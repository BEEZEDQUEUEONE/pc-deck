use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use crate::config::{validate_sensor_url, Config};
use crate::platform::{epoch_ms, run, to_number};

const PS_SCRIPT: &str = include_str!("sensors.ps1");

#[derive(Clone, Default)]
struct Info {
    cpu: Option<Value>,
    gpus: Vec<Value>,
    thermal_zones: Vec<Value>,
    fans: Vec<Value>,
}

#[derive(Clone, Default)]
struct Lhm {
    reachable: bool,
    temperatures: Vec<Value>,
    fans: Vec<Value>,
    error: Option<String>,
}

#[derive(Clone, Default)]
struct Nvidia {
    available: bool,
    gpu: Option<Value>,
}

#[derive(Clone, Default)]
struct State {
    info: Info,
    lhm: Lhm,
    nvidia: Nvidia,
}

pub struct Sensors {
    state: Arc<Mutex<State>>,
    config: Arc<Mutex<Config>>,
}

fn fetch_lhm(url: &str) -> Result<Value, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(4))
        .build()
        .map_err(|error| error.to_string())?;

    let response = client
        .get(format!("{}/data.json", url.trim_end_matches('/')))
        .header("accept", "application/json")
        .send()
        .map_err(|error| {
            if error.is_timeout() {
                "No response from LibreHardwareMonitor".to_string()
            } else {
                error.to_string()
            }
        })?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }

    response.json::<Value>().map_err(|error| error.to_string())
}

fn walk_lhm(node: &Value, trail: &[String], temperatures: &mut Vec<Value>, fans: &mut Vec<Value>) {
    let text = node
        .get("Text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let raw = node
        .get("Value")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();

    let hardware = trail
        .get(1)
        .or_else(|| trail.first())
        .cloned()
        .unwrap_or_default();
    let category = trail
        .get(2)
        .or_else(|| trail.get(1))
        .cloned()
        .unwrap_or_else(|| "Sensors".to_string());

    if !raw.is_empty() {
        let lower = raw.to_ascii_lowercase();

        if raw.contains('°') && lower.contains('c') {
            if let Some(celsius) = to_number(&raw) {
                if celsius > 0.0 && celsius < 130.0 {
                    temperatures.push(json!({
                        "label": if text.is_empty() { "Sensor" } else { &text },
                        "celsius": celsius,
                        "group": category,
                        "hardware": hardware,
                        "source": "LibreHardwareMonitor",
                    }));
                }
            }
        } else if lower.contains("rpm") {
            if let Some(rpm) = to_number(&raw) {
                if rpm > 0.0 {
                    fans.push(json!({
                        "label": if text.is_empty() { "Fan" } else { &text },
                        "rpm": rpm,
                        "percent": Value::Null,
                        "group": category,
                        "hardware": hardware,
                        "source": "LibreHardwareMonitor",
                    }));
                }
            }
        } else if raw.contains('%') {
            let label = text.to_ascii_lowercase();
            if label.contains("fan") || label.contains("pump") {
                fans.push(json!({
                    "label": text,
                    "rpm": Value::Null,
                    "percent": to_number(&raw),
                    "group": category,
                    "hardware": hardware,
                    "source": "LibreHardwareMonitor",
                }));
            }
        }
    }

    let mut next_trail = trail.to_vec();
    if !text.is_empty() && raw.is_empty() {
        next_trail.push(text);
    }
    if next_trail.len() > 3 {
        next_trail.truncate(3);
    }

    if let Some(children) = node.get("Children").and_then(Value::as_array) {
        for child in children {
            walk_lhm(child, &next_trail, temperatures, fans);
        }
    }
}

fn parse_lhm(payload: &Value) -> (Vec<Value>, Vec<Value>) {
    let mut temperatures = Vec::new();
    let mut fans = Vec::new();
    walk_lhm(payload, &[], &mut temperatures, &mut fans);

    let mut seen = HashSet::new();
    let mut dedupe = |items: Vec<Value>| {
        items
            .into_iter()
            .filter(|item| {
                let key = format!(
                    "{}|{}",
                    item.get("hardware").and_then(Value::as_str).unwrap_or(""),
                    item.get("label").and_then(Value::as_str).unwrap_or("")
                );
                seen.insert(key)
            })
            .collect::<Vec<_>>()
    };

    let mut temperatures = dedupe(temperatures);
    temperatures.truncate(32);
    let mut fans = dedupe(fans);
    fans.truncate(16);
    (temperatures, fans)
}

fn refresh_lhm(state: &Arc<Mutex<State>>, url: &str) {
    let parsed = match fetch_lhm(url) {
        Ok(payload) => parse_lhm(&payload),
        Err(error) => {
            if let Ok(mut guard) = state.lock() {
                guard.lhm = Lhm {
                    reachable: false,
                    temperatures: Vec::new(),
                    fans: Vec::new(),
                    error: Some(error),
                };
            }
            return;
        }
    };

    if let Ok(mut guard) = state.lock() {
        guard.lhm = Lhm {
            reachable: true,
            temperatures: parsed.0,
            fans: parsed.1,
            error: None,
        };
    }
}

fn refresh_nvidia(state: &Arc<Mutex<State>>) {
    let result = run(
        "nvidia-smi",
        &[
            "--query-gpu=index,name,temperature.gpu,fan.speed,utilization.gpu,memory.used,memory.total,power.draw",
            "--format=csv,noheader,nounits",
        ],
        Duration::from_secs(5),
    );

    if !result.ok {
        if let Ok(mut guard) = state.lock() {
            guard.nvidia = Nvidia {
                available: false,
                gpu: None,
            };
        }
        return;
    }

    let Some(line) = result.stdout.lines().find(|line| !line.trim().is_empty()) else {
        return;
    };

    let parts: Vec<&str> = line.split(',').map(str::trim).collect();
    if parts.len() < 8 {
        return;
    }

    let gpu = json!({
        "index": to_number(parts[0]),
        "name": if parts[1].is_empty() { "GPU" } else { parts[1] },
        "temperatureC": to_number(parts[2]),
        "fanPercent": to_number(parts[3]),
        "utilizationPercent": to_number(parts[4]),
        "memoryUsedMb": to_number(parts[5]),
        "memoryTotalMb": to_number(parts[6]),
        "powerW": to_number(parts[7]),
        "source": "nvidia-smi",
    });

    if let Ok(mut guard) = state.lock() {
        guard.nvidia = Nvidia {
            available: true,
            gpu: Some(gpu),
        };
    }
}

fn refresh_powershell(state: &Arc<Mutex<State>>, script: &std::path::Path) {
    if !script.exists() {
        return;
    }
    let result = run(
        "powershell.exe",
        &[
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &script.to_string_lossy(),
        ],
        Duration::from_secs(15),
    );

    if !result.ok || result.stdout.trim().is_empty() {
        return;
    }

    let Ok(parsed) = serde_json::from_str::<Value>(result.stdout.trim()) else {
        return;
    };

    let info = Info {
        cpu: parsed.get("cpu").cloned().filter(|value| !value.is_null()),
        gpus: parsed
            .get("gpus")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        thermal_zones: parsed
            .get("thermalZones")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        fans: parsed
            .get("fans")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
    };

    if let Ok(mut guard) = state.lock() {
        guard.info = info;
    }
}

impl Sensors {
    pub fn start(config: Arc<Mutex<Config>>) -> Self {
        let state = Arc::new(Mutex::new(State::default()));

        // The PowerShell bridge ships inside the executable; it is written out
        // once so it can be invoked without a shell.
        let script_path = std::env::temp_dir().join("pc-deck-sensors.ps1");
        let _ = fs::write(&script_path, PS_SCRIPT);

        {
            let state = Arc::clone(&state);
            let script = script_path.clone();
            thread::spawn(move || {
                refresh_powershell(&state, &script);
                loop {
                    thread::sleep(Duration::from_secs(90));
                    refresh_powershell(&state, &script);
                }
            });
        }

        {
            let state = Arc::clone(&state);
            let config = Arc::clone(&config);
            thread::spawn(move || loop {
                let (enabled, url, interval) = config
                    .lock()
                    .map(|cfg| (cfg.lhm_enabled, cfg.lhm_url.clone(), cfg.sensor_refresh_ms))
                    .unwrap_or((true, "http://127.0.0.1:8085".to_string(), 5000));

                if enabled {
                    refresh_lhm(&state, &url);
                }
                refresh_nvidia(&state);
                thread::sleep(Duration::from_millis(interval.max(2000)));
            });
        }

        Self { state, config }
    }

    pub fn refresh_now(&self) {
        let (enabled, url) = self
            .config
            .lock()
            .map(|cfg| (cfg.lhm_enabled, cfg.lhm_url.clone()))
            .unwrap_or((false, String::new()));

        if enabled {
            refresh_lhm(&self.state, &url);
        }
        refresh_nvidia(&self.state);
    }

    pub fn snapshot(&self) -> Value {
        let state = self.state.lock().map(|s| s.clone()).unwrap_or_default();

        let mut temperatures = state.lhm.temperatures.clone();
        let mut fans = state.lhm.fans.clone();

        for zone in &state.info.thermal_zones {
            let celsius = zone.get("celsius").and_then(Value::as_f64);
            if let Some(celsius) = celsius {
                if celsius > 0.0 {
                    let name = zone.get("name").and_then(Value::as_str).unwrap_or("ACPI zone");
                    temperatures.push(json!({
                        "label": name.replace('\\', " / "),
                        "celsius": celsius,
                        "group": "ACPI",
                        "hardware": "Motherboard",
                        "source": "WMI",
                    }));
                }
            }
        }

        for fan in &state.info.fans {
            let rpm = fan.get("rpm").and_then(Value::as_f64);
            if let Some(rpm) = rpm {
                if rpm > 0.0 {
                    let name = fan.get("name").and_then(Value::as_str).unwrap_or("Fan");
                    fans.push(json!({
                        "label": name.replace('\\', " / "),
                        "rpm": rpm,
                        "percent": Value::Null,
                        "group": "Chassis",
                        "hardware": "Motherboard",
                        "source": "WMI",
                    }));
                }
            }
        }

        let gpu = state.nvidia.gpu.clone();
        let helper_covers_gpu = state
            .lhm
            .temperatures
            .iter()
            .chain(state.lhm.fans.iter())
            .any(|item| {
                let text = format!(
                    "{} {}",
                    item.get("hardware").and_then(Value::as_str).unwrap_or(""),
                    item.get("label").and_then(Value::as_str).unwrap_or("")
                )
                .to_ascii_lowercase();
                ["gpu", "nvidia", "radeon", "arc"]
                    .iter()
                    .any(|needle| text.contains(needle))
            });

        if let Some(gpu) = &gpu {
            if !helper_covers_gpu {
                if let Some(celsius) = gpu.get("temperatureC").and_then(Value::as_f64) {
                    temperatures.push(json!({
                        "label": "GPU core",
                        "celsius": celsius,
                        "group": "GPU",
                        "hardware": gpu.get("name").and_then(Value::as_str).unwrap_or("GPU"),
                        "source": "nvidia-smi",
                    }));
                }
                if let Some(percent) = gpu.get("fanPercent").and_then(Value::as_f64) {
                    fans.push(json!({
                        "label": "GPU fan",
                        "rpm": Value::Null,
                        "percent": percent,
                        "group": "GPU",
                        "hardware": gpu.get("name").and_then(Value::as_str).unwrap_or("GPU"),
                        "source": "nvidia-smi",
                    }));
                }
            }
        }

        let has_cpu_temp = temperatures.iter().any(|item| {
            let source = item.get("source").and_then(Value::as_str).unwrap_or("");
            let label = item
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_ascii_lowercase();
            source != "nvidia-smi"
                && ["cpu", "core", "package", "tctl", "tdie", "ccd"]
                    .iter()
                    .any(|needle| label.contains(needle))
        });

        let hint = if temperatures.is_empty() {
            Some("No temperature sensors reported. Windows does not expose them without a helper: run LibreHardwareMonitor (Options → Remote Web Server, port 8085) and this panel picks it up automatically.")
        } else if !has_cpu_temp {
            Some("CPU temperature is not exposed by Windows. Run LibreHardwareMonitor with its web server on port 8085 to add per-core temperatures and fan RPM.")
        } else {
            None
        };

        json!({
            "cpu": state.info.cpu,
            "gpus": state.info.gpus,
            "temperatures": temperatures,
            "fans": fans,
            "gpu": gpu,
            "sources": {
                "libreHardwareMonitor": state.lhm.reachable,
                "nvidiaSmi": state.nvidia.available,
                "wmiThermalZones": state.info.thermal_zones.len(),
            },
            "hint": hint,
            "updatedAt": epoch_ms(),
        })
    }
}

pub fn test_source(url: &str) -> Value {
    let url = match validate_sensor_url(url) {
        Ok(url) => url,
        Err(error) => {
            return json!({
                "ok": false,
                "temperatures": 0,
                "fans": 0,
                "samples": [],
                "error": error,
            })
        }
    };

    match fetch_lhm(&url) {
        Ok(payload) => {
            let (temperatures, fans) = parse_lhm(&payload);
            let mut samples: Vec<String> = temperatures
                .iter()
                .take(3)
                .map(|item| {
                    format!(
                        "{} {:.1}°C",
                        item.get("label").and_then(Value::as_str).unwrap_or("Sensor"),
                        item.get("celsius").and_then(Value::as_f64).unwrap_or(0.0)
                    )
                })
                .collect();

            samples.extend(fans.iter().take(2).map(|fan| {
                let label = fan.get("label").and_then(Value::as_str).unwrap_or("Fan");
                match fan.get("rpm").and_then(Value::as_f64) {
                    Some(rpm) => format!("{label} {rpm:.0} rpm"),
                    None => format!(
                        "{label} {:.0}%",
                        fan.get("percent").and_then(Value::as_f64).unwrap_or(0.0)
                    ),
                }
            }));

            json!({
                "ok": true,
                "temperatures": temperatures.len(),
                "fans": fans.len(),
                "samples": samples,
            })
        }
        Err(error) => json!({
            "ok": false,
            "temperatures": 0,
            "fans": 0,
            "samples": [],
            "error": if error.contains("No response") { error } else { error },
        }),
    }
}
