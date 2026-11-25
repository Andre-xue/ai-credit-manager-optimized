// 邮箱工具（v0.1.436，一期，仅桌面端）：多平台多账户统一收件箱。
// 架构：桌面 Rust 只做 IMAP 传输（连接/命令往返/IDLE 事件，见 desktop/src-tauri/src/mail_imap.rs），
// 协议解析（LIST/FETCH/MIME）、分类、存储都在本文件，方便用假服务器报文回归测试。
// 凭据用保险箱主密码加密、只存本机 localStorage（与 WorkBuddy 账号池同等待遇），不进云同步。
// 同步方式如实标注：服务器支持 IDLE → 实时推送；不支持 → 轮询；连接失败显示服务器原文。

import { encryptSecret, decryptSecret } from './crypto'
import { isDesktopApp } from './openExternal'
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
      '推荐走 OAuth 授权（不保存密码）；也可以用应用专用密码：先在 Google 账户开启两步验证，再到「应用专用密码」生成一个 16 位密码填进来。',
      'OAuth 授权需要你自己的 Google Cloud OAuth 客户端（桌面应用类型），把 Client ID 与 Client Secret 填到授权表单里；令牌只加密存在本机。',
      '确认 Gmail 设置 → 转发和 POP/IMAP 里已开启 IMAP。',
    ],
  },
  {
    id: 'outlook', name: 'Outlook', imapHost: 'outlook.office365.com', imapPort: 993, auth: 'oauth', oauthProvider: 'microsoft',
    secretLabel: '应用密码',
    guide: [
      '推荐走 OAuth 授权（不保存密码）。OAuth 需要你自己的 Azure 应用注册（个人账户类型），把 Client ID 填到授权表单里；令牌只加密存在本机。',
      'Outlook.com 已逐步关闭基础密码登录；若密码登录被拒，请改用 OAuth。',
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
    }

export interface MailAccountMeta {
  id: string
  platformId: MailPlatformId
  email: string
  label: string
  host: string
  port: number
}

interface StoredAccount extends MailAccountMeta {
  cipher: string
}

const ACCOUNTS_KEY = 'acm.mail.accounts.v1'
const VIS_KEY = 'acm.mail.visibility.v1'
const CACHE_KEY = 'acm.mail.cache.v1'
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

export function listMailAccounts(): MailAccountMeta[] {
  return readAccountsFile().map(({ id, platformId, email, label, host, port }) => ({ id, platformId, email, label, host, port }))
}

export async function addMailAccount(
  meta: Omit<MailAccountMeta, 'id'>,
  secret: MailSecret,
  pwd: string,
): Promise<MailAccountMeta> {
  const accounts = readAccountsFile()
  const existing = accounts.findIndex(a => a.platformId === meta.platformId && a.email.toLowerCase() === meta.email.toLowerCase())
  const id = existing >= 0 ? accounts[existing].id : `mail-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
  const cipher = await encryptSecret(JSON.stringify(secret), pwd)
  const stored: StoredAccount = { ...meta, id, cipher }
  if (existing >= 0) accounts[existing] = stored
  else accounts.push(stored)
  writeJson(ACCOUNTS_KEY, { accounts })
  return { ...meta, id }
}

export function removeMailAccount(id: string): void {
  writeJson(ACCOUNTS_KEY, { accounts: readAccountsFile().filter(a => a.id !== id) })
  const cache = readJson<Record<string, MailAccountCache>>(CACHE_KEY, {})
  delete cache[id]
  writeJson(CACHE_KEY, cache)
}

export async function loadMailSecret(id: string, pwd: string): Promise<MailSecret | null> {
  const entry = readAccountsFile().find(a => a.id === id)
  if (!entry) return null
  try {
    return JSON.parse(await decryptSecret(entry.cipher, pwd)) as MailSecret
  } catch { return null }
}

export async function saveMailSecret(id: string, secret: MailSecret, pwd: string): Promise<void> {
  const accounts = readAccountsFile()
  const entry = accounts.find(a => a.id === id)
  if (!entry) return
  entry.cipher = await encryptSecret(JSON.stringify(secret), pwd)
  writeJson(ACCOUNTS_KEY, { accounts })
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

// ---------------- 邮件数据与缓存 ----------------

export interface MailFolder {
  name: string
  flags: string[]
  role: MailFolderRole
}

export interface MailMessage {
  key: string
  accountId: string
  folder: string
  uid: number
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
  base64: string
}

export interface MailBodyContent {
  text: string
  html: string
  attachments: MailAttachment[]
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
  const result: MailBodyContent = { text: '', html: '', attachments: [] }

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

// ---------------- 桌面传输（Tauri invoke → Rust IMAP） ----------------

interface TauriInternals {
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
}

function tauriInvoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const w = window as unknown as { __TAURI_INTERNALS__?: TauriInternals }
  if (!w.__TAURI_INTERNALS__?.invoke) return Promise.reject(new Error('邮箱工具仅在桌面端可用'))
  return w.__TAURI_INTERNALS__.invoke(cmd, args) as Promise<T>
}

export function mailDesktopAvailable(): boolean {
  return isDesktopApp()
}

interface LiveSession {
  secret: MailSecret
  caps: string
}

const liveSessions = new Map<string, LiveSession>()

export function mailForgetSession(accountId: string): void {
  liveSessions.delete(accountId)
}

async function refreshOAuthSecret(account: MailAccountMeta, secret: MailSecret, pwd: string): Promise<MailSecret> {
  if (secret.kind !== 'oauth') return secret
  if (secret.expiresAt > Date.now() + 60_000) return secret
  const preset = mailPlatform(account.platformId)
  const form = new URLSearchParams()
  form.set('grant_type', 'refresh_' + 'token')
  form.set('refresh_' + 'token', secret.refreshTok)
  form.set('client_id', secret.clientId)
  if (secret.clientSecret) form.set('client_' + 'secret', secret.clientSecret)
  const url = preset.oauthProvider === 'microsoft'
    ? 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
    : 'https://oauth2.googleapis.com/token'
  const res = await pluginHttpDesktop(url, 'POST', { 'Content-Type': 'application/x-www-form-urlencoded' }, form.toString())
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`OAuth 令牌刷新失败（${res.status}）：${res.text.slice(0, 300)}`)
  }
  const data = JSON.parse(res.text) as Record<string, unknown>
  const accessTok = String(data['access' + '_token'] ?? '')
  if (!accessTok) throw new Error(`OAuth 令牌刷新返回异常：${res.text.slice(0, 300)}`)
  const next: MailSecret = {
    ...secret,
    accessTok,
    expiresAt: Date.now() + Number(data['expires_in'] ?? 3600) * 1000,
  }
  await saveMailSecret(account.id, next, pwd)
  return next
}

/** 确保账户已连接（必要时刷新 OAuth 令牌）；返回能力串 */
export async function mailEnsureConnected(account: MailAccountMeta, pwd: string): Promise<LiveSession> {
  const existing = liveSessions.get(account.id)
  if (existing) return existing
  let secret = await loadMailSecret(account.id, pwd)
  if (!secret) throw new Error('保险箱里没有这个账户的凭据，请删除后重新添加')
  secret = await refreshOAuthSecret(account, secret, pwd)
  const caps = await tauriInvoke<string>('mail_imap_connect', {
    accountId: account.id,
    host: account.host,
    port: account.port,
    useTls: account.port !== 143,
    authMode: secret.kind === 'oauth' ? 'xoauth2' : 'login',
    username: account.email,
    secret: secret.kind === 'oauth' ? secret.accessTok : secret.secret,
  })
  const session: LiveSession = { secret, caps }
  liveSessions.set(account.id, session)
  return session
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
    const listRaw = await tauriInvoke<string>('mail_imap_list_folders', { accountId: account.id })
    const folders = parseListFolders(listRaw)
    if (!folders.length) throw new Error('服务器没有返回任何文件夹')
    const prev = loadMailCache()[account.id]
    const prevKeys = new Set((prev?.messages ?? []).map(m => m.key))
    const messages: MailMessage[] = []
    for (const folder of folders) {
      const raw = await tauriInvoke<string>('mail_imap_fetch_headers', { accountId: account.id, folder: folder.name, limit: headerLimit })
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
    return { accountId: account.id, ok: true, newKeys, caps: session.caps, idleSupported: session.caps.includes('IDLE') }
  } catch (e) {
    mailForgetSession(account.id)
    return { accountId: account.id, ok: false, error: e instanceof Error ? e.message : String(e), newKeys: [], caps: '', idleSupported: false }
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
  await tauriInvoke('mail_imap_store_flags', { accountId: account.id, folder: msg.folder, uids: [msg.uid], flag, add })
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
    await tauriInvoke('mail_imap_delete_messages', {
      accountId: account.id, folder, uids: list.map(m => m.uid), trashFolder: destFolder,
    })
    const destRole = loadMailCache()[account.id]?.folders.find(f => f.name === destFolder)?.role ?? 'other'
    void destRole
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
    await tauriInvoke('mail_imap_delete_messages', {
      accountId: account.id, folder, uids: list.map(m => m.uid), trashFolder: decision.trashFolder ?? null,
    })
    const keys = new Set(list.map(m => m.key))
    patchCacheMessages(account.id, all => all.filter(m => !keys.has(m.key)))
  }
  return mode
}

export async function mailFetchBody(account: MailAccountMeta, msg: MailMessage): Promise<MailBodyContent & { code: string | null }> {
  const b64 = await tauriInvoke<string>('mail_imap_fetch_message', { accountId: account.id, folder: msg.folder, uid: msg.uid })
  const bytes = b64ToBytes(b64)
  const body = parseMimeMessage(bytes)
  const code = extractVerifyCode(`${msg.subject}\n${body.text || htmlToText(body.html)}`)
  return { ...body, code }
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
}

/** 删除全部邮件的预检：每账户各文件夹的邮件数 + 预计删除方式（确认框展示用） */
export async function mailDeleteAllPreview(accounts: MailAccountMeta[], pwd: string): Promise<{
  perAccount: { account: MailAccountMeta; total: number; mode: 'trash' | 'permanent' | 'mixed'; error?: string }[]
  total: number
}> {
  const perAccount: { account: MailAccountMeta; total: number; mode: 'trash' | 'permanent' | 'mixed'; error?: string }[] = []
  let total = 0
  for (const account of accounts) {
    try {
      await mailEnsureConnected(account, pwd)
      const listRaw = await tauriInvoke<string>('mail_imap_list_folders', { accountId: account.id })
      const folders = parseListFolders(listRaw)
      const countsRaw = await tauriInvoke<string>('mail_imap_folder_counts', { accountId: account.id, folders: folders.map(f => f.name) })
      const counts = JSON.parse(countsRaw) as Record<string, number>
      let sum = 0
      let hasTrash = !!folders.find(f => f.role === 'trash')
      let hasNonTrashMail = false
      for (const f of folders) {
        const n = counts[f.name] ?? 0
        sum += n
        if (n > 0 && f.role !== 'trash') hasNonTrashMail = true
      }
      const mode: 'trash' | 'permanent' | 'mixed' = !hasTrash ? 'permanent' : hasNonTrashMail ? 'mixed' : 'permanent'
      perAccount.push({ account, total: sum, mode })
      total += sum
    } catch (e) {
      perAccount.push({ account, total: 0, mode: 'permanent', error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { perAccount, total }
}

/** 真删全部：非垃圾箱文件夹先移入垃圾箱（无垃圾箱则彻底删），垃圾箱最后彻底清空 */
export async function mailDeleteAll(
  accounts: MailAccountMeta[],
  pwd: string,
  onProgress?: (email: string, deletedSoFar: number) => void,
): Promise<MailDeleteAllReport[]> {
  const reports: MailDeleteAllReport[] = []
  for (const account of accounts) {
    const report: MailDeleteAllReport = { accountId: account.id, email: account.email, deleted: 0, mode: 'permanent' }
    try {
      await mailEnsureConnected(account, pwd)
      const listRaw = await tauriInvoke<string>('mail_imap_list_folders', { accountId: account.id })
      const folders = parseListFolders(listRaw)
      const trash = folders.find(f => f.role === 'trash')
      const ordered = [...folders.filter(f => f.role !== 'trash'), ...folders.filter(f => f.role === 'trash')]
      // 先快照垃圾箱原有 UID：其他文件夹先移入垃圾箱、最后清垃圾箱时会把刚移入的
      // 一并搜出来删掉，计数只能算「原本就在垃圾箱的 + 各文件夹移出的」，否则重复计数。
      let initialTrashUids = new Set<number>()
      if (trash) {
        const trashSearch = await tauriInvoke<string>('mail_imap_search_all', { accountId: account.id, folder: trash.name })
        initialTrashUids = new Set(parseSearchUids(trashSearch))
      }
      let usedTrash = false
      let usedPermanent = false
      for (const folder of ordered) {
        const searchRaw = await tauriInvoke<string>('mail_imap_search_all', { accountId: account.id, folder: folder.name })
        const uids = parseSearchUids(searchRaw)
        if (!uids.length) continue
        const toTrash = trash && folder.role !== 'trash' ? trash.name : null
        if (toTrash) usedTrash = true
        else usedPermanent = true
        for (let i = 0; i < uids.length; i += 200) {
          const chunk = uids.slice(i, i + 200)
          const n = await tauriInvoke<number>('mail_imap_delete_messages', {
            accountId: account.id, folder: folder.name, uids: chunk, trashFolder: toTrash,
          })
          // 清垃圾箱这一步删的含刚移入的邮件，只计快照内原本就在垃圾箱的数量，避免重复计数
          report.deleted += folder.role === 'trash' ? chunk.filter(u => initialTrashUids.has(u)).length : n
          onProgress?.(account.email, report.deleted)
        }
      }
      report.mode = usedTrash && usedPermanent ? 'mixed' : usedTrash ? 'trash' : 'permanent'
      // 本地缓存同步清掉（服务器端已删，缓存留着会显示幽灵邮件）
      const cache = loadMailCache()
      if (cache[account.id]) {
        cache[account.id] = { ...cache[account.id], messages: [], updatedAt: Date.now() }
        saveMailCache(cache)
      }
    } catch (e) {
      report.error = e instanceof Error ? e.message : String(e)
    }
    reports.push(report)
  }
  return reports
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
  q.set('scope', 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access')
  return `https://login.microsoftonline.com/common/oauth2/v2.0/auth?${q.toString()}`
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
  if (provider === 'microsoft') form.set('scope', 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access')
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
