// 邮箱工具（v0.1.436）：桌面端 IMAP 传输层。
// 只做「连接 + 命令往返 + IDLE 长连接事件」的薄传输：协议解析（文件夹 / 信封 / MIME）
// 全部在前端 src/core/mail.ts 完成，方便用假 IMAP 服务器的真实报文做回归测试。
// 前端命令契约（Tauri 自动映射 JS 驼峰参数）：
//   mail_imap_connect / mail_imap_disconnect / mail_imap_list_folders /
//   mail_imap_fetch_headers / mail_imap_fetch_message / mail_imap_store_flags /
//   mail_imap_delete_messages / mail_imap_folder_counts /
//   mail_imap_idle_start / mail_imap_idle_stop /
//   mail_oauth_listen_start / mail_oauth_listen_result

use std::collections::HashMap;
use std::io::{Read as StdRead, Write as StdWrite};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, ReadHalf, WriteHalf};
use tokio::net::TcpStream;
use tokio::sync::Mutex;

/// dyn 不能同时挂两个非 auto trait，用一个汇总 trait 包住读写两面。
trait MailStream: tokio::io::AsyncRead + tokio::io::AsyncWrite {}
impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite> MailStream for T {}

// v0.1.445：连接验证全链路超时预算（秒）。436 的教训：greeting / XOAUTH2 质询等读取
// 没有超时，服务器在某一步不说话就会让界面无限转圈。现在每一步都有上限且报错指明步骤，
// 各步之和 ≤ 总时长上限（60 秒，由 mail_imap_connect 兜底中止）。
const TCP_TIMEOUT_SECS: u64 = 10;
const TLS_TIMEOUT_SECS: u64 = 10;
const GREETING_TIMEOUT_SECS: u64 = 10;
const LOGIN_TIMEOUT_SECS: u64 = 15;
const CAPABILITY_TIMEOUT_SECS: u64 = 10;
const COMMAND_TIMEOUT_SECS: u64 = 30;
const IDLE_STEP_TIMEOUT_SECS: u64 = 15;
const VERIFY_TOTAL_TIMEOUT_SECS: u64 = 60;

type BoxStream = Box<dyn MailStream + Unpin + Send>;

enum Seg {
    Line(String),
    Bytes(Vec<u8>),
}

struct ImapConn {
    reader: BufReader<ReadHalf<BoxStream>>,
    writer: WriteHalf<BoxStream>,
    tag_seq: u32,
}

impl ImapConn {
    fn next_tag(&mut self) -> String {
        self.tag_seq += 1;
        format!("a{}", self.tag_seq)
    }

    async fn write_raw(&mut self, data: &str) -> Result<(), String> {
        self.writer
            .write_all(data.as_bytes())
            .await
            .map_err(|e| format!("发送失败：{e}"))?;
        self.writer.flush().await.map_err(|e| format!("发送失败：{e}"))?;
        Ok(())
    }

    async fn write_line(&mut self, line: &str) -> Result<(), String> {
        self.write_raw(&format!("{line}\r\n")).await
    }

    async fn read_line(&mut self) -> Result<String, String> {
        let mut buf: Vec<u8> = Vec::new();
        let n = self
            .reader
            .read_until(b'\n', &mut buf)
            .await
            .map_err(|e| format!("读取失败：{e}"))?;
        if n == 0 {
            return Err("连接已被服务器断开".to_string());
        }
        Ok(String::from_utf8_lossy(&buf).trim_end_matches(['\r', '\n']).to_string())
    }

    /// 带步骤名与超时的 read_line：超时/失败都指明卡在哪一步（v0.1.445）。
    async fn read_line_step(&mut self, step: &str, secs: u64) -> Result<String, String> {
        match tokio::time::timeout(
            std::time::Duration::from_secs(secs),
            self.read_line(),
        )
        .await
        {
            Ok(Ok(line)) => Ok(line),
            Ok(Err(e)) => Err(format!("{step}失败：{e}")),
            Err(_) => Err(format!("{step}超时（{secs} 秒内服务器没有响应）")),
        }
    }

    /// 读一段以 tag 完成行结束的完整响应；行尾 {n} 字面量读成 Bytes 段。
    async fn read_response(&mut self, tag: &str) -> Result<Vec<Seg>, String> {
        let mut segs: Vec<Seg> = Vec::new();
        loop {
            let line = self.read_line().await?;
            let is_done = line.starts_with(&format!("{tag} "));
            let mut lit: Option<usize> = None;
            let t = line.trim_end();
            if t.ends_with('}') {
                if let Some(open) = t.rfind('{') {
                    let inner = &t[open + 1..t.len() - 1];
                    let inner = inner.strip_suffix('+').unwrap_or(inner);
                    if let Ok(n) = inner.parse::<usize>() {
                        lit = Some(n);
                    }
                }
            }
            segs.push(Seg::Line(line));
            if let Some(n) = lit {
                let mut bytes = vec![0u8; n];
                self.reader
                    .read_exact(&mut bytes)
                    .await
                    .map_err(|e| format!("读取邮件内容失败：{e}"))?;
                segs.push(Seg::Bytes(bytes));
            }
            if is_done {
                return Ok(segs);
            }
        }
    }

    /// 发一条命令并等完成行；NO/BAD 时把服务器完成行原文作为错误返回（真实原因，不加工）。
    async fn command(&mut self, cmd: &str) -> Result<Vec<Seg>, String> {
        self.command_t(cmd, COMMAND_TIMEOUT_SECS).await
    }

    /// 同 command，但可指定超时；超时报错带命令动词与秒数（只用动词，绝不回显
    /// LOGIN 的完整命令——里面含授权码/令牌）。
    async fn command_t(&mut self, cmd: &str, secs: u64) -> Result<Vec<Seg>, String> {
        let tag = self.next_tag();
        self.write_line(&format!("{tag} {cmd}")).await?;
        let mut words = cmd.split_whitespace();
        let verb = match words.next() {
            Some("UID") => match words.next() {
                Some(sub) => format!("UID {sub}"),
                None => "UID".to_string(),
            },
            Some(w) => w.to_string(),
            None => "命令".to_string(),
        };
        let segs = tokio::time::timeout(
            std::time::Duration::from_secs(secs),
            self.read_response(&tag),
        )
        .await
        .map_err(|_| format!("服务器响应超时（命令 {verb}，{secs} 秒内未返回完整结果）"))??;
        let last = segs
            .iter()
            .rev()
            .find_map(|s| match s {
                Seg::Line(l) => Some(l.clone()),
                _ => None,
            })
            .unwrap_or_default();
        let rest = last.strip_prefix(&format!("{tag} ")).unwrap_or("");
        if rest.starts_with("OK") {
            Ok(segs)
        } else {
            Err(last)
        }
    }
}

fn flatten(segs: &[Seg]) -> String {
    let mut out = String::new();
    for s in segs {
        match s {
            Seg::Line(l) => {
                out.push_str(l);
                out.push_str("\r\n");
            }
            Seg::Bytes(b) => out.push_str(&String::from_utf8_lossy(b)),
        }
    }
    out
}

fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn parse_caps(flat: &str) -> String {
    for line in flat.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("* CAPABILITY") {
            return rest.trim().to_string();
        }
    }
    String::new()
}

fn parse_exists(flat: &str) -> i64 {
    for line in flat.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("* ") {
            if let Some(num) = rest.strip_suffix(" EXISTS") {
                if let Ok(n) = num.trim().parse::<i64>() {
                    return n;
                }
            }
        }
    }
    0
}

#[derive(Clone)]
struct Session {
    conn: Arc<Mutex<ImapConn>>,
    caps: String,
}

struct OAuthSlot {
    result: Arc<StdMutex<Option<OAuthResult>>>,
}

#[derive(Clone, serde::Serialize)]
pub struct OAuthResult {
    code: Option<String>,
    error: Option<String>,
}

struct MailGlobals {
    sessions: Mutex<HashMap<String, Session>>,
    idle_stops: Mutex<HashMap<String, Arc<AtomicBool>>>,
    oauth: StdMutex<Option<OAuthSlot>>,
    /// v0.1.445：进行中的连接验证任务，前端「取消验证」靠它真正掐断在途连接。
    pending_connects: Mutex<HashMap<String, tokio::task::AbortHandle>>,
}

fn globals() -> &'static MailGlobals {
    static G: OnceLock<MailGlobals> = OnceLock::new();
    G.get_or_init(|| MailGlobals {
        sessions: Mutex::new(HashMap::new()),
        idle_stops: Mutex::new(HashMap::new()),
        oauth: StdMutex::new(None),
        pending_connects: Mutex::new(HashMap::new()),
    })
}

/// v0.1.447：进程级安装 rustls CryptoProvider。
/// lib::run() 首行与本模块建连前都会调用；集成测试调用同一个函数，
/// 保证测试与生产走同一条初始化路径。
pub fn ensure_crypto_provider() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        // ring 已在依赖树里（Cargo.toml 显式启用 rustls 的 ring feature），
        // 不引入 aws-lc-rs 的额外体积。install 失败只可能是已装过，忽略即可。
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// TLS 根证书库：生产用 webpki 系统根；集成测试可额外注入一张本地自签证书
/// （tests/mail_tls_integration.rs），其余建连代码与生产完全一致。
fn root_store(
    extra_root: Option<rustls::pki_types::CertificateDer<'static>>,
) -> Result<rustls::RootCertStore, String> {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    if let Some(cert) = extra_root {
        roots
            .add(cert)
            .map_err(|e| format!("注入额外根证书失败：{e}"))?;
    }
    Ok(roots)
}

async fn raw_connect(host: &str, port: u16, use_tls: bool) -> Result<ImapConn, String> {
    raw_connect_x(host, port, use_tls, None).await
}

async fn raw_connect_x(
    host: &str,
    port: u16,
    use_tls: bool,
    extra_root: Option<rustls::pki_types::CertificateDer<'static>>,
) -> Result<ImapConn, String> {
    // 双保险：即便某条路径没经过 lib::run() 的启动初始化，建连前也确保
    // provider 已装（Once 保证只装一次，后续调用零成本）。
    ensure_crypto_provider();
    let tcp = tokio::time::timeout(
        std::time::Duration::from_secs(TCP_TIMEOUT_SECS),
        TcpStream::connect((host, port)),
    )
    .await
    .map_err(|_| format!("连接服务器超时（{host}:{port}，{TCP_TIMEOUT_SECS} 秒内未建立 TCP 连接）"))?
    .map_err(|e| format!("连接 {host}:{port} 失败：{e}"))?;
    let stream: BoxStream = if use_tls {
        let config = rustls::ClientConfig::builder()
            .with_root_certificates(root_store(extra_root)?)
            .with_no_client_auth();
        let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
        let server_name = rustls::pki_types::ServerName::try_from(host.to_string())
            .map_err(|_| "服务器域名无效".to_string())?;
        let tls = tokio::time::timeout(
            std::time::Duration::from_secs(TLS_TIMEOUT_SECS),
            connector.connect(server_name, tcp),
        )
        .await
        .map_err(|_| format!("TLS 握手超时（{TLS_TIMEOUT_SECS} 秒内未完成握手）"))?
        .map_err(|e| format!("TLS 握手失败：{e}"))?;
        Box::new(tls)
    } else {
        Box::new(tcp)
    };
    let (rd, wr) = tokio::io::split(stream);
    Ok(ImapConn {
        reader: BufReader::new(rd),
        writer: wr,
        tag_seq: 0,
    })
}

/// 建连 + 读 greeting + 登录 + CAPABILITY，返回 (连接, 能力串)。
/// auth_mode：login = LOGIN 用户名+授权码/密码；xoauth2 = OAuth 访问令牌（secret 传 access token）。
async fn login_conn(
    host: &str,
    port: u16,
    use_tls: bool,
    auth_mode: &str,
    username: &str,
    secret: &str,
) -> Result<(ImapConn, String), String> {
    login_conn_x(host, port, use_tls, auth_mode, username, secret, None).await
}

/// 集成测试入口（tests/mail_tls_integration.rs）：走与生产完全相同的
/// TCP → TLS 握手 → greeting → LOGIN → CAPABILITY 代码，只额外信任一张
/// 本地自签证书；返回 CAPABILITY 串。436/445 的无头验收全靠 stub，从未跑过
/// 真 Rust TLS——本入口就是为 v0.1.447 的 CI 真握手测试补的课。
#[doc(hidden)]
pub async fn login_conn_with_extra_root(
    host: &str,
    port: u16,
    use_tls: bool,
    auth_mode: &str,
    username: &str,
    secret: &str,
    extra_root: rustls::pki_types::CertificateDer<'static>,
) -> Result<String, String> {
    let (_conn, caps) = login_conn_x(
        host,
        port,
        use_tls,
        auth_mode,
        username,
        secret,
        Some(extra_root),
    )
    .await?;
    Ok(caps)
}

async fn login_conn_x(
    host: &str,
    port: u16,
    use_tls: bool,
    auth_mode: &str,
    username: &str,
    secret: &str,
    extra_root: Option<rustls::pki_types::CertificateDer<'static>>,
) -> Result<(ImapConn, String), String> {
    let mut conn = raw_connect_x(host, port, use_tls, extra_root).await?;
    // v0.1.445：greeting 必须带超时——436 这里是裸 read_line，服务器连上后不发问候语
    // （隐式 TLS 等待顺序错位、服务器假死、中间设备吞包）就会永久死等，界面无限转圈。
    let greet = conn
        .read_line_step("等待服务器问候语", GREETING_TIMEOUT_SECS)
        .await?;
    if !greet.starts_with("* OK") && !greet.starts_with("* PREAUTH") {
        return Err(format!("服务器 greeting 异常：{greet}"));
    }
    if auth_mode == "xoauth2" {
        use base64::Engine;
        let raw = format!("user={username}\u{1}auth=Bearer {secret}\u{1}\u{1}");
        let b64 = base64::engine::general_purpose::STANDARD.encode(raw.as_bytes());
        let tag = conn.next_tag();
        conn.write_line(&format!("{tag} AUTHENTICATE XOAUTH2 {b64}"))
            .await?;
        // 失败时服务器先回一行 "+ <详情>" 质询：回空行后再等完成行；成功则直接是完成行
        let mut line = conn
            .read_line_step("等待 OAuth 登录响应", IDLE_STEP_TIMEOUT_SECS)
            .await?;
        if line.starts_with('+') {
            conn.write_line("").await?;
            line = conn
                .read_line_step("等待 OAuth 登录响应", IDLE_STEP_TIMEOUT_SECS)
                .await?;
        }
        if !line.starts_with(&format!("{tag} OK")) {
            return Err(line);
        }
    } else {
        conn.command_t(
            &format!("LOGIN {} {}", quote(username), quote(secret)),
            LOGIN_TIMEOUT_SECS,
        )
        .await?;
    }
    let segs = conn
        .command_t("CAPABILITY", CAPABILITY_TIMEOUT_SECS)
        .await?;
    Ok((conn, parse_caps(&flatten(&segs))))
}

async fn get_session(account_id: &str) -> Result<Session, String> {
    globals()
        .sessions
        .lock()
        .await
        .get(account_id)
        .cloned()
        .ok_or_else(|| "邮箱未连接，请先点刷新重新连接".to_string())
}

/// SELECT 文件夹并返回 EXISTS 数（每次操作都重新 SELECT，保证状态新鲜）。
async fn select_folder(session: &Session, folder: &str) -> Result<i64, String> {
    let mut conn = session.conn.lock().await;
    let segs = conn.command(&format!("SELECT {}", quote(folder))).await?;
    Ok(parse_exists(&flatten(&segs)))
}

#[tauri::command]
pub async fn mail_imap_connect(
    account_id: String,
    host: String,
    port: u16,
    use_tls: bool,
    auth_mode: String,
    username: String,
    secret: String,
) -> Result<String, String> {
    // v0.1.445：登录跑在独立任务里并登记 AbortHandle，前端可取消；
    // 再套一层总时长上限兜底（各步超时之和 ≤ 55 秒，总上限 60 秒）。
    let task = tokio::spawn(async move {
        login_conn(&host, port, use_tls, &auth_mode, &username, &secret).await
    });
    let abort = task.abort_handle();
    globals()
        .pending_connects
        .lock()
        .await
        .insert(account_id.clone(), abort.clone());
    let joined = tokio::time::timeout(
        std::time::Duration::from_secs(VERIFY_TOTAL_TIMEOUT_SECS),
        task,
    )
    .await;
    globals()
        .pending_connects
        .lock()
        .await
        .remove(&account_id);
    let (conn, caps) = match joined {
        Ok(Ok(Ok(pair))) => pair,
        Ok(Ok(Err(e))) => return Err(e),
        Ok(Err(j)) if j.is_cancelled() => {
            return Err("连接验证已被取消".to_string());
        }
        Ok(Err(j)) => return Err(format!("连接任务异常结束：{j}")),
        Err(_) => {
            abort.abort();
            return Err(format!(
                "连接验证总时长超过 {VERIFY_TOTAL_TIMEOUT_SECS} 秒，已自动中止（服务器响应过慢）"
            ));
        }
    };
    let session = Session {
        conn: Arc::new(Mutex::new(conn)),
        caps: caps.clone(),
    };
    globals().sessions.lock().await.insert(account_id, session);
    Ok(caps)
}

/// 取消进行中的连接验证（v0.1.445）：真正 abort 掉在途登录任务，连接随任务取消被断开。
#[tauri::command]
pub async fn mail_imap_cancel_connect(account_id: String) -> Result<(), String> {
    if let Some(h) = globals().pending_connects.lock().await.remove(&account_id) {
        h.abort();
    }
    Ok(())
}

#[tauri::command]
pub async fn mail_imap_disconnect(account_id: String) -> Result<(), String> {
    mail_imap_idle_stop(account_id.clone()).await;
    if let Some(session) = globals().sessions.lock().await.remove(&account_id) {
        let mut conn = session.conn.lock().await;
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            conn.command("LOGOUT"),
        )
        .await;
    }
    Ok(())
}

#[tauri::command]
pub async fn mail_imap_list_folders(account_id: String) -> Result<String, String> {
    let session = get_session(&account_id).await?;
    let mut conn = session.conn.lock().await;
    let segs = conn.command("LIST \"\" \"*\"").await?;
    Ok(flatten(&segs))
}

#[tauri::command]
pub async fn mail_imap_fetch_headers(
    account_id: String,
    folder: String,
    limit: u32,
) -> Result<String, String> {
    let session = get_session(&account_id).await?;
    let exists = select_folder(&session, &folder).await?;
    if exists <= 0 {
        return Ok(format!("* 0 EXISTS\r\n"));
    }
    let take = (limit as i64).min(exists).max(1);
    let start = exists - take + 1;
    let mut conn = session.conn.lock().await;
    let segs = conn
        .command(&format!(
            "FETCH {start}:{exists} (UID FLAGS INTERNALDATE RFC822.SIZE BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE CONTENT-TYPE)] BODY.PEEK[TEXT]<0.600>)"
        ))
        .await?;
    Ok(flatten(&segs))
}

#[tauri::command]
pub async fn mail_imap_fetch_message(
    account_id: String,
    folder: String,
    uid: u32,
) -> Result<String, String> {
    let session = get_session(&account_id).await?;
    select_folder(&session, &folder).await?;
    let mut conn = session.conn.lock().await;
    let segs = conn
        .command(&format!("UID FETCH {uid} (BODY.PEEK[])"))
        .await?;
    for s in &segs {
        if let Seg::Bytes(b) = s {
            use base64::Engine;
            return Ok(base64::engine::general_purpose::STANDARD.encode(b));
        }
    }
    Err("服务器未返回邮件正文".to_string())
}

#[tauri::command]
pub async fn mail_imap_store_flags(
    account_id: String,
    folder: String,
    uids: Vec<u32>,
    flag: String,
    add: bool,
) -> Result<(), String> {
    if !["\\Seen", "\\Flagged", "\\Deleted"].contains(&flag.as_str()) {
        return Err(format!("不支持的标记：{flag}"));
    }
    if uids.is_empty() {
        return Ok(());
    }
    let session = get_session(&account_id).await?;
    select_folder(&session, &folder).await?;
    let csv = uids
        .iter()
        .map(|u| u.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let op = if add { "+FLAGS.SILENT" } else { "-FLAGS.SILENT" };
    let mut conn = session.conn.lock().await;
    conn.command(&format!("UID STORE {csv} {op} ({flag})")).await?;
    Ok(())
}

#[tauri::command]
pub async fn mail_imap_delete_messages(
    account_id: String,
    folder: String,
    uids: Vec<u32>,
    trash_folder: Option<String>,
) -> Result<u32, String> {
    if uids.is_empty() {
        return Ok(0);
    }
    let session = get_session(&account_id).await?;
    select_folder(&session, &folder).await?;
    let csv = uids
        .iter()
        .map(|u| u.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let mut conn = session.conn.lock().await;
    if let Some(trash) = &trash_folder {
        if trash != &folder {
            conn.command(&format!("UID COPY {csv} {}", quote(trash)))
                .await?;
        }
    }
    conn.command(&format!("UID STORE {csv} +FLAGS.SILENT (\\Deleted)"))
        .await?;
    if session.caps.contains("UIDPLUS") {
        conn.command(&format!("UID EXPUNGE {csv}")).await?;
    } else {
        conn.command("EXPUNGE").await?;
    }
    Ok(uids.len() as u32)
}

#[tauri::command]
pub async fn mail_imap_folder_counts(
    account_id: String,
    folders: Vec<String>,
) -> Result<String, String> {
    let session = get_session(&account_id).await?;
    let mut map = serde_json::Map::new();
    for f in &folders {
        let n = select_folder(&session, f).await?;
        map.insert(f.clone(), serde_json::json!(n));
    }
    Ok(serde_json::Value::Object(map).to_string())
}

#[tauri::command]
pub async fn mail_imap_search_all(
    account_id: String,
    folder: String,
) -> Result<String, String> {
    let session = get_session(&account_id).await?;
    select_folder(&session, &folder).await?;
    let mut conn = session.conn.lock().await;
    let segs = conn.command("UID SEARCH ALL").await?;
    Ok(flatten(&segs))
}

fn emit_idle(app: &AppHandle, account_id: &str, kind: &str, message: Option<&str>) {
    let _ = app.emit(
        "mail_idle",
        serde_json::json!({
            "accountId": account_id,
            "kind": kind,
            "message": message,
        }),
    );
}

/// IDLE 会话主循环：一轮 IDLE 最长挂 90 秒，到期 DONE 后重新 IDLE；stop 置位即退出。
async fn idle_session(
    app: &AppHandle,
    account_id: &str,
    host: &str,
    port: u16,
    use_tls: bool,
    auth_mode: &str,
    username: &str,
    secret: &str,
    folder: &str,
    stop: &Arc<AtomicBool>,
) -> Result<(), String> {
    let (mut conn, caps) = login_conn(host, port, use_tls, auth_mode, username, secret).await?;
    conn.command(&format!("SELECT {}", quote(folder))).await?;
    if !caps.contains("IDLE") {
        // 服务器不支持 IDLE：如实上报，前端改走定时轮询，不假装实时
        emit_idle(app, account_id, "unsupported", None);
        while !stop.load(Ordering::Relaxed) {
            // 5 秒一片地睡，stop 置位后最多 5 秒就退出（436 是整段 180 秒才看一次）
            for _ in 0..36 {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            }
            if stop.load(Ordering::Relaxed) {
                break;
            }
            emit_idle(app, account_id, "tick", None);
        }
        return Ok(());
    }
    emit_idle(app, account_id, "connected", None);
    while !stop.load(Ordering::Relaxed) {
        let tag = conn.next_tag();
        conn.write_line(&format!("{tag} IDLE")).await?;
        // 等服务器 "+ idling" 确认行（v0.1.445：带超时，436 是裸 read_line 会死等）
        let first = conn
            .read_line_step("等待 IDLE 确认", IDLE_STEP_TIMEOUT_SECS)
            .await?;
        if !first.starts_with('+') {
            return Err(format!("IDLE 启动失败：{first}"));
        }
        loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            match tokio::time::timeout(
                std::time::Duration::from_secs(90),
                conn.read_line(),
            )
            .await
            {
                Ok(Ok(line)) => {
                    let t = line.trim();
                    if t.ends_with(" EXISTS") {
                        emit_idle(app, account_id, "newmail", None);
                    } else if t.ends_with(" EXPUNGE") || t.ends_with(" FETCH") {
                        emit_idle(app, account_id, "changed", None);
                    } else if t.starts_with("* BYE") {
                        return Err(format!("服务器断开：{t}"));
                    }
                }
                Ok(Err(e)) => return Err(e),
                Err(_) => break, // 90 秒到期：DONE 后重新 IDLE
            }
        }
        conn.write_line("DONE").await?;
        // v0.1.445：DONE 的完成行也要超时——436 是裸 read_response，服务器不回就死等，
        // 且 stop 已置位也退不出去。超时按连接已坏处理，返回 Err 走外层重连退避。
        match tokio::time::timeout(
            std::time::Duration::from_secs(IDLE_STEP_TIMEOUT_SECS),
            conn.read_response(&tag),
        )
        .await
        {
            Ok(Ok(_segs)) => {}
            Ok(Err(e)) => return Err(format!("IDLE 结束失败：{e}")),
            Err(_) => {
                return Err(format!(
                    "IDLE 结束确认超时（{IDLE_STEP_TIMEOUT_SECS} 秒内服务器没有响应），将重新连接"
                ))
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn mail_imap_idle_start(
    app: AppHandle,
    account_id: String,
    host: String,
    port: u16,
    use_tls: bool,
    auth_mode: String,
    username: String,
    secret: String,
    folder: String,
) -> Result<(), String> {
    mail_imap_idle_stop(account_id.clone()).await;
    let stop = Arc::new(AtomicBool::new(false));
    globals()
        .idle_stops
        .lock()
        .await
        .insert(account_id.clone(), stop.clone());
    let acc = account_id.clone();
    tokio::spawn(async move {
        let mut backoff = 5u64;
        loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            match idle_session(
                &app, &acc, &host, port, use_tls, &auth_mode, &username, &secret, &folder, &stop,
            )
            .await
            {
                Ok(()) => break,
                Err(e) => {
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    emit_idle(&app, &acc, "error", Some(&e));
                    emit_idle(&app, &acc, "reconnecting", None);
                    // 退避睡眠 1 秒一片，stop 置位能及时退出（v0.1.445）
                    for _ in 0..backoff {
                        if stop.load(Ordering::Relaxed) {
                            break;
                        }
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    }
                    backoff = (backoff * 2).min(60);
                }
            }
        }
        emit_idle(&app, &acc, "stopped", None);
    });
    Ok(())
}

#[tauri::command]
pub async fn mail_imap_idle_stop(account_id: String) {
    if let Some(stop) = globals().idle_stops.lock().await.remove(&account_id) {
        stop.store(true, Ordering::Relaxed);
    }
}

// ---------- OAuth 桌面授权：本机 127.0.0.1 一次性回调监听 ----------

fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                if let Ok(v) = u8::from_str_radix(hex, 16) {
                    out.push(v);
                    i += 2;
                } else {
                    out.push(bytes[i]);
                }
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn parse_oauth_request(req: &str) -> OAuthResult {
    let first = req.lines().next().unwrap_or("");
    let path = first.split_whitespace().nth(1).unwrap_or("");
    let query = path.split('?').nth(1).unwrap_or("");
    let mut code: Option<String> = None;
    let mut error: Option<String> = None;
    for pair in query.split('&') {
        let mut it = pair.splitn(2, '=');
        let k = it.next().unwrap_or("");
        let v = url_decode(it.next().unwrap_or(""));
        match k {
            "code" => code = Some(v),
            "error" => error = Some(v),
            _ => {}
        }
    }
    if code.is_none() && error.is_none() {
        error = Some("回调里没有授权码".to_string());
    }
    OAuthResult { code, error }
}

#[tauri::command]
pub fn mail_oauth_listen_start() -> Result<u16, String> {
    let listener =
        std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| format!("启动本机回调监听失败：{e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("读取回调端口失败：{e}"))?
        .port();
    let slot = OAuthSlot {
        result: Arc::new(StdMutex::new(None)),
    };
    let result_ref = slot.result.clone();
    if let Ok(mut g) = globals().oauth.lock() {
        *g = Some(slot);
    }
    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut buf = vec![0u8; 8192];
            let n = stream.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            let result = parse_oauth_request(&req);
            let body = if result.error.is_some() {
                "<html><meta charset=\"utf-8\"><body style=\"font-family:sans-serif;padding:40px\">授权未完成，可以关闭此页面，回到 AI 魔方重试。</body></html>"
            } else {
                "<html><meta charset=\"utf-8\"><body style=\"font-family:sans-serif;padding:40px\">授权成功，可以关闭此页面，回到 AI 魔方继续。</body></html>"
            };
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(resp.as_bytes());
            if let Ok(mut r) = result_ref.lock() {
                *r = Some(result);
            }
        }
    });
    Ok(port)
}

#[tauri::command]
pub fn mail_oauth_listen_result() -> Option<OAuthResult> {
    let g = globals().oauth.lock().ok()?;
    let slot = g.as_ref()?;
    // 先绑定再返回：尾表达式里的锁 guard 临时量会活过 g 的析构，借用检查不过
    let result = slot.result.lock().ok()?.clone();
    result
}
