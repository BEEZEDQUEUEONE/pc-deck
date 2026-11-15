use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use crate::config::Site;
use crate::platform::epoch_ms;

const CACHE_TTL: Duration = Duration::from_secs(45);

static CACHE: Mutex<Option<HashMap<String, (Instant, Value)>>> = Mutex::new(None);

fn describe_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        return "Timed out after 7s".to_string();
    }
    let text = error.to_string().to_ascii_lowercase();
    if text.contains("dns") || text.contains("name or service not known") {
        return "DNS lookup failed".to_string();
    }
    if text.contains("refused") {
        return "Connection refused".to_string();
    }
    if text.contains("reset") {
        return "Connection reset".to_string();
    }
    if text.contains("certificate") || text.contains("tls") {
        return "TLS certificate not trusted".to_string();
    }
    error.to_string().chars().take(160).collect()
}

fn probe(client: &reqwest::blocking::Client, site: &Site) -> Value {
    let started = Instant::now();
    let base = || {
        json!({
            "name": site.name,
            "url": site.url,
            "adminUrl": site.admin_url,
            "links": site.links.iter().map(|link| json!({ "label": link.label, "url": link.url })).collect::<Vec<_>>(),
            "checkedAt": epoch_ms(),
        })
    };

    match client.get(&site.url).send() {
        Ok(response) => {
            let status = response.status().as_u16();
            let mut value = base();
            let object = value.as_object_mut().unwrap();
            object.insert("ok".into(), json!(response.status().is_success()));
            object.insert("status".into(), json!(status));
            object.insert(
                "latencyMs".into(),
                json!(started.elapsed().as_millis() as u64),
            );
            object.insert("error".into(), Value::Null);
            value
        }
        Err(error) => {
            let mut value = base();
            let object = value.as_object_mut().unwrap();
            object.insert("ok".into(), json!(false));
            object.insert("status".into(), json!(0));
            object.insert(
                "latencyMs".into(),
                json!(started.elapsed().as_millis() as u64),
            );
            object.insert("error".into(), json!(describe_error(&error)));
            value
        }
    }
}

pub fn check(sites: &[Site], force: bool) -> Vec<Value> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(7))
        .redirect(reqwest::redirect::Policy::limited(10))
        .user_agent("pc-deck/0.2 (local dashboard)")
        .build()
        .unwrap_or_else(|_| reqwest::blocking::Client::new());

    let mut results: Vec<Option<Value>> = vec![None; sites.len()];
    let mut pending: Vec<usize> = Vec::new();

    {
        if let Ok(mut guard) = CACHE.lock() {
            let cache = guard.get_or_insert_with(HashMap::new);
            cache.retain(|_, (at, _)| at.elapsed() < CACHE_TTL);

            for (index, site) in sites.iter().enumerate() {
                if !force {
                    if let Some((_, value)) = cache.get(&site.url) {
                        results[index] = Some(value.clone());
                        continue;
                    }
                }
                pending.push(index);
            }
        }
    }

    let mut handles = Vec::new();
    for index in pending {
        let site = sites[index].clone();
        let client = client.clone();
        handles.push(thread::spawn(move || (index, probe(&client, &site))));
    }

    for handle in handles {
        if let Ok((index, value)) = handle.join() {
            if let Ok(mut guard) = CACHE.lock() {
                let cache = guard.get_or_insert_with(HashMap::new);
                if let Some(site) = sites.get(index) {
                    cache.insert(site.url.clone(), (Instant::now(), value.clone()));
                }
            }
            results[index] = Some(value);
        }
    }

    results
        .into_iter()
        .enumerate()
        .map(|(index, value)| value.unwrap_or_else(|| json!({ "name": sites[index].name, "ok": false })))
        .collect()
}
