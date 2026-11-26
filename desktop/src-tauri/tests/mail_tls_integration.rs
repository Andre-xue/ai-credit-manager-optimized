// v0.1.447 集成测试：真 TLS 握手走 App 自身的 mail_imap 连接代码。
//
// 背景：442 起真机上每次 TLS 握手都 panic——
//   "Could not automatically determine the process-level CryptoProvider
//    from Rustls crate features..."
// rustls 的进程级 CryptoProvider 从未安装、crate feature 也没恰好启用一个，
// ClientConfig::builder() 直接 panic，连接任务死掉、前端无限转圈。
// 436/445 的验收全靠前端 stub，从未跑过真 Rust TLS，所以漏掉了这个总根源。
//
// 本测试本地起一个带自签证书的假 TLS IMAP 服务器（fixtures/，SAN 含
// 127.0.0.1），用 mail_imap 的生产连接函数完成
// TCP → TLS 握手 → greeting → LOGIN → CAPABILITY 全程。
// 未修代码上：ClientConfig 构建 panic → 本测试红；
// 修复后（启动时 install_default ring provider）：变绿。

use std::sync::Arc;

use base64::Engine as _;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

fn pem_der(pem: &str) -> Vec<u8> {
    let b64: String = pem
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .collect::<String>()
        .split_whitespace()
        .collect();
    base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .expect("fixture PEM base64 应可解码")
}

fn fixture_cert() -> CertificateDer<'static> {
    CertificateDer::from(pem_der(include_str!("fixtures/localhost-cert.pem")))
}

fn fixture_key() -> PrivateKeyDer<'static> {
    PrivateKeyDer::try_from(pem_der(include_str!("fixtures/localhost-key.pem")))
        .expect("fixture 私钥应可解析（PKCS#8）")
}

/// 假 TLS IMAP 服务器：一条连接，按脚本走 greeting / LOGIN / CAPABILITY。
async fn spawn_fake_imap_tls_server() -> u16 {
    let config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![fixture_cert()], fixture_key())
        .expect("测试服务器 TLS 配置应可构建");
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("测试服务器应可监听");
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.expect("应有客户端连入");
        let stream = acceptor.accept(tcp).await.expect("TLS 握手应成功");
        let (rd, mut wr) = tokio::io::split(stream);
        let mut lines = BufReader::new(rd).lines();
        wr.write_all(b"* OK Fake IMAP server ready\r\n")
            .await
            .unwrap();
        // LOGIN：回带 tag 的 OK
        let login = lines.next_line().await.unwrap().expect("应收到 LOGIN");
        let tag = login.split_whitespace().next().unwrap().to_string();
        assert!(login.contains("LOGIN"), "第一条命令应是 LOGIN：{login}");
        wr.write_all(format!("{tag} OK LOGIN completed\r\n").as_bytes())
            .await
            .unwrap();
        // CAPABILITY：先未标记行，再带 tag 的 OK
        let cap = lines
            .next_line()
            .await
            .unwrap()
            .expect("应收到 CAPABILITY");
        let tag = cap.split_whitespace().next().unwrap().to_string();
        assert!(
            cap.contains("CAPABILITY"),
            "第二条命令应是 CAPABILITY：{cap}"
        );
        wr.write_all(b"* CAPABILITY IMAP4rev1 IDLE\r\n")
            .await
            .unwrap();
        wr.write_all(format!("{tag} OK CAPABILITY completed\r\n").as_bytes())
            .await
            .unwrap();
    });
    port
}

#[tokio::test]
async fn mail_imap_real_tls_handshake_login_capability() {
    // 与 App 启动路径一致：先走生产同款的 CryptoProvider 初始化入口
    // （lib::run() 首行调用同一个函数）。初始化未真正安装 provider 时
    // （复现状态），下方 ClientConfig::builder() 会 panic，本测试为红。
    ai_credit_manager_lib::mail_imap::ensure_crypto_provider();

    let port = spawn_fake_imap_tls_server().await;
    let caps = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        ai_credit_manager_lib::mail_imap::login_conn_with_extra_root(
            "127.0.0.1",
            port,
            true,
            "login",
            "tester@example.com",
            "test-secret",
            fixture_cert(),
        ),
    )
    .await
    .expect("连接全程不应超时（20 秒）")
    .expect("TLS 握手 + LOGIN + CAPABILITY 应成功");
    assert!(
        caps.contains("IMAP4rev1"),
        "CAPABILITY 应含 IMAP4rev1，实际：{caps}"
    );
}

// ---------- v0.1.460：Gmail 风格 XOAUTH2 响应序列回归 ----------
//
// Ethan 2026-11-26 实机：Gmail 浏览器授权登录后「账户已保存，但连接失败」，
// 错误原文是 Gmail 的整行无标签 CAPABILITY 响应。真实 Gmail 行为：
// greeting 是单行 * OK [CAPABILITY ...]；AUTHENTICATE XOAUTH2 成功后，
// 服务器先发一行无标签 * CAPABILITY ...，再发带 tag 的 OK。
// 旧代码的 XOAUTH2 分支只读一行就要求是 tagged OK，于是把先到的
// * CAPABILITY 行误判为失败并把该行原文当错误抛出（LOGIN 路径走
// read_response 读到 tagged 行为止，所以 QQ 等授权码路径从未触发）。

/// 截图里的真实 Gmail CAPABILITY 串（问候括号内与认证后无标签行同内容）。
const GMAIL_CAPS: &str = "IMAP4rev1 UNSELECT IDLE NAMESPACE QUOTA ID XLIST CHILDREN X-GM-EXT-1 UIDPLUS COMPRESS=DEFLATE ENABLE MOVE CONDSTORE ESEARCH UTF8=ACCEPT LIST-EXTENDED LIST-STATUS LITERAL- SPECIAL-USE APPENDLIMIT=35651584";

/// 假 Gmail 风格 TLS IMAP 服务器：greeting 单行带 [CAPABILITY ...]；
/// AUTHENTICATE 成功先回无标签 * CAPABILITY 行、再回 tagged OK。
async fn spawn_fake_gmail_tls_server() -> u16 {
    let config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![fixture_cert()], fixture_key())
        .expect("测试服务器 TLS 配置应可构建");
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("测试服务器应可监听");
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.expect("应有客户端连入");
        let stream = acceptor.accept(tcp).await.expect("TLS 握手应成功");
        let (rd, mut wr) = tokio::io::split(stream);
        let mut lines = BufReader::new(rd).lines();
        wr.write_all(
            format!("* OK [CAPABILITY {GMAIL_CAPS}] Gimap ready for requests from 127.0.0.1\r\n")
                .as_bytes(),
        )
        .await
        .unwrap();
        // AUTHENTICATE XOAUTH2：先无标签 CAPABILITY 行，再 tagged OK（Gmail 真实顺序）
        let auth = match lines.next_line().await {
            Ok(Some(l)) => l,
            _ => return,
        };
        let tag = auth.split_whitespace().next().unwrap().to_string();
        assert!(
            auth.contains("AUTHENTICATE XOAUTH2"),
            "第一条命令应是 AUTHENTICATE XOAUTH2：{auth}"
        );
        wr.write_all(format!("* CAPABILITY {GMAIL_CAPS}\r\n").as_bytes())
            .await
            .unwrap();
        wr.write_all(format!("{tag} OK tester@gmail.com authenticated (Success)\r\n").as_bytes())
            .await
            .unwrap();
        // CAPABILITY 命令：未标记行 + tagged OK
        let cap = match lines.next_line().await {
            Ok(Some(l)) => l,
            _ => return,
        };
        let tag = cap.split_whitespace().next().unwrap().to_string();
        assert!(cap.contains("CAPABILITY"), "第二条命令应是 CAPABILITY：{cap}");
        wr.write_all(format!("* CAPABILITY {GMAIL_CAPS}\r\n").as_bytes())
            .await
            .unwrap();
        wr.write_all(format!("{tag} OK CAPABILITY completed\r\n").as_bytes())
            .await
            .unwrap();
    });
    port
}

#[tokio::test]
async fn mail_imap_gmail_style_xoauth2_untagged_capability_before_ok() {
    ai_credit_manager_lib::mail_imap::ensure_crypto_provider();

    let port = spawn_fake_gmail_tls_server().await;
    let caps = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        ai_credit_manager_lib::mail_imap::login_conn_with_extra_root(
            "127.0.0.1",
            port,
            true,
            "xoauth2",
            "tester@gmail.com",
            "fake-access-token",
            fixture_cert(),
        ),
    )
    .await
    .expect("连接全程不应超时（20 秒）")
    .expect("Gmail 风格 AUTHENTICATE（tagged OK 之前先发 * CAPABILITY 无标签行）应登录成功");
    assert!(
        caps.contains("X-GM-EXT-1"),
        "CAPABILITY 应含 Gmail 的 X-GM-EXT-1，实际：{caps}"
    );
}

/// 假 XOAUTH2 失败质询服务器：AUTHENTICATE 后先回「+ <详情>」质询行，
/// 客户端回空行后才发 tagged NO。钉死：报错必须是 tagged NO 原文，
/// 不能是质询行、也不能把质询当成功。
async fn spawn_fake_xoauth2_challenge_server() -> u16 {
    let config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![fixture_cert()], fixture_key())
        .expect("测试服务器 TLS 配置应可构建");
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("测试服务器应可监听");
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.expect("应有客户端连入");
        let stream = acceptor.accept(tcp).await.expect("TLS 握手应成功");
        let (rd, mut wr) = tokio::io::split(stream);
        let mut lines = BufReader::new(rd).lines();
        wr.write_all(b"* OK Fake IMAP server ready\r\n")
            .await
            .unwrap();
        let auth = match lines.next_line().await {
            Ok(Some(l)) => l,
            _ => return,
        };
        let tag = auth.split_whitespace().next().unwrap().to_string();
        assert!(
            auth.contains("AUTHENTICATE XOAUTH2"),
            "第一条命令应是 AUTHENTICATE XOAUTH2：{auth}"
        );
        let detail = base64::engine::general_purpose::STANDARD
            .encode(br#"{"status":"401","schemes":"Bearer","scope":"https://mail.google.com/"}"#);
        wr.write_all(format!("+ {detail}\r\n").as_bytes())
            .await
            .unwrap();
        // 客户端必须回一行空行，服务器才发 tagged NO
        let blank = lines.next_line().await.unwrap().expect("应收到质询回应行");
        assert!(blank.is_empty(), "质询回应应为空行，实际：{blank:?}");
        wr.write_all(
            format!("{tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n")
                .as_bytes(),
        )
        .await
        .unwrap();
    });
    port
}

#[tokio::test]
async fn mail_imap_xoauth2_challenge_error_is_tagged_no() {
    ai_credit_manager_lib::mail_imap::ensure_crypto_provider();

    let port = spawn_fake_xoauth2_challenge_server().await;
    let err = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        ai_credit_manager_lib::mail_imap::login_conn_with_extra_root(
            "127.0.0.1",
            port,
            true,
            "xoauth2",
            "tester@gmail.com",
            "bad-access-token",
            fixture_cert(),
        ),
    )
    .await
    .expect("连接全程不应超时（20 秒）")
    .expect_err("质询后 tagged NO 应让登录失败");
    assert!(
        err.contains("AUTHENTICATIONFAILED"),
        "错误应是服务器 tagged NO 原文，实际：{err}"
    );
    assert!(
        !err.starts_with('+'),
        "错误不能是质询行原文，实际：{err}"
    );
}
