#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 翻译助手 OCR 子进程模式（v0.1.451）：主进程截图后以 `--acm-ocr --image <png>`
    // 自启本 exe 做 Vision OCR，必须赶在 Tauri builder 之前处理完、输出结果后退出。
    // 隔离的原因：440 的 Vision FFI 在主进程里实机带崩过整个 App；子进程崩了
    // 主进程只收到非零退出码，弹错误小窗即可（见 translator::ocr_via_subprocess）。
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--acm-ocr") {
        std::process::exit(ai_credit_manager_lib::translator::run_ocr_cli(&args));
    }
    ai_credit_manager_lib::run()
}
