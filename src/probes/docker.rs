use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Duration;

use crate::platform::{epoch_ms, run};

struct Probe {
    checked_at: u64,
    available: bool,
    version: Option<String>,
    error: Option<String>,
}

static PROBE: Mutex<Probe> = Mutex::new(Probe {
    checked_at: 0,
    available: false,
    version: None,
    error: None,
});

fn describe_failure(stdout: &str, stderr: &str, timed_out: bool) -> String {
    let text = format!("{stderr}\n{stdout}").to_ascii_lowercase();
    if text.contains("enoent") || text.contains("not recognized") || text.contains("not found") {
        return "Docker CLI is not on PATH. Install Docker Desktop, or turn the container panel off in config.json.".to_string();
    }
    if text.contains("error during connect")
        || text.contains("cannot connect")
        || text.contains("pipe")
    {
        return "Docker is installed but the engine is not running. Start Docker Desktop and this panel will connect.".to_string();
    }
    if timed_out {
        return "Docker did not answer in time.".to_string();
    }
    stderr
        .lines()
        .chain(stdout.lines())
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim().chars().take(240).collect())
        .unwrap_or_else(|| "Docker is unavailable.".to_string())
}

fn probe(force: bool) {
    let mut state = match PROBE.lock() {
        Ok(state) => state,
        Err(_) => return,
    };

    if !force && state.checked_at > 0 && epoch_ms().saturating_sub(state.checked_at) < 15_000 {
        return;
    }

    let result = run(
        "docker",
        &["version", "--format", "{{.Server.Version}}"],
        Duration::from_secs(5),
    );
    state.checked_at = epoch_ms().max(1);

    if result.ok {
        state.available = true;
        state.version = Some(result.stdout.trim().to_string()).filter(|text| !text.is_empty());
        state.error = None;
    } else {
        state.available = false;
        state.version = None;
        state.error = Some(describe_failure(&result.stdout, &result.stderr, result.timed_out));
    }
}

fn parse_containers(stdout: &str) -> Vec<Value> {
    let mut containers: Vec<(bool, String, Value)> = Vec::new();

    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(row) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let text = |key: &str| {
            row.get(key)
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string()
        };
        let name = text("Names");
        let state = text("State").to_ascii_lowercase();
        let id = text("ID");
        let value = json!({
            "id": id.chars().take(12).collect::<String>(),
            "name": name,
            "image": text("Image"),
            "command": text("Command"),
            "state": state,
            "status": text("Status"),
            "ports": text("Ports"),
            "runningFor": text("RunningFor"),
        });
        containers.push((state == "running", name, value));
    }

    containers.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    containers.into_iter().map(|(_, _, value)| value).collect()
}

pub fn list(enabled: bool) -> Value {
    if !enabled {
        return json!({
            "available": false,
            "disabled": true,
            "error": "The container panel is turned off in config.json.",
            "containers": [],
        });
    }

    probe(false);

    let (available, version, error) = match PROBE.lock() {
        Ok(state) => (state.available, state.version.clone(), state.error.clone()),
        Err(_) => (false, None, Some("Docker state is unavailable.".to_string())),
    };

    if !available {
        return json!({
            "available": false,
            "version": Value::Null,
            "error": error,
            "containers": [],
        });
    }

    let result = run(
        "docker",
        &["ps", "-a", "--no-trunc", "--format", "{{json .}}"],
        Duration::from_secs(15),
    );

    if !result.ok {
        if let Ok(mut state) = PROBE.lock() {
            state.available = false;
            state.checked_at = 0;
            state.error = Some(describe_failure(&result.stdout, &result.stderr, result.timed_out));
        }
        return json!({
            "available": false,
            "version": Value::Null,
            "error": describe_failure(&result.stdout, &result.stderr, result.timed_out),
            "containers": [],
        });
    }

    json!({
        "available": true,
        "version": version,
        "error": Value::Null,
        "containers": parse_containers(&result.stdout),
    })
}

fn valid_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes.len() > 128 {
        return false;
    }
    let first = bytes[0] as char;
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    bytes
        .iter()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'_' | b'.' | b'-'))
}

pub fn action(enabled: bool, name: &str, action: &str) -> Value {
    if !enabled {
        return json!({ "ok": false, "error": "The container panel is turned off in config.json." });
    }

    let action = action.to_ascii_lowercase();
    if !matches!(action.as_str(), "start" | "stop" | "restart") {
        return json!({ "ok": false, "error": "Only start, stop and restart are allowed." });
    }
    if !valid_name(name) {
        return json!({ "ok": false, "error": "Invalid container name." });
    }

    // Confirm the container exists so only a real name can reach docker.
    let listing = list(enabled);
    let known = listing
        .get("containers")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .any(|item| item.get("name").and_then(Value::as_str) == Some(name))
        })
        .unwrap_or(false);

    if !listing
        .get("available")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return json!({
            "ok": false,
            "error": listing.get("error").and_then(Value::as_str).unwrap_or("Docker is unavailable."),
        });
    }
    if !known {
        return json!({ "ok": false, "error": format!("No container named \"{name}\".") });
    }

    let result = run("docker", &[&action, name], Duration::from_secs(45));
    if !result.ok {
        return json!({
            "ok": false,
            "error": describe_failure(&result.stdout, &result.stderr, result.timed_out),
        });
    }

    json!({ "ok": true, "message": format!("{action} sent to {name}") })
}
