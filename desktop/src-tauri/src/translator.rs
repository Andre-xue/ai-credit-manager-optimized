// 翻译助手原生侧（v0.1.440）：全局快捷键（划词/截图/输入）、模拟复制取词、
// 截图框选 + macOS Vision 本地 OCR、权限真实查询、译文小窗与框选层窗口管理。
//
// macOS 能力全部走系统框架 FFI（CoreGraphics / CoreFoundation / ApplicationServices /
// Vision + libobjc 动态消息），不新增任何 crate 依赖：本地与 CI 的依赖树保持不动。
// 非 macOS 平台：快捷键与窗口照常，取词/截图/权限返回明确的「仅支持 macOS」结果。
//
// 事件（发给 main 窗口，宿主在 src/components/TranslatorHost.tsx）：
// - translator-hotkey { action: "selection" | "input" }
// - translator-shot-text { text, x, y }（OCR 完成，x/y 为选区中心/底部，逻辑点）
// - translator-error { message, x?, y? }
// 小窗数据：translator_show_pop 存入 POP_PAYLOAD 并向小窗发 translator-pop-data，
// 小窗启动时也会用 translator_pop_payload 主动拉一次，双保险。

use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub const POP_LABEL: &str = "translator-pop";
pub const CAPTURE_LABEL: &str = "translator-capture";

// ---------------- 共享状态 ----------------

struct HotkeyConfig {
    disable_fullscreen: bool,
}

static CONFIG: Mutex<HotkeyConfig> = Mutex::new(HotkeyConfig { disable_fullscreen: false });
static TRANSLATOR_SHORTCUTS: Mutex<Vec<Shortcut>> = Mutex::new(Vec::new());

#[derive(Clone, Serialize, Deserialize, Default)]
pub struct PopPayload {
    pub source: String,
    pub translated: String,
    #[serde(default)]
    pub target_lang: String,
    pub error: Option<String>,
    pub ops: String,
}

static POP_PAYLOAD: Mutex<Option<PopPayload>> = Mutex::new(None);

fn emit_to_main(app: &AppHandle, event: &str, payload: serde_json::Value) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.emit(event, payload);
    }
}

fn fullscreen_guard() -> bool {
    let disabled = CONFIG.lock().map(|c| c.disable_fullscreen).unwrap_or(false);
    if !disabled {
        return false;
    }
    #[cfg(target_os = "macos")]
    {
        mac::frontmost_app_fullscreen()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

// ---------------- 权限 ----------------

#[derive(Serialize)]
pub struct TranslatorPermissions {
    pub macos: bool,
    pub accessibility: bool,
    #[serde(rename = "screenCapture")]
    pub screen_capture: bool,
}

#[tauri::command]
pub fn translator_permissions() -> TranslatorPermissions {
    #[cfg(target_os = "macos")]
    {
        TranslatorPermissions {
            macos: true,
            accessibility: mac::ax_trusted(),
            screen_capture: mac::screen_ok(),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        TranslatorPermissions { macos: false, accessibility: false, screen_capture: false }
    }
}

/// 触发辅助功能系统授权请求（带 prompt 的官方查询：系统会把本应用登记进
/// 「辅助功能」列表并弹窗），返回当前真实状态。
#[tauri::command]
pub fn translator_request_accessibility() -> bool {
    #[cfg(target_os = "macos")]
    {
        mac::ax_trusted_with_prompt()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// 触发录屏系统授权请求，返回当前真实状态。
#[tauri::command]
pub fn translator_request_screen() -> bool {
    #[cfg(target_os = "macos")]
    {
        mac::screen_request()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// 直达 macOS 系统设置对应的隐私面板（应用不能自授权限，只能把用户送到开关面前）。
#[tauri::command]
pub fn translator_open_settings(kind: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let pane = match kind.as_str() {
            "accessibility" => "Privacy_Accessibility",
            _ => "Privacy_ScreenCapture",
        };
        let url = format!("x-apple.systempreferences:com.apple.preference.security?{pane}");
        std::process::Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|e| format!("打开系统设置失败：{e}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = kind;
        Err("仅支持 macOS".to_string())
    }
}

// ---------------- 全局快捷键 ----------------

/// 前端下发翻译助手快捷键配置：只注销/重注册本模块自己管的那批，
/// 不碰 App 壳的 AI/迷你窗快捷键（shortcuts_apply 同理只管它自己的）。
#[tauri::command]
pub fn translator_shortcuts_apply(
    app: AppHandle,
    selection: Option<String>,
    screenshot: Option<String>,
    input: Option<String>,
    disable_fullscreen: bool,
    double_click: bool,
) -> Result<(), String> {
    if let Ok(mut c) = CONFIG.lock() {
        c.disable_fullscreen = disable_fullscreen;
    }
    #[cfg(target_os = "macos")]
    {
        mac::set_double_click_enabled(double_click && selection.is_some());
        if double_click && selection.is_some() {
            mac::ensure_double_click_thread(app.clone());
        }
    }

    let gs = app.global_shortcut();
    if let Ok(mut store) = TRANSLATOR_SHORTCUTS.lock() {
        for sc in store.drain(..) {
            let _ = gs.unregister(sc);
        }
    }
    let mut registered: Vec<Shortcut> = Vec::new();
    let mut register = |raw: &Option<String>, kind: &'static str| -> Result<(), String> {
        let Some(v) = raw else { return Ok(()) };
        if v.trim().is_empty() {
            return Ok(());
        }
        let sc: Shortcut = v
            .parse()
            .map_err(|e| format!("快捷键格式无效（{v}）：{e}"))?;
        let h = app.clone();
        gs.on_shortcut(sc, move |_app, _s, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }
            if fullscreen_guard() {
                return;
            }
            match kind {
                "selection" => emit_to_main(&h, "translator-hotkey", serde_json::json!({ "action": "selection" })),
                "input" => {
                    crate::show_main_window(&h, Some("workshop"));
                    emit_to_main(&h, "translator-hotkey", serde_json::json!({ "action": "input" }));
                }
                _ => {
                    if let Err(e) = start_capture(&h) {
                        let (mx, my) = current_mouse(&h);
                        emit_to_main(&h, "translator-error", serde_json::json!({ "message": e, "x": mx, "y": my }));
                    }
                }
            }
        })
        .map_err(|e| format!("注册快捷键失败（{v}，可能被其他应用占用）：{e}"))?;
        registered.push(sc);
        Ok(())
    };
    let r = (|| {
        register(&selection, "selection")?;
        register(&screenshot, "screenshot")?;
        register(&input, "input")?;
        Ok::<(), String>(())
    })();
    if let Ok(mut store) = TRANSLATOR_SHORTCUTS.lock() {
        *store = registered;
    }
    r
}

fn current_mouse(_app: &AppHandle) -> (f64, f64) {
    #[cfg(target_os = "macos")]
    {
        mac::mouse_location()
    }
    #[cfg(not(target_os = "macos"))]
    {
        (0.0, 0.0)
    }
}

// ---------------- 取词（模拟复制） ----------------

#[derive(Serialize)]
pub struct SelectionOutcome {
    pub text: Option<String>,
    pub error: Option<String>,
    pub x: f64,
    pub y: f64,
}

/// 模拟 Cmd+C 取当前选中文本：剪贴板先写入哨兵串，按下复制后轮询剪贴板变化，
/// 取不到就恢复原剪贴板并明确报错——不假装成功（见 core/translator.ts 的宿主处理）。
#[tauri::command]
pub fn translator_get_selection() -> SelectionOutcome {
    #[cfg(target_os = "macos")]
    {
        let (x, y) = mac::mouse_location();
        if !mac::ax_trusted() {
            return SelectionOutcome {
                text: None,
                error: Some("缺少辅助功能权限：到「翻译助手 → 设置 → 权限管理」点「去开启」，在系统设置里给 AI 魔方打勾后重试".to_string()),
                x,
                y,
            };
        }
        match mac::grab_selection() {
            Ok(text) => SelectionOutcome { text: Some(text), error: None, x, y },
            Err(e) => SelectionOutcome { text: None, error: Some(e), x, y },
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        SelectionOutcome {
            text: None,
            error: Some("划词翻译仅支持 macOS 桌面端".to_string()),
            x: 0.0,
            y: 0.0,
        }
    }
}

// ---------------- 剪贴板与粘贴（替换） ----------------

#[tauri::command]
pub fn translator_clipboard_write(text: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        mac::clipboard_write(&text)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = text;
        Err("仅支持 macOS".to_string())
    }
}

/// 替换原文：先收起小窗让焦点回到原应用，再写剪贴板并模拟 Cmd+V 粘贴译文。
#[tauri::command]
pub fn translator_paste_text(app: AppHandle, text: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if let Some(w) = app.get_webview_window(POP_LABEL) {
            let _ = w.hide();
        }
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(160));
            if mac::clipboard_write(&text).is_ok() {
                mac::send_cmd_v();
            }
        });
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, text);
        Err("仅支持 macOS".to_string())
    }
}

// ---------------- 译文小窗 ----------------

fn ensure_pop_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(w) = app.get_webview_window(POP_LABEL) {
        return Ok(w);
    }
    let w = WebviewWindowBuilder::new(app, POP_LABEL, WebviewUrl::App("index.html#/translator-pop".into()))
        .title("翻译")
        .inner_size(400.0, 300.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .build()
        .map_err(|e| format!("创建翻译小窗失败：{e}"))?;
    let wc = w.clone();
    w.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = wc.hide();
        }
    });
    Ok(w)
}

#[tauri::command]
pub fn translator_show_pop(
    app: AppHandle,
    source: String,
    translated: String,
    target_lang: String,
    error: Option<String>,
    ops: String,
    x: f64,
    y: f64,
) -> Result<(), String> {
    let payload = PopPayload { source, translated, target_lang, error, ops };
    if let Ok(mut g) = POP_PAYLOAD.lock() {
        *g = Some(payload.clone());
    }
    let w = ensure_pop_window(&app)?;
    // 定位：x/y 是逻辑点（鼠标位置 + 前端已加的偏移），换算成物理像素并夹在屏幕内
    if let Ok(Some(monitor)) = w.primary_monitor() {
        let scale = monitor.scale_factor();
        let mon_w = monitor.size().width as i32;
        let mon_h = monitor.size().height as i32;
        let win_w = w.outer_size().map(|s| s.width as i32).unwrap_or((400.0 * scale) as i32);
        let win_h = w.outer_size().map(|s| s.height as i32).unwrap_or((300.0 * scale) as i32);
        let edge = (6.0 * scale) as i32;
        let mut px = (x * scale) as i32;
        let mut py = (y * scale) as i32;
        if px + win_w > mon_w - edge {
            px = mon_w - win_w - edge;
        }
        if py + win_h > mon_h - edge {
            py = mon_h - win_h - edge;
        }
        let _ = w.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(px.max(edge), py.max(edge))));
    }
    let _ = w.show();
    let _ = w.emit("translator-pop-data", payload);
    Ok(())
}

#[tauri::command]
pub fn translator_pop_payload() -> Option<PopPayload> {
    POP_PAYLOAD.lock().ok().and_then(|g| g.clone())
}

#[tauri::command]
pub fn translator_hide_pop(app: AppHandle) {
    if let Some(w) = app.get_webview_window(POP_LABEL) {
        let _ = w.hide();
    }
}

// ---------------- 截图框选 + OCR ----------------

fn ensure_capture_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(w) = app.get_webview_window(CAPTURE_LABEL) {
        return Ok(w);
    }
    let w = WebviewWindowBuilder::new(app, CAPTURE_LABEL, WebviewUrl::App("index.html#/translator-capture".into()))
        .title("截图翻译")
        .inner_size(1200.0, 800.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .build()
        .map_err(|e| format!("创建截图框选层失败：{e}"))?;
    let wc = w.clone();
    w.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = wc.hide();
        }
    });
    Ok(w)
}

fn start_capture(app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if !mac::screen_ok() {
            // 先触发系统授权请求（应用会被登记进录屏列表），再把用户直达设置面板
            let _ = mac::screen_request();
            let _ = translator_open_settings("screen".to_string());
            return Err("需要录屏权限：已为你打开系统设置，在「录屏与系统录音」里给 AI 魔方打勾后重试".to_string());
        }
    }
    let w = ensure_capture_window(app)?;
    // 铺满主显示器（逻辑点坐标，与前端 clientX/Y 同系）
    if let Ok(Some(monitor)) = w.primary_monitor() {
        let scale = monitor.scale_factor();
        let lw = monitor.size().width as f64 / scale;
        let lh = monitor.size().height as f64 / scale;
        let _ = w.set_size(tauri::Size::Logical(tauri::LogicalSize::new(lw, lh)));
        let _ = w.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(0.0, 0.0)));
    }
    let _ = w.show();
    let _ = w.set_focus();
    Ok(())
}

#[tauri::command]
pub fn translator_start_capture(app: AppHandle) -> Result<(), String> {
    start_capture(&app)
}

#[tauri::command]
pub fn translator_capture_cancel(app: AppHandle) {
    if let Some(w) = app.get_webview_window(CAPTURE_LABEL) {
        let _ = w.hide();
    }
}

/// 框选完成：收起框选层 → screencapture 截取选区（逻辑点）→ Vision 本地 OCR →
/// 结果以 translator-shot-text 事件发给主窗口宿主继续翻译；失败发 translator-error。
#[tauri::command]
pub fn translator_capture_finish(app: AppHandle, x: f64, y: f64, w: f64, h: f64) {
    if let Some(win) = app.get_webview_window(CAPTURE_LABEL) {
        let _ = win.hide();
    }
    let cx = x + w / 2.0;
    let bottom = y + h;
    std::thread::spawn(move || {
        #[cfg(target_os = "macos")]
        {
            match mac::capture_and_ocr(x, y, w, h) {
                Ok(text) if !text.trim().is_empty() => {
                    emit_to_main(&app, "translator-shot-text", serde_json::json!({ "text": text, "x": cx, "y": bottom }));
                }
                Ok(_) => {
                    emit_to_main(&app, "translator-error", serde_json::json!({
                        "message": "框选区域里没有识别到文字，换个区域试试", "x": cx, "y": bottom
                    }));
                }
                Err(e) => {
                    emit_to_main(&app, "translator-error", serde_json::json!({ "message": e, "x": cx, "y": bottom }));
                }
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            emit_to_main(&app, "translator-error", serde_json::json!({
                "message": "截图翻译仅支持 macOS 桌面端", "x": cx, "y": bottom
            }));
        }
    });
}

// ---------------- macOS FFI ----------------

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::{c_char, c_void, CString};
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};

    // ---- CoreGraphics / ApplicationServices / CoreFoundation ----
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct CGPointF {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct CGSizeF {
        width: f64,
        height: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct CGRectF {
        origin: CGPointF,
        size: CGSizeF,
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
        fn CGEventCreate(source: *const c_void) -> *mut c_void;
        fn CGEventGetLocation(event: *const c_void) -> CGPointF;
        fn CGEventCreateKeyboardEvent(source: *const c_void, keycode: u16, keydown: bool) -> *mut c_void;
        fn CGEventSetFlags(event: *mut c_void, flags: u64);
        fn CGEventPost(tap: u32, event: *mut c_void);
        fn CGEventSourceButtonState(state: i32, button: u32) -> bool;
        fn CGWindowListCopyWindowInfo(options: u32, relative_to_window: u32) -> *const c_void;
        fn CGMainDisplayID() -> u32;
        fn CGDisplayBounds(display: u32) -> CGRectF;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: *const c_void);
        fn CFArrayGetCount(arr: *const c_void) -> isize;
        fn CFArrayGetValueAtIndex(arr: *const c_void, idx: isize) -> *const c_void;
        fn CFDictionaryGetValue(dict: *const c_void, key: *const c_void) -> *const c_void;
        fn CFNumberGetValue(num: *const c_void, the_type: i32, value_ptr: *mut c_void) -> bool;
        fn CFStringCreateWithCString(alloc: *const c_void, c_str: *const c_char, encoding: u32) -> *const c_void;
    }

    // Vision / Foundation 只经 libobjc 动态消息调用，没有链接期符号；
    // 用一个从不调用的锚点函数让链接器把两个 framework 挂上，保证运行时类可达。
    #[link(name = "Vision", kind = "framework")]
    #[link(name = "Foundation", kind = "framework")]
    extern "C" {
        fn acm_translator_framework_anchor();
    }

    #[link(name = "objc")]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend();
        fn objc_autoreleasePoolPush() -> *mut c_void;
        fn objc_autoreleasePoolPop(ctx: *mut c_void);
    }

    type Id = *mut c_void;
    type Sel = *mut c_void;

    fn sel(name: &str) -> Sel {
        let c = CString::new(name).unwrap_or_default();
        unsafe { sel_registerName(c.as_ptr()) }
    }

    fn class(name: &str) -> Id {
        let c = CString::new(name).unwrap_or_default();
        unsafe { objc_getClass(c.as_ptr()) }
    }

    // objc_msgSend 的几种常用签名（ARM64/x86_64 下 id/整数/bool 参数都走寄存器）
    unsafe fn msg_id(recv: Id, sel: Sel) -> Id {
        let f: extern "C" fn(Id, Sel) -> Id = std::mem::transmute(objc_msgSend as usize);
        f(recv, sel)
    }
    unsafe fn msg_void(recv: Id, sel: Sel) {
        let f: extern "C" fn(Id, Sel) = std::mem::transmute(objc_msgSend as usize);
        f(recv, sel)
    }
    unsafe fn msg_id_cstr(recv: Id, sel: Sel, arg: *const c_char) -> Id {
        let f: extern "C" fn(Id, Sel, *const c_char) -> Id = std::mem::transmute(objc_msgSend as usize);
        f(recv, sel, arg)
    }
    unsafe fn msg_id_id(recv: Id, sel: Sel, arg: Id) -> Id {
        let f: extern "C" fn(Id, Sel, Id) -> Id = std::mem::transmute(objc_msgSend as usize);
        f(recv, sel, arg)
    }
    unsafe fn msg_id_id_id(recv: Id, sel: Sel, a: Id, b: Id) -> Id {
        let f: extern "C" fn(Id, Sel, Id, Id) -> Id = std::mem::transmute(objc_msgSend as usize);
        f(recv, sel, a, b)
    }
    unsafe fn msg_void_id(recv: Id, sel: Sel, arg: Id) {
        let f: extern "C" fn(Id, Sel, Id) = std::mem::transmute(objc_msgSend as usize);
        f(recv, sel, arg)
    }
    unsafe fn msg_void_i64(recv: Id, sel: Sel, arg: i64) {
        let f: extern "C" fn(Id, Sel, i64) = std::mem::transmute(objc_msgSend as usize);
        f(recv, sel, arg)
    }
    unsafe fn msg_void_bool(recv: Id, sel: Sel, arg: bool) {
        let f: extern "C" fn(Id, Sel, bool) = std::mem::transmute(objc_msgSend as usize);
        f(recv, sel, arg)
    }
    unsafe fn msg_usize(recv: Id, sel: Sel) -> usize {
        let f: extern "C" fn(Id, Sel) -> usize = std::mem::transmute(objc_msgSend as usize);
        f(recv, sel)
    }
    unsafe fn msg_id_usize(recv: Id, sel: Sel, arg: usize) -> Id {
        let f: extern "C" fn(Id, Sel, usize) -> Id = std::mem::transmute(objc_msgSend as usize);
        f(recv, sel, arg)
    }
    unsafe fn msg_arr_objs(recv: Id, sel: Sel, objs: *const Id, count: usize) -> Id {
        let f: extern "C" fn(Id, Sel, *const Id, usize) -> Id = std::mem::transmute(objc_msgSend as usize);
        f(recv, sel, objs, count)
    }
    unsafe fn msg_perform(recv: Id, sel: Sel, requests: Id, error: *mut Id) -> bool {
        let f: extern "C" fn(Id, Sel, Id, *mut Id) -> bool = std::mem::transmute(objc_msgSend as usize);
        f(recv, sel, requests, error)
    }
    unsafe fn msg_supported_langs(recv: Id, sel: Sel, revision: i64, error: *mut Id) -> Id {
        let f: extern "C" fn(Id, Sel, i64, *mut Id) -> Id = std::mem::transmute(objc_msgSend as usize);
        f(recv, sel, revision, error)
    }

    unsafe fn ns_string(s: &str) -> Id {
        let cls = class("NSString");
        if cls.is_null() {
            return std::ptr::null_mut();
        }
        let c = CString::new(s).unwrap_or_default();
        msg_id_cstr(cls, sel("stringWithUTF8String:"), c.as_ptr())
    }

    unsafe fn ns_utf8(obj: Id) -> Option<String> {
        if obj.is_null() {
            return None;
        }
        let f: extern "C" fn(Id, Sel) -> *const c_char = std::mem::transmute(objc_msgSend as usize);
        let p = f(obj, sel("UTF8String"));
        if p.is_null() {
            return None;
        }
        Some(std::ffi::CStr::from_ptr(p).to_string_lossy().into_owned())
    }

    // ---- 权限 ----

    pub fn ax_trusted() -> bool {
        unsafe { AXIsProcessTrusted() }
    }

    pub fn ax_trusted_with_prompt() -> bool {
        unsafe {
            // 用 NSMutableDictionary 拼 { AXTrustedCheckOptionPrompt: true }，
            // 避免手写 CFDictionary 的回调结构体。
            let dict_cls = class("NSMutableDictionary");
            let num_cls = class("NSNumber");
            if dict_cls.is_null() || num_cls.is_null() {
                return AXIsProcessTrusted();
            }
            let dict = msg_id(dict_cls, sel("dictionary"));
            let key = ns_string("AXTrustedCheckOptionPrompt");
            let f: extern "C" fn(Id, Sel, bool) -> Id = std::mem::transmute(objc_msgSend as usize);
            let val = f(num_cls, sel("numberWithBool:"), true);
            if !dict.is_null() && !key.is_null() && !val.is_null() {
                let set: extern "C" fn(Id, Sel, Id, Id) = std::mem::transmute(objc_msgSend as usize);
                set(dict, sel("setObject:forKey:"), val, key);
            }
            AXIsProcessTrustedWithOptions(dict as *const c_void)
        }
    }

    pub fn screen_ok() -> bool {
        unsafe { CGPreflightScreenCaptureAccess() }
    }

    pub fn screen_request() -> bool {
        unsafe { CGRequestScreenCaptureAccess() }
    }

    // ---- 鼠标与键盘 ----

    pub fn mouse_location() -> (f64, f64) {
        unsafe {
            let ev = CGEventCreate(std::ptr::null());
            if ev.is_null() {
                return (0.0, 0.0);
            }
            let p = CGEventGetLocation(ev);
            CFRelease(ev as *const c_void);
            (p.x, p.y)
        }
    }

    const FLAG_COMMAND: u64 = 0x0010_0000; // kCGEventFlagMaskCommand
    const KEY_COMMAND: u16 = 55;
    const KEY_C: u16 = 8; // kVK_ANSI_C
    const KEY_V: u16 = 9; // kVK_ANSI_V

    unsafe fn post_key(keycode: u16, keydown: bool, flags: u64) {
        let ev = CGEventCreateKeyboardEvent(std::ptr::null(), keycode, keydown);
        if ev.is_null() {
            return;
        }
        if flags != 0 {
            CGEventSetFlags(ev, flags);
        }
        CGEventPost(0, ev); // kCGHIDEventTap
        CFRelease(ev as *const c_void);
    }

    fn send_combo(keycode: u16) {
        unsafe {
            post_key(KEY_COMMAND, true, FLAG_COMMAND);
            post_key(keycode, true, FLAG_COMMAND);
            post_key(keycode, false, FLAG_COMMAND);
            post_key(KEY_COMMAND, false, 0);
        }
    }

    pub fn send_cmd_v() {
        send_combo(KEY_V);
    }

    // ---- 剪贴板（走系统 pbcopy/pbpaste，与现有 osascript 用法同风格） ----

    fn clipboard_read() -> Option<String> {
        let out = Command::new("pbpaste").output().ok()?;
        if !out.status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    pub fn clipboard_write(text: &str) -> Result<(), String> {
        use std::io::Write;
        let mut child = Command::new("pbcopy")
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|e| format!("写入剪贴板失败：{e}"))?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(text.as_bytes())
                .map_err(|e| format!("写入剪贴板失败：{e}"))?;
        }
        let _ = child.wait();
        Ok(())
    }

    /// 模拟复制取选区：哨兵串 + 轮询变化；超时恢复原剪贴板并报错。
    pub fn grab_selection() -> Result<String, String> {
        let saved = clipboard_read();
        let sentinel = format!(
            "__acm_tr_{}__",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        clipboard_write(&sentinel)?;
        send_combo(KEY_C);
        let deadline = Instant::now() + Duration::from_millis(600);
        let mut found: Option<String> = None;
        while Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(40));
            match clipboard_read() {
                Some(cur) if cur != sentinel && !cur.is_empty() => {
                    found = Some(cur);
                    break;
                }
                _ => {}
            }
        }
        match found {
            Some(text) => Ok(text),
            None => {
                // 没取到：把用户原来的剪贴板还回去，不留哨兵串污染
                if let Some(orig) = saved {
                    let _ = clipboard_write(&orig);
                }
                Err("没有取到选中文本：请先在其他应用里选中文字再按快捷键；若已选中，可能是当前应用不响应模拟复制".to_string())
            }
        }
    }

    // ---- 全屏检测（设置项：在全屏应用中禁用快捷键） ----

    unsafe fn cf_key(name: &str) -> *const c_void {
        let c = CString::new(name).unwrap_or_default();
        CFStringCreateWithCString(std::ptr::null(), c.as_ptr(), 0x0800_0100) // kCFStringEncodingUTF8
    }

    unsafe fn dict_i32(dict: *const c_void, key_name: &str) -> Option<i32> {
        let key = cf_key(key_name);
        if key.is_null() {
            return None;
        }
        let v = CFDictionaryGetValue(dict, key);
        CFRelease(key);
        if v.is_null() {
            return None;
        }
        let mut out: i32 = 0;
        // kCFNumberSInt32Type = 3
        if CFNumberGetValue(v, 3, &mut out as *mut i32 as *mut c_void) {
            Some(out)
        } else {
            None
        }
    }

    unsafe fn dict_f64(dict: *const c_void, key_name: &str) -> Option<f64> {
        let key = cf_key(key_name);
        if key.is_null() {
            return None;
        }
        let v = CFDictionaryGetValue(dict, key);
        CFRelease(key);
        if v.is_null() {
            return None;
        }
        let mut out: f64 = 0.0;
        // kCFNumberDoubleType = 13
        if CFNumberGetValue(v, 13, &mut out as *mut f64 as *mut c_void) {
            Some(out)
        } else {
            None
        }
    }

    pub fn frontmost_app_fullscreen() -> bool {
        unsafe {
            let disp = CGDisplayBounds(CGMainDisplayID());
            // kCGWindowListOptionOnScreenOnly(1) | kCGWindowListExcludeDesktopElements(16)
            let arr = CGWindowListCopyWindowInfo(0x1 | 0x10, 0);
            if arr.is_null() {
                return false;
            }
            let mut result = false;
            let n = CFArrayGetCount(arr);
            for i in 0..n {
                let dict = CFArrayGetValueAtIndex(arr, i);
                if dict.is_null() {
                    continue;
                }
                if dict_i32(dict, "kCGWindowLayer") != Some(0) {
                    continue;
                }
                // 窗口列表按前后排序：第一个 layer 0 窗口即最前面的普通窗口
                let bounds_key = cf_key("kCGWindowBounds");
                if !bounds_key.is_null() {
                    let bounds = CFDictionaryGetValue(dict, bounds_key);
                    CFRelease(bounds_key);
                    if !bounds.is_null() {
                        let w = dict_f64(bounds, "Width").unwrap_or(0.0);
                        let h = dict_f64(bounds, "Height").unwrap_or(0.0);
                        result = w >= disp.size.width - 2.0 && h >= disp.size.height - 2.0;
                    }
                }
                break;
            }
            CFRelease(arr);
            result
        }
    }

    // ---- 双击监听（轮询鼠标左键状态，无需事件 tap） ----

    static DC_ENABLED: AtomicBool = AtomicBool::new(false);
    static DC_STARTED: AtomicBool = AtomicBool::new(false);

    pub fn set_double_click_enabled(on: bool) {
        DC_ENABLED.store(on, Ordering::SeqCst);
    }

    pub fn ensure_double_click_thread(app: tauri::AppHandle) {
        if DC_STARTED.swap(true, Ordering::SeqCst) {
            return;
        }
        std::thread::spawn(move || {
            let mut last_down: Option<(Instant, f64, f64)> = None;
            let mut was_down = false;
            loop {
                std::thread::sleep(Duration::from_millis(15));
                if !DC_ENABLED.load(Ordering::SeqCst) {
                    was_down = false;
                    last_down = None;
                    continue;
                }
                // kCGEventSourceStateHIDSystemState = 1, kCGMouseButtonLeft = 0
                let down = unsafe { CGEventSourceButtonState(1, 0) };
                if down && !was_down {
                    let (mx, my) = mouse_location();
                    let now = Instant::now();
                    let is_double = match last_down {
                        Some((t, lx, ly)) => {
                            now.duration_since(t) < Duration::from_millis(450)
                                && (mx - lx).abs() < 8.0
                                && (my - ly).abs() < 8.0
                        }
                        None => false,
                    };
                    if is_double {
                        last_down = None;
                        let app2 = app.clone();
                        std::thread::spawn(move || {
                            // 等双击选词在目标应用里生效后再触发取词
                            std::thread::sleep(Duration::from_millis(280));
                            if !DC_ENABLED.load(Ordering::SeqCst) {
                                return;
                            }
                            if super::fullscreen_guard() {
                                return;
                            }
                            super::emit_to_main(
                                &app2,
                                "translator-hotkey",
                                serde_json::json!({ "action": "selection" }),
                            );
                        });
                    } else {
                        last_down = Some((now, mx, my));
                    }
                }
                was_down = down;
            }
        });
    }

    // ---- 截图 + Vision OCR ----

    pub fn capture_and_ocr(x: f64, y: f64, w: f64, h: f64) -> Result<String, String> {
        let path = std::env::temp_dir().join(format!(
            "acm-translator-{}-{}.png",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let region = format!("{},{},{},{}", x as i64, y as i64, w as i64, h as i64);
        let out = Command::new("screencapture")
            .args(["-R", &region, "-x", "-t", "png"])
            .arg(&path)
            .output()
            .map_err(|e| format!("截图失败：{e}"))?;
        if !out.status.success() || !path.exists() {
            return Err("截图失败：请确认已授予录屏权限（系统设置 → 隐私与安全性 → 录屏与系统录音）".to_string());
        }
        let text = vision_ocr(&path);
        let _ = std::fs::remove_file(&path);
        text
    }

    fn vision_ocr(png_path: &std::path::Path) -> Result<String, String> {
        unsafe {
            let pool = objc_autoreleasePoolPush();
            let r = vision_ocr_inner(png_path);
            objc_autoreleasePoolPop(pool);
            r
        }
    }

    unsafe fn vision_ocr_inner(png_path: &std::path::Path) -> Result<String, String> {
        let path_str = png_path.to_string_lossy().into_owned();
        let data_cls = class("NSData");
        let req_cls = class("VNRecognizeTextRequest");
        let handler_cls = class("VNImageRequestHandler");
        let arr_cls = class("NSArray");
        if data_cls.is_null() || req_cls.is_null() || handler_cls.is_null() || arr_cls.is_null() {
            return Err("系统 Vision 框架不可用（需要 macOS 10.15 以上）".to_string());
        }
        let ns_path = ns_string(&path_str);
        let data = msg_id_id(data_cls, sel("dataWithContentsOfFile:"), ns_path);
        if data.is_null() {
            return Err("读取截图文件失败".to_string());
        }
        let req = msg_id(msg_id(req_cls, sel("alloc")), sel("init"));
        if req.is_null() {
            return Err("创建 OCR 请求失败".to_string());
        }
        // VNRecognitionLevelAccurate = 0
        msg_void_i64(req, sel("setRecognitionLevel:"), 0);
        msg_void_bool(req, sel("setUsesLanguageCorrection:"), true);
        // 只用系统真正支持的识别语言（不同 macOS 版本支持集不同），避免设入不支持的语种
        let langs = supported_languages(req_cls, arr_cls);
        if !langs.is_empty() {
            let ptrs: Vec<Id> = langs.iter().map(|s| ns_string(s)).collect();
            let lang_arr = msg_arr_objs(arr_cls, sel("arrayWithObjects:count:"), ptrs.as_ptr(), ptrs.len());
            if !lang_arr.is_null() {
                msg_void_id(req, sel("setRecognitionLanguages:"), lang_arr);
            }
        }
        let handler = msg_id_id_id(msg_id(handler_cls, sel("alloc")), sel("initWithData:options:"), data, std::ptr::null_mut());
        if handler.is_null() {
            msg_void(req, sel("release"));
            return Err("创建 OCR 处理器失败".to_string());
        }
        let req_arr = msg_id_id(arr_cls, sel("arrayWithObject:"), req);
        let mut err: Id = std::ptr::null_mut();
        let ok = msg_perform(handler, sel("performRequests:error:"), req_arr, &mut err);
        if !ok {
            let detail = if !err.is_null() {
                let desc = msg_id(err, sel("localizedDescription"));
                ns_utf8(desc).unwrap_or_default()
            } else {
                String::new()
            };
            msg_void(req, sel("release"));
            msg_void(handler, sel("release"));
            return Err(if detail.is_empty() {
                "本地 OCR 识别失败".to_string()
            } else {
                format!("本地 OCR 识别失败：{detail}")
            });
        }
        let results = msg_id(req, sel("results"));
        let mut lines: Vec<String> = Vec::new();
        if !results.is_null() {
            let n = msg_usize(results, sel("count"));
            for i in 0..n {
                let obs = msg_id_usize(results, sel("objectAtIndex:"), i);
                if obs.is_null() {
                    continue;
                }
                let cands = msg_id_usize(obs, sel("topCandidates:"), 1);
                if cands.is_null() || msg_usize(cands, sel("count")) == 0 {
                    continue;
                }
                let cand = msg_id_usize(cands, sel("objectAtIndex:"), 0);
                if cand.is_null() {
                    continue;
                }
                let s = msg_id(cand, sel("string"));
                if let Some(txt) = ns_utf8(s) {
                    if !txt.trim().is_empty() {
                        lines.push(txt);
                    }
                }
            }
        }
        msg_void(req, sel("release"));
        msg_void(handler, sel("release"));
        Ok(lines.join("\n"))
    }

    /// 问 VNRecognizeTextRequest 本人支持哪些语言（revision 2），与期望列表取交集。
    unsafe fn supported_languages(req_cls: Id, _arr_cls: Id) -> Vec<String> {
        let want = ["zh-Hans", "zh-Hant", "en-US"];
        let mut err: Id = std::ptr::null_mut();
        // +supportedRecognitionLanguagesForTextRequestRevision:error:（revision 2 = macOS 11+）
        let list = msg_supported_langs(req_cls, sel("supportedRecognitionLanguagesForTextRequestRevision:error:"), 2, &mut err);
        if list.is_null() {
            return vec!["en-US".to_string()];
        }
        let n = msg_usize(list, sel("count"));
        let mut have: Vec<String> = Vec::new();
        for i in 0..n {
            let s = msg_id_usize(list, sel("objectAtIndex:"), i);
            if let Some(t) = ns_utf8(s) {
                have.push(t);
            }
        }
        want.iter()
            .filter(|w| have.iter().any(|h| h == **w))
            .map(|w| w.to_string())
            .collect()
    }
}
