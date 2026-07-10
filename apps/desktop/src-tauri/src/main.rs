// SumMeet desktop shell (SPEC A7).
//
// The window is just the existing web panel in a native webview — we don't
// rewrite the UI per platform. What the native shell adds is the part a browser
// can't do: capture the OS audio mix (system -> left, mic -> right) by driving
// the Swift recorder, which uploads straight to the local API.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::Read;
use std::net::TcpStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

const API_BASE: &str = "http://localhost:8080";
const API_PORT: u16 = 8080;
const PANEL_PORT: u16 = 3000;

#[derive(Default)]
struct Recording(Mutex<Option<Child>>);

/// The backend we started, if any. We only own it when we spawned it — an already
/// running `pnpm dev` is left alone, and left running when the app quits.
#[derive(Default)]
struct Backend(Mutex<Option<Child>>);

fn port_open(port: u16) -> bool {
    TcpStream::connect_timeout(
        &([127, 0, 0, 1], port).into(),
        Duration::from_millis(300),
    )
    .is_ok()
}

fn wait_for_ports(ports: &[u16], timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if ports.iter().all(|p| port_open(*p)) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    false
}

/// Repo root, so we can run the workspace's dev servers.
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

/// Start the API + panel if they aren't already up, so opening the app is enough
/// — no `pnpm dev` in another terminal.
///
/// `pnpm dev` spawns a tree (concurrently -> next + tsx). Killing only the parent
/// leaves orphans holding the ports, so put the child in its own process group
/// and signal the whole group on quit.
fn ensure_backend() -> Option<Child> {
    if port_open(API_PORT) && port_open(PANEL_PORT) {
        return None; // someone else's dev server: not ours to manage
    }

    let mut cmd = Command::new("pnpm");
    cmd.arg("dev")
        .current_dir(repo_root())
        .env("PATH", augmented_path())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    unsafe {
        cmd.pre_exec(|| {
            libc::setsid(); // new process group -> we can kill the whole tree
            Ok(())
        });
    }

    match cmd.spawn() {
        Ok(child) => {
            // setsid() made the child a group leader, so pgid == pid.
            BACKEND_PGID.store(child.id() as i32, Ordering::SeqCst);
            if !wait_for_ports(&[API_PORT, PANEL_PORT], Duration::from_secs(90)) {
                eprintln!("backend did not come up in time");
            }
            Some(child)
        }
        Err(e) => {
            eprintln!("could not start backend: {e} (is pnpm on PATH?)");
            None
        }
    }
}

/// The backend's process-group id, readable from a signal handler.
///
/// If the app is killed (SIGTERM/SIGINT) rather than quit through the UI, no Tauri
/// event ever fires and the dev-server tree would survive, holding :3000 and :8080
/// — the exact orphan problem that plagues `pnpm dev`. A signal handler is the
/// only place we can still reap it.
static BACKEND_PGID: AtomicI32 = AtomicI32::new(0);

extern "C" fn reap_backend_on_signal(_sig: i32) {
    let pgid = BACKEND_PGID.load(Ordering::SeqCst);
    if pgid > 0 {
        // killpg and _exit are async-signal-safe; println!/exit() are not.
        unsafe { libc::killpg(pgid, libc::SIGKILL) };
    }
    unsafe { libc::_exit(0) };
}

fn install_signal_handlers() {
    unsafe {
        libc::signal(libc::SIGTERM, reap_backend_on_signal as libc::sighandler_t);
        libc::signal(libc::SIGINT, reap_backend_on_signal as libc::sighandler_t);
        libc::signal(libc::SIGHUP, reap_backend_on_signal as libc::sighandler_t);
    }
}

/// Signal the whole process group, not just the parent.
fn stop_backend(child: &mut Child) {
    unsafe {
        libc::killpg(child.id() as i32, libc::SIGTERM);
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => return,
            _ => std::thread::sleep(Duration::from_millis(100)),
        }
    }
    unsafe {
        libc::killpg(child.id() as i32, libc::SIGKILL);
    }
    let _ = child.wait();
    BACKEND_PGID.store(0, Ordering::SeqCst);
}

/// Locate the Swift recorder.
///
/// In a shipped bundle it sits next to us in Contents/MacOS. In development we
/// anchor on the crate directory rather than walking up from the executable:
/// `cargo test` runs binaries out of `target/debug/deps/`, one level deeper than
/// `cargo run`, so a relative-to-exe path silently resolves to nothing.
fn recorder_path() -> Option<PathBuf> {
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) {
        let sibling = dir.join("recorder");
        if sibling.exists() {
            return Some(sibling);
        }
    }

    #[cfg(debug_assertions)]
    {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../macos/recorder/build/SumMeet Recorder.app/Contents/MacOS/recorder");
        if let Ok(p) = dev.canonicalize() {
            return Some(p);
        }
    }

    None
}

/// A GUI app launched from Finder inherits a minimal PATH (/usr/bin:/bin:…), so
/// neither `ffmpeg` (which the recorder shells out to) nor `pnpm` (which starts the
/// backend) would be found — both silent failures that never appear when the app is
/// launched from a terminal. Put the usual install locations back, including
/// ~/.local/bin, where corepack puts pnpm.
fn augmented_path() -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    let home = std::env::var("HOME").unwrap_or_default();
    format!("/opt/homebrew/bin:/usr/local/bin:{home}/.local/bin:{current}")
}

/// Spawn the recorder; it records until SIGINT, then joins the channels and
/// uploads. Separate from the Tauri command so it can be tested without a window.
fn spawn_recorder(title: &str) -> Result<Child, String> {
    let bin =
        recorder_path().ok_or("recorder binary not found — run apps/macos/recorder/build.sh")?;
    let out = std::env::temp_dir().join(format!("summeet-{}.wav", std::process::id()));

    Command::new(bin)
        .arg(&out)
        .arg("--api")
        .arg(API_BASE)
        .arg("--title")
        .arg(title)
        .env("PATH", augmented_path())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start recorder: {e}"))
}

/// SIGINT, not kill: the recorder still has to flush, join the channels and upload.
fn finish_recorder(mut child: Child) -> Result<String, String> {
    unsafe {
        libc::kill(child.id() as i32, libc::SIGINT);
    }
    let status = child.wait().map_err(|e| e.to_string())?;

    let mut stdout = String::new();
    if let Some(mut out) = child.stdout.take() {
        let _ = out.read_to_string(&mut stdout);
    }
    let mut stderr = String::new();
    if let Some(mut e) = child.stderr.take() {
        let _ = e.read_to_string(&mut stderr);
    }

    if !status.success() {
        // The recorder's diagnostics span several lines (e.g. the microphone
        // permission explanation); the last line alone loses the point.
        let detail: Vec<&str> = stderr.lines().filter(|l| !l.trim().is_empty()).collect();
        let tail = detail
            .iter()
            .rev()
            .take(5)
            .rev()
            .cloned()
            .collect::<Vec<_>>()
            .join(" ");
        return Err(format!(
            "recorder failed ({}): {}",
            status.code().unwrap_or(-1),
            if tail.is_empty() { "unknown error" } else { &tail }
        ));
    }

    stdout
        .lines()
        .find_map(|l| l.strip_prefix("MEETING_ID="))
        .map(str::to_string)
        .ok_or_else(|| "recorder produced no meeting id".to_string())
}

#[tauri::command]
fn start_recording(state: tauri::State<Recording>, title: String) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Err("already recording".into());
    }
    *guard = Some(spawn_recorder(&title)?);
    Ok(())
}

/// Ask the recorder to stop, wait for it to write + upload, hand back the id.
#[tauri::command]
fn stop_recording(state: tauri::State<Recording>) -> Result<String, String> {
    let child = {
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        guard.take().ok_or("not recording")?
    };
    finish_recorder(child)
}

#[tauri::command]
fn is_recording(state: tauri::State<Recording>) -> bool {
    state.0.lock().map(|g| g.is_some()).unwrap_or(false)
}

fn cleanup(handle: &tauri::AppHandle) {
    // Take each child out from under its lock before waiting on it: holding a
    // MutexGuard across a multi-second wait pins a borrow of the State temporary.
    let recording = {
        let s = handle.state::<Recording>();
        let child = s.0.lock().ok().and_then(|mut g| g.take());
        child
    };
    if let Some(child) = recording {
        let _ = finish_recorder(child); // let an in-flight recording finish uploading
    }

    let backend = {
        let s = handle.state::<Backend>();
        let child = s.0.lock().ok().and_then(|mut g| g.take());
        child
    };
    if let Some(mut child) = backend {
        stop_backend(&mut child); // only ever set when we started it ourselves
    }
}

fn main() {
    install_signal_handlers();

    let app = tauri::Builder::default()
        .manage(Recording::default())
        .manage(Backend::default())
        .setup(|app| {
            // Block until the panel answers: the webview points at :3000 and would
            // otherwise load an error page before the server is listening.
            let started = ensure_backend();
            let state = app.state::<Backend>();
            let mut guard = state.0.lock().unwrap();
            *guard = started;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_recording,
            stop_recording,
            is_recording
        ])
        .build(tauri::generate_context!())
        .expect("error while building SumMeet");

    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            cleanup(handle);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_recorder_binary() {
        assert!(
            recorder_path().is_some(),
            "recorder not found — run apps/macos/recorder/build.sh"
        );
    }

    /// A Finder-launched app has a minimal PATH. Both tools we shell out to must
    /// still resolve, or they fail silently in production and never in dev.
    #[test]
    fn augmented_path_reaches_ffmpeg_and_pnpm() {
        let path = augmented_path();
        for tool in ["ffmpeg", "pnpm"] {
            let found = path.split(':').any(|dir| {
                !dir.is_empty() && std::path::Path::new(dir).join(tool).exists()
            });
            assert!(found, "{tool} not reachable from the augmented PATH: {path}");
        }
    }

    #[test]
    fn repo_root_is_the_workspace() {
        assert!(repo_root().join("pnpm-workspace.yaml").exists());
    }

    #[test]
    fn closed_port_reads_as_closed() {
        // 1 is privileged and never bound by us; a false positive here would make
        // the app skip starting the backend and load an error page.
        assert!(!port_open(1));
    }

    #[test]
    fn waiting_on_a_closed_port_times_out_rather_than_hanging() {
        let t0 = std::time::Instant::now();
        assert!(!wait_for_ports(&[1], Duration::from_millis(600)));
        assert!(t0.elapsed() < Duration::from_secs(5));
    }

    /// End-to-end: spawn the Swift recorder, stop it, and confirm the local API
    /// accepted the upload. Needs the API on :8080 and screen/mic permissions, so
    /// it's opt-in: `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn records_and_uploads() {
        let child = spawn_recorder("cargo test recording").expect("spawn");
        std::thread::sleep(std::time::Duration::from_secs(3));
        let id = finish_recorder(child).expect("finish");
        assert!(!id.is_empty(), "expected a meeting id");
        println!("MEETING_ID={id}");
    }
}
