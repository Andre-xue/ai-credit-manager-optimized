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

// ---------------- 本机诊断日志（v0.1.451） ----------------
// ~/.ai-credit-manager/translator/diag.log：每次快捷键触发、框选、截图、OCR
// 子进程的节点位与结果都记一行。全局快捷键/真机 OCR 无头验不了，Ethan 再
// 复现时靠这份日志定位断点。只记事件与长度/退出码，不记译文与原文内容。

fn diag_path() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(std::path::PathBuf::from(home).join(".ai-credit-manager").join("translator").join("diag.log"))
}

fn utc_stamp(secs: u64) -> String {
    // unix 秒 → UTC YYYY-MM-DD HH:MM:SS（civil-from-days 算法，无外部依赖）
    let days = (secs / 86_400) as i64;
    let tod = secs % 86_400;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}Z",
        year, m, d,
        tod / 3600, (tod % 3600) / 60, tod % 60
    )
}

fn unix_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn diag(event: &str, detail: &str) {
    let Some(path) = diag_path() else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let line = format!("{} {} {}\n", utc_stamp(secs), event, detail.replace('\n', " "));
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
    }
}

// ---------------- 共享状态 ----------------

struct HotkeyConfig {
    disable_fullscreen: bool,
}

static CONFIG: Mutex<HotkeyConfig> = Mutex::new(HotkeyConfig { disable_fullscreen: false });
static TRANSLATOR_SHORTCUTS: Mutex<Vec<Shortcut>> = Mutex::new(Vec::new());

// 权限查询诊断节流状态（v0.1.453；v0.1.464 起只剩官方两读数）：(ax, screen)
// 与上次落盘秒数。前端每 2.5 秒轮询一次权限命令，无节流会把 diag.log 刷爆；
// 状态变化必记、无变化最多每分钟一条。再带 current_exe 路径——运行的若不是
// /Applications 里的正本，一眼可见。
static LAST_PERM_DIAG: Mutex<Option<((bool, bool), u64)>> = Mutex::new(None);

// 权限命令调用计数（v0.1.462）：打开路径面包屑只详记前 5 次调用，避免 2.5 秒
// 轮询把 diag.log 刷爆；崩溃发生在第一次打开时，前 5 次足够定位。
static PERM_CALLS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 进程级 panic 落盘钩子（v0.1.462，lib.rs 的 run() 开头安装）：任何线程的
/// Rust panic 先把位置与消息写进本 diag.log，再链回默认钩子保持原行为。
/// 若「打开翻译助手闪退」源于某处 panic，下次看日志尾部的 panic 行即知断点。
/// 钩子内只做忽略错误的追加写（diag 本身从不 panic），消息截断 200 字。
pub fn install_diag_panic_hook() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let loc = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "?".to_string());
        let msg = if let Some(s) = info.payload().downcast_ref::<&str>() {
            s.to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "(no message)".to_string()
        };
        diag(
            "panic",
            &format!("at={loc} msg={}", msg.chars().take(200).collect::<String>()),
        );
        prev(info);
    }));
}

/// 前端面包屑落盘（v0.1.462）：翻译页挂载、首轮权限返回、快捷键下发结果等
/// 前端节点经此写进 diag.log，与 Rust 侧 perm-open / apply 步骤行拼成完整
/// 的打开路径时间线——再闪退，看日志最后几行就知道死在哪两步之间。
/// 只记节点名，内容清洗为单行并截断。
#[tauri::command]
pub fn translator_diag_note(note: String) {
    let clean: String = note
        .chars()
        .filter(|c| *c != '\n' && *c != '\r')
        .take(120)
        .collect();
    diag("fe-note", &clean);
}

fn diag_perm(ax: bool, screen: bool) {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let cur = (ax, screen);
    let should = {
        let Ok(mut guard) = LAST_PERM_DIAG.lock() else { return };
        let due = match *guard {
            None => true,
            Some((prev, last)) => prev != cur || secs.saturating_sub(last) >= 60,
        };
        if due {
            *guard = Some((cur, secs));
        }
        due
    };
    if should {
        let exe = std::env::current_exe()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| "?".to_string());
        diag(
            "perm-check",
            &format!("ax={ax} screen={screen} exe={exe}"),
        );
    }
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PopPayload {
    pub source: String,
    pub translated: String,
    #[serde(default)]
    pub target_lang: String,
    /// 识别出的源语言显示名（小窗语言行展示，如「英语」；v0.1.451 新增）
    #[serde(default)]
    pub source_lang: String,
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
    permissions_snapshot()
}

/// 权限预检实际执行体：命令本体与 CI 的 macOS FFI 集成测试共用同一份
/// （仿 447 mail_tls_integration 调生产函数的先例），保证被测的就是真机跑的。
#[doc(hidden)]
pub fn permissions_snapshot() -> TranslatorPermissions {
    #[cfg(target_os = "macos")]
    {
        // v0.1.462 打开路径面包屑：本命令全 App 只有翻译页会调（挂载即调），
        // 前 5 次调用逐步落盘（step 行写在每步 FFI 之前——崩在哪一步，日志就
        // 停在哪一步的前一行）。diag 是同步 write 系统调用，进程崩了也留得住。
        let call = PERM_CALLS.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        let trace = call <= 5;
        if trace {
            diag("perm-open", &format!("call={call} step=ax"));
        }
        let accessibility = mac::ax_trusted();
        if trace {
            diag("perm-open", &format!("call={call} step=screen ax={accessibility}"));
        }
        let screen_capture = mac::screen_ok();
        if trace {
            diag("perm-open", &format!("call={call} step=done screen={screen_capture}"));
        }
        // v0.1.464：453 的两个诊断探针（ax_trusted_opts / screen_names_visible）
        // 已整个摘除。定案证据是 Ethan 实机 diag.log（462 面包屑）：点开翻译页后
        // step=ax（false）、step=screen（false）都正常返回，日志停在
        // 「step=ax-opts」一行后进程即死、无 panic 行——死在紧随其后的
        // ax_trusted_opts()（objc_msgSend 拼 NSMutableDictionary 调
        // AXIsProcessTrustedWithOptions）内部，是 catch_unwind 拦不住的段错误；
        // screen_names_visible 根本没执行到。两个探针只是权限交叉核对、非功能
        // 必需，官方两 API 的读数已由日志证明在真机正常，权限判定只用它们。
        diag_perm(accessibility, screen_capture);
        TranslatorPermissions { macos: true, accessibility, screen_capture }
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
        // v0.1.465 请求路径面包屑：464 修完检查路径后，实机点「去开启」进程
        // 仍消失过一次；本命令进出成对落盘（同步写），begin 有 end 无即死在
        // 本命令内，end 里的 trusted 是系统当时的真实读数。
        diag("req-ax", "begin");
        let trusted = mac::ax_trusted_with_prompt();
        diag("req-ax", &format!("end trusted={trusted}"));
        trusted
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
        // v0.1.465：与 req-ax 同口径面包屑（本命令走纯 C 的
        // CGRequestScreenCaptureAccess，465 实机该路径已证明可用）。
        diag("req-screen", "begin");
        let granted = mac::screen_request();
        diag("req-screen", &format!("end granted={granted}"));
        granted
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

// ---------------- FFI 探针（v0.1.462，CI 集成测试专用） ----------------
// tests/translator_ffi_integration.rs 在 macOS runner 上逐个真跑这些预检类
// FFI（进程内调用）：哪个函数有段错误，测试进程就死在哪个测试上。背景：
// translator_permissions 是全 App 只有翻译页会调的命令，而无头 stub 验不到
// 真 FFI——本模块把生产函数拉出来逐个过堂。生产代码不走这里（命令走
// permissions_snapshot 与各命令本体），探针只做同一函数的转发。
// v0.1.464：453 的 ax_trusted_opts / screen_names_visible 两探针已被实机
// diag.log 钉死为闪退元凶并整个删除，本模块随之去掉对应转发。
#[doc(hidden)]
pub mod ffi_probe {
    /// AXIsProcessTrusted
    pub fn ax() -> bool {
        #[cfg(target_os = "macos")]
        {
            super::mac::ax_trusted()
        }
        #[cfg(not(target_os = "macos"))]
        {
            false
        }
    }

    /// CGPreflightScreenCaptureAccess
    pub fn screen() -> bool {
        #[cfg(target_os = "macos")]
        {
            super::mac::screen_ok()
        }
        #[cfg(not(target_os = "macos"))]
        {
            false
        }
    }

    /// v0.1.465：prompt 选项字典构造+释放（纯 CFDictionaryCreate，无弹窗、
    /// 不调 WithOptions）——旧手拼 msgSend 字典正是这一步在真机段错误
    pub fn ax_prompt_dict() -> bool {
        #[cfg(target_os = "macos")]
        {
            super::mac::ax_prompt_dict_roundtrip()
        }
        #[cfg(not(target_os = "macos"))]
        {
            false
        }
    }

    /// v0.1.465：「去开启」走的完整 prompt 请求路径（生产函数本体）。
    /// runner 上调用会把测试进程登记进辅助功能列表并触发系统提示（异步、
    /// 不阻塞调用），测试只断言不崩、返回值可读。
    pub fn ax_prompt() -> bool {
        #[cfg(target_os = "macos")]
        {
            super::mac::ax_trusted_with_prompt()
        }
        #[cfg(not(target_os = "macos"))]
        {
            false
        }
    }

    /// CGEventCreate + CGEventGetLocation
    pub fn mouse() -> (f64, f64) {
        #[cfg(target_os = "macos")]
        {
            super::mac::mouse_location()
        }
        #[cfg(not(target_os = "macos"))]
        {
            (0.0, 0.0)
        }
    }

    /// CGDisplayBounds + CGWindowList 前景窗口全屏判定
    pub fn frontmost_fullscreen() -> bool {
        #[cfg(target_os = "macos")]
        {
            super::mac::frontmost_app_fullscreen()
        }
        #[cfg(not(target_os = "macos"))]
        {
            false
        }
    }

    /// v0.1.468：Vision OCR 核心入口——与 --acm-ocr 子进程（run_ocr_cli）走的
    /// 是同一个生产函数（mac::vision_ocr_path），CI 集成测试 t08 用它对已知
    /// 文字 PNG 真跑 OCR，子进程与测试共用一份实现，不许测试里另写一份。
    pub fn ocr_png(path: &std::path::Path) -> Result<String, String> {
        #[cfg(target_os = "macos")]
        {
            super::mac::vision_ocr_path(path)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = path;
            Err("OCR 仅支持 macOS".to_string())
        }
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
    // v0.1.462 打开路径面包屑：本命令在启动（宿主）与打开翻译页（300ms 后）
    // 都会被调，begin/end 成对出现才算走完；缺 end 即死在本命令内部。
    diag(
        "apply-begin",
        &format!(
            "sel={} shot={} input={} dc={double_click}",
            selection.is_some(),
            screenshot.is_some(),
            input.is_some()
        ),
    );
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
    diag("apply-step", "unregistered-old");
    let mut registered: Vec<Shortcut> = Vec::new();
    let mut register = |raw: &Option<String>, kind: &'static str| -> Result<(), String> {
        let Some(v) = raw else { return Ok(()) };
        if v.trim().is_empty() {
            return Ok(());
        }
        // 不拼上游解析原文：muda 的英文报错含仓库链接，不给用户看（451 实机教训）
        let sc: Shortcut = v.parse().map_err(|_| {
            diag("shortcut-parse-fail", &format!("kind={kind} value={v}"));
            format!("「{v}」不是有效的快捷键组合，请重新录入")
        })?;
        let h = app.clone();
        let hv = v.clone();
        gs.on_shortcut(sc, move |_app, _s, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }
            diag("hotkey-fired", &format!("kind={kind} value={hv}"));
            if fullscreen_guard() {
                diag("hotkey-blocked", "fullscreen-guard");
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
        .map_err(|_| {
            diag("shortcut-register-fail", &format!("kind={kind} value={v}"));
            format!("快捷键「{v}」注册失败，可能已被其他应用占用，换个组合试试")
        })?;
        diag("shortcut-registered", &format!("kind={kind} value={v}"));
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
    diag("apply-end", if r.is_ok() { "ok" } else { "err" });
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
            Ok(text) => {
                diag("selection-ok", &format!("chars={}", text.chars().count()));
                SelectionOutcome { text: Some(text), error: None, x, y }
            }
            Err(e) => {
                diag("selection-fail", &e);
                SelectionOutcome { text: None, error: Some(e), x, y }
            }
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

/// 读剪贴板（小窗「粘贴并翻译」用）。
#[tauri::command]
pub fn translator_clipboard_read() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        mac::clipboard_read_pub().ok_or_else(|| "读取剪贴板失败".to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
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
    source_lang: Option<String>,
    error: Option<String>,
    ops: String,
    x: f64,
    y: f64,
) -> Result<(), String> {
    let payload = PopPayload {
        source,
        translated,
        target_lang,
        source_lang: source_lang.unwrap_or_default(),
        error,
        ops,
    };
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
    // v0.1.465 流水线面包屑：小窗已 show（错误与结果都记）——实机「松手后
    // 小窗不出现」时，日志有 pop-show 就是窗口层问题，没有就是死在更前面。
    diag("pop-show", &format!(
        "kind={} src-chars={} dst-chars={} at={x:.0},{y:.0}",
        if payload.error.is_some() { "error" } else { "result" },
        payload.source.chars().count(),
        payload.translated.chars().count(),
    ));
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

/// 小窗置顶开关（小窗图钉按钮）。
#[tauri::command]
pub fn translator_pop_set_on_top(app: AppHandle, on: bool) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(POP_LABEL) {
        w.set_always_on_top(on).map_err(|e| format!("设置小窗置顶失败：{e}"))?;
    }
    Ok(())
}

// ---------------- 截图框选 + OCR ----------------

/// 框选会话编号（v0.1.465）：每次 start_capture 自增，capture-start /
/// capture-cancel / capture-end 三行同号成对——实机「第二次 Esc 退不出」
/// 时看日志即知卡在第几会话、取消有没有到 Rust。
static CAPTURE_SESSION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 单会话约束状态（v0.1.465）：SESSION_ACTIVE = 框选层会话进行中（start 置
/// 位、cancel/finish 入口清位）；OCR_RUNNING + OCR_SINCE = 上一会话的 OCR
/// 子进程还在跑（finish 线程置位、线程结束清位）。两者任一成立时热键不开
/// 新会话（见 start_capture）。
static CAPTURE_SESSION_ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static OCR_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static OCR_SINCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn capture_session_now() -> u64 {
    CAPTURE_SESSION.load(std::sync::atomic::Ordering::SeqCst)
}

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
            diag("capture-blocked", "screen-permission-missing");
            // 先触发系统授权请求（应用会被登记进录屏列表），再把用户直达设置面板
            let _ = mac::screen_request();
            let _ = translator_open_settings("screen".to_string());
            return Err("需要录屏权限：已为你打开系统设置，在「录屏与系统录音」里给 AI 魔方打勾后重试".to_string());
        }
    }
    // v0.1.465 单会话约束：同一时刻只许一个捕获会话——框选层开着、或上一
    // 会话的 OCR 还在跑时，热键一律忽略并落 capture-busy（464 实机日志：
    // 首会话 OCR 25 秒未回期间热键又连开两次框选层，会话叠死、第二次起
    // Esc 失效）。忙标志残留（框选层已不可见、OCR 标记超过 45 秒未清）
    // 则自愈放行，不许把截图翻译永久锁死。
    {
        use std::sync::atomic::Ordering::SeqCst;
        let ocr_running = OCR_RUNNING.load(SeqCst);
        let ocr_stale = ocr_running && unix_secs().saturating_sub(OCR_SINCE.load(SeqCst)) > 45;
        if ocr_stale {
            OCR_RUNNING.store(false, SeqCst);
            diag("capture-busy", "ocr-stale-cleared");
        }
        let overlay_visible = app
            .get_webview_window(CAPTURE_LABEL)
            .and_then(|w| w.is_visible().ok())
            .unwrap_or(false);
        if overlay_visible || (ocr_running && !ocr_stale) {
            diag("capture-busy", &format!("n={} ignored", capture_session_now()));
            return Ok(());
        }
        if CAPTURE_SESSION_ACTIVE.swap(true, SeqCst) {
            diag("capture-busy", "stale-flag-cleared");
        }
    }
    let session = CAPTURE_SESSION.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    diag("capture-start", &format!("n={session}"));
    let w = match ensure_capture_window(app) {
        Ok(w) => w,
        Err(e) => {
            CAPTURE_SESSION_ACTIVE.store(false, std::sync::atomic::Ordering::SeqCst);
            return Err(e);
        }
    };
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
    // v0.1.465：框选层窗口是复用的（ensure 只建一次），前端组件跨会话不卸载、
    // 其 doneRef 在首会话结束后永不复位——465 实机第二次框选时 Esc 与松手
    // finish 全被 doneRef 早退吞掉、框选层关不掉只能杀进程。这里每会话发
    // begin 事件，前端据此复位全部会话状态并重启兜底自关计时。
    let _ = w.emit("translator-capture-begin", serde_json::json!({ "session": session }));
    diag("capture-shown", &format!("overlay-visible n={session}"));
    Ok(())
}

#[tauri::command]
pub fn translator_start_capture(app: AppHandle) -> Result<(), String> {
    start_capture(&app)
}

#[tauri::command]
pub fn translator_capture_cancel(app: AppHandle) {
    // v0.1.465 会话面包屑：与 capture-start 同号即取消命令真到了 Rust
    diag("capture-cancel", &format!("n={}", capture_session_now()));
    CAPTURE_SESSION_ACTIVE.store(false, std::sync::atomic::Ordering::SeqCst);
    if let Some(w) = app.get_webview_window(CAPTURE_LABEL) {
        let _ = w.hide();
    }
}

/// 框选完成：收起框选层 → screencapture 截取选区（逻辑点）→ 子进程 Vision OCR →
/// 结果以 translator-shot-text 事件发给主窗口宿主继续翻译；失败发 translator-error。
///
/// v0.1.451：OCR 不再在主进程里跑。440 的 Vision FFI（libobjc msgSend 直调）实机
/// 在松手后把整个 App 带崩（段错误 catch_unwind 也拦不住）。现在截图仍在本进程
/// （screencapture 本身是外部命令），OCR 改为以当前 exe 的 --acm-ocr 隐藏模式
/// 自启子进程执行：子进程崩了只回一个非零退出码，主 App 弹「识别失败」小窗、
/// 不受影响。整段再套 catch_unwind，普通 panic 也只变错误提示。
#[tauri::command]
pub fn translator_capture_finish(app: AppHandle, x: f64, y: f64, w: f64, h: f64) {
    // v0.1.465 会话面包屑：松手 finish 真到了 Rust 才会有这行；会话到此结束、
    // 接力的是 OCR 进行中标记（线程结束清位），期间热键仍被单会话约束拦下
    diag("capture-end", &format!("n={}", capture_session_now()));
    CAPTURE_SESSION_ACTIVE.store(false, std::sync::atomic::Ordering::SeqCst);
    OCR_RUNNING.store(true, std::sync::atomic::Ordering::SeqCst);
    OCR_SINCE.store(unix_secs(), std::sync::atomic::Ordering::SeqCst);
    if let Some(win) = app.get_webview_window(CAPTURE_LABEL) {
        let _ = win.hide();
    }
    let cx = x + w / 2.0;
    let bottom = y + h;
    diag("capture-finish", &format!("rect={x:.0},{y:.0} {w:.0}x{h:.0}"));
    std::thread::spawn(move || {
        let app2 = app.clone();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<String, String> {
            #[cfg(target_os = "macos")]
            let out = {
                let png = mac::capture_shot(x, y, w, h)?;
                // v0.1.465 流水线面包屑：截图落盘与 OCR 启动分开记——「松手后
                // 没下文」时看缺哪一行就知道死在截图还是识别
                let bytes = std::fs::metadata(&png).map(|m| m.len()).unwrap_or(0);
                diag("capture-done", &format!("png-bytes={bytes}"));
                diag("ocr-start", "subprocess");
                let text = ocr_via_subprocess(&png);
                let _ = std::fs::remove_file(&png);
                text
            };
            #[cfg(not(target_os = "macos"))]
            let out = Err("截图翻译仅支持 macOS 桌面端".to_string());
            out
        }));
        match result {
            Ok(Ok(text)) if !text.trim().is_empty() => {
                diag("ocr-ok", &format!("chars={}", text.chars().count()));
                emit_to_main(&app2, "translator-shot-text", serde_json::json!({ "text": text, "x": cx, "y": bottom }));
            }
            Ok(Ok(_)) => {
                diag("ocr-empty", "no-text");
                emit_to_main(&app2, "translator-error", serde_json::json!({
                    "message": "框选区域里没有识别到文字，换个区域试试", "x": cx, "y": bottom
                }));
            }
            Ok(Err(e)) => {
                diag("ocr-fail", &e);
                emit_to_main(&app2, "translator-error", serde_json::json!({ "message": e, "x": cx, "y": bottom }));
            }
            Err(_) => {
                diag("ocr-fail", "panic-caught");
                emit_to_main(&app2, "translator-error", serde_json::json!({
                    "message": "截图识别出了问题（内部错误已拦下），再试一次；反复出现请把诊断日志发给开发者", "x": cx, "y": bottom
                }));
            }
        }
        // v0.1.465：OCR 接力结束，清进行中标记（单会话约束据此放行新会话）
        OCR_RUNNING.store(false, std::sync::atomic::Ordering::SeqCst);
        OCR_SINCE.store(0, std::sync::atomic::Ordering::SeqCst);
    });
}

/// 以当前 exe 自启 OCR 子进程（--acm-ocr 隐藏模式，见 main.rs 的拦截）：
/// 30 秒超时强杀（v0.1.465 起，旧为 25 秒）；子进程崩溃/非零退出只变成 Err，绝不影响主进程。
fn ocr_via_subprocess(png: &std::path::Path) -> Result<String, String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    let exe = std::env::current_exe().map_err(|e| format!("识别失败：找不到程序本体（{e}）"))?;
    diag("ocr-spawn", &format!("exe={}", exe.display()));
    let mut child = Command::new(&exe)
        .arg("--acm-ocr")
        .arg("--image")
        .arg(png)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("识别失败：无法启动识别子进程（{e}）"))?;
    // stdout/stderr 各开一个线程读完，避免管道写满把子进程堵死
    let mut out_pipe = child.stdout.take();
    let out_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(p) = out_pipe.as_mut() {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    });
    let mut err_pipe = child.stderr.take();
    let err_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(p) = err_pipe.as_mut() {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    });
    // v0.1.465：时限 25→30 秒（给 Vision 冷启动留量），且超时文案只许写真实
    // 原因——464 实机 97×36 的小选区也挂满超时，旧文案甩锅「区域太大」是误导
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => {
                if std::time::Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    diag("ocr-fail", "subprocess-timeout-30s");
                    return Err("识别超时：本地识别进程 30 秒内没有返回结果，请重试；反复出现请把诊断日志发给开发者".to_string());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("识别失败：等待子进程出错（{e}）")),
        }
    };
    let out = out_thread.join().unwrap_or_default();
    let errb = err_thread.join().unwrap_or_default();
    if status.success() {
        Ok(String::from_utf8_lossy(&out).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&errb).trim().to_string();
        let code = status.code().map(|c| c.to_string()).unwrap_or_else(|| "信号终止".to_string());
        diag("ocr-fail", &format!("exit={code} stderr={}", stderr.chars().take(200).collect::<String>()));
        Err(if stderr.is_empty() {
            format!("本地 OCR 识别失败（识别进程异常退出，码 {code}），再试一次")
        } else {
            format!("本地 OCR 识别失败：{}", stderr.chars().take(120).collect::<String>())
        })
    }
}

/// OCR 子进程入口（main.rs 在 Tauri builder 之前拦截 --acm-ocr 走这里）：
/// 对 --image 指定的 PNG 跑 Vision OCR，识别文本写 stdout，错误写 stderr。
/// 返回进程退出码：0 成功，1 识别失败，2 参数/平台问题。
/// v0.1.465 子进程面包屑：父进程只看得到 spawn 与超时，子进程内部三行
/// （ocr-child-start / ocr-child-ocr-done / ocr-child-exit）把下次超时拆开
/// 定性——没有 start = 死在进程启动/拦截之前；有 start 没 ocr-done = 卡在
/// Vision 调用内；有 ocr-done 没 exit = 卡在回传/退出。464 实机子进程挂满
/// 25 秒被强杀时，这三行一行都没有（旧版子进程不写日志），无从定性。
pub fn run_ocr_cli(args: &[String]) -> i32 {
    diag("ocr-child-start", &format!("args={}", args.len()));
    let code = run_ocr_cli_inner(args);
    diag("ocr-child-exit", &format!("code={code}"));
    code
}

fn run_ocr_cli_inner(args: &[String]) -> i32 {
    let mut image: Option<String> = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "--image" {
            image = it.next().cloned();
        }
    }
    let Some(image) = image else {
        eprintln!("缺少 --image 参数");
        return 2;
    };
    let _ = &image; // 非 macOS 分支不用它，消 unused 警告
    #[cfg(target_os = "macos")]
    {
        match mac::vision_ocr_path(std::path::Path::new(&image)) {
            Ok(text) => {
                diag("ocr-child-ocr-done", &format!("chars={}", text.chars().count()));
                use std::io::Write;
                let _ = std::io::stdout().write_all(text.as_bytes());
                0
            }
            Err(e) => {
                diag("ocr-child-ocr-done", &format!("err={}", e.chars().take(120).collect::<String>()));
                eprintln!("{e}");
                1
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        eprintln!("OCR 仅支持 macOS");
        2
    }
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
        // kAXTrustedCheckOptionPrompt：官方导出的 CFStringRef 常量（选项字典的
        // key），v0.1.465 起正规声明取用，不再用 NSString 手拼同名串。
        static kAXTrustedCheckOptionPrompt: *const c_void;
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

    // CFDictionaryCreate 的回调结构体：本模块只取官方常量
    // kCFTypeDictionaryKeyCallBacks / kCFTypeDictionaryValueCallBacks 的地址
    // 传给 CFDictionaryCreate，从不按值读写，字段布局按官方头文件声明即可。
    #[repr(C)]
    struct CfDictKeyCallbacks {
        version: isize,
        retain: *const c_void,
        release: *const c_void,
        copy_description: *const c_void,
        equal: *const c_void,
        hash: *const c_void,
    }
    #[repr(C)]
    struct CfDictValueCallbacks {
        version: isize,
        retain: *const c_void,
        release: *const c_void,
        copy_description: *const c_void,
        equal: *const c_void,
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: *const c_void);
        fn CFArrayGetCount(arr: *const c_void) -> isize;
        fn CFArrayGetValueAtIndex(arr: *const c_void, idx: isize) -> *const c_void;
        fn CFDictionaryGetValue(dict: *const c_void, key: *const c_void) -> *const c_void;
        fn CFNumberGetValue(num: *const c_void, the_type: i32, value_ptr: *mut c_void) -> bool;
        fn CFStringCreateWithCString(alloc: *const c_void, c_str: *const c_char, encoding: u32) -> *const c_void;
        // v0.1.465：prompt 选项字典改走正规 CF 接口构造（见 ax_prompt_options_dict）
        fn CFDictionaryCreate(
            allocator: *const c_void,
            keys: *const *const c_void,
            values: *const *const c_void,
            num_values: isize,
            key_callbacks: *const c_void,
            value_callbacks: *const c_void,
        ) -> *const c_void;
        static kCFBooleanTrue: *const c_void;
        static kCFTypeDictionaryKeyCallBacks: CfDictKeyCallbacks;
        static kCFTypeDictionaryValueCallBacks: CfDictValueCallbacks;
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

    /// 构造 prompt 选项字典 { kAXTrustedCheckOptionPrompt: kCFBooleanTrue }。
    /// v0.1.465 改法：全程正规 CoreFoundation C 接口——CFDictionaryCreate +
    /// 官方导出的 key 常量（kAXTrustedCheckOptionPrompt）、值常量
    /// （kCFBooleanTrue）与回调结构体（kCFTypeDictionary*CallBacks），零
    /// objc_msgSend 手拼。背景：旧实现用 transmuted msgSend 拼
    /// NSMutableDictionary，与 453 探针 ax_trusted_opts 同构，而后者已被实机
    /// diag.log + 代码坐实在 Ethan 机器上段错误（464 摘除）；465 实机点
    /// 「去开启」走的正是本函数，进程又消失一次——同构嫌疑面整体移除，不再
    /// 在请求路径上留任何手拼字典构造。返回 +1 引用，调用方用完 CFRelease；
    /// 构造失败返回 null。单独成函数是为 CI 集成测试把「构造+释放」与
    /// 「真调 prompt」分开反复验证（构造正是旧实现出事的那一步）。
    pub fn ax_prompt_options_dict() -> *const c_void {
        unsafe {
            let keys: [*const c_void; 1] = [kAXTrustedCheckOptionPrompt];
            let values: [*const c_void; 1] = [kCFBooleanTrue];
            if keys[0].is_null() || values[0].is_null() {
                return std::ptr::null();
            }
            CFDictionaryCreate(
                std::ptr::null(),
                keys.as_ptr(),
                values.as_ptr(),
                1,
                &kCFTypeDictionaryKeyCallBacks as *const _ as *const c_void,
                &kCFTypeDictionaryValueCallBacks as *const _ as *const c_void,
            )
        }
    }

    /// CI 探针用：构造 prompt 选项字典并立刻释放，返回是否构造成功。
    pub fn ax_prompt_dict_roundtrip() -> bool {
        let dict = ax_prompt_options_dict();
        if dict.is_null() {
            return false;
        }
        unsafe { CFRelease(dict) };
        true
    }

    pub fn ax_trusted_with_prompt() -> bool {
        unsafe {
            let dict = ax_prompt_options_dict();
            if dict.is_null() {
                return AXIsProcessTrusted();
            }
            let trusted = AXIsProcessTrustedWithOptions(dict);
            CFRelease(dict);
            trusted
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
            super::diag("dc-thread-start", "polling-loop-entered");
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

    pub fn clipboard_read_pub() -> Option<String> {
        clipboard_read()
    }

    // ---- 截图 + Vision OCR ----
    // v0.1.451 起两者分工：capture_shot 只负责截图（留在主进程，screencapture 是
    // 外部命令）；vision_ocr_path 只在 --acm-ocr 子进程里被调用（见 run_ocr_cli），
    // 主进程不再碰 Vision FFI——440 实机它曾把主进程带崩。

    pub fn capture_shot(x: f64, y: f64, w: f64, h: f64) -> Result<std::path::PathBuf, String> {
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
        Ok(path)
    }

    pub fn vision_ocr_path(png_path: &std::path::Path) -> Result<String, String> {
        vision_ocr(png_path)
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
        // 老系统上该类方法不存在时直接调会抛 NSException 让进程 abort：
        // 先问 respondsToSelector:，没有就返回空（调用方据此不设语言、用系统默认集）
        let target = sel("supportedRecognitionLanguagesForTextRequestRevision:error:");
        let responds: extern "C" fn(Id, Sel, Sel) -> bool = std::mem::transmute(objc_msgSend as usize);
        if !responds(req_cls, sel("respondsToSelector:"), target) {
            return Vec::new();
        }
        let mut err: Id = std::ptr::null_mut();
        // +supportedRecognitionLanguagesForTextRequestRevision:error:（revision 2 = macOS 11+）
        let list = msg_supported_langs(req_cls, target, 2, &mut err);
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
