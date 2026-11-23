import { encryptSecret, decryptSecret } from './crypto'

/**
 * 通用「令牌类」签到平台的多账号存储（v0.1.367）：
 * 豆包 / 灵犀 / DuMate / 小浣熊 / 天翼 AI / Qoder 等平台的凭据都是用户粘贴的
 * Cookie / Token / PAT 字符串，统一按平台分开存：每个账号一条，secret 用保险箱
 * 主密码单独加密，只存本机不云同步（与 WorkBuddy / MiniMax 池同款）。
 */

const KEY = 'acm.tokenpool.v1'

export interface TokenAccountMeta { id: string; label: string }
interface TokenEntry extends TokenAccountMeta { cipher: string }
type TokenFile = Partial<Record<string, TokenEntry[]>>

function readFile(): TokenFile {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as TokenFile
    return v && typeof v === 'object' ? v : {}
  } catch { return {} }
}

function writeFile(f: TokenFile): void {
  try { localStorage.setItem(KEY, JSON.stringify(f)) } catch { /* 忽略 */ }
}

export function listTokenMeta(platform: string): TokenAccountMeta[] {
  return (readFile()[platform] ?? []).map(({ id, label }) => ({ id, label }))
}

export function hasTokenAccounts(platform: string): boolean {
  return (readFile()[platform] ?? []).length > 0
}

export function hasAnyTokenAccounts(): boolean {
  return Object.values(readFile()).some(list => (list ?? []).length > 0)
}

export async function addTokenAccount(platform: string, label: string, secret: string, pwd: string): Promise<TokenAccountMeta> {
  const f = readFile()
  const list = f[platform] ?? []
  const id = `tk-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
  const meta: TokenAccountMeta = { id, label: label.trim() || '未命名账号' }
  list.push({ ...meta, cipher: await encryptSecret(secret.trim(), pwd) })
  f[platform] = list
  writeFile(f)
  return meta
}

export function removeTokenAccount(platform: string, id: string): void {
  const f = readFile()
  f[platform] = (f[platform] ?? []).filter(a => a.id !== id)
  writeFile(f)
}

export async function loadTokenSecret(platform: string, id: string, pwd: string): Promise<string | null> {
  const entry = (readFile()[platform] ?? []).find(a => a.id === id)
  if (!entry || !pwd) return null
  try {
    const secret = await decryptSecret(entry.cipher, pwd)
    return secret ? secret : null
  } catch { return null }
}
