// SumMeet desktop shell (SPEC A7).
//
// The window is just the existing web panel in a native webview — we don't
// rewrite the UI per platform. What the native shell adds is the part a browser
// can't do: capture the OS audio mix (system -> left, mic -> right) by driving
// the Swift recorder, which uploads straight to the local API.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader, Read};
use std::net::TcpStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::Manager;

const API_BASE: &str = "http://localhost:8080";
const API_PORT: u16 = 8080;
const PANEL_PORT: u16 = 3000;
/// The recorder emits a level line every 200 ms; past this it has gone quiet on us.
const LEVEL_STALE: Duration = Duration::from_millis(1500);

/// The recorder's live view of both channels, refreshed from its stdout.
#[derive(Clone, Copy, Default)]
struct Levels {
    system: f32,
    mic: f32,
}

/// What the panel and the menu-bar item render. `stale` means the recorder stopped
/// reporting — the recording is running blind, which is worth showing.
#[derive(serde::Serialize, Clone, Copy, Default)]
struct CaptureStatus {
    recording: bool,
    system: f32,
    mic: f32,
    elapsed_secs: u64,
    stale: bool,
}

/// A recorder process plus the thread draining its stdout. We can't just read
/// stdout at exit any more: the levels have to arrive while it runs, and a full
/// pipe buffer would otherwise block the recorder mid-meeting.
struct Session {
    child: Child,
    reader: Option<JoinHandle<Vec<String>>>,
    levels: Arc<Mutex<Option<(Levels, Instant)>>>,
    started: Instant,
}

#[derive(Default)]
struct Recording(Mutex<Option<Session>>);

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
        libc::signal(libc::SIGTERM, reap_backend_on_signal as *const () as libc::sighandler_t);
        libc::signal(libc::SIGINT, reap_backend_on_signal as *const () as libc::sighandler_t);
        libc::signal(libc::SIGHUP, reap_backend_on_signal as *const () as libc::sighandler_t);
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

/// `LEVEL sys=0.01234 mic=0.05678` → the two numbers.
fn parse_level(line: &str) -> Option<Levels> {
    let rest = line.strip_prefix("LEVEL ")?;
    let mut system = None;
    let mut mic = None;
    for field in rest.split_whitespace() {
        let (key, value) = field.split_once('=')?;
        let value: f32 = value.parse().ok()?;
        match key {
            "sys" => system = Some(value),
            "mic" => mic = Some(value),
            _ => {}
        }
    }
    Some(Levels {
        system: system?,
        mic: mic?,
    })
}

/// Spawn the recorder; it records until SIGINT, then joins the channels and
/// uploads. Separate from the Tauri command so it can be tested without a window.
fn spawn_recorder(title: &str) -> Result<Session, String> {
    let bin =
        recorder_path().ok_or("recorder binary not found — run apps/macos/recorder/build.sh")?;
    let out = std::env::temp_dir().join(format!("summeet-{}.wav", std::process::id()));

    let mut child = Command::new(bin)
        .arg(&out)
        .arg("--api")
        .arg(API_BASE)
        .arg("--title")
        .arg(title)
        .env("PATH", augmented_path())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start recorder: {e}"))?;

    let levels = Arc::new(Mutex::new(None));
    let stdout = child.stdout.take().ok_or("recorder has no stdout")?;
    let reader = {
        let levels = Arc::clone(&levels);
        std::thread::spawn(move || {
            // Levels are consumed live; everything else is kept for finish_recorder,
            // which still needs MEETING_ID out of this same stream.
            let mut kept = Vec::new();
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                match parse_level(&line) {
                    Some(l) => *levels.lock().unwrap() = Some((l, Instant::now())),
                    None => kept.push(line),
                }
            }
            kept
        })
    };

    Ok(Session {
        child,
        reader: Some(reader),
        levels,
        started: Instant::now(),
    })
}

/// SIGINT, not kill: the recorder still has to flush, join the channels and upload.
fn finish_recorder(mut session: Session) -> Result<String, String> {
    unsafe {
        libc::kill(session.child.id() as i32, libc::SIGINT);
    }
    let status = session.child.wait().map_err(|e| e.to_string())?;

    // The reader thread ends when the recorder closes stdout, i.e. on exit; joining
    // after wait() therefore can't deadlock and hands back every non-level line.
    let stdout = session
        .reader
        .take()
        .and_then(|h| h.join().ok())
        .unwrap_or_default()
        .join("\n");

    let mut stderr = String::new();
    if let Some(mut e) = session.child.stderr.take() {
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
            "recorder failed ({}): {} — full log at ~/Library/Logs/SumMeet/recorder.log",
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

/// Live capture status, so the user can see both channels are alive *during* the
/// meeting rather than discovering a dead microphone in the transcript afterwards.
fn read_status(recording: &Recording) -> CaptureStatus {
    let guard = match recording.0.lock() {
        Ok(g) => g,
        Err(_) => return CaptureStatus::default(),
    };
    let Some(session) = guard.as_ref() else {
        return CaptureStatus::default();
    };
    let sampled = session.levels.lock().ok().and_then(|l| *l);
    match sampled {
        Some((levels, at)) => CaptureStatus {
            recording: true,
            system: levels.system,
            mic: levels.mic,
            elapsed_secs: session.started.elapsed().as_secs(),
            stale: at.elapsed() > LEVEL_STALE,
        },
        // Recording, but no level has landed yet: the first one is 200 ms out.
        None => CaptureStatus {
            recording: true,
            elapsed_secs: session.started.elapsed().as_secs(),
            stale: session.started.elapsed() > LEVEL_STALE,
            ..CaptureStatus::default()
        },
    }
}

#[tauri::command]
fn capture_status(state: tauri::State<Recording>) -> CaptureStatus {
    read_status(&state)
}

// ── Menu-bar indicator ───────────────────────────────────────────────────────
// The window is usually behind the meeting. A recording you can't see is a
// recording you can't trust: the microphone died twice in this project's history
// and nothing on screen said so until the transcript came back wrong.

const TRAY_ID: &str = "summeet";
/// A live mic always carries room tone; below this it isn't merely quiet, it's off.
const DEAD_CHANNEL: f32 = 0.001;
/// Don't cry "dead" before the channel has had a moment to produce anything.
const GRACE_SECS: u64 = 4;

/// One glyph per channel, in the ascending-bars language of the SumMeet mark. RMS is
/// linear but hearing is not: a linear scale sits on the bottom block through normal
/// speech, so map decibels.
fn meter(level: f32) -> char {
    const BLOCKS: [char; 7] = ['▁', '▂', '▃', '▄', '▅', '▆', '▇'];
    let db = if level <= 0.0 {
        -100.0
    } else {
        20.0 * level.log10()
    };
    let step = (((db + 60.0) / 50.0).clamp(0.0, 1.0) * (BLOCKS.len() - 1) as f32).round() as usize;
    BLOCKS[step]
}

/// A channel silent for the whole recording, not merely between words. The peak
/// decays, so a pause in the conversation never reads as a dead channel.
fn channel_label(level: f32, recent_peak: f32, elapsed: u64) -> char {
    if elapsed >= GRACE_SECS && recent_peak < DEAD_CHANNEL {
        '!'
    } else {
        meter(level)
    }
}

/// A macOS template image: the mark in black, transparency doing the drawing. The
/// system recolours it for the light and dark menu bar — which is exactly why emoji
/// never belong here, since it cannot recolour those.
const TRAY_ICON: &[u8] = include_bytes!("../icons/tray-icon@2x.png");

fn start_menu_bar_indicator(handle: tauri::AppHandle) -> tauri::Result<()> {
    let mut tray = tauri::tray::TrayIconBuilder::with_id(TRAY_ID);
    match tauri::image::Image::from_bytes(TRAY_ICON) {
        Ok(icon) => tray = tray.icon(icon).icon_as_template(true),
        // Losing the icon is cosmetic; losing the meter is not. Carry on with text.
        Err(e) => eprintln!("tray icon failed to load: {e}"),
    }
    tray.build(&handle)?;

    std::thread::spawn(move || {
        // Peaks decay instead of resetting, so the meter shows "this channel is
        // alive" through the natural pauses in speech.
        let (mut system_peak, mut mic_peak) = (0.0f32, 0.0f32);

        loop {
            std::thread::sleep(Duration::from_millis(300));
            let Some(tray) = handle.tray_by_id(TRAY_ID) else {
                continue;
            };
            let status = read_status(&handle.state::<Recording>());

            if !status.recording {
                system_peak = 0.0;
                mic_peak = 0.0;
                let _ = tray.set_title(None::<&str>);
                let _ = tray.set_tooltip(Some("SumMeet"));
                continue;
            }

            system_peak = (system_peak * 0.97).max(status.system);
            mic_peak = (mic_peak * 0.97).max(status.mic);

            let clock = format!("{}:{:02}", status.elapsed_secs / 60, status.elapsed_secs % 60);
            // Two glyphs, others then you — the order of the stereo layout itself.
            let title = if status.stale {
                format!("{clock} !")
            } else {
                format!(
                    "{clock} {}{}",
                    channel_label(status.system, system_peak, status.elapsed_secs),
                    channel_label(status.mic, mic_peak, status.elapsed_secs),
                )
            };
            let _ = tray.set_title(Some(&title));
            let _ = tray.set_tooltip(Some(if status.stale {
                "SumMeet: the recorder stopped reporting"
            } else if status.elapsed_secs >= GRACE_SECS && mic_peak < DEAD_CHANNEL {
                "SumMeet: the microphone is silent — your own voice is not being captured"
            } else if status.elapsed_secs >= GRACE_SECS && system_peak < DEAD_CHANNEL {
                "SumMeet: no system audio — the other participants are not being captured"
            } else {
                "SumMeet: recording (system + microphone)"
            }));
        }
    });
    Ok(())
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
            drop(guard);

            start_menu_bar_indicator(app.handle().clone())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_recording,
            stop_recording,
            is_recording,
            capture_status
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

    #[test]
    fn parses_a_level_line() {
        let l = parse_level("LEVEL sys=0.08820 mic=0.03971").expect("should parse");
        assert!((l.system - 0.08820).abs() < 1e-6);
        assert!((l.mic - 0.03971).abs() < 1e-6);
    }

    #[test]
    fn ignores_lines_that_are_not_levels() {
        // These must survive to finish_recorder, which parses MEETING_ID out of them.
        assert!(parse_level("MEETING_ID=abc123").is_none());
        assert!(parse_level("OK /tmp/out.wav").is_none());
        assert!(parse_level("LEVEL sys=nan-ish").is_none());
    }

    #[test]
    fn the_meter_spans_silence_to_speech() {
        assert_eq!(meter(0.0), '▁');
        assert_eq!(meter(0.3), '▇');
        // Room tone (~0.005) must be visibly above silence, or a live mic looks dead.
        assert!(meter(0.005) > '▁');
        // And speech must be visibly above room tone.
        assert!(meter(0.05) > meter(0.005));
    }

    #[test]
    fn a_dead_channel_warns_only_after_the_grace_period() {
        // A silent pause between sentences is not a dead microphone.
        assert_eq!(channel_label(0.0, 0.05, 30), '▁');
        // Nothing at all since the recording began, though, is.
        assert_eq!(channel_label(0.0, 0.0, 30), '!');
        assert_eq!(channel_label(0.0, 0.0, 1), '▁');
    }

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
