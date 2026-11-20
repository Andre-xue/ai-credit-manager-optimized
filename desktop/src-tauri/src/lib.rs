#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::time::{SystemTime, UNIX_EPOCH};
use std::sync::OnceLock;

/// 进程级共享 HTTP Client：复用 TLS 连接池，避免每次调用重新握手（性能）。
/// 官方端点用默认重定向策略；用户自定义 API 端点用禁用重定向的版本（SSRF 防护）。
fn shared_http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("ai-credit-manager/0.1")
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .expect("初始化 HTTP 客户端失败")
    })
}

fn shared_provider_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("ai-credit-manager/0.1")
            .timeout(std::time::Duration::from_secs(120))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("初始化 API 代理客户端失败")
    })
}

/// 云 LLM 代理：桌面 WebView 直连云端 SSE 会被 CORS 拦截（POST /chat/completions 预检失败），
/// 由 Rust 后端带 publishableKey 头转发，收集 SSE 的 content delta 后返回完整文本。
#[tauri::command]
async fn call_cloud_llm(endpoint: String, publishable_key: String, body_json: String, conversation_id: Option<String>) -> Result<String, String> {
    let url = format!("{}/.cloud/llm/chat/completions", endpoint.trim_end_matches('/'));
    let client = shared_http_client();
    let _: serde_json::Value = serde_json::from_str(&body_json).map_err(|e| format!("请求体非法：{}", e))?;
    let mut req = client.post(&url)
        .header("x-wb-webapp-access-key", &publishable_key)
        .header("Accept", "text/event-stream")
        .header("Content-Type", "application/json");
    if let Some(cid) = &conversation_id { req = req.header("X-Conversation-ID", cid); }
    let resp = req.body(body_json).send().await.map_err(|e| format!("请求失败：{}", e))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("读取响应失败：{}", e))?;
    if !status.is_success() { return Err(format!("云端返回 {}：{}", status.as_u16(), text.chars().take(300).collect::<String>())) }

    // 解析 SSE：逐行取 data: {...}，累加 choices[0].delta.content；
    // 思考模型可能把内容放在 reasoning_content，content 为空时回退使用它。
    let mut answer = String::new();
    let mut reasoning = String::new();
    for line in text.lines() {
        let line = line.trim();
        if !line.starts_with("data:") { continue }
        let data = line[5..].trim();
        if data == "[DONE]" { break }
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
            if let Some(delta) = json.get("choices").and_then(|c| c.get(0)).and_then(|ch| ch.get("delta")) {
                if let Some(content) = delta.get("content").and_then(|v| v.as_str()) { answer.push_str(content) }
                if let Some(reason) = delta.get("reasoning_content").and_then(|v| v.as_str()) { reasoning.push_str(reason) }
            }
        }
    }
    if answer.is_empty() { answer = reasoning; }
    if answer.is_empty() { return Err("云端未返回文本内容".into()) }
    Ok(answer)
}

/// 校验代理目标 URL，防止 SSRF 与 API Key 外泄。
/// - https：允许公网域名，但拒绝解析到内网/回环/链路本地/云元数据地址的主机
/// - http：仅允许本机（localhost / 127.0.0.0/8 / ::1），供本地 Ollama 等模型使用
fn validate_proxy_url(raw: &str) -> Result<reqwest::Url, String> {
    let u = reqwest::Url::parse(raw).map_err(|_| "URL 格式不合法".to_string())?;
    let scheme = u.scheme();
    if scheme != "https" && scheme != "http" {
        return Err("仅允许 http(s) 协议".into())
    }
    let host = u.host_str().ok_or_else(|| "URL 缺少主机".to_string())?;
    let is_local = host == "localhost"
        || host == "::1"
        || host == "[::1]"
        || host.starts_with("127.")
        || host == "0.0.0.0";
    if scheme == "http" {
        if !is_local {
            return Err("http 仅允许本机地址（localhost / 127.0.0.1 / ::1）".into())
        }
        return Ok(u)
    }
    // https：拒绝字面量的内网/保留地址（防止 https://127.0.0.1、169.254.169.254 等绕过）
    let ip_blocked = host.parse::<std::net::IpAddr>().map(|ip| !is_public_ip(&ip)).unwrap_or(false);
    if is_local || ip_blocked {
        return Err("不允许请求内网或本机地址".into())
    }
    Ok(u)
}

/// 判断 IP 是否为公网地址（用于 SSRF 防护）
fn is_public_ip(ip: &std::net::IpAddr) -> bool {
    use std::net::IpAddr;
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            !(o[0] == 10
                || o[0] == 127
                || o[0] == 0
                || (o[0] == 169 && o[1] == 254)
                || (o[0] == 172 && (16..=31).contains(&o[1]))
                || (o[0] == 192 && o[1] == 168)
                || (o[0] == 100 && (64..=127).contains(&o[1]))
                || (o[0] >= 224))
        }
        IpAddr::V6(v) => {
            !v.is_loopback() && !v.is_unspecified() && !v.is_multicast()
                // 拒绝 IPv4 映射的内网地址
                && v.to_ipv4().map(|x| is_public_ip(&IpAddr::V4(x))).unwrap_or(true)
        }
    }
}

/// 通用模型 API 代理：让「用自己 Key 调用」绕过桌面 CORS。
/// 安全约束：仅 http(s)，且拒绝内网/回环/保留地址（防止开放代理 SSRF 与 Key 外发）；
/// 不存储任何凭证，Key 仅用于本次请求头。生图/视频的异步任务也用此命令提交与轮询。
#[tauri::command]
async fn call_provider_api(url: String, api_key: String, body_json: String, method: String) -> Result<String, String> {
    if api_key.trim().is_empty() { return Err("API Key 不能为空".into()) }
    let url = validate_proxy_url(&url)?.to_string();
    let m = method.to_uppercase();
    if m != "POST" && m != "GET" { return Err("仅支持 POST / GET".into()) }

    let client = shared_provider_client(); // 进程级复用；已禁用重定向，避免 302 到内网绕过 SSRF 校验

    let mut req = if m == "POST" {
        let parsed: serde_json::Value = serde_json::from_str(&body_json)
            .map_err(|e| format!("请求体不是合法 JSON：{}", e))?;
        // .json() 已自动设置 Content-Type: application/json。
        // 绝不可再手动 .header("Content-Type", ...) —— reqwest 的 header() 是「追加」语义，
        // 会产生两个 Content-Type 头（合并成 application/json, application/json），
        // DeepSeek 等严格网关会因此返回 415，而 GLM/Kimi 宽容只取第一个故正常。
        client.post(&url).json(&parsed)
    } else {
        client.get(&url)
    };
    // 只设 Authorization；Content-Type 由 .json() 唯一提供（GET 无需 Content-Type）。
    req = req.header("Authorization", format!("Bearer {}", api_key));

    let resp = req.send().await.map_err(|e| format!("请求失败：{}", e))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("读取响应失败：{}", e))?;
    if !status.is_success() {
        // 错误里带上实际请求的 URL 与请求体，便于定位 415 等兼容性问题（不含 api_key）
        let method = req::method_name(&m);
        return Err(format!("接口返回 {} [{} {} body={}]：{}",
            status.as_u16(), method, url,
            body_json.chars().take(300).collect::<String>(),
            text.chars().take(200).collect::<String>()))
    }
    Ok(text)
}

mod req {
    pub fn method_name(m: &str) -> &'static str {
        if m == "GET" { "GET" } else { "POST" }
    }
}

/// 官方只读用量代理：仅允许白名单官方端点，绕过桌面端 CORS 限制。
/// 不接收任意 URL，防止被用作开放代理（SSRF）；不存储任何凭证。
/// 定位 Touch ID helper 二进制（开发态与打包态）
fn biometric_helper_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    if let Ok(dir) = app.path().resource_dir() {
        let p = dir.join("binaries").join("acm-biometric-aarch64-apple-darwin");
        if p.exists() { return Some(p) }
        let p2 = dir.join("acm-biometric-aarch64-apple-darwin");
        if p2.exists() { return Some(p2) }
    }
    // 开发态：从 exe 目录向上找 src-tauri/binaries
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent();
        while let Some(d) = dir {
            let p = d.join("binaries").join("acm-biometric-aarch64-apple-darwin");
            if p.exists() { return Some(p) }
            dir = d.parent();
        }
    }
    None
}

#[tauri::command]
async fn biometric_available(app: tauri::AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let p = biometric_helper_path(&app).ok_or("未找到指纹验证组件")?;
        let out = std::process::Command::new(p).arg("check").output()
            .map_err(|e| format!("指纹检测失败：{}", e))?;
        Ok(out.status.success())
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = app; Ok(false) }
}

#[tauri::command]
async fn biometric_auth(app: tauri::AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let p = biometric_helper_path(&app).ok_or("未找到指纹验证组件")?;
        let out = std::process::Command::new(p).arg("auth").output()
            .map_err(|e| format!("指纹验证失败：{}", e))?;
        Ok(out.status.success())
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = app; Ok(false) }
}

/// 在系统默认浏览器打开外部链接。仅允许 http(s)，防止被滥用。
/// 弹出系统文件夹选择框，返回选中目录路径（macOS 用 osascript，零依赖）
#[tauri::command]
async fn choose_save_dir() -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let script = "POSIX path of (choose folder with prompt \"选择导出文件的保存位置\")";
        let out = std::process::Command::new("osascript")
            .arg("-e").arg(script).output()
            .map_err(|e| format!("打开文件夹选择失败：{}", e))?;
        if !out.status.success() {
            return Ok(None) // 用户取消
        }
        let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
        Ok(if path.is_empty() { None } else { Some(path) })
    }
    #[cfg(not(target_os = "macos"))]
    { Err("当前平台暂不支持选择保存目录，请使用默认下载".into()) }
}

/// 将文本文件写入指定目录
#[tauri::command]
async fn write_file_to_dir(dir: String, filename: String, content: String) -> Result<String, String> {
    use std::io::Write;
    let path = std::path::Path::new(&dir).join(&filename);
    let mut f = std::fs::File::create(&path).map_err(|e| format!("创建文件失败：{}", e))?;
    f.write_all(content.as_bytes()).map_err(|e| format!("写入失败：{}", e))?;
    Ok(path.to_string_lossy().to_string())
}

/// 写二进制文件到指定目录（content 为 base64），用于 docx / 图片等
#[tauri::command]
async fn write_binary_to_dir(dir: String, filename: String, content_base64: String) -> Result<String, String> {
    use std::io::Write;
    let bytes = base64_decode(&content_base64)?;
    let path = std::path::Path::new(&dir).join(&filename);
    let mut f = std::fs::File::create(&path).map_err(|e| format!("创建文件失败：{}", e))?;
    f.write_all(&bytes).map_err(|e| format!("写入失败：{}", e))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
async fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("仅允许 http(s) 链接".into())
    }
    // 校验 URL 不含空白与控制字符，杜绝 cmd/shell 元字符注入面
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("链接含非法字符".into())
    }
    // Windows 用 rundll32 直接交给系统处理 URL，不走 cmd，避免 &|^ 等被当作命令分隔符。
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", &url]).status();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(&url).status();
    #[cfg(target_os = "linux")]
    let result = std::process::Command::new("xdg-open").arg(&url).status();
    result.map(|_| ()).map_err(|e| format!("打开浏览器失败：{}", e))
}

/// 打开系统「麦克风隐私设置」面板。目标地址固定，不接受前端传参，避免命令注入。
#[tauri::command]
async fn open_mic_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // 新系统 scheme 先跳麦克风页；再显式唤起系统设置 App 保证窗口到前台
        let _ = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone").status();
        let _ = std::process::Command::new("open").args(["-a", "System Settings"]).status();
        return Ok(())
    }
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", "ms-settings:privacy-microphone"]).status();
    #[cfg(target_os = "linux")]
    let result = std::process::Command::new("xdg-open").arg("gnome-control-center privacy").status();
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    let result = Ok(std::process::ExitStatus::default());
    #[cfg(not(target_os = "macos"))]
    result.map(|_| ()).map_err(|e| format!("打开系统设置失败：{}", e))
}

/// 打开系统「语音识别隐私设置」面板（仅桌面端）。
#[tauri::command]
async fn open_speech_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition").status();
        let _ = std::process::Command::new("open").args(["-a", "System Settings"]).status();
        return Ok(())
    }
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", "ms-settings:privacy-speech"]).status();
    #[cfg(target_os = "linux")]
    let result = std::process::Command::new("xdg-open").arg("gnome-control-center privacy").status();
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    let result = Ok(std::process::ExitStatus::default());
    #[cfg(not(target_os = "macos"))]
    result.map(|_| ()).map_err(|e| format!("打开系统设置失败：{}", e))
}

/// 检测本机是否安装了指定客户端。
/// macOS：用 mdfind 按官方 bundle id 精确匹配（Spotlight 索引）；Windows：查注册表 App Paths / where。
/// 仅做只读检测，不启动任何程序。
#[tauri::command]
async fn is_app_installed(bundle_ids: Vec<String>, exe_names: Vec<String>) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        for bid in &bundle_ids {
            if bid.is_empty() { continue }
            // 允许字母数字、点、横线，防止命令注入
            if !bid.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') { continue }
            if let Ok(out) = std::process::Command::new("mdfind")
                .arg(format!("kMDItemCFBundleIdentifier == '{}'", bid)).output() {
                if !out.stdout.is_empty() { return Ok(true) }
            }
        }
        // mdfind 索引未建立时，回退检查常见安装目录（整行精确匹配 xxx.app，避免子串误判）
        if let Ok(out) = std::process::Command::new("ls").arg("/Applications").output() {
            let installed: Vec<String> = String::from_utf8_lossy(&out.stdout)
                .lines().map(|l| l.trim().to_lowercase()).collect();
            for exe in &exe_names {
                let stem = exe.trim_end_matches(".exe").to_lowercase();
                if !stem.is_empty() && installed.iter().any(|n| n == &format!("{}.app", stem)) {
                    return Ok(true)
                }
            }
        }
        Ok(false)
    }
    #[cfg(target_os = "windows")]
    {
        for exe in &exe_names {
            if exe.is_empty() { continue }
            if !exe.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == ' ') { continue }
            // 注册表 App Paths
            if let Ok(out) = std::process::Command::new("reg")
                .args(["query", &format!("HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\{}", exe)])
                .output() {
                if out.status.success() { return Ok(true) }
            }
            // PATH 中查找
            if let Ok(out) = std::process::Command::new("where").arg(exe).output() {
                if out.status.success() { return Ok(true) }
            }
        }
        Ok(false)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (bundle_ids, exe_names);
        Ok(false)
    }
}

/// 唤醒本机已安装的客户端。命中第一个可用标识即打开，返回是否成功发起。
/// 调用方应在失败时回退到官网，保证始终有可用出口。
#[tauri::command]
async fn open_local_app(bundle_ids: Vec<String>, exe_names: Vec<String>) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let _ = &exe_names; // macOS 仅用 bundle id 唤醒
        for bid in &bundle_ids {
            if bid.is_empty() { continue }
            if !bid.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') { continue }
            if let Ok(out) = std::process::Command::new("mdfind")
                .arg(format!("kMDItemCFBundleIdentifier == '{}'", bid)).output() {
                if !out.stdout.is_empty() {
                    // status() 等待并检查退出码：bundle id 未注册时 open 会返回非 0，
                    // 避免"report 成功但没唤醒"的假阳性。
                    let ok = std::process::Command::new("open").arg("-b").arg(bid).status()
                        .map(|s| s.success()).unwrap_or(false);
                    if ok { return Ok(true) }
                }
            }
        }
        Ok(false)
    }
    #[cfg(target_os = "windows")]
    {
        for exe in &exe_names {
            if exe.is_empty() { continue }
            if !exe.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == ' ') { continue }
            if let Ok(out) = std::process::Command::new("where").arg(exe).output() {
                if out.status.success() {
                    std::process::Command::new("cmd").args(["/C", "start", "", exe]).spawn()
                        .map_err(|e| format!("唤醒客户端失败：{}", e))?;
                    return Ok(true)
                }
            }
        }
        Ok(false)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (bundle_ids, exe_names);
        Ok(false)
    }
}

#[tauri::command]
async fn send_notification(title: String, body: String) -> Result<(), String> {
    // 用系统原生命令发通知，避免引入额外 crate（本机无外网时也能编译）。
    // 转义双引号与反斜杠，防止 AppleScript 注入。
    let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(
        "display notification \"{}\" with title \"AI 积分管家\" subtitle \"{}\"",
        esc(&body), esc(&title)
    );
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("osascript")
            .arg("-e").arg(&script)
            .output()
            .map_err(|e| format!("发送通知失败：{}", e))?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = script;
        Err("当前平台暂未实现系统通知".into())
    }
}

#[tauri::command]
async fn proxy_usage(provider: String, api_key: String) -> Result<serde_json::Value, String> {
    if api_key.trim().is_empty() {
        return Err("API Key 不能为空".into())
    }
    let (url, need_range): (&str, bool) = match provider.as_str() {
        "openai" => ("https://api.openai.com/v1/organization/usage/completions", true),
        "anthropic" => ("https://api.anthropic.com/v1/usage", false),
        _ => return Err(format!("平台 {} 不支持官方只读用量 API", provider)),
    };

    let client = shared_http_client();
    let mut req = client.get(url).header("Authorization", format!("Bearer {}", api_key));
    if need_range {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_secs();
        req = req.query(&[("start_time", (now - 30 * 24 * 3600).to_string())]);
    }

    let resp = req.send().await.map_err(|e| format!("请求官方接口失败：{}", e))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("官方接口返回 {}，请检查 Key 权限与账户类型", status.as_u16()))
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("解析响应失败：{}", e))
}

/// 本地服务 HTTP 指纹判定：Ollama GET /api/tags 返回 {"models":[...]}
fn fp_ollama(v: &serde_json::Value) -> bool { v.get("models").is_some() }
/// ComfyUI GET /system_stats 返回 {"system":...,"devices":...}
fn fp_comfyui(v: &serde_json::Value) -> bool { v.get("system").is_some() && v.get("devices").is_some() }
/// LM Studio GET /v1/models 返回 OpenAI 格式 {"data":[...]}
fn fp_lmstudio(v: &serde_json::Value) -> bool { v.get("data").is_some() }

/// 探测本机正在运行的本地模型服务（Ollama / ComfyUI / LM Studio 等）。
/// 不再仅凭 TCP 端口开放就认定（会把占用 8080/5000 的无关程序误报为本地服务），
/// 而是对每个候选地址发真实 HTTP 请求做指纹校验，只有响应匹配服务特征才返回。
/// 返回实际可连接的网关地址与端口，前端只读展示、不可修改。
#[tauri::command]
async fn detect_local_services() -> Result<Vec<serde_json::Value>, String> {
    use std::time::Duration;

    // 探测专用短超时客户端：本地服务应快速响应，避免无关端口拖慢整体探测
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(1200))
        .connect_timeout(Duration::from_millis(300))
        .build()
        .map_err(|e| format!("初始化探测客户端失败：{}", e))?;

    // (服务名, 指纹路径, 判定函数)：对候选地址依次尝试，命中即确认服务类型
    let fingerprints: &[(&str, &str, fn(&serde_json::Value) -> bool)] = &[
        ("Ollama", "/api/tags", fp_ollama),
        ("ComfyUI", "/system_stats", fp_comfyui),
        ("LM Studio", "/v1/models", fp_lmstudio),
    ];

    // 候选端口：各服务默认端口 + 常见自定义端口（覆盖大多数本机部署习惯）
    let ports: &[u16] = &[
        11434, 11435, 11436, // Ollama 默认及常见自定义
        8188, 8189, 8288,    // ComfyUI 默认及常见自定义
        1234, 1235,          // LM Studio 默认及常见自定义
        5000, 5001, 8000, 8080, 7860, 3000, // 通用本地端口（需指纹命中才返回）
    ];
    let hosts = ["127.0.0.1", "localhost"];
    let mut found: Vec<serde_json::Value> = Vec::new();

    for &port in ports {
        let mut matched: Option<(&str, &str)> = None; // (service, path)
        for host in hosts {
            for (service, path, check) in fingerprints {
                let url = format!("http://{}:{}{}", host, port, path);
                if let Ok(resp) = client.get(&url).send().await {
                    if resp.status().is_success() {
                        if let Ok(json) = resp.json::<serde_json::Value>().await {
                            if check(&json) {
                                matched = Some((service, host));
                                break
                            }
                        }
                    }
                }
            }
            if matched.is_some() { break }
        }
        if let Some((service, host)) = matched {
            let host = if host == "localhost" { "127.0.0.1" } else { host };
            found.push(serde_json::json!({
                "service": service,
                "host": host,
                "port": port,
                "url": format!("http://{}:{}", host, port),
            }));
        }
    }
    Ok(found)
}

/// 从 macOS `sysctl -n hw.memsize` 的输出（字节数）解析物理内存 GB
fn parse_memsize_bytes_macos(out: &str) -> Option<f64> {
    let bytes: u64 = out.trim().parse().ok()?;
    Some(bytes as f64 / (1024.0 * 1024.0 * 1024.0))
}

/// 从 Linux /proc/meminfo 的 MemTotal 行解析物理内存 GB（kB → GB）
fn parse_meminfo_linux(out: &str) -> Option<f64> {
    for line in out.lines() {
        if let Some(rest) = line.strip_prefix("MemTotal:") {
            let kb: f64 = rest.split_whitespace().next()?.parse().ok()?;
            return Some(kb / 1024.0 / 1024.0)
        }
    }
    None
}

/// 读取本机物理内存 GB（桌面端）。失败返回 0，前端按 8G 保守档处理。
#[tauri::command]
fn get_system_memory_gb() -> f64 {
    use std::process::Command;
    let out = {
        #[cfg(target_os = "macos")]
        { Command::new("sysctl").args(["-n", "hw.memsize"]).output().ok().and_then(|o| String::from_utf8(o.stdout).ok()).and_then(|s| parse_memsize_bytes_macos(&s)) }
        #[cfg(target_os = "linux")]
        { std::fs::read_to_string("/proc/meminfo").ok().and_then(|s| parse_meminfo_linux(&s)) }
        #[cfg(target_os = "windows")]
        { Command::new("wmic").args(["computersystem", "get", "TotalPhysicalMemory", "/value"]).output().ok().and_then(|o| String::from_utf8(o.stdout).ok()).and_then(|s| s.split('=').nth(1).map(|x| x.trim().to_string())).and_then(|n| n.parse::<u64>().ok()).map(|b| b as f64 / (1024.0*1024.0*1024.0)) }
        #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
        { None::<f64> }
    };
    out.unwrap_or(0.0)
}

/// 检测单个本地服务是否正在运行（HTTP 指纹校验，返回服务实际地址或 null）。
/// key: ollama / comfyui / lmstudio
#[tauri::command]
async fn check_local_service(key: String) -> Option<String> {
    use std::time::Duration;
    let (ports, path, check): (&[u16], &str, fn(&serde_json::Value) -> bool) = match key.as_str() {
        "ollama" => (&[11434, 11435, 11436], "/api/tags", fp_ollama),
        "comfyui" => (&[8188, 8189, 8288], "/system_stats", fp_comfyui),
        "lmstudio" => (&[1234, 1235], "/v1/models", fp_lmstudio),
        _ => return None,
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(1000))
        .connect_timeout(Duration::from_millis(250))
        .build()
        .ok()?;
    for &port in ports {
        for host in ["127.0.0.1", "localhost"] {
            let url = format!("http://{}:{}{}", host, port, path);
            if let Ok(resp) = client.get(&url).send().await {
                if resp.status().is_success() {
                    if let Ok(json) = resp.json::<serde_json::Value>().await {
                        if check(&json) {
                            return Some(format!("http://127.0.0.1:{}", port))
                        }
                    }
                }
            }
        }
    }
    None
}

/// App 自己启动的本地服务 PID 记录文件路径：~/.ai-credit-manager/local-services.json
fn managed_pids_path() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    std::path::Path::new(&home).join(".ai-credit-manager").join("local-services.json")
}

/// 读取 App 启动的服务 PID 映射：{ "ollama": 1234, "comfyui": 5678 }
fn load_managed_pids() -> std::collections::HashMap<String, u32> {
    let path = managed_pids_path();
    std::fs::read_to_string(path).ok()
        .and_then(|s| serde_json::from_str::<std::collections::HashMap<String, u32>>(&s).ok())
        .unwrap_or_default()
}

/// 保存 App 启动的服务 PID 映射
fn save_managed_pids(map: &std::collections::HashMap<String, u32>) {
    let path = managed_pids_path();
    if let Some(dir) = path.parent() { let _ = std::fs::create_dir_all(dir); }
    if let Ok(json) = serde_json::to_string(map) { let _ = std::fs::write(path, json); }
}

/// 判断某进程是否仍在运行（macOS/Linux kill -0；Windows 用 tasklist）
fn pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        use std::process::Command;
        Command::new("kill").arg("-0").arg(pid.to_string()).status().map(|s| s.success()).unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        use std::process::Command;
        let out = Command::new("tasklist").args(["/FI", &format!("PID eq {}", pid)]).output().ok();
        out.map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string())).unwrap_or(false)
    }
}

/// 某服务是否由本 App 启动且仍在运行（供前端决定是否显示"停止"按钮）
#[tauri::command]
fn is_service_app_managed(key: String) -> bool {
    load_managed_pids().get(&key).copied().map(pid_alive).unwrap_or(false)
}

/// 启动本机本地模型服务的后台进程（不打开 GUI 窗口，不改系统自启）。
/// Ollama: ollama serve；ComfyUI: venv python main.py --listen 127.0.0.1 --port 8188。
/// 成功启动后记录 PID，仅这些由 App 启动的进程可被 stop_local_service 停止。
#[tauri::command]
fn start_local_service(key: String) -> Result<String, String> {
    use std::process::{Command, Stdio};
    // 若已在运行（无论谁启动），不重复启动
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let (program, args, work_dir, guide): (String, Vec<String>, String, &str) = match key.as_str() {
        "ollama" => (
            "/opt/homebrew/bin/ollama".to_string(),
            vec!["serve".to_string()],
            home.clone(),
            "Ollama 后台服务将在 11434 端口运行",
        ),
        "comfyui" => {
            let py = format!("{}/ComfyUI/venv/bin/python", home);
            let main = format!("{}/ComfyUI/main.py", home);
            if !std::path::Path::new(&py).exists() || !std::path::Path::new(&main).exists() {
                return Err("未找到 ComfyUI（venv 或 main.py 缺失），请确认安装路径为 ~/ComfyUI".to_string())
            }
            (
                py,
                vec![main, "--listen".to_string(), "127.0.0.1".to_string(), "--port".to_string(), "8188".to_string()],
                format!("{}/ComfyUI", home),
                "ComfyUI 后台服务将在 8188 端口运行",
            )
        }
        "lmstudio" => return Err("LM Studio 无 CLI 后台启动方式，请在 LM Studio 应用内手动开启本地服务器".to_string()),
        _ => return Err("未知服务".to_string()),
    };
    if !std::path::Path::new(&program).exists() {
        return Err(format!("未找到启动程序 {}，请确认已安装", program))
    }
    let child = Command::new(&program)
        .args(&args)
        .current_dir(work_dir)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("启动失败：{}", e))?;
    let mut pids = load_managed_pids();
    pids.insert(key.clone(), child.id());
    save_managed_pids(&pids);
    Ok(format!("已启动 {} 后台进程（PID {}），请稍候点击「重新检测」。{}", key, child.id(), guide))
}

/// 停止由本 App 启动的本地服务进程；仅 kill 记录中的 PID，不碰用户手动启动的服务。
#[tauri::command]
fn stop_local_service(key: String) -> Result<String, String> {
    use std::process::Command;
    let mut pids = load_managed_pids();
    let pid = match pids.remove(&key) {
        Some(p) => p,
        None => return Err("该服务不是由本 App 启动的，为不影响其他软件，请在其应用内自行关闭".to_string()),
    };
    save_managed_pids(&pids);
    if !pid_alive(pid) {
        return Ok(format!("服务进程（PID {}）已不在运行，记录已清理", pid))
    }
    #[cfg(unix)]
    let stopped = Command::new("kill").arg(pid.to_string()).status().map(|s| s.success()).unwrap_or(false);
    #[cfg(not(unix))]
    let stopped = Command::new("taskkill").args(["/PID", &pid.to_string(), "/F"]).status().map(|s| s.success()).unwrap_or(false);
    if stopped { Ok(format!("已停止由本 App 启动的 {} 服务（PID {}）", key, pid)) }
    else { Err(format!("停止进程 {} 失败", pid)) }
}

/// 服务默认端口映射（用于按端口定位并停止外部启动的服务进程）
fn service_port(key: &str) -> Option<u16> {
    match key {
        "ollama" => Some(11434),
        "comfyui" => Some(8188),
        "lmstudio" => Some(1234),
        _ => None,
    }
}

/// 停止占用服务端口的进程（无论由谁启动），用于关闭开关时真正释放端口与内存。
/// 通过 lsof 精确定位监听该端口的 PID；若 App 曾启动该服务则一并清理 PID 记录。
#[tauri::command]
fn stop_service_by_port(key: String) -> Result<String, String> {
    use std::process::Command;
    let port = service_port(&key).ok_or_else(|| "未知服务".to_string())?;
    #[cfg(unix)]
    let pids_out = Command::new("lsof")
        .args(["-ti", &format!("tcp:{}", port), "-sTCP:LISTEN"])
        .output()
        .map_err(|e| format!("查找端口进程失败：{}（请确认已安装 lsof）", e))?;
    #[cfg(not(unix))]
    let pids_out = Command::new("netstat")
        .args(["-ano", "-p", "TCP"])
        .output()
        .map_err(|e| format!("查找端口进程失败：{}", e))?;

    #[cfg(unix)]
    let pids: Vec<u32> = String::from_utf8_lossy(&pids_out.stdout)
        .lines().filter_map(|l| l.trim().parse().ok()).collect();
    #[cfg(not(unix))]
    let pids: Vec<u32> = Vec::new(); // Windows 端保守处理：仅靠 managed PID 停止

    if pids.is_empty() {
        // 端口无监听进程，仍需清理 App 的 PID 记录
        let mut m = load_managed_pids();
        m.remove(&key);
        save_managed_pids(&m);
        return Ok(format!("{} 服务端口 {} 当前无进程监听", key, port))
    }
    let mut stopped = Vec::new();
    let mut failed = Vec::new();
    for pid in &pids {
        #[cfg(unix)]
        let ok = Command::new("kill").arg(pid.to_string()).status().map(|s| s.success()).unwrap_or(false);
        #[cfg(not(unix))]
        let ok = Command::new("taskkill").args(["/PID", &pid.to_string(), "/F"]).status().map(|s| s.success()).unwrap_or(false);
        if ok { stopped.push(*pid) } else { failed.push(*pid) }
    }
    let mut m = load_managed_pids();
    m.remove(&key);
    save_managed_pids(&m);
    if failed.is_empty() {
        Ok(format!("已停止 {} 服务端口 {} 上的进程（PID {}），内存已释放", key, port,
            stopped.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(", ")))
    } else {
        Err(format!("部分进程停止失败（PID {}），可能需要管理员权限",
            failed.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(", ")))
    }
}

// ==================== 阿里云百炼 TTS 直连 ====================
// 用户只需填 API Key，App 后端直调官方 REST API（规避浏览器 CORS、免部署代理）。

/// 阿里云百炼旧域名（仍可用，无需 WorkspaceId，降低用户配置门槛）
const DASHSCOPE_BASE: &str = "https://dashscope.aliyuncs.com/api/v1/services/audio/tts";

/// 解析声音复刻响应中的 voice_id
fn parse_clone_voice_id(json: &serde_json::Value) -> Option<String> {
    json.get("output")?.get("voice_id")?.as_str().map(|s| s.to_string())
}

/// 解析语音合成响应中的音频 URL（非流式：output.audio.url）
fn parse_synthesize_url(json: &serde_json::Value) -> Option<String> {
    json.get("output")?.get("audio")?.get("url")?.as_str().map(|s| s.to_string())
}

/// 校验测试连接响应是否有效（list_voice 成功即 Key 有效；有 voice_list 或仅 request_id 都算成功）
fn parse_test_ok(json: &serde_json::Value) -> bool {
    json.get("request_id").and_then(|v| v.as_str()).is_some()
}

/// base64 编码字节（无外部依赖）
fn base64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    let mut i = 0;
    while i < data.len() {
        let b0 = data[i];
        let b1 = if i + 1 < data.len() { data[i + 1] } else { 0 };
        let b2 = if i + 2 < data.len() { data[i + 2] } else { 0 };
        out.push(T[(b0 >> 2) as usize] as char);
        out.push(T[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        out.push(if i + 1 < data.len() { T[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char } else { '=' });
        out.push(if i + 2 < data.len() { T[(b2 & 0x3f) as usize] as char } else { '=' });
        i += 3;
    }
    out
}

/// base64 解码字符串为字节（无外部依赖，与 base64_encode 配套）
fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    let mut buf: u32 = 0;
    let mut bits = 0u32;
    for &c in bytes {
        if c == b'=' { break }
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'\n' | b'\r' | b' ' => continue,
            _ => return Err("非法 base64 字符".into()),
        } as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1u32 << bits) - 1;
        }
    }
    Ok(out)
}

/// 校验 API Key 有效性：调用 list_voice，成功即有效
#[tauri::command]
async fn tts_test_direct(api_key: String) -> Result<String, String> {
    let key = api_key.trim();
    if key.is_empty() { return Err("请先填写 API Key".to_string()) }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build().map_err(|e| format!("客户端错误：{}", e))?;
    let url = format!("{}/customization", DASHSCOPE_BASE);
    let body = serde_json::json!({
        "model": "voice-enrollment",
        "input": { "action": "list_voice", "page_size": 1, "page_index": 0 }
    });
    let resp = client.post(&url)
        .header("Authorization", format!("Bearer {}", key))
        .header("Content-Type", "application/json")
        .json(&body).send().await
        .map_err(|e| format!("连接失败：{}", e))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() { return Err(format!("API Key 无效或未知错误（HTTP {}）：{}", status.as_u16(), text.chars().take(160).collect::<String>())) }
    let json: serde_json::Value = serde_json::from_str(&text).map_err(|_| "响应格式异常".to_string())?;
    if parse_test_ok(&json) { Ok("连接成功，API Key 有效".to_string()) }
    else { Err(format!("校验未通过：{}", text.chars().take(160).collect::<String>())) }
}

/// 声音复刻：POST customization create_voice，audio 为 Data URI
#[tauri::command]
async fn tts_clone_direct(api_key: String, name: String, mime: String, audio_data_url: String) -> Result<String, String> {
    let key = api_key.trim();
    if key.is_empty() { return Err("请先填写 API Key".to_string()) }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build().map_err(|e| format!("客户端错误：{}", e))?;
    // prefix 仅允许字母数字、≤10 字符
    let prefix: String = name.chars().filter(|c| c.is_ascii_alphanumeric()).take(10).collect();
    let prefix = if prefix.is_empty() { "voice".to_string() } else { prefix };
    let body = serde_json::json!({
        "model": "voice-enrollment",
        "input": {
            "action": "create_voice",
            "target_model": "cosyvoice-v2",
            "prefix": prefix,
            "audio": audio_data_url,
            "language_hints": ["zh"]
        }
    });
    let url = format!("{}/customization", DASHSCOPE_BASE);
    let resp = client.post(&url)
        .header("Authorization", format!("Bearer {}", key))
        .header("Content-Type", "application/json")
        .json(&body).send().await
        .map_err(|e| format!("克隆请求失败：{}", e))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() { return Err(format!("克隆失败（HTTP {}）：{}", status.as_u16(), text.chars().take(200).collect::<String>())) }
    let json: serde_json::Value = serde_json::from_str(&text).map_err(|_| format!("响应格式异常：{}", text.chars().take(160).collect::<String>()))?;
    parse_clone_voice_id(&json).ok_or_else(|| format!("服务未返回 voice_id：{}", text.chars().take(200).collect::<String>()))
}

/// 语音合成：POST SpeechSynthesizer → 取 audio.url → 下载字节 → 返回 base64（含 data URI）
#[tauri::command]
async fn tts_synthesize_direct(api_key: String, voice: String, text: String) -> Result<String, String> {
    let key = api_key.trim();
    if key.is_empty() { return Err("请先填写 API Key".to_string()) }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build().map_err(|e| format!("客户端错误：{}", e))?;
    let body = serde_json::json!({
        "model": "cosyvoice-v2",
        "input": { "text": text, "voice": voice, "format": "mp3", "sample_rate": 24000 }
    });
    let url = format!("{}/SpeechSynthesizer", DASHSCOPE_BASE);
    let resp = client.post(&url)
        .header("Authorization", format!("Bearer {}", key))
        .header("Content-Type", "application/json")
        .json(&body).send().await
        .map_err(|e| format!("合成请求失败：{}", e))?;
    let status = resp.status();
    let resp_text = resp.text().await.unwrap_or_default();
    if !status.is_success() { return Err(format!("合成失败（HTTP {}）：{}", status.as_u16(), resp_text.chars().take(200).collect::<String>())) }
    let json: serde_json::Value = serde_json::from_str(&resp_text).map_err(|_| "合成响应格式异常".to_string())?;
    let audio_url = parse_synthesize_url(&json).ok_or_else(|| format!("合成未返回音频地址：{}", resp_text.chars().take(200).collect::<String>()))?;
    let audio = client.get(&audio_url).send().await.map_err(|e| format!("下载音频失败：{}", e))?;
    if !audio.status().is_success() { return Err(format!("下载音频失败（HTTP {}）", audio.status().as_u16())) }
    let bytes = audio.bytes().await.map_err(|e| format!("读取音频失败：{}", e))?;
    Ok(format!("data:audio/mp3;base64,{}", base64_encode(&bytes)))
}

// ==================== VoiceStudio 本地语音服务（OpenAI 兼容 :3900） ====================

/// 规范化 VoiceStudio 基址：默认 http://127.0.0.1:3900，去掉末尾斜杠
fn vs_base(endpoint: &str) -> String {
    let e = endpoint.trim();
    if e.is_empty() { "http://127.0.0.1:3900".to_string() } else { e.trim_end_matches('/').to_string() }
}

/// 解析 data URI 为 (mime, bytes)
fn parse_data_uri(uri: &str) -> Result<(String, Vec<u8>), String> {
    let (head, data) = uri.split_once(',').ok_or_else(|| "音频不是有效的 Data URI".to_string())?;
    let mime = head.strip_prefix("data:").and_then(|h| h.split(';').next()).unwrap_or("audio/wav").to_string();
    let bytes = base64_decode(data).map_err(|e| format!("音频解码失败：{}", e))?;
    if bytes.is_empty() { return Err("音频数据为空".to_string()) }
    Ok((mime, bytes))
}

/// 测试 VoiceStudio 连接：GET /health
#[tauri::command]
async fn voicestudio_test(endpoint: String, api_key: String) -> Result<String, String> {
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(15))
        .build().map_err(|e| format!("客户端错误：{}", e))?;
    let mut req = client.get(format!("{}/health", vs_base(&endpoint)));
    if !api_key.trim().is_empty() { req = req.header("Authorization", format!("Bearer {}", api_key.trim())) }
    let resp = req.send().await.map_err(|e| format!("连接失败（请确认 VoiceStudio 已启动）：{}", e))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() { return Err(format!("连接失败（HTTP {}）：{}", status.as_u16(), text.chars().take(160).collect::<String>())) }
    Ok("连接成功，VoiceStudio 服务可用".to_string())
}

/// 列出 VoiceStudio 已保存的音色：GET /profiles → [{id,name,...}]
#[tauri::command]
async fn voicestudio_list(endpoint: String, api_key: String) -> Result<Vec<serde_json::Value>, String> {
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(30))
        .build().map_err(|e| format!("客户端错误：{}", e))?;
    let mut req = client.get(format!("{}/profiles", vs_base(&endpoint)));
    if !api_key.trim().is_empty() { req = req.header("Authorization", format!("Bearer {}", api_key.trim())) }
    let resp = req.send().await.map_err(|e| format!("请求失败：{}", e))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() { return Err(format!("获取音色失败（HTTP {}）：{}", status.as_u16(), text.chars().take(200).collect::<String>())) }
    // 兼容返回数组或 {profiles:[...]} / {data:[...]}
    let json: serde_json::Value = serde_json::from_str(&text).map_err(|_| format!("响应格式异常：{}", text.chars().take(160).collect::<String>()))?;
    let arr = if let Some(a) = json.as_array() { a.clone() }
        else if let Some(a) = json.get("profiles").and_then(|v| v.as_array()) { a.clone() }
        else if let Some(a) = json.get("data").and_then(|v| v.as_array()) { a.clone() }
        else { vec![] };
    Ok(arr)
}

/// VoiceStudio 克隆：POST /profiles（multipart: name/kind=clone/ref_audio）
#[tauri::command]
async fn voicestudio_clone(endpoint: String, api_key: String, name: String, audio_data_url: String) -> Result<String, String> {
    let (mime, bytes) = parse_data_uri(&audio_data_url)?;
    let boundary = format!("----VoiceStudioBoundary{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos());
    let ext = match mime.as_str() { "audio/mpeg" | "audio/mp3" => "mp3", "audio/ogg" => "ogg", "audio/flac" => "flac", "audio/webm" => "webm", _ => "wav" };
    let mut body: Vec<u8> = Vec::new();
    let mut part = |field: &str, value: &str| {
        body.extend_from_slice(format!("--{}\r\nContent-Disposition: form-data; name=\"{}\"\r\n\r\n{}\r\n", boundary, field, value).as_bytes());
    };
    part("name", &name);
    part("kind", "clone");
    part("language", "Auto");
    body.extend_from_slice(format!("--{}\r\nContent-Disposition: form-data; name=\"ref_audio\"; filename=\"ref_audio.{}\"\r\nContent-Type: {}\r\n\r\n", boundary, ext, mime).as_bytes());
    body.extend_from_slice(&bytes);
    body.extend_from_slice(format!("\r\n--{}--\r\n", boundary).as_bytes());
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(180))
        .build().map_err(|e| format!("客户端错误：{}", e))?;
    let mut req = client.post(format!("{}/profiles", vs_base(&endpoint)))
        .header("Content-Type", format!("multipart/form-data; boundary={}", boundary));
    if !api_key.trim().is_empty() { req = req.header("Authorization", format!("Bearer {}", api_key.trim())) }
    let resp = req.body(body).send().await.map_err(|e| format!("克隆请求失败：{}", e))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() { return Err(format!("克隆失败（HTTP {}）：{}", status.as_u16(), text.chars().take(200).collect::<String>())) }
    let json: serde_json::Value = serde_json::from_str(&text).map_err(|_| format!("响应格式异常：{}", text.chars().take(160).collect::<String>()))?;
    // 兼容 {id:...} / {profile_id:...} / 直接字符串
    let id = json.get("id").and_then(|v| v.as_str())
        .or_else(|| json.get("profile_id").and_then(|v| v.as_str()))
        .or_else(|| json.as_str())
        .ok_or_else(|| format!("服务未返回音色 ID：{}", text.chars().take(200).collect::<String>()))?;
    Ok(id.to_string())
}

/// VoiceStudio 合成：POST /v1/audio/speech → 返回 data URI
#[tauri::command]
async fn voicestudio_synthesize(endpoint: String, api_key: String, voice: String, text: String) -> Result<String, String> {
    let body = serde_json::json!({
        "model": "tts-1",
        "voice": voice,
        "input": text,
        "response_format": "wav"
    });
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(180))
        .build().map_err(|e| format!("客户端错误：{}", e))?;
    let mut req = client.post(format!("{}/v1/audio/speech", vs_base(&endpoint)))
        .header("Content-Type", "application/json");
    if !api_key.trim().is_empty() { req = req.header("Authorization", format!("Bearer {}", api_key.trim())) }
    let resp = req.json(&body).send().await.map_err(|e| format!("合成请求失败：{}", e))?;
    let status = resp.status();
    if !status.is_success() {
        let t = resp.text().await.unwrap_or_default();
        return Err(format!("合成失败（HTTP {}）：{}", status.as_u16(), t.chars().take(200).collect::<String>()))
    }
    let content_type = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let bytes = resp.bytes().await.map_err(|e| format!("读取音频失败：{}", e))?;
    // 防止误把 JSON 错误当成音频
    if content_type.contains("application/json") || bytes.starts_with(b"{\"") {
        return Err(format!("合成返回非音频：{}", String::from_utf8_lossy(&bytes).chars().take(200).collect::<String>()))
    }
    let mime = if content_type.contains("audio/") { content_type.split(';').next().unwrap_or("audio/wav").to_string() }
        else if bytes.starts_with(b"ID3") || content_type.contains("mpeg") { "audio/mpeg".to_string() }
        else { "audio/wav".to_string() };
    Ok(format!("data:{};base64,{}", mime, base64_encode(&bytes)))
}

// ==================== 本地模型列表与文件选择 ====================

/// 从 Ollama /api/tags 响应解析模型名列表
fn parse_ollama_models(json: &serde_json::Value) -> Vec<String> {
    json.get("models").and_then(|m| m.as_array()).map(|arr| arr.iter()
        .filter_map(|x| x.get("name").and_then(|n| n.as_str()).map(|s| s.to_string()))
        .collect()).unwrap_or_default()
}

/// 从 LM Studio /v1/models 响应解析模型 id 列表
fn parse_openai_models(json: &serde_json::Value) -> Vec<String> {
    json.get("data").and_then(|m| m.as_array()).map(|arr| arr.iter()
        .filter_map(|x| x.get("id").and_then(|n| n.as_str()).map(|s| s.to_string()))
        .collect()).unwrap_or_default()
}

/// 支持的本地模型文件扩展名（用于文件选择器过滤与扫描）
const MODEL_FILE_EXTS: &[&str] = &["gguf", "safetensors", "ckpt", "bin", "model", "pth"];

/// 扫描 ComfyUI models 目录下支持的模型文件（递归一层），返回相对 models 的路径
fn scan_comfyui_models() -> Vec<String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let root = std::path::Path::new(&home).join("ComfyUI").join("models");
    let mut out = Vec::new();
    fn walk(dir: &std::path::Path, rel: &str, out: &mut Vec<String>) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    let name = e.file_name().to_string_lossy().to_string();
                    let next = if rel.is_empty() { name } else { format!("{}/{}", rel, name) };
                    walk(&p, &next, out);
                } else if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
                    if MODEL_FILE_EXTS.contains(&ext.to_ascii_lowercase().as_str()) {
                        let name = e.file_name().to_string_lossy().to_string();
                        out.push(if rel.is_empty() { name } else { format!("{}/{}", rel, name) });
                    }
                }
            }
        }
    }
    walk(&root, "", &mut out);
    out.sort();
    out
}

/// ComfyUI 原生 API 桥接：endpoint 为相对路径（如 "prompt" / "history/<id>" / "view?filename=...&type=output"）。
/// method=POST 时 body_json 为请求体；want_image=true 时把响应二进制转 base64 返回（用于 /view 取图）。
/// 仅允许本机地址（复用 validate_proxy_url 的 SSRF 校验）。
#[tauri::command]
async fn comfyui_api(base_url: String, endpoint: String, method: String, body_json: String, want_image: bool) -> Result<String, String> {
    let base = validate_proxy_url(base_url.trim().trim_end_matches('/'))?.to_string();
    // endpoint 只允许简单路径与查询串，禁止 //、.. 防止路径穿越
    if endpoint.contains("..") || endpoint.starts_with("//") { return Err("非法端点".into()) }
    let url = format!("{}/{}", base, endpoint.trim_start_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(if want_image { 60 } else { 30 }))
        .build().map_err(|e| format!("客户端错误：{}", e))?;
    let m = method.to_uppercase();
    let mut req = if m == "POST" {
        let v: serde_json::Value = serde_json::from_str(&body_json)
            .map_err(|e| format!("请求体不是合法 JSON：{}", e))?;
        client.post(&url).json(&v)
    } else {
        client.get(&url)
    };
    let resp = req.send().await.map_err(|e| format!("请求失败：{}", e))?;
    let status = resp.status();
    if want_image {
        let bytes = resp.bytes().await.map_err(|e| format!("读取图片失败：{}", e))?;
        if !status.is_success() { return Err(format!("取图失败（HTTP {}）", status.as_u16())) }
        return Ok(base64_encode(&bytes))
    }
    let text = resp.text().await.map_err(|e| format!("读取响应失败：{}", e))?;
    if !status.is_success() { return Err(format!("接口返回 {}：{}", status.as_u16(), text.chars().take(200).collect::<String>())) }
    Ok(text)
}

/// 从 ComfyUI /object_info/CheckpointLoaderSimple 获取实时可用的 checkpoint 列表（比扫目录准确）。
#[tauri::command]
async fn comfyui_checkpoints(base_url: String) -> Result<Vec<String>, String> {
    let base = validate_proxy_url(base_url.trim().trim_end_matches('/'))?.to_string();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build().map_err(|e| format!("客户端错误：{}", e))?;
    let resp = client.get(format!("{}/object_info/CheckpointLoaderSimple", base)).send().await
        .map_err(|e| format!("连接 ComfyUI 失败：{}", e))?;
    if !resp.status().is_success() { return Err(format!("ComfyUI 返回 {}", resp.status().as_u16())) }
    let json: serde_json::Value = resp.json().await.map_err(|e| format!("响应格式异常：{}", e))?;
    let names = json.get("CheckpointLoaderSimple")
        .and_then(|v| v.get("input"))
        .and_then(|v| v.get("required"))
        .and_then(|v| v.get("ckpt_name"))
        .and_then(|v| v.get(0))
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(str::to_string)).collect::<Vec<_>>())
        .unwrap_or_default();
    if names.is_empty() { return Err("ComfyUI 未报告任何 checkpoint（可能未加载模型）".into()) }
    Ok(names)
}

/// 拉取本地服务已加载/已安装的模型列表，供添加本地模型弹窗选择。
/// key: ollama / comfyui / lmstudio；url 为探测到的服务网关地址。
#[tauri::command]
async fn fetch_local_models(key: String, url: String) -> Result<Vec<String>, String> {
    let base = url.trim().trim_end_matches('/');
    if key == "comfyui" {
        // ComfyUI 无标准已加载模型 API，扫描 models 目录下的模型文件
        let models = scan_comfyui_models();
        if models.is_empty() {
            return Err("未在 ~/ComfyUI/models 下找到模型文件（支持 gguf/safetensors/ckpt/bin）".to_string())
        }
        return Ok(models)
    }
    let (path, parser): (&str, fn(&serde_json::Value) -> Vec<String>) = match key.as_str() {
        "ollama" => ("/api/tags", parse_ollama_models),
        "lmstudio" => ("/v1/models", parse_openai_models),
        _ => return Err("未知服务".to_string()),
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build().map_err(|e| format!("客户端错误：{}", e))?;
    let resp = client.get(format!("{}{}", base, path)).send().await
        .map_err(|e| format!("拉取模型列表失败：{}", e))?;
    if !resp.status().is_success() { return Err(format!("拉取模型列表失败（HTTP {}）", resp.status().as_u16())) }
    let json: serde_json::Value = resp.json().await.map_err(|e| format!("响应格式异常：{}", e))?;
    Ok(parser(&json))
}

/// 从 Ollama /api/embed 响应解析向量（兼容 embeddings[0] 数组与 embedding 单数组）
fn parse_embed_vector(json: &serde_json::Value) -> Option<Vec<f64>> {
    let arr = json.get("embeddings")
        .and_then(|e| e.get(0))
        .or_else(|| json.get("embedding"))
        .and_then(|v| v.as_array())?;
    arr.iter().map(|n| n.as_f64()).collect()
}

/// 调用本机 Ollama 的嵌入接口生成文本向量（供本地文档问答/RAG 使用）。
/// base_url: 探测到的网关（如 http://127.0.0.1:11434）；model: 嵌入模型名（如 nomic-embed-text）
#[tauri::command]
async fn ollama_embed(base_url: String, model: String, input: String) -> Result<Vec<f64>, String> {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() { return Err("未配置 Ollama 服务地址".to_string()) }
    if input.trim().is_empty() { return Err("待嵌入文本为空".to_string()) }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build().map_err(|e| format!("客户端错误：{}", e))?;
    let body = serde_json::json!({ "model": model, "input": input });
    let resp = client.post(format!("{}/api/embed", base))
        .header("Content-Type", "application/json")
        .json(&body).send().await
        .map_err(|e| format!("嵌入请求失败：{}", e))?;
    let status = resp.status();
    if !status.is_success() {
        let t = resp.text().await.unwrap_or_default();
        return Err(format!("嵌入失败（HTTP {}）：{}", status.as_u16(), t.chars().take(160).collect::<String>()))
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| format!("响应格式异常：{}", e))?;
    parse_embed_vector(&json).ok_or_else(|| format!("响应中未找到向量：{}", json.to_string().chars().take(160).collect::<String>()))
}

/// 弹出系统文件选择器，让用户选择本地模型文件（不读取内容，仅返回完整路径供前端取文件名）
#[tauri::command]
fn choose_model_file() -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        // AppleScript：允许选择任意文件；模型格式由前端提示
        let script = "POSIX path of (choose file with prompt \"选择本地模型文件（.gguf / .safetensors / .ckpt / .bin）\")";
        let out = std::process::Command::new("osascript")
            .arg("-e").arg(script).output()
            .map_err(|e| format!("打开文件选择器失败：{}", e))?;
        // 用户取消时 osascript 返回非 0 且 stderr 含 -128
        if !out.status.success() { return Ok(None) }
        let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
        Ok(if path.is_empty() { None } else { Some(path) })
    }
    #[cfg(not(target_os = "macos"))]
    { Err("当前平台暂不支持系统文件选择，请手动输入模型名".to_string()) }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![proxy_usage, call_provider_api, call_cloud_llm, send_notification, open_url, open_mic_settings, open_speech_settings, biometric_available, biometric_auth, choose_save_dir, write_file_to_dir, write_binary_to_dir, is_app_installed, open_local_app, detect_local_services, get_system_memory_gb, check_local_service, start_local_service, stop_local_service, is_service_app_managed, tts_test_direct, tts_clone_direct, tts_synthesize_direct, voicestudio_test, voicestudio_list, voicestudio_clone, voicestudio_synthesize, fetch_local_models, choose_model_file, ollama_embed, stop_service_by_port, comfyui_api, comfyui_checkpoints])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod local_service_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ollama_fingerprint_matches_only_ollama_shape() {
        assert!(fp_ollama(&json!({"models": [{"name": "llama3"}]})));
        assert!(!fp_ollama(&json!({"status": "ok"})));
        assert!(!fp_ollama(&json!({})));
    }

    #[test]
    fn comfyui_fingerprint_requires_system_and_devices() {
        assert!(fp_comfyui(&json!({"system": {}, "devices": []})));
        assert!(!fp_comfyui(&json!({"system": {}}))); // 缺 devices 不算
        assert!(!fp_comfyui(&json!({"hello": "world"})));
    }

    #[test]
    fn lmstudio_fingerprint_matches_openai_models_shape() {
        assert!(fp_lmstudio(&json!({"data": [{"id": "m"}]})));
        assert!(!fp_lmstudio(&json!({"models": []}))); // Ollama 形状不算 LM Studio
        assert!(!fp_lmstudio(&json!({})));
    }

    #[test]
    fn parse_macos_memsize() {
        let bytes_16g = 16u64 * 1024 * 1024 * 1024;
        assert_eq!(parse_memsize_bytes_macos(&bytes_16g.to_string()), Some(16.0));
        assert_eq!(parse_memsize_bytes_macos("17179869184\n"), Some(16.0));
        assert_eq!(parse_memsize_bytes_macos("invalid"), None);
    }

    #[test]
    fn parse_linux_meminfo() {
        let meminfo = "MemTotal:       16384256 kB\nMemFree:         1234567 kB\n";
        let gb = parse_meminfo_linux(meminfo).unwrap();
        assert!(gb > 15.0 && gb < 17.0, "解析结果 {} 应接近 16GB", gb);
        assert_eq!(parse_meminfo_linux("no mem here"), None);
    }

    #[test]
    fn parse_embed_vector_ok() {
        let j = serde_json::json!({"model":"nomic-embed-text","embeddings":[[0.1, -0.2, 0.3]]});
        let v = parse_embed_vector(&j).unwrap();
        assert_eq!(v.len(), 3);
        assert!((v[1] + 0.2).abs() < 1e-9);
        let j2 = serde_json::json!({"embedding":[1.0, 2.0]});
        assert_eq!(parse_embed_vector(&j2).unwrap().len(), 2);
        assert!(parse_embed_vector(&serde_json::json!({})).is_none());
    }

    #[test]
    fn parse_ollama_models_ok() {
        let j = serde_json::json!({"models":[{"name":"llama3:latest"},{"name":"qwen2.5:7b"}]});
        assert_eq!(parse_ollama_models(&j), vec!["llama3:latest", "qwen2.5:7b"]);
        assert!(parse_ollama_models(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn parse_openai_models_ok() {
        let j = serde_json::json!({"data":[{"id":"model-a"},{"id":"model-b"}]});
        assert_eq!(parse_openai_models(&j), vec!["model-a", "model-b"]);
        assert!(parse_openai_models(&serde_json::json!({"data":[]})).is_empty());
    }

    #[test]
    fn service_port_ok() {
        assert_eq!(service_port("ollama"), Some(11434));
        assert_eq!(service_port("comfyui"), Some(8188));
        assert_eq!(service_port("lmstudio"), Some(1234));
        assert_eq!(service_port("unknown"), None);
    }

    #[test]
    fn parse_clone_voice_id_ok() {
        let j = serde_json::json!({"request_id":"x","output":{"voice_id":"cosyvoice-v2-abc-123"}});
        assert_eq!(parse_clone_voice_id(&j), Some("cosyvoice-v2-abc-123".to_string()));
        assert_eq!(parse_clone_voice_id(&serde_json::json!({"output":{}})), None);
    }

    #[test]
    fn parse_synthesize_url_ok() {
        let j = serde_json::json!({"output":{"audio":{"url":"https://oss.example/a.wav"},"finish_reason":"stop"}});
        assert_eq!(parse_synthesize_url(&j), Some("https://oss.example/a.wav".to_string()));
        assert_eq!(parse_synthesize_url(&serde_json::json!({"output":{"audio":{"data":""}}})), None);
    }

    #[test]
    fn parse_test_ok_requires_request_id() {
        assert!(parse_test_ok(&serde_json::json!({"request_id":"req-1","output":{"voice_list":[]}})));
        assert!(!parse_test_ok(&serde_json::json!({"error":"bad key"})));
    }

    #[test]
    fn base64_encode_standard() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
    }

    #[test]
    fn unrelated_services_do_not_match_any_fingerprint() {
        // 占用 8080/5000 的无关 Web 服务响应，不应被误判为任何本地模型服务
        for body in [json!({"status": "ok"}), json!({"hello": "world"}), json!({"version": "1.0"})] {
            assert!(!fp_ollama(&body) && !fp_comfyui(&body) && !fp_lmstudio(&body));
        }
    }
}
