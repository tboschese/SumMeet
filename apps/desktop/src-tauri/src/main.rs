// SumMeet desktop shell (SPEC A7).
//
// The window is just the existing web panel in a native webview — we don't
// rewrite the UI per platform. What the native shell adds is the part a browser
// can't do: capture the OS audio mix (validated in apps/macos/spike) and, later,
// run the local API as a sidecar so there's no `pnpm dev` to remember.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running SumMeet");
}
