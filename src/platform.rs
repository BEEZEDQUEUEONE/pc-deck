use std::io::Read;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Fixed-argument command execution. No shell is ever involved, output is
/// capped, and a stuck process is killed instead of blocking the caller.
pub struct Output {
    pub ok: bool,
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

impl Output {
    pub fn first_error_line(&self) -> Option<String> {
        self.stderr
            .lines()
            .chain(self.stdout.lines())
            .find(|line| !line.trim().is_empty())
            .map(|line| line.trim().to_string())
    }
}

pub fn run(command: &str, args: &[&str], timeout: Duration) -> Output {
    let mut cmd = Command::new(command);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(error) => {
            return Output {
                ok: false,
                code: -1,
                stdout: String::new(),
                stderr: error.to_string(),
                timed_out: false,
            }
        }
    };

    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();

    let stdout_thread = thread::spawn(move || {
        let mut text = String::new();
        if let Some(pipe) = stdout_pipe.as_mut() {
            let _ = pipe.read_to_string(&mut text);
        }
        text
    });
    let stderr_thread = thread::spawn(move || {
        let mut text = String::new();
        if let Some(pipe) = stderr_pipe.as_mut() {
            let _ = pipe.read_to_string(&mut text);
        }
        text
    });

    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let mut code = -1;

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                code = status.code().unwrap_or(-1);
                break;
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    timed_out = true;
                    break;
                }
                thread::sleep(Duration::from_millis(25));
            }
            Err(_) => {
                let _ = child.kill();
                break;
            }
        }
    }

    let mut stdout = stdout_thread.join().unwrap_or_default();
    let mut stderr = stderr_thread.join().unwrap_or_default();
    if stdout.len() > 200_000 {
        stdout = stdout.split_off(stdout.len() - 200_000);
    }
    if stderr.len() > 60_000 {
        stderr = stderr.split_off(stderr.len() - 60_000);
    }
    if timed_out {
        stderr.push_str(&format!("\n[timed out after {}ms]", timeout.as_millis()));
    }

    Output {
        ok: code == 0 && !timed_out,
        code,
        stdout,
        stderr,
        timed_out,
    }
}

pub fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Windows reports its full version through the registry; sysinfo only returns
/// the build number, which is not enough to tell 10 from 11.
pub fn windows_version() -> String {
    let output = run(
        "reg",
        &[
            "query",
            r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion",
        ],
        Duration::from_secs(5),
    );
    if !output.ok {
        return String::new();
    }

    let mut major = String::new();
    let mut minor = String::new();
    let mut build = String::new();

    for line in output.stdout.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 3 {
            continue;
        }
        match parts[0] {
            "CurrentMajorVersionNumber" => major = hex_or_dec(parts[2]),
            "CurrentMinorVersionNumber" => minor = hex_or_dec(parts[2]),
            "CurrentBuildNumber" => build = parts[2].to_string(),
            _ => {}
        }
    }

    if build.is_empty() {
        return String::new();
    }
    if major.is_empty() || minor.is_empty() {
        return build;
    }
    format!("{major}.{minor}.{build}")
}

fn hex_or_dec(value: &str) -> String {
    let trimmed = value.trim();
    if let Some(hex) = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
    {
        return u32::from_str_radix(hex, 16)
            .map(|number| number.to_string())
            .unwrap_or_else(|_| trimmed.to_string());
    }
    trimmed.to_string()
}

/// sysinfo cannot read the nominal clock on some Ryzen parts, so fall back to
/// the value Windows stores for the processor.
pub fn cpu_speed_mhz() -> u64 {
    let output = run(
        "reg",
        &[
            "query",
            r"HKLM\HARDWARE\DESCRIPTION\System\CentralProcessor\0",
            "/v",
            "~MHz",
        ],
        Duration::from_secs(5),
    );
    if !output.ok {
        return 0;
    }

    for line in output.stdout.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 3 && parts[0] == "~MHz" {
            return hex_or_dec(parts[2]).parse::<u64>().unwrap_or(0);
        }
    }
    0
}

/// LibreHardwareMonitor reports values as display strings ("45.0 °C"), so the
/// numeric part has to be pulled out before the UI can use it.
pub fn to_number(value: &str) -> Option<f64> {
    let cleaned: String = value
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '.' || *c == '-')
        .collect();
    if cleaned.is_empty() {
        return None;
    }
    cleaned.parse::<f64>().ok()
}
