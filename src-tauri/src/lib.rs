use chrono::{DateTime, Datelike, Local};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io,
    path::{Path, PathBuf},
    process::Command,
    time::SystemTime,
};
use tauri::Emitter;
use walkdir::WalkDir;

#[derive(Debug, Deserialize, Serialize, Clone)]
struct Rule {
    pattern: String,
    folder: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct BuildPlanRequest {
    source: String,
    destination: String,
    recursive: bool,
    template: String,
    rules: Vec<Rule>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct FilePlan {
    source: String,
    target: String,
    reason: String,
    size: u64,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct OrganizeRequest {
    operation: String,
    source: String,
    destination: String,
    template: String,
    items: Vec<FilePlan>,
}

#[derive(Debug, Deserialize, Serialize)]
struct HistoryItem {
    from: String,
    to: String,
    reason: String,
    size: u64,
}

#[derive(Debug, Deserialize, Serialize)]
struct HistoryRecord {
    created_at: String,
    operation: String,
    source: String,
    destination: String,
    template: String,
    items: Vec<HistoryItem>,
}

#[derive(Debug, Deserialize, Serialize)]
struct HistorySummary {
    record_file: String,
    created_at: String,
    operation: String,
    source: String,
    destination: String,
    template: String,
    count: usize,
}

#[derive(Debug, Deserialize, Serialize)]
struct AppSettings {
    rules: Vec<Rule>,
    default_template: String,
    default_operation: String,
    recursive: bool,
}

#[derive(Debug, Serialize, Clone)]
struct ScanProgress {
    phase: String,
    processed: usize,
    total: usize,
    current: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            rules: vec![
                Rule {
                    pattern: ".pdf".to_string(),
                    folder: "Important PDFs".to_string(),
                },
                Rule {
                    pattern: "invoice".to_string(),
                    folder: "Invoices".to_string(),
                },
            ],
            default_template: "Category".to_string(),
            default_operation: "Copy".to_string(),
            recursive: true,
        }
    }
}

#[tauri::command]
fn load_settings() -> Result<AppSettings, String> {
    let path = settings_path()?;
    if !path.exists() {
        return Ok(AppSettings::default());
    }

    let text = fs::read_to_string(&path).map_err(format_io_error)?;
    serde_json::from_str(&text).map_err(|err| err.to_string())
}

#[tauri::command]
fn save_settings(settings: AppSettings) -> Result<(), String> {
    let path = settings_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(format_io_error)?;
    }
    let text = serde_json::to_string_pretty(&settings).map_err(|err| err.to_string())?;
    fs::write(path, text).map_err(format_io_error)
}

#[tauri::command]
fn build_plan(app: tauri::AppHandle, request: BuildPlanRequest) -> Result<Vec<FilePlan>, String> {
    let source = normalize_dir(&request.source, "source")?;
    let destination = normalize_destination(&request.destination)?;
    let mut plan = Vec::new();
    let mut used_targets = HashSet::new();
    emit_scan_progress(&app, "Counting files", 0, 0, &source);
    let total = count_eligible_files(&source, &destination, request.recursive, &app)?;
    emit_scan_progress(&app, "Building preview", 0, total, &source);

    let walker = if request.recursive {
        WalkDir::new(&source).into_iter()
    } else {
        WalkDir::new(&source).max_depth(1).into_iter()
    };

    let mut processed = 0;
    for entry in walker.filter_map(Result::ok).filter(|entry| entry.file_type().is_file()) {
        let path = entry.path();
        if is_inside(path, &destination) {
            continue;
        }

        let metadata = fs::metadata(path).map_err(format_io_error)?;
        let (folder, reason) = target_folder_for(path, &request.template, &request.rules, &metadata)?;
        let target = unique_target(&destination.join(folder).join(entry.file_name()), &mut used_targets);
        plan.push(FilePlan {
            source: path.to_string_lossy().to_string(),
            target: target.to_string_lossy().to_string(),
            reason,
            size: metadata.len(),
        });
        processed += 1;
        if processed == total || processed % 100 == 0 {
            emit_scan_progress(&app, "Building preview", processed, total, path);
        }
    }

    emit_scan_progress(&app, "Preview complete", processed, total, &source);
    Ok(plan)
}

#[tauri::command]
fn organize_files(request: OrganizeRequest) -> Result<String, String> {
    let destination = normalize_destination(&request.destination)?;
    fs::create_dir_all(&destination).map_err(format_io_error)?;

    let mut items = Vec::new();
    let mut used_targets = HashSet::new();
    let operation = request.operation.trim();

    if operation != "Move" && operation != "Copy" {
        return Err("Operation must be Move or Copy.".to_string());
    }

    for item in request.items {
        let source = PathBuf::from(&item.source);
        if !source.exists() {
            continue;
        }

        let requested_target = PathBuf::from(&item.target);
        let target = unique_target(&requested_target, &mut used_targets);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(format_io_error)?;
        }

        if operation == "Copy" {
            fs::copy(&source, &target).map_err(format_io_error)?;
        } else {
            move_file(&source, &target).map_err(format_io_error)?;
        }

        items.push(HistoryItem {
            from: source.to_string_lossy().to_string(),
            to: target.to_string_lossy().to_string(),
            reason: item.reason,
            size: item.size,
        });
    }

    let record = HistoryRecord {
        created_at: Local::now().to_rfc3339(),
        operation: operation.to_string(),
        source: request.source,
        destination: destination.to_string_lossy().to_string(),
        template: request.template,
        items,
    };

    let history_path = write_history(&destination, &record)?;
    Ok(history_path.to_string_lossy().to_string())
}

#[tauri::command]
fn list_history(destination: String) -> Result<Vec<HistorySummary>, String> {
    let destination = normalize_destination(&destination)?;
    let history_dir = destination.join(".organizer_history");
    if !history_dir.exists() {
        return Ok(Vec::new());
    }

    let mut records = Vec::new();
    for entry in fs::read_dir(history_dir).map_err(format_io_error)? {
        let path = entry.map_err(format_io_error)?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let text = fs::read_to_string(&path).map_err(format_io_error)?;
        if let Ok(record) = serde_json::from_str::<HistoryRecord>(&text) {
            records.push(HistorySummary {
                record_file: path.to_string_lossy().to_string(),
                created_at: record.created_at,
                operation: record.operation,
                source: record.source,
                destination: record.destination,
                template: record.template,
                count: record.items.len(),
            });
        }
    }

    records.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(records)
}

#[tauri::command]
fn undo_last_move(destination: String) -> Result<usize, String> {
    let destination = normalize_destination(&destination)?;
    let history_dir = destination.join(".organizer_history");
    if !history_dir.exists() {
        return Ok(0);
    }

    let mut move_records = Vec::new();
    for entry in fs::read_dir(&history_dir).map_err(format_io_error)? {
        let path = entry.map_err(format_io_error)?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let text = fs::read_to_string(&path).map_err(format_io_error)?;
        if let Ok(record) = serde_json::from_str::<HistoryRecord>(&text) {
            if record.operation == "Move" {
                move_records.push((path, record));
            }
        }
    }

    move_records.sort_by(|a, b| b.1.created_at.cmp(&a.1.created_at));
    let Some((record_path, record)) = move_records.into_iter().next() else {
        return Ok(0);
    };

    let mut restored = 0;
    let mut used_targets = HashSet::new();
    for item in record.items.into_iter().rev() {
        let current = PathBuf::from(item.to);
        let original = PathBuf::from(item.from);
        if !current.exists() {
            continue;
        }
        if let Some(parent) = original.parent() {
            fs::create_dir_all(parent).map_err(format_io_error)?;
        }
        let final_target = unique_target(&original, &mut used_targets);
        move_file(&current, &final_target).map_err(format_io_error)?;
        restored += 1;
    }

    let _ = fs::remove_file(record_path);
    Ok(restored)
}

#[tauri::command]
fn pick_folder(title: String, initial: Option<String>) -> Result<Option<String>, String> {
    let title = escape_powershell_single_quoted(&title);
    let initial = initial
        .filter(|value| !value.trim().is_empty())
        .map(|value| escape_powershell_single_quoted(&value))
        .unwrap_or_default();
    let selected_path = "$dialog.SelectedPath";
    let script = format!(
        "Add-Type -AssemblyName System.Windows.Forms; \
         $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; \
         $dialog.Description = '{title}'; \
         $dialog.ShowNewFolderButton = $true; \
         if ('{initial}' -ne '' -and (Test-Path -LiteralPath '{initial}')) {{ $dialog.SelectedPath = '{initial}' }}; \
         if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{ Write-Output {selected_path} }}"
    );

    let output = Command::new("powershell")
        .args(["-NoProfile", "-STA", "-Command", &script])
        .output()
        .map_err(format_io_error)?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "Folder picker did not complete successfully.".to_string()
        } else {
            stderr
        });
    }

    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() {
        Ok(None)
    } else {
        Ok(Some(value))
    }
}

#[tauri::command]
fn default_destination(source: String) -> Result<String, String> {
    let source = normalize_dir(&source, "source")?;
    Ok(source.join("Organized").to_string_lossy().to_string())
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            load_settings,
            save_settings,
            build_plan,
            organize_files,
            list_history,
            undo_last_move,
            pick_folder,
            default_destination
        ])
        .run(tauri::generate_context!())
        .expect("error while running FileFlow Organizer");
}

fn category_map() -> HashMap<&'static str, &'static [&'static str]> {
    HashMap::from([
        ("Images", &["jpg", "jpeg", "png", "gif", "bmp", "tiff", "webp", "heic", "svg"][..]),
        ("Videos", &["mp4", "mov", "avi", "mkv", "wmv", "flv", "webm", "m4v"][..]),
        ("Audio", &["mp3", "wav", "flac", "aac", "ogg", "m4a", "wma"][..]),
        ("Documents", &["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "rtf", "md"][..]),
        ("Archives", &["zip", "rar", "7z", "tar", "gz", "bz2"][..]),
        ("Code", &["py", "js", "ts", "html", "css", "json", "xml", "cs", "cpp", "c", "java"][..]),
        ("Apps", &["exe", "msi", "appx", "msix", "bat", "cmd"][..]),
    ])
}

fn count_eligible_files(source: &Path, destination: &Path, recursive: bool, app: &tauri::AppHandle) -> Result<usize, String> {
    let walker = if recursive {
        WalkDir::new(source).into_iter()
    } else {
        WalkDir::new(source).max_depth(1).into_iter()
    };

    let mut total = 0;
    let mut visited = 0;
    for entry in walker.filter_map(Result::ok) {
        visited += 1;
        let path = entry.path();
        if entry.file_type().is_file() && !is_inside(path, destination) {
            total += 1;
        }
        if visited % 250 == 0 {
            emit_scan_progress(app, "Counting files", total, 0, path);
        }
    }
    Ok(total)
}

fn emit_scan_progress(app: &tauri::AppHandle, phase: &str, processed: usize, total: usize, current: &Path) {
    let _ = app.emit(
        "scan_progress",
        ScanProgress {
            phase: phase.to_string(),
            processed,
            total,
            current: current.to_string_lossy().to_string(),
        },
    );
}

fn target_folder_for(
    path: &Path,
    template: &str,
    rules: &[Rule],
    metadata: &fs::Metadata,
) -> Result<(PathBuf, String), String> {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_lowercase();
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_lowercase();

    for rule in rules {
        let pattern = rule.pattern.trim().to_lowercase();
        if pattern.is_empty() || rule.folder.trim().is_empty() {
            continue;
        }
        let extension_match = pattern.strip_prefix('.').map(|value| value == extension).unwrap_or(false);
        if extension_match || file_name.contains(&pattern) {
            return Ok((PathBuf::from("Rules").join(safe_name(&rule.folder)), format!("Rule: {}", rule.pattern)));
        }
    }

    let category = category_for(&extension);
    let created = metadata.created().unwrap_or_else(|_| SystemTime::now());
    let modified = metadata.modified().unwrap_or_else(|_| SystemTime::now());

    match template {
        "Extension" => Ok((PathBuf::from(extension_label(&extension)), "Extension".to_string())),
        "Date Created" => Ok((date_folder(created), "Created date".to_string())),
        "Date Modified" => Ok((date_folder(modified), "Modified date".to_string())),
        "Category / Extension" => Ok((
            PathBuf::from(category).join(extension_label(&extension)),
            "Category and extension".to_string(),
        )),
        "Filename Prefix" => Ok((PathBuf::from(filename_prefix(path)), "Filename prefix".to_string())),
        _ => Ok((PathBuf::from(category), format!("Category: {}", category))),
    }
}

fn category_for(extension: &str) -> &'static str {
    for (category, extensions) in category_map() {
        if extensions.contains(&extension) {
            return category;
        }
    }
    "Other"
}

fn extension_label(extension: &str) -> String {
    if extension.is_empty() {
        "No Extension".to_string()
    } else {
        extension.to_uppercase()
    }
}

fn filename_prefix(path: &Path) -> String {
    let stem = path.file_stem().and_then(|value| value.to_str()).unwrap_or("Other");
    let prefix = stem
        .split(|character: char| character == '-' || character == '_' || character == '.' || character.is_whitespace())
        .next()
        .unwrap_or("Other");
    safe_name(prefix)
}

fn date_folder(time: SystemTime) -> PathBuf {
    let datetime: DateTime<Local> = DateTime::from(time);
    PathBuf::from(datetime.year().to_string()).join(format!("{:02}", datetime.month()))
}

fn unique_target(path: &Path, used_targets: &mut HashSet<PathBuf>) -> PathBuf {
    let mut candidate = path.to_path_buf();
    if !candidate.exists() && used_targets.insert(candidate.clone()) {
        return candidate;
    }

    let parent = path.parent().unwrap_or_else(|| Path::new(""));
    let stem = path.file_stem().and_then(|value| value.to_str()).unwrap_or("file");
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("");

    for index in 2.. {
        let file_name = if extension.is_empty() {
            format!("{stem} ({index})")
        } else {
            format!("{stem} ({index}).{extension}")
        };
        candidate = parent.join(file_name);
        if !candidate.exists() && used_targets.insert(candidate.clone()) {
            return candidate;
        }
    }

    unreachable!()
}

fn write_history(destination: &Path, record: &HistoryRecord) -> Result<PathBuf, String> {
    let history_dir = destination.join(".organizer_history");
    fs::create_dir_all(&history_dir).map_err(format_io_error)?;
    let file_name = format!("{}.json", Local::now().format("%Y%m%d-%H%M%S-%3f"));
    let path = history_dir.join(file_name);
    let text = serde_json::to_string_pretty(record).map_err(|err| err.to_string())?;
    fs::write(&path, text).map_err(format_io_error)?;
    Ok(path)
}

fn move_file(source: &Path, target: &Path) -> io::Result<()> {
    match fs::rename(source, target) {
        Ok(()) => Ok(()),
        Err(_) => {
            fs::copy(source, target)?;
            fs::remove_file(source)
        }
    }
}

fn normalize_dir(path: &str, label: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path.trim());
    if !path.exists() || !path.is_dir() {
        return Err(format!("Choose a valid {label} folder."));
    }
    Ok(path)
}

fn normalize_destination(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Choose a destination folder.".to_string());
    }
    Ok(PathBuf::from(trimmed))
}

fn is_inside(path: &Path, parent: &Path) -> bool {
    let Ok(path) = path.canonicalize() else {
        return false;
    };
    let Ok(parent) = parent.canonicalize() else {
        return false;
    };
    path.starts_with(parent)
}

fn safe_name(value: &str) -> String {
    let invalid = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    let mut cleaned = value
        .trim()
        .chars()
        .map(|character| if invalid.contains(&character) || character.is_control() { '_' } else { character })
        .collect::<String>();
    cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.is_empty() {
        "Other".to_string()
    } else {
        cleaned.chars().take(80).collect()
    }
}

fn escape_powershell_single_quoted(value: &str) -> String {
    value.replace('\'', "''")
}

fn settings_path() -> Result<PathBuf, String> {
    let appdata = std::env::var_os("APPDATA").ok_or_else(|| "APPDATA is not available.".to_string())?;
    Ok(PathBuf::from(appdata).join("FileFlow Organizer").join("settings.json"))
}

fn format_io_error(error: io::Error) -> String {
    error.to_string()
}
