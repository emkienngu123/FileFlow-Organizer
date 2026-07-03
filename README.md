# FileFlow Organizer

FileFlow Organizer is a Windows desktop file organizer built with Tauri, React, and Rust.

It is an original app inspired by the general idea of one-click file cleanup utilities. It does not copy another app's branding, UI, text, or proprietary behavior.

## Features

- Preview file organization before changing anything
- Copy or move files into generated folders
- Organize by category, extension, created date, modified date, category plus extension, or filename prefix
- Add reusable custom rules such as `.pdf -> Important PDFs`
- Save rule presets and defaults locally
- Keep per-destination organize history in `.organizer_history`
- Undo the most recent move operation
- Build Windows MSI and EXE installers

## Development

Install dependencies:

```powershell
npm.cmd install --cache .npm-cache --strict-ssl=false
```

Run the app in development:

```powershell
npm.cmd run tauri:dev
```

Build the frontend:

```powershell
npm.cmd run build
```

Build Windows installers:

```powershell
npm.cmd run tauri:build
```

## Release Artifacts

After a successful Tauri build, installers are created under:

```text
src-tauri\target\release\bundle\
```

Current local build outputs:

- `src-tauri\target\release\bundle\msi\FileFlow Organizer_0.2.0_x64_en-US.msi`
- `src-tauri\target\release\bundle\nsis\FileFlow Organizer_0.2.0_x64-setup.exe`

## Distribution Notes

The installers are unsigned. For public distribution, buy a code signing certificate and configure Tauri signing to reduce Windows SmartScreen warnings.
