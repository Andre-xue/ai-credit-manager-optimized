#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::time::{SystemTime, UNIX_EPOCH};
use std::sync::OnceLock;

/// 进程级共享 HTTP Client：复用 TLS 连接池，避免每次调用重新握手（性能）。
/// v0.1.285 起禁用重定向：云端请求带会话令牌/自定义头，reqwest 跟随重定向时不会剥离
/// 自定义头，3xx 跳到内网/第三方会同时构成 SSRF 与凭据外泄面；官方端点本就不应重定向。
fn shared_http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("ai-credit-manager/0.1")
            .timeout(std::time::Duration::from_secs(120))
            .redirect(reqwest::redirect::Policy::none())
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
async fn call_cloud_llm(endpoint: String, publishable_key: String, body_json: String, conversation_id: Option<String>, access_token: Option<String>, device_id: Option<String>, origin: Option<String>) -> Result<String, String> {
    let url = format!("{}/.cloud/llm/chat/completions", endpoint.trim_end_matches('/'));
    let client = shared_http_client();
    let _: serde_json::Value = serde_json::from_str(&body_json).map_err(|e| format!("请求体非法：{}", e))?;
    let mut req = client.post(&url)
        .header("x-wb-webapp-access-key", &publishable_key)
        .header("Accept", "text/event-stream")
        .header("Content-Type", "application/json");
    if let Some(cid) = &conversation_id { req = req.header("X-Conversation-ID", cid); }
    // 网关按「设备 + Origin」绑定会话：带上与 WebView 一致的客户端身份，否则 401 invalid_grant
    if let Some(d) = &device_id { if !d.is_empty() { req = req.header("X-Device-Id", d); } }
    if let Some(o) = &origin { if !o.is_empty() { req = req.header("Origin", o); } }
    // 网关 LLM 能力要求登录：前端已登录时传入会话 token
    if let Some(token) = &access_token { if !token.is_empty() { req = req.header("Authorization", format!("Bearer {}", token)); } }
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
/// - https：允许公网域名；字面量的内网/回环/链路本地/云元数据地址拒绝，
///   域名解析结果由 validate_resolved_public 在请求前另行校验（防解析到内网的域名）
/// - http：仅允许本机（localhost / 127.0.0.0/8 / ::1），供本地 Ollama 等模型使用
fn validate_proxy_url(raw: &str) -> Result<reqwest::Url, String> {
    let u = reqwest::Url::parse(raw).map_err(|_| "URL 格式不合法".to_string())?;
    let scheme = u.scheme();
    if scheme != "https" && scheme != "http" {
        return Err("仅允许 http(s) 协议".into())
    }
    let host = u.host_str().ok_or_else(|| "URL 缺少主机".to_string())?;
    // 本机判定必须基于解析后的 IP，禁止用 "127." 前缀匹配域名（127.0.0.1.evil.com 不是本机）
    let is_local = host == "localhost"
        || host.parse::<std::net::IpAddr>().map(|ip| ip.is_loopback()).unwrap_or(false)
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
                // 注意：198.18.0.0/15（基准测试段）刻意不拦——Clash/Surge/sing-box 的
                // fake-IP 模式会把真实域名解析到该段，拦了会让这类用户的所有外网请求全灭
                // （v0.1.286 实测：汇率面板 RPC 被误杀）；该段也不可路由到局域网设备，非 SSRF 目标。
                || (o[0] == 192 && o[1] == 0 && o[2] == 0) // 192.0.0.0/24
                || (o[0] == 192 && o[1] == 0 && o[2] == 2) // 文档示例段 TEST-NET-1/2/3
                || (o[0] == 198 && o[1] == 51 && o[2] == 100)
                || (o[0] == 203 && o[1] == 0 && o[2] == 113)
                || (o[0] >= 224))
        }
        IpAddr::V6(v) => {
            let s = v.segments();
            !v.is_loopback() && !v.is_unspecified() && !v.is_multicast()
                && (s[0] & 0xffc0) != 0xfe80 // fe80::/10 链路本地
                && (s[0] & 0xfe00) != 0xfc00 // fc00::/7 ULA
                // 拒绝 IPv4 映射的内网地址
                && v.to_ipv4().map(|x| is_public_ip(&IpAddr::V4(x))).unwrap_or(true)
        }
    }
}

/// 对已通过 validate_proxy_url 的 URL 再做一次 DNS 解析校验：域名解析结果只要含任一
/// 明确的内网/本机地址（见 is_internal_ip）即拒绝（防 *.nip.io 式域名与静态重绑定
/// 把请求引到内网/云元数据）；特殊保留段不在此列，避免误杀 fake-IP 代理用户。
/// 说明：reqwest 发请求时会再次解析，校验与连接之间仍有极小的动态重绑定窗口，
/// 但静态解析到内网的域名（现实中的绝大多数情况）会被这里拦下（v0.1.285）。
async fn validate_resolved_public(u: &reqwest::Url) -> Result<(), String> {
    use std::net::ToSocketAddrs;
    let host = match u.host_str() { Some(h) => h.to_string(), None => return Ok(()) };
    if host == "localhost" || host.parse::<std::net::IpAddr>().is_ok() { return Ok(()) }
    let port = u.port().unwrap_or(if u.scheme() == "http" { 80 } else { 443 });
    let addrs: Vec<std::net::SocketAddr> = (host.as_str(), port).to_socket_addrs()
        .map_err(|_| "域名解析失败".to_string())?.collect();
    if addrs.is_empty() { return Err("域名无有效解析结果".into()) }
    if addrs.iter().any(|a| is_internal_ip(&a.ip())) {
        return Err("域名解析到内网或保留地址，已拒绝".into())
    }
    Ok(())
}

/// DNS 解析结果专用判定：是否为「明确的内网/本机目标」（回环、RFC1918 私有段、
/// 链路本地含云元数据段、ULA、组播）。与 is_public_ip 的区别：解析校验只拦这些
/// 真正能到达局域网/本机/元数据的地址——fake-IP 代理（Clash/Surge/sing-box）会把
/// 所有真实域名解析到 198.18.0.0/15 等特殊段、连接由用户自己的代理接管，
/// 若按「非公网即拒绝」会把这类用户的全部外网请求误杀（v0.1.286 实测：
/// api.siliconflow.cn 与 open.er-api.com 在公共 DNS 均为正常公网 IP，
/// 在用户机器上被本地代理改写解析后遭误拒，模型拉取与汇率面板同时中招）。
fn is_internal_ip(ip: &std::net::IpAddr) -> bool {
    use std::net::IpAddr;
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            o[0] == 10
                || o[0] == 127
                || o[0] == 0
                || (o[0] == 169 && o[1] == 254)
                || (o[0] == 172 && (16..=31).contains(&o[1]))
                || (o[0] == 192 && o[1] == 168)
                || (o[0] >= 224)
        }
        IpAddr::V6(v) => {
            let s = v.segments();
            v.is_loopback() || v.is_unspecified() || v.is_multicast()
                || (s[0] & 0xffc0) == 0xfe80
                || (s[0] & 0xfe00) == 0xfc00
                || v.to_ipv4().map(|x| is_internal_ip(&IpAddr::V4(x))).unwrap_or(false)
        }
    }
}

/// 主机是否为本机/局域网地址（localhost、回环、私有段、链路本地、ULA；
/// 但云元数据段 169.254.0.0/16 永不视为本地服务）
fn is_local_host(host: &str) -> bool {
    if host == "localhost" { return true }
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(v)) => {
            let o = v.octets();
            if o[0] == 169 && o[1] == 254 { return false }
            v.is_loopback() || o[0] == 10
                || (o[0] == 172 && (16..=31).contains(&o[1]))
                || (o[0] == 192 && o[1] == 168)
        }
        Ok(std::net::IpAddr::V6(v)) => {
            let s = v.segments();
            v.is_loopback()
                || (s[0] & 0xffc0) == 0xfe80
                || (s[0] & 0xfe00) == 0xfc00
                || v.to_ipv4().map(|x| is_local_host(&x.to_string())).unwrap_or(false)
        }
        Err(_) => false,
    }
}

/// 本地服务专用校验（ComfyUI / Ollama / LM Studio）：只允许 http(s) + 本机/局域网地址，
/// 拒绝公网域名与公网 IP——这类服务按定义就在用户自己的网络里（v0.1.285 SSRF 收口）。
fn validate_local_service_url(raw: &str) -> Result<String, String> {
    let u = reqwest::Url::parse(raw).map_err(|_| "URL 格式不合法".to_string())?;
    if u.scheme() != "https" && u.scheme() != "http" { return Err("仅允许 http(s) 协议".into()) }
    let host = u.host_str().ok_or_else(|| "URL 缺少主机".to_string())?;
    if !is_local_host(host) { return Err("本地服务地址只允许本机或局域网地址".into()) }
    Ok(u.to_string().trim_end_matches('/').to_string())
}

/// 通用服务地址校验（VoiceStudio 等用户自填端点）：本机/局域网走本地规则，公网走 validate_proxy_url。
fn validate_service_url(raw: &str) -> Result<String, String> {
    let u = reqwest::Url::parse(raw).map_err(|_| "URL 格式不合法".to_string())?;
    let host = u.host_str().ok_or_else(|| "URL 缺少主机".to_string())?;
    if is_local_host(host) {
        if u.scheme() != "https" && u.scheme() != "http" { return Err("仅允许 http(s) 协议".into()) }
        return Ok(u.to_string().trim_end_matches('/').to_string())
    }
    Ok(validate_proxy_url(raw)?.to_string().trim_end_matches('/').to_string())
}

/// 通用模型 API 代理：让「用自己 Key 调用」绕过桌面 CORS。
/// 安全约束：仅 http(s)，且拒绝内网/回环/保留地址（防止开放代理 SSRF 与 Key 外发）；
/// 不存储任何凭证，Key 仅用于本次请求头。生图/视频的异步任务也用此命令提交与轮询。
#[tauri::command]
async fn call_provider_api(url: String, api_key: String, body_json: String, method: String, headers_json: Option<String>) -> Result<String, String> {
    if api_key.trim().is_empty() { return Err("API Key 不能为空".into()) }
    let parsed = validate_proxy_url(&url)?;
    validate_resolved_public(&parsed).await?;
    let url = parsed.to_string();
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
    // 附加业务头（如百炼视频的 X-DashScope-Async）：跳过 Authorization/Content-Type，避免覆盖与重复头。
    if let Some(hj) = headers_json.as_deref() {
        if let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(hj) {
            for (k, v) in map {
                let lk = k.to_ascii_lowercase();
                if lk == "authorization" || lk == "content-type" { continue }
                if let Some(s) = v.as_str() { req = req.header(k, s); }
            }
        }
    }

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

// ---------------- 插件系统（v0.1.264）：网络代理 + 桌面进程插件 ----------------

/// 插件网络代理：URL 先过 SSRF 校验（validate_proxy_url）；具体域名白名单在 TS 宿主侧
/// 按插件清单校验。与 call_provider_api 不同：不强制 Bearer 头、不要求成功状态码，
/// 状态码与响应体原样回传给插件自行判断。
#[tauri::command]
async fn plugin_http(url: String, method: String, headers_json: Option<String>, body: Option<String>) -> Result<String, String> {
    let parsed = validate_proxy_url(&url)?;
    validate_resolved_public(&parsed).await?;
    let url = parsed.to_string();
    let m = method.to_uppercase();
    let parsed_method = reqwest::Method::from_bytes(m.as_bytes())
        .map_err(|_| format!("不支持的请求方法：{}", m))?;
    let client = shared_provider_client(); // 已禁用重定向，避免 302 跳内网绕过 SSRF 校验
    let mut req = client.request(parsed_method, &url);
    if let Some(hj) = headers_json.as_deref() {
        if let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(hj) {
            for (k, v) in map {
                if let Some(s) = v.as_str() { req = req.header(k, s); }
            }
        }
    }
    if let Some(b) = body { req = req.body(b); }
    let resp = req.send().await.map_err(|e| format!("请求失败：{}", e))?;
    let status = resp.status().as_u16();
    let mut headers_map = serde_json::Map::new();
    for (k, v) in resp.headers().iter() {
        if let Ok(s) = v.to_str() { headers_map.insert(k.as_str().to_string(), serde_json::Value::String(s.to_string())); }
    }
    let text = resp.text().await.map_err(|e| format!("读取响应失败：{}", e))?;
    Ok(serde_json::json!({ "status": status, "body": text, "headers": headers_map }).to_string())
}

// ---------------- 插件面板文档服务（v0.1.284） ----------------
// 真因记录：主窗口 CSP 是 script-src 'self'，srcdoc 子文档按规范继承嵌入方 CSP，
// 插件面板的内联脚本（桥 + 插件代码）在桌面端全被拦截——面板 HTML 能显示、点击毫无反应（v0.1.264 起）。
// 改法：面板 HTML 先经 plugin_frame_put 暂存，再让 iframe 加载自定义协议 acmplugin:// 的独立文档，
// 该文档带自己的 CSP 响应头（只放行内联脚本/样式，直连网络全禁，能力照旧走宿主 RPC）；
// iframe 的 sandbox="allow-scripts"（无 allow-same-origin）不变，插件与宿主依然不同源。
fn plugin_frames() -> &'static std::sync::Mutex<std::collections::HashMap<String, String>> {
    static FRAMES: OnceLock<std::sync::Mutex<std::collections::HashMap<String, String>>> = OnceLock::new();
    FRAMES.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

#[tauri::command]
fn plugin_frame_put(id: String, html: String) -> Result<(), String> {
    if html.len() > 5_000_000 { return Err("插件面板文档过大".into()) }
    plugin_frames().lock().map_err(|_| "面板表锁定失败".to_string())?.insert(id, html);
    Ok(())
}

#[tauri::command]
fn plugin_frame_remove(id: String) -> Result<(), String> {
    plugin_frames().lock().map_err(|_| "面板表锁定失败".to_string())?.remove(&id);
    Ok(())
}

fn plugin_frame_response(request: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let id = request.uri().path().rsplit('/').next().unwrap_or("").to_string();
    let html = plugin_frames().lock().ok()
        .and_then(|m| m.get(&id).cloned())
        .unwrap_or_else(|| "<!doctype html><html><body></body></html>".to_string());
    tauri::http::Response::builder()
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob: https:; media-src data: blob: https:; font-src data:")
        .body(html.into_bytes())
        .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

/// 桌面进程插件：用户在插件清单里声明的本地命令，由用户手动启动/停止；输出留最近 300 行。
struct PluginProc {
    child: std::process::Child,
    output: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
}

fn plugin_procs() -> &'static std::sync::Mutex<std::collections::HashMap<String, PluginProc>> {
    static PROCS: OnceLock<std::sync::Mutex<std::collections::HashMap<String, PluginProc>>> = OnceLock::new();
    PROCS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

#[tauri::command]
fn plugin_process_start(id: String, command: String, args: Vec<String>) -> Result<u32, String> {
    use std::process::{Command, Stdio};
    let mut map = plugin_procs().lock().map_err(|_| "进程表锁定失败".to_string())?;
    let running = map.get_mut(&id)
        .map(|e| matches!(e.child.try_wait(), Ok(None)))
        .unwrap_or(false);
    if running { return Err("该插件进程已在运行".into()); }
    map.remove(&id);
    let mut child = Command::new(&command)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动失败：{}", e))?;
    let pid = child.id();
    let output = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    fn drain<R: std::io::Read + Send + 'static>(stream: R, buf: std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        use std::io::{BufRead, BufReader};
        std::thread::spawn(move || {
            for line in BufReader::new(stream).lines() {
                match line {
                    Ok(l) => {
                        if let Ok(mut v) = buf.lock() {
                            v.push(l);
                            if v.len() > 300 { let excess = v.len() - 300; v.drain(0..excess); }
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }
    if let Some(out) = child.stdout.take() { drain(out, output.clone()); }
    if let Some(err) = child.stderr.take() { drain(err, output.clone()); }
    map.insert(id, PluginProc { child, output });
    Ok(pid)
}

#[tauri::command]
fn plugin_process_stop(id: String) -> Result<(), String> {
    let mut map = plugin_procs().lock().map_err(|_| "进程表锁定失败".to_string())?;
    if let Some(mut entry) = map.remove(&id) {
        let _ = entry.child.kill();
        let _ = entry.child.wait();
    }
    Ok(())
}

#[tauri::command]
fn plugin_process_running(id: String) -> bool {
    let mut map = match plugin_procs().lock() { Ok(m) => m, Err(_) => return false };
    match map.get_mut(&id) {
        Some(entry) => matches!(entry.child.try_wait(), Ok(None)),
        None => false,
    }
}

#[tauri::command]
fn plugin_process_output(id: String) -> String {
    let map = match plugin_procs().lock() { Ok(m) => m, Err(_) => return String::new() };
    match map.get(&id) {
        Some(entry) => entry.output.lock().map(|v| v.join("\n")).unwrap_or_default(),
        None => String::new(),
    }
}

// ---------------- MCP 服务器 stdio 桥（v0.1.264） ----------------
// 本地 MCP 服务器就是普通子进程：JSON-RPC 按行走 stdin/stdout。
// 前端用 mcp_write 写入一行请求、用 mcp_read 轮询取走新到的 stdout 行（无需 Tauri 事件）。

struct McpProc {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    lines: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    logs: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
}

fn mcp_procs() -> &'static std::sync::Mutex<std::collections::HashMap<String, McpProc>> {
    static PROCS: OnceLock<std::sync::Mutex<std::collections::HashMap<String, McpProc>>> = OnceLock::new();
    PROCS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn mcp_drain<R: std::io::Read + Send + 'static>(stream: R, buf: std::sync::Arc<std::sync::Mutex<Vec<String>>>, cap: usize) {
    use std::io::{BufRead, BufReader};
    std::thread::spawn(move || {
        for line in BufReader::new(stream).lines() {
            match line {
                Ok(l) => {
                    if let Ok(mut v) = buf.lock() {
                        v.push(l);
                        if v.len() > cap { let excess = v.len() - cap; v.drain(0..excess); }
                    }
                }
                Err(_) => break,
            }
        }
    });
}

#[tauri::command]
fn mcp_start(id: String, command: String, args: Vec<String>) -> Result<u32, String> {
    use std::process::{Command, Stdio};
    let mut map = mcp_procs().lock().map_err(|_| "MCP 进程表锁定失败".to_string())?;
    let running = map.get_mut(&id)
        .map(|e| matches!(e.child.try_wait(), Ok(None)))
        .unwrap_or(false);
    if running { return Err("该 MCP 服务器已在运行".into()); }
    map.remove(&id);
    let mut child = Command::new(&command)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 MCP 服务器失败：{}", e))?;
    let pid = child.id();
    let stdin = child.stdin.take().ok_or_else(|| "无法打开 MCP 服务器 stdin".to_string())?;
    let lines = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let logs = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    if let Some(out) = child.stdout.take() { mcp_drain(out, lines.clone(), 2000); }
    if let Some(err) = child.stderr.take() { mcp_drain(err, logs.clone(), 300); }
    map.insert(id, McpProc { child, stdin, lines, logs });
    Ok(pid)
}

#[tauri::command]
fn mcp_write(id: String, line: String) -> Result<(), String> {
    use std::io::Write;
    let mut map = mcp_procs().lock().map_err(|_| "MCP 进程表锁定失败".to_string())?;
    let entry = map.get_mut(&id).ok_or_else(|| "MCP 服务器未运行".to_string())?;
    entry.stdin.write_all(line.as_bytes()).map_err(|e| format!("写入 MCP 服务器失败：{}", e))?;
    entry.stdin.write_all(b"\n").map_err(|e| format!("写入 MCP 服务器失败：{}", e))?;
    entry.stdin.flush().map_err(|e| format!("写入 MCP 服务器失败：{}", e))?;
    Ok(())
}

/// 取走自上次读取以来新到的 stdout 行（JSON-RPC 消息，一行一条）
#[tauri::command]
fn mcp_read(id: String) -> Vec<String> {
    let map = match mcp_procs().lock() { Ok(m) => m, Err(_) => return Vec::new() };
    match map.get(&id) {
        Some(entry) => entry.lines.lock().map(|mut v| std::mem::take(&mut *v)).unwrap_or_default(),
        None => Vec::new(),
    }
}

#[tauri::command]
fn mcp_stop(id: String) -> Result<(), String> {
    let mut map = mcp_procs().lock().map_err(|_| "MCP 进程表锁定失败".to_string())?;
    if let Some(mut entry) = map.remove(&id) {
        let _ = entry.child.kill();
        let _ = entry.child.wait();
    }
    Ok(())
}

#[tauri::command]
fn mcp_running(id: String) -> bool {
    let mut map = match mcp_procs().lock() { Ok(m) => m, Err(_) => return false };
    match map.get_mut(&id) {
        Some(entry) => matches!(entry.child.try_wait(), Ok(None)),
        None => false,
    }
}

#[tauri::command]
fn mcp_logs(id: String) -> String {
    let map = match mcp_procs().lock() { Ok(m) => m, Err(_) => return String::new() };
    match map.get(&id) {
        Some(entry) => entry.logs.lock().map(|v| v.join("\n")).unwrap_or_default(),
        None => String::new(),
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
    // 开发态：从 exe 目录向上找 src-tauri/binaries（仅 debug 构建；发布构建只认 resource_dir，
    // 防止同名文件被预置到 exe 上层目录后被抢注执行，v0.1.285）
    #[cfg(debug_assertions)]
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

/// 导出文件名净化（v0.1.285）：文件名来自文档标题/AI 生成名等不可信数据，
/// 只允许单个文件名——拒绝路径分隔符、.. 与绝对路径，防止写出目标目录之外。
fn safe_filename(filename: &str) -> Result<String, String> {
    let name = filename.trim();
    if name.is_empty() || name == "." || name == ".."
        || name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err("文件名不合法".into())
    }
    Ok(name.to_string())
}

/// 将文本文件写入指定目录
#[tauri::command]
async fn write_file_to_dir(dir: String, filename: String, content: String) -> Result<String, String> {
    use std::io::Write;
    let path = std::path::Path::new(&dir).join(safe_filename(&filename)?);
    let mut f = std::fs::File::create(&path).map_err(|e| format!("创建文件失败：{}", e))?;
    f.write_all(content.as_bytes()).map_err(|e| format!("写入失败：{}", e))?;
    Ok(path.to_string_lossy().to_string())
}

/// 写二进制文件到指定目录（content 为 base64），用于 docx / 图片等
#[tauri::command]
async fn write_binary_to_dir(dir: String, filename: String, content_base64: String) -> Result<String, String> {
    use std::io::Write;
    let bytes = base64_decode(&content_base64)?;
    let path = std::path::Path::new(&dir).join(safe_filename(&filename)?);
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
        "deepseek" => ("https://api.deepseek.com/user/balance", false),
        "kim" => ("https://api.moonshot.cn/v1/users/me/balance", false),
        "siliconflow" => ("https://api.siliconflow.cn/v1/user/info", false),
        "openrouter" => ("https://openrouter.ai/api/v1/auth/key", false),
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
        // 带上平台返回体片段（如 {"message":"Token is invalid."}），用户一眼能看出是 Key 无效还是权限问题
        let body = resp.text().await.unwrap_or_default();
        let snippet: String = body.chars().take(140).collect();
        return Err(format!("官方接口返回 {}：{}", status.as_u16(), snippet))
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
    // 各端口并行探测：此前串行逐个端口×双主机×三指纹试，最坏要等几十秒，
    // 添加本地模型的表单长时间卡在「正在探测本机服务…」像检测不到服务（v0.1.256 改并行）
    let mut handles = Vec::new();
    for &port in ports {
        let client = client.clone();
        let fps: Vec<(&str, &str, fn(&serde_json::Value) -> bool)> = fingerprints.to_vec();
        handles.push(tauri::async_runtime::spawn(async move {
            for host in ["127.0.0.1", "localhost"] {
                for (service, path, check) in &fps {
                    let url = format!("http://{}:{}{}", host, port, path);
                    if let Ok(resp) = client.get(&url).send().await {
                        if resp.status().is_success() {
                            if let Ok(json) = resp.json::<serde_json::Value>().await {
                                if check(&json) {
                                    let h = if host == "localhost" { "127.0.0.1" } else { host };
                                    return Some(serde_json::json!({
                                        "service": service,
                                        "host": h,
                                        "port": port,
                                        "url": format!("http://{}:{}", h, port),
                                    }));
                                }
                            }
                        }
                    }
                }
            }
            None
        }));
    }
    let mut found: Vec<serde_json::Value> = Vec::new();
    for h in handles {
        if let Ok(Some(v)) = h.await { found.push(v) }
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
    // 各端口并行探测：旧版顺序逐个敲，服务未启动时要挨个等超时（最坏 6 秒以上），
    // 弹窗会长时间停在「正在探测」。并行后按端口优先级取第一个命中。
    let mut handles = Vec::new();
    for &port in ports {
        let client = client.clone();
        let path = path.to_string();
        handles.push(tauri::async_runtime::spawn(async move {
            for host in ["127.0.0.1", "localhost"] {
                let url = format!("http://{}:{}{}", host, port, path);
                if let Ok(resp) = client.get(&url).send().await {
                    if resp.status().is_success() {
                        if let Ok(json) = resp.json::<serde_json::Value>().await {
                            if check(&json) {
                                return Some(port);
                            }
                        }
                    }
                }
            }
            None
        }));
    }
    for h in handles {
        if let Ok(Some(port)) = h.await {
            return Some(format!("http://127.0.0.1:{}", port));
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

/// 查监听某 TCP 端口的进程 PID 列表（unix 用 lsof；Windows 返回空，走 managed PID 路径）
fn port_listener_pids(port: u16) -> Vec<u32> {
    #[cfg(unix)]
    {
        use std::process::Command;
        match Command::new("lsof").args(["-ti", &format!("tcp:{}", port), "-sTCP:LISTEN"]).output() {
            Ok(o) => String::from_utf8_lossy(&o.stdout)
                .lines().filter_map(|l| l.trim().parse().ok()).collect(),
            Err(_) => Vec::new(),
        }
    }
    #[cfg(not(unix))]
    { Vec::new() }
}

/// 向进程发送信号：force=false 为常规终止（SIGTERM），true 为强制结束（SIGKILL；Windows 恒为 taskkill /F）
fn signal_pid(pid: u32, force: bool) -> bool {
    use std::process::Command;
    #[cfg(unix)]
    {
        let mut cmd = Command::new("kill");
        if force { cmd.arg("-9"); }
        cmd.arg(pid.to_string()).status().map(|s| s.success()).unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        let _ = force;
        Command::new("taskkill").args(["/PID", &pid.to_string(), "/F"]).status().map(|s| s.success()).unwrap_or(false)
    }
}

/// 轮询等待进程退出，最多等 max_ms；返回等待结束时仍存活的 PID
fn wait_pids_exit(pids: &[u32], max_ms: u64) -> Vec<u32> {
    let mut remaining: Vec<u32> = pids.to_vec();
    let mut waited = 0u64;
    while !remaining.is_empty() && waited < max_ms {
        std::thread::sleep(std::time::Duration::from_millis(200));
        waited += 200;
        remaining.retain(|p| pid_alive(*p));
    }
    remaining
}

/// 确认式停止一组进程：先 SIGTERM 并等待退出（≤2s），未退出的 SIGKILL 再等一轮（≤1s）。
/// 返回 (已确认退出的 PID, 其中被强制结束的 PID, 仍存活的 PID)
fn stop_pids_confirmed(pids: &[u32]) -> (Vec<u32>, Vec<u32>, Vec<u32>) {
    for pid in pids { signal_pid(*pid, false); }
    let alive = wait_pids_exit(pids, 2000);
    if alive.is_empty() { return (pids.to_vec(), Vec::new(), Vec::new()); }
    for pid in &alive { signal_pid(*pid, true); }
    let still = wait_pids_exit(&alive, 1000);
    let forced: Vec<u32> = alive.iter().copied().filter(|p| !still.contains(p)).collect();
    let graceful: Vec<u32> = pids.iter().copied().filter(|p| !alive.contains(p)).collect();
    let mut done = graceful;
    done.extend(forced.iter().copied());
    (done, forced, still)
}

/// 读取进程的命令行（ps -o command=）；失败返回空串
fn pid_command(pid: u32) -> String {
    #[cfg(unix)]
    {
        use std::process::Command;
        Command::new("ps").args(["-p", &pid.to_string(), "-o", "command="]).output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default()
    }
    #[cfg(not(unix))]
    { String::new() }
}

/// Ollama 桌面应用是否在运行（macOS：进程名恰为 Ollama）
fn ollama_app_running() -> bool {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        Command::new("pgrep").args(["-x", "Ollama"]).output().map(|o| !o.stdout.is_empty()).unwrap_or(false)
    }
    #[cfg(not(target_os = "macos"))]
    { false }
}

/// 退出 Ollama 桌面应用。必要性：该应用会守护自己的服务进程，应用不退出时，
/// 关开关杀掉的 11434 服务会被它重新拉回来，达不到「关掉就停、不常驻」。
/// 返回退出前它是否在运行。
fn quit_ollama_app() -> bool {
    if !ollama_app_running() { return false; }
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        let _ = Command::new("pkill").args(["-x", "Ollama"]).status();
        let mut waited = 0;
        while ollama_app_running() && waited < 2000 {
            std::thread::sleep(std::time::Duration::from_millis(200));
            waited += 200;
        }
    }
    true
}

/// Ollama CLI 可执行路径：Homebrew（Apple Silicon / Intel）与桌面应用自带 CLI，取第一个存在的
fn ollama_program() -> String {
    for p in ["/opt/homebrew/bin/ollama", "/usr/local/bin/ollama", "/Applications/Ollama.app/Contents/Resources/ollama"] {
        if std::path::Path::new(p).exists() { return p.to_string(); }
    }
    "/opt/homebrew/bin/ollama".to_string()
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
fn start_local_service(key: String, launch_desktop: bool) -> Result<String, String> {
    use std::process::{Command, Stdio};
    // Comfy Desktop 拉起模式（设置开关）：不走命令行 venv 路径，改为打开桌面应用，
    // 实例由用户在应用内点开；不记录 managed PID（没有可管理的子进程）。
    if key == "comfyui" && launch_desktop {
        #[cfg(target_os = "macos")]
        {
            for app_name in ["Comfy Desktop", "ComfyUI"] {
                let ok = Command::new("open").args(["-a", app_name]).status().map(|s| s.success()).unwrap_or(false);
                if ok {
                    return Ok(format!("已打开 {}，请在其中打开你的实例；实例启动后本 App 会自动识别", app_name));
                }
            }
            return Err("未找到 Comfy Desktop 应用（已尝试 Comfy Desktop / ComfyUI 两个名称）".to_string());
        }
        #[cfg(not(target_os = "macos"))]
        {
            return Err("拉起 Comfy Desktop 仅支持 macOS".to_string());
        }
    }
    // 若已在运行（无论谁启动），不重复启动
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let (program, args, work_dir, guide): (String, Vec<String>, String, &str) = match key.as_str() {
        "ollama" => (
            ollama_program(),
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

/// 停止由本 App 启动的本地服务进程；仅处理记录中的 PID，不碰用户手动启动的服务。
/// 确认式：发终止信号后等待进程真的退出，未退出则强制结束，并如实报告结果。
#[tauri::command]
fn stop_local_service(key: String) -> Result<String, String> {
    let mut pids = load_managed_pids();
    let pid = match pids.remove(&key) {
        Some(p) => p,
        None => return Err("该服务不是由本 App 启动的，为不影响其他软件，请在其应用内自行关闭".to_string()),
    };
    save_managed_pids(&pids);
    if !pid_alive(pid) {
        return Ok(format!("服务进程（PID {}）已不在运行，记录已清理", pid));
    }
    let (_done, forced, still) = stop_pids_confirmed(&[pid]);
    if !still.is_empty() {
        return Err(format!("进程 {} 经强制结束仍未退出，可能需要管理员权限手动处理", pid));
    }
    if forced.is_empty() {
        Ok(format!("已停止由本 App 启动的 {} 服务（PID {}，已确认进程退出，内存已释放）", key, pid))
    } else {
        Ok(format!("已停止由本 App 启动的 {} 服务（PID {}，常规终止未退出已强制结束，已确认进程退出，内存已释放）", key, pid))
    }
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
/// 通过 lsof 精确定位监听该端口的 PID；确认式关闭：SIGTERM 后等待进程退出（≤2s），
/// 未退出的 SIGKILL 强杀再等一轮（≤1s），最后复查端口无监听才算成功；若 App 曾启动该服务则一并清理 PID 记录。
#[tauri::command]
fn stop_service_by_port(key: String) -> Result<String, String> {
    let port = service_port(&key).ok_or_else(|| "未知服务".to_string())?;
    #[cfg(unix)]
    {
        use std::process::Command;
        if Command::new("lsof").arg("-v").output().is_err() {
            return Err("查找端口进程失败：lsof 不可用".to_string());
        }
    }
    // Ollama 先退出桌面应用：它会守护自己的服务进程，不先退出，刚杀掉的服务会被它拉回来
    let app_quit = key == "ollama" && quit_ollama_app();
    let app_note = if app_quit { "；已一并退出 Ollama 应用，防止它把服务重新拉起" } else { "" };
    let pids = port_listener_pids(port);
    if pids.is_empty() {
        // 端口无监听进程，仍需清理 App 的 PID 记录
        let mut m = load_managed_pids();
        m.remove(&key);
        save_managed_pids(&m);
        return Ok(format!("{} 服务端口 {} 当前无进程监听{}", key, port, app_note));
    }
    let (done, forced, still) = stop_pids_confirmed(&pids);
    let mut m = load_managed_pids();
    m.remove(&key);
    save_managed_pids(&m);
    // 最终复查：目标进程须全部退出，且端口上不得再有任何监听进程
    let listeners = port_listener_pids(port);
    if !still.is_empty() || !listeners.is_empty() {
        let mut bad: Vec<u32> = still.iter().copied().chain(listeners.iter().copied()).collect();
        bad.sort_unstable();
        bad.dedup();
        return Err(format!("{} 服务端口 {} 仍有进程未退出（PID {}），可能需要管理员权限手动处理",
            key, port, bad.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(", ")));
    }
    // Ollama 落定复查：等 1.5 秒确认端口没有被任何守护者重新监听；若又出现则再清一次，
    // 仍清不掉才报错——保证「关开关」返回成功时服务是真的停了，而不是杀完瞬间没人、过会儿又回来
    if key == "ollama" {
        std::thread::sleep(std::time::Duration::from_millis(1500));
        let again = port_listener_pids(port);
        if !again.is_empty() {
            let (_d2, _f2, still2) = stop_pids_confirmed(&again);
            let left = port_listener_pids(port);
            if !still2.is_empty() || !left.is_empty() {
                let mut bad: Vec<u32> = still2.iter().copied().chain(left.iter().copied()).collect();
                bad.sort_unstable();
                bad.dedup();
                return Err(format!("{} 服务端口 {} 上的进程被停止后又重新出现（PID {}），可能有其他守护程序在拉起它，请手动处理",
                    key, port, bad.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(", ")));
            }
        }
    }
    let pid_list = done.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(", ");
    if forced.is_empty() {
        Ok(format!("已停止 {} 服务端口 {} 上的进程（PID {}），已确认进程退出、端口已释放，内存已回收{}", key, port, pid_list, app_note))
    } else {
        Ok(format!("已停止 {} 服务端口 {} 上的进程（PID {}），其中 PID {} 常规终止未退出已强制结束；已确认端口已释放，内存已回收{}",
            key, port, pid_list, forced.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(", "), app_note))
    }
}

/// 开关关闭状态下的遗留进程对账（App 启动时由前端对每个「关着」的服务调用一次）：
/// 保证「开关关了 = 服务不常驻」跨重启也成立。处理三类遗留：
/// 1) 本 App 记录的托管 PID 还活着（App 上次异常退出/被强杀留下的孤儿进程）→ 确认式停止并清记录；
/// 2) 服务端口上命令行确属该服务的监听进程（ollama serve / ComfyUI main.py）→ 确认式停止；
/// 3) Ollama 端口仍被占且桌面应用在跑 → 退出该应用（它在守护服务）后再清一次。
/// 命令行对不上的未知进程不动，只在返回信息里如实说明。返回 (是否动了进程, 说明)。
#[tauri::command]
fn reconcile_local_service(key: String) -> Result<(bool, String), String> {
    let port = match service_port(&key) {
        Some(p) => p,
        None => return Ok((false, "未知服务".to_string())),
    };
    if key == "lmstudio" {
        return Ok((false, "LM Studio 不由本 App 托管".to_string()));
    }
    let mut acted = false;
    let mut notes: Vec<String> = Vec::new();
    // 1) 托管 PID 遗留
    let mut m = load_managed_pids();
    if let Some(pid) = m.remove(&key) {
        save_managed_pids(&m);
        if pid_alive(pid) {
            let (_d, _f, still) = stop_pids_confirmed(&[pid]);
            if still.is_empty() {
                acted = true;
                notes.push(format!("已停止上次遗留的 {} 服务进程（PID {}）", key, pid));
            }
        }
    }
    // 2) 端口上确属该服务的监听进程
    let matches_service = |pid: u32| -> bool {
        let cmd = pid_command(pid).to_lowercase();
        match key.as_str() {
            "ollama" => cmd.contains("ollama") && cmd.contains("serve"),
            "comfyui" => cmd.contains("main.py"),
            _ => false,
        }
    };
    let mut sweep_matching = |acted: &mut bool, notes: &mut Vec<String>| {
        let targets: Vec<u32> = port_listener_pids(port).into_iter().filter(|p| matches_service(*p)).collect();
        if !targets.is_empty() {
            let (_d, _f, still) = stop_pids_confirmed(&targets);
            let killed: Vec<u32> = targets.iter().copied().filter(|p| !still.contains(p)).collect();
            if !killed.is_empty() {
                *acted = true;
                notes.push(format!("已停止占用 {} 端口的 {} 服务进程（PID {}）",
                    port, key, killed.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(", ")));
            }
        }
    };
    sweep_matching(&mut acted, &mut notes);
    // 3) Ollama 应用守护兜底
    if key == "ollama" && !port_listener_pids(port).is_empty() && ollama_app_running() {
        if quit_ollama_app() {
            acted = true;
            notes.push("已退出 Ollama 应用（它在守护 11434 端口的服务）".to_string());
            sweep_matching(&mut acted, &mut notes);
        }
    }
    if !acted && !port_listener_pids(port).is_empty() {
        notes.push(format!("{} 端口被其他进程占用（非 {} 服务本身），未做处理", port, key));
    }
    Ok((acted, notes.join("；")))
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
    // 音频地址来自官方接口响应，下载前仍过一遍 SSRF 校验（v0.1.285）
    let audio_url = validate_proxy_url(&audio_url)?.to_string();
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

/// VoiceStudio 基址校验（v0.1.285 SSRF 收口）：本机/局域网或公网 https 才放行
fn vs_base_checked(endpoint: &str) -> Result<String, String> {
    validate_service_url(&vs_base(endpoint))
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
    let mut req = client.get(format!("{}/health", vs_base_checked(&endpoint)?));
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
    let mut req = client.get(format!("{}/profiles", vs_base_checked(&endpoint)?));
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
    let mut req = client.post(format!("{}/profiles", vs_base_checked(&endpoint)?))
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
    let mut req = client.post(format!("{}/v1/audio/speech", vs_base_checked(&endpoint)?))
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
/// 递归收集模型文件（相对名去重，总量上限 5000 条防失控目录）
fn walk_model_files(dir: &std::path::Path, rel: &str, out: &mut Vec<String>, seen: &mut std::collections::HashSet<String>) {
    if out.len() >= 5000 { return; }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                let name = e.file_name().to_string_lossy().to_string();
                let next = if rel.is_empty() { name } else { format!("{}/{}", rel, name) };
                walk_model_files(&p, &next, out, seen);
            } else if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
                if MODEL_FILE_EXTS.contains(&ext.to_ascii_lowercase().as_str()) {
                    let name = e.file_name().to_string_lossy().to_string();
                    let rel_name = if rel.is_empty() { name } else { format!("{}/{}", rel, name) };
                    if seen.insert(rel_name.clone()) { out.push(rel_name); }
                }
            }
        }
    }
}

fn scan_comfyui_models() -> Vec<String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let root = std::path::Path::new(&home).join("ComfyUI").join("models");
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    walk_model_files(&root, "", &mut out, &mut seen);
    out.sort();
    out
}

/// 从 Comfy Desktop 的 electron-store 配置（config.json）里泛化提取实例目录：
/// 不依赖其字段结构——收集所有「存在的绝对路径」字符串，取其 models 子目录。
/// 配置位置随版本/改名变化，逐个候选尝试。
fn comfy_desktop_models_roots() -> Vec<std::path::PathBuf> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let app_support = std::path::Path::new(&home).join("Library").join("Application Support");
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    fn collect_paths(v: &serde_json::Value, acc: &mut Vec<String>) {
        match v {
            serde_json::Value::String(s) => { if s.starts_with('/') { acc.push(s.clone()); } }
            serde_json::Value::Array(a) => { for x in a { collect_paths(x, acc); } }
            serde_json::Value::Object(m) => { for (_, x) in m { collect_paths(x, acc); } }
            _ => {}
        }
    }
    for name in ["Comfy Desktop", "ComfyUI", "Comfy", "comfyui-electron"] {
        let cfg = app_support.join(name).join("config.json");
        let Ok(text) = std::fs::read_to_string(&cfg) else { continue };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        let mut paths = Vec::new();
        collect_paths(&json, &mut paths);
        for p in paths {
            let dir = std::path::PathBuf::from(&p);
            if !dir.is_dir() { continue; }
            if dir.file_name().map(|n| n == "models").unwrap_or(false) {
                if !roots.contains(&dir) { roots.push(dir.clone()); }
            }
            let models = dir.join("models");
            if models.is_dir() && !roots.contains(&models) { roots.push(models); }
        }
    }
    roots
}

/// 解析某 ComfyUI 安装目录下的 extra_model_paths.yaml，返回 (分类, 目录) 列表（仅保留真实存在的目录）
fn extra_model_path_dirs(install_root: &std::path::Path) -> Vec<(String, std::path::PathBuf)> {
    let yaml = install_root.join("extra_model_paths.yaml");
    let Ok(text) = std::fs::read_to_string(&yaml) else { return Vec::new() };
    const CATS: [&str; 18] = ["checkpoints", "loras", "vae", "controlnet", "animatediff_models", "upscale_models", "embeddings", "clip", "unet", "diffusion_models", "text_encoders", "clip_vision", "style_models", "gligen", "hypernetworks", "photomaker", "classifiers", "animatediff_motion_lora"];
    let mut base_path: Option<std::path::PathBuf> = None;
    let mut pairs: Vec<(String, String)> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') { continue; }
        let Some((k, v)) = line.split_once(':') else { continue };
        let key = k.trim().to_string();
        let val = v.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
        if val.is_empty() { continue; }
        if key == "base_path" { base_path = Some(std::path::PathBuf::from(&val)); }
        else if CATS.contains(&key.as_str()) { pairs.push((key, val)); }
    }
    let mut out = Vec::new();
    for (key, val) in pairs {
        let p = std::path::PathBuf::from(&val);
        let resolved = if p.is_absolute() { p } else if let Some(b) = &base_path { b.join(&p) } else { install_root.join(&p) };
        if resolved.is_dir() { out.push((key, resolved)); }
    }
    out
}

/// 扩展扫描：固定目录 + Comfy Desktop 实例目录 + 各安装目录 extra_model_paths.yaml 指向的分类目录
fn scan_comfyui_models_extended() -> Vec<String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let home_root = std::path::Path::new(&home).join("ComfyUI");
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    walk_model_files(&home_root.join("models"), "", &mut out, &mut seen);
    for (cat, dir) in extra_model_path_dirs(&home_root) {
        walk_model_files(&dir, &cat, &mut out, &mut seen);
    }
    for models_root in comfy_desktop_models_roots() {
        walk_model_files(&models_root, "", &mut out, &mut seen);
        if let Some(install_root) = models_root.parent() {
            for (cat, dir) in extra_model_path_dirs(install_root) {
                walk_model_files(&dir, &cat, &mut out, &mut seen);
            }
        }
    }
    out.sort();
    out
}

/// ComfyUI 原生 API 桥接：endpoint 为相对路径（如 "prompt" / "history/<id>" / "view?filename=...&type=output"）。
/// method=POST 时 body_json 为请求体；want_image=true 时把响应二进制转 base64 返回（用于 /view 取图）。
/// 仅允许本机/局域网地址（validate_local_service_url，v0.1.285 起收紧：此前公网 https 也可达）。
#[tauri::command]
async fn comfyui_api(base_url: String, endpoint: String, method: String, body_json: String, want_image: bool) -> Result<String, String> {
    let base = validate_local_service_url(base_url.trim().trim_end_matches('/'))?;
    // endpoint 只允许简单路径与查询串，禁止 //、.. 防止路径穿越
    if endpoint.contains("..") || endpoint.starts_with("//") { return Err("非法端点".into()) }
    let url = format!("{}/{}", base, endpoint.trim_start_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(if want_image { 60 } else { 30 }))
        .redirect(reqwest::redirect::Policy::none())
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
    // validate_local_service_url 已处理尾斜杠（Url 序列化补的尾斜杠会拼出 //object_info 双斜杠被 aiohttp 404）
    let base = validate_local_service_url(base_url.trim().trim_end_matches('/'))?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
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
async fn fetch_local_models(key: String, url: String, scan_extra: bool) -> Result<Vec<String>, String> {
    let base = url.trim().trim_end_matches('/');
    if key == "comfyui" {
        // ComfyUI 无标准已加载模型 API，扫描 models 目录下的模型文件；
        // scan_extra（设置开关）时同时覆盖 Comfy Desktop 实例目录与 extra_model_paths.yaml
        let models = if scan_extra { scan_comfyui_models_extended() } else { scan_comfyui_models() };
        if models.is_empty() {
            return Err(if scan_extra {
                "未在 ~/ComfyUI/models 与 Comfy Desktop 实例目录下找到模型文件（支持 gguf/safetensors/ckpt/bin）".to_string()
            } else {
                "未在 ~/ComfyUI/models 下找到模型文件（支持 gguf/safetensors/ckpt/bin）".to_string()
            })
        }
        return Ok(models)
    }
    let base = validate_local_service_url(base)?;
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
    let base = validate_local_service_url(base)?;
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

// ================= 桌面外壳：托盘常驻 / 菜单栏迷你窗 / 全局快捷键 / 开机自启 =================
use tauri::menu::{MenuBuilder, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};
use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const TRAY_ID: &str = "acm-tray";
const MINI_LABEL: &str = "mini";

/// 图标显示模式：both（Dock+菜单栏）/ dock（仅 Dock，关主窗即退出）/ menubar（仅菜单栏）
static ICON_MODE: OnceLock<std::sync::Mutex<String>> = OnceLock::new();

fn icon_mode() -> String {
    ICON_MODE
        .get_or_init(|| std::sync::Mutex::new("both".to_string()))
        .lock()
        .map(|g| g.clone())
        .unwrap_or_else(|_| "both".to_string())
}

fn set_icon_mode(mode: &str) {
    if let Ok(mut g) = ICON_MODE.get_or_init(|| std::sync::Mutex::new("both".to_string())).lock() {
        *g = mode.to_string();
    }
}

/// 迷你窗闲置自动关闭：代次（每次显示 +1，旧计时作废）/ 鼠标悬停中 / 已有交互
static MINI_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static MINI_HOVER: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static MINI_INTERACTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 迷你窗显示后启动闲置计时：无任何交互、且鼠标不在窗口上时，约 5 秒后自动隐藏。
/// 鼠标悬停会清零计时；一旦有交互（前端上报）本次显示不再自动关闭。
fn arm_mini_autohide(app: tauri::AppHandle) {
    use std::sync::atomic::Ordering;
    let gen = MINI_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    MINI_INTERACTED.store(false, Ordering::SeqCst);
    MINI_HOVER.store(false, Ordering::SeqCst);
    std::thread::spawn(move || {
        let mut idle_ms: u64 = 0;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(250));
            if MINI_GEN.load(Ordering::SeqCst) != gen {
                return;
            }
            if MINI_INTERACTED.load(Ordering::SeqCst) {
                return;
            }
            let Some(w) = app.get_webview_window(MINI_LABEL) else { return };
            if !w.is_visible().unwrap_or(false) {
                return;
            }
            if MINI_HOVER.load(Ordering::SeqCst) {
                idle_ms = 0;
                continue;
            }
            idle_ms += 250;
            if idle_ms >= 5000 {
                let _ = w.hide();
                return;
            }
        }
    });
}

/// 前端上报：鼠标是否悬停在迷你窗上
#[tauri::command]
fn mini_hover(inside: bool) {
    MINI_HOVER.store(inside, std::sync::atomic::Ordering::SeqCst);
}

/// 前端上报：用户在迷你窗内有操作（点击/按键），本次显示取消自动关闭
#[tauri::command]
fn mini_interacted() {
    MINI_INTERACTED.store(true, std::sync::atomic::Ordering::SeqCst);
}

/// 前端下发图标显示模式：both / dock / menubar
#[tauri::command]
fn icon_display_apply(app: tauri::AppHandle, mode: String) {
    set_icon_mode(&mode);
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_visible(mode != "dock");
    }
    #[cfg(target_os = "macos")]
    {
        let policy = if mode == "menubar" {
            tauri::ActivationPolicy::Accessory
        } else {
            tauri::ActivationPolicy::Regular
        };
        let _ = app.set_activation_policy(policy);
    }
}

// ===== 本地统一网关：OpenAI 兼容代理（仅监听 127.0.0.1，真实 Key 只存进程内存） =====
// 前端在保险箱解锁后把「模型 id → 上游账户列表」路由表下发到这里；本地工具（Cursor 等）
// 以 http://127.0.0.1:<port>/v1 + 网关令牌调用，按模型名路由到真实账户；
// 上游报错（401/403/429/5xx）或连接失败时自动换下一个账户重试（故障转移）。
// gateway_stop 会清掉路由与令牌；应用退出后内存路由自然消失，不落盘。

#[derive(serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GatewayRouteIn {
    base_url: String,
    api_key: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GatewayStatus {
    running: bool,
    port: u16,
    route_count: usize,
    model_count: usize,
    requests: u64,
}

struct GatewayInner {
    running: bool,
    port: u16,
    token: String,
    routes: std::collections::HashMap<String, Vec<GatewayRouteIn>>,
    requests: u64,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

static GATEWAY: OnceLock<std::sync::Mutex<GatewayInner>> = OnceLock::new();

fn gateway_inner() -> &'static std::sync::Mutex<GatewayInner> {
    GATEWAY.get_or_init(|| std::sync::Mutex::new(GatewayInner {
        running: false,
        port: 0,
        token: String::new(),
        routes: std::collections::HashMap::new(),
        requests: 0,
        stop: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
    }))
}

fn gateway_blocking_client() -> &'static reqwest::blocking::Client {
    static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .user_agent("ai-credit-manager-gateway/0.1")
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(180))
            .build()
            .expect("初始化网关 HTTP 客户端失败")
    })
}

#[tauri::command]
fn gateway_set_routes(routes: std::collections::HashMap<String, Vec<GatewayRouteIn>>) -> Result<usize, String> {
    let mut g = gateway_inner().lock().map_err(|_| "网关状态锁定失败".to_string())?;
    let models = routes.len();
    g.routes = routes;
    Ok(models)
}

#[tauri::command]
fn gateway_start(port: u16, token: String) -> Result<String, String> {
    if token.trim().is_empty() {
        return Err("网关令牌为空，先在设置里生成令牌".to_string());
    }
    let stop;
    {
        let mut g = gateway_inner().lock().map_err(|_| "网关状态锁定失败".to_string())?;
        if g.running && g.port == port {
            g.token = token;
            return Ok(format!("网关已在运行：http://127.0.0.1:{}/v1", port));
        }
        if g.running {
            g.stop.store(true, std::sync::atomic::Ordering::SeqCst);
            g.running = false;
        }
        stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        g.stop = stop.clone();
        g.port = port;
        g.token = token;
    }
    let listener = std::net::TcpListener::bind(("127.0.0.1", port))
        .map_err(|e| format!("端口 {} 绑定失败：{}", port, e))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    {
        let mut g = gateway_inner().lock().map_err(|_| "网关状态锁定失败".to_string())?;
        g.running = true;
    }
    std::thread::spawn(move || {
        while !stop.load(std::sync::atomic::Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => {
                    std::thread::spawn(move || gateway_handle_conn(stream));
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(std::time::Duration::from_millis(120));
                }
                Err(_) => break,
            }
        }
    });
    Ok(format!("网关已开启：http://127.0.0.1:{}/v1", port))
}

#[tauri::command]
fn gateway_stop() -> Result<(), String> {
    let mut g = gateway_inner().lock().map_err(|_| "网关状态锁定失败".to_string())?;
    g.stop.store(true, std::sync::atomic::Ordering::SeqCst);
    g.running = false;
    g.routes.clear();
    g.token.clear();
    Ok(())
}

#[tauri::command]
fn gateway_status() -> GatewayStatus {
    match gateway_inner().lock() {
        Ok(g) => GatewayStatus {
            running: g.running,
            port: g.port,
            route_count: g.routes.values().map(|v| v.len()).sum(),
            model_count: g.routes.len(),
            requests: g.requests,
        },
        Err(_) => GatewayStatus { running: false, port: 0, route_count: 0, model_count: 0, requests: 0 },
    }
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() { return None; }
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn gateway_write(stream: &mut std::net::TcpStream, status: u16, reason: &str, content_type: &str, body: &[u8]) {
    use std::io::Write;
    let head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        status, reason, content_type, body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

fn gateway_err_json(stream: &mut std::net::TcpStream, status: u16, reason: &str, msg: &str) {
    let body = serde_json::json!({ "error": { "message": msg, "type": "gateway_error" } }).to_string();
    gateway_write(stream, status, reason, "application/json", body.as_bytes());
}

fn gateway_handle_conn(mut stream: std::net::TcpStream) {
    use std::io::{Read, Write};
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(180)));
    let mut buf: Vec<u8> = Vec::with_capacity(8192);
    let mut chunk = [0u8; 8192];
    let head_end;
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => return,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if let Some(pos) = find_subslice(&buf, b"\r\n\r\n") {
                    head_end = pos + 4;
                    break;
                }
                if buf.len() > 65536 { return; }
            }
            Err(_) => return,
        }
    }
    let head_text = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head_text.lines();
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();
    let mut content_length: usize = 0;
    let mut authorization = String::new();
    let mut expect_continue = false;
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            let key = k.trim().to_ascii_lowercase();
            let val = v.trim().to_string();
            match key.as_str() {
                "content-length" => content_length = val.parse().unwrap_or(0),
                "authorization" => authorization = val,
                "expect" => expect_continue = val.eq_ignore_ascii_case("100-continue"),
                _ => {}
            }
        }
    }
    if expect_continue {
        let _ = stream.write_all(b"HTTP/1.1 100 Continue\r\n\r\n");
        let _ = stream.flush();
    }
    let mut body: Vec<u8> = buf.split_off(head_end);
    while body.len() < content_length {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => body.extend_from_slice(&chunk[..n]),
            Err(_) => break,
        }
        if body.len() > 33_554_432 { return; }
    }
    body.truncate(content_length);

    let (token, routes_snapshot) = {
        let g = match gateway_inner().lock() { Ok(g) => g, Err(_) => return };
        (g.token.clone(), g.routes.clone())
    };
    if path.starts_with("/v1/") {
        if token.is_empty() || authorization != format!("Bearer {}", token) {
            gateway_err_json(&mut stream, 401, "Unauthorized", "网关令牌不正确（Authorization: Bearer <令牌>）");
            return;
        }
    } else if path == "/" || path == "/health" {
        let body = serde_json::json!({ "ok": true, "service": "ai-credit-manager gateway" }).to_string();
        gateway_write(&mut stream, 200, "OK", "application/json", body.as_bytes());
        return;
    } else {
        gateway_err_json(&mut stream, 404, "Not Found", "路径不存在");
        return;
    }

    if method == "GET" && path == "/v1/models" {
        let data: Vec<serde_json::Value> = routes_snapshot.keys()
            .map(|id| serde_json::json!({ "id": id, "object": "model", "owned_by": "ai-credit-manager" }))
            .collect();
        let body = serde_json::json!({ "object": "list", "data": data }).to_string();
        gateway_write(&mut stream, 200, "OK", "application/json", body.as_bytes());
        return;
    }
    if !(method == "POST" && path == "/v1/chat/completions") {
        gateway_err_json(&mut stream, 404, "Not Found", "仅支持 GET /v1/models 与 POST /v1/chat/completions");
        return;
    }

    let req_json: serde_json::Value = serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
    let model = req_json.get("model").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let want_stream = req_json.get("stream").and_then(|v| v.as_bool()).unwrap_or(false);
    let candidates = match routes_snapshot.get(&model) {
        Some(list) if !list.is_empty() => list.clone(),
        _ => {
            gateway_err_json(&mut stream, 404, "Not Found", &format!("模型 {} 未注册路由（开启网关时按账户引擎目录注册）", model));
            return;
        }
    };
    if let Ok(mut g) = gateway_inner().lock() { g.requests += 1; }

    let client = gateway_blocking_client();
    let mut last_err = String::new();
    for (idx, route) in candidates.iter().enumerate() {
        let url = format!("{}/chat/completions", route.base_url.trim_end_matches('/'));
        let resp = client.post(&url)
            .header("Authorization", format!("Bearer {}", route.api_key))
            .header("Content-Type", "application/json")
            .body(body.clone())
            .send();
        let mut resp = match resp {
            Ok(r) => r,
            Err(e) => { last_err = format!("连接上游失败：{}", e); continue; }
        };
        let status = resp.status();
        let failover_worthy = status.as_u16() == 401 || status.as_u16() == 403 || status.as_u16() == 429 || status.is_server_error();
        if failover_worthy && idx + 1 < candidates.len() {
            last_err = format!("上游返回 {}", status);
            continue;
        }
        let reason = status.canonical_reason().unwrap_or("");
        let content_type = resp.headers().get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok()).unwrap_or("application/json").to_string();
        if want_stream || content_type.contains("text/event-stream") {
            let head = format!(
                "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nConnection: close\r\nCache-Control: no-cache\r\n\r\n",
                status.as_u16(), reason, content_type
            );
            if stream.write_all(head.as_bytes()).is_err() { return; }
            let mut rbuf = [0u8; 8192];
            loop {
                match resp.read(&mut rbuf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if stream.write_all(&rbuf[..n]).is_err() { return; }
                        let _ = stream.flush();
                    }
                    Err(_) => break,
                }
            }
            let _ = stream.flush();
        } else {
            match resp.bytes() {
                Ok(bytes) => gateway_write(&mut stream, status.as_u16(), reason, &content_type, &bytes),
                Err(e) => gateway_err_json(&mut stream, 502, "Bad Gateway", &format!("读取上游响应失败：{}", e)),
            }
        }
        return;
    }
    gateway_err_json(&mut stream, 502, "Bad Gateway", &format!("所有上游账户均不可用：{}", last_err));
}

/// 最近一次托盘图标的物理矩形（x, y, w, h）：迷你窗据此定位到图标正下方弹出
static TRAY_RECT: OnceLock<std::sync::Mutex<Option<(i32, i32, i32, i32)>>> = OnceLock::new();

fn tray_rect_store() -> &'static std::sync::Mutex<Option<(i32, i32, i32, i32)>> {
    TRAY_RECT.get_or_init(|| std::sync::Mutex::new(None))
}

fn show_main_window(app: &tauri::AppHandle, section: Option<&str>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        if let Some(s) = section {
            let _ = w.emit("acm-navigate", s);
        }
    }
}

fn toggle_mini_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window(MINI_LABEL) {
        if w.is_visible().unwrap_or(false) {
            MINI_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let _ = w.hide();
        } else {
            // 定位：优先贴托盘图标正下方弹出（与图标水平居中对齐）；从未点过托盘
            // （快捷键呼出）时退回主显示器右上角。全部用物理像素计算——逻辑宽度
            // 直接相减会在 Retina 屏上让窗口溢出屏幕右缘、右侧数据被切掉。
            if let Ok(Some(monitor)) = w.primary_monitor() {
                let scale = monitor.scale_factor();
                let mon_w = monitor.size().width as i32;
                let mon_h = monitor.size().height as i32;
                let win_w = w.outer_size().map(|s| s.width as i32).unwrap_or((348.0 * scale) as i32);
                let win_h = w.outer_size().map(|s| s.height as i32).unwrap_or((470.0 * scale) as i32);
                let edge = (8.0 * scale) as i32;
                let gap = (4.0 * scale) as i32;
                let anchored = tray_rect_store().lock().ok().and_then(|g| *g);
                let (x, y) = match anchored {
                    Some((rx, ry, rw, rh)) => {
                        let cx = rx + rw / 2;
                        let x = (cx - win_w / 2).clamp(edge, (mon_w - win_w - edge).max(edge));
                        // 图标在屏幕上半部（macOS 菜单栏）→ 窗口在其下方；下半部（Windows 任务栏）→ 窗口在其上方
                        let y = if ry + rh / 2 <= mon_h / 2 { ry + rh + gap } else { (ry - win_h - gap).max(edge) };
                        (x, y)
                    }
                    None => ((mon_w - win_w - (12.0 * scale) as i32).max(0), (32.0 * scale) as i32),
                };
                let _ = w.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(x, y)));
            }
            let _ = w.show();
            let _ = w.set_focus();
            arm_mini_autohide(app.clone());
        }
    }
}

/// 前端下发快捷键设置：先注销全部，再按开关与自定义组合重新注册（设置页动态生效）
#[tauri::command]
fn shortcuts_apply(app: tauri::AppHandle, enabled: bool, ai: Option<String>, mini: Option<String>) -> Result<(), String> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    if !enabled {
        return Ok(());
    }
    let parse = |s: Option<String>| -> Result<Option<Shortcut>, String> {
        match s {
            None => Ok(None),
            Some(v) => v
                .parse::<Shortcut>()
                .map(Some)
                .map_err(|e| format!("快捷键格式无效（{v}）：{e}")),
        }
    };
    if let Some(sc) = parse(ai)? {
        let h = app.clone();
        gs.on_shortcut(sc, move |_app, _s, event| {
            if event.state == ShortcutState::Pressed {
                show_main_window(&h, Some("ai"));
            }
        })
        .map_err(|e| format!("注册 AI 助手快捷键失败（可能被其他应用占用）：{e}"))?;
    }
    if let Some(sc) = parse(mini)? {
        let h = app.clone();
        gs.on_shortcut(sc, move |_app, _s, event| {
            if event.state == ShortcutState::Pressed {
                toggle_mini_window(&h);
            }
        })
        .map_err(|e| format!("注册迷你窗快捷键失败（可能被其他应用占用）：{e}"))?;
    }
    Ok(())
}

/// 显示主窗口并（可选）跳转到指定页签（迷你窗/托盘/快捷键共用）
#[tauri::command]
fn show_main(app: tauri::AppHandle, section: Option<String>) {
    show_main_window(&app, section.as_deref());
}

#[tauri::command]
fn mini_hide(app: tauri::AppHandle) {
    MINI_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    if let Some(w) = app.get_webview_window(MINI_LABEL) {
        let _ = w.hide();
    }
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Mac 系统毛玻璃增强（v0.1.293）：液态玻璃风格开启时给主窗口挂系统
/// NSVisualEffectView（Sidebar 材质）作底材，前端再把壳/侧边栏底色调透让它透上来；
/// 关闭即撤除。窗口透明由 tauri.macos.conf.json 的 transparent + macOSPrivateApi 保证。
/// 非 macOS 平台为空操作（CSS 液态玻璃在所有平台都有效，系统底材只是 Mac 的增强）。
#[tauri::command]
fn set_window_glass(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::window::{Effect, EffectState, Effects};
        if let Some(w) = app.get_webview_window("main") {
            if enabled {
                let _ = w.set_effects(Some(Effects {
                    effects: vec![Effect::Sidebar],
                    state: Some(EffectState::Active),
                    radius: None,
                    color: None,
                }));
            } else {
                let _ = w.set_effects(None);
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, enabled);
    }
    Ok(())
}

#[tauri::command]
fn autostart_is_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn autostart_set(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let m = app.autolaunch();
    if enabled { m.enable() } else { m.disable() }.map_err(|e| e.to_string())
}

fn setup_desktop_shell(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();

    // 主窗口关闭行为随图标模式：菜单栏常驻（both/menubar）时隐藏到托盘；仅 Dock 时关窗即退出
    if let Some(main) = app.get_webview_window("main") {
        let main_for_event = main.clone();
        let handle_for_event = handle.clone();
        main.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if icon_mode() == "dock" {
                    handle_for_event.exit(0);
                } else {
                    api.prevent_close();
                    let _ = main_for_event.hide();
                }
            }
        });
    }

    // 迷你窗：隐藏创建，点托盘图标或快捷键时在右上角切换显隐
    let mini = tauri::WebviewWindowBuilder::new(app.handle(), MINI_LABEL, tauri::WebviewUrl::App("index.html#/mini".into()))
        .title("AI 积分管家 · 速览")
        .inner_size(348.0, 470.0)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .build()?;
    let mini_for_event = mini.clone();
    let handle_for_mini = handle.clone();
    mini.on_window_event(move |event| {
        match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = mini_for_event.hide();
            }
            // 点击窗口之外（桌面 / 其他应用 / 主窗口）→ 收起，原生弹出层行为。
            // 延迟 200ms 并校验代次：点托盘图标切换时由切换逻辑先处理，避免刚关又开。
            tauri::WindowEvent::Focused(false) => {
                let gen = MINI_GEN.load(std::sync::atomic::Ordering::SeqCst);
                let app = handle_for_mini.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(200));
                    if MINI_GEN.load(std::sync::atomic::Ordering::SeqCst) != gen {
                        return;
                    }
                    if let Some(w) = app.get_webview_window(MINI_LABEL) {
                        if w.is_visible().unwrap_or(false) && !w.is_focused().unwrap_or(false) {
                            let _ = w.hide();
                        }
                    }
                });
            }
            _ => {}
        }
    });

    // 托盘菜单（右键）：打开主窗口 / AI 助手 / 今日签到 / 退出
    let menu = MenuBuilder::new(app.handle())
        .item(&MenuItem::with_id(app.handle(), "open-main", "打开主窗口", true, None::<&str>)?)
        .item(&MenuItem::with_id(app.handle(), "open-ai", "AI 助手", true, None::<&str>)?)
        .item(&MenuItem::with_id(app.handle(), "open-checkin", "今日签到", true, None::<&str>)?)
        .separator()
        .item(&MenuItem::with_id(app.handle(), "quit", "退出 AI 积分管家", true, None::<&str>)?)
        .build()?;

    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("AI 积分管家")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open-main" => show_main_window(app, None),
            "open-ai" => show_main_window(app, Some("ai")),
            "open-checkin" => show_main_window(app, Some("checkin")),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, rect, .. } = event {
                // 记住托盘图标位置，迷你窗据此定位到图标正下方
                let app = tray.app_handle();
                let scale = app
                    .get_webview_window(MINI_LABEL)
                    .and_then(|w| w.primary_monitor().ok().flatten())
                    .map(|m| m.scale_factor())
                    .unwrap_or(2.0);
                let p: tauri::PhysicalPosition<i32> = rect.position.to_physical(scale);
                let s: tauri::PhysicalSize<u32> = rect.size.to_physical(scale);
                if let Ok(mut g) = tray_rect_store().lock() {
                    *g = Some((p.x, p.y, s.width as i32, s.height as i32));
                }
                toggle_mini_window(app);
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;

    // 全局快捷键：Cmd/Ctrl+Shift+A 呼出 AI 助手；Cmd/Ctrl+Shift+M 切换迷你窗
    #[cfg(target_os = "macos")]
    let mods = Modifiers::SUPER | Modifiers::SHIFT;
    #[cfg(not(target_os = "macos"))]
    let mods = Modifiers::CONTROL | Modifiers::SHIFT;
    let h1 = handle.clone();
    app.global_shortcut().on_shortcut(Shortcut::new(Some(mods), Code::KeyA), move |_app, _sc, event| {
        if event.state == ShortcutState::Pressed {
            show_main_window(&h1, Some("ai"));
        }
    })?;
    let h2 = handle;
    app.global_shortcut().on_shortcut(Shortcut::new(Some(mods), Code::KeyM), move |_app, _sc, event| {
        if event.state == ShortcutState::Pressed {
            toggle_mini_window(&h2);
        }
    })?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None::<Vec<&str>>))
        .register_uri_scheme_protocol("acmplugin", |_app, request| plugin_frame_response(request))
        .setup(|app| setup_desktop_shell(app))
        .invoke_handler(tauri::generate_handler![proxy_usage, call_provider_api, call_cloud_llm, send_notification, open_url, open_mic_settings, open_speech_settings, biometric_available, biometric_auth, choose_save_dir, write_file_to_dir, write_binary_to_dir, is_app_installed, open_local_app, detect_local_services, get_system_memory_gb, check_local_service, start_local_service, stop_local_service, is_service_app_managed, tts_test_direct, tts_clone_direct, tts_synthesize_direct, voicestudio_test, voicestudio_list, voicestudio_clone, voicestudio_synthesize, fetch_local_models, choose_model_file, ollama_embed, stop_service_by_port, reconcile_local_service, comfyui_api, comfyui_checkpoints, show_main, mini_hide, quit_app, set_window_glass, autostart_is_enabled, autostart_set, shortcuts_apply, mini_hover, mini_interacted, icon_display_apply, gateway_set_routes, gateway_start, gateway_stop, gateway_status, plugin_http, plugin_frame_put, plugin_frame_remove, plugin_process_start, plugin_process_stop, plugin_process_running, plugin_process_output, mcp_start, mcp_write, mcp_read, mcp_stop, mcp_running, mcp_logs])
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
