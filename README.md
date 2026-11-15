# PC Deck

A native Windows desktop app for looking at one PC. Live CPU, memory, GPU, temperatures and fan
speeds, a WizTree-style disk map, Docker containers, and uptime checks for your sites — in a single
window.

It is one small `.exe`. No browser tab, no local server, no installer, no account, no telemetry and
no administrator rights.

## Panels

- **Overview** — CPU load overall and per core with a rolling sparkline, memory use, GPU temperature,
  fan, load, VRAM and power, drive capacity, uptime, and how much memory the app itself uses.
- **Disk space** — a squarified treemap of a folder, its largest files, a ranked list below it and
  click-to-drill navigation. Scans run on demand, are cached for ten minutes and report when a folder
  was only partly measured.
- **Containers** — lists Docker containers and allows start, stop and restart. Nothing else: no shell,
  no deletes, no compose edits. The panel explains itself instead of failing when Docker is absent.
- **Site** — status code, latency and error for each configured site, plus buttons for the site, an
  admin URL and any quick links.
- **Settings** — themes, site entries, container options, allowed drives and the CPU temperature helper,
  written back to `config.json`.

## Requirements

- Windows 10 or 11, 64-bit
- **WebView2 runtime** — included with Windows 11 and up-to-date Windows 10. If it is missing, install
  Microsoft's Evergreen runtime once.
- Optional: Docker Desktop for the containers panel
- Optional: a sensor helper for CPU temperatures (the app can download one for you)

## Run it

Double-click **`PC Deck.exe`**.

On first run a `config.json` is created next to the executable with sensible defaults. Drives are
detected automatically.

## Build from source

You need Rust stable and the Microsoft C++ build tools (Rust on Windows links against MSVC):

```bash
rustup-init -y --default-toolchain stable-x86_64-pc-windows-msvc
winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
cargo build --release
```

The result is `target/release/pc-deck.exe` — rename it to `PC Deck.exe` and put it wherever you like.
No Node, npm or web toolchain is involved.

## CPU temperatures

Windows does not expose CPU temperatures to normal programs. On most desktops there is no ACPI
thermal zone to read at all, so any app that shows CPU package, per-core or motherboard temperatures —
LibreHardwareMonitor, OpenHardwareMonitor, HWiNFO, Core Temp — loads a small kernel driver to talk to
the chip. That driver requires administrator rights, once.

PC Deck does not ship or load a driver itself. In **Settings → CPU temperatures** you can:

1. Press **Download helper**. It fetches the official LibreHardwareMonitor release from GitHub, verifies
   its SHA-256 checksum and unpacks it into `tools\` next to the executable.
2. Press **Start helper**. Windows shows its permission prompt; approve it. That prompt belongs to the
   helper, not to PC Deck.
3. In the helper window open **Options → Remote Web Server → Run** (port 8085).
4. Press **Test connection** here.

Temperatures and fan RPM then appear on the overview, and are picked up automatically on later runs.
Already running a compatible helper? Skip the download and point the URL field at it.

Without a helper the app still works, using the GPU sensors that nvidia-smi exposes.

## Security model

This is a single-machine tool, and it is built to stay that way:

- **No network port is opened.** There is no HTTP server to connect to. The interface is embedded in
  the executable and speaks to Rust through WebView2's in-process IPC, so another device has nothing
  to reach.
- The app runs as your normal user. Only the optional helper is elevated, through the standard Windows
  consent prompt.
- No shell is ever executed with user input. Commands use fixed argument lists; a container action is
  checked against the live container list before it runs.
- Files are only ever read, only for their names and sizes, and only inside the drives listed in
  `config.json`. Nothing is written, moved or deleted outside `config.json` and the helper folder.
- Outbound requests happen only for the site checks you configure and the optional helper download.
- No telemetry, no analytics, no accounts.

## Configuration

`config.json` sits next to the executable and can be edited by hand or from the Settings panel.

| Key | Default | Purpose |
| --- | --- | --- |
| `theme` | `midnight` | `midnight`, `ember`, `violet` or `daylight`. |
| `diskRoots` | detected drives | Folders the disk map may read. Absolute paths only. |
| `refreshMs` | `2000` | How often the overview samples the machine. |
| `sensorRefreshMs` | `5000` | How often sensors are polled. |
| `docker.enabled` | `true` | Show the containers panel. |
| `docker.refreshMs` | `6000` | Container list refresh interval. |
| `libreHardwareMonitor.enabled` | `true` | Use a local sensor helper. |
| `libreHardwareMonitor.url` | `http://127.0.0.1:8085` | Helper address; must be loopback. |
| `sites` | one example | Site entries, admin URLs and quick links. |

URLs accept `example.com` as well as `https://example.com`.

## Project layout

```
src/
  main.rs           native window, embedded UI, IPC wiring
  api.rs            request dispatcher (same payloads the UI has always used)
  config.rs         defaults, validation, settings persistence
  platform.rs       fixed-argument command runner, Windows version, helpers
  bridge.js         page-side bridge that turns API calls into IPC
  probes/
    system.rs       CPU, memory, volumes
    sensors.rs      GPU, helper, ACPI sensor aggregation
    sensors.ps1     PowerShell bridge for names/fans/thermal zones
    helper.rs       optional LibreHardwareMonitor download and launch
    disktree.rs     on-demand disk measurement with limits and caching
    docker.rs       container list and start/stop/restart
    sites.rs        uptime checks
web/                static UI (no framework, no build step, inlined at build time)
```

## Known limitations

- CPU temperatures require the helper described above; there is no driver-free way on Windows.
- The app needs the WebView2 runtime, which is part of Windows 11 but may need installing on older
  Windows 10 machines.
- Locked system files such as `pagefile.sys` cannot be measured without administrator rights, so a
  drive total can read lower than Windows reports. Files protected by permissions are skipped too.
- A disk scan is capped at 1.5 million files or 120 seconds. Reaching either marks the result as partial
  rather than hanging.
- Site checks are one request from your PC; there is no history or alerting.
- There is no installer and no code signing, so Windows SmartScreen may ask once before opening a build
  you compiled yourself.
- The helper is fetched at runtime from its own project and is covered by its own licence (MPL-2.0).
  It is not redistributed with this repository.

## Code signing

Builds are unsigned, so another PC may show a SmartScreen warning the first time. Removing that
needs a certificate you own — an OV/EV code-signing certificate, or Microsoft's Azure Artifact
Signing (formerly Trusted Signing). With the Windows SDK and a certificate installed:

```bat
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 "PC Deck.exe"
signtool verify /pa "PC Deck.exe"
```

A signature proves who published the file and that it was not modified afterwards. It does not
immediately clear SmartScreen: reputation builds as people download and run the same publisher's
signed builds.

## Licence

All rights reserved. The source is published so it can be read; copying, modification, redistribution
or republishing any part of it is not permitted. See [LICENSE](LICENSE).
