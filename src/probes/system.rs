use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use sysinfo::{Disks, Pid, ProcessesToUpdate, System};

use crate::config::Config;
use crate::platform::epoch_ms;

#[derive(Default, Clone)]
struct Sample {
    usage: f32,
    per_core: Vec<f32>,
    volumes: Vec<Value>,
}

pub struct SystemProbe {
    sample: Arc<Mutex<Sample>>,
    started_at: u64,
    cpu_model: String,
    cpu_cores: usize,
    cpu_threads: usize,
    cpu_speed: u64,
}

impl SystemProbe {
    pub fn start(config: Arc<Mutex<Config>>) -> Self {
        let mut sys = match System::new() {
            Ok(system) => system,
            Err(_) => {
                return Self {
                    sample: Arc::new(Mutex::new(Sample::default())),
                    started_at: epoch_ms(),
                    cpu_model: "Unknown CPU".to_string(),
                    cpu_cores: 1,
                    cpu_threads: 1,
                    cpu_speed: 0,
                }
            }
        };
        sys.refresh_cpu_usage();
        sys.refresh_memory();

        let cpu_model = sys
            .cpus()
            .first()
            .map(|cpu| cpu.brand().trim().to_string())
            .filter(|brand| !brand.is_empty())
            .unwrap_or_else(|| "Unknown CPU".to_string());
        let cpu_threads = sys.cpus().len();
        let mut cpu_speed = sys.cpus().first().map(|cpu| cpu.frequency()).unwrap_or(0);
        if cpu_speed == 0 {
            cpu_speed = crate::platform::cpu_speed_mhz();
        }
        let cpu_cores = std::thread::available_parallelism()
            .map(|count| count.get())
            .unwrap_or(cpu_threads.max(1));

        let sample = Arc::new(Mutex::new(Sample::default()));
        let target = Arc::clone(&sample);

        thread::spawn(move || {
            let mut sys = sys;
            let mut disks = Disks::new_with_refreshed_list().ok();
            let mut last_volumes = 0u64;

            loop {
                thread::sleep(Duration::from_secs(1));
                sys.refresh_cpu_usage();

                let usage = (sys.global_cpu_usage() * 10.0).round() / 10.0;
                let per_core = sys
                    .cpus()
                    .iter()
                    .map(|cpu| (cpu.usage() * 10.0).round() / 10.0)
                    .collect::<Vec<_>>();

                let now = epoch_ms();
                if now.saturating_sub(last_volumes) > 20_000 {
                    if let Some(list) = disks.as_mut() {
                        list.refresh(true);
                    }
                    last_volumes = now;
                }

                let roots = config
                    .lock()
                    .map(|cfg| cfg.disk_roots.clone())
                    .unwrap_or_default();

                let mut volumes = Vec::new();
                for root in roots {
                    let clean = root.strip_prefix(r"\\?\").unwrap_or(&root);
                    let normalised = clean.trim_end_matches(['\\', '/']).to_ascii_lowercase();
                    let Some(disks) = disks.as_ref() else { continue };
                    let Some(disk) = disks.iter().find(|disk| {
                        disk.mount_point()
                            .to_string_lossy()
                            .trim_end_matches(['\\', '/'])
                            .eq_ignore_ascii_case(&normalised)
                    }) else {
                        continue;
                    };

                    let total = disk.total_space();
                    if total == 0 {
                        continue;
                    }
                    let free = disk.available_space();
                    let used = total.saturating_sub(free);

                    volumes.push(json!({
                        "name": if normalised.is_empty() { clean.to_string() } else { clean.trim_end_matches(['\\', '/']).to_string() },
                        "root": clean,
                        "total": total,
                        "free": free,
                        "used": used,
                        "usage": ((used as f64 / total as f64) * 1000.0).round() / 10.0,
                    }));
                }

                if let Ok(mut guard) = target.lock() {
                    *guard = Sample {
                        usage,
                        per_core,
                        volumes,
                    };
                }
            }
        });

        Self {
            sample,
            started_at: epoch_ms(),
            cpu_model,
            cpu_cores,
            cpu_threads,
            cpu_speed,
        }
    }

    pub fn snapshot(&self) -> Value {
        let sample = self.sample.lock().map(|s| s.clone()).unwrap_or_default();

        let pid = Pid::from_u32(std::process::id());
        let mut probe = System::new().ok();
        let (rss, total, used) = match probe.as_mut() {
            Some(system) => {
                system.refresh_memory();
                system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
                let rss = system.process(pid).map(|process| process.memory()).unwrap_or(0);
                (rss, system.total_memory(), system.used_memory())
            }
            None => (0, 0, 0),
        };
        let free = total.saturating_sub(used);

        let release = {
            let version = crate::platform::windows_version();
            if version.is_empty() {
                System::kernel_version().unwrap_or_default()
            } else {
                version
            }
        };

        json!({
            "host": System::host_name().unwrap_or_default(),
            "platform": "win32",
            "release": release,
            "arch": std::env::consts::ARCH,
            "node": format!("Rust {}", env!("CARGO_PKG_VERSION")),
            "uptimeSec": System::uptime().unwrap_or(0),
            "cpu": {
                "model": self.cpu_model,
                "cores": self.cpu_cores,
                "threads": self.cpu_threads,
                "speedMhz": self.cpu_speed,
                "usage": sample.usage,
                "perCore": sample.per_core,
            },
            "memory": {
                "total": total,
                "free": free,
                "used": used,
                "usage": if total > 0 { ((used as f64 / total as f64) * 1000.0).round() / 10.0 } else { 0.0 },
            },
            "volumes": sample.volumes,
            "dashboard": {
                "rss": rss,
                "startedAt": self.started_at,
            },
            "sampledAt": epoch_ms(),
        })
    }
}
