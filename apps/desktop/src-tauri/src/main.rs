// SumMeet desktop shell (SPEC A7).
//
// The window is just the existing web panel in a native webview — we don't
// rewrite the UI per platform. What the native shell adds is the part a browser
// can't do: capture the OS audio mix (system -> left, mic -> right) by driving
// the Swift recorder, which uploads straight to the local API.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

const API_BASE: &str = "http://localhost:8080";

#[derive(Default)]
struct Recording(Mutex<Option<Child>>);

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

/// A GUI app launched from Finder inherits a minimal PATH, so `ffmpeg` (which the
/// recorder shells out to) would not be found — a silent failure. Put the usual
/// Homebrew locations back before spawning.
fn augmented_path() -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    format!("/opt/homebrew/bin:/usr/local/bin:{current}")
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
        return Err(format!(
            "recorder failed ({}): {}",
            status.code().unwrap_or(-1),
            stderr.lines().last().unwrap_or("unknown error")
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

fn main() {
    tauri::Builder::default()
        .manage(Recording::default())
        .invoke_handler(tauri::generate_handler![
            start_recording,
            stop_recording,
            is_recording
        ])
        .run(tauri::generate_context!())
        .expect("error while running SumMeet");
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

    #[test]
    fn path_carries_homebrew_so_ffmpeg_resolves() {
        assert!(augmented_path().contains("/opt/homebrew/bin"));
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
