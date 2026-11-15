use rayon::prelude::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::platform::epoch_ms;

const MAX_FILES: u64 = 1_500_000;
const MAX_DIRS: u64 = 400_000;
const TIME_BUDGET: Duration = Duration::from_secs(120);
const MAX_CHILDREN: usize = 240;
const TOP_FILES: usize = 14;
const CACHE_TTL: Duration = Duration::from_secs(600);
const JOB_TTL: Duration = Duration::from_secs(900);

fn strip_verbatim(path: &str) -> String {
    path.strip_prefix(r"\\?\").unwrap_or(path).to_string()
}

struct Limits {
    files: AtomicU64,
    dirs: AtomicU64,
    bytes: AtomicU64,
    errors: AtomicU64,
    aborted: AtomicBool,
    deadline: Instant,
}

impl Limits {
    fn new() -> Self {
        Self {
            files: AtomicU64::new(0),
            dirs: AtomicU64::new(0),
            bytes: AtomicU64::new(0),
            errors: AtomicU64::new(0),
            aborted: AtomicBool::new(false),
            deadline: Instant::now() + TIME_BUDGET,
        }
    }

    fn starved(&self) -> bool {
        self.aborted.load(Ordering::Relaxed)
            || Instant::now() > self.deadline
            || self.files.load(Ordering::Relaxed) > MAX_FILES
            || self.dirs.load(Ordering::Relaxed) > MAX_DIRS
    }
}

struct Node {
    name: String,
    path: String,
    size: u64,
    file_count: u64,
    children: Vec<Node>,
    top_files: Vec<(String, String, u64)>,
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

fn walk(dir: &Path, depth: usize, limits: &Limits) -> Node {
    let mut node = Node {
        name: file_name(dir),
        path: dir.to_string_lossy().to_string(),
        size: 0,
        file_count: 0,
        children: Vec::new(),
        top_files: Vec::new(),
    };

    if limits.starved() {
        limits.aborted.store(true, Ordering::Relaxed);
        return node;
    }

    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => {
            limits.errors.fetch_add(1, Ordering::Relaxed);
            return node;
        }
    };
    limits.dirs.fetch_add(1, Ordering::Relaxed);

    let mut directories: Vec<PathBuf> = Vec::new();
    let mut files: Vec<(String, u64)> = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        // Junctions and symlinks would double count or loop forever.
        let kind = match entry.file_type() {
            Ok(kind) => kind,
            Err(_) => continue,
        };
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            directories.push(path);
        } else {
            let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
            files.push((file_name(&path), size));
        }
    }

    for (name, size) in files {
        node.size = node.size.saturating_add(size);
        if size > 0 {
            node.file_count += 1;
        }
        limits.files.fetch_add(1, Ordering::Relaxed);
        limits.bytes.fetch_add(size, Ordering::Relaxed);

        if depth == 0 && size > 0 {
            node.top_files.push((
                name.clone(),
                dir.join(&name).to_string_lossy().to_string(),
                size,
            ));
            node.top_files.sort_by(|a, b| b.2.cmp(&a.2));
            node.top_files.truncate(TOP_FILES);
        }
    }

    let children: Vec<Node> = directories
        .par_iter()
        .map(|child| walk(child, depth + 1, limits))
        .collect();

    for child in children {
        node.size = node.size.saturating_add(child.size);
        node.file_count = node.file_count.saturating_add(child.file_count);
        if depth == 0 {
            node.children.push(child);
        }
    }

    node
}

fn build_tree(root: Node, limits: &Limits, duration_ms: u64) -> Value {
    let mut children = root.children;
    children.retain(|child| child.size > 0);
    children.sort_by(|a, b| b.size.cmp(&a.size));

    let omitted = children.len().saturating_sub(MAX_CHILDREN);
    children.truncate(MAX_CHILDREN);

    let mut top_files = root.top_files;
    top_files.sort_by(|a, b| b.2.cmp(&a.2));

    json!({
        "name": root.name,
        "path": root.path,
        "size": root.size,
        "fileCount": root.file_count,
        "partial": limits.aborted.load(Ordering::Relaxed),
        "durationMs": duration_ms,
        "counts": {
            "files": limits.files.load(Ordering::Relaxed),
            "dirs": limits.dirs.load(Ordering::Relaxed),
            "bytes": limits.bytes.load(Ordering::Relaxed),
            "errors": limits.errors.load(Ordering::Relaxed),
        },
        "omitted": omitted,
        "children": children.iter().map(|child| json!({
            "name": child.name,
            "path": child.path,
            "size": child.size,
            "fileCount": child.file_count,
        })).collect::<Vec<_>>(),
        "files": top_files.iter().map(|(name, path, size)| json!({
            "name": name,
            "path": path,
            "size": size,
        })).collect::<Vec<_>>(),
    })
}

struct Job {
    id: String,
    path: String,
    state: String,
    started_at: u64,
    finished_at: Option<u64>,
    files: u64,
    dirs: u64,
    bytes: u64,
    errors: u64,
    tree: Option<Value>,
    error: Option<String>,
}

impl Job {
    fn to_value(&self) -> Value {
        json!({
            "id": self.id,
            "path": self.path,
            "state": self.state,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            "progress": {
                "files": self.files,
                "dirs": self.dirs,
                "bytes": self.bytes,
                "errors": self.errors,
            },
            "tree": self.tree,
            "error": self.error,
        })
    }
}

#[derive(Default, Clone)]
pub struct DiskTree {
    jobs: Arc<Mutex<HashMap<String, Arc<Mutex<Job>>>>>,
    cache: Arc<Mutex<HashMap<String, (Instant, Value)>>>,
}

pub fn validate(input: &str, roots: &[String]) -> Result<String, (u16, String)> {
    if input.trim().is_empty() {
        return Err((400, "A folder path is required".to_string()));
    }

    let resolved = fs::canonicalize(input.trim())
        .map(|path| strip_verbatim(&path.to_string_lossy()))
        .map_err(|_| (404, "That folder does not exist or cannot be read".to_string()))?;

    let lower = resolved.to_ascii_lowercase();
    let allowed = roots.iter().any(|root| {
        let base = strip_verbatim(root.trim_end_matches(['\\', '/'])).to_ascii_lowercase();
        if base.is_empty() {
            return false;
        }
        lower == base
            || lower.starts_with(&format!("{base}\\"))
            || lower.starts_with(&format!("{base}/"))
    });

    if !allowed {
        return Err((
            403,
            "That path is outside the configured disk roots".to_string(),
        ));
    }

    if !Path::new(&resolved).is_dir() {
        return Err((400, "That path is not a folder".to_string()));
    }

    Ok(resolved)
}

impl DiskTree {
    pub fn start(&self, target: String, refresh: bool) -> Value {
        let key = target.to_ascii_lowercase();

        if !refresh {
            if let Ok(mut cache) = self.cache.lock() {
                cache.retain(|_, (at, _)| at.elapsed() < CACHE_TTL);
                if let Some((_, tree)) = cache.get(&key) {
                    return json!({
                        "state": "done",
                        "cached": true,
                        "path": target,
                        "tree": tree,
                    });
                }
            }
        }

        if let Ok(jobs) = self.jobs.lock() {
            for job in jobs.values() {
                if let Ok(existing) = job.lock() {
                    if existing.path.eq_ignore_ascii_case(&target) && existing.state == "running" {
                        return existing.to_value();
                    }
                }
            }
        }

        let id = format!("{:x}-{:x}", epoch_ms(), rand_suffix());
        let job = Arc::new(Mutex::new(Job {
            id: id.clone(),
            path: target.clone(),
            state: "running".to_string(),
            started_at: epoch_ms(),
            finished_at: None,
            files: 0,
            dirs: 0,
            bytes: 0,
            errors: 0,
            tree: None,
            error: None,
        }));

        if let Ok(mut jobs) = self.jobs.lock() {
            jobs.insert(id, Arc::clone(&job));
        }

        let snapshot = job.lock().map(|guard| guard.to_value()).unwrap_or(Value::Null);
        self.spawn(target, key, job);
        snapshot
    }

    fn spawn(&self, target: String, key: String, job: Arc<Mutex<Job>>) {
        let jobs = Arc::clone(&self.jobs);
        let cache = Arc::clone(&self.cache);

        thread::spawn(move || {
            let started = Instant::now();
            let limits = Arc::new(Limits::new());
            let done = Arc::new(AtomicBool::new(false));

            {
                let limits = Arc::clone(&limits);
                let done = Arc::clone(&done);
                let job = Arc::clone(&job);
                thread::spawn(move || {
                    while !done.load(Ordering::Relaxed) {
                        thread::sleep(Duration::from_millis(400));
                        if let Ok(mut guard) = job.lock() {
                            guard.files = limits.files.load(Ordering::Relaxed);
                            guard.dirs = limits.dirs.load(Ordering::Relaxed);
                            guard.bytes = limits.bytes.load(Ordering::Relaxed);
                            guard.errors = limits.errors.load(Ordering::Relaxed);
                        }
                    }
                });
            }

            let root = walk(Path::new(&target), 0, &limits);
            let duration = started.elapsed().as_millis() as u64;
            let tree = build_tree(root, &limits, duration);
            let aborted = limits.aborted.load(Ordering::Relaxed);

            if let Ok(mut guard) = job.lock() {
                guard.tree = Some(tree.clone());
                guard.state = "done".to_string();
                guard.finished_at = Some(epoch_ms());
                guard.files = limits.files.load(Ordering::Relaxed);
                guard.dirs = limits.dirs.load(Ordering::Relaxed);
                guard.bytes = limits.bytes.load(Ordering::Relaxed);
                guard.errors = limits.errors.load(Ordering::Relaxed);
            }
            done.store(true, Ordering::Relaxed);

            if !aborted {
                if let Ok(mut cache) = cache.lock() {
                    cache.insert(key, (Instant::now(), tree));
                }
            }

            // Drop finished jobs and stale caches so a long session stays small.
            if let Ok(mut jobs) = jobs.lock() {
                jobs.retain(|_, entry| {
                    entry
                        .lock()
                        .map(|guard| {
                            guard.finished_at.is_none()
                                || epoch_ms().saturating_sub(guard.finished_at.unwrap_or(0))
                                    < JOB_TTL.as_millis() as u64
                        })
                        .unwrap_or(false)
                });
            }
            if let Ok(mut cache) = cache.lock() {
                cache.retain(|_, (at, _)| at.elapsed() < CACHE_TTL);
            }
        });
    }

    pub fn get(&self, id: &str) -> Option<Value> {
        let jobs = self.jobs.lock().ok()?;
        let job = jobs.get(id)?;
        job.lock().ok().map(|guard| guard.to_value())
    }
}

fn rand_suffix() -> u64 {
    use std::sync::atomic::AtomicU64;
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    nanos ^ COUNTER
        .fetch_add(1, Ordering::Relaxed)
        .wrapping_mul(0x9E37_79B9_7F4A_7C15)
}
