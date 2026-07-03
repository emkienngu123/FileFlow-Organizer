import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  ArchiveRestore,
  ClipboardList,
  Copy,
  FolderInput,
  FolderOutput,
  History,
  Loader2,
  Play,
  Plus,
  RotateCcw,
  Save,
  Search,
  Settings,
  Shuffle,
  Trash2,
} from "lucide-react";

type Rule = {
  pattern: string;
  folder: string;
};

type FilePlan = {
  source: string;
  target: string;
  reason: string;
  size: number;
};

type HistorySummary = {
  record_file: string;
  created_at: string;
  operation: string;
  source: string;
  destination: string;
  template: string;
  count: number;
};

type AppSettings = {
  rules: Rule[];
  default_template: string;
  default_operation: string;
  recursive: boolean;
};

type ScanProgress = {
  phase: string;
  processed: number;
  total: number;
  current: string;
};

type View = "organize" | "rules" | "history" | "settings";

const templates = ["Category", "Extension", "Date Created", "Date Modified", "Category / Extension", "Filename Prefix"];
const operations = ["Copy", "Move"];

function App() {
  const [view, setView] = useState<View>("organize");
  const [source, setSource] = useState("");
  const [destination, setDestination] = useState("");
  const [template, setTemplate] = useState("Category");
  const [operation, setOperation] = useState("Copy");
  const [recursive, setRecursive] = useState(true);
  const [rules, setRules] = useState<Rule[]>([]);
  const [rulePattern, setRulePattern] = useState("");
  const [ruleFolder, setRuleFolder] = useState("");
  const [plan, setPlan] = useState<FilePlan[]>([]);
  const [history, setHistory] = useState<HistorySummary[]>([]);
  const [filter, setFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("All");
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [status, setStatus] = useState("Ready to organize.");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    invoke<AppSettings>("load_settings")
      .then((settings) => {
        setRules(settings.rules);
        setTemplate(settings.default_template);
        setOperation(settings.default_operation);
        setRecursive(settings.recursive);
      })
      .catch((error) => setStatus(String(error)));
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<ScanProgress>("scan_progress", (event) => {
      setScanProgress(event.payload);
    }).then((handler) => {
      unlisten = handler;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  const filteredPlan = useMemo(() => {
    const value = filter.trim().toLowerCase();
    return plan.filter((item) => {
      const matchesCategory = categoryFilter === "All" || topLevelFolder(item.target, destination) === categoryFilter;
      const matchesText = !value || `${item.source} ${item.target} ${item.reason}`.toLowerCase().includes(value);
      return matchesCategory && matchesText;
    });
  }, [categoryFilter, destination, filter, plan]);

  const totalSize = useMemo(() => plan.reduce((sum, item) => sum + item.size, 0), [plan]);
  const arrangement = useMemo(() => buildArrangement(plan, destination), [plan, destination]);

  async function handleSourceBlur() {
    if (!source.trim() || destination.trim()) {
      return;
    }
    try {
      const suggested = await invoke<string>("default_destination", { source });
      setDestination(suggested);
      await previewFor(source, suggested);
    } catch {
      // The preview action will show the real validation error.
    }
  }

  async function browseSource() {
    const selected = await invoke<string | null>("pick_folder", { title: "Choose source folder", initial: source || null });
    if (typeof selected !== "string") {
      return;
    }
    setSource(selected);
    let nextDestination = destination;
    if (!destination.trim()) {
      try {
        const suggested = await invoke<string>("default_destination", { source: selected });
        setDestination(suggested);
        nextDestination = suggested;
      } catch {
        nextDestination = `${selected}\\Organized`;
        setDestination(nextDestination);
      }
    }
    await previewFor(selected, nextDestination);
  }

  async function browseDestination() {
    const selected = await invoke<string | null>("pick_folder", {
      title: "Choose destination folder",
      initial: destination || source || null,
    });
    if (typeof selected === "string") {
      setDestination(selected);
      if (source.trim()) {
        await previewFor(source, selected);
      }
    }
  }

  async function previewPlan() {
    await previewFor(source, destination);
  }

  async function previewFor(nextSource: string, nextDestination: string) {
    await runBusy("Scanning selected folder...", async () => {
      setScanProgress({ phase: "Starting scan", processed: 0, total: 0, current: nextSource });
      const nextPlan = await invoke<FilePlan[]>("build_plan", {
        request: { source: nextSource, destination: nextDestination, recursive, template, rules },
      });
      setPlan(nextPlan);
      setCategoryFilter("All");
      setScanProgress({ phase: "Preview complete", processed: nextPlan.length, total: nextPlan.length, current: nextSource });
      setStatus(`Preview ready: ${nextPlan.length.toLocaleString()} files planned.`);
    });
  }

  async function organizeFiles() {
    if (!plan.length) {
      setStatus("Create a preview before organizing.");
      return;
    }

    const confirmed = window.confirm(`${operation} ${plan.length.toLocaleString()} files using the current preview?`);
    if (!confirmed) {
      return;
    }

    await runBusy("Organizing files...", async () => {
      const historyPath = await invoke<string>("organize_files", {
        request: { operation, source, destination, template, items: plan },
      });
      setStatus(`Organized ${plan.length.toLocaleString()} files. History saved to ${historyPath}`);
      setPlan([]);
      await loadHistory();
    });
  }

  async function undoLastMove() {
    const confirmed = window.confirm("Undo the most recent move operation for this destination?");
    if (!confirmed) {
      return;
    }

    await runBusy("Restoring moved files...", async () => {
      const restored = await invoke<number>("undo_last_move", { destination });
      setStatus(restored ? `Restored ${restored.toLocaleString()} files.` : "No move history found to undo.");
      await loadHistory();
    });
  }

  async function loadHistory() {
    if (!destination.trim()) {
      setHistory([]);
      return;
    }
    const records = await invoke<HistorySummary[]>("list_history", { destination });
    setHistory(records);
  }

  async function saveCurrentSettings() {
    await runBusy("Saving settings...", async () => {
      await invoke("save_settings", {
        settings: {
          rules,
          default_template: template,
          default_operation: operation,
          recursive,
        },
      });
      setStatus("Settings saved.");
    });
  }

  function addRule() {
    const pattern = rulePattern.trim();
    const folder = ruleFolder.trim();
    if (!pattern || !folder) {
      setStatus("Enter both a match pattern and a folder name.");
      return;
    }
    setRules((current) => [...current, { pattern, folder }]);
    setRulePattern("");
    setRuleFolder("");
    setStatus(`Rule added: ${pattern} -> ${folder}`);
  }

  function removeRule(index: number) {
    setRules((current) => current.filter((_, ruleIndex) => ruleIndex !== index));
  }

  async function runBusy(message: string, action: () => Promise<void>) {
    try {
      setBusy(true);
      setStatus(message);
      await action();
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">F</div>
          <div>
            <h1>FileFlow</h1>
            <p>Local file organizer</p>
          </div>
        </div>

        <nav>
          <NavButton active={view === "organize"} icon={<ClipboardList />} label="Organize" onClick={() => setView("organize")} />
          <NavButton active={view === "rules"} icon={<Shuffle />} label="Rules" onClick={() => setView("rules")} />
          <NavButton
            active={view === "history"}
            icon={<History />}
            label="History"
            onClick={() => {
              setView("history");
              void loadHistory();
            }}
          />
          <NavButton active={view === "settings"} icon={<Settings />} label="Settings" onClick={() => setView("settings")} />
        </nav>

        <div className="sidebar-card">
          <span className="meta-label">Current mode</span>
          <strong>{operation}</strong>
          <p>{operation === "Copy" ? "Safe test mode. Source files stay in place." : "Move mode creates undo records."}</p>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <h2>{viewTitle(view)}</h2>
            <p>{viewSubtitle(view)}</p>
          </div>
          <div className="status-pill">
            {busy ? <Loader2 className="spin" size={16} /> : <ArchiveRestore size={16} />}
            <span>{status}</span>
          </div>
        </header>

        {view === "organize" && (
          <section className="organize-grid">
            <div className="panel setup-panel">
              <PathField
                icon={<FolderInput />}
                label="Source folder"
                value={source}
                placeholder="C:\\Users\\You\\Downloads"
                onChange={setSource}
                onBlur={handleSourceBlur}
                onBrowse={browseSource}
              />
              <PathField
                icon={<FolderOutput />}
                label="Destination folder"
                value={destination}
                placeholder="C:\\Users\\You\\Downloads\\Organized"
                onChange={setDestination}
                onBlur={() => {
                  if (source.trim() && destination.trim()) {
                    void previewFor(source, destination);
                  }
                }}
                onBrowse={browseDestination}
              />

              <div className="field-row">
                <label>
                  <span>Template</span>
                  <select value={template} onChange={(event) => setTemplate(event.target.value)}>
                    {templates.map((item) => (
                      <option key={item}>{item}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Operation</span>
                  <select value={operation} onChange={(event) => setOperation(event.target.value)}>
                    {operations.map((item) => (
                      <option key={item}>{item}</option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="check-row">
                <input type="checkbox" checked={recursive} onChange={(event) => setRecursive(event.target.checked)} />
                Include files in subfolders
              </label>

              <div className="action-row">
                <button className="primary" onClick={previewPlan} disabled={busy}>
                  <Search size={17} />
                  Preview
                </button>
                <button className="success" onClick={organizeFiles} disabled={busy || !plan.length}>
                  {operation === "Copy" ? <Copy size={17} /> : <Play size={17} />}
                  Organize
                </button>
                <button onClick={undoLastMove} disabled={busy || !destination.trim()}>
                  <RotateCcw size={17} />
                  Undo
                </button>
              </div>

              <ScanProgressBar progress={scanProgress} active={busy} />

              <ArrangementPanel arrangement={arrangement} hasDestination={Boolean(destination.trim())} />
            </div>

            <div className="panel chart-panel">
              <PieChart arrangement={arrangement} total={plan.length} totalSize={totalSize} />
            </div>

            <PreviewPanel
              plan={filteredPlan}
              arrangement={arrangement}
              categoryFilter={categoryFilter}
              setCategoryFilter={setCategoryFilter}
              filter={filter}
              setFilter={setFilter}
            />
          </section>
        )}

        {view === "rules" && (
          <section className="panel full-panel">
            <div className="section-head">
              <div>
                <h3>Rule presets</h3>
                <p>Rules run before templates. Match by extension, like .pdf, or by text in the filename.</p>
              </div>
              <button onClick={saveCurrentSettings} disabled={busy}>
                <Save size={16} />
                Save presets
              </button>
            </div>

            <div className="rule-composer">
              <input value={rulePattern} onChange={(event) => setRulePattern(event.target.value)} placeholder=".pdf or invoice" />
              <input value={ruleFolder} onChange={(event) => setRuleFolder(event.target.value)} placeholder="Target folder" />
              <button className="primary" onClick={addRule}>
                <Plus size={16} />
                Add rule
              </button>
            </div>

            <RuleHelp />

            <div className="rule-list">
              {rules.map((rule, index) => (
                <div className="rule-item" key={`${rule.pattern}-${rule.folder}-${index}`}>
                  <div>
                    <strong>{rule.pattern}</strong>
                    <span>{rule.folder}</span>
                  </div>
                  <button className="ghost danger" onClick={() => removeRule(index)}>
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {view === "history" && (
          <section className="panel full-panel">
            <div className="section-head">
              <div>
                <h3>Organized records</h3>
                <p>History is loaded from the selected destination folder.</p>
              </div>
              <button onClick={loadHistory} disabled={busy || !destination.trim()}>
                <History size={16} />
                Refresh
              </button>
            </div>
            <HistoryTable history={history} />
          </section>
        )}

        {view === "settings" && (
          <section className="panel full-panel settings-panel">
            <div className="section-head">
              <div>
                <h3>Defaults and distribution</h3>
                <p>These defaults are saved locally for future app launches.</p>
              </div>
              <button className="primary" onClick={saveCurrentSettings} disabled={busy}>
                <Save size={16} />
                Save settings
              </button>
            </div>
            <div className="settings-grid">
              <Metric label="App version" value="0.2.0" />
              <Metric label="Installer target" value="MSI + EXE" />
              <Metric label="Saved rules" value={rules.length.toLocaleString()} />
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function NavButton({ active, icon, label, onClick }: { active: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button className={`nav-button ${active ? "active" : ""}`} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function PathField({
  icon,
  label,
  value,
  placeholder,
  onChange,
  onBlur,
  onBrowse,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  onBrowse?: () => void;
}) {
  return (
    <label className="path-field">
      <span>
        {icon}
        {label}
      </span>
      <div className="path-input-row">
        <input value={value} onChange={(event) => onChange(event.target.value)} onBlur={onBlur} placeholder={placeholder} />
        {onBrowse && (
          <button type="button" onClick={onBrowse}>
            Browse
          </button>
        )}
      </div>
    </label>
  );
}

function ScanProgressBar({ progress, active }: { progress: ScanProgress | null; active: boolean }) {
  if (!progress && !active) {
    return null;
  }
  const percent = progress?.total ? Math.min(100, Math.round((progress.processed / progress.total) * 100)) : 0;
  const label = progress?.total
    ? `${progress.processed.toLocaleString()} of ${progress.total.toLocaleString()} files`
    : `${progress?.processed.toLocaleString() ?? 0} files found`;

  return (
    <div className="scan-progress">
      <div className="scan-progress-head">
        <strong>{progress?.phase ?? "Scanning"}</strong>
        <span>{progress?.total ? `${percent}%` : "Counting..."}</span>
      </div>
      <div className={`progress-track ${progress?.total ? "" : "indeterminate"}`}>
        <div className="progress-fill" style={{ width: progress?.total ? `${percent}%` : "45%" }} />
      </div>
      <div className="scan-progress-foot">
        <span>{label}</span>
        <span title={progress?.current}>{progress?.current ? compactPath(progress.current) : ""}</span>
      </div>
    </div>
  );
}

function RuleHelp() {
  const examples = [
    { match: ".pdf", folder: "PDF Documents", description: "Sends every PDF file to one folder." },
    { match: "invoice", folder: "Invoices", description: "Matches filenames like invoice-2026.xlsx or client-invoice.pdf." },
    { match: ".jpg", folder: "Photos", description: "Moves JPEG photos before the default category template runs." },
  ];

  return (
    <div className="rule-help">
      <div>
        <h4>How custom rules work</h4>
        <p>
          Rules run before the selected template. Use an extension such as <strong>.pdf</strong> or a word that appears in
          the filename such as <strong>invoice</strong>. Matching files go to the folder name you choose.
        </p>
      </div>
      <div className="rule-examples">
        {examples.map((example) => (
          <div key={`${example.match}-${example.folder}`}>
            <code>{example.match}</code>
            <span>{"->"}</span>
            <strong>{example.folder}</strong>
            <p>{example.description}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ArrangementPanel({ arrangement, hasDestination }: { arrangement: ArrangementItem[]; hasDestination: boolean }) {
  const displayItems = arrangement.length ? arrangement.slice(0, 8) : defaultArrangement();
  return (
    <div className="arrangement-panel">
      <div className="mini-section-head">
        <strong>Default folder arrangement</strong>
        <span>{hasDestination ? `${displayItems.length} folders` : "Choose destination"}</span>
      </div>
      <div className="arrangement-list">
        {displayItems.map((item) => (
          <div className="arrangement-item" key={item.name}>
            <span className="folder-dot" style={{ background: item.color }} />
            <div>
              <strong>{item.name}</strong>
              <span>{item.count ? `${item.count.toLocaleString()} files` : "Ready"}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PieChart({ arrangement, total, totalSize }: { arrangement: ArrangementItem[]; total: number; totalSize: number }) {
  const items = arrangement.length ? arrangement.slice(0, 7) : defaultArrangement();
  const chartTotal = Math.max(
    items.reduce((sum, item) => sum + Math.max(item.count, 1), 0),
    1,
  );
  let cursor = 0;

  return (
    <div className="pie-card">
      <div className="section-head compact">
        <div>
          <h3>Instant preview</h3>
          <p>{total ? "Folder split from the current plan." : "Choose a source folder to generate the chart."}</p>
        </div>
      </div>

      <div className="pie-content">
        <svg className="pie-chart" viewBox="0 0 120 120" role="img" aria-label="Folder preview pie chart">
          <circle cx="60" cy="60" r="43" fill="#edf2f7" />
          {items.map((item) => {
            const value = total ? item.count : 1;
            const start = cursor / chartTotal;
            cursor += value;
            const end = cursor / chartTotal;
            return <path key={item.name} d={pieSlicePath(60, 60, 43, start, end)} fill={item.color} />;
          })}
          <circle cx="60" cy="60" r="24" fill="#ffffff" />
          <text x="60" y="57" textAnchor="middle" className="pie-total">
            {total.toLocaleString()}
          </text>
          <text x="60" y="72" textAnchor="middle" className="pie-label">
            files
          </text>
        </svg>

        <div className="pie-summary">
          <Metric label="Files planned" value={total.toLocaleString()} />
          <Metric label="Total size" value={formatBytes(totalSize)} />
        </div>
      </div>

      <div className="pie-legend">
        {items.map((item) => (
          <div key={item.name}>
            <span className="folder-dot" style={{ background: item.color }} />
            <span>{item.name}</span>
            <strong>{item.count ? item.count.toLocaleString() : "-"}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function PreviewPanel({
  plan,
  arrangement,
  categoryFilter,
  setCategoryFilter,
  filter,
  setFilter,
}: {
  plan: FilePlan[];
  arrangement: ArrangementItem[];
  categoryFilter: string;
  setCategoryFilter: (value: string) => void;
  filter: string;
  setFilter: (value: string) => void;
}) {
  const categoryButtons = [{ name: "All", count: arrangement.reduce((sum, item) => sum + item.count, 0), color: "#172033" }, ...arrangement];

  return (
    <div className="panel preview-panel">
      <div className="section-head">
        <div>
          <h3>Preview plan</h3>
          <p>Preview one folder category at a time before touching files.</p>
        </div>
        <div className="filter-box">
          <Search size={16} />
          <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter preview" />
        </div>
      </div>

      <div className="category-filter-row">
        {categoryButtons.map((item) => (
          <button
            className={`category-chip ${categoryFilter === item.name ? "active" : ""}`}
            key={item.name}
            onClick={() => setCategoryFilter(item.name)}
            type="button"
          >
            <span className="folder-dot" style={{ background: item.color }} />
            <span>{item.name}</span>
            <strong>{item.count.toLocaleString()}</strong>
          </button>
        ))}
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>Target</th>
              <th>Reason</th>
              <th>Size</th>
            </tr>
          </thead>
          <tbody>
            {plan.slice(0, 1000).map((item) => (
              <tr key={`${item.source}-${item.target}`}>
                <td title={item.source}>{compactPath(item.source)}</td>
                <td title={item.target}>{compactPath(item.target)}</td>
                <td>
                  <span className="badge">{item.reason}</span>
                </td>
                <td>{formatBytes(item.size)}</td>
              </tr>
            ))}
            {!plan.length && (
              <tr>
                <td colSpan={4} className="empty">
                  No preview yet. Enter folders, then click Preview.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type ArrangementItem = {
  name: string;
  count: number;
  size: number;
  color: string;
};

const chartColors = ["#2563eb", "#18a67a", "#f59e0b", "#dc2626", "#7c3aed", "#0891b2", "#4b5563", "#db2777"];

function buildArrangement(plan: FilePlan[], destination: string): ArrangementItem[] {
  const groups = new Map<string, { count: number; size: number }>();
  for (const item of plan) {
    const name = topLevelFolder(item.target, destination);
    const current = groups.get(name) ?? { count: 0, size: 0 };
    current.count += 1;
    current.size += item.size;
    groups.set(name, current);
  }

  return [...groups.entries()]
    .map(([name, value], index) => ({
      name,
      count: value.count,
      size: value.size,
      color: chartColors[index % chartColors.length],
    }))
    .sort((a, b) => b.count - a.count);
}

function topLevelFolder(target: string, destination: string) {
  const normalizedTarget = target.replace(/\//g, "\\");
  const normalizedDestination = destination.replace(/\//g, "\\").replace(/\\+$/, "");
  let relative = normalizedTarget;
  if (normalizedDestination && normalizedTarget.toLowerCase().startsWith(`${normalizedDestination.toLowerCase()}\\`)) {
    relative = normalizedTarget.slice(normalizedDestination.length + 1);
  }
  return relative.split("\\").filter(Boolean)[0] || "Other";
}

function defaultArrangement(): ArrangementItem[] {
  return ["Images", "Documents", "Videos", "Audio", "Archives", "Code", "Apps", "Other"].map((name, index) => ({
    name,
    count: 0,
    size: 0,
    color: chartColors[index % chartColors.length],
  }));
}

function pieSlicePath(cx: number, cy: number, radius: number, start: number, end: number) {
  if (end - start >= 0.999) {
    return [
      `M ${cx} ${cy - radius}`,
      `A ${radius} ${radius} 0 1 1 ${cx - 0.01} ${cy - radius}`,
      `A ${radius} ${radius} 0 1 1 ${cx} ${cy - radius}`,
      `L ${cx} ${cy}`,
      "Z",
    ].join(" ");
  }

  const startAngle = start * Math.PI * 2 - Math.PI / 2;
  const endAngle = end * Math.PI * 2 - Math.PI / 2;
  const x1 = cx + radius * Math.cos(startAngle);
  const y1 = cy + radius * Math.sin(startAngle);
  const x2 = cx + radius * Math.cos(endAngle);
  const y2 = cy + radius * Math.sin(endAngle);
  const largeArc = end - start > 0.5 ? 1 : 0;
  return `M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z`;
}

function HistoryTable({ history }: { history: HistorySummary[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Operation</th>
            <th>Template</th>
            <th>Files</th>
            <th>Record</th>
          </tr>
        </thead>
        <tbody>
          {history.map((item) => (
            <tr key={item.record_file}>
              <td>{formatDate(item.created_at)}</td>
              <td>
                <span className={`badge ${item.operation === "Move" ? "move" : ""}`}>{item.operation}</span>
              </td>
              <td>{item.template}</td>
              <td>{item.count.toLocaleString()}</td>
              <td title={item.record_file}>{compactPath(item.record_file)}</td>
            </tr>
          ))}
          {!history.length && (
            <tr>
              <td colSpan={5} className="empty">
                No history found for the selected destination.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function viewTitle(view: View) {
  return {
    organize: "Organize files",
    rules: "Rules",
    history: "History",
    settings: "Settings",
  }[view];
}

function viewSubtitle(view: View) {
  return {
    organize: "Build a preview, then copy or move files into clean folders.",
    rules: "Create reusable patterns for high-priority file groups.",
    history: "Audit previous organize runs and undo move operations.",
    settings: "Save defaults for future launches and packaging builds.",
  }[view];
}

function compactPath(path: string) {
  if (path.length <= 72) {
    return path;
  }
  return `${path.slice(0, 32)}...${path.slice(-34)}`;
}

function formatBytes(bytes: number) {
  if (!bytes) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

export default App;
