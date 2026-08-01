#[cfg(windows)]
use std::ffi::c_void;

#[cfg(windows)]
const GWL_EXSTYLE: i32 = -20;
#[cfg(windows)]
const WS_EX_LAYERED: isize = 0x0008_0000;
#[cfg(windows)]
const LWA_ALPHA: u32 = 0x0000_0002;

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn GetWindowLongPtrW(hwnd: *mut c_void, index: i32) -> isize;
    fn SetWindowLongPtrW(hwnd: *mut c_void, index: i32, value: isize) -> isize;
    fn SetLayeredWindowAttributes(hwnd: *mut c_void, color_key: u32, alpha: u8, flags: u32) -> i32;
}

/// Applies opacity to the native application window, including all canvas UI.
/// A 30% floor is enforced in the frontend so the controls cannot be lost.
#[tauri::command]
pub fn set_window_opacity(window: tauri::Window, opacity: f64) -> Result<(), String> {
    let clamped = opacity.clamp(0.30, 1.0);

    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|error| error.to_string())?.0 as *mut c_void;
        let alpha = (clamped * 255.0).round() as u8;
        unsafe {
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | WS_EX_LAYERED);
            if SetLayeredWindowAttributes(hwnd, 0, alpha, LWA_ALPHA) == 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
        }
    }

    #[cfg(not(windows))]
    let _ = (window, clamped);

    Ok(())
}
