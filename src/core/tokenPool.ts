import { encryptSecret, decryptSecret } from './crypto'
import { encryptLocalSecret, decryptStoredSecret, isLegacyCipher, migrateCipherValue } from './deviceKey'
import { TOKEN_PLATFORM_IDS } from './checkinPlatforms'

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

export async function addTokenAccount(platform: string, label: string, secret: string, _pwd?: string): Promise<TokenAccountMeta> {
  const f = readFile()
  const list = f[platform] ?? []
  const id = `tk-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
  const meta: TokenAccountMeta = { id, label: label.trim() || '未命名账号' }
  list.push({ ...meta, cipher: await encryptLocalSecret(secret.trim()) })
  f[platform] = list
  writeFile(f)
  return meta
}

export function removeTokenAccount(platform: string, id: string): void {
  const f = readFile()
  f[platform] = (f[platform] ?? []).filter(a => a.id !== id)
  writeFile(f)
}

export async function loadTokenSecret(platform: string, id: string, pwd?: string): Promise<string | null> {
  const entry = (readFile()[platform] ?? []).find(a => a.id === id)
  if (!entry) return null
  try {
    const secret = await decryptStoredSecret(entry.cipher, pwd)
    if (!secret) return null
    if (isLegacyCipher(entry.cipher)) {
      const f = readFile()
      const e2 = (f[platform] ?? []).find(a => a.id === id)
      if (e2) { e2.cipher = await encryptLocalSecret(secret); writeFile(f) }
    }
    return secret
  } catch { return null }
}

/** 还有几份旧格式密文没迁（v0.1.470 迁移审计用） */
export function countLegacyTokenCreds(): number {
  return Object.values(readFile()).reduce((n, list) => n + (list ?? []).filter(a => isLegacyCipher(a.cipher)).length, 0)
}

/** 把全部平台的旧格式密文批量迁成本地密文；返回成功迁移数（幂等） */
export async function migrateTokenCreds(pwd: string): Promise<number> {
  const f = readFile()
  let n = 0
  for (const list of Object.values(f)) {
    for (const a of list ?? []) {
      if (!isLegacyCipher(a.cipher)) continue
      try {
        const next = await migrateCipherValue(a.cipher, pwd)
        if (next) { a.cipher = next; n++ }
      } catch { /* 跳过 */ }
    }
  }
  if (n) writeFile(f)
  return n
}

// ---- 凭据迁移（桌面导出 → 手机导入）：整包用主密码加密，不明文落盘 ----

export async function exportTokenCredentials(pwd: string): Promise<string> {
  // 导出文件本身用主密码加密（便携文件离开本机后的唯一保护）：没有主密码不许
  // 退化成空密码加密。v0.1.470 起凭据读取不再需要密码，这道检查只管导出文件。
  if (!pwd) throw new Error('导出凭据文件需要主密码（导出文件用主密码加密保护），请先解锁保险箱再导出')
  const items: { platform: string; label: string; secret: string }[] = []
  for (const pid of TOKEN_PLATFORM_IDS) {
    for (const m of listTokenMeta(pid)) {
      const sec = await loadTokenSecret(pid, m.id, pwd)
      if (sec) items.push({ platform: pid, label: m.label, secret: sec })
    }
  }
  if (!items.length) throw new Error('还没有可导出的凭据（先在任意令牌平台添加账号）')
  const cipher = await encryptSecret(JSON.stringify({ v: 1, items }), pwd)
  return JSON.stringify({ app: 'ai-cube', kind: 'token-credentials', cipher }, null, 2)
}

export async function importTokenCredentials(text: string, pwd: string): Promise<{ added: number; skipped: number }> {
  let outer: { kind?: string; cipher?: string }
  try { outer = JSON.parse(text) as { kind?: string; cipher?: string } } catch { throw new Error('文件格式不对：不是 AI 魔方导出的凭据文件') }
  if (outer.kind !== 'token-credentials' || !outer.cipher) throw new Error('文件格式不对：不是 AI 魔方导出的凭据文件')
  let plain: string
  try { plain = await decryptSecret(outer.cipher, pwd) } catch { throw new Error('解密失败：主密码不对，或手机与电脑不是同一套保险箱（需先同步保险箱）') }
  const payload = JSON.parse(plain) as { items?: { platform: string; label: string; secret: string }[] }
  let added = 0, skipped = 0
  for (const it of payload.items ?? []) {
    if (!(TOKEN_PLATFORM_IDS as string[]).includes(it.platform) || !it.secret) { skipped++; continue }
    const pid = it.platform
    if (listTokenMeta(pid).some(m => m.label === it.label)) { skipped++; continue }
    await addTokenAccount(pid, it.label || '导入的账号', it.secret, pwd)
    added++
  }
  return { added, skipped }
}
