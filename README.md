# PC Deck

A local dashboard for a single Windows PC. Live CPU, memory, GPU, temperatures and fan speeds, a
WizTree-style disk map, Docker containers, and uptime checks for your sites — in one page that only
your machine can open.

It runs on Node with **zero dependencies**. No build step, no installer, no account, no telemetry.

## Panels

- **Overview** — CPU load overall and per core with a rolling sparkline, memory use, GPU temperature,
  fan, load, VRAM and power, drive capacity, uptime, and how much memory the dashboard itself uses.
- **Disk space** — a squarified treemap of a folder, with its largest files, a ranked list below it and
  click-to-drill navigation. Scans run on demand, are cached for ten minutes and report when a folder
  was only partly measured.
- **Containers** — lists Docker containers and allows start, stop and restart. Nothing else: no shell,
  no deletes, no compose edits. The panel explains itself instead of failing when Docker is absent.
- **Site** — status code, latency and error for each configured site, plus buttons for the site, an
  admin URL and any quick links.
- **Settings** — themes, site entries, container options, allowed drives and the CPU temperature helper,
  written back to `config.json`.

## Requirements

- Windows 10 or 11
- Node.js **18.17 or newer**
- Optional: Docker Desktop for the containers panel
- Optional: a sensor helper for CPU temperatures (the dashboard can download one for you)

## Run it

```bash
npm start
```

Then open <http://127.0.0.1:4317>. There is nothing to install first: the project has no dependencies.

On Windows you can also double-click **`start.bat`**, which starts the dashboard and opens it for you.

On first run a `config.json` is created next to `package.json` with sensible defaults. Drives are
detected automatically.

## CPU temperatures

Windows does not expose CPU temperatures to normal user programs. On most desktops there is no ACPI
thermal zone to read at all, so any app that shows CPU package, per-core or motherboard temperatures —
LibreHardwareMonitor, OpenHardwareMonitor, HWiNFO, Core Temp — loads a small kernel driver to talk to
the chip. That driver requires administrator rights, once.

PC Deck does not ship or load a driver itself. In **Settings → CPU temperatures** you can:

1. Press **Download helper**. It fetches the official LibreHardwareMonitor release from GitHub, verifies
   its SHA-256 checksum and unpacks it into `tools/` inside this project.
2. Press **Start helper**. Windows shows its permission prompt; approve it. That prompt belongs to the
   helper, not to the dashboard.
3. In the helper window open **Options → Remote Web Server → Run** (port 8085).
4. Press **Test connection** here.

Temperatures and fan RPM then appear on the overview, and are picked up automatically on later runs.
Already running a compatible helper? Skip the download and point the URL field at it.

Without a helper the dashboard still works, using the GPU sensors that nvidia-smi exposes.

## Security model

This is a single-machine tool, and it is built to stay that way:

- The server binds to `127.0.0.1` only; nothing on your network can reach it.
- Requests whose `Host` header is not loopback are rejected (DNS rebinding), and state-changing
  requests must come from the dashboard's own origin.
- The dashboard never runs elevated. Only the optional helper does, launched through the normal Windows
  consent prompt.
- No shell is ever executed with user input. Commands use fixed argument lists; a container action is
  checked against the live container list before it runs.
- Files are only ever read, and only for their names and sizes, and only inside the drives listed in
  `config.json`. Nothing is written, moved or deleted outside `config.json` and the helper folder.
- No telemetry, no analytics, no outbound requests except the site checks you configure and the
  optional helper download.

## Configuration

`config.json` is the source of truth and can be edited by hand or from the Settings panel.

| Key | Default | Purpose |
| --- | --- | --- |
| `port` | `4317` | Local port. Restart after changing it. |
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
server/
  index.js          HTTP server, API routes, static files
  config.js         defaults, validation, settings persistence
  security.js       loopback host/origin checks and response headers
  probes/
    system.js       CPU, memory, volumes
    sensors.js      GPU, helper, ACPI sensor aggregation
    sensors.ps1     PowerShell bridge for names/fans/thermal zones
    helper.js       optional LibreHardwareMonitor download and launch
    disktree.js     on-demand disk measurement with limits and caching
    docker.js       container list and start/stop/restart
    sites.js        uptime checks
  util/run.js       no-shell command runner with timeouts
web/                static UI (no framework, no build step)
```

## Known limitations

- CPU temperatures require the helper described above; there is no driver-free way on Windows.
- Locked system files such as `pagefile.sys` cannot be measured without administrator rights, so a
  drive total can read lower than Windows reports. Files protected by permissions are skipped too.
- A disk scan is capped at 1.5 million files or 120 seconds. Reaching either marks the result as partial
  rather than hanging.
- Site checks are one request from your PC; there is no history or alerting.
- The helper is fetched at runtime from its own project and is covered by its own licence (MPL-2.0).
  It is not redistributed with this repository.

## Licence

MIT — see [LICENSE](LICENSE).
