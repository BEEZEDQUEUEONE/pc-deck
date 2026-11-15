use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::config::app_dir;
use crate::platform::{epoch_ms, run};

/// Optional sensor helper.
///
/// Windows will not hand CPU temperatures to a normal process, so the dashboard
/// fetches LibreHardwareMonitor from its official release, verifies the
/// checksum and launches it. The download lives inside the app folder, and
/// Windows asks for administrator permission for the helper itself only.
const VERSION: &str = "0.9.6";
const DOWNLOAD_URL: &str = "https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases/download/v0.9.6/LibreHardwareMonitor.zip";
const EXPECTED_SHA256: &str = "086d9f1b5a99e643edc2cfaaac16051685b551e4c5ac0b32a57c58c0e529c001";
const MAX_DOWNLOAD_BYTES: u64 = 40 * 1024 * 1024;

static INSTALLING: Mutex<bool> = Mutex::new(false);
static RUNNING: Mutex<Option<(Instant, bool)>> = Mutex::new(None);

fn tools_dir() -> PathBuf {
    app_dir().join("tools")
}

fn helper_dir() -> PathBuf {
    tools_dir().join("libre-hardware-monitor")
}

fn helper_exe() -> PathBuf {
    helper_dir().join("LibreHardwareMonitor.exe")
}

fn zip_path() -> PathBuf {
    tools_dir().join("libre-hardware-monitor.zip")
}

fn is_installed() -> bool {
    helper_exe().exists()
}

fn is_running() -> bool {
    if let Ok(guard) = RUNNING.lock() {
        if let Some((checked, value)) = *guard {
            if checked.elapsed() < Duration::from_secs(5) {
                return value;
            }
        }
    }

    let result = run(
        "tasklist",
        &["/FI", "IMAGENAME eq LibreHardwareMonitor.exe", "/NH"],
        Duration::from_secs(5),
    );
    let value = result.ok && result.stdout.to_ascii_lowercase().contains("librehardwaremonitor.exe");

    if let Ok(mut guard) = RUNNING.lock() {
        *guard = Some((Instant::now(), value));
    }
    value
}

fn reset_running_cache() {
    if let Ok(mut guard) = RUNNING.lock() {
        *guard = None;
    }
}

pub fn status() -> Value {
    let installed = is_installed();
    json!({
        "version": VERSION,
        "installed": installed,
        "running": if installed { is_running() } else { false },
        "directory": if installed { Some(helper_dir().to_string_lossy().to_string()) } else { None },
        "downloadMb": 6.3,
    })
}

pub fn install() -> Result<Value, (u16, String)> {
    {
        let mut guard = INSTALLING.lock().map_err(|_| (500, "Helper state is unavailable.".to_string()))?;
        if *guard {
            return Err((409, "The helper is already downloading.".to_string()));
        }
        if is_installed() {
            return Ok(status());
        }
        *guard = true;
    }

    let result = download_and_unpack();
    if let Ok(mut guard) = INSTALLING.lock() {
        *guard = false;
    }

    match result {
        Ok(()) => Ok(status()),
        Err(error) => {
            let _ = fs::remove_file(zip_path());
            Err((500, error))
        }
    }
}

fn download_and_unpack() -> Result<(), String> {
    let _ = fs::create_dir_all(helper_dir());

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|error| error.to_string())?;

    let response = client
        .get(DOWNLOAD_URL)
        .header("user-agent", "pc-deck/0.2 (local dashboard)")
        .send()
        .map_err(|error| error.to_string())?;

    if !response.status().is_success() {
        return Err(format!("GitHub returned HTTP {}", response.status().as_u16()));
    }

    let bytes = response.bytes().map_err(|error| error.to_string())?;
    if bytes.is_empty() {
        return Err("The download was empty.".to_string());
    }
    if bytes.len() as u64 > MAX_DOWNLOAD_BYTES {
        return Err("The download was larger than expected.".to_string());
    }

    let digest = Sha256::digest(&bytes);
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    if hex != EXPECTED_SHA256 {
        return Err("The downloaded helper did not match the expected checksum, so it was discarded.".to_string());
    }

    let archive_path = zip_path();
    fs::write(&archive_path, &bytes).map_err(|error| error.to_string())?;

    let unpacked = (|| -> Result<(), String> {
        let file = fs::File::open(&archive_path).map_err(|error| error.to_string())?;
        let mut archive = zip::ZipArchive::new(file).map_err(|error| error.to_string())?;
        archive
            .extract(helper_dir())
            .map_err(|error| error.to_string())?;
        Ok(())
    })();

    let _ = fs::remove_file(&archive_path);
    unpacked?;

    if !helper_exe().exists() {
        return Err("The helper archive did not contain LibreHardwareMonitor.exe.".to_string());
    }

    Ok(())
}

fn ps_quote(value: &str) -> String {
    value.replace('\'', "''")
}

pub fn start() -> Result<Value, (u16, String)> {
    if !is_installed() {
        return Err((400, "Download the helper first.".to_string()));
    }

    let exe = helper_exe().to_string_lossy().to_string();
    let dir = helper_dir().to_string_lossy().to_string();
    let command = format!(
        "Start-Process -FilePath '{}' -WorkingDirectory '{}' -Verb RunAs",
        ps_quote(&exe),
        ps_quote(&dir)
    );

    let launched = run(
        "powershell.exe",
        &[
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &command,
        ],
        Duration::from_secs(20),
    );

    reset_running_cache();

    if !launched.ok {
        let line = launched
            .first_error_line()
            .filter(|text| !text.to_ascii_lowercase().contains("cancel"))
            .map(|text| text.chars().take(240).collect::<String>())
            .unwrap_or_else(|| {
                "The helper was not started. Windows asks for administrator permission — approve it to continue.".to_string()
            });

        return Ok(json!({
            "ok": false,
            "error": line,
            "status": status(),
        }));
    }

    Ok(json!({ "ok": true, "status": status() }))
}

pub fn installed_at() -> Option<String> {
    if is_installed() {
        Some(helper_dir().to_string_lossy().to_string())
    } else {
        None
    }
}

pub fn last_seen() -> u64 {
    epoch_ms()
}
