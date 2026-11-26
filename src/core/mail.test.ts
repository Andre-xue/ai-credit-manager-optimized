// 邮箱工具 v0.1.436 单元测试：预设 / 验证码提取 / 自动分类 / 编码解码 /
// IMAP 报文解析（报文形态与本地假 IMAP 服务器 verify436 的真实输出一致）/ MIME 解析 / 删除方式决策。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  MAIL_PLATFORMS, mailPlatform, extractVerifyCode, classifyMessage, decodeEncodedWords,
  parseListFolders, parseFetchHeaders, parseSearchUids, resolveDeleteMode, parseMimeMessage,
  htmlToText, sanitizeMailHtml, loadMailVisibility, saveMailVisibility, isAccountVisible,
  buildOAuthUrl, raceTimeout, mailConnectTimeoutMs, MAIL_CONNECT_TIMEOUT_MS,
  mailInvoke, mailStepTimeoutMs, displayMailError, isMailInternalError, shouldSuggestCredentialCheck,
  type MailFolder,
} from './mail'

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
    expect(m).toContain('IMAP.AccessAsUser.All')
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
