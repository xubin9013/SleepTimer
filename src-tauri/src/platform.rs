use tauri_plugin_dialog::DialogExt;

#[cfg(windows)]
use windows_sys::Win32::UI::WindowsAndMessaging::{
    HWND_BROADCAST, SC_MONITORPOWER, SendMessageTimeoutW, WM_SYSCOMMAND,
    SMTO_ABORTIFHUNG, SMTO_NOTIMEOUTIFNOTHUNG,
};
#[cfg(windows)]
use windows_sys::Win32::Foundation::{BOOL, LPARAM, WPARAM};

#[cfg(windows)]
extern "system" {
    fn LockWorkStation() -> BOOL;
}

/// Turn the monitor off. Optionally lock the workstation afterwards.
///
/// Uses `SendMessageTimeoutW` (instead of the synchronous `SendMessageW`) so a
/// hung / unresponsive window cannot block the broadcast forever and freeze the app.
#[cfg(windows)]
pub fn screen_off(lock: bool) -> Result<(), String> {
    unsafe {
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SYSCOMMAND,
            SC_MONITORPOWER as WPARAM,
            2 as LPARAM,
            SMTO_ABORTIFHUNG | SMTO_NOTIMEOUTIFNOTHUNG,
            2000,
            std::ptr::null_mut(),
        );
        if lock {
            LockWorkStation();
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn screen_off(_lock: bool) -> Result<(), String> {
    Err("screen off is only supported on Windows".to_string())
}

/// Add / remove the app from the current user's startup registry key.
#[cfg(windows)]
pub fn set_autostart(enabled: bool) -> Result<(), String> {
    use winreg::enums::*;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let path = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    let key = hkcu
        .open_subkey_with_flags(path, KEY_WRITE)
        .map_err(|e| e.to_string())?;
    let exe = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .to_string();
    if enabled {
        // ★ 开机静默启动：注册时附带 --silent 参数，使主窗口不显示、仅驻留托盘
        let cmd = format!("\"{}\" --silent", exe);
        key.set_value("SleepTimer", &cmd).map_err(|e| e.to_string())?;
    } else {
        let _ = key.delete_value("SleepTimer");
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn set_autostart(_enabled: bool) -> Result<(), String> {
    Ok(())
}

/// Check whether the app is currently registered for auto-start (without modifying).
#[cfg(windows)]
pub fn check_autostart() -> bool {
    use winreg::enums::*;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let path = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    if let Ok(key) = hkcu.open_subkey_with_flags(path, KEY_READ) {
        let r: Result<String, _> = key.get_value("SleepTimer");
        r.is_ok()
    } else {
        false
    }
}

#[cfg(not(windows))]
pub fn check_autostart() -> bool {
    false
}

/// Open the native folder picker and return the selected path (blocking).
pub fn pick_folder(app: &tauri::AppHandle) -> Option<String> {
    let path = app.dialog().file().blocking_pick_folder()?;
    match path.into_path() {
        Ok(p) => Some(p.to_string_lossy().to_string()),
        Err(_) => None,
    }
}
