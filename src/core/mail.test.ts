// 邮箱工具 v0.1.436 单元测试：预设 / 验证码提取 / 自动分类 / 编码解码 /
// IMAP 报文解析（报文形态与本地假 IMAP 服务器 verify436 的真实输出一致）/ MIME 解析 / 删除方式决策。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  MAIL_PLATFORMS, mailPlatform, extractVerifyCode, classifyMessage, decodeEncodedWords,
  parseListFolders, parseFetchHeaders, parseSearchUids, resolveDeleteMode, parseMimeMessage,
  htmlToText, sanitizeMailHtml, prepareMailHtml, htmlHasVisibleText, MAIL_IMG_PLACEHOLDER, loadMailVisibility, saveMailVisibility, isAccountVisible,
  buildOAuthUrl, raceTimeout, mailConnectTimeoutMs, MAIL_CONNECT_TIMEOUT_MS,
  decodeJwtPayload, diagnoseOAuthTokenForImap, MAIL_NOT_CONNECTED_GUIDANCE,
  type MailAccountMeta,
  mailInvoke, mailStepTimeoutMs, displayMailError, isMailInternalError, shouldSuggestCredentialCheck,
  OAUTH_REGISTER_GUIDES, describeOAuthCallbackError, mailOAuthAuthorize, OAUTH_CANCELLED,
  loadOAuthClientCreds, saveOAuthClientCreds, clearOAuthClientCreds,
  loadMailReauthFlags, setMailReauthFlag, clearMailReauthFlag,
  parseBodyStructure, assembleBodyFromParts, bytesToBase64,
  loadCachedBody, saveCachedBody, dropCachedBodies, MAIL_CONNECT_STEP_LABELS,
  type MailFolder, type MailBodyResult,
  MS_GRAPH_SCOPE, MAIL_GRAPH_MIGRATION_MESSAGE, diagnoseOAuthTokenForGraph,
  mapGraphFolder, mapGraphMessage, hashGraphId, graphListFolders, graphErrorDetail,
  mailSyncAccount, addMailAccount, listMailAccounts, loadMailCache,
  mailDeleteAll, mailDeleteAllPreview, mailDeleteAllSnapshot, saveMailCache,
  type MailSecret, type MailDeleteAllProgressEvent, type MailMessage,
} from './mail'
import { initVault } from './crypto'

class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.get(k) ?? null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}
;(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage()

beforeEach(() => { localStorage.clear() })

describe('平台预设', () => {
  it('8 个预设 + 自定义兜底，服务器地址真实', () => {
    expect(MAIL_PLATFORMS.length).toBe(9)
    expect(mailPlatform('gmail').imapHost).toBe('imap.gmail.com')
    expect(mailPlatform('outlook').imapHost).toBe('outlook.office365.com')
    expect(mailPlatform('qq').imapHost).toBe('imap.qq.com')
    expect(mailPlatform('net163').imapHost).toBe('imap.163.com')
    expect(mailPlatform('net126').imapHost).toBe('imap.126.com')
    expect(mailPlatform('icloud').imapHost).toBe('imap.mail.me.com')
    expect(mailPlatform('sina').imapHost).toBe('imap.sina.com')
    expect(mailPlatform('aliyun').imapHost).toBe('imap.aliyun.com')
    expect(mailPlatform('gmail').auth).toBe('oauth')
    expect(mailPlatform('qq').auth).toBe('authcode')
    for (const p of MAIL_PLATFORMS) expect(p.guide.length).toBeGreaterThan(0)
  })
})

describe('验证码提取', () => {
  it('中文锚定', () => {
    expect(extractVerifyCode('您的验证码是 123456，5 分钟内有效')).toBe('123456')
    expect(extractVerifyCode('校验码：8899 请勿泄露')).toBe('8899')
    expect(extractVerifyCode('123456 是你的动态码')).toBe('123456')
  })
  it('英文锚定', () => {
    expect(extractVerifyCode('Your verification code is 654321.')).toBe('654321')
  })
  it('无验证码返回 null', () => {
    expect(extractVerifyCode('会议在 2026 年 123456 室举行')).toBeNull()
    expect(extractVerifyCode('hello world')).toBeNull()
  })
})

describe('自动分类', () => {
  it('五类各命中一例', () => {
    expect(classifyMessage({ from: 'GitHub', fromAddr: 'noreply@github.com', subject: '[GitHub] 你的验证码', snippet: '验证码 123456' })).toBe('code')
    expect(classifyMessage({ from: '银行', fromAddr: 'alert@bank.example', subject: '登录提醒：新设备登录', snippet: '' })).toBe('security')
    expect(classifyMessage({ from: '周刊', fromAddr: 'weekly@news.example', subject: '本周订阅周刊第 12 期', snippet: '' })).toBe('subscription')
    expect(classifyMessage({ from: '商城', fromAddr: 'promo@shop.example', subject: '双十一大促 5 折优惠', snippet: '' })).toBe('ad')
    expect(classifyMessage({ from: '张三', fromAddr: 'zhangsan@example.com', subject: '周末聚餐', snippet: '老地方见' })).toBe('personal')
  })
  it('验证码优先于安全（带码的安全邮件进验证码类，方便找码）', () => {
    expect(classifyMessage({ from: 'x', fromAddr: 'a@b.c', subject: '安全验证', snippet: '您的验证码是 246810' })).toBe('code')
  })
})

describe('RFC2047 解码', () => {
  it('UTF-8 Base64 与 GBK Q 编码', () => {
    const b64 = Buffer.from('你好世界', 'utf-8').toString('base64')
    expect(decodeEncodedWords(`=?UTF-8?B?${b64}?=`)).toBe('你好世界')
    expect(decodeEncodedWords('=?UTF-8?Q?hello_world?=')).toBe('hello world')
  })
})

const LIST_RAW = [
  '* LIST (\\HasNoChildren) "/" "INBOX"',
  '* LIST (\\HasNoChildren \\Sent) "/" "Sent"',
  '* LIST (\\HasNoChildren \\Drafts) "/" "Drafts"',
  '* LIST (\\HasNoChildren \\Trash) "/" "Trash"',
  '* LIST (\\HasNoChildren \\Junk) "/" "Junk"',
  '* LIST (\\HasNoChildren) "/" "工作"',
  'a3 OK List completed',
].join('\r\n')

describe('LIST 解析与文件夹角色', () => {
  it('解析出 6 个文件夹且角色正确', () => {
    const folders = parseListFolders(LIST_RAW)
    expect(folders.length).toBe(6)
    expect(folders.find(f => f.name === 'INBOX')?.role).toBe('inbox')
    expect(folders.find(f => f.name === 'Sent')?.role).toBe('sent')
    expect(folders.find(f => f.name === 'Trash')?.role).toBe('trash')
    expect(folders.find(f => f.name === 'Junk')?.role).toBe('junk')
    expect(folders.find(f => f.name === '工作')?.role).toBe('other')
  })
})

// 与真实 IMAP 服务器 + Rust flatten 后的形态一致：头部字面量之后直接跟 " BODY[TEXT]" 段，
// 段间没有分隔行；正文字面量之后紧跟 ")" 收尾（与 verify436 假服务器的输出同形态）
const FETCH_RAW = [
  '* 1 FETCH (UID 101 FLAGS (\\Seen) INTERNALDATE "26-Nov-2026 10:00:00 +0800" RFC822.SIZE 2048 BODYSTRUCTURE ("TEXT" "PLAIN") BODY[HEADER.FIELDS (FROM TO CC SUBJECT DATE CONTENT-TYPE)] {150}',
  'From: GitHub <noreply@github.com>',
  'Subject: [GitHub] Your verification code',
  'Date: Thu, 26 Nov 2026 10:00:00 +0800',
  'Content-Type: text/plain; charset=utf-8',
  ' BODY[TEXT]<0> {40}',
  'Your verification code is 123456 ok)',
  '* 2 FETCH (UID 102 FLAGS () INTERNALDATE "26-Nov-2026 11:00:00 +0800" RFC822.SIZE 999 BODYSTRUCTURE ("TEXT" "PLAIN") BODY[HEADER.FIELDS (FROM TO CC SUBJECT DATE CONTENT-TYPE)] {130}',
  'From: =?UTF-8?B?5ZWG5Z+O?= <promo@shop.example>',
  'Subject: =?UTF-8?B?5Y-M5Y2B5LiA5aSn5L+D?= 5折',
  'Date: Thu, 26 Nov 2026 11:00:00 +0800',
  'Content-Type: multipart/mixed; boundary="x"',
  ' BODY[TEXT]<0> {20}',
  'big sale now)',
  'a4 OK Fetch completed',
].join('\r\n')

describe('FETCH 头部解析', () => {
  it('两封邮件：字段、分类、附件标记都对', () => {
    const msgs = parseFetchHeaders(FETCH_RAW, 'acct-1', 'INBOX')
    expect(msgs.length).toBe(2)
    const [m1, m2] = msgs
    expect(m1.uid).toBe(101)
    expect(m1.from).toBe('GitHub')
    expect(m1.fromAddr).toBe('noreply@github.com')
    expect(m1.flags).toContain('\\Seen')
    expect(m1.category).toBe('code')
    expect(m1.snippet).toContain('123456')
    expect(m1.hasAttach).toBe(false)
    expect(m2.uid).toBe(102)
    expect(m2.from).toBe('商城')
    expect(m2.category).toBe('ad')
    expect(m2.hasAttach).toBe(true)
    expect(m2.key).toBe('acct-1|INBOX|102')
  })
})

describe('SEARCH 与删除方式', () => {
  it('parseSearchUids', () => {
    expect(parseSearchUids('* SEARCH 1 2 30\r\na5 OK done')).toEqual([1, 2, 30])
    expect(parseSearchUids('* SEARCH\r\na5 OK')).toEqual([])
  })
  it('resolveDeleteMode：有垃圾箱移垃圾箱，垃圾箱内彻底删', () => {
    const folders: MailFolder[] = [
      { name: 'INBOX', flags: [], role: 'inbox' },
      { name: 'Trash', flags: [], role: 'trash' },
    ]
    expect(resolveDeleteMode(folders, 'INBOX')).toEqual({ mode: 'trash', trashFolder: 'Trash' })
    expect(resolveDeleteMode(folders, 'Trash').mode).toBe('permanent')
    expect(resolveDeleteMode([folders[0]], 'INBOX').mode).toBe('permanent')
  })
})

describe('MIME 正文解析', () => {
  it('multipart：正文 + 附件 + 验证码', () => {
    const attachB64 = Buffer.from('PDFDATA', 'utf-8').toString('base64')
    const eml = [
      'From: a@b.c',
      'Subject: invoice',
      'Content-Type: multipart/mixed; boundary="BB"',
      '',
      '--BB',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Your code is 778899=2E thanks',
      '--BB',
      'Content-Type: application/pdf; name="bill.pdf"',
      'Content-Disposition: attachment; filename="bill.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      attachB64,
      '--BB--',
      '',
    ].join('\r\n')
    const body = parseMimeMessage(new TextEncoder().encode(eml))
    expect(body.text).toContain('778899.')
    expect(body.attachments.length).toBe(1)
    expect(body.attachments[0].filename).toBe('bill.pdf')
    expect(body.attachments[0].size).toBe(7)
    expect(extractVerifyCode(body.text)).toBe('778899')
  })
  it('html 转文本与净化', () => {
    expect(htmlToText('<p>你好</p><script>alert(1)</script>')).toContain('你好')
    const clean = sanitizeMailHtml('<p onclick="x()">hi</p><script>bad</script><a href="javascript:evil()">l</a>')
    expect(clean).not.toContain('script')
    expect(clean).not.toContain('onclick')
    expect(clean).not.toContain('javascript:')
  })
})

describe('阅读页正文呈现（v0.1.449）', () => {
  const pngB64 = Buffer.from('PNGDATA').toString('base64')
  const emlRelated = [
    'From: a@b.c',
    'Subject: photo',
    'Content-Type: multipart/related; boundary="REL"',
    '',
    '--REL',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<html><body><p>照片在下面</p><img src="cid:photo1@acm" alt="照片"></body></html>',
    '--REL',
    'Content-Type: image/png; name="photo.png"',
    'Content-Disposition: inline; filename="photo.png"',
    'Content-Transfer-Encoding: base64',
    'Content-ID: <photo1@acm>',
    '',
    pngB64,
    '--REL--',
    '',
  ].join('\r\n')

  it('cid 内嵌图被单独收集，不进附件列表', () => {
    const body = parseMimeMessage(new TextEncoder().encode(emlRelated))
    expect(body.inlineImages.length).toBe(1)
    expect(body.inlineImages[0].cid).toBe('photo1@acm')
    expect(body.inlineImages[0].contentType).toBe('image/png')
    expect(body.inlineImages[0].base64).toBe(pngB64)
    expect(body.attachments.length).toBe(0)
    expect(body.html).toContain('cid:photo1@acm')
  })

  it('prepareMailHtml：cid 换 data: URL', () => {
    const body = parseMimeMessage(new TextEncoder().encode(emlRelated))
    const out = prepareMailHtml(body.html, body.inlineImages, false)
    expect(out.html).toContain(`data:image/png;base64,${pngB64}`)
    expect(out.html).not.toContain('cid:')
    expect(out.remoteCount).toBe(0)
  })

  it('prepareMailHtml：远程图默认占位（存原地址、剥 srcset），点后才放行', () => {
    const html = '<p>大促</p><img src="https://cdn.example.com/a.png" srcset="https://cdn.example.com/a2x.png 2x" width="600">'
    const blocked = prepareMailHtml(html, [], false)
    expect(blocked.remoteCount).toBe(1)
    expect(blocked.html).toContain(MAIL_IMG_PLACEHOLDER)
    expect(blocked.html).toContain('data-remote-src="https://cdn.example.com/a.png"')
    expect(blocked.html).not.toContain('srcset')
    expect(blocked.html).not.toMatch(/\ssrc="https:/)
    const shown = prepareMailHtml(html, [], true)
    expect(shown.remoteCount).toBe(1)
    expect(shown.html).toContain('src="https://cdn.example.com/a.png"')
  })

  it('prepareMailHtml：净化仍生效；解析不到的 cid 与相对地址换占位', () => {
    const out = prepareMailHtml('<script>bad</script><img src="cid:missing@x"><img src="/rel.png">', [], false)
    expect(out.html).not.toContain('script')
    expect(out.html).not.toContain('cid:missing@x')
    expect(out.html).not.toContain('/rel.png')
    expect(out.html.split(MAIL_IMG_PLACEHOLDER).length - 1).toBe(2)
  })

  it('htmlHasVisibleText：只有图片的 HTML 无可见文字（回落纯文本的判据）', () => {
    expect(htmlHasVisibleText('<html><body><img src="https://x/logo.png" alt=""></body></html>')).toBe(false)
    expect(htmlHasVisibleText('<p>你好</p>')).toBe(true)
    expect(htmlHasVisibleText('')).toBe(false)
  })

  it('Meta 形态：HTML 只有图、正文全在 text/plain → 解析后判据成立可回落', () => {
    const eml = [
      'From: Meta <noreply@facebookmail.com>',
      'Subject: code',
      'Content-Type: multipart/alternative; boundary="ALT"',
      '',
      '--ALT',
      'Content-Type: text/plain; charset=utf-8',
      '',
      '你的验证码是 654321。如果你没有请求此验证码，请立即修改密码。',
      '--ALT',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<html><body><table><tr><td><img src="https://static.example.com/logo.png" alt=""></td></tr></table></body></html>',
      '--ALT--',
      '',
    ].join('\r\n')
    const body = parseMimeMessage(new TextEncoder().encode(eml))
    expect(body.text).toContain('请立即修改密码')
    expect(htmlHasVisibleText(body.html)).toBe(false)
  })
})

describe('显示开关', () => {
  it('平台总开关关掉 → 其下账户全部隐匿；账户副开关单独关', () => {
    const v = loadMailVisibility()
    expect(isAccountVisible(v, { id: 'a1', platformId: 'qq', email: 'x@qq.com', label: '', host: '', port: 993 })).toBe(true)
    v.platforms.qq = false
    saveMailVisibility(v)
    expect(isAccountVisible(loadMailVisibility(), { id: 'a1', platformId: 'qq', email: 'x@qq.com', label: '', host: '', port: 993 })).toBe(false)
    const v2 = loadMailVisibility()
    v2.platforms.qq = true
    v2.accounts.a1 = false
    saveMailVisibility(v2)
    expect(isAccountVisible(loadMailVisibility(), { id: 'a1', platformId: 'qq', email: 'x@qq.com', label: '', host: '', port: 993 })).toBe(false)
  })
})

describe('连接验证超时兜底（445）', () => {
  it('默认看门狗 70 秒（大于 Rust 侧 60 秒总上限，正常时先收到 Rust 的分步报错）', () => {
    expect(MAIL_CONNECT_TIMEOUT_MS).toBe(70_000)
    expect(mailConnectTimeoutMs()).toBe(70_000)
  })
  it('raceTimeout：按时返回的结果原样通过', async () => {
    await expect(raceTimeout(Promise.resolve('caps'), 1000, '不应触发')).resolves.toBe('caps')
  })
  it('raceTimeout：永不返回的连接按时以指定文案拒绝（不再无限等）', async () => {
    const t0 = Date.now()
    await expect(raceTimeout(new Promise<string>(() => {}), 30, '连接验证超时（测试）'))
      .rejects.toThrow('连接验证超时（测试）')
    expect(Date.now() - t0).toBeLessThan(1000)
  })
  it('raceTimeout：底层真实错误原样透传，不被超时文案吞掉', async () => {
    await expect(raceTimeout(Promise.reject(new Error('a1 NO Login failed')), 1000, '不应触发'))
      .rejects.toThrow('a1 NO Login failed')
  })
})

describe('同步路径分步超时（445 补充）', () => {
  it('每类命令有自己的上限：LIST 30s / FETCH 45s / 删除 60s / 未知命令 30s', () => {
    expect(mailStepTimeoutMs('mail_imap_list_folders')).toBe(30_000)
    expect(mailStepTimeoutMs('mail_imap_fetch_headers')).toBe(45_000)
    expect(mailStepTimeoutMs('mail_imap_delete_messages')).toBe(60_000)
    expect(mailStepTimeoutMs('mail_imap_unknown')).toBe(30_000)
  })

  const g = globalThis as unknown as { window?: unknown }
  let calls: string[]
  const stubWindow = (invoke: (cmd: string) => Promise<unknown>, stepMs?: number) => {
    calls = []
    g.window = {
      __ACM_MAIL_STEP_TIMEOUT_MS__: stepMs,
      __TAURI_INTERNALS__: { invoke: (cmd: string) => { calls.push(cmd); return invoke(cmd) } },
    }
  }
  afterEach(() => { delete g.window })

  it('mailInvoke：正常返回原样通过', async () => {
    stubWindow(async () => '* LIST ok')
    await expect(mailInvoke<string>('mail_imap_list_folders', { accountId: 'a1' }, '拉取文件夹列表（LIST）')).resolves.toBe('* LIST ok')
  })
  it('mailInvoke：服务器不响应 → 带步骤名的超时错误，并丢弃会话（发 disconnect）', async () => {
    stubWindow(async (cmd) => (cmd === 'mail_imap_disconnect' ? null : new Promise(() => {})), 30)
    await expect(mailInvoke<string>('mail_imap_list_folders', { accountId: 'a1' }, '拉取文件夹列表（LIST）'))
      .rejects.toThrow('拉取文件夹列表（LIST）超时')
    await new Promise(r => setTimeout(r, 20))
    expect(calls).toContain('mail_imap_disconnect')
  })
  it('mailInvoke：服务器真实报错原样透传，不触发丢弃会话', async () => {
    stubWindow(async () => { throw new Error('a3 NO Mailbox does not exist') })
    await expect(mailInvoke<string>('mail_imap_fetch_headers', { accountId: 'a1', folder: 'INBOX' }, '拉取「INBOX」邮件列表（FETCH）'))
      .rejects.toThrow('a3 NO Mailbox does not exist')
    expect(calls).not.toContain('mail_imap_disconnect')
  })
})

describe('OAuth URL', () => {
  it('Google / Microsoft 授权链接含本机回调', () => {
    const g = buildOAuthUrl('google', 'cid-1', 18765)
    expect(g).toContain('accounts.google.com')
    expect(g).toContain('127.0.0.1%3A18765')
    const m = buildOAuthUrl('microsoft', 'cid-2', 18766)
    expect(m).toContain('login.microsoftonline.com')
    // v0.1.459：微软改走 Graph 资源，scope 是 Mail.ReadWrite，不再是 IMAP 范围
    expect(m).toContain('Mail.ReadWrite')
    expect(m).not.toContain('IMAP.AccessAsUser.All')
  })

  // v0.1.457 钉死端点形状：微软 v2 授权端点是 /authorize，写成 /auth（Google 的结尾）线上直接 404，
  // Ethan 实机点「连接并授权」打开即 404。此后这类「拼错一个词」必须被单测拦住。
  it('微软授权 URL 的 host+path 精确等于 /common/oauth2/v2.0/authorize 且带必需参数', () => {
    const u = new URL(buildOAuthUrl('microsoft', 'cid-2', 18766))
    expect(u.protocol).toBe('https:')
    expect(u.host).toBe('login.microsoftonline.com')
    expect(u.pathname).toBe('/common/oauth2/v2.0/authorize')
    expect(u.searchParams.get('client_id')).toBe('cid-2')
    expect(u.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:18766')
    expect(u.searchParams.get('response_type')).toBe('code')
    expect(u.searchParams.get('response_mode')).toBe('query')
    // v0.1.459：scope 改 Graph（Ethan 拍板 Outlook OAuth 走 Graph 通道）；457 钉的 IMAP scope 就此作废
    expect(u.searchParams.get('scope')).toBe('https://graph.microsoft.com/Mail.ReadWrite offline_access')
  })

  it('Google 授权 URL 的 host+path 精确等于 /o/oauth2/v2/auth 且带必需参数', () => {
    const u = new URL(buildOAuthUrl('google', 'cid-1', 18765))
    expect(u.protocol).toBe('https:')
    expect(u.host).toBe('accounts.google.com')
    expect(u.pathname).toBe('/o/oauth2/v2/auth')
    expect(u.searchParams.get('client_id')).toBe('cid-1')
    expect(u.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:18765')
    expect(u.searchParams.get('response_type')).toBe('code')
    expect(u.searchParams.get('scope')).toBe('https://mail.google.com/')
    expect(u.searchParams.get('access_type')).toBe('offline')
    expect(u.searchParams.get('prompt')).toBe('consent')
  })
})

describe('错误文本显示清洗与后缀决策（447）', () => {
  // Ethan 实机截图原文形态：panic 信息带着字面 \n 显示
  const panicText = '连接任务异常结束：task 112 panicked with message "\\nCould not automatically determine the process-level CryptoProvider from Rustls crate features.\\nCall CryptoProvider::install_default() before this point"'

  it('字面 \\n / \\" 还原为空格与引号，不再显示转义符', () => {
    const out = displayMailError(panicText)
    expect(out).not.toContain('\\n')
    expect(out).toContain('Could not automatically determine the process-level CryptoProvider')
    expect(out).toContain('task 112 panicked')
  })

  it('普通多行错误压成单行可读文本', () => {
    expect(displayMailError('a1 NO  Login   failed')).toBe('a1 NO Login failed')
  })

  it('panic / CryptoProvider 属内部错误，不拼「请检查服务器/授权码」', () => {
    expect(isMailInternalError(panicText)).toBe(true)
    expect(shouldSuggestCredentialCheck(panicText)).toBe(false)
  })

  it('服务器登录失败拼后缀；超时类不拼', () => {
    expect(shouldSuggestCredentialCheck('a1 NO Login failed: authentication rejected')).toBe(true)
    expect(shouldSuggestCredentialCheck('等待服务器问候语超时（10 秒内服务器没有响应）')).toBe(false)
    expect(shouldSuggestCredentialCheck('')).toBe(false)
  })
})

describe('OAuth 令牌声明校验与 not connected 映射（458）', () => {
  const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const makeJwt = (payload: Record<string, unknown>) =>
    `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}.fakesig`
  const outlookAcct: MailAccountMeta = {
    id: 'mail-ms-1', platformId: 'outlook', email: 'ethan458@outlook.com',
    label: 'ethan458@outlook.com', host: 'outlook.office365.com', port: 993,
  }
  const goodPayload = {
    aud: 'https://outlook.office.com',
    scp: 'openid profile IMAP.AccessAsUser.All',
    upn: 'ethan458@outlook.com',
  }

  it('JWT 解码：三段式解出 payload，非 JWT / 坏 JSON 返回 null', () => {
    expect(decodeJwtPayload(makeJwt({ aud: 'x', n: 1 }))).toEqual({ aud: 'x', n: 1 })
    expect(decodeJwtPayload('at-446-opaque')).toBeNull()
    expect(decodeJwtPayload('a.b')).toBeNull()
    expect(decodeJwtPayload(`h.${b64url('not json')}.s`)).toBeNull()
    expect(decodeJwtPayload('')).toBeNull()
  })

  it('声明全对 → 放行（upn 大小写不同也算同一个）', () => {
    expect(diagnoseOAuthTokenForImap(outlookAcct, makeJwt(goodPayload))).toBeNull()
    expect(diagnoseOAuthTokenForImap(outlookAcct, makeJwt({ ...goodPayload, upn: 'Ethan458@Outlook.com' }))).toBeNull()
    expect(diagnoseOAuthTokenForImap(outlookAcct, makeJwt({ ...goodPayload, aud: 'https://outlook.office365.com' }))).toBeNull()
    expect(diagnoseOAuthTokenForImap(outlookAcct, makeJwt({ ...goodPayload, scp: 'https://outlook.office.com/IMAP.AccessAsUser.All' }))).toBeNull()
  })

  it('aud 不是 Outlook 资源 → 令牌权限不对、要求重新授权', () => {
    const msg = diagnoseOAuthTokenForImap(outlookAcct, makeJwt({ ...goodPayload, aud: 'https://graph.microsoft.com' }))
    expect(msg).toContain('令牌权限不对')
    expect(msg).toContain('请删除账户后重新授权')
  })

  it('scp 缺 IMAP.AccessAsUser.All → 令牌权限不对（缺 IMAP 权限）', () => {
    const msg = diagnoseOAuthTokenForImap(outlookAcct, makeJwt({ ...goodPayload, scp: 'openid profile email' }))
    expect(msg).toBe('令牌权限不对（缺 IMAP 权限），请删除账户后重新授权')
  })

  it('upn 与填写邮箱不一致 → 精确点名两个账户（preferred_username 同样拦）', () => {
    const msg = diagnoseOAuthTokenForImap(outlookAcct, makeJwt({ ...goodPayload, upn: 'other458@outlook.com' }))
    expect(msg).toBe('授权登录的账户是 other458@outlook.com，与填写的邮箱 ethan458@outlook.com 不是同一个，请重新授权并在浏览器里选对账户')
    const msg2 = diagnoseOAuthTokenForImap(outlookAcct, makeJwt({ aud: goodPayload.aud, scp: goodPayload.scp, preferred_username: 'third458@outlook.com' }))
    expect(msg2).toContain('third458@outlook.com')
    expect(msg2).toContain('选对账户')
  })

  it('解不出 JWT / 声明缺失 → 不拦截（诊断不当新故障源）', () => {
    expect(diagnoseOAuthTokenForImap(outlookAcct, 'ya29.opaque-google-style')).toBeNull()
    expect(diagnoseOAuthTokenForImap(outlookAcct, makeJwt({ exp: 1 }))).toBeNull()
  })

  it('非微软平台不做此校验（Gmail 账户拿 JWT 形令牌也放行）', () => {
    const gmailAcct: MailAccountMeta = {
      id: 'mail-g-1', platformId: 'gmail', email: 'ethan458@gmail.com',
      label: 'ethan458@gmail.com', host: 'imap.gmail.com', port: 993,
    }
    expect(diagnoseOAuthTokenForImap(gmailAcct, makeJwt({ aud: 'https://graph.microsoft.com', upn: 'x@y.com' }))).toBeNull()
  })

  it('「authenticated but not connected」映射：指引在前、原文保留、重复调用不叠加', () => {
    const raw = 'a1 NO User is authenticated but not connected.'
    const out = displayMailError(raw)
    expect(out.startsWith(MAIL_NOT_CONNECTED_GUIDANCE)).toBe(true)
    expect(out).toContain('浏览器里授权登录的账户与填写的邮箱不是同一个')
    expect(out).toContain('IMAP 已开启')
    expect(out.endsWith(raw)).toBe(true)
    const twice = displayMailError(out)
    expect(twice.split('没把它连上这个邮箱').length - 1).toBe(1)
    expect(displayMailError('a1 NO Login failed')).toBe('a1 NO Login failed')
  })
})

describe('OAuth 注册引导与实现一致性（446）', () => {
  it('Google：需要 Secret、步骤含桌面应用类型、回调说明与回环实现一致', () => {
    const g = OAUTH_REGISTER_GUIDES.google
    expect(g.needsSecret).toBe(true)
    expect(g.steps.length).toBeGreaterThanOrEqual(4)
    expect(g.steps.join('')).toContain('桌面应用')
    expect(g.steps.join('')).toContain('Gmail API')
    expect(g.callbackNote).toContain('127.0.0.1')
  })
  it('Microsoft：公共客户端不需要 Secret、步骤含移动和桌面平台与回环 URI', () => {
    const m = OAUTH_REGISTER_GUIDES.microsoft
    expect(m.needsSecret).toBe(false)
    expect(m.steps.length).toBeGreaterThanOrEqual(4)
    expect(m.steps.join('')).toContain('移动和桌面应用程序')
    expect(m.steps.join('')).toContain('http://127.0.0.1')
    expect(m.callbackNote).toContain('127.0.0.1')
  })
  it('回调 error 翻译：拒绝与凭据错误分开说', () => {
    expect(describeOAuthCallbackError('access_denied')).toContain('拒绝了授权')
    expect(describeOAuthCallbackError('invalid_client')).toContain('客户端凭据')
    expect(describeOAuthCallbackError('server_error')).toContain('server_error')
  })
})

describe('OAuth 客户端凭据存储（446）', () => {
  it('加密往返：localStorage 里没有明文、读回一致、清除后读不到', async () => {
    await initVault('test1234')
    await saveOAuthClientCreds('google', { clientId: 'cid-xyz', clientSecret: 'sec-xyz' }, 'test1234')
    const raw = localStorage.getItem('acm.mail.oauthClients.v1') ?? ''
    expect(raw).not.toContain('cid-xyz')
    expect(raw).not.toContain('sec-xyz')
    await expect(loadOAuthClientCreds('google', 'test1234')).resolves.toEqual({ clientId: 'cid-xyz', clientSecret: 'sec-xyz' })
    await expect(loadOAuthClientCreds('google', 'wrong-pass')).resolves.toBeNull()
    await expect(loadOAuthClientCreds('microsoft', 'test1234')).resolves.toBeNull()
    clearOAuthClientCreds('google')
    await expect(loadOAuthClientCreds('google', 'test1234')).resolves.toBeNull()
  })
})

describe('重新授权标记（446）', () => {
  it('set/load/clear 往返', () => {
    expect(loadMailReauthFlags()).toEqual({})
    setMailReauthFlag('a1', '授权令牌已被撤销或失效，需要重新授权')
    expect(loadMailReauthFlags()['a1']).toContain('重新授权')
    clearMailReauthFlag('a1')
    expect(loadMailReauthFlags()).toEqual({})
  })
})

describe('浏览器授权编排（446）', () => {
  const g = globalThis as unknown as { window?: unknown }
  let calls: { cmd: string; args?: Record<string, unknown> }[]
  const stubOAuthWindow = (handler: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>, timeoutMs?: number) => {
    calls = []
    g.window = {
      ...(timeoutMs ? { __ACM_MAIL_OAUTH_TIMEOUT_MS__: timeoutMs } : {}),
      __TAURI_INTERNALS__: {
        invoke: (cmd: string, args?: Record<string, unknown>) => { calls.push({ cmd, args }); return handler(cmd, args) },
      },
    }
  }
  afterEach(() => { delete g.window })

  const tokenOk = JSON.stringify({
    status: 200,
    body: JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }),
    headers: {},
  })

  it('顺利路径：开浏览器 URL 参数正确 → 回调 code → 换令牌成功', async () => {
    let polls = 0
    stubOAuthWindow(async cmd => {
      if (cmd === 'mail_oauth_listen_start') return 18765
      if (cmd === 'mail_oauth_listen_result') { polls += 1; return polls < 2 ? null : { code: 'code-1', error: null } }
      if (cmd === 'plugin_http') return tokenOk
      return null
    })
    const secret = await mailOAuthAuthorize('google', 'cid-1', 'sec-1')
    expect(secret.kind).toBe('oauth')
    if (secret.kind === 'oauth') {
      expect(secret.accessTok).toBe('at-1')
      expect(secret.refreshTok).toBe('rt-1')
      expect(secret.clientId).toBe('cid-1')
    }
    const openCall = calls.find(c => c.cmd === 'open_url')
    const url = String(openCall?.args?.url ?? '')
    expect(url).toContain('accounts.google.com')
    expect(url).toContain('response_type=code')
    expect(url).toContain('client_id=cid-1')
    expect(url).toContain('127.0.0.1%3A18765')
  })

  it('用户在浏览器拒绝：报「拒绝了授权」并终止监听', async () => {
    stubOAuthWindow(async cmd => {
      if (cmd === 'mail_oauth_listen_start') return 18766
      if (cmd === 'mail_oauth_listen_result') return { code: null, error: 'access_denied' }
      return null
    })
    await expect(mailOAuthAuthorize('microsoft', 'cid-2', '')).rejects.toThrow('拒绝了授权')
    expect(calls.map(c => c.cmd)).toContain('mail_oauth_listen_stop')
  })

  it('回调超时：报超时并终止监听', async () => {
    stubOAuthWindow(async cmd => {
      if (cmd === 'mail_oauth_listen_start') return 18767
      if (cmd === 'mail_oauth_listen_result') return null
      return null
    }, 100)
    await expect(mailOAuthAuthorize('google', 'cid-1', 'sec-1')).rejects.toThrow('等待浏览器授权超时')
    expect(calls.map(c => c.cmd)).toContain('mail_oauth_listen_stop')
  })

  it('取消：抛 OAUTH_CANCELLED 并终止监听', async () => {
    stubOAuthWindow(async cmd => {
      if (cmd === 'mail_oauth_listen_start') return 18768
      if (cmd === 'mail_oauth_listen_result') return null
      return null
    })
    await expect(mailOAuthAuthorize('google', 'cid-1', 'sec-1', { isCancelled: () => true })).rejects.toThrow(OAUTH_CANCELLED)
    expect(calls.map(c => c.cmd)).toContain('mail_oauth_listen_stop')
  })

  it('换令牌被拒：透传服务器真实原因', async () => {
    stubOAuthWindow(async cmd => {
      if (cmd === 'mail_oauth_listen_start') return 18769
      if (cmd === 'mail_oauth_listen_result') return { code: 'bad-code', error: null }
      if (cmd === 'plugin_http') return JSON.stringify({ status: 400, body: '{"error":"invalid_grant","error_description":"Bad Request"}', headers: {} })
      return null
    })
    await expect(mailOAuthAuthorize('google', 'cid-1', 'sec-1')).rejects.toThrow('OAuth 换令牌失败（400）')
  })
})

describe('v0.1.450 BODYSTRUCTURE 解析', () => {
  it('单段纯文本：section 为 TEXT，带 charset/encoding/size', () => {
    const raw = '* 1 FETCH (UID 11 BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 123 4))\r\n'
    const parts = parseBodyStructure(raw)
    expect(parts).toEqual([{ section: 'TEXT', contentType: 'text/plain', charset: 'UTF-8', encoding: '7BIT', size: 123, filename: undefined, cid: undefined, disposition: undefined }])
  })

  it('mixed 嵌 alternative + 内嵌图 + pdf 附件：段号与元信息齐全', () => {
    const alt = '(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "BASE64" 100 3) ("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "QUOTED-PRINTABLE" 200 5) "ALTERNATIVE" NIL NIL NIL)'
    const img = '("IMAGE" "PNG" ("NAME" "logo.png") "<cid-1@local>" NIL "BASE64" 999)'
    const pdf = '("APPLICATION" "PDF" ("NAME" "bill.pdf") NIL NIL "BASE64" 5000 NIL ("ATTACHMENT" ("FILENAME" "bill.pdf")) NIL NIL)'
    const rawFull = `* 3 FETCH (UID 33 BODYSTRUCTURE (${alt} ${img} ${pdf} "MIXED" NIL NIL NIL))\r\n`
    const parts = parseBodyStructure(rawFull)
    const bySection = Object.fromEntries(parts.map(p => [p.section, p]))
    expect(Object.keys(bySection).sort()).toEqual(['1.1', '1.2', '2', '3'])
    expect(bySection['1.1'].contentType).toBe('text/plain')
    expect(bySection['1.2'].contentType).toBe('text/html')
    expect(bySection['1.2'].encoding).toBe('QUOTED-PRINTABLE')
    expect(bySection['2'].contentType).toBe('image/png')
    expect(bySection['2'].cid).toBe('cid-1@local')
    expect(bySection['3'].contentType).toBe('application/pdf')
    expect(bySection['3'].disposition).toBe('attachment')
    expect(bySection['3'].filename).toBe('bill.pdf')
    expect(bySection['3'].size).toBe(5000)
  })

  it('垃圾报文返回空数组（调用方据此回落全文拉取）', () => {
    expect(parseBodyStructure('')).toEqual([])
    expect(parseBodyStructure('* 1 FETCH (UID 1 FLAGS (\\Seen))')).toEqual([])
    expect(parseBodyStructure('* 1 FETCH (UID 1 BODYSTRUCTURE (BROKEN')).toEqual([])
  })
})

describe('v0.1.450 按段组装正文', () => {
  it('文本段解码、cid 图进 inlineImages、附件只记元信息', () => {
    const bs = '(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "BASE64" 10 1) ("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "7BIT" 20 1) ("IMAGE" "PNG" ("NAME" "a.png") "img1@x" NIL "BASE64" 4) ("APPLICATION" "PDF" NIL NIL NIL "BASE64" 5000 NIL ("ATTACHMENT" ("FILENAME" "bill.pdf"))) "MIXED")'
    const parts = parseBodyStructure(`* 1 FETCH (UID 7 BODYSTRUCTURE ${bs})`)
    const enc = (s: string) => new TextEncoder().encode(s)
    const data = new Map<string, Uint8Array>([
      ['1', enc(Buffer.from('你好正文', 'utf-8').toString('base64'))],
      ['2', enc('<p>你好 <b>HTML</b></p>')],
      ['3', enc(Buffer.from([1, 2, 3]).toString('base64'))],
      // 段 4（附件）不取数：data 里没有它
    ])
    const body = assembleBodyFromParts(parts, data)
    expect(body.text).toBe('你好正文')
    expect(body.html).toBe('<p>你好 <b>HTML</b></p>')
    expect(body.inlineImages).toEqual([{ cid: 'img1@x', contentType: 'image/png', base64: bytesToBase64(new Uint8Array([1, 2, 3])) }])
    expect(body.attachments).toEqual([{ filename: 'bill.pdf', contentType: 'application/pdf', size: 5000, section: '4', encoding: 'BASE64' }])
  })
})

describe('v0.1.450 正文缓存与连接步骤文案', () => {
  const sample: MailBodyResult = { text: '正文', html: '', attachments: [], inlineImages: [], code: null }
  it('存取与按 key 删除', () => {
    saveCachedBody('a|INBOX|1', sample)
    expect(loadCachedBody('a|INBOX|1')?.text).toBe('正文')
    dropCachedBodies(['a|INBOX|1'])
    expect(loadCachedBody('a|INBOX|1')).toBeNull()
  })
  it('超大正文不进缓存（避免撑爆 localStorage）', () => {
    saveCachedBody('a|INBOX|2', { ...sample, text: 'x'.repeat(1_100_000) })
    expect(loadCachedBody('a|INBOX|2')).toBeNull()
  })
  it('连接步骤三段文案齐全', () => {
    expect(MAIL_CONNECT_STEP_LABELS.connecting).toContain('正在连接')
    expect(MAIL_CONNECT_STEP_LABELS.handshaking).toContain('握手')
    expect(MAIL_CONNECT_STEP_LABELS['logging-in']).toContain('登录验证')
  })
})

/* ================= v0.1.459：Outlook OAuth 走 Microsoft Graph 通道 ================= */

const OUTLOOK_META: MailAccountMeta = { id: 'acc-459', email: 'someone@outlook.com', platformId: 'outlook', label: 'someone@outlook.com', host: 'outlook.office365.com', port: 993 }

function graphJwt(payload: Record<string, unknown>): string {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${seg({ alg: 'RS256', typ: 'JWT' })}.${seg(payload)}.sig`
}

function stubTauriInvoke(handler: (cmd: string, args: Record<string, unknown>) => unknown) {
  const g = globalThis as unknown as { window: unknown }
  g.window = { __TAURI_INTERNALS__: { invoke: (cmd: string, args: Record<string, unknown>) => handler(cmd, args ?? {}) } }
}

function b64Json(status: number, obj: unknown) {
  return JSON.stringify({ status, bodyBase64: Buffer.from(JSON.stringify(obj)).toString('base64'), headers: {} })
}

describe('v0.1.459 Graph scope 与令牌自检', () => {
  it('Graph scope 常量就是 Mail.ReadWrite + offline_access', () => {
    expect(MS_GRAPH_SCOPE).toBe('https://graph.microsoft.com/Mail.ReadWrite offline_access')
  })
  it('Graph 令牌全对（aud=graph、scp 含 Mail.ReadWrite、upn 一致）→ 放行', () => {
    const tok = graphJwt({ aud: 'https://graph.microsoft.com', scp: 'openid profile Mail.ReadWrite', upn: 'someone@outlook.com', exp: 9999999999 })
    expect(diagnoseOAuthTokenForGraph(OUTLOOK_META, tok)).toBeNull()
  })
  it('aud 还是 outlook.office.com（旧 IMAP 令牌）→ 报发给错资源', () => {
    const tok = graphJwt({ aud: 'https://outlook.office.com', scp: 'IMAP.AccessAsUser.All', upn: 'someone@outlook.com', exp: 9999999999 })
    expect(diagnoseOAuthTokenForGraph(OUTLOOK_META, tok)).toContain('不是发给微软 Graph')
  })
  it('scp 缺 Mail.ReadWrite → 报缺邮件读写权限', () => {
    const tok = graphJwt({ aud: 'https://graph.microsoft.com', scp: 'openid profile User.Read', upn: 'someone@outlook.com', exp: 9999999999 })
    expect(diagnoseOAuthTokenForGraph(OUTLOOK_META, tok)).toContain('缺邮件读写权限')
  })
  it('upn 与账户邮箱不一致 → 点名两个地址', () => {
    const tok = graphJwt({ aud: 'https://graph.microsoft.com', scp: 'Mail.ReadWrite', upn: 'other@outlook.com', exp: 9999999999 })
    const msg = diagnoseOAuthTokenForGraph(OUTLOOK_META, tok) ?? ''
    expect(msg).toContain('other@outlook.com')
    expect(msg).toContain('someone@outlook.com')
  })
  it('解不出的令牌、Gmail 账户 → 放行（不误拦）', () => {
    expect(diagnoseOAuthTokenForGraph(OUTLOOK_META, 'not-a-jwt')).toBeNull()
    const gmailTok = graphJwt({ aud: 'x', scp: 'y', upn: 'z@z.z' })
    expect(diagnoseOAuthTokenForGraph({ ...OUTLOOK_META, platformId: 'gmail', email: 'a@gmail.com' }, gmailTok)).toBeNull()
  })
  it('not connected 指引按通道分开：Graph 账户不再提 IMAP 开关，IMAP 账户保持原样', () => {
    const raw = 'IMAP 错误：User is authenticated but not connected'
    const g = displayMailError(raw, { transport: 'graph' })
    expect(g).toContain('Graph')
    expect(g).not.toContain('IMAP 已开启')
    expect(displayMailError(raw)).toContain('IMAP 已开启')
  })
})

describe('v0.1.459 Graph 响应映射', () => {
  it('文件夹：name 存 id、label 存显示名、角色与计数映射', () => {
    const f = mapGraphFolder({ id: 'fid-1', displayName: 'Deleted Items', totalItemCount: 7, unreadItemCount: 2 })
    expect(f.name).toBe('fid-1')
    expect(f.label).toBe('Deleted Items')
    expect(f.role).toBe('trash')
    expect(f.total).toBe(7)
    expect(f.unread).toBe(2)
    // 知名文件夹的角色以端点语义为准，不靠显示名猜
    expect(mapGraphFolder({ id: 'fid-2', displayName: '收件箱' }, 'inbox').role).toBe('inbox')
  })
  it('消息：字段映射、已读/星标转 flags、验证码分类、uid 稳定', () => {
    const raw = {
      id: 'AAMk-1', subject: '您的验证码是 123456',
      from: { emailAddress: { name: '服务台', address: 'notice@service.example' } },
      receivedDateTime: '2026-11-26T07:00:00Z', isRead: false, hasAttachments: true,
      bodyPreview: '您的验证码是 123456', flag: { flagStatus: 'flagged' },
    }
    const m = mapGraphMessage(raw, 'acc-459', 'fid-1')
    expect(m.graphId).toBe('AAMk-1')
    expect(m.from).toBe('服务台')
    expect(m.fromAddr).toBe('notice@service.example')
    expect(m.flags).toContain('\\Flagged')
    expect(m.flags).not.toContain('\\Seen')
    expect(m.hasAttach).toBe(true)
    expect(m.category).toBe('code')
    expect(m.key).toBe(`acc-459|fid-1|${m.uid}`)
    expect(m.uid).toBe(hashGraphId('AAMk-1'))
    expect(mapGraphMessage({ ...raw, isRead: true }, 'acc-459', 'fid-1').flags).toContain('\\Seen')
    expect(hashGraphId('AAMk-1')).not.toBe(hashGraphId('AAMk-2'))
    expect(hashGraphId('AAMk-1')).toBeGreaterThan(0)
  })
  it('Graph 错误透传：JSON 错误体提取 code 与 message；非 JSON 用原文', () => {
    const d = graphErrorDetail(401, '{"error":{"code":"InvalidAuthenticationToken","message":"Access token is empty."}}')
    expect(d).toContain('401')
    expect(d).toContain('InvalidAuthenticationToken')
    expect(d).toContain('Access token is empty.')
    expect(graphErrorDetail(500, 'raw boom')).toContain('500')
    expect(graphErrorDetail(500, 'raw boom')).toContain('raw boom')
  })
  it('graphListFolders 遇 401 → 抛错带状态码与微软原文，不吞', async () => {
    stubTauriInvoke((cmd) => {
      if (cmd === 'plugin_http_b64') return b64Json(401, { error: { code: 'InvalidAuthenticationToken', message: 'bad token' } })
      throw new Error(`unexpected ${cmd}`)
    })
    await expect(graphListFolders('tok')).rejects.toThrow(/401/)
    await expect(graphListFolders('tok')).rejects.toThrow(/InvalidAuthenticationToken/)
  })
})

describe('v0.1.459 旧令牌迁移检出与 Graph 同步', () => {
  const PWD = 'test1234'
  beforeEach(() => localStorage.clear())

  it('未过期旧 IMAP 令牌（aud=outlook、无 scope 记录）→ 同步失败给迁移原因 + 打 reauth 标记 + 不发 Graph 请求', async () => {
    await initVault(PWD)
    const legacyTok = graphJwt({ aud: 'https://outlook.office.com', scp: 'IMAP.AccessAsUser.All', upn: 'someone@outlook.com', exp: 9999999999 })
    const secret: MailSecret = { kind: 'oauth', accessTok: legacyTok, refreshTok: 'rt-old', expiresAt: Date.now() + 3600_000, clientId: 'cid', clientSecret: '' }
    const acc = await addMailAccount({ email: 'someone@outlook.com', platformId: 'outlook', label: 'someone@outlook.com', host: 'outlook.office365.com', port: 993 }, secret, PWD)
    const calls: string[] = []
    stubTauriInvoke((cmd) => { calls.push(cmd); throw new Error('不应发网络') })
    const out = await mailSyncAccount(acc, PWD)
    expect(out.ok).toBe(false)
    expect(out.error).toContain('Graph 通道')
    expect(out.error).toContain('重新授权')
    expect(loadMailReauthFlags()[acc.id]).toContain('Graph 通道')
    expect(calls).not.toContain('plugin_http_b64')
    expect(calls).not.toContain('mail_imap_connect')
  })

  it('已过期旧令牌刷新被拒（invalid_grant 且无 Graph 范围）→ 同样走迁移文案与标记', async () => {
    await initVault(PWD)
    const secret: MailSecret = { kind: 'oauth', accessTok: 'opaque-old', refreshTok: 'rt-old', expiresAt: 1, clientId: 'cid', clientSecret: '' }
    const acc = await addMailAccount({ email: 'someone@outlook.com', platformId: 'outlook', label: 'someone@outlook.com', host: 'outlook.office365.com', port: 993 }, secret, PWD)
    stubTauriInvoke((cmd) => {
      if (cmd === 'plugin_http') return JSON.stringify({ status: 400, body: JSON.stringify({ error: 'invalid_grant', error_description: 'grant expired' }), headers: {} })
      throw new Error(`unexpected ${cmd}`)
    })
    const out = await mailSyncAccount(acc, PWD)
    expect(out.ok).toBe(false)
    expect(out.error).toContain(MAIL_GRAPH_MIGRATION_MESSAGE)
    expect(loadMailReauthFlags()[acc.id]).toBeTruthy()
  })

  it('Graph 令牌账户：同步走 plugin_http_b64 出邮件、回填 transport=graph、轮询档（idleSupported=false）、正文预取走 $value', async () => {
    await initVault(PWD)
    const tok = graphJwt({ aud: 'https://graph.microsoft.com', scp: 'Mail.ReadWrite', upn: 'someone@outlook.com', exp: 9999999999 })
    const secret: MailSecret = { kind: 'oauth', accessTok: tok, refreshTok: 'rt-g', expiresAt: Date.now() + 3600_000, clientId: 'cid', clientSecret: '', scope: MS_GRAPH_SCOPE }
    const acc = await addMailAccount({ email: 'someone@outlook.com', platformId: 'outlook', label: 'someone@outlook.com', host: 'outlook.office365.com', port: 993 }, secret, PWD)
    const inbox = { id: 'fid-inbox', displayName: 'Inbox', totalItemCount: 1, unreadItemCount: 1, childFolderCount: 0 }
    const trash = { id: 'fid-trash', displayName: 'Deleted Items', totalItemCount: 0, unreadItemCount: 0, childFolderCount: 0 }
    const msg = {
      id: 'AAMk-9', subject: '459 同步测试', from: { emailAddress: { name: 'Boss', address: 'boss@example.com' } },
      receivedDateTime: '2026-11-26T07:00:00Z', isRead: false, hasAttachments: false, bodyPreview: 'hi', flag: { flagStatus: 'notFlagged' },
    }
    const mime = 'From: Boss <boss@example.com>\r\nSubject: 459\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nGraph body 459\r\n'
    const imapCalls: string[] = []
    stubTauriInvoke((cmd, args) => {
      if (cmd.startsWith('mail_imap')) { imapCalls.push(cmd); throw new Error('Graph 账户不许走 IMAP') }
      if (cmd !== 'plugin_http_b64') throw new Error(`unexpected ${cmd}`)
      const url = String(args['url'])
      if (url.includes('/mailFolders/inbox?')) return b64Json(200, { id: 'fid-inbox' })
      if (/\/mailFolders\/(sentitems|drafts|deleteditems|junkemail|archive)\?/.test(url)) return b64Json(404, { error: { code: 'ErrorFolderNotFound', message: 'no' } })
      if (url.includes('/messages/') && url.includes('$value')) return JSON.stringify({ status: 200, bodyBase64: Buffer.from(mime).toString('base64'), headers: {} })
      if (url.includes('/mailFolders/fid-inbox/messages')) return b64Json(200, { value: [msg] })
      if (url.includes('/messages?')) return b64Json(200, { value: [] })
      if (url.includes('/mailFolders?')) return b64Json(200, { value: [inbox, trash] })
      throw new Error(`unrouted ${url}`)
    })
    const out = await mailSyncAccount(acc, PWD)
    expect(out.ok).toBe(true)
    expect(out.caps).toBe('GRAPH')
    expect(out.idleSupported).toBe(false) // Graph 无 IDLE：界面如实标轮询
    expect(imapCalls).toEqual([])
    const cached = loadMailCache()[acc.id]
    expect(cached.messages).toHaveLength(1)
    expect(cached.messages[0].graphId).toBe('AAMk-9')
    expect(cached.folders.map(f => f.role)).toContain('trash')
    expect(listMailAccounts().find(a => a.id === acc.id)?.transport).toBe('graph')
    // 正文预取（450 缓存层）走 $value：等微任务跑完后缓存里应有正文
    await new Promise(r => setTimeout(r, 30))
    expect(loadCachedBody(cached.messages[0].key)?.text).toContain('Graph body 459')
  })
})

/* ================= v0.1.466：一键删除全部——快照秒开 / 并发核对 / 真进度 / 取消 / 分步超时 =================
 * 全部走 invoke 打桩跑真实 mailDeleteAll / mailDeleteAllPreview（与真机同一份代码），
 * 断言进度事件序列、取消行为与计数口径，而不是只测纯函数。 */

describe('v0.1.466 删除全部（打桩全流程）', () => {
  const PWD = 'test1234'
  const g = globalThis as unknown as { window?: Record<string, unknown> }
  beforeEach(() => localStorage.clear())
  afterEach(() => { delete g.window })

  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)
  const searchRaw = (uids: number[]) => `* SEARCH ${uids.join(' ')}\r\na5 OK done`

  async function makeImapAccount(email: string): Promise<MailAccountMeta> {
    return addMailAccount(
      { email, platformId: 'qq', label: email, host: 'imap.qq.com', port: 993 },
      { kind: 'code', secret: 'authcode-1' },
      PWD,
    )
  }

  /** 通用 IMAP 打桩：folders 给 {name, uids}（名字含 Trash 自动带 \Trash 标记），可覆盖单命令行为 */
  function stubImap(folders: { name: string; uids: number[] }[], overrides?: (cmd: string, args: Record<string, unknown>) => unknown) {
    const deleteCalls: { folder: string; count: number }[] = []
    // 必须 async：tauriInvoke 直传 invoke 的返回值，raceTimeout 要真 Promise（裸值会炸 p.then）
    stubTauriInvoke(async (cmd, args) => {
      if (overrides) {
        const r = overrides(cmd, args)
        if (r !== undefined) return r
      }
      if (cmd === 'mail_imap_connect') return 'IMAP4rev1 IDLE'
      if (cmd === 'mail_imap_disconnect') return null
      if (cmd === 'mail_imap_list_folders') {
        return folders.map(f => `* LIST (\\HasNoChildren${f.name === 'Trash' ? ' \\Trash' : ''}) "/" "${f.name}"`).join('\r\n') + '\r\na3 OK List completed'
      }
      if (cmd === 'mail_imap_folder_counts') {
        const counts: Record<string, number> = {}
        for (const f of folders) counts[f.name] = f.uids.length
        return JSON.stringify(counts)
      }
      if (cmd === 'mail_imap_search_all') {
        const f = folders.find(x => x.name === args['folder'])
        return searchRaw(f ? f.uids : [])
      }
      if (cmd === 'mail_imap_delete_messages') {
        const uids = args['uids'] as number[]
        deleteCalls.push({ folder: String(args['folder']), count: uids.length })
        return uids.length
      }
      throw new Error(`unexpected ${cmd}`)
    })
    return { deleteCalls }
  }

  it('IMAP 进度序列：账户→文件夹→批次（450 封 3 批）→完成；垃圾箱计数口径不重复', async () => {
    await initVault(PWD)
    const acc = await makeImapAccount('a@qq.com')
    stubImap([
      { name: 'INBOX', uids: range(1, 450) },
      { name: 'Trash', uids: [901, 902] },
    ])
    const events: MailDeleteAllProgressEvent[] = []
    const [report] = await mailDeleteAll([acc], PWD, { onEvent: e => events.push(e) })
    expect(events.map(e => e.type)).toEqual([
      'account-start', 'folder-start', 'batch', 'batch', 'batch', 'folder-start', 'batch', 'account-done',
    ])
    const folderStarts = events.filter(e => e.type === 'folder-start')
    expect(folderStarts.map(e => (e.type === 'folder-start' ? e.total : 0))).toEqual([450, 2])
    const batches = events.filter(e => e.type === 'batch')
    expect(batches.map(e => (e.type === 'batch' ? e.batchIndex : 0))).toEqual([1, 2, 3, 1])
    // INBOX 450 封移入垃圾箱计 450；清垃圾箱时只计原本就在垃圾箱的 2 封，不重复计刚移入的
    expect(report.deleted).toBe(452)
    expect(report.mode).toBe('mixed')
    expect(report.error).toBeUndefined()
  })

  it('取消：第 2 批后置取消令牌 → 不再发删除、报告 cancelled 且已删=前两批实数', async () => {
    await initVault(PWD)
    const acc = await makeImapAccount('b@qq.com')
    const { deleteCalls } = stubImap([{ name: 'INBOX', uids: range(1, 450) }])
    const token = { cancelled: false }
    const events: MailDeleteAllProgressEvent[] = []
    const [report] = await mailDeleteAll([acc], PWD, {
      cancelToken: token,
      onEvent: e => {
        events.push(e)
        if (e.type === 'batch' && e.batchIndex === 2) token.cancelled = true
      },
    })
    expect(deleteCalls.length).toBe(2)
    expect(report.cancelled).toBe(true)
    expect(report.deleted).toBe(400)
    expect(events.map(e => e.type)).toContain('account-cancelled')
    expect(events.map(e => e.type)).not.toContain('account-done')
  })

  it('账户并发（≤3）与失败隔离：一个账户连接失败，其余照常删完，报告按输入序', async () => {
    await initVault(PWD)
    const accs = [await makeImapAccount('c1@qq.com'), await makeImapAccount('c2@qq.com'), await makeImapAccount('c3@qq.com')]
    let inFlight = 0
    let maxInFlight = 0
    stubImap([{ name: 'INBOX', uids: range(1, 5) }], (cmd, args) => {
      if (cmd === 'mail_imap_connect') {
        if (args['accountId'] === accs[1].id) throw new Error('a1 NO Login failed')
        return (async () => {
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          await new Promise(r => setTimeout(r, 30))
          inFlight -= 1
          return 'IMAP4rev1 IDLE'
        })()
      }
      return undefined
    })
    const reports = await mailDeleteAll(accs, PWD, {})
    expect(reports.map(r => r.accountId)).toEqual(accs.map(a => a.id))
    expect(reports[0].deleted).toBe(5)
    expect(reports[1].error).toContain('Login failed')
    expect(reports[2].deleted).toBe(5)
    expect(maxInFlight).toBeGreaterThanOrEqual(2)
    expect(maxInFlight).toBeLessThanOrEqual(3)
  })

  it('取消发生在开始前：其余账户标 notStarted、一封未删', async () => {
    await initVault(PWD)
    const acc = await makeImapAccount('d@qq.com')
    const { deleteCalls } = stubImap([{ name: 'INBOX', uids: range(1, 3) }])
    const [report] = await mailDeleteAll([acc], PWD, { cancelToken: { cancelled: true } })
    expect(report.notStarted).toBe(true)
    expect(report.deleted).toBe(0)
    expect(deleteCalls.length).toBe(0)
  })

  /** Graph 打桩：inboxCount 封收件箱 + 垃圾箱 t1/t2；batchImpl 可替换 $batch 行为 */
  function stubGraph(inboxCount: number, batchImpl?: (body: { requests: { id: string }[] }) => unknown) {
    const inbox = { id: 'fid-inbox', displayName: 'Inbox', totalItemCount: inboxCount, unreadItemCount: 0, childFolderCount: 0 }
    const trash = { id: 'fid-trash', displayName: 'Deleted Items', totalItemCount: 2, unreadItemCount: 0, childFolderCount: 0 }
    stubTauriInvoke(async (cmd, args) => {
      if (cmd !== 'plugin_http_b64') throw new Error(`unexpected ${cmd}`)
      const url = String(args['url'])
      if (url.endsWith('/$batch')) {
        const body = JSON.parse(String(args['body'])) as { requests: { id: string }[] }
        if (batchImpl) return batchImpl(body)
        return b64Json(200, { responses: body.requests.map(r => ({ id: r.id, status: 200, body: {} })) })
      }
      if (url.includes('/mailFolders/inbox?')) return b64Json(200, { id: 'fid-inbox' })
      if (url.includes('/mailFolders/deleteditems?')) return b64Json(200, { id: 'fid-trash' })
      if (url.includes('/mailFolders/') && url.includes('?$select=id')) return b64Json(404, { error: { code: 'ErrorFolderNotFound', message: 'no' } })
      if (url.includes('$top=100')) return b64Json(200, { value: [inbox, trash] })
      if (url.includes('$top=1&')) return b64Json(200, { value: [] })
      if (url.includes('/mailFolders/fid-inbox/messages')) return b64Json(200, { value: range(1, inboxCount).map(i => ({ id: `m${i}` })) })
      if (url.includes('/mailFolders/fid-trash/messages')) return b64Json(200, { value: [{ id: 't1' }, { id: 't2' }] })
      throw new Error(`unrouted ${url}`)
    })
  }

  async function makeGraphAccount(email: string): Promise<MailAccountMeta> {
    const tok = graphJwt({ aud: 'https://graph.microsoft.com', scp: 'Mail.ReadWrite', upn: email, exp: 9999999999 })
    const secret: MailSecret = { kind: 'oauth', accessTok: tok, refreshTok: 'rt-g', expiresAt: Date.now() + 3600_000, clientId: 'cid', clientSecret: '', scope: MS_GRAPH_SCOPE }
    return addMailAccount({ email, platformId: 'outlook', label: email, host: 'outlook.office365.com', port: 993 }, secret, PWD)
  }

  it('Graph 进度：收件箱 25 封分 2 批 $batch、垃圾箱只计原有 2 封', async () => {
    await initVault(PWD)
    const acc = await makeGraphAccount('someone@outlook.com')
    stubGraph(25)
    const events: MailDeleteAllProgressEvent[] = []
    const [report] = await mailDeleteAll([acc], PWD, { onEvent: e => events.push(e) })
    expect(events.map(e => e.type)).toEqual([
      'account-start', 'folder-start', 'batch', 'batch', 'folder-start', 'batch', 'account-done',
    ])
    const batches = events.filter(e => e.type === 'batch')
    expect(batches.map(e => (e.type === 'batch' ? e.deletedInFolder : 0))).toEqual([20, 25, 2])
    expect(report.deleted).toBe(27)
    expect(report.mode).toBe('mixed')
    expect(report.error).toBeUndefined()
  })

  it('Graph 单步超时：$batch 挂死 → 该账户按超时失败收场，整体不挂住', async () => {
    await initVault(PWD)
    const acc = await makeGraphAccount('someone@outlook.com')
    stubGraph(1, () => new Promise(() => {}))
    ;(g.window as Record<string, unknown>)['__ACM_MAIL_GRAPH_TIMEOUT_MS__'] = 40
    const t0 = Date.now()
    const [report] = await mailDeleteAll([acc], PWD, {})
    expect(Date.now() - t0).toBeLessThan(10_000)
    expect(report.error).toContain('Graph 请求超时')
    expect(report.deleted).toBe(0)
  })

  it('快照秒开：只读本地缓存、不发任何请求；核对并发逐行回告并给出服务器数字', async () => {
    await initVault(PWD)
    const acc = await makeImapAccount('e@qq.com')
    const msg = (uid: number): MailMessage => ({
      key: `${acc.id}|INBOX|${uid}`, accountId: acc.id, folder: 'INBOX', uid,
      from: 'F', fromAddr: 'f@x.y', subject: 's', date: 0, snippet: '', flags: [], hasAttach: false, size: 0, category: 'personal',
    })
    saveMailCache({
      [acc.id]: {
        folders: [
          { name: 'INBOX', flags: [], role: 'inbox' },
          { name: 'Trash', flags: [], role: 'trash' },
        ],
        messages: [msg(1), msg(2), msg(3)],
        caps: '', updatedAt: Date.now(),
      },
    })
    stubTauriInvoke(() => { throw new Error('快照不许发网络') })
    const snap = mailDeleteAllSnapshot([acc])
    expect(snap).toHaveLength(1)
    expect(snap[0].total).toBe(3)
    expect(snap[0].mode).toBe('mixed')
    expect(snap[0].source).toBe('snapshot')

    stubImap([{ name: 'INBOX', uids: range(1, 5) }, { name: 'Trash', uids: [9] }])
    const updates: string[] = []
    const preview = await mailDeleteAllPreview([acc], PWD, e => updates.push(`${e.account.id}:${e.total}:${e.source}`))
    expect(updates).toEqual([`${acc.id}:6:verified`])
    expect(preview.total).toBe(6)
    expect(preview.perAccount[0].source).toBe('verified')
  })
})
