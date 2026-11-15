#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;
mod config;
mod platform;
mod probes;

use std::cell::{Cell, RefCell};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::thread;

use tao::dpi::{LogicalSize, PhysicalPosition};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::window::{Icon, WindowBuilder};
use wry::WebViewBuilder;

use api::AppState;
use probes::disktree::DiskTree;
use probes::sensors::Sensors;
use probes::system::SystemProbe;

#[derive(Debug, Clone, Copy)]
enum Target {
    Main,
    Overlay,
}

#[derive(Debug)]
enum UserEvent {
    Respond(Target, String),
}

fn build_html() -> String {
    let index = include_str!("../web/index.html");
    let styles = include_str!("../web/styles.css");
    let script = include_str!("../web/app.js");
    let bridge = include_str!("bridge.js");

    let with_styles = index.replace(
        "<link rel=\"stylesheet\" href=\"/styles.css\" />",
        &format!("<style>\n{styles}\n</style>"),
    );

    with_styles.replace(
        "<script src=\"/app.js\" type=\"module\"></script>",
        // Classic scripts on purpose: WebView2 does not execute inline module
        // scripts in a NavigateToString document.
        &format!("<script>\n{bridge}\n</script>\n<script>\n{script}\n</script>"),
    )
}

fn overlay_html() -> String {
    include_str!("../web/overlay.html").replace(
        "<!--BRIDGE-->",
        &format!("<script>\n{}\n</script>", include_str!("bridge.js")),
    )
}

/// Messages with a `cmd` field are window actions, not API calls.
fn read_command(raw: &str) -> Option<String> {
    if !raw.starts_with("{\"cmd\"") {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    value
        .get("cmd")
        .and_then(|cmd| cmd.as_str())
        .map(str::to_string)
}

fn window_icon() -> Option<Icon> {
    let size = 32u32;
    let mut pixels = Vec::with_capacity((size * size * 4) as usize);

    for y in 0..size {
        for x in 0..size {
            let dx = x as f32 - 15.5;
            let dy = y as f32 - 15.5;
            if (dx * dx + dy * dy).sqrt() < 15.0 {
                let shade = (x + y) as f32 / 62.0;
                pixels.push((18.0 + 20.0 * shade) as u8);
                pixels.push((190.0 - 80.0 * shade) as u8);
                pixels.push((160.0 + 40.0 * shade) as u8);
                pixels.push(255);
            } else {
                pixels.extend_from_slice(&[0, 0, 0, 0]);
            }
        }
    }

    Icon::from_rgba(pixels, size, size).ok()
}

/// Headless check used during development and by the release smoke test:
/// prints what every probe answers without opening a window.
fn selftest(state: &Arc<AppState>) {
    use serde_json::json;
    use std::time::Duration;

    std::thread::sleep(Duration::from_secs(3));
    let config = state.config.lock().map(|cfg| cfg.clone()).unwrap();

    println!(
        "system {}",
        serde_json::to_string(&state.system.snapshot()).unwrap_or_default()
    );
    println!(
        "sensors {}",
        serde_json::to_string(&state.sensors.snapshot()).unwrap_or_default()
    );
    println!(
        "docker {}",
        serde_json::to_string(&crate::probes::docker::list(config.docker_enabled)).unwrap_or_default()
    );
    println!(
        "helper {}",
        serde_json::to_string(&crate::probes::helper::status()).unwrap_or_default()
    );
    println!(
        "sites {}",
        serde_json::to_string(&json!({ "sites": crate::probes::sites::check(&config.sites, true) }))
            .unwrap_or_default()
    );

    // Round-trip the settings panel: read the view, then save it back unchanged.
    let view = crate::api::handle(state, "/api/settings", "GET", None);
    println!(
        "settings-view {} {}",
        view.0,
        serde_json::to_string(&view.1).unwrap_or_default()
    );
    let current = view.1.get("settings").cloned().unwrap_or(json!({}));
    let saved = crate::api::handle(state, "/api/settings", "PUT", Some(current));
    println!(
        "settings-save {} {}",
        saved.0,
        serde_json::to_string(&saved.1).unwrap_or_default()
    );

    println!(
        "settings {}",
        serde_json::to_string(&json!({
            "theme": config.theme,
            "dockerEnabled": config.docker_enabled,
            "sensors": { "enabled": config.lhm_enabled, "url": config.lhm_url },
            "diskRoots": config.disk_roots,
        }))
        .unwrap_or_default()
    );

    if let Some(root) = config.disk_roots.first() {
        let target = format!("{}\\Windows\\System32\\drivers\\etc", root.trim_end_matches(['\\', '/']));
        if let Ok(path) = crate::probes::disktree::validate(&target, &config.disk_roots) {
            let started = state.disk.start(path, true);
            let id = started.get("id").and_then(|value| value.as_str()).unwrap_or("");
            let mut tree = None;
            for _ in 0..40 {
                std::thread::sleep(Duration::from_millis(500));
                if let Some(job) = state.disk.get(id) {
                    if job.get("state").and_then(|value| value.as_str()) == Some("done") {
                        tree = job.get("tree").cloned();
                        break;
                    }
                }
            }
            println!(
                "disk {}",
                serde_json::to_string(&json!({
                    "path": target,
                    "files": tree.as_ref().and_then(|value| value.get("fileCount")).cloned(),
                    "size": tree.as_ref().and_then(|value| value.get("size")).cloned(),
                    "partial": tree.as_ref().and_then(|value| value.get("partial")).cloned(),
                }))
                .unwrap_or_default()
            );
        }
    }
}

fn main() {
    let (config, note) = config::load();
    if let Some(note) = note {
        eprintln!("{note}");
    }

    // `--label` replaces the machine name in the header, which keeps public
    // screenshots free of a real hostname. `--overlay` opens the mini panel.
    let host_label = std::env::args().find_map(|arg| arg.strip_prefix("--label=").map(str::to_string));
    let overlay_at_start = std::env::args().any(|arg| arg == "--overlay");

    let config = Arc::new(Mutex::new(config));
    let state = Arc::new(AppState {
        system: SystemProbe::start(Arc::clone(&config), host_label),
        sensors: Sensors::start(Arc::clone(&config)),
        config,
        disk: DiskTree::default(),
        started_at: platform::epoch_ms(),
    });

    if std::env::args().any(|arg| arg == "--dump-html") {
        let html = build_html();
        let path = config::app_dir().join("tools").join("page.html");
        let _ = std::fs::write(&path, &html);
        println!("wrote {} bytes to {}", html.len(), path.display());
        return;
    }

    if std::env::args().any(|arg| arg == "--selftest") {
        selftest(&state);
        return;
    }

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    // `--panel=disk` opens a given tab after startup, which is handy for
    // screenshots and for checking a panel without clicking through the window.
    let mut html = build_html();
    if let Some(panel) = std::env::args().find_map(|arg| arg.strip_prefix("--panel=").map(str::to_string)) {
        if panel.chars().all(|c| c.is_ascii_alphanumeric()) {
            let click = format!(
                "<script>setTimeout(function(){{var el=document.querySelector('.nav-item[data-panel=\"{panel}\"]');if(el)el.click();}},2200);</script>"
            );
            html = html.replace("</body>", &format!("{click}</body>"));
        }
    }

    let window = WindowBuilder::new()
        .with_title("PC Deck")
        .with_inner_size(LogicalSize::new(1280.0, 860.0))
        .with_min_inner_size(LogicalSize::new(960.0, 620.0))
        .with_window_icon(window_icon())
        .build(&event_loop)
        .expect("could not create the PC Deck window");
    let main_id = window.id();

    let overlay_window = WindowBuilder::new()
        .with_title("PC Deck Overlay")
        .with_inner_size(LogicalSize::new(330.0, 132.0))
        .with_resizable(false)
        .with_decorations(false)
        .with_always_on_top(true)
        .with_visible(false)
        .with_window_icon(window_icon())
        .build(&event_loop)
        .expect("could not create the overlay window");
    let overlay_id = overlay_window.id();

    if let Some(monitor) = overlay_window.current_monitor().or_else(|| overlay_window.primary_monitor()) {
        let area = monitor.size();
        let origin = monitor.position();
        let own = overlay_window.inner_size();
        let x = origin.x + area.width as i32 - own.width as i32 - 24;
        let y = origin.y + 24;
        overlay_window.set_outer_position(PhysicalPosition::new(x, y));
    }

    // Keep the WebView2 profile out of the app folder, where a portable exe is
    // often read-only and would otherwise collect a user-data directory.
    let data_dir = std::env::var_os("LOCALAPPDATA")
        .map(|base| PathBuf::from(base).join("PC Deck").join("WebView2"))
        .unwrap_or_else(|| config::app_dir().join("webview2"));
    let _ = std::fs::create_dir_all(&data_dir);
    let mut web_context = wry::WebContext::new(Some(data_dir));

    let overlay_holder = Rc::new(RefCell::new(Some(overlay_window)));
    let overlay_visible = Rc::new(Cell::new(overlay_at_start));

    let overlay_webview = {
        let overlay_state = Arc::clone(&state);
        let overlay_proxy = proxy.clone();
        let windows = Rc::clone(&overlay_holder);
        let visible = Rc::clone(&overlay_visible);

        let builder = WebViewBuilder::new_with_web_context(&mut web_context)
            .with_html(overlay_html())
            .with_ipc_handler(move |request: wry::http::Request<String>| {
                let raw = request.body().to_string();

                if let Some(cmd) = read_command(&raw) {
                    if let Some(window) = windows.borrow().as_ref() {
                        match cmd.as_str() {
                            "hide" => {
                                window.set_visible(false);
                                visible.set(false);
                            }
                            "drag" => {
                                let _ = window.drag_window();
                            }
                            _ => {}
                        }
                    }
                    return;
                }

                let state = Arc::clone(&overlay_state);
                let proxy = overlay_proxy.clone();
                thread::spawn(move || {
                    let script = api::handle_ipc(&state, &raw);
                    let _ = proxy.send_event(UserEvent::Respond(Target::Overlay, script));
                });
            });

        let window = overlay_holder.borrow();
        builder
            .build(window.as_ref().expect("overlay window"))
            .expect("could not start the overlay WebView")
    };

    let main_webview = {
        let main_state = Arc::clone(&state);
        let main_proxy = proxy.clone();
        let windows = Rc::clone(&overlay_holder);
        let visible = Rc::clone(&overlay_visible);

        WebViewBuilder::new_with_web_context(&mut web_context)
            .with_html(html)
            .with_ipc_handler(move |request: wry::http::Request<String>| {
                let raw = request.body().to_string();

                if let Some(cmd) = read_command(&raw) {
                    if cmd == "overlay" {
                        let next = !visible.get();
                        if let Some(window) = windows.borrow().as_ref() {
                            window.set_visible(next);
                            if next {
                                window.set_focus();
                            }
                        }
                        visible.set(next);
                    }
                    return;
                }

                let state = Arc::clone(&main_state);
                let proxy = main_proxy.clone();
                thread::spawn(move || {
                    let script = api::handle_ipc(&state, &raw);
                    let _ = proxy.send_event(UserEvent::Respond(Target::Main, script));
                });
            })
            .build(&window)
            .expect("could not start the WebView")
    };

    if overlay_at_start {
        if let Some(window) = overlay_holder.borrow().as_ref() {
            window.set_visible(true);
        }
    }

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            Event::UserEvent(UserEvent::Respond(Target::Main, script)) => {
                let _ = main_webview.evaluate_script(&script);
            }
            Event::UserEvent(UserEvent::Respond(Target::Overlay, script)) => {
                let _ = overlay_webview.evaluate_script(&script);
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                window_id,
                ..
            } => {
                if window_id == main_id {
                    *control_flow = ControlFlow::Exit;
                } else if window_id == overlay_id {
                    if let Some(window) = overlay_holder.borrow().as_ref() {
                        window.set_visible(false);
                    }
                    overlay_visible.set(false);
                }
            }
            _ => {}
        }
    });
}
