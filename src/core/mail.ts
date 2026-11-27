// 邮箱工具（v0.1.436，一期，仅桌面端）：多平台多账户统一收件箱。
// 架构：桌面 Rust 只做 IMAP 传输（连接/命令往返/IDLE 事件，见 desktop/src-tauri/src/mail_imap.rs），
// 协议解析（LIST/FETCH/MIME）、分类、存储都在本文件，方便用假服务器报文回归测试。
// 凭据用保险箱主密码加密、只存本机 localStorage（与 WorkBuddy 账号池同等待遇），不进云同步。
// 同步方式如实标注：服务器支持 IDLE → 实时推送；不支持 → 轮询；连接失败显示服务器原文。

import { encryptLocalSecret, decryptStoredSecret, isLegacyCipher, migrateCipherValue } from './deviceKey'
import { isDesktopApp, openExternal } from './openExternal'
import { pluginHttpDesktop } from './plugins'

// ---------------- 类型与平台预设 ----------------

export type MailPlatformId = 'gmail' | 'outlook' | 'qq' | 'net163' | 'net126' | 'icloud' | 'sina' | 'aliyun' | 'custom'
export type MailCategory = 'code' | 'security' | 'subscription' | 'ad' | 'personal'
export type MailFolderRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'other'

export interface MailPlatformPreset {
  id: MailPlatformId
  name: string
  imapHost: string
  imapPort: number
  /** oauth = 浏览器授权（需自备 OAuth 客户端）；authcode = 授权码/应用专用密码/密码 */
  auth: 'oauth' | 'authcode'
  oauthProvider?: 'google' | 'microsoft'
  secretLabel: string
  guide: string[]
}

export const MAIL_PLATFORMS: MailPlatformPreset[] = [
  {
    id: 'gmail', name: 'Gmail', imapHost: 'imap.gmail.com', imapPort: 993, auth: 'oauth', oauthProvider: 'google',
    secretLabel: '应用专用密码',
    guide: [
      '两种添加方式：①浏览器授权登录（推荐）：不交出密码，在浏览器里登录 Google 点允许即可；需要先按下方步骤卡免费注册一个你自己的 OAuth 客户端（约 5 分钟）。②应用专用密码：先在 Google 账户开启两步验证，再到「应用专用密码」生成一个 16 位密码填进来。',
      '确认 Gmail 设置 → 转发和 POP/IMAP 里已开启 IMAP。',
    ],
  },
  {
    id: 'outlook', name: 'Outlook', imapHost: 'outlook.office365.com', imapPort: 993, auth: 'oauth', oauthProvider: 'microsoft',
    secretLabel: '应用密码',
    guide: [
      '两种添加方式：①浏览器授权登录（推荐）：不交出密码，在浏览器里登录微软账户点允许即可；授权页会请你同意「读取和写入邮件」权限，邮件走微软 Graph 接口收取，不用开 IMAP；需要先按下方步骤卡在 Azure 免费注册一个应用（约 5 分钟）。②应用密码：在微软账户的安全页里生成应用密码填进来（这条走 IMAP）。',
      'Outlook.com 已逐步关闭基础密码登录；若密码登录被拒，请改用浏览器授权登录。',
    ],
  },
  {
    id: 'qq', name: 'QQ 邮箱', imapHost: 'imap.qq.com', imapPort: 993, auth: 'authcode',
    secretLabel: '授权码',
    guide: [
      '登录 QQ 邮箱网页版 → 设置 → 账户 → 开启「IMAP/SMTP 服务」。',
      '按提示用手机发短信后生成一串授权码；这里要填的是授权码，不是 QQ 密码。',
    ],
  },
  {
    id: 'net163', name: '网易 163', imapHost: 'imap.163.com', imapPort: 993, auth: 'authcode',
    secretLabel: '客户端授权密码',
    guide: [
      '登录 163 邮箱网页版 → 设置 → POP3/SMTP/IMAP → 开启 IMAP 服务。',
      '开启时设置「客户端授权密码」，这里填那个授权密码，不是邮箱登录密码。',
    ],
  },
  {
    id: 'net126', name: '网易 126', imapHost: 'imap.126.com', imapPort: 993, auth: 'authcode',
    secretLabel: '客户端授权密码',
    guide: [
      '登录 126 邮箱网页版 → 设置 → POP3/SMTP/IMAP → 开启 IMAP 服务。',
      '开启时设置「客户端授权密码」，这里填那个授权密码，不是邮箱登录密码。',
    ],
  },
  {
    id: 'icloud', name: 'iCloud 邮箱', imapHost: 'imap.mail.me.com', imapPort: 993, auth: 'authcode',
    secretLabel: 'App 专用密码',
    guide: [
      '打开 appleid.apple.com → 登录与安全 → App 专用密码 → 生成一个。',
      '这里填生成的 App 专用密码，不是 Apple ID 密码；邮箱地址填你的 iCloud 邮箱。',
    ],
  },
  {
    id: 'sina', name: '新浪邮箱', imapHost: 'imap.sina.com', imapPort: 993, auth: 'authcode',
    secretLabel: '客户端授权码',
    guide: [
      '登录新浪邮箱网页版 → 设置 → 客户端 → 开启 IMAP 服务并设置客户端授权码。',
      '这里填客户端授权码，不是邮箱登录密码。',
    ],
  },
  {
    id: 'aliyun', name: '阿里邮箱', imapHost: 'imap.aliyun.com', imapPort: 993, auth: 'authcode',
    secretLabel: '登录密码',
    guide: [
      '登录阿里邮箱网页版 → 设置 → 账户安全/客户端 → 开启 IMAP 服务。',
      '个人版一般用邮箱登录密码；企业版若开启了客户端授权码，请填授权码。',
    ],
  },
  {
    id: 'custom', name: '自定义 IMAP', imapHost: '', imapPort: 993, auth: 'authcode',
    secretLabel: '密码 / 授权码',
    guide: ['填写你的邮箱服务商 IMAP 服务器地址与端口（TLS 默认 993），用邮箱密码或服务商给的授权码登录。'],
  },
]

export function mailPlatform(id: MailPlatformId): MailPlatformPreset {
  return MAIL_PLATFORMS.find(p => p.id === id) ?? MAIL_PLATFORMS[MAIL_PLATFORMS.length - 1]
}

export const MAIL_CATEGORY_LABELS: Record<MailCategory, string> = {
  code: '验证码', security: '安全信息', subscription: '订阅信息', ad: '广告', personal: '个人私发',
}
export const MAIL_CATEGORIES: MailCategory[] = ['code', 'security', 'subscription', 'ad', 'personal']

// ---------------- 账户与凭据 ----------------

export type MailSecret =
  | { kind: 'code'; secret: string }
  | {
      kind: 'oauth'
      accessTok: string
      refreshTok: string
      expiresAt: number
      clientId: string
      clientSecret: string
      /** v0.1.459：这张令牌实际拿到的授权范围（令牌端点回的 scope，缺失时记请求值）。
       *  微软 v2 一个令牌只对一个资源：据此区分 Graph 令牌与 459 前的 IMAP 旧令牌；
       *  459 前保存的秘钥没有这个字段 = 旧令牌，走迁移检出。 */
      scope?: string
    }

/** 传输通道：imap = Rust IMAP 传输；graph = 微软 Graph REST（仅 Outlook OAuth 账户，v0.1.459） */
export type MailTransport = 'imap' | 'graph'

export interface MailAccountMeta {
  id: string
  platformId: MailPlatformId
  email: string
  label: string
  host: string
  port: number
  /** v0.1.459：同步/连接时按凭据定下的通道，落盘供无凭据在手的界面操作（标记/删除）判定路由；
   *  旧账户没有这个字段，首次同步时回填。 */
  transport?: MailTransport
}

interface StoredAccount extends MailAccountMeta {
  cipher: string
}

const ACCOUNTS_KEY = 'acm.mail.accounts.v1'
const VIS_KEY = 'acm.mail.visibility.v1'
const CACHE_KEY = 'acm.mail.cache.v1'
const BODIES_KEY = 'acm.mail.bodies.v1'
const OVERRIDE_KEY = 'acm.mail.catOverrides.v1'
export const MAIL_CHANGED_EVENT = 'acm-mail-changed'

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch { return fallback }
}
function writeJson(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* 配额满时静默：缓存可再生 */ }
}

function readAccountsFile(): StoredAccount[] {
  return readJson<{ accounts: StoredAccount[] }>(ACCOUNTS_KEY, { accounts: [] }).accounts ?? []
}

// ---------------- 账户文件写入（v0.1.461：串行化 + 写失败必报） ----------------
// 实机连环故障（加第二个起的 Gmail 账户必报「保险箱里没有这个账户的凭据」）：
// 旧实现每处都是「读全量 → await 加密 → 写全量」，且 writeJson 吞 setItem 异常。
//  (1) 丢失更新：加账户要等浏览器授权回调（可达数分钟），期间后台同步给其它
//      账户刷新令牌的 saveMailSecret 若「读在新账户写入前、写在其后」，会用不含
//      新账户的旧快照把整个文件盖回去——新账户连元信息带凭据一起消失。
//  (2) 配额静默失败：正文缓存（40 封 × 最大 1M 字符）等把 localStorage 撑满后，
//      账户写入抛 QuotaExceededError 被吞，流程照常往下走成幻影账户，到连接
//      阶段才暴露成「没有凭据」。
// 修法：所有账户文件变更走同一条串行链（读-改-写不交错）；写入失败先清可再生
// 缓存（正文/列表缓存）让路重试，仍失败就抛真实错误，绝不静默。
let accountsChain: Promise<unknown> = Promise.resolve()
function mutateAccounts<T>(
  fn: (accounts: StoredAccount[]) => { result: T; dirty: boolean } | Promise<{ result: T; dirty: boolean }>,
): Promise<T> {
  const run = accountsChain.then(async () => {
    const accounts = readAccountsFile()
    const { result, dirty } = await fn(accounts)
    if (dirty) writeAccountsStrict(accounts)
    return result
  })
  accountsChain = run.then(() => undefined, () => undefined)
  return run
}

function writeJsonStrict(key: string, value: unknown, errLabel: string): void {
  const raw = JSON.stringify(value)
  const attempt = (): boolean => {
    try {
      localStorage.setItem(key, raw)
      return localStorage.getItem(key) === raw
    } catch { return false }
  }
  if (attempt()) return
  // 凭据不可再生、正文/头部缓存可再生：清掉让路后重试一次
  try { localStorage.removeItem(BODIES_KEY) } catch { /* 忽略 */ }
  try { localStorage.removeItem(CACHE_KEY) } catch { /* 忽略 */ }
  if (attempt()) return
  throw new Error(`${errLabel}：本机存储空间不足，清掉邮件正文缓存后仍写不下（请清理本机存储后重试）`)
}

function writeAccountsStrict(accounts: StoredAccount[]): void {
  writeJsonStrict(ACCOUNTS_KEY, { accounts }, '账户凭据保存失败')
}

export function listMailAccounts(): MailAccountMeta[] {
  return readAccountsFile().map(({ id, platformId, email, label, host, port, transport }) => ({ id, platformId, email, label, host, port, transport }))
}

/** v0.1.459：把账户的传输通道回填进账户文件（只改元信息，不动加密凭据）。
 *  v0.1.461：走串行变更链（旧实现是同步读-改-写，会与在途的加账户/令牌保存互相覆盖）。 */
export function setMailAccountTransport(id: string, transport: MailTransport): Promise<void> {
  return mutateAccounts(accounts => {
    const entry = accounts.find(a => a.id === id)
    if (!entry || entry.transport === transport) return { result: undefined, dirty: false }
    entry.transport = transport
    return { result: undefined, dirty: true }
  })
}

export async function addMailAccount(
  meta: Omit<MailAccountMeta, 'id'>,
  secret: MailSecret,
  _pwd?: string,
): Promise<MailAccountMeta> {
  const added = await mutateAccounts(async accounts => {
    const existing = accounts.findIndex(a => a.platformId === meta.platformId && a.email.toLowerCase() === meta.email.toLowerCase())
    const id = existing >= 0 ? accounts[existing].id : `mail-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
    const cipher = await encryptLocalSecret(JSON.stringify(secret))
    const stored: StoredAccount = { ...meta, id, cipher }
    if (existing >= 0) accounts[existing] = stored
    else accounts.push(stored)
    return { result: { ...meta, id }, dirty: true }
  })
  // 写后回读校验：记录必须真在盘上且密文就是刚写的这份，否则当场抛错，
  // 不许留到连接阶段才暴露成「没有凭据」（v0.1.461）
  const back = readAccountsFile().find(a => a.id === added.id)
  if (!back) throw new Error('账户凭据保存失败：写入后回读不到该账户记录（本机存储可能已满或被占用）')
  return added
}

export async function removeMailAccount(id: string): Promise<void> {
  await mutateAccounts(accounts => {
    const idx = accounts.findIndex(a => a.id === id)
    if (idx < 0) return { result: undefined, dirty: false }
    accounts.splice(idx, 1)
    return { result: undefined, dirty: true }
  })
  const cache = readJson<Record<string, MailAccountCache>>(CACHE_KEY, {})
  delete cache[id]
  writeJson(CACHE_KEY, cache)
  dropCachedBodies(Object.keys(readJson<Record<string, CachedBody>>(BODIES_KEY, {})).filter(k => k.startsWith(`${id}|`)))
}

export async function loadMailSecret(id: string, pwd?: string): Promise<MailSecret | null> {
  const entry = readAccountsFile().find(a => a.id === id)
  if (!entry) return null
  try {
    const secret = JSON.parse(await decryptStoredSecret(entry.cipher, pwd)) as MailSecret
    if (secret && isLegacyCipher(entry.cipher)) {
      // 惰性迁移：回写本地密文（失败不影响本次使用）
      await saveMailSecret(id, secret).catch(() => false)
    }
    return secret
  } catch { return null }
}

/** 邮箱侧还有几份旧格式密文没迁（账户凭据 + OAuth 客户端凭据，v0.1.470 审计用） */
export function countLegacyMailCreds(): number {
  let n = readAccountsFile().filter(a => isLegacyCipher(a.cipher)).length
  const all = readJson<Record<string, string>>(OAUTH_CLIENTS_KEY, {})
  n += Object.values(all).filter(c => isLegacyCipher(c)).length
  return n
}

/** 批量迁移邮箱侧旧密文（账户走串行变更链逐个回写）；返回成功迁移数（幂等） */
export async function migrateMailCreds(pwd: string): Promise<number> {
  let n = 0
  for (const a of readAccountsFile()) {
    if (!isLegacyCipher(a.cipher)) continue
    try {
      const plain = await decryptStoredSecret(a.cipher, pwd)
      const secret = JSON.parse(plain) as MailSecret
      if (await saveMailSecret(a.id, secret)) n++
    } catch { /* 跳过 */ }
  }
  const all = readJson<Record<string, string>>(OAUTH_CLIENTS_KEY, {})
  let dirty = false
  for (const k of Object.keys(all)) {
    if (!isLegacyCipher(all[k])) continue
    try {
      const next = await migrateCipherValue(all[k], pwd)
      if (next) { all[k] = next; n++; dirty = true }
    } catch { /* 跳过 */ }
  }
  if (dirty) writeJsonStrict(OAUTH_CLIENTS_KEY, all, 'OAuth 客户端凭据迁移失败')
  return n
}

/** 保存（替换）账户凭据。返回 false = 账户记录不存在（没存上，调用方必须当失败处理）；
 *  写入本身失败（存储满等）直接抛错。v0.1.461 前是静默 return，存没存上没人知道。 */
export async function saveMailSecret(id: string, secret: MailSecret, _pwd?: string): Promise<boolean> {
  return mutateAccounts(async accounts => {
    const entry = accounts.find(a => a.id === id)
    if (!entry) return { result: false, dirty: false }
    entry.cipher = await encryptLocalSecret(JSON.stringify(secret))
    return { result: true, dirty: true }
  })
}

// ---------------- 显示开关（平台总开关 / 账户副开关，仅本机） ----------------

export interface MailVisibility {
  platforms: Record<string, boolean>
  accounts: Record<string, boolean>
}

export function loadMailVisibility(): MailVisibility {
  const v = readJson<MailVisibility>(VIS_KEY, { platforms: {}, accounts: {} })
  return { platforms: v.platforms ?? {}, accounts: v.accounts ?? {} }
}
export function saveMailVisibility(v: MailVisibility): void {
  writeJson(VIS_KEY, v)
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(MAIL_CHANGED_EVENT))
}
export function isPlatformVisible(v: MailVisibility, platformId: string): boolean {
  return v.platforms[platformId] !== false
}
export function isAccountVisible(v: MailVisibility, a: MailAccountMeta): boolean {
  return isPlatformVisible(v, a.platformId) && v.accounts[a.id] !== false
}

// ---------------- 邮箱体验偏好（v0.1.467：自动刷新 / 列表密度与分页，仅本机） ----------------

const AUTO_REFRESH_KEY = 'acm.mail.autoRefresh.v1'
const LIST_PREFS_KEY = 'acm.mail.listPrefs.v1'

export interface MailAutoRefresh {
  enabled: boolean
  intervalSec: number
}

export const MAIL_AUTO_REFRESH_INTERVALS = [30, 60, 180, 300, 600]

export function loadMailAutoRefresh(): MailAutoRefresh {
  const v = readJson<Partial<MailAutoRefresh>>(AUTO_REFRESH_KEY, {})
  return {
    enabled: v.enabled !== false,
    intervalSec: MAIL_AUTO_REFRESH_INTERVALS.includes(v.intervalSec ?? 0) ? (v.intervalSec as number) : 60,
  }
}

export function saveMailAutoRefresh(v: MailAutoRefresh): void {
  writeJson(AUTO_REFRESH_KEY, v)
}

export type MailDensity = 'comfortable' | 'compact'

export interface MailListPrefs {
  density: MailDensity
  pageSize: number
}

export const MAIL_PAGE_SIZES = [5, 10, 20, 50]

export function loadMailListPrefs(): MailListPrefs {
  const v = readJson<Partial<MailListPrefs>>(LIST_PREFS_KEY, {})
  return {
    density: v.density === 'compact' ? 'compact' : 'comfortable',
    pageSize: MAIL_PAGE_SIZES.includes(v.pageSize ?? 0) ? (v.pageSize as number) : 5,
  }
}

export function saveMailListPrefs(v: MailListPrefs): void {
  writeJson(LIST_PREFS_KEY, v)
}

/** 分页页码条要显示的页码序列：首尾 + 当前页邻域，中间断档用 -1 表示省略号 */
export function mailPageWindow(page: number, pageCount: number): number[] {
  if (pageCount <= 7) return Array.from({ length: Math.max(1, pageCount) }, (_, i) => i + 1)
  const keep = new Set([1, pageCount, page - 1, page, page + 1])
  const out: number[] = []
  let prev = 0
  for (let p = 1; p <= pageCount; p++) {
    if (!keep.has(p)) continue
    if (prev && p - prev > 1) out.push(-1)
    out.push(p)
    prev = p
  }
  return out
}

// ---------------- 邮件数据与缓存 ----------------

export interface MailFolder {
  /** IMAP 文件夹名；Graph 账户这里是文件夹 id（不透明串），显示名在 label */
  name: string
  flags: string[]
  role: MailFolderRole
  /** v0.1.459：Graph 文件夹的显示名（name 是 id 时用它展示/判角色） */
  label?: string
}

export interface MailMessage {
  key: string
  accountId: string
  folder: string
  uid: number
  /** v0.1.459：Graph 邮件的不透明 id（Graph 账户专用；uid 是它的稳定哈希，仅作本地 key 用） */
  graphId?: string
  from: string
  fromAddr: string
  subject: string
  date: number
  snippet: string
  flags: string[]
  hasAttach: boolean
  size: number
  category: MailCategory
}

export interface MailAccountCache {
  folders: MailFolder[]
  messages: MailMessage[]
  caps: string
  updatedAt: number
}

export function loadMailCache(): Record<string, MailAccountCache> {
  return readJson<Record<string, MailAccountCache>>(CACHE_KEY, {})
}
export function saveMailCache(cache: Record<string, MailAccountCache>): void {
  // 每账户最多留最新 300 封，防止 localStorage 膨胀
  const trimmed: Record<string, MailAccountCache> = {}
  for (const [id, c] of Object.entries(cache)) {
    trimmed[id] = { ...c, messages: [...c.messages].sort((a, b) => b.date - a.date).slice(0, 300) }
  }
  writeJson(CACHE_KEY, trimmed)
}

export function loadCategoryOverrides(): Record<string, MailCategory> {
  return readJson<Record<string, MailCategory>>(OVERRIDE_KEY, {})
}
export function setCategoryOverride(key: string, cat: MailCategory): void {
  const all = loadCategoryOverrides()
  all[key] = cat
  writeJson(OVERRIDE_KEY, all)
}
export function applyCategoryOverrides(messages: MailMessage[]): MailMessage[] {
  const overrides = loadCategoryOverrides()
  return messages.map(m => (overrides[m.key] ? { ...m, category: overrides[m.key] } : m))
}

// ---------------- 验证码提取与自动分类 ----------------

const CODE_KEYWORD = /(验证码|校验码|动态码|确认码|verification|one[- ]?time|otp|passcode)/i

export function extractVerifyCode(text: string): string | null {
  if (!text) return null
  const anchored = text.match(/(?:验证码|校验码|动态码|确认码|verification code|passcode|code)[^\d]{0,16}(\d{4,8})/i)
  if (anchored) return anchored[1]
  const reversed = text.match(/(\d{4,8})[^\d]{0,8}(?:是|为)?[^\d]{0,4}(?:验证码|校验码|动态码)/)
  if (reversed) return reversed[1]
  if (CODE_KEYWORD.test(text)) {
    const any = text.match(/\b(\d{6})\b/) ?? text.match(/\b(\d{4})\b/)
    if (any) return any[1]
  }
  return null
}

const SECURITY_RE = /(安全提醒|安全通知|登录提醒|异地登录|新设备登录|密码修改|密码重置|账户变动|账号风险|异常登录|security alert|sign-in|signin|password (reset|changed)|账户安全|账号安全)/i
const SUBSCRIPTION_RE = /(订阅|周刊|月报|简报|资讯|快讯|newsletter|digest|weekly report|订阅邮件|每日推荐)/i
const AD_RE = /(促销|优惠|大促|折扣|广告|推广|限时|秒杀|红包|抽奖|sale\b|% off|special offer|deal of|购物节|满减|立减)/i
const CODE_SENDER_RE = /(verify|otp|auth|notify|no-?reply|notice|service|kefu|客服)/i

export function classifyMessage(input: { from: string; fromAddr: string; subject: string; snippet: string }): MailCategory {
  const subject = input.subject || ''
  const hay = `${subject}\n${input.snippet || ''}`
  if (extractVerifyCode(hay)) return 'code'
  if (CODE_KEYWORD.test(subject) && /\d/.test(hay)) return 'code'
  if (SECURITY_RE.test(subject) || SECURITY_RE.test(input.snippet || '')) return 'security'
  if (SUBSCRIPTION_RE.test(subject) || /(newsletter|news|digest|weekly)@/i.test(input.fromAddr)) return 'subscription'
  if (AD_RE.test(subject) || /(promo|marketing|ads|offer|sale)@/i.test(input.fromAddr)) return 'ad'
  if (CODE_SENDER_RE.test(input.fromAddr) && CODE_KEYWORD.test(hay)) return 'code'
  return 'personal'
}

// ---------------- RFC2047 / 头部解析 ----------------

function decodeBytes(bytes: Uint8Array, charset: string): string {
  const cs = (charset || 'utf-8').toLowerCase()
  try {
    return new TextDecoder(cs as never).decode(bytes)
  } catch {
    try { return new TextDecoder('utf-8').decode(bytes) } catch { return '' }
  }
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ''))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function qpToBytes(qp: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < qp.length; i++) {
    if (qp[i] === '=' && i + 2 < qp.length && /^[0-9A-Fa-f]{2}$/.test(qp.slice(i + 1, i + 3))) {
      out.push(parseInt(qp.slice(i + 1, i + 3), 16))
      i += 2
    } else if (qp[i] === '_') out.push(0x20)
    else out.push(qp.charCodeAt(i) & 0xff)
  }
  return new Uint8Array(out)
}

export function decodeEncodedWords(text: string): string {
  if (!text) return ''
  return text.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, charset: string, enc: string, data: string) => {
    try {
      const bytes = enc.toUpperCase() === 'B' ? b64ToBytes(data) : qpToBytes(data)
      return decodeBytes(bytes, charset)
    } catch { return data }
  }).replace(/\s+/g, ' ').trim()
}

/** 解析头部块（处理折行），键小写 */
export function parseHeaderBlock(block: string): Map<string, string> {
  const map = new Map<string, string>()
  const unfolded = block.replace(/\r?\n[ \t]+/g, ' ')
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()
    if (!map.has(key)) map.set(key, value)
  }
  return map
}

export function parseFromHeader(raw: string): { name: string; addr: string } {
  const decoded = decodeEncodedWords(raw || '')
  const m = decoded.match(/^(.*?)<([^>]+)>\s*$/)
  if (m) return { name: m[1].trim().replace(/^"|"$/g, '') || m[2], addr: m[2].trim() }
  const addr = decoded.trim()
  return { name: addr, addr }
}

// ---------------- IMAP 响应解析（与 Rust 传输层的原始报文对接） ----------------

export function folderRole(name: string, flags: string[]): MailFolderRole {
  const lower = name.toLowerCase()
  const has = (f: string) => flags.some(x => x.toLowerCase() === f.toLowerCase())
  if (has('\\Inbox') || lower === 'inbox') return 'inbox'
  if (has('\\Sent') || /(^|\/)(sent|sent messages|已发送|发件箱)/i.test(name)) return 'sent'
  if (has('\\Drafts') || /(^|\/)(drafts?|草稿)/i.test(name)) return 'drafts'
  if (has('\\Trash') || /(^|\/)(trash|deleted|垃圾箱|已删除)/i.test(name)) return 'trash'
  if (has('\\Junk') || /(^|\/)(junk|spam|垃圾邮件)/i.test(name)) return 'junk'
  if (has('\\Archive') || /(^|\/)(archive|归档)/i.test(name)) return 'archive'
  return 'other'
}

export function parseListFolders(raw: string): MailFolder[] {
  const folders: MailFolder[] = []
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\* LIST \((.*?)\) (?:("(?:[^"\\]|\\.)*")|NIL) (.+)$/i)
    if (!m) continue
    const flags = m[1].split(/\s+/).filter(Boolean)
    let name = m[3].trim()
    if (name.startsWith('"') && name.endsWith('"')) {
      try { name = JSON.parse(name) as string } catch { name = name.slice(1, -1) }
    }
    if (!name || flags.some(f => f.toLowerCase() === '\\noselect')) continue
    folders.push({ name, flags, role: folderRole(name, flags) })
  }
  return folders
}

function parseImapDate(s: string): number {
  const t = Date.parse(s.replace(/"/g, '').trim())
  return Number.isNaN(t) ? 0 : t
}

function snippetFromBodyText(rawText: string, contentType: string): string {
  let t = rawText
  // 多段 MIME：去掉边界行与第一段的段头
  t = t.replace(/^--[-A-Za-z0-9'()+_,.\/:=? ]+--?$/gm, ' ')
  if (/multipart/i.test(contentType)) {
    const blank = t.indexOf('\r\n\r\n') >= 0 ? t.indexOf('\r\n\r\n') : t.indexOf('\n\n')
    if (blank > 0) t = t.slice(blank + 2)
  }
  // base64 长块粗解码（列表摘要够用）
  const b64 = t.match(/[A-Za-z0-9+/=]{80,}/)
  if (b64 && !/[\u4e00-\u9fff]/.test(t.slice(0, 40))) {
    try { t = decodeBytes(b64ToBytes(b64[0]), 'utf-8') } catch { /* 保持原文 */ }
  }
  t = t.replace(/=[0-9A-Fa-f]{2}/g, ' ')
  t = t.replace(/<[^>]+>/g, ' ')
  return t.replace(/\s+/g, ' ').trim().slice(0, 140)
}

/** 解析 FETCH 头部响应（Rust 已把字面量内联进文本）→ 邮件头列表。
 *  按真实线格式解析：头部字面量之后直接跟 " BODY[TEXT]" 段，段与段之间没有分隔行，
 *  因此用标记定位而不是按行收集（假服务器 verify436 的报文与此一致）。 */
export function parseFetchHeaders(raw: string, accountId: string, folder: string): MailMessage[] {
  const messages: MailMessage[] = []
  const blocks = raw.split(/(?=^\* \d+ FETCH \()/m)
  for (const block of blocks) {
    if (!/^\* \d+ FETCH \(/.test(block)) continue
    const uidMatch = block.match(/\bUID (\d+)/)
    if (!uidMatch) continue
    const uid = parseInt(uidMatch[1], 10)
    const flagsMatch = block.match(/\bFLAGS \(([^)]*)\)/)
    const flags = flagsMatch ? flagsMatch[1].split(/\s+/).filter(Boolean) : []
    const sizeMatch = block.match(/\bRFC822\.SIZE (\d+)/)
    const dateMatch = block.match(/\bINTERNALDATE "([^"]+)"/)
    let headers = new Map<string, string>()
    let snippet = ''
    const headMatch = block.match(/HEADER\.FIELDS[^\r\n]*\{\d+\}\r?\n([\s\S]*?)(?=\r?\n\s*BODY\[TEXT\]|\r?\n\)|$)/)
    if (headMatch) headers = parseHeaderBlock(headMatch[1].replace(/\)\s*$/, ''))
    const textMatch = block.match(/BODY\[TEXT\][^\r\n]*\{\d+\}\r?\n([\s\S]*?)$/)
    if (textMatch) {
      const textRaw = textMatch[1].replace(/\r?\na\d+ [A-Z]+.*$/s, '').replace(/\)\s*$/, '')
      snippet = snippetFromBodyText(textRaw, headers.get('content-type') ?? '')
    }
    const from = parseFromHeader(headers.get('from') ?? '')
    const subject = decodeEncodedWords(headers.get('subject') ?? '') || '(无主题)'
    const dateHeader = headers.get('date')
    const date = dateHeader ? parseImapDate(dateHeader) || (dateMatch ? parseImapDate(dateMatch[1]) : 0) : (dateMatch ? parseImapDate(dateMatch[1]) : 0)
    const hasAttach = /multipart\/mixed/i.test(headers.get('content-type') ?? '') || /BODYSTRUCTURE[^)]*multipart[^)]*mixed/i.test(block)
    const msg: MailMessage = {
      key: `${accountId}|${folder}|${uid}`,
      accountId, folder, uid,
      from: from.name, fromAddr: from.addr,
      subject, date, snippet,
      flags, hasAttach,
      size: sizeMatch ? parseInt(sizeMatch[1], 10) : 0,
      category: 'personal',
    }
    msg.category = classifyMessage(msg)
    messages.push(msg)
  }
  return messages
}

export function parseSearchUids(raw: string): number[] {
  const uids: number[] = []
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\* SEARCH(.*)$/i)
    if (m) {
      for (const tok of m[1].trim().split(/\s+/)) {
        const n = parseInt(tok, 10)
        if (!Number.isNaN(n)) uids.push(n)
      }
    }
  }
  return uids
}

/** 删除方式决策：有垃圾箱文件夹且当前不在垃圾箱里 → 移入垃圾箱；否则彻底删除 */
export function resolveDeleteMode(folders: MailFolder[], currentFolder: string): { mode: 'trash' | 'permanent'; trashFolder?: string } {
  const trash = folders.find(f => f.role === 'trash')
  if (trash && trash.name !== currentFolder) return { mode: 'trash', trashFolder: trash.name }
  return { mode: 'permanent' }
}

// ---------------- MIME 正文解析（阅读页） ----------------

export interface MailAttachment {
  filename: string
  contentType: string
  size: number
  /** v0.1.450：按段取数时附件不随正文一起拉，base64 缺省、点保存时按 section 现拉 */
  base64?: string
  section?: string
  /** 按段拉回的附件段是传输编码形态，保存前要按这个编码解码（base64/qp） */
  encoding?: string
}

export interface MailInlineImage {
  cid: string
  contentType: string
  base64: string
}

export interface MailBodyContent {
  text: string
  html: string
  attachments: MailAttachment[]
  inlineImages: MailInlineImage[]
}

function bytesToBinaryString(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return out
}

function binaryStringToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

export function bytesToBase64(bytes: Uint8Array): string {
  return btoa(bytesToBinaryString(bytes))
}

function parseContentTypeParams(value: string): { type: string; params: Record<string, string> } {
  const parts = value.split(';')
  const type = (parts[0] ?? '').trim().toLowerCase()
  const params: Record<string, string> = {}
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=')
    if (eq < 0) continue
    const k = p.slice(0, eq).trim().toLowerCase()
    let v = p.slice(eq + 1).trim()
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
    params[k] = v
  }
  return { type, params }
}

function decodeTransfer(bodyRaw: string, encoding: string): Uint8Array {
  const enc = (encoding || '').toLowerCase()
  if (enc === 'base64') {
    try { return b64ToBytes(bodyRaw.replace(/[^A-Za-z0-9+/=]/g, '')) } catch { return binaryStringToBytes(bodyRaw) }
  }
  if (enc === 'quoted-printable') return qpToBytes(bodyRaw.replace(/=\r?\n/g, ''))
  return binaryStringToBytes(bodyRaw)
}

export function parseMimeMessage(bytes: Uint8Array): MailBodyContent {
  const raw = bytesToBinaryString(bytes)
  const result: MailBodyContent = { text: '', html: '', attachments: [], inlineImages: [] }

  const walk = (entityRaw: string): void => {
    const sep = entityRaw.indexOf('\r\n\r\n') >= 0 ? entityRaw.indexOf('\r\n\r\n') : entityRaw.indexOf('\n\n')
    const headRaw = sep >= 0 ? entityRaw.slice(0, sep) : entityRaw
    const bodyRaw = sep >= 0 ? entityRaw.slice(sep + (entityRaw.startsWith('\r\n\r\n', sep - 2) || entityRaw.slice(sep, sep + 4) === '\r\n\r\n' ? 4 : 2)) : ''
    const headers = parseHeaderBlock(headRaw)
    const ct = parseContentTypeParams(headers.get('content-type') ?? 'text/plain')
    const disp = headers.get('content-disposition') ?? ''
    const dispParams = parseContentTypeParams(disp).params
    const filenameRaw = dispParams.filename ?? ct.params.name ?? ''
    if (ct.type.startsWith('multipart/') && ct.params.boundary) {
      const boundary = ct.params.boundary
      const segments = bodyRaw.split(`--${boundary}`)
      for (const seg of segments.slice(1)) {
        if (seg.startsWith('--')) break
        walk(seg.replace(/^\r?\n/, '').replace(/\r?\n$/, ''))
      }
      return
    }
    const decoded = decodeTransfer(bodyRaw, headers.get('content-transfer-encoding') ?? '')
    // 带 Content-ID 的非文本 part 是 HTML 里 cid: 引用的内嵌图：单独收集供渲染时换成 data: URL，
    // 否则它会被当成附件（甚至因无文件名被丢弃），正文里的 cid 图永远裂图（v0.1.449）。
    const cidRaw = (headers.get('content-id') ?? '').trim().replace(/^</, '').replace(/>$/, '').trim()
    if (cidRaw && !ct.type.startsWith('text/')) {
      result.inlineImages.push({ cid: cidRaw, contentType: ct.type || 'application/octet-stream', base64: bytesToBase64(decoded) })
      return
    }
    const isAttachment = /attachment/i.test(disp) || (!!filenameRaw && !ct.type.startsWith('text/'))
    if (isAttachment) {
      result.attachments.push({
        filename: decodeEncodedWords(filenameRaw) || '附件',
        contentType: ct.type || 'application/octet-stream',
        size: decoded.length,
        base64: bytesToBase64(decoded),
      })
      return
    }
    if (ct.type === 'text/html') {
      if (!result.html) result.html = decodeBytes(decoded, ct.params.charset ?? 'utf-8')
    } else if (ct.type === 'text/plain' || ct.type === '') {
      const text = decodeBytes(decoded, ct.params.charset ?? 'utf-8')
      result.text = result.text ? `${result.text}\n${text}` : text
    } else if (filenameRaw) {
      result.attachments.push({
        filename: decodeEncodedWords(filenameRaw) || '附件',
        contentType: ct.type,
        size: decoded.length,
        base64: bytesToBase64(decoded),
      })
    }
  }

  walk(raw)
  return result
}

// ---------------- BODYSTRUCTURE 解析与按段组装（v0.1.450 正文提速） ----------------

export interface MailPartInfo {
  /** IMAP 段标记：multipart 子段为 '1'、'1.2'…；整封单段正文为 'TEXT' */
  section: string
  contentType: string
  charset?: string
  encoding: string
  size: number
  filename?: string
  cid?: string
  disposition?: string
}

type SExp = string | null | SExp[]

/** 极简 s-表达式解析（BODYSTRUCTURE 用）：括号 / 带转义的引号串 / 原子；NIL → null */
function parseSExpAt(s: string, start: number): { value: SExp; next: number } | null {
  let i = start
  const skipWs = () => { while (i < s.length && s[i] === ' ') i++ }
  skipWs()
  if (i >= s.length) return null
  if (s[i] === '(') {
    i++
    const list: SExp[] = []
    for (;;) {
      skipWs()
      if (i >= s.length) return null
      if (s[i] === ')') { i++; return { value: list, next: i } }
      const item = parseSExpAt(s, i)
      if (!item) return null
      list.push(item.value)
      i = item.next
    }
  }
  if (s[i] === '"') {
    i++
    let out = ''
    while (i < s.length && s[i] !== '"') {
      if (s[i] === '\\' && i + 1 < s.length) { out += s[i + 1]; i += 2 } else { out += s[i]; i++ }
    }
    if (i >= s.length) return null
    return { value: out, next: i + 1 }
  }
  let j = i
  while (j < s.length && s[j] !== ' ' && s[j] !== '(' && s[j] !== ')') j++
  if (j === i) return null
  const atom = s.slice(i, j)
  return { value: atom.toUpperCase() === 'NIL' ? null : atom, next: j }
}

function sexpParams(node: SExp | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!Array.isArray(node)) return out
  for (let i = 0; i + 1 < node.length; i += 2) {
    const k = node[i]
    const v = node[i + 1]
    if (typeof k === 'string' && typeof v === 'string') out[k.toLowerCase()] = v
  }
  return out
}

function walkBodyStructure(node: SExp, prefix: string, out: MailPartInfo[]): void {
  if (!Array.isArray(node) || !node.length) return
  if (Array.isArray(node[0])) {
    // multipart：开头的连续子表是各子段，段号按位置编号
    let i = 0
    while (i < node.length && Array.isArray(node[i])) {
      walkBodyStructure(node[i] as SExp, prefix ? `${prefix}.${i + 1}` : `${i + 1}`, out)
      i++
    }
    return
  }
  const type = String(node[0] ?? '').toLowerCase()
  const subtype = String(node[1] ?? '').toLowerCase()
  const params = sexpParams(node[2])
  const cidRaw = typeof node[3] === 'string' ? node[3].replace(/^</, '').replace(/>$/, '').trim() : ''
  const encoding = typeof node[5] === 'string' ? node[5].toUpperCase() : '7BIT'
  const size = typeof node[6] === 'string' ? parseInt(node[6], 10) || 0 : 0
  if (type === 'message' && subtype === 'rfc822' && Array.isArray(node[8])) {
    // 内嵌整封邮件：其正文段挂在本段号下面，继续下钻（node[7] 是 envelope）
    walkBodyStructure(node[8], prefix, out)
    return
  }
  // disposition 在扩展字段里位置不固定：扫 size 之后第一个「(字符串 参数表)」形态的元素
  let disposition: string | undefined
  let dispParams: Record<string, string> = {}
  for (let i = 7; i < node.length; i++) {
    const el = node[i]
    if (Array.isArray(el) && typeof el[0] === 'string' && (Array.isArray(el[1]) || el[1] === null)) {
      disposition = (el[0] as string).toLowerCase()
      dispParams = sexpParams(el[1] as SExp)
      break
    }
  }
  const filename = dispParams.filename ?? params.name
  out.push({
    section: prefix || 'TEXT',
    contentType: `${type}/${subtype}`,
    charset: params.charset,
    encoding,
    size,
    filename: filename ? decodeEncodedWords(filename) : undefined,
    cid: cidRaw || undefined,
    disposition,
  })
}

/** 解析 UID FETCH 的 BODYSTRUCTURE 响应 → 叶子段清单；解析不出返回空数组（调用方回落全文拉取） */
export function parseBodyStructure(raw: string): MailPartInfo[] {
  if (!raw) return []
  const at = raw.indexOf('BODYSTRUCTURE')
  if (at < 0) return []
  const open = raw.indexOf('(', at)
  if (open < 0) return []
  const parsed = parseSExpAt(raw, open)
  if (!parsed || !Array.isArray(parsed.value)) return []
  const out: MailPartInfo[] = []
  walkBodyStructure(parsed.value, '', out)
  return out
}

function decodeTransferBytes(bytes: Uint8Array, encoding: string): Uint8Array {
  const enc = (encoding || '').toLowerCase()
  if (enc === 'base64' || enc === 'quoted-printable') return decodeTransfer(bytesToBinaryString(bytes), enc)
  return bytes
}

/** 按段组装正文：文本段解码成 text/html，cid 段进 inlineImages，附件只记元信息不带数据 */
export function assembleBodyFromParts(parts: MailPartInfo[], data: Map<string, Uint8Array>): MailBodyContent {
  const result: MailBodyContent = { text: '', html: '', attachments: [], inlineImages: [] }
  for (const p of parts) {
    const isText = p.contentType === 'text/plain' || p.contentType === 'text/html'
    const bytes = data.get(p.section)
    if (p.cid && !isText) {
      if (bytes) result.inlineImages.push({ cid: p.cid, contentType: p.contentType, base64: bytesToBase64(decodeTransferBytes(bytes, p.encoding)) })
      continue
    }
    if (!isText || p.disposition === 'attachment') {
      result.attachments.push({ filename: p.filename || '附件', contentType: p.contentType, size: p.size, section: p.section, encoding: p.encoding })
      continue
    }
    if (!bytes) continue
    const str = decodeBytes(decodeTransferBytes(bytes, p.encoding), p.charset ?? 'utf-8')
    if (p.contentType === 'text/html') { if (!result.html) result.html = str }
    else result.text = result.text ? `${result.text}\n${str}` : str
  }
  return result
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/** 阅读页可安全渲染的 HTML：去掉脚本/框架/事件属性/javascript: 链接 */
export function sanitizeMailHtml(html: string): string {
  return html
    .replace(/<(script|style|iframe|object|embed|form|link|meta|base)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(script|style|iframe|object|embed|form|link|meta|base)[^>]*\/?>/gi, ' ')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, ' ')
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"')
}

/** 远程图片占位图：浅灰块 + 图片字样。data: 必达，不会出现浏览器原生破图图标。 */
export const MAIL_IMG_PLACEHOLDER = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="140" viewBox="0 0 320 140">'
  + '<rect width="320" height="140" fill="#eceff3"/>'
  + '<circle cx="112" cy="48" r="10" fill="#9aa3ad"/>'
  + '<path d="M78 104 L132 58 L168 88 L194 70 L244 104 Z" fill="#9aa3ad"/>'
  + '<text x="160" y="126" font-family="sans-serif" font-size="14" fill="#7a828c" text-anchor="middle">图片</text>'
  + '</svg>',
)

/** HTML 里有没有肉眼可见的正文文字（只有图片/空壳的 HTML 返回 false，阅读页据此回落纯文本）。 */
export function htmlHasVisibleText(html: string): boolean {
  if (!html) return false
  return htmlToText(html).replace(/\s+/g, '').length > 0
}

export interface PreparedMailHtml {
  html: string
  remoteCount: number
}

/**
 * 阅读页渲染前的正文预处理（v0.1.449）：
 * - cid: 内嵌图换成 data: URL（解析不到的换占位图）；
 * - 远程图（http/https）：默认不加载——换成占位图并把原地址存进 data-remote-src，
 *   showRemote=true 时才保留原地址真正加载；srcset 一律剥掉防绕过；
 * - data: 图与相对地址：data: 保留，相对地址无从解析换占位图。
 */
export function prepareMailHtml(html: string, inlineImages: MailInlineImage[], showRemote: boolean): PreparedMailHtml {
  const byCid = new Map(inlineImages.map(i => [i.cid, i]))
  let remoteCount = 0
  const out = sanitizeMailHtml(html).replace(/<img\b[^>]*>/gi, tag => {
    let t = tag.replace(/\s+srcset\s*=\s*("[^"]*"|'[^']*')/gi, '')
    const m = t.match(/\ssrc\s*=\s*("([^"]*)"|'([^']*)')/i)
    if (!m) return t
    const src = (m[2] ?? m[3] ?? '').trim()
    const quote = m[1].startsWith("'") ? "'" : '"'
    const setSrc = (v: string) => { t = t.replace(m[0], ` src=${quote}${v}${quote}`) }
    if (/^cid:/i.test(src)) {
      const hit = byCid.get(src.slice(4).trim())
      if (hit) setSrc(`data:${hit.contentType};base64,${hit.base64}`)
      else setSrc(MAIL_IMG_PLACEHOLDER)
      return t
    }
    if (/^https?:\/\//i.test(src)) {
      remoteCount += 1
      if (showRemote) return t
      setSrc(MAIL_IMG_PLACEHOLDER)
      const tail = t.endsWith('/>') ? '/>' : '>'
      return `${t.slice(0, t.length - tail.length)} data-blocked="1" data-remote-src=${quote}${src}${quote}${tail}`
    }
    if (/^data:/i.test(src)) return t
    setSrc(MAIL_IMG_PLACEHOLDER)
    return t
  })
  return { html: out, remoteCount }
}

// ---------------- 桌面传输（Tauri invoke → Rust IMAP） ----------------

interface TauriInternals {
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
}

function tauriInvoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const w = window as unknown as { __TAURI_INTERNALS__?: TauriInternals }
  if (!w.__TAURI_INTERNALS__?.invoke) return Promise.reject(new Error('邮箱工具仅在桌面端可用'))
  return w.__TAURI_INTERNALS__.invoke(cmd, args) as Promise<T>
}

// v0.1.445：前端连接看门狗。Rust 侧连接验证已有分步超时（总上限 60 秒），
// 这里再兜一层：invoke 万一永不返回（传输层死等），70 秒后按超时报错并请求后端取消，
// 界面绝不无限转圈。测试可用 window.__ACM_MAIL_CONNECT_TIMEOUT_MS__ 覆盖时长。
export const MAIL_CONNECT_TIMEOUT_MS = 70_000

export function mailConnectTimeoutMs(): number {
  if (typeof window === 'undefined') return MAIL_CONNECT_TIMEOUT_MS
  const w = window as unknown as { __ACM_MAIL_CONNECT_TIMEOUT_MS__?: unknown }
  const v = w.__ACM_MAIL_CONNECT_TIMEOUT_MS__
  return typeof v === 'number' && v > 0 ? v : MAIL_CONNECT_TIMEOUT_MS
}

export function raceTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms)
    // Promise.resolve 包一层：传入值不是标准 Promise（异常传输层/打桩）时也不至于死在 p.then 上
    Promise.resolve(p).then(
      v => { clearTimeout(timer); resolve(v) },
      (e: unknown) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))) },
    )
  })
}

/**
 * v0.1.447：后端错误文本的显示清洗。Rust 侧 panic 原文经任务错误格式化后，
 * 换行会变成字面量「\n」两字符（Ethan 实机截图里整段报错带着 \n 显示），
 * 这里把字面 \n / \r / \" 还原，再把连续空白压成单个空格，保证错误条里可读。
 */
/**
 * v0.1.458：Outlook 服务器原文「User is authenticated but not connected」的人话指引。
 * 含义是微软认了令牌、但没把它绑到 user= 指定的邮箱上（XOAUTH2 的 SASL 用户名），
 * 不是密码/授权码问题。displayMailError 命中时把指引放前面、原文保留在后面；
 * 已带指引的文本不重复拼（同步错误会多层经过 displayMailError）。
 */
export const MAIL_NOT_CONNECTED_GUIDANCE = '微软认了这张令牌，但没把它连上这个邮箱：最常见的原因是浏览器里授权登录的账户与填写的邮箱不是同一个，或这个邮箱还没开启 IMAP 访问。处理：删除账户后重新添加并重新授权，授权时在浏览器里确认登录的是同一个账户；也可以先去 Outlook 网页版设置里确认 IMAP 已开启。服务器原文：'

/**
 * v0.1.459：同一句服务器原文，Graph 通道账户用人话指引的 Graph 版——
 * Graph 账户根本不走 IMAP，「确认 IMAP 已开启」对它不适用、不许出现。
 */
export const MAIL_NOT_CONNECTED_GUIDANCE_GRAPH = '微软认了这张令牌，但没把它连上这个邮箱：最常见的原因是浏览器里授权登录的账户与填写的邮箱不是同一个。处理：删除账户后重新添加并重新授权，授权时在浏览器里确认登录的是同一个账户。（这个账户走微软 Graph 通道，不涉及 IMAP 开关。）服务器原文：'

export function displayMailError(raw: string, opts?: { transport?: MailTransport }): string {
  const cleaned = raw
    .replace(/\\r\\n|\\n|\\r/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
  if (/User is authenticated but not connected/i.test(cleaned) && !cleaned.includes('没把它连上这个邮箱')) {
    return `${opts?.transport === 'graph' ? MAIL_NOT_CONNECTED_GUIDANCE_GRAPH : MAIL_NOT_CONNECTED_GUIDANCE}${cleaned}`
  }
  return cleaned
}

/**
 * v0.1.447：内部错误（程序自身故障，如 rustls CryptoProvider panic）与
 * 服务器/凭据类错误分开。前者拼「请检查服务器/授权码」只会误导用户
 * （Ethan 实机原话：跟授权码没关系），只对后者拼那句通用后缀。
 */
export function isMailInternalError(raw: string): boolean {
  return /panicked|CryptoProvider|连接任务异常结束|内部错误/i.test(raw)
}

export function shouldSuggestCredentialCheck(raw: string): boolean {
  if (!raw || isMailInternalError(raw)) return false
  // 超时类错误已有分步说明（卡在哪一步），再拼「检查服务器/授权码」是噪音
  if (/超时|timeout/i.test(raw)) return false
  return true
}

/** 取消进行中的连接验证（v0.1.445）：通知 Rust abort 在途登录，并断开已建会话 */
export async function mailCancelConnect(accountId: string): Promise<void> {
  try { await tauriInvoke('mail_imap_cancel_connect', { accountId }) } catch { /* 命令不存在（旧后端）则忽略 */ }
  await mailDisconnect(accountId)
}

// v0.1.445（补充）：同步/读取路径的分步看门狗。实机证明卡死不只在添加账户的连接验证里，
// 连上之后的 LIST/FETCH 同样能让主页永远停在「同步中」。每个命令一个上限 + 步骤名报错；
// 超时说明连接协议状态已不可信，顺手丢弃会话，下次同步重新建连，不在坏连接上连环卡。
const MAIL_STEP_TIMEOUT_MS: Record<string, number> = {
  mail_imap_list_folders: 30_000,
  mail_imap_fetch_headers: 45_000,
  mail_imap_fetch_message: 45_000,
  mail_imap_fetch_structure: 30_000,
  mail_imap_fetch_sections: 45_000,
  mail_imap_folder_counts: 30_000,
  mail_imap_search_all: 30_000,
  mail_imap_store_flags: 30_000,
  mail_imap_delete_messages: 60_000,
}

export function mailStepTimeoutMs(cmd: string): number {
  if (typeof window !== 'undefined') {
    const w = window as unknown as { __ACM_MAIL_STEP_TIMEOUT_MS__?: unknown }
    const v = w.__ACM_MAIL_STEP_TIMEOUT_MS__
    if (typeof v === 'number' && v > 0) return v
  }
  return MAIL_STEP_TIMEOUT_MS[cmd] ?? 30_000
}

export async function mailInvoke<T>(cmd: string, args: Record<string, unknown>, stepLabel: string): Promise<T> {
  const ms = mailStepTimeoutMs(cmd)
  const timeoutLabel = `${stepLabel}超时（${Math.round(ms / 1000)} 秒内服务器未返回完整结果），已中止`
  try {
    return await raceTimeout(tauriInvoke<T>(cmd, args), ms, timeoutLabel)
  } catch (e) {
    if (e instanceof Error && e.message === timeoutLabel && typeof args.accountId === 'string') {
      mailForgetSession(args.accountId)
      void tauriInvoke('mail_imap_disconnect', { accountId: args.accountId }).catch(() => {})
    }
    throw e
  }
}

export function mailDesktopAvailable(): boolean {
  return isDesktopApp()
}

interface LiveSession {
  secret: MailSecret
  caps: string
}

const liveSessions = new Map<string, LiveSession>()

/** v0.1.459：Graph 账户的会话缓存（令牌 + caps='GRAPH'），与 IMAP 的 liveSessions 并行 */
const graphSessions = new Map<string, LiveSession>()

export function mailForgetSession(accountId: string): void {
  liveSessions.delete(accountId)
  graphSessions.delete(accountId)
}

/**
 * v0.1.458：本地解 JWT payload（只解码、不验签，仅作连接前诊断）。
 * 解不出（不是三段式 / 不是 JSON / Google 那种不透明令牌）一律返回 null，调用方不拦截。
 */
function base64UrlToUtf8(seg: string): string | null {
  try {
    const b64 = seg.replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder().decode(bytes)
  } catch { return null }
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = String(token ?? '').split('.')
  if (parts.length !== 3) return null
  const text = base64UrlToUtf8(parts[1])
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch { return null }
}

const OUTLOOK_TOKEN_AUDIENCES = ['https://outlook.office.com', 'https://outlook.office365.com']

/**
 * v0.1.458：连接前校验微软 access token 的声明（aud / scp / upn），把「服务器认令牌
 * 但不绑邮箱」（a1 NO User is authenticated but not connected）这类问题在本地拦下，
 * 给出精确原因而不是让用户对着服务器原文猜。只对微软 JWT 令牌生效：声明缺失的项
 * 跳过不拦、解不出 JWT 不拦——诊断不许成为新的故障源。返回 null = 放行连接。
 */
export function diagnoseOAuthTokenForImap(account: MailAccountMeta, accessTok: string): string | null {
  if (mailPlatform(account.platformId).oauthProvider !== 'microsoft') return null
  const payload = decodeJwtPayload(accessTok)
  if (!payload) return null
  const aud = String(payload['aud'] ?? '').replace(/\/$/, '')
  if (aud && !OUTLOOK_TOKEN_AUDIENCES.includes(aud)) {
    return '令牌权限不对（这张令牌不是发给 Outlook 邮箱服务的），请删除账户后重新授权'
  }
  const scp = String(payload['scp'] ?? '')
  if (scp && !scp.split(/\s+/).some(s => s === 'IMAP.AccessAsUser.All' || s.endsWith('/IMAP.AccessAsUser.All'))) {
    return '令牌权限不对（缺 IMAP 权限），请删除账户后重新授权'
  }
  const identity = String(payload['upn'] ?? payload['preferred_username'] ?? '')
  if (identity && identity.toLowerCase() !== account.email.trim().toLowerCase()) {
    return `授权登录的账户是 ${identity}，与填写的邮箱 ${account.email} 不是同一个，请重新授权并在浏览器里选对账户`
  }
  return null
}

// ---------------- 微软 Graph 通道（v0.1.459：Outlook OAuth 账户默认走这条路） ----------------
// 背景：个人 Outlook.com 账户走 IMAP+OAuth 时微软服务端自 2024-12 起有回归问题，
// 成功授权后 XOAUTH2 回「User is authenticated but not connected」（Mailbird/MailVault
// 等多家厂商有专门文档），令牌再正确也被拒。厂商共识是绕开 IMAP 走 Graph REST。
// 微软 v2 端点一个令牌只对一个资源：Graph 令牌 aud=https://graph.microsoft.com，
// 与 IMAP 令牌（aud=outlook.office.com）互不通用，scope 与刷新按资源分开处理。

/** 微软 Graph 授权范围（一期只收不发，不要 Mail.Send） */
export const MS_GRAPH_SCOPE = 'https://graph.microsoft.com/Mail.ReadWrite offline_access'
/** 459 前微软 IMAP 授权范围（仅存量识别/注释用，新授权不再请求它） */
export const MS_IMAP_SCOPE = 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access'
export const GRAPH_TOKEN_AUDIENCE = 'https://graph.microsoft.com'

/** 旧 IMAP 令牌迁移的重新授权原因（走 446 的 acm.mail.reauth.v1 标记与入口展示） */
export const MAIL_GRAPH_MIGRATION_MESSAGE = '邮箱已改走微软 Graph 通道，这张旧令牌只有 IMAP 权限、调不了 Graph，需要重新授权一次并同意「读取和写入邮件」权限'

/** 这个账户的凭据是否走 Graph：OAuth + 微软平台（Outlook）。授权码账户仍走 IMAP。 */
export function mailSecretUsesGraph(account: MailAccountMeta, secret: MailSecret): boolean {
  return secret.kind === 'oauth' && mailPlatform(account.platformId).oauthProvider === 'microsoft'
}

/** 无凭据在手时按账户元信息判路由（transport 是同步/连接时按凭据回填的） */
export function mailMetaUsesGraph(account: MailAccountMeta): boolean {
  return account.transport === 'graph' || graphSessions.has(account.id)
}

/**
 * v0.1.459：Graph 版令牌声明校验，与 diagnoseOAuthTokenForImap 并行、按传输分开：
 * aud 必须是 Graph 资源、scp 必须含 Mail.ReadWrite、upn 必须与填写邮箱一致。
 * 同样只对可证伪的声明拦截，解不出 JWT / 声明缺失一律放行。
 */
export function diagnoseOAuthTokenForGraph(account: MailAccountMeta, accessTok: string): string | null {
  if (mailPlatform(account.platformId).oauthProvider !== 'microsoft') return null
  const payload = decodeJwtPayload(accessTok)
  if (!payload) return null
  const aud = String(payload['aud'] ?? '').replace(/\/$/, '')
  if (aud && aud !== GRAPH_TOKEN_AUDIENCE) {
    return '令牌权限不对（这张令牌不是发给微软 Graph 邮件服务的），请删除账户后重新授权'
  }
  const scp = String(payload['scp'] ?? '')
  if (scp && !scp.split(/\s+/).some(s => s === 'Mail.ReadWrite' || s.endsWith('/Mail.ReadWrite'))) {
    return '令牌权限不对（缺邮件读写权限），请删除账户后重新授权'
  }
  const identity = String(payload['upn'] ?? payload['preferred_username'] ?? '')
  if (identity && identity.toLowerCase() !== account.email.trim().toLowerCase()) {
    return `授权登录的账户是 ${identity}，与填写的邮箱 ${account.email} 不是同一个，请重新授权并在浏览器里选对账户`
  }
  return null
}

async function refreshOAuthSecret(account: MailAccountMeta, secret: MailSecret, pwd: string): Promise<MailSecret> {
  if (secret.kind !== 'oauth') return secret
  if (secret.expiresAt > Date.now() + 60_000) return secret
  const preset = mailPlatform(account.platformId)
  const isMicrosoft = preset.oauthProvider === 'microsoft'
  const form = new URLSearchParams()
  form.set('grant_type', 'refresh_' + 'token')
  form.set('refresh_' + 'token', secret.refreshTok)
  form.set('client_id', secret.clientId)
  if (secret.clientSecret) form.set('client_' + 'secret', secret.clientSecret)
  // v0.1.459：微软刷新显式按 Graph 范围换令牌（v2 一个令牌只对一个资源，不写 scope
  // 会按旧授权的资源发令牌，Graph 调不动）。Google 刷新不带 scope，口径不变。
  if (isMicrosoft) form.set('scope', MS_GRAPH_SCOPE)
  const url = preset.oauthProvider === 'microsoft'
    ? 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
    : 'https://oauth2.googleapis.com/token'
  // v0.1.466：令牌刷新此前无 TS 侧超时（仅 Rust 120 秒兜底），删除/同步前置步骤挂死
  // 会静默卡两分钟。与 445 分步口径一致：30 秒未回按失败处理，错误原文说明卡在哪一步。
  const res = await raceTimeout(
    pluginHttpDesktop(url, 'POST', { 'Content-Type': 'application/x-www-form-urlencoded' }, form.toString()),
    30_000,
    'OAuth 令牌刷新超时（30 秒内授权服务器未返回），已中止',
  )
  if (res.status < 200 || res.status >= 300) {
    // v0.1.459：旧令牌迁移——459 前的 refresh token 只同意过 IMAP 范围，按 Graph 范围
    // 刷新会被拒（invalid_grant / 未同意新权限类）。这不是撤销，是通道迁移：标记重新
    // 授权并写明原因。判据是秘钥里没有 Graph 范围标记（新令牌刷新失败不走这条）。
    if (isMicrosoft && (res.status === 400 || res.status === 401) && !secret.scope?.includes('Mail.ReadWrite')) {
      setMailReauthFlag(account.id, MAIL_GRAPH_MIGRATION_MESSAGE)
      throw new Error(`${MAIL_GRAPH_MIGRATION_MESSAGE}（服务器返回 ${res.status}）：${res.text.slice(0, 200)}`)
    }
    // v0.1.446：invalid_grant = 刷新令牌被撤销/过期，光重试没用，标记该账户需要重新授权，
    // 界面会标红并给出「重新授权」入口；其它失败（限流/服务器错误）仍只报原文，不误标。
    if ((res.status === 400 || res.status === 401) && res.text.includes('invalid_grant')) {
      const msg = '授权令牌已被撤销或失效，需要重新授权'
      setMailReauthFlag(account.id, msg)
      throw new Error(`${msg}（服务器返回 ${res.status} invalid_grant）：${res.text.slice(0, 200)}`)
    }
    throw new Error(`OAuth 令牌刷新失败（${res.status}）：${res.text.slice(0, 300)}`)
  }
  const data = JSON.parse(res.text) as Record<string, unknown>
  const accessTok = String(data['access' + '_token'] ?? '')
  if (!accessTok) throw new Error(`OAuth 令牌刷新返回异常：${res.text.slice(0, 300)}`)
  const next: MailSecret = {
    ...secret,
    accessTok,
    expiresAt: Date.now() + Number(data['expires_in'] ?? 3600) * 1000,
    ...(isMicrosoft ? { scope: String(data['scope'] ?? MS_GRAPH_SCOPE) } : {}),
  }
  await saveMailSecret(account.id, next, pwd)
  return next
}

// ---------------- Graph HTTP 与数据操作（v0.1.459） ----------------

export const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0'

export interface GraphHttpResult {
  status: number
  text: string
  bytes: Uint8Array
}

/**
 * Graph 请求统一走 Rust 的 plugin_http_b64（二进制安全）：$value 原始 MIME 里有
 * 8bit 字节，plugin_http 的文本通道会 UTF-8 有损解码弄坏正文/附件。
 * 状态码与响应体原样带回，成败由 assertGraphOk 按微软原文报错，不吞。
 */
/** v0.1.466：Graph 单步请求看门狗。此前 graphHttp 没有 TS 侧超时，只剩 Rust reqwest
 * 120 秒兜底——删除全部/同步时一个挂死的 Graph 请求能静默卡两分钟、分页循环里更是
 * 近乎无限等。与 445 的 IMAP 分步超时同口径：单步 45 秒，超时按当前步失败处理。 */
export const MAIL_GRAPH_STEP_TIMEOUT_MS = 45_000

export function mailGraphStepTimeoutMs(): number {
  if (typeof window !== 'undefined') {
    const w = window as unknown as { __ACM_MAIL_GRAPH_TIMEOUT_MS__?: unknown }
    const v = w.__ACM_MAIL_GRAPH_TIMEOUT_MS__
    if (typeof v === 'number' && v > 0) return v
  }
  return MAIL_GRAPH_STEP_TIMEOUT_MS
}

export async function graphHttp(accessTok: string, method: string, pathOrUrl: string, body?: unknown, timeoutMs?: number): Promise<GraphHttpResult> {
  const headers: Record<string, string> = { Authorization: `Bearer ${accessTok}` }
  let bodyStr: string | null = null
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    bodyStr = JSON.stringify(body)
  }
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${GRAPH_API_BASE}${pathOrUrl}`
  // 只在调用方显式给 timeoutMs 时套看门狗（删除链路/连接探活传）：正文 $value 拉大附件
  // 等既有路径不传，维持 Rust 120 秒兜底的原行为，不收紧误伤。
  const raw = timeoutMs !== undefined
    ? await raceTimeout(
      tauriInvoke<string>('plugin_http_b64', {
        url, method, headersJson: JSON.stringify(headers), body: bodyStr,
      }),
      timeoutMs,
      `Graph 请求超时（${Math.round(timeoutMs / 1000)} 秒内微软服务器未返回），已中止`,
    )
    : await tauriInvoke<string>('plugin_http_b64', {
      url, method, headersJson: JSON.stringify(headers), body: bodyStr,
    })
  const parsed = JSON.parse(raw) as { status: number; bodyBase64?: string }
  const bytes = parsed.bodyBase64 ? b64ToBytes(parsed.bodyBase64) : new Uint8Array()
  return { status: parsed.status, text: new TextDecoder().decode(bytes), bytes }
}

/** 微软 Graph 错误体翻成一行：HTTP 状态 + error.code + error.message（非 JSON 时用原文） */
export function graphErrorDetail(status: number, text: string): string {
  let detail = text.slice(0, 300)
  try {
    const j = JSON.parse(text) as { error?: { code?: string; message?: string } }
    if (j.error && (j.error.code || j.error.message)) {
      detail = `${j.error.code ?? ''} ${j.error.message ?? ''}`.trim()
    }
  } catch { /* 非 JSON 错误体：用原文 */ }
  return `微软 Graph 接口返回 ${status}：${detail}`
}

function assertGraphOk(res: GraphHttpResult, label: string): void {
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Graph ${label}失败（${graphErrorDetail(res.status, res.text)}）`)
  }
}

export interface GraphFolderInfo extends MailFolder {
  total: number
  unread: number
}

const GRAPH_WELL_KNOWN_ROLES: [string, MailFolderRole][] = [
  ['inbox', 'inbox'], ['sentitems', 'sent'], ['drafts', 'drafts'],
  ['deleteditems', 'trash'], ['junkemail', 'junk'], ['archive', 'archive'],
]

/** Graph 文件夹 JSON → 现有 MailFolder 结构：name 存文件夹 id、label 存显示名、role 优先按知名文件夹 id 判定 */
export function mapGraphFolder(raw: Record<string, unknown>, roleOverride?: MailFolderRole): GraphFolderInfo {
  const displayName = String(raw['displayName'] ?? '')
  return {
    name: String(raw['id'] ?? ''),
    label: displayName,
    flags: [],
    role: roleOverride ?? folderRole(displayName, []),
    total: Number(raw['totalItemCount'] ?? 0) || 0,
    unread: Number(raw['unreadItemCount'] ?? 0) || 0,
  }
}

const GRAPH_FOLDER_FIELDS = 'id,displayName,totalItemCount,unreadItemCount,childFolderCount'

/** 文件夹列表（含计数）：先用知名文件夹端点定 id→role，再分页拉全量并逐层展开子文件夹 */
export async function graphListFolders(accessTok: string, timeoutMs?: number): Promise<GraphFolderInfo[]> {
  const roleById = new Map<string, MailFolderRole>()
  await Promise.all(GRAPH_WELL_KNOWN_ROLES.map(async ([wk, role]) => {
    try {
      const res = await graphHttp(accessTok, 'GET', `/me/mailFolders/${wk}?$select=id`, undefined, timeoutMs)
      if (res.status >= 200 && res.status < 300) {
        const j = JSON.parse(res.text) as Record<string, unknown>
        if (j['id']) roleById.set(String(j['id']), role)
      }
    } catch { /* 单个知名文件夹查不到不阻断整体，role 回落显示名判定 */ }
  }))
  const folders: GraphFolderInfo[] = []
  const seen = new Set<string>()
  const pullLevel = async (firstUrl: string, depth: number): Promise<void> => {
    let next: string | null = firstUrl
    while (next && folders.length < 200) {
      const res: GraphHttpResult = await graphHttp(accessTok, 'GET', next, undefined, timeoutMs)
      assertGraphOk(res, '拉取文件夹列表')
      const j = JSON.parse(res.text) as { value?: Record<string, unknown>[]; '@odata.nextLink'?: string }
      for (const rawF of j.value ?? []) {
        const info = mapGraphFolder(rawF, roleById.get(String(rawF['id'] ?? '')))
        if (!info.name || seen.has(info.name)) continue
        seen.add(info.name)
        folders.push(info)
        if (Number(rawF['childFolderCount'] ?? 0) > 0 && depth < 3) {
          await pullLevel(`/me/mailFolders/${encodeURIComponent(info.name)}/childFolders?$top=100&$select=${GRAPH_FOLDER_FIELDS}`, depth + 1)
        }
      }
      next = j['@odata.nextLink'] ?? null
    }
  }
  await pullLevel(`/me/mailFolders?$top=100&$select=${GRAPH_FOLDER_FIELDS}`, 0)
  return folders
}

/** Graph 邮件 id → 稳定数值 uid（FNV-1a）：只作本地 key/排序用，真实 id 在 graphId 里 */
export function hashGraphId(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) || 1
}

/** Graph 邮件 JSON → 现有 MailMessage 头结构（分类沿用现有规则） */
export function mapGraphMessage(raw: Record<string, unknown>, accountId: string, folderId: string): MailMessage {
  const graphId = String(raw['id'] ?? '')
  const fromObj = (raw['from'] as { emailAddress?: { name?: string; address?: string } } | null)?.emailAddress ?? {}
  const fromAddr = String(fromObj.address ?? '')
  const flags: string[] = []
  if (raw['isRead']) flags.push('\\Seen')
  if ((raw['flag'] as { flagStatus?: string } | null)?.flagStatus === 'flagged') flags.push('\\Flagged')
  const uid = hashGraphId(graphId)
  const msg: MailMessage = {
    key: `${accountId}|${folderId}|${uid}`,
    accountId,
    folder: folderId,
    uid,
    graphId,
    from: String(fromObj.name ?? '') || fromAddr,
    fromAddr,
    subject: String(raw['subject'] ?? '') || '(无主题)',
    date: Date.parse(String(raw['receivedDateTime'] ?? '')) || 0,
    snippet: String(raw['bodyPreview'] ?? '').replace(/\s+/g, ' ').trim().slice(0, 140),
    flags,
    hasAttach: !!raw['hasAttachments'],
    size: 0,
    category: 'personal',
  }
  msg.category = classifyMessage(msg)
  return msg
}

const GRAPH_MESSAGE_FIELDS = 'id,subject,from,receivedDateTime,isRead,hasAttachments,bodyPreview,flag'

/** 按文件夹分页拉邮件头（跟 @odata.nextLink，直到 limit 或拉完） */
export async function graphListMessages(accessTok: string, accountId: string, folderId: string, limit: number): Promise<MailMessage[]> {
  const out: MailMessage[] = []
  let next: string | null = `/me/mailFolders/${encodeURIComponent(folderId)}/messages?$top=${Math.min(100, Math.max(1, limit))}&$orderby=receivedDateTime%20desc&$select=${GRAPH_MESSAGE_FIELDS}`
  while (next && out.length < limit) {
    const res: GraphHttpResult = await graphHttp(accessTok, 'GET', next)
    assertGraphOk(res, '拉取邮件列表')
    const j = JSON.parse(res.text) as { value?: Record<string, unknown>[]; '@odata.nextLink'?: string }
    for (const rawM of j.value ?? []) {
      if (out.length >= limit) break
      out.push(mapGraphMessage(rawM, accountId, folderId))
    }
    next = j['@odata.nextLink'] ?? null
  }
  return out
}

/** 取一封邮件的原始 MIME（$value），字节原样交给 parseMimeMessage（附件随 MIME 一并解析） */
export async function graphFetchMessageMime(accessTok: string, graphId: string): Promise<Uint8Array> {
  const res = await graphHttp(accessTok, 'GET', `/me/messages/${encodeURIComponent(graphId)}/$value`)
  assertGraphOk(res, '拉取邮件正文')
  return res.bytes
}

export async function graphPatchMessage(accessTok: string, graphId: string, patch: Record<string, unknown>): Promise<void> {
  const res = await graphHttp(accessTok, 'PATCH', `/me/messages/${encodeURIComponent(graphId)}`, patch)
  assertGraphOk(res, '更新邮件标记')
}

export async function graphMoveMessage(accessTok: string, graphId: string, destFolderId: string): Promise<void> {
  const res = await graphHttp(accessTok, 'POST', `/me/messages/${encodeURIComponent(graphId)}/move`, { destinationId: destFolderId })
  assertGraphOk(res, '移动邮件')
}

export async function graphDeleteMessage(accessTok: string, graphId: string): Promise<void> {
  const res = await graphHttp(accessTok, 'DELETE', `/me/messages/${encodeURIComponent(graphId)}`)
  assertGraphOk(res, '删除邮件')
}

export interface GraphBatchRequest {
  id: string
  method: string
  /** $batch 内的相对路径，如 /me/messages/{id}/move */
  url: string
  body?: unknown
}

export interface GraphBatchItemResult {
  id: string
  status: number
  text: string
}

/** $batch 批量（微软上限 20 条/批，自动分片）；批本身失败按原文抛，单条成败看返回的 status */
export async function graphBatch(accessTok: string, requests: GraphBatchRequest[], timeoutMs?: number): Promise<GraphBatchItemResult[]> {
  const results: GraphBatchItemResult[] = []
  for (let i = 0; i < requests.length; i += 20) {
    const chunk = requests.slice(i, i + 20)
    const res = await graphHttp(accessTok, 'POST', '/$batch', {
      requests: chunk.map(r => ({
        id: r.id,
        method: r.method,
        url: r.url,
        ...(r.body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: r.body } : {}),
      })),
    }, timeoutMs)
    assertGraphOk(res, '批量操作')
    const j = JSON.parse(res.text) as { responses?: { id: string; status: number; body?: unknown }[] }
    for (const item of j.responses ?? []) {
      results.push({
        id: String(item.id),
        status: Number(item.status),
        text: typeof item.body === 'string' ? item.body : JSON.stringify(item.body ?? ''),
      })
    }
  }
  return results
}

/** 一个文件夹的全部邮件 id（删全部用，分页跟 nextLink） */
export async function graphListAllMessageIds(accessTok: string, folderId: string, timeoutMs?: number): Promise<string[]> {
  const ids: string[] = []
  let next: string | null = `/me/mailFolders/${encodeURIComponent(folderId)}/messages?$top=999&$select=id`
  while (next) {
    const res: GraphHttpResult = await graphHttp(accessTok, 'GET', next, undefined, timeoutMs)
    assertGraphOk(res, '搜索邮件')
    const j = JSON.parse(res.text) as { value?: { id?: string }[]; '@odata.nextLink'?: string }
    for (const v of j.value ?? []) if (v.id) ids.push(String(v.id))
    next = j['@odata.nextLink'] ?? null
  }
  return ids
}

/**
 * Graph 账户的「连接」：旧令牌本地检出 → 必要时刷新（微软按 Graph 范围）→ 声明校验 →
 * 轻探活（GET 文件夹第一页）。成功后回填 transport='graph' 并清重新授权标记。
 */
async function ensureGraphConnected(account: MailAccountMeta, secret0: MailSecret, pwd: string): Promise<LiveSession> {
  const cached = graphSessions.get(account.id)
  if (cached) return cached
  let secret = secret0
  if (secret.kind === 'oauth') {
    // 本地迁移检出（不发网络）：手里的 access token 若 aud 是 Outlook 资源，就是
    // 459 前的 IMAP 旧令牌；秘钥记录的 scope 没有 Mail.ReadWrite 同理。都走重新授权。
    const payload = decodeJwtPayload(secret.accessTok)
    const aud = String(payload?.['aud'] ?? '').replace(/\/$/, '')
    const legacyByAud = !!aud && OUTLOOK_TOKEN_AUDIENCES.includes(aud)
    const legacyByScope = !!secret.scope && !secret.scope.includes('Mail.ReadWrite')
    if (legacyByAud || legacyByScope) {
      setMailReauthFlag(account.id, MAIL_GRAPH_MIGRATION_MESSAGE)
      throw new Error(MAIL_GRAPH_MIGRATION_MESSAGE)
    }
  }
  secret = await refreshOAuthSecret(account, secret, pwd)
  if (secret.kind !== 'oauth') throw new Error('这个账户的凭据不是 OAuth 令牌，无法走 Graph 通道')
  const tokenProblem = diagnoseOAuthTokenForGraph(account, secret.accessTok)
  if (tokenProblem) throw new Error(tokenProblem)
  const probe = await graphHttp(secret.accessTok, 'GET', '/me/mailFolders?$top=1&$select=id', undefined, 30_000)
  assertGraphOk(probe, '连接验证')
  const session: LiveSession = { secret, caps: 'GRAPH' }
  graphSessions.set(account.id, session)
  await setMailAccountTransport(account.id, 'graph')
  account.transport = 'graph'
  clearMailReauthFlag(account.id)
  return session
}

/** 界面操作（标记/删除/移动）在无凭据参数时取 Graph 令牌：来自同步/连接时建的会话 */
function graphSessionToken(account: MailAccountMeta): string {
  const s = graphSessions.get(account.id)
  if (!s || s.secret.kind !== 'oauth') throw new Error('Graph 连接未建立，请先点「刷新」同步一次再操作')
  return s.secret.accessTok
}

/** v0.1.450：连接进度步骤（Rust 侧 mail_connect_step 事件回告），验证按钮据此分步显示 */
export type MailConnectStep = 'connecting' | 'handshaking' | 'logging-in'

export const MAIL_CONNECT_STEP_LABELS: Record<MailConnectStep, string> = {
  connecting: '正在连接服务器…',
  handshaking: '正在加密握手…',
  'logging-in': '正在登录验证…',
}

export const MAIL_CONNECT_STEP_EVENT = 'mail_connect_step'

/** 确保账户已连接（必要时刷新 OAuth 令牌）；返回能力串。onStep 收到连接进度步骤（尽力而为，事件通道不可用时不回调）。
 *  v0.1.459：Outlook OAuth 账户分流到 Graph（ensureGraphConnected），其余账户走原 IMAP 连接。 */
export async function mailEnsureConnected(account: MailAccountMeta, pwd: string, onStep?: (step: MailConnectStep) => void): Promise<LiveSession> {
  // 已知通道时先查会话缓存，省掉每次解密（IMAP 旧行为一致）
  if (account.transport === 'graph') {
    const g = graphSessions.get(account.id)
    if (g) return g
  } else if (account.transport === 'imap') {
    const existing0 = liveSessions.get(account.id)
    if (existing0) return existing0
  }
  let secret = await loadMailSecret(account.id, pwd)
  if (!secret) {
    // v0.1.461：账户在、凭据读不到（461 前保存被竞态/配额打断的存量，或凭据损坏）。
    // OAuth 账户落重新授权标记，界面给出「重新授权」入口补回，不再逼用户删账户。
    if (mailPlatform(account.platformId).oauthProvider) {
      setMailReauthFlag(account.id, '保险箱里没有这个账户的凭据，点「重新授权」补回即可，不用删除账户')
      throw new Error('保险箱里没有这个账户的凭据，请点「重新授权」补回（不用删除账户）')
    }
    throw new Error('保险箱里没有这个账户的凭据，请删除后用授权码重新添加')
  }
  if (mailSecretUsesGraph(account, secret)) return ensureGraphConnected(account, secret, pwd)
  const existing = liveSessions.get(account.id)
  if (existing) return existing
  secret = await refreshOAuthSecret(account, secret, pwd)
  // v0.1.458：发连接前先验令牌声明（仅微软 JWT）：aud/scp/upn 任一可证伪就不发连接，
  // 直接报精确原因，省得服务器回「authenticated but not connected」让用户猜。
  if (secret.kind === 'oauth') {
    const tokenProblem = diagnoseOAuthTokenForImap(account, secret.accessTok)
    if (tokenProblem) throw new Error(tokenProblem)
  }
  const timeoutMs = mailConnectTimeoutMs()
  let unlisten: (() => void) | undefined
  if (onStep) {
    try {
      const { listen } = await import('@tauri-apps/api/event')
      unlisten = await listen<{ accountId: string; step: MailConnectStep }>(MAIL_CONNECT_STEP_EVENT, e => {
        if (e.payload?.accountId === account.id && e.payload.step) onStep(e.payload.step)
      })
    } catch { /* 网页/测试环境无事件通道：步骤文案保持当前值，不阻断连接 */ }
  }
  let caps: string
  try {
    caps = await raceTimeout(
      tauriInvoke<string>('mail_imap_connect', {
        accountId: account.id,
        host: account.host,
        port: account.port,
        useTls: account.port !== 143,
        authMode: secret.kind === 'oauth' ? 'xoauth2' : 'login',
        username: account.email,
        secret: secret.kind === 'oauth' ? secret.accessTok : secret.secret,
      }),
      timeoutMs,
      `连接验证超时（${Math.round(timeoutMs / 1000)} 秒内服务器未完成连接验证），已自动中止；请检查网络与服务器地址后重试`,
    )
  } catch (e) {
    // 超时或失败都请后端掐掉可能还在途的连接，避免留下一条僵尸连接
    if (e instanceof Error && e.message.includes('连接验证超时')) void mailCancelConnect(account.id)
    throw e
  } finally {
    unlisten?.()
  }
  const session: LiveSession = { secret, caps }
  liveSessions.set(account.id, session)
  await setMailAccountTransport(account.id, 'imap') // v0.1.459：回填通道，界面操作据此判路由
  account.transport = 'imap'
  clearMailReauthFlag(account.id) // v0.1.446：连上了就说明授权有效，清掉可能残留的重新授权标记
  return session
}

/**
 * 添加账户时的快速验证（v0.1.450）：只做连通 + 登录 + CAPABILITY，
 * 文件夹枚举/计数/拉头部全部留给回到收件箱后的首次同步，不再压在验证按钮上。
 */
export async function mailVerifyAccount(account: MailAccountMeta, pwd: string, onStep?: (step: MailConnectStep) => void): Promise<string> {
  const session = await mailEnsureConnected(account, pwd, onStep)
  return session.caps
}

export async function mailDisconnect(accountId: string): Promise<void> {
  mailForgetSession(accountId)
  try { await tauriInvoke('mail_imap_disconnect', { accountId }) } catch { /* 已断开则忽略 */ }
}

export interface MailSyncOutcome {
  accountId: string
  ok: boolean
  error?: string
  newKeys: string[]
  caps: string
  idleSupported: boolean
}

/** 连接并同步一个账户（全部文件夹的头部，统一进缓存）；失败返回服务器真实原因 */
export async function mailSyncAccount(account: MailAccountMeta, pwd: string, headerLimit = 60): Promise<MailSyncOutcome> {
  try {
    const session = await mailEnsureConnected(account, pwd)
    // v0.1.459：Graph 账户同步——文件夹/计数与逐文件夹邮件头都走 Graph REST，
    // 缓存结构与 IMAP 完全一致；Graph 没有 IDLE，idleSupported=false → 界面如实标轮询。
    if (account.transport === 'graph' && session.secret.kind === 'oauth') {
      const tok = session.secret.accessTok
      const folders = await graphListFolders(tok)
      if (!folders.length) throw new Error('微软 Graph 没有返回任何文件夹')
      const prev = loadMailCache()[account.id]
      const prevKeys = new Set((prev?.messages ?? []).map(m => m.key))
      const messages: MailMessage[] = []
      for (const folder of folders) {
        messages.push(...await graphListMessages(tok, account.id, folder.name, headerLimit))
      }
      const cache = loadMailCache()
      cache[account.id] = { folders, messages, caps: session.caps, updatedAt: Date.now() }
      saveMailCache(cache)
      const newKeys = prev ? messages.filter(m => !prevKeys.has(m.key) && !m.flags.includes('\\Seen')).map(m => m.key) : []
      void prefetchMailBodies(account, messages)
      return { accountId: account.id, ok: true, newKeys, caps: session.caps, idleSupported: false }
    }
    const listRaw = await mailInvoke<string>('mail_imap_list_folders', { accountId: account.id }, '拉取文件夹列表（LIST）')
    const folders = parseListFolders(listRaw)
    if (!folders.length) throw new Error('服务器没有返回任何文件夹')
    const prev = loadMailCache()[account.id]
    const prevKeys = new Set((prev?.messages ?? []).map(m => m.key))
    const messages: MailMessage[] = []
    for (const folder of folders) {
      const raw = await mailInvoke<string>('mail_imap_fetch_headers', { accountId: account.id, folder: folder.name, limit: headerLimit }, `拉取「${folder.name}」邮件列表（FETCH）`)
      messages.push(...parseFetchHeaders(raw, account.id, folder.name))
    }
    const cache = loadMailCache()
    cache[account.id] = { folders, messages, caps: session.caps, updatedAt: Date.now() }
    saveMailCache(cache)
    const newKeys = prev ? messages.filter(m => !prevKeys.has(m.key) && !m.flags.includes('\\Seen')).map(m => m.key) : []
    // 启动 IDLE（收件箱优先）；支不支持由 Rust 事件回告，界面据此标注同步方式
    const idleFolder = folders.find(f => f.role === 'inbox') ?? folders[0]
    const secret = session.secret
    void tauriInvoke('mail_imap_idle_start', {
      accountId: account.id,
      host: account.host,
      port: account.port,
      useTls: account.port !== 143,
      authMode: secret.kind === 'oauth' ? 'xoauth2' : 'login',
      username: account.email,
      secret: secret.kind === 'oauth' ? secret.accessTok : secret.secret,
      folder: idleFolder.name,
    }).catch(() => { /* IDLE 起不来不阻断同步，状态会显示为手动刷新 */ })
    // v0.1.450：后台预取最新几封正文进本机缓存（不阻塞同步结果），打开这些邮件时秒显
    void prefetchMailBodies(account, messages)
    return { accountId: account.id, ok: true, newKeys, caps: session.caps, idleSupported: session.caps.includes('IDLE') }
  } catch (e) {
    mailForgetSession(account.id)
    return { accountId: account.id, ok: false, error: displayMailError(e instanceof Error ? e.message : String(e), { transport: account.transport }), newKeys: [], caps: '', idleSupported: false }
  }
}

function patchCacheMessages(accountId: string, fn: (messages: MailMessage[]) => MailMessage[]): void {
  const cache = loadMailCache()
  const entry = cache[accountId]
  if (!entry) return
  entry.messages = fn(entry.messages)
  saveMailCache(cache)
}

export async function mailSetFlag(account: MailAccountMeta, msg: MailMessage, flag: '\\Seen' | '\\Flagged', add: boolean): Promise<void> {
  if (mailMetaUsesGraph(account)) {
    // v0.1.459：Graph 账户走 PATCH：已读=isRead，星标=flag.flagStatus
    if (!msg.graphId) throw new Error('这封邮件缺少 Graph 标识，请刷新后重试')
    const tok = graphSessionToken(account)
    if (flag === '\\Seen') await graphPatchMessage(tok, msg.graphId, { isRead: add })
    else await graphPatchMessage(tok, msg.graphId, { flag: { flagStatus: add ? 'flagged' : 'notFlagged' } })
  } else {
    await mailInvoke('mail_imap_store_flags', { accountId: account.id, folder: msg.folder, uids: [msg.uid], flag, add }, '更新邮件标记（STORE）')
  }
  patchCacheMessages(account.id, list => list.map(m => {
    if (m.key !== msg.key) return m
    const flags = add ? [...new Set([...m.flags, flag])] : m.flags.filter(f => f !== flag)
    return { ...m, flags }
  }))
}

/** 移动邮件（复制到目标文件夹 + 从原文件夹删除，IMAP 的标准移动法） */
export async function mailMoveMessages(account: MailAccountMeta, msgs: MailMessage[], destFolder: string): Promise<void> {
  const byFolder = new Map<string, MailMessage[]>()
  for (const m of msgs) {
    if (m.folder === destFolder) continue
    byFolder.set(m.folder, [...(byFolder.get(m.folder) ?? []), m])
  }
  for (const [folder, list] of byFolder) {
    if (mailMetaUsesGraph(account)) {
      // v0.1.459：Graph 有原生 move，不用 IMAP 的复制+删除
      const tok = graphSessionToken(account)
      for (const m of list) {
        if (!m.graphId) throw new Error('这封邮件缺少 Graph 标识，请刷新后重试')
        await graphMoveMessage(tok, m.graphId, destFolder)
      }
    } else {
      await mailInvoke('mail_imap_delete_messages', {
        accountId: account.id, folder, uids: list.map(m => m.uid), trashFolder: destFolder,
      }, '移动邮件（COPY/删除）')
    }
    const destRole = loadMailCache()[account.id]?.folders.find(f => f.name === destFolder)?.role ?? 'other'
    void destRole
    dropCachedBodies(list.map(m => m.key)) // 移动后 key 变了，旧 key 的正文缓存作废
    patchCacheMessages(account.id, all => all.map(m => (list.some(x => x.key === m.key) ? { ...m, folder: destFolder, key: `${account.id}|${destFolder}|${m.uid}` } : m)))
  }
}

/** 删除邮件：有垃圾箱移垃圾箱（在垃圾箱里则彻底删），返回实际方式 */
export async function mailDeleteMessages(account: MailAccountMeta, msgs: MailMessage[]): Promise<'trash' | 'permanent'> {
  const cache = loadMailCache()[account.id]
  const folders = cache?.folders ?? []
  const byFolder = new Map<string, MailMessage[]>()
  for (const m of msgs) byFolder.set(m.folder, [...(byFolder.get(m.folder) ?? []), m])
  let mode: 'trash' | 'permanent' = 'permanent'
  for (const [folder, list] of byFolder) {
    const decision = resolveDeleteMode(folders, folder)
    if (decision.mode === 'trash') mode = 'trash'
    if (mailMetaUsesGraph(account)) {
      // v0.1.459：Graph 删除——移入垃圾箱走 move 到已删除文件夹 id，彻底删走 DELETE；
      // $batch 分片执行，单条失败如实汇总抛错（已成功的以服务器为准，下次同步对齐）
      const tok = graphSessionToken(account)
      const reqs: GraphBatchRequest[] = list.map((m, i) => {
        if (!m.graphId) throw new Error('这封邮件缺少 Graph 标识，请刷新后重试')
        return decision.mode === 'trash'
          ? { id: String(i), method: 'POST', url: `/me/messages/${encodeURIComponent(m.graphId)}/move`, body: { destinationId: decision.trashFolder } }
          : { id: String(i), method: 'DELETE', url: `/me/messages/${encodeURIComponent(m.graphId)}` }
      })
      const results = await graphBatch(tok, reqs)
      const failed = results.filter(r => r.status < 200 || r.status >= 300)
      const missing = list.length - results.length
      if (failed.length || missing > 0) {
        const first = failed[0]
        throw new Error(`删除邮件部分失败（${failed.length + missing}/${list.length} 封）${first ? `：${graphErrorDetail(first.status, first.text)}` : ''}`)
      }
    } else {
      await mailInvoke('mail_imap_delete_messages', {
        accountId: account.id, folder, uids: list.map(m => m.uid), trashFolder: decision.trashFolder ?? null,
      }, '删除邮件')
    }
    const keys = new Set(list.map(m => m.key))
    dropCachedBodies(list.map(m => m.key))
    patchCacheMessages(account.id, all => all.filter(m => !keys.has(m.key)))
  }
  return mode
}

// ---------------- 正文缓存（v0.1.450：打开邮件先秒显缓存，后台再校验） ----------------

export type MailBodyResult = MailBodyContent & { code: string | null }

interface CachedBody {
  at: number
  body: MailBodyResult
}

const BODY_CACHE_MAX = 40
const BODY_CACHE_MAX_CHARS = 1_000_000
/** 同步时预取正文的封数（最新优先）：打开这些邮件直接命中缓存 */
export const MAIL_PREFETCH_COUNT = 8

export function loadCachedBody(key: string): MailBodyResult | null {
  const all = readJson<Record<string, CachedBody>>(BODIES_KEY, {})
  return all[key]?.body ?? null
}

export function saveCachedBody(key: string, body: MailBodyResult): void {
  try {
    if (JSON.stringify(body).length > BODY_CACHE_MAX_CHARS) return // 巨型内嵌图等不进缓存
    const all = readJson<Record<string, CachedBody>>(BODIES_KEY, {})
    all[key] = { at: Date.now(), body }
    const kept = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, BODY_CACHE_MAX)
    writeJson(BODIES_KEY, Object.fromEntries(kept))
  } catch { /* 缓存可再生，失败静默 */ }
}

export function dropCachedBodies(keys: string[]): void {
  if (!keys.length) return
  const all = readJson<Record<string, CachedBody>>(BODIES_KEY, {})
  let changed = false
  for (const k of keys) if (all[k]) { delete all[k]; changed = true }
  if (changed) writeJson(BODIES_KEY, all)
}

/**
 * 拉一封邮件的正文（v0.1.450 提速）：先取 BODYSTRUCTURE，只按段拉文本段与 cid 内嵌图，
 * 附件只记元信息不拉数据（点保存时 mailFetchAttachment 现拉）——带大附件的邮件
 * 不再整封全文过网。结构取不到/解析不出时回落旧全文拉取（结果一致，只是慢）。
 * 成功后写入正文缓存，阅读页下次打开先显缓存。
 */
export async function mailFetchBody(account: MailAccountMeta, msg: MailMessage): Promise<MailBodyResult> {
  // v0.1.459：Graph 账户取 $value 原始 MIME 喂现有 parseMimeMessage（附件随 MIME
  // 一并解析出 base64，保存时直接用），验证码提取与正文缓存与 IMAP 路径共用。
  if (mailMetaUsesGraph(account)) {
    if (!msg.graphId) throw new Error('这封邮件缺少 Graph 标识，请刷新后重试')
    const bytes = await graphFetchMessageMime(graphSessionToken(account), msg.graphId)
    if (!bytes.length) throw new Error('微软 Graph 未返回邮件正文')
    const gbody = parseMimeMessage(bytes)
    const gcode = extractVerifyCode(`${msg.subject}\n${gbody.text || htmlToText(gbody.html)}`)
    const gout: MailBodyResult = { ...gbody, code: gcode }
    saveCachedBody(msg.key, gout)
    return gout
  }
  let body: MailBodyContent | null = null
  try {
    const structRaw = await mailInvoke<string>('mail_imap_fetch_structure', { accountId: account.id, folder: msg.folder, uid: msg.uid }, '读取邮件结构（FETCH）')
    const parts = structRaw ? parseBodyStructure(structRaw) : []
    const want = parts.filter(p => {
      const isText = p.contentType === 'text/plain' || p.contentType === 'text/html'
      if (p.cid && !isText) return true
      return isText && p.disposition !== 'attachment'
    })
    if (parts.length && want.length) {
      const json = await mailInvoke<string>('mail_imap_fetch_sections', {
        accountId: account.id, folder: msg.folder, uid: msg.uid, sections: want.map(p => p.section),
      }, '拉取邮件正文（FETCH）')
      const obj = JSON.parse(json) as Record<string, string>
      const data = new Map<string, Uint8Array>()
      for (const p of want) {
        const b64 = obj[p.section]
        if (b64) data.set(p.section, b64ToBytes(b64))
      }
      body = assembleBodyFromParts(parts, data)
    }
  } catch { body = null }
  if (!body) {
    const b64 = await mailInvoke<string>('mail_imap_fetch_message', { accountId: account.id, folder: msg.folder, uid: msg.uid }, '拉取邮件正文（FETCH）')
    if (!b64) throw new Error('服务器未返回邮件正文')
    body = parseMimeMessage(b64ToBytes(b64))
  }
  const code = extractVerifyCode(`${msg.subject}\n${body.text || htmlToText(body.html)}`)
  const out: MailBodyResult = { ...body, code }
  saveCachedBody(msg.key, out)
  return out
}

/** 同步后预取最新 MAIL_PREFETCH_COUNT 封正文（逐封串行、失败不影响同步，mailFetchBody 自带写缓存） */
async function prefetchMailBodies(account: MailAccountMeta, messages: MailMessage[]): Promise<void> {
  const newest = [...messages].sort((a, b) => b.date - a.date).slice(0, MAIL_PREFETCH_COUNT)
  for (const m of newest) {
    if (loadCachedBody(m.key)) continue
    try { await mailFetchBody(account, m) } catch { /* 预取失败不影响同步，用户打开时再正常拉取 */ }
  }
}

/** 附件按需拉取（v0.1.450）：正文阶段没拉附件数据，保存时按段现拉这一段 */
export async function mailFetchAttachment(account: MailAccountMeta, msg: MailMessage, att: MailAttachment): Promise<string> {
  if (att.base64) return att.base64
  // v0.1.459：Graph 正文是整封 MIME 解析的，附件本应带 base64；没有就是数据不完整
  if (mailMetaUsesGraph(account)) throw new Error('这封邮件的附件数据不完整，请刷新邮件后重试')
  if (!att.section) throw new Error('这封邮件的附件缺少段信息，请刷新后重试')
  const json = await mailInvoke<string>('mail_imap_fetch_sections', {
    accountId: account.id, folder: msg.folder, uid: msg.uid, sections: [att.section],
  }, '拉取附件（FETCH）')
  const obj = JSON.parse(json) as Record<string, string>
  const rawB64 = obj[att.section]
  if (!rawB64) throw new Error('服务器未返回附件内容')
  // 段数据是传输编码形态（附件多为 base64 文本本身），解码后重新编码才是文件内容
  return bytesToBase64(decodeTransferBytes(b64ToBytes(rawB64), att.encoding ?? ''))
}

export async function mailSaveAttachment(filename: string, base64: string): Promise<string> {
  const dir = await tauriInvoke<string | null>('choose_save_dir', {})
  if (!dir) throw new Error('未选择保存目录')
  return tauriInvoke<string>('write_binary_to_dir', { dir, filename, contentBase64: base64 })
}

export interface MailDeleteAllReport {
  accountId: string
  email: string
  deleted: number
  mode: 'trash' | 'permanent' | 'mixed'
  error?: string
  /** v0.1.466：用户中途取消时，这个账户删到一半停住（deleted 是已删实数） */
  cancelled?: boolean
  /** v0.1.466：取消发生时这个账户还没轮到开始，一封未删 */
  notStarted?: boolean
}

/** v0.1.466：删除全部的取消令牌（界面点「取消删除」时置 cancelled=true，删除链路在每个批次前检查） */
export interface MailDeleteCancelToken {
  cancelled: boolean
}

/** v0.1.466：删除进度事件（账户 → 文件夹 → 批次三级粒度，界面据此渲染真进度） */
export type MailDeleteAllProgressEvent =
  | { type: 'account-start'; accountId: string; email: string }
  | { type: 'folder-start'; accountId: string; folder: string; folderLabel: string; total: number }
  | { type: 'batch'; accountId: string; folder: string; batchIndex: number; batchCount: number; deletedInFolder: number; deletedInAccount: number }
  | { type: 'account-done'; accountId: string; deleted: number; mode: 'trash' | 'permanent' | 'mixed' }
  | { type: 'account-error'; accountId: string; deleted: number; error: string }
  | { type: 'account-cancelled'; accountId: string; deleted: number }

export interface MailDeleteAllOptions {
  onEvent?: (event: MailDeleteAllProgressEvent) => void
  cancelToken?: MailDeleteCancelToken
}

/** 并发上限内跑完全部任务并按原序返回结果（删除/预检的账户级并行用，上限 3） */
export async function mapWithConcurrencyLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

/**
 * v0.1.459：Graph 账户的一键删除全部——非垃圾箱文件夹先 $batch 移入已删除文件夹，
 * 垃圾箱最后 $batch 彻底删；计数口径与 IMAP 版一致（垃圾箱只计原本就在里面的，
 * 避免把刚移入的重复计数）。部分失败不中断：报告里如实写失败封数与首个微软原文。
 * v0.1.466：每 20 条一批单独发 $batch 并报进度（原来整文件夹一次发完、中途零进度）；
 * 每步 Graph 请求带单步超时；每批前查取消令牌，取消则停在本账户并如实返回已删数。
 * 返回 'done' | 'cancelled'。
 */
async function graphDeleteAll(
  account: MailAccountMeta,
  report: MailDeleteAllReport,
  ctx: { emit: (e: MailDeleteAllProgressEvent) => void; isCancelled: () => boolean; legacyProgress: () => void },
): Promise<'done' | 'cancelled'> {
  const tok = graphSessionToken(account)
  const stepMs = mailGraphStepTimeoutMs()
  const folders = await graphListFolders(tok, stepMs)
  const trash = folders.find(f => f.role === 'trash')
  const initialTrashIds = new Set(trash ? await graphListAllMessageIds(tok, trash.name, stepMs) : [])
  let usedTrash = false
  let usedPermanent = false
  let failedCount = 0
  let firstError = ''
  const runBatch = async (reqs: GraphBatchRequest[]): Promise<Set<string>> => {
    const okIds = new Set<string>()
    if (!reqs.length) return okIds
    const results = await graphBatch(tok, reqs, stepMs)
    const byId = new Map(results.map(r => [r.id, r]))
    for (const r of reqs) {
      const item = byId.get(r.id)
      if (item && item.status >= 200 && item.status < 300) okIds.add(r.id)
      else {
        failedCount += 1
        if (!firstError) firstError = item ? graphErrorDetail(item.status, item.text) : '批量操作没有返回这一条的结果'
      }
    }
    return okIds
  }
  const ordered = [...folders.filter(f => f.role !== 'trash'), ...folders.filter(f => f.role === 'trash')]
  for (const folder of ordered) {
    if (ctx.isCancelled()) return 'cancelled'
    const ids = await graphListAllMessageIds(tok, folder.name, stepMs)
    if (!ids.length) continue
    const toTrash = trash && folder.role !== 'trash'
    if (toTrash) usedTrash = true
    else usedPermanent = true
    ctx.emit({ type: 'folder-start', accountId: account.id, folder: folder.name, folderLabel: folder.label ?? folder.name, total: ids.length })
    let deletedInFolder = 0
    const batchCount = Math.ceil(ids.length / 20)
    for (let i = 0; i < ids.length; i += 20) {
      if (ctx.isCancelled()) return 'cancelled'
      const chunkIds = ids.slice(i, i + 20)
      const okIds = await runBatch(chunkIds.map(id => (toTrash && trash)
        ? { id, method: 'POST', url: `/me/messages/${encodeURIComponent(id)}/move`, body: { destinationId: trash.name } }
        : { id, method: 'DELETE', url: `/me/messages/${encodeURIComponent(id)}` }))
      // 清垃圾箱这一步删的含刚移入的邮件，只计快照内原本就在垃圾箱的数量（与 IMAP 版同口径）
      const counted = folder.role === 'trash' ? [...okIds].filter(id => initialTrashIds.has(id)).length : okIds.size
      deletedInFolder += counted
      report.deleted += counted
      ctx.emit({
        type: 'batch', accountId: account.id, folder: folder.name,
        batchIndex: Math.floor(i / 20) + 1, batchCount, deletedInFolder, deletedInAccount: report.deleted,
      })
      ctx.legacyProgress()
    }
  }
  report.mode = usedTrash && usedPermanent ? 'mixed' : usedTrash ? 'trash' : 'permanent'
  if (failedCount > 0) report.error = `有 ${failedCount} 封删除失败：${firstError}`
  if (failedCount === 0) {
    const cache = loadMailCache()
    if (cache[account.id]) {
      cache[account.id] = { ...cache[account.id], messages: [], updatedAt: Date.now() }
      saveMailCache(cache)
    }
  }
  return 'done'
}

export interface MailDeleteAllPreviewEntry {
  account: MailAccountMeta
  total: number
  mode: 'trash' | 'permanent' | 'mixed'
  /** snapshot=本地已同步数据的即时快照（可能与服务器有出入）；verified=已连服务器核对 */
  source: 'snapshot' | 'verified'
  error?: string
}

/**
 * v0.1.466：本地快照封数——弹窗打开的瞬间就能渲染，不连任何服务器。
 * 数据来自上次同步的缓存：Graph 账户缓存文件夹带服务器计数时用计数和，
 * 否则数本地已同步邮件条数。只是快照，界面必须如实标注，随后由核对结果逐行替换。
 */
export function mailDeleteAllSnapshot(accounts: MailAccountMeta[]): MailDeleteAllPreviewEntry[] {
  const cache = loadMailCache()
  return accounts.map(account => {
    const entry = cache[account.id]
    if (!entry) return { account, total: 0, mode: 'permanent' as const, source: 'snapshot' as const }
    const hasTrash = entry.folders.some(f => f.role === 'trash')
    const folderTotals = entry.folders.map(f => (f as GraphFolderInfo).total)
    let total: number
    let hasNonTrashMail: boolean
    if (entry.folders.length > 0 && folderTotals.every(t => typeof t === 'number')) {
      total = folderTotals.reduce((a, b) => a + (b ?? 0), 0)
      hasNonTrashMail = entry.folders.some((f, i) => f.role !== 'trash' && (folderTotals[i] ?? 0) > 0)
    } else {
      const roleByName = new Map(entry.folders.map(f => [f.name, f.role]))
      total = entry.messages.length
      hasNonTrashMail = entry.messages.some(m => roleByName.get(m.folder) !== 'trash')
    }
    const mode: 'trash' | 'permanent' | 'mixed' = !hasTrash ? 'permanent' : hasNonTrashMail ? 'mixed' : 'permanent'
    return { account, total, mode, source: 'snapshot' as const }
  })
}

/** 单个账户的服务器核对（纯只读：Graph 文件夹计数 / IMAP 的 LIST+STATUS，不删任何东西） */
async function previewDeleteAllOne(account: MailAccountMeta, pwd: string): Promise<MailDeleteAllPreviewEntry> {
  try {
    await mailEnsureConnected(account, pwd)
    if (account.transport === 'graph') {
      // v0.1.459：Graph 预检——文件夹计数直接来自 mailFolders 的 totalItemCount
      const gfolders = await graphListFolders(graphSessionToken(account), mailGraphStepTimeoutMs())
      let gsum = 0
      let gHasNonTrashMail = false
      for (const f of gfolders) {
        gsum += f.total
        if (f.total > 0 && f.role !== 'trash') gHasNonTrashMail = true
      }
      const gHasTrash = !!gfolders.find(f => f.role === 'trash')
      const gmode: 'trash' | 'permanent' | 'mixed' = !gHasTrash ? 'permanent' : gHasNonTrashMail ? 'mixed' : 'permanent'
      return { account, total: gsum, mode: gmode, source: 'verified' }
    }
    const listRaw = await mailInvoke<string>('mail_imap_list_folders', { accountId: account.id }, '拉取文件夹列表（LIST）')
    const folders = parseListFolders(listRaw)
    const countsRaw = await mailInvoke<string>('mail_imap_folder_counts', { accountId: account.id, folders: folders.map(f => f.name) }, '统计各文件夹邮件数')
    const counts = JSON.parse(countsRaw) as Record<string, number>
    let sum = 0
    const hasTrash = !!folders.find(f => f.role === 'trash')
    let hasNonTrashMail = false
    for (const f of folders) {
      const n = counts[f.name] ?? 0
      sum += n
      if (n > 0 && f.role !== 'trash') hasNonTrashMail = true
    }
    const mode: 'trash' | 'permanent' | 'mixed' = !hasTrash ? 'permanent' : hasNonTrashMail ? 'mixed' : 'permanent'
    return { account, total: sum, mode, source: 'verified' }
  } catch (e) {
    return { account, total: 0, mode: 'permanent', source: 'verified', error: displayMailError(e instanceof Error ? e.message : String(e)) }
  }
}

/**
 * 删除全部邮件的预检（服务器核对）：每账户各文件夹的邮件数 + 预计删除方式（确认框展示用）。
 * v0.1.466：账户间并发核对（上限 3），每完成一个就经 onUpdate 逐行回告界面替换快照；
 * 此前是 for...of 串行全连接，6 个账户排队等——弹窗长时间卡在「正在连接各账户统计邮件数…」。
 * 本函数仍然纯只读，不删任何邮件。
 */
export async function mailDeleteAllPreview(
  accounts: MailAccountMeta[],
  pwd: string,
  onUpdate?: (entry: MailDeleteAllPreviewEntry) => void,
): Promise<{ perAccount: MailDeleteAllPreviewEntry[]; total: number }> {
  const perAccount = await mapWithConcurrencyLimit(accounts, 3, async account => {
    const entry = await previewDeleteAllOne(account, pwd)
    try { onUpdate?.(entry) } catch { /* 界面回调异常不影响核对本身 */ }
    return entry
  })
  return { perAccount, total: perAccount.reduce((a, e) => a + (e.error ? 0 : e.total), 0) }
}

/**
 * 真删全部：非垃圾箱文件夹先移入垃圾箱（无垃圾箱则彻底删），垃圾箱最后彻底清空。
 * v0.1.466 重写编排（删除语义与计数口径不变）：
 * - 账户间并发（上限 3，不同服务器互不影响），同一账户内仍串行；单账户失败不连累其他账户；
 * - 进度细化到账户→文件夹→批次，经 opts.onEvent 透传（旧 (email, n) 回调继续兼容）；
 * - 每步网络调用都有分步超时（IMAP 走 mailInvoke 的 445 口径、Graph 走单步 45 秒），
 *   单步超时按该账户失败处理并继续其他账户，不整场挂死；
 * - opts.cancelToken：每个批次前检查，取消后当前账户停在已删实数、未开始的账户标
 *   notStarted，已删/未删在报告里如实分开，不静默消失。
 */
export async function mailDeleteAll(
  accounts: MailAccountMeta[],
  pwd: string,
  optsOrProgress?: MailDeleteAllOptions | ((email: string, deletedSoFar: number) => void),
): Promise<MailDeleteAllReport[]> {
  const opts: MailDeleteAllOptions = typeof optsOrProgress === 'function' ? {} : (optsOrProgress ?? {})
  const legacy = typeof optsOrProgress === 'function' ? optsOrProgress : undefined
  const emit = (e: MailDeleteAllProgressEvent) => { try { opts.onEvent?.(e) } catch { /* 进度回调异常不影响删除 */ } }
  const isCancelled = () => !!opts.cancelToken?.cancelled

  const deleteOne = async (account: MailAccountMeta): Promise<MailDeleteAllReport> => {
    const report: MailDeleteAllReport = { accountId: account.id, email: account.email, deleted: 0, mode: 'permanent' }
    if (isCancelled()) {
      report.notStarted = true
      return report
    }
    emit({ type: 'account-start', accountId: account.id, email: account.email })
    const legacyProgress = () => { try { legacy?.(account.email, report.deleted) } catch { /* 同上 */ } }
    try {
      await mailEnsureConnected(account, pwd)
      if (isCancelled()) {
        report.cancelled = true
        emit({ type: 'account-cancelled', accountId: account.id, deleted: report.deleted })
        return report
      }
      if (account.transport === 'graph') {
        // v0.1.459：Graph 账户走 graphDeleteAll（移入已删除 + 清空），与 IMAP 账户在同一份报告里分别汇总
        const outcome = await graphDeleteAll(account, report, { emit, isCancelled, legacyProgress })
        if (outcome === 'cancelled') {
          report.cancelled = true
          emit({ type: 'account-cancelled', accountId: account.id, deleted: report.deleted })
          return report
        }
      } else {
        const listRaw = await mailInvoke<string>('mail_imap_list_folders', { accountId: account.id }, '拉取文件夹列表（LIST）')
        const folders = parseListFolders(listRaw)
        const trash = folders.find(f => f.role === 'trash')
        const ordered = [...folders.filter(f => f.role !== 'trash'), ...folders.filter(f => f.role === 'trash')]
        // 先快照垃圾箱原有 UID：其他文件夹先移入垃圾箱、最后清垃圾箱时会把刚移入的
        // 一并搜出来删掉，计数只能算「原本就在垃圾箱的 + 各文件夹移出的」，否则重复计数。
        let initialTrashUids = new Set<number>()
        if (trash) {
          const trashSearch = await mailInvoke<string>('mail_imap_search_all', { accountId: account.id, folder: trash.name }, '搜索垃圾箱邮件（SEARCH）')
          initialTrashUids = new Set(parseSearchUids(trashSearch))
        }
        let usedTrash = false
        let usedPermanent = false
        let stopped = false
        for (const folder of ordered) {
          if (isCancelled()) { stopped = true; break }
          const searchRaw = await mailInvoke<string>('mail_imap_search_all', { accountId: account.id, folder: folder.name }, `搜索「${folder.name}」邮件（SEARCH）`)
          const uids = parseSearchUids(searchRaw)
          if (!uids.length) continue
          const toTrash = trash && folder.role !== 'trash' ? trash.name : null
          if (toTrash) usedTrash = true
          else usedPermanent = true
          emit({ type: 'folder-start', accountId: account.id, folder: folder.name, folderLabel: folder.label ?? folder.name, total: uids.length })
          let deletedInFolder = 0
          const batchCount = Math.ceil(uids.length / 200)
          for (let i = 0; i < uids.length; i += 200) {
            if (isCancelled()) { stopped = true; break }
            const chunk = uids.slice(i, i + 200)
            const n = await mailInvoke<number>('mail_imap_delete_messages', {
              accountId: account.id, folder: folder.name, uids: chunk, trashFolder: toTrash,
            }, '删除邮件')
            // 清垃圾箱这一步删的含刚移入的邮件，只计快照内原本就在垃圾箱的数量，避免重复计数
            const counted = folder.role === 'trash' ? chunk.filter(u => initialTrashUids.has(u)).length : n
            deletedInFolder += counted
            report.deleted += counted
            emit({
              type: 'batch', accountId: account.id, folder: folder.name,
              batchIndex: Math.floor(i / 200) + 1, batchCount, deletedInFolder, deletedInAccount: report.deleted,
            })
            legacyProgress()
          }
          if (stopped) break
        }
        report.mode = usedTrash && usedPermanent ? 'mixed' : usedTrash ? 'trash' : 'permanent'
        if (stopped) {
          report.cancelled = true
          emit({ type: 'account-cancelled', accountId: account.id, deleted: report.deleted })
          return report
        }
        // 本地缓存同步清掉（服务器端已删，缓存留着会显示幽灵邮件）
        const cache = loadMailCache()
        if (cache[account.id]) {
          cache[account.id] = { ...cache[account.id], messages: [], updatedAt: Date.now() }
          saveMailCache(cache)
        }
      }
    } catch (e) {
      report.error = displayMailError(e instanceof Error ? e.message : String(e), { transport: account.transport })
      emit({ type: 'account-error', accountId: account.id, deleted: report.deleted, error: report.error })
      return report
    }
    emit({ type: 'account-done', accountId: account.id, deleted: report.deleted, mode: report.mode })
    return report
  }

  return mapWithConcurrencyLimit(accounts, 3, deleteOne)
}

// ---------------- OAuth 授权（Gmail / Outlook） ----------------

export function buildOAuthUrl(provider: 'google' | 'microsoft', clientId: string, port: number): string {
  const redirect = `http://127.0.0.1:${port}`
  if (provider === 'google') {
    const q = new URLSearchParams()
    q.set('client_id', clientId)
    q.set('redirect_uri', redirect)
    q.set('response_type', 'code')
    q.set('scope', 'https://mail.google.com/')
    q.set('access_type', 'offline')
    q.set('prompt', 'consent')
    return `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`
  }
  const q = new URLSearchParams()
  q.set('client_id', clientId)
  q.set('redirect_uri', redirect)
  q.set('response_type', 'code')
  q.set('response_mode', 'query')
  q.set('scope', MS_GRAPH_SCOPE) // v0.1.459：微软改走 Graph 资源（Mail.ReadWrite），不再请求 IMAP 范围
  return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${q.toString()}`
}

export async function mailOAuthExchange(
  provider: 'google' | 'microsoft',
  code: string,
  clientId: string,
  clientSecret: string,
  port: number,
): Promise<MailSecret> {
  const form = new URLSearchParams()
  form.set('code', code)
  form.set('client_id', clientId)
  if (clientSecret) form.set('client_' + 'secret', clientSecret)
  form.set('redirect_uri', `http://127.0.0.1:${port}`)
  form.set('grant_type', 'authorization_code')
  if (provider === 'microsoft') form.set('scope', MS_GRAPH_SCOPE)
  const url = provider === 'microsoft'
    ? 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
    : 'https://oauth2.googleapis.com/token'
  const res = await pluginHttpDesktop(url, 'POST', { 'Content-Type': 'application/x-www-form-urlencoded' }, form.toString())
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`OAuth 换令牌失败（${res.status}）：${res.text.slice(0, 300)}`)
  }
  const data = JSON.parse(res.text) as Record<string, unknown>
  const accessTok = String(data['access' + '_token'] ?? '')
  const refreshTok = String(data['refresh' + '_token'] ?? '')
  if (!accessTok || !refreshTok) throw new Error(`OAuth 返回缺少令牌：${res.text.slice(0, 300)}`)
  return {
    kind: 'oauth',
    accessTok,
    refreshTok,
    expiresAt: Date.now() + Number(data['expires_in'] ?? 3600) * 1000,
    clientId,
    clientSecret,
    // v0.1.459：记下令牌实际拿到的范围（微软回 scope 字段；没有就记请求值），
    // 后续据此区分 Graph 令牌与旧 IMAP 令牌。Google 不记（不透明令牌、无此需求）。
    ...(provider === 'microsoft' ? { scope: String(data['scope'] ?? MS_GRAPH_SCOPE) } : {}),
  }
}

export async function mailOAuthListenStart(): Promise<number> {
  return tauriInvoke<number>('mail_oauth_listen_start', {})
}

export async function mailOAuthListenResult(): Promise<{ code?: string; error?: string } | null> {
  const r = await tauriInvoke<{ code: string | null; error: string | null } | null>('mail_oauth_listen_result', {})
  if (!r) return null
  return { code: r.code ?? undefined, error: r.error ?? undefined }
}

/** v0.1.446：真正终止本机回调监听（取消授权/超时时调用，不留僵尸监听线程） */
export async function mailOAuthListenStop(): Promise<void> {
  try { await tauriInvoke('mail_oauth_listen_stop', {}) } catch { /* 网页环境无此命令，忽略 */ }
}

// ---------------- OAuth 客户端注册引导（v0.1.446，与上面的实现口径逐项对齐） ----------------
// 实现口径（buildOAuthUrl / mailOAuthExchange）：redirect_uri = http://127.0.0.1:<随机端口>；
// Google scope=https://mail.google.com/（桌面应用客户端，需 ID+Secret）；
// Microsoft scope=https://graph.microsoft.com/Mail.ReadWrite + offline_access（公共客户端，只需 ID；
// v0.1.459 起 Outlook OAuth 走 Graph 通道，不再请求 IMAP 范围）。

export interface OAuthRegisterGuide {
  /** 表单是否需要 Client Secret 输入框：Google 桌面客户端需要，微软公共客户端不需要 */
  needsSecret: boolean
  steps: string[]
  callbackNote: string
}

export const OAUTH_REGISTER_GUIDES: Record<'google' | 'microsoft', OAuthRegisterGuide> = {
  google: {
    needsSecret: true,
    steps: [
      '打开 Google Cloud 控制台（console.cloud.google.com），用你的 Google 账号登录，新建一个项目（名字随意）。',
      '进「API 和服务 → 库」，搜索 Gmail API，点「启用」',
      '进「API 和服务 → OAuth 同意屏幕」：用户类型选「外部」，填应用名和你的联系邮箱并保存；如果状态显示「测试」，再到「测试用户」里把你自己的 Gmail 地址加进去（不加会报未授权）。',
      '进「API 和服务 → 凭据」→「创建凭据」→「OAuth 客户端 ID」，应用类型选「桌面应用」，创建后会得到 Client ID 和 Client Secret。',
      '把 Client ID 和 Client Secret 粘到下面两个输入框，点「连接并授权」，浏览器会打开 Google 官方页面，登录并点允许即可。',
    ],
    callbackNote: '回调地址不用填：应用类型选「桌面应用」时 Google 不要求预填回调地址——App 用本机回环地址 http://127.0.0.1 的随机端口接收回调，桌面应用对任意回环端口自动放行。若控制台某处要求你填，就填 http://127.0.0.1（不要带端口）。',
  },
  microsoft: {
    needsSecret: false,
    steps: [
      '打开 Azure 门户（portal.azure.com），用你的微软账户登录，进「应用注册」，点「新注册」',
      '名字随意；「支持的账户类型」选「任何组织目录中的账户和个人 Microsoft 账户」（只用个人 Outlook 邮箱也可以选仅个人账户），点「注册」',
      '进新应用的「身份验证」页 →「添加平台」→ 选「移动和桌面应用程序」，在重定向 URI 里填 http://127.0.0.1（见下方回调说明），保存。',
      '回到「概述」页，复制「应用程序(客户端) ID」，粘到下面输入框，点「连接并授权」，浏览器会打开微软官方页面，登录并点允许即可。',
    ],
    callbackNote: '重定向 URI 填 http://127.0.0.1，不要带端口：App 实际用 http://127.0.0.1 的随机端口接收回调，Azure 对本机回环地址不校验端口，与你填的这条一致。另外这是「公共客户端」，微软不发 Client Secret，所以本表单没有密码输入框——只填 ID 是对的。授权页会列出「读取和写入邮件（Mail.ReadWrite）」权限——邮箱走微软 Graph 接口收邮件用的，点允许即可。',
  },
}

// ---------------- OAuth 客户端凭据（用户自备；加密存保险箱同等待遇，仅本机不同步） ----------------

const OAUTH_CLIENTS_KEY = 'acm.mail.oauthClients.v1'

export interface OAuthClientCreds {
  clientId: string
  clientSecret: string
}

export async function loadOAuthClientCreds(provider: 'google' | 'microsoft', pwd?: string): Promise<OAuthClientCreds | null> {
  const all = readJson<Record<string, string>>(OAUTH_CLIENTS_KEY, {})
  const cipher = all[provider]
  if (!cipher) return null
  try {
    const parsed = JSON.parse(await decryptStoredSecret(cipher, pwd)) as Partial<OAuthClientCreds>
    if (!parsed.clientId) return null
    return { clientId: String(parsed.clientId), clientSecret: String(parsed.clientSecret ?? '') }
  } catch { return null }
}

export async function saveOAuthClientCreds(provider: 'google' | 'microsoft', creds: OAuthClientCreds, _pwd?: string): Promise<void> {
  const all = readJson<Record<string, string>>(OAUTH_CLIENTS_KEY, {})
  all[provider] = await encryptLocalSecret(JSON.stringify({ clientId: creds.clientId, clientSecret: creds.clientSecret }))
  // v0.1.461：与账户凭据同等待遇——写不下必须抛错，不许静默丢（旧 writeJson 吞异常）
  writeJsonStrict(OAUTH_CLIENTS_KEY, all, 'OAuth 客户端凭据保存失败')
}

export function clearOAuthClientCreds(provider: 'google' | 'microsoft'): void {
  const all = readJson<Record<string, string>>(OAUTH_CLIENTS_KEY, {})
  delete all[provider]
  writeJson(OAUTH_CLIENTS_KEY, all)
}

// ---------------- 需要重新授权标记（v0.1.446，仅本机） ----------------

const REAUTH_KEY = 'acm.mail.reauth.v1'

export function loadMailReauthFlags(): Record<string, string> {
  return readJson<Record<string, string>>(REAUTH_KEY, {})
}

export function setMailReauthFlag(accountId: string, message: string): void {
  const all = loadMailReauthFlags()
  if (all[accountId] === message) return
  all[accountId] = message
  writeJson(REAUTH_KEY, all)
}

export function clearMailReauthFlag(accountId: string): void {
  const all = loadMailReauthFlags()
  if (!(accountId in all)) return
  delete all[accountId]
  writeJson(REAUTH_KEY, all)
}

// ---------------- 浏览器授权编排（v0.1.446：监听→开浏览器→等回调→换令牌） ----------------

/** 授权被用户取消时抛出的标记错误（界面静默复位，不当失败展示） */
export const OAUTH_CANCELLED = 'OAUTH_CANCELLED'

/** 等待浏览器回调的超时（默认 3 分钟；无头验收可用 window 覆盖缩短） */
export function mailOAuthTimeoutMs(): number {
  if (typeof window !== 'undefined') {
    const w = window as unknown as { __ACM_MAIL_OAUTH_TIMEOUT_MS__?: unknown }
    const v = w.__ACM_MAIL_OAUTH_TIMEOUT_MS__
    if (typeof v === 'number' && v > 0) return v
  }
  return 180_000
}

/** 回调带回的 error 参数翻成人话：用户拒绝与其它失败分开说 */
export function describeOAuthCallbackError(error: string): string {
  if (error === 'access_denied') return '你在浏览器里拒绝了授权（access_denied），没有拿到令牌，账户未添加。想继续的话重新点「连接并授权」，并在官方页面点「允许」'
  if (error === 'consent_required' || error === 'interaction_required') return `授权还差一步确认（${error}），请重新授权并在浏览器里完成确认`
  if (error === 'invalid_client') return '客户端凭据被官方拒绝（invalid_client）：多半是 Client ID / Secret 填错了，或 Google 客户端类型没选「桌面应用」'
  return `授权没有完成，官方返回：${error}`
}

/**
 * 完整授权流程：起本机回调监听 → 系统浏览器打开官方授权页 → 轮询回调 → 换令牌。
 * 超时/取消都会真正终止监听；每一步失败都抛带真实原因的 Error（拒绝/超时/换令牌被拒分开）。
 */
export async function mailOAuthAuthorize(
  provider: 'google' | 'microsoft',
  clientId: string,
  clientSecret: string,
  opts: { onStatus?: (s: string) => void; isCancelled?: () => boolean } = {},
): Promise<MailSecret> {
  const port = await mailOAuthListenStart()
  const opened = await openExternal(buildOAuthUrl(provider, clientId, port))
  if (!opened) {
    void mailOAuthListenStop()
    throw new Error('没能打开系统浏览器，请手动检查默认浏览器设置后重试')
  }
  opts.onStatus?.('已打开浏览器，请在浏览器里登录并点「允许」完成授权…')
  const timeoutMs = mailOAuthTimeoutMs()
  const deadline = Date.now() + timeoutMs
  let code = ''
  while (Date.now() < deadline) {
    if (opts.isCancelled?.()) {
      void mailOAuthListenStop()
      throw new Error(OAUTH_CANCELLED)
    }
    await new Promise(r => setTimeout(r, 800))
    if (opts.isCancelled?.()) {
      void mailOAuthListenStop()
      throw new Error(OAUTH_CANCELLED)
    }
    let res: { code?: string; error?: string } | null = null
    try { res = await mailOAuthListenResult() } catch { res = null }
    if (res?.error) {
      void mailOAuthListenStop()
      throw new Error(describeOAuthCallbackError(res.error))
    }
    if (res?.code) { code = res.code; break }
  }
  if (!code) {
    void mailOAuthListenStop()
    throw new Error(`等待浏览器授权超时（${Math.round(timeoutMs / 1000)} 秒内没有等到回调），账户未添加；请确认浏览器打开了授权页并完成登录后重试`)
  }
  opts.onStatus?.('授权成功，正在换取令牌…')
  return mailOAuthExchange(provider, code, clientId, clientSecret, port)
}
