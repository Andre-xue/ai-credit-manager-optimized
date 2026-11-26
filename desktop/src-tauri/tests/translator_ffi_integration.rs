//! v0.1.462 集成测试：翻译助手「打开页面」路径上的 macOS 预检 FFI 逐个真跑。
//!
//! 背景：Ethan 实机在 AI 工坊点「翻译助手」卡，整个 App 瞬间退出；其他工具
//! 打开都正常。打开翻译页才会走的原生代码只有 translator_permissions 命令
//! （全 App 仅 TranslatorTool 调用，挂载即调、之后每 2.5 秒轮询）：
//! AXIsProcessTrusted、CGPreflightScreenCaptureAccess。无头 stub 验不到真
//! FFI（447 邮箱 TLS 总根源就是这么漏网的），本测试在 macOS runner 上以
//! 进程内调用逐个函数反复跑（CI 用 --test-threads=1 串行）：哪个函数段错误，
//! 测试进程就死在哪个测试上，输出里最后一个开始的测试名即元凶。
//!
//! v0.1.464：453 为诊断权限问题加的两个交叉核对（ax_trusted_opts /
//! screen_names_visible）已删除——Ethan 实机 diag.log（462 面包屑）钉死：
//! perm-open call=1 走完 step=ax、step=screen 后停在 step=ax-opts 一行进程
//! 即死、无 panic 行，死在 ax_trusted_opts() 内部（段错误），
//! screen_names_visible 根本没执行到。两探针非功能必需，整个摘除，其测试
//! 随之删除；本文件只守仍在生产路径上的 FFI。
#![cfg(target_os = "macos")]

use ai_credit_manager_lib::translator::{ffi_probe, permissions_snapshot};

const ROUNDS: usize = 60;

#[test]
fn t01_permissions_snapshot_repeated() {
    println!("t01 permissions_snapshot（命令本体：官方两读数 + diag 落盘）x{ROUNDS}");
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
fn t03_screen_preflight() {
    println!("t03 CGPreflightScreenCaptureAccess x{ROUNDS}");
    for _ in 0..ROUNDS {
        let _ = ffi_probe::screen();
    }
}

#[test]
fn t04_mouse_location() {
    println!("t04 CGEventCreate + CGEventGetLocation x{ROUNDS}");
    for _ in 0..ROUNDS {
        let _ = ffi_probe::mouse();
    }
}

#[test]
fn t05_frontmost_fullscreen() {
    println!("t05 CGDisplayBounds + CGWindowList 全屏判定 x{ROUNDS}");
    for _ in 0..ROUNDS {
        let _ = ffi_probe::frontmost_fullscreen();
    }
}
