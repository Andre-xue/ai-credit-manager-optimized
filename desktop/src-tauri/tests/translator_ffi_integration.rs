//! v0.1.462 集成测试：翻译助手「打开页面」路径上的 macOS 预检 FFI 逐个真跑。
//!
//! 背景：Ethan 实机在 AI 工坊点「翻译助手」卡，整个 App 瞬间退出；其他工具
//! 打开都正常。打开翻译页才会走的原生代码只有 translator_permissions 命令
//! （全 App 仅 TranslatorTool 调用，挂载即调、之后每 2.5 秒轮询）：
//! AXIsProcessTrusted、CGPreflightScreenCaptureAccess，加上 453 为诊断权限
//! 问题新加的两个交叉核对——ax_trusted_opts（objc_msgSend 拼
//! NSMutableDictionary 再调 AXIsProcessTrustedWithOptions）与
//! screen_names_visible（CGWindowListCopyWindowInfo + CF 数组/字典迭代 +
//! objc UTF8String）。这两个函数从未在真机被证实跑通过，无头 stub 又验不到
//! 真 FFI（447 邮箱 TLS 总根源就是这么漏网的）。
//!
//! 本测试在 macOS runner 上以进程内调用逐个函数反复跑（CI 用
//! --test-threads=1 串行）：哪个函数段错误，测试进程就死在哪个测试上，
//! 输出里最后一个开始的测试名即元凶；全绿则把这一批 FFI 在 runner 条件下
//! 排除。每个测试先 println 自己的名字，--nocapture 下肉眼可定位。
#![cfg(target_os = "macos")]

use ai_credit_manager_lib::translator::{ffi_probe, permissions_snapshot};

const ROUNDS: usize = 60;

#[test]
fn t01_permissions_snapshot_repeated() {
    println!("t01 permissions_snapshot（命令本体：四读数 + diag 落盘）x{ROUNDS}");
    for i in 0..ROUNDS {
        let p = permissions_snapshot();
        assert!(p.macos, "macOS runner 上 macos 应为 true");
        if i == 0 {
            println!(
                "t01 首轮读数 accessibility={} screen_capture={}",
                p.accessibility, p.screen_capture
            );
        }
    }
}

#[test]
fn t02_ax_trusted() {
    println!("t02 AXIsProcessTrusted x{ROUNDS}");
    for _ in 0..ROUNDS {
        let _ = ffi_probe::ax();
    }
}

#[test]
fn t03_ax_trusted_opts() {
    println!("t03 AXIsProcessTrustedWithOptions（objc NSMutableDictionary）x{ROUNDS}");
    for _ in 0..ROUNDS {
        let _ = ffi_probe::ax_opts();
    }
}

#[test]
fn t04_screen_preflight() {
    println!("t04 CGPreflightScreenCaptureAccess x{ROUNDS}");
    for _ in 0..ROUNDS {
        let _ = ffi_probe::screen();
    }
}

#[test]
fn t05_screen_names_visible() {
    println!("t05 CGWindowListCopyWindowInfo 窗口名探针（CF 迭代 + UTF8String）x{ROUNDS}");
    for _ in 0..ROUNDS {
        let _ = ffi_probe::names_visible();
    }
}

#[test]
fn t06_mouse_location() {
    println!("t06 CGEventCreate + CGEventGetLocation x{ROUNDS}");
    for _ in 0..ROUNDS {
        let _ = ffi_probe::mouse();
    }
}

#[test]
fn t07_frontmost_fullscreen() {
    println!("t07 CGDisplayBounds + CGWindowList 全屏判定 x{ROUNDS}");
    for _ in 0..ROUNDS {
        let _ = ffi_probe::frontmost_fullscreen();
    }
}
