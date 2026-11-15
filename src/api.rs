use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

use crate::config::{self, Config, Site};
use crate::platform::epoch_ms;
use crate::probes::disktree::DiskTree;
use crate::probes::sensors::Sensors;
use crate::probes::system::SystemProbe;
use crate::probes::{docker, helper, sites};

pub struct AppState {
    pub config: Arc<Mutex<Config>>,
    pub system: SystemProbe,
    pub sensors: Sensors,
    pub disk: DiskTree,
    pub started_at: u64,
}

fn settings_view(config: &Config) -> Value {
    json!({
        "theme": config.theme,
        "sites": config.sites.iter().map(Site::to_value).collect::<Vec<_>>(),
        "docker": { "enabled": config.docker_enabled, "refreshMs": config.docker_refresh_ms },
        "sensors": { "enabled": config.lhm_enabled, "url": config.lhm_url },
        "diskRoots": config.disk_roots,
    })
}

fn query_value<'a>(query: &'a str, key: &str) -> Option<&'a str> {
    query.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=')?;
        if name == key {
            Some(value)
        } else {
            None
        }
    })
}

fn error(status: u16, message: &str) -> (u16, Value) {
    (status, json!({ "error": message }))
}

pub fn handle(state: &Arc<AppState>, raw_url: &str, method: &str, body: Option<Value>) -> (u16, Value) {
    let (path, query) = raw_url.split_once('?').unwrap_or((raw_url, ""));
    let method = method.to_ascii_uppercase();
    let body = body.unwrap_or_else(|| json!({}));

    let config = match state.config.lock() {
        Ok(config) => config.clone(),
        Err(_) => return error(500, "Settings are unavailable."),
    };

    match (path, method.as_str()) {
        ("/api/config", "GET") => (
            200,
            json!({
                "version": env!("CARGO_PKG_VERSION"),
                "refreshMs": config.refresh_ms,
                "sensorRefreshMs": config.sensor_refresh_ms,
                "diskRoots": config.disk_roots,
                "dockerEnabled": config.docker_enabled,
                "dockerRefreshMs": config.docker_refresh_ms,
                "theme": config.theme,
                "sites": config.sites.iter().map(Site::to_value).collect::<Vec<_>>(),
                "uptimeSec": epoch_ms().saturating_sub(state.started_at) / 1000,
            }),
        ),

        ("/api/settings", "GET") => (200, json!({ "settings": settings_view(&config) })),

        ("/api/settings", "PUT") => match config::validate_settings(&body, &config) {
            Ok(next) => {
                if let Err(failure) = config::save(&next) {
                    return error(500, &format!("Could not write config.json: {failure}"));
                }
                if let Ok(mut live) = state.config.lock() {
                    *live = next.clone();
                }
                state.sensors.refresh_now();
                (200, json!({ "ok": true, "settings": settings_view(&next) }))
            }
            Err(message) => error(400, &message),
        },

        ("/api/sensors/test", "POST") => {
            let url = body.get("url").and_then(Value::as_str).unwrap_or("");
            (200, crate::probes::sensors::test_source(url))
        }

        ("/api/helper", "GET") => (200, helper::status()),

        ("/api/helper/install", "POST") => match helper::install() {
            Ok(status) => (200, json!({ "ok": true, "status": status })),
            Err((status_code, message)) => (
                status_code,
                json!({ "ok": false, "error": message, "status": helper::status() }),
            ),
        },

        ("/api/helper/start", "POST") => match helper::start() {
            Ok(value) => (200, value),
            Err((status_code, message)) => (
                status_code,
                json!({ "ok": false, "error": message, "status": helper::status() }),
            ),
        },

        ("/api/system", "GET") => (200, state.system.snapshot()),
        ("/api/sensors", "GET") => (200, state.sensors.snapshot()),

        ("/api/docker", "GET") => (200, docker::list(config.docker_enabled)),

        ("/api/docker/action", "POST") => {
            if !config.docker_enabled {
                return error(403, "The container panel is turned off in config.json.");
            }
            let name = body.get("name").and_then(Value::as_str).unwrap_or("");
            let action = body.get("action").and_then(Value::as_str).unwrap_or("");
            (200, docker::action(config.docker_enabled, name, action))
        }

        ("/api/sites", "GET") => {
            let force = query_value(query, "refresh") == Some("1");
            let list = sites::check(&config.sites, force);
            (200, json!({ "sites": list }))
        }

        ("/api/disk/scan", "POST") => {
            let path = body.get("path").and_then(Value::as_str).unwrap_or("");
            match crate::probes::disktree::validate(path, &config.disk_roots) {
                Ok(target) => {
                    let refresh = body
                        .get("refresh")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    (200, state.disk.start(target, refresh))
                }
                Err((status, message)) => error(status, &message),
            }
        }

        ("/api/disk/scan", "GET") => {
            let id = query_value(query, "id").unwrap_or("");
            match state.disk.get(id) {
                Some(job) => (200, job),
                None => error(404, "That scan is no longer available. Start a new one."),
            }
        }

        _ => error(404, "Unknown API route"),
    }
}

/// Turns one IPC message into the JavaScript call that settles the matching
/// promise in the page. Payloads are embedded as JSON string literals so quotes,
/// newlines and unicode survive intact.
pub fn handle_ipc(state: &Arc<AppState>, raw: &str) -> String {
    let request: Value = serde_json::from_str(raw).unwrap_or_else(|_| json!({}));
    let id = request.get("id").and_then(Value::as_u64).unwrap_or(0);
    let url = request.get("url").and_then(Value::as_str).unwrap_or("");
    let method = request.get("method").and_then(Value::as_str).unwrap_or("GET");

    let body = request
        .get("body")
        .and_then(Value::as_str)
        .and_then(|text| serde_json::from_str::<Value>(text).ok());

    let (status, payload) = handle(state, url, method, body);
    // JSON is also valid JavaScript, so the object is embedded directly. Wrapping
    // it in a string would hand the page a string instead of a parsed response.
    let payload_text = serde_json::to_string(&payload).unwrap_or_else(|_| "null".to_string());

    if std::env::args().any(|arg| arg == "--log-ipc") {
        use std::io::Write;
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(crate::config::app_dir().join("tools").join("ipc.log"))
        {
            let _ = writeln!(file, "{method} {url} -> {status} ({} bytes)", payload_text.len());
        }
    }

    format!("window.__pcdeckResolve({id}, {status}, {payload_text});")
}
