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
