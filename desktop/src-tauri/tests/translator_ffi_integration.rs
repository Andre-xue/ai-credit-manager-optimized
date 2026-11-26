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
//!
//! v0.1.465：「去开启」走的请求路径 ax_trusted_with_prompt 旧实现与出事探针
//! 同构（transmuted objc_msgSend 手拼 NSMutableDictionary），464 实机点
//! 「去开启」后进程又消失一次。本版改为纯 CFDictionaryCreate 正规构造，
//! 新增 t06（构造+释放反复跑——旧实现正是死在这一步）与 t07（完整 prompt
//! 路径真跑；会把测试进程登记进 runner 的辅助功能列表并触发异步系统
//! 提示，不阻塞调用，只断言不崩、返回值可读）。
//!
//! v0.1.468：新增 t08——截图翻译的 Vision OCR 真跑（见 t08 注释）。
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

#[test]
fn t06_ax_prompt_dict_roundtrip() {
    println!("t06 CFDictionaryCreate prompt 选项字典构造+释放 x{ROUNDS}");
    for _ in 0..ROUNDS {
        assert!(
            ffi_probe::ax_prompt_dict(),
            "prompt 选项字典构造应成功（官方常量 + CFDictionaryCreate）"
        );
    }
}

/// v0.1.468：截图翻译 OCR 子进程卡死的真跑复现/验收测试。
///
/// 背景：Ethan 实机（464 的 25s、465 的 30s 两次）截图翻译的子进程写完
/// ocr-child-start 后再无下文，父进程超时强杀——这台路径上 Vision OCR
/// 从未成功过一次。旧实现把解码（NSData initWithData）、语言查询
/// （supportedRecognitionLanguages 类方法）与 perform 全压在子进程主线程
/// 的一串手拼 objc_msgSend 里，无从分段。本测试用 CoreGraphics 画一张
/// 已知文字（HELLO 12345）的 PNG，调与子进程完全相同的生产入口
/// （ffi_probe::ocr_png → mac::vision_ocr_path），带 25 秒超时守卫：
/// 旧实现若在 runner 上同样卡死，本测试以「超时未返回」明确失败（复现）；
/// 新实现必须在超时内返回且识别出已知文字（验收）。
#[test]
fn t08_vision_ocr_known_text() {
    println!("t08 Vision OCR 真跑：CoreGraphics 画 HELLO 12345 → 生产 OCR 入口（25s 守卫）");
    let png = draw::make_text_png("HELLO 12345").expect("生成测试 PNG 失败");
    let (tx, rx) = std::sync::mpsc::channel();
    let p2 = png.clone();
    std::thread::spawn(move || {
        let _ = tx.send(ffi_probe::ocr_png(&p2));
    });
    match rx.recv_timeout(std::time::Duration::from_secs(25)) {
        Ok(Ok(text)) => {
            println!("t08 识别结果: {text:?}");
            let flat: String = text.chars().filter(|c| !c.is_whitespace()).collect();
            assert!(flat.contains("HELLO"), "识别文本应包含 HELLO，实际: {text:?}");
            assert!(flat.contains("12345"), "识别文本应包含 12345，实际: {text:?}");
            println!("t08 通过：识别文本包含 HELLO 与 12345");
        }
        Ok(Err(e)) => panic!("t08 OCR 返回错误: {e}"),
        Err(_) => panic!("t08 OCR 25 秒未返回——子进程卡死在 runner 上复现（v0.1.468 根因）"),
    }
}

/// 用纯 C 接口画一张白底黑字 PNG，供 t08 使用：CoreGraphics 位图上下文
/// + CoreText 排字（CTLineDraw）+ ImageIO 写 PNG。
/// 注意不能用 CGContextSelectFont + CGContextShowTextAtPoint 画这张图：
/// 那套 Quartz 文本 API 按字形索引解释字节，画出的字形与字符码位整体
/// 偏移——首跑 runner 上 HELLO 12345 被画成了另一串字形，OCR 如实读出
/// 乱码，一度误判为 OCR 本身的问题。画图只是测试夹具；被测的 OCR 走
/// 生产入口，不在这里另写一份。
mod draw {
    use std::ffi::{c_char, c_void, CString};

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGPointF {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGSizeF {
        width: f64,
        height: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGRectF {
        origin: CGPointF,
        size: CGSizeF,
    }
    // 只取地址传给 CFDictionaryCreate，从不按值读写（与 translator.rs 同款声明）
    #[repr(C)]
    struct DictKeyCallbacks {
        version: isize,
        retain: *const c_void,
        release: *const c_void,
        copy_description: *const c_void,
        equal: *const c_void,
        hash: *const c_void,
    }
    #[repr(C)]
    struct DictValueCallbacks {
        version: isize,
        retain: *const c_void,
        release: *const c_void,
        copy_description: *const c_void,
        equal: *const c_void,
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(alloc: *const c_void, s: *const c_char, encoding: u32) -> *const c_void;
        fn CFURLCreateWithFileSystemPath(alloc: *const c_void, path: *const c_void, style: i32, is_dir: bool) -> *const c_void;
        fn CFAttributedStringCreate(alloc: *const c_void, string: *const c_void, attributes: *const c_void) -> *const c_void;
        fn CFDictionaryCreate(
            alloc: *const c_void,
            keys: *const *const c_void,
            values: *const *const c_void,
            num_values: isize,
            key_callbacks: *const c_void,
            value_callbacks: *const c_void,
        ) -> *const c_void;
        fn CFRelease(cf: *const c_void);
        static kCFTypeDictionaryKeyCallBacks: DictKeyCallbacks;
        static kCFTypeDictionaryValueCallBacks: DictValueCallbacks;
    }

    #[link(name = "CoreText", kind = "framework")]
    extern "C" {
        fn CTFontCreateWithName(name: *const c_void, size: f64, matrix: *const c_void) -> *mut c_void;
        fn CTLineCreateWithAttributedString(attr_string: *const c_void) -> *mut c_void;
        fn CTLineDraw(line: *mut c_void, ctx: *mut c_void);
        static kCTFontAttributeName: *const c_void;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGColorSpaceCreateDeviceRGB() -> *mut c_void;
        fn CGColorSpaceRelease(space: *mut c_void);
        fn CGBitmapContextCreate(
            data: *mut c_void,
            width: usize,
            height: usize,
            bits_per_component: usize,
            bytes_per_row: usize,
            space: *mut c_void,
            bitmap_info: u32,
        ) -> *mut c_void;
        fn CGBitmapContextCreateImage(ctx: *mut c_void) -> *mut c_void;
        fn CGContextRelease(ctx: *mut c_void);
        fn CGContextSetRGBFillColor(ctx: *mut c_void, r: f64, g: f64, b: f64, a: f64);
        fn CGContextFillRect(ctx: *mut c_void, rect: CGRectF);
        fn CGContextSetTextPosition(ctx: *mut c_void, x: f64, y: f64);
        fn CGImageRelease(img: *mut c_void);
    }

    #[link(name = "ImageIO", kind = "framework")]
    extern "C" {
        fn CGImageDestinationCreateWithURL(url: *const c_void, ty: *const c_void, count: usize, options: *const c_void) -> *mut c_void;
        fn CGImageDestinationAddImage(dest: *mut c_void, img: *mut c_void, options: *const c_void);
        fn CGImageDestinationFinalize(dest: *mut c_void) -> bool;
    }

    const KCF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
    const KCG_IMAGE_ALPHA_PREMULTIPLIED_LAST: u32 = 1;

    pub fn make_text_png(text: &str) -> Result<std::path::PathBuf, String> {
        let path = std::env::temp_dir().join("acm-t08-ocr-test.png");
        unsafe {
            let (w, h) = (1200usize, 300usize);
            let space = CGColorSpaceCreateDeviceRGB();
            if space.is_null() {
                return Err("CGColorSpaceCreateDeviceRGB 失败".into());
            }
            let ctx = CGBitmapContextCreate(
                std::ptr::null_mut(),
                w,
                h,
                8,
                0,
                space,
                KCG_IMAGE_ALPHA_PREMULTIPLIED_LAST,
            );
            if ctx.is_null() {
                CGColorSpaceRelease(space);
                return Err("CGBitmapContextCreate 失败".into());
            }
            // 白底
            CGContextSetRGBFillColor(ctx, 1.0, 1.0, 1.0, 1.0);
            CGContextFillRect(
                ctx,
                CGRectF {
                    origin: CGPointF { x: 0.0, y: 0.0 },
                    size: CGSizeF { width: w as f64, height: h as f64 },
                },
            );
            // 黑字：CoreText 排字（位图上下文坐标原点在左下，y 为基线）
            CGContextSetRGBFillColor(ctx, 0.0, 0.0, 0.0, 1.0);
            let text_c = CString::new(text).unwrap();
            let cf_text = CFStringCreateWithCString(std::ptr::null(), text_c.as_ptr(), KCF_STRING_ENCODING_UTF8);
            let font_name_c = CString::new("Helvetica-Bold").unwrap();
            let cf_font_name = CFStringCreateWithCString(std::ptr::null(), font_name_c.as_ptr(), KCF_STRING_ENCODING_UTF8);
            let font = CTFontCreateWithName(cf_font_name, 130.0, std::ptr::null());
            if font.is_null() {
                CFRelease(cf_text);
                CFRelease(cf_font_name);
                CGContextRelease(ctx);
                CGColorSpaceRelease(space);
                return Err("CTFontCreateWithName 失败".into());
            }
            let keys: [*const c_void; 1] = [kCTFontAttributeName];
            let values: [*const c_void; 1] = [font as *const c_void];
            let attrs = CFDictionaryCreate(
                std::ptr::null(),
                keys.as_ptr(),
                values.as_ptr(),
                1,
                &kCFTypeDictionaryKeyCallBacks as *const _ as *const c_void,
                &kCFTypeDictionaryValueCallBacks as *const _ as *const c_void,
            );
            let attr_str = CFAttributedStringCreate(std::ptr::null(), cf_text, attrs);
            let line = CTLineCreateWithAttributedString(attr_str);
            if line.is_null() {
                CFRelease(attr_str);
                CFRelease(attrs);
                CFRelease(font as *const c_void);
                CFRelease(cf_text);
                CFRelease(cf_font_name);
                CGContextRelease(ctx);
                CGColorSpaceRelease(space);
                return Err("CTLineCreateWithAttributedString 失败".into());
            }
            CGContextSetTextPosition(ctx, 40.0, 95.0);
            CTLineDraw(line, ctx);
            CFRelease(line as *const c_void);
            CFRelease(attr_str);
            CFRelease(attrs);
            CFRelease(font as *const c_void);
            CFRelease(cf_text);
            CFRelease(cf_font_name);
            let img = CGBitmapContextCreateImage(ctx);
            CGContextRelease(ctx);
            CGColorSpaceRelease(space);
            if img.is_null() {
                return Err("CGBitmapContextCreateImage 失败".into());
            }
            // 写 PNG（ImageIO；类型标识直接用 UTI 字符串 public.png）
            let path_c = CString::new(path.to_string_lossy().into_owned()).unwrap();
            let cf_path = CFStringCreateWithCString(std::ptr::null(), path_c.as_ptr(), KCF_STRING_ENCODING_UTF8);
            let url = CFURLCreateWithFileSystemPath(std::ptr::null(), cf_path, 0, false);
            let uti_c = CString::new("public.png").unwrap();
            let uti = CFStringCreateWithCString(std::ptr::null(), uti_c.as_ptr(), KCF_STRING_ENCODING_UTF8);
            let dest = CGImageDestinationCreateWithURL(url, uti, 1, std::ptr::null());
            if dest.is_null() {
                CGImageRelease(img);
                return Err("CGImageDestinationCreateWithURL 失败".into());
            }
            CGImageDestinationAddImage(dest, img, std::ptr::null());
            let ok = CGImageDestinationFinalize(dest);
            CFRelease(dest as *const c_void);
            CFRelease(url);
            CFRelease(cf_path);
            CFRelease(uti);
            CGImageRelease(img);
            if !ok {
                return Err("CGImageDestinationFinalize 失败".into());
            }
        }
        Ok(path)
    }
}

#[test]
fn t07_ax_trusted_with_prompt() {
    // 完整 prompt 路径只跑少量轮：每轮都可能触发系统异步提示，没必要刷 60 次；
    // 构造本身的反复验证在 t06。runner 上未授权是常态，返回值应为 false，
    // 但只断言「调用返回了」（授权状态不是本测试能控制的变量）。
    const PROMPT_ROUNDS: usize = 10;
    println!("t07 AXIsProcessTrustedWithOptions(prompt) 完整路径 x{PROMPT_ROUNDS}");
    for i in 0..PROMPT_ROUNDS {
        let trusted = ffi_probe::ax_prompt();
        if i == 0 {
            println!("t07 首轮读数 trusted={trusted}");
        }
    }
}
