use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

pub const THEMES: [&str; 4] = ["midnight", "ember", "violet", "daylight"];

#[derive(Clone, Debug)]
pub struct Link {
    pub label: String,
    pub url: String,
}

#[derive(Clone, Debug)]
pub struct Site {
    pub name: String,
    pub url: String,
    pub admin_url: String,
    pub links: Vec<Link>,
}

impl Site {
    pub fn to_value(&self) -> Value {
        json!({
            "name": self.name,
            "url": self.url,
            "adminUrl": self.admin_url,
            "links": self.links.iter().map(|link| json!({ "label": link.label, "url": link.url })).collect::<Vec<_>>(),
        })
    }
}

#[derive(Clone, Debug)]
pub struct Config {
    pub port: u16,
    pub theme: String,
    pub disk_roots: Vec<String>,
    pub refresh_ms: u64,
    pub sensor_refresh_ms: u64,
    pub docker_enabled: bool,
    pub docker_refresh_ms: u64,
    pub lhm_enabled: bool,
    pub lhm_url: String,
    pub sites: Vec<Site>,
}

pub fn app_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

pub fn config_path() -> PathBuf {
    app_dir().join("config.json")
}

fn detect_roots() -> Vec<String> {
    let mut roots = Vec::new();
    for letter in b'C'..=b'Z' {
        let candidate = format!("{}:\\", letter as char);
        if Path::new(&candidate).exists() {
            roots.push(candidate);
        }
    }
    if roots.is_empty() {
        roots.push("C:\\".to_string());
    }
    roots
}

fn clamp(value: &Value, min: u64, max: u64, fallback: u64) -> u64 {
    match value.as_u64() {
        Some(number) => number.clamp(min, max),
        None => fallback,
    }
}

pub fn normalize_site_url(value: &str) -> String {
    let raw = value.trim();
    if raw.is_empty() {
        return String::new();
    }
    let lower = raw.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return raw.to_string();
    }
    if raw.starts_with("//") {
        return format!("https:{}", raw);
    }
    format!("https://{}", raw.trim_start_matches('/'))
}

fn url_host(url: &str) -> Option<String> {
    let (_, rest) = url.split_once("://")?;
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host.is_empty() {
        None
    } else {
        Some(host.to_string())
    }
}

fn is_http(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

pub fn validate_sensor_url(value: &str) -> Result<String, String> {
    let url = value.trim().trim_end_matches('/').to_string();
    let lower = url.to_ascii_lowercase();

    let scheme_ok = lower.starts_with("http://") || lower.starts_with("https://");
    let rest = lower.split_once("://").map(|(_, tail)| tail).unwrap_or("");
    let host = rest.split(['/', ':']).next().unwrap_or("");
    let loopback = matches!(host, "127.0.0.1" | "localhost") || rest.starts_with("[::1]");

    if !scheme_ok || !loopback || rest.is_empty() {
        return Err("The helper URL must point at this machine (127.0.0.1 or localhost).".to_string());
    }
    Ok(url)
}

fn normalize_sites(input: Option<&Value>) -> Vec<Site> {
    let Some(entries) = input.and_then(Value::as_array) else {
        return Vec::new();
    };

    let mut sites = Vec::new();
    for entry in entries.iter().take(24) {
        let url = normalize_site_url(entry.get("url").and_then(Value::as_str).unwrap_or(""));
        if !is_http(&url) {
            continue;
        }
        let host = url_host(&url).unwrap_or_else(|| "site".to_string());

        let links = entry
            .get("links")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(|link| {
                        let link_url = link.get("url").and_then(Value::as_str).unwrap_or("");
                        if !is_http(link_url) {
                            return None;
                        }
                        let label = link
                            .get("label")
                            .and_then(Value::as_str)
                            .filter(|text| !text.is_empty())
                            .unwrap_or(link_url);
                        Some(Link {
                            label: label.chars().take(60).collect(),
                            url: link_url.to_string(),
                        })
                    })
                    .take(12)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        sites.push(Site {
            name: entry
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())
                .map(|name| name.chars().take(60).collect())
                .unwrap_or(host),
            url,
            admin_url: normalize_site_url(
                entry.get("adminUrl").and_then(Value::as_str).unwrap_or(""),
            ),
            links,
        });
    }
    sites
}

/// `fs::canonicalize` prefixes Windows paths with `\\?\`; the rest of the app
/// compares and displays plain drive paths.
fn strip_verbatim(path: &str) -> String {
    path.strip_prefix(r"\\?\").unwrap_or(path).to_string()
}

fn sanitize_roots(input: Option<&Value>) -> Vec<String> {
    let Some(list) = input.and_then(Value::as_array) else {
        return Vec::new();
    };

    let mut roots: Vec<String> = Vec::new();
    for entry in list {
        let Some(text) = entry.as_str() else { continue };
        let trimmed = text.trim();
        if trimmed.is_empty() || !Path::new(trimmed).is_absolute() {
            continue;
        }
        let resolved = fs::canonicalize(trimmed)
            .map(|path| strip_verbatim(&path.to_string_lossy()))
            .unwrap_or_else(|_| trimmed.to_string());
        if !roots.iter().any(|root| root.eq_ignore_ascii_case(&resolved)) {
            roots.push(resolved);
        }
    }
    roots
}

pub fn normalize(raw: &Value) -> Config {
    let source = raw.as_object();
    let docker = source
        .and_then(|object| object.get("docker"))
        .and_then(Value::as_object);
    let lhm = source
        .and_then(|object| object.get("libreHardwareMonitor"))
        .and_then(Value::as_object);

    let fallback_url = "http://127.0.0.1:8085".to_string();
    let lhm_url = lhm
        .and_then(|object| object.get("url"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .and_then(|value| validate_sensor_url(value).ok())
        .unwrap_or(fallback_url);

    let roots = sanitize_roots(source.and_then(|object| object.get("diskRoots")));
    let theme = source
        .and_then(|object| object.get("theme"))
        .and_then(Value::as_str)
        .filter(|value| THEMES.contains(value))
        .unwrap_or("midnight")
        .to_string();

    Config {
        port: clamp(
            source.and_then(|o| o.get("port")).unwrap_or(&Value::Null),
            1024,
            65535,
            4317,
        ) as u16,
        theme,
        disk_roots: if roots.is_empty() { detect_roots() } else { roots },
        refresh_ms: clamp(
            source.and_then(|o| o.get("refreshMs")).unwrap_or(&Value::Null),
            500,
            15000,
            2000,
        ),
        sensor_refresh_ms: clamp(
            source
                .and_then(|o| o.get("sensorRefreshMs"))
                .unwrap_or(&Value::Null),
            2000,
            60000,
            5000,
        ),
        docker_enabled: docker
            .and_then(|object| object.get("enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(true),
        docker_refresh_ms: clamp(
            docker
                .and_then(|object| object.get("refreshMs"))
                .unwrap_or(&Value::Null),
            3000,
            60000,
            6000,
        ),
        lhm_enabled: lhm
            .and_then(|object| object.get("enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(true),
        lhm_url,
        sites: normalize_sites(source.and_then(|object| object.get("sites"))),
    }
}

pub fn load() -> (Config, Option<String>) {
    let path = config_path();
    let mut note = None;

    let raw = if path.exists() {
        match fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<Value>(&text) {
                Ok(value) => value,
                Err(error) => {
                    note = Some(format!(
                        "config.json could not be parsed ({}); using defaults.",
                        error
                    ));
                    json!({})
                }
            },
            Err(_) => json!({}),
        }
    } else {
        let defaults = Config {
            port: 4317,
            theme: "midnight".to_string(),
            disk_roots: detect_roots(),
            refresh_ms: 2000,
            sensor_refresh_ms: 5000,
            docker_enabled: true,
            docker_refresh_ms: 6000,
            lhm_enabled: true,
            lhm_url: "http://127.0.0.1:8085".to_string(),
            sites: Vec::new(),
        };
        let _ = fs::write(&path, format!("{}\n", serde_json::to_string_pretty(&to_value(&defaults)).unwrap_or_default()));
        note = Some("config.json was created with defaults.".to_string());
        json!({})
    };

    (normalize(&raw), note)
}

pub fn to_value(config: &Config) -> Value {
    json!({
        "port": config.port,
        "theme": config.theme,
        "diskRoots": config.disk_roots,
        "refreshMs": config.refresh_ms,
        "sensorRefreshMs": config.sensor_refresh_ms,
        "docker": { "enabled": config.docker_enabled, "refreshMs": config.docker_refresh_ms },
        "libreHardwareMonitor": { "enabled": config.lhm_enabled, "url": config.lhm_url },
        "sites": config.sites.iter().map(Site::to_value).collect::<Vec<_>>(),
    })
}

/// Keeps unknown keys that a user may have added by hand.
pub fn save(config: &Config) -> Result<(), String> {
    let path = config_path();
    let mut merged = fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or_else(|| json!({}));

    let value = to_value(config);
    if let (Some(target), Some(source)) = (merged.as_object_mut(), value.as_object()) {
        for (key, entry) in source {
            target.insert(key.clone(), entry.clone());
        }
    }

    let text = serde_json::to_string_pretty(&merged).map_err(|error| error.to_string())?;
    fs::write(&path, format!("{text}\n")).map_err(|error| error.to_string())
}

pub fn validate_settings(body: &Value, live: &Config) -> Result<Config, String> {
    let mut next = live.clone();

    if let Some(theme) = body.get("theme").and_then(Value::as_str) {
        if THEMES.contains(&theme) {
            next.theme = theme.to_string();
        }
    }

    if let Some(entries) = body.get("sites").and_then(Value::as_array) {
        let mut sites = Vec::new();
        for (index, entry) in entries.iter().take(24).enumerate() {
            let url = normalize_site_url(entry.get("url").and_then(Value::as_str).unwrap_or(""));
            if url.is_empty() {
                continue;
            }
            if !is_http(&url) {
                return Err(format!(
                    "Site {} needs a URL like https://example.com",
                    index + 1
                ));
            }
            let Some(host) = url_host(&url) else {
                return Err(format!("Site {} has a URL that cannot be parsed", index + 1));
            };

            let links = entry
                .get("links")
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(|link| {
                            let link_url = link.get("url").and_then(Value::as_str).unwrap_or("");
                            if !is_http(link_url) {
                                return None;
                            }
                            let label = link
                                .get("label")
                                .and_then(Value::as_str)
                                .filter(|text| !text.is_empty())
                                .unwrap_or(link_url);
                            Some(Link {
                                label: label.chars().take(60).collect(),
                                url: link_url.to_string(),
                            })
                        })
                        .take(12)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();

            sites.push(Site {
                name: entry
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|name| !name.is_empty())
                    .map(|name| name.chars().take(60).collect())
                    .unwrap_or(host),
                url,
                admin_url: normalize_site_url(
                    entry.get("adminUrl").and_then(Value::as_str).unwrap_or(""),
                ),
                links,
            });
        }
        next.sites = sites;
    }

    if let Some(docker) = body.get("docker") {
        next.docker_enabled = docker
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(next.docker_enabled);
        if let Some(refresh) = docker.get("refreshMs") {
            next.docker_refresh_ms = clamp(refresh, 3000, 60000, next.docker_refresh_ms);
        }
    }

    if let Some(sensors) = body.get("sensors") {
        next.lhm_enabled = sensors
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(next.lhm_enabled);
        if let Some(url) = sensors.get("url").and_then(Value::as_str) {
            if !url.is_empty() {
                next.lhm_url = validate_sensor_url(url)?;
            }
        }
    }

    if let Some(entries) = body.get("diskRoots").and_then(Value::as_array) {
        if !entries.is_empty() {
            let mut roots: Vec<String> = Vec::new();
            for entry in entries.iter().take(8) {
                let raw = entry.as_str().unwrap_or("").trim();
                if raw.is_empty() {
                    continue;
                }
                if !Path::new(raw).is_absolute() {
                    return Err(format!(
                        "\"{raw}\" is not a full path. Use something like D:\\"
                    ));
                }
                let resolved = fs::canonicalize(raw)
                    .map(|path| strip_verbatim(&path.to_string_lossy()))
                    .unwrap_or_else(|_| raw.to_string());
                if !Path::new(&resolved).is_dir() {
                    return Err(format!("\"{resolved}\" cannot be read from this PC"));
                }
                if !roots.iter().any(|root| root.eq_ignore_ascii_case(&resolved)) {
                    roots.push(resolved);
                }
            }
            if roots.is_empty() {
                return Err("Keep at least one drive in the list".to_string());
            }
            next.disk_roots = roots;
        }
    }

    Ok(next)
}
