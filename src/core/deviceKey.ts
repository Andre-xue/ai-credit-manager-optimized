import { decryptSecret } from './crypto'

/**
 * 设备本地密钥加密（v0.1.470）：运营凭据（Epic 设备授权、签到凭据、邮箱凭据、
 * 账号池凭据、TMDB Key 等）不再用保险箱主密码加密，改用一把只存在本机的
 * 随机密钥加密——功能不再被保险箱解锁门槛拦住。
 *
 * 口径（Ethan 2026-11-27 定案）：只有 API Key 管理里「查看 Key 明文」与
 * 「删除 Key 数据」两处继续用主密码/指纹解锁；API Key 本身仍是主密码加密、
 * 仍进云同步，本模块绝不碰账户 Key。
 *
 * 安全边界（已向 Ethan 明示并接受）：本地密钥与密文同在本机存储里，能读到
 * 本机存储的人就能解开——它防的是密文被单独捡走/同步泄露，不防能操作这台
 * 电脑的人。运营凭据一律只存本机、绝不进云同步/备份（各存储模块维持原状）。
 *
 * 密文格式：新格式带 `L1.` 前缀（`L1.<iv b64>:<cipher b64>`），与保险箱旧
 * 格式（无前缀的 `<iv>:<cipher>`）可机械区分，迁移逻辑据此判定。
 */

const DEVICE_KEY_KEY = 'acm.device.key.v1'
export const LOCAL_CIPHER_PREFIX = 'L1.'

const enc = new TextEncoder()
const dec = new TextDecoder()

function toBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64)
  const bytes = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i)
  return bytes
}

let deviceKeyPromise: Promise<CryptoKey> | null = null

/** 取（或首次生成）设备密钥。密钥材料只存本机 localStorage，永不导出。 */
function getDeviceKey(): Promise<CryptoKey> {
  if (!deviceKeyPromise) {
    deviceKeyPromise = (async () => {
      let raw = localStorage.getItem(DEVICE_KEY_KEY)
      if (!raw) {
        raw = toBase64(crypto.getRandomValues(new Uint8Array(32)))
        try { localStorage.setItem(DEVICE_KEY_KEY, raw) } catch { /* 存不下也先用内存里的这把 */ }
      }
      return crypto.subtle.importKey('raw', fromBase64(raw) as BufferSource, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    })()
  }
  return deviceKeyPromise
}

/** 本地密钥加密（运营凭据专用）。 */
export async function encryptLocalSecret(plaintext: string): Promise<string> {
  const key = await getDeviceKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, enc.encode(plaintext))
  return LOCAL_CIPHER_PREFIX + toBase64(iv) + ':' + toBase64(cipher)
}

/** 本地密钥解密；输入不是 L1 格式时抛错。 */
export async function decryptLocalSecret(ciphertext: string): Promise<string> {
  if (!isLocalCipher(ciphertext)) throw new Error('不是本地密钥密文')
  const [ivB64, cipherB64] = ciphertext.slice(LOCAL_CIPHER_PREFIX.length).split(':')
  const key = await getDeviceKey()
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(ivB64) as BufferSource },
    key,
    fromBase64(cipherB64) as BufferSource,
  )
  return dec.decode(plain)
}

export function isLocalCipher(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith(LOCAL_CIPHER_PREFIX)
}

/** 是否为保险箱旧格式密文（无 L1 前缀、形如 iv:cipher）。空值不算。 */
export function isLegacyCipher(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0) return false
  if (v.startsWith(LOCAL_CIPHER_PREFIX)) return false
  return v.includes(':')
}

/**
 * 统一解密入口（运营凭据各存储共用）：
 * - L1 本地密文 → 本地密钥解，不需要主密码；
 * - 旧格式 → 有 pwd 时用主密码解（调用方负责随后回写为本地密文完成迁移）；
 *   没 pwd 时抛 LEGACY_CRED_LOCKED 错误，界面据此提示「一次性迁移解锁」。
 */
export const LEGACY_CRED_LOCKED = 'LEGACY_CRED_LOCKED'

export async function decryptStoredSecret(ciphertext: string, pwd?: string): Promise<string> {
  if (isLocalCipher(ciphertext)) return decryptLocalSecret(ciphertext)
  if (pwd) return decryptSecret(ciphertext, pwd)
  const e = new Error('这份凭据还是旧版加密，需要解锁一次完成迁移，之后不再需要密码')
  ;(e as Error & { code?: string }).code = LEGACY_CRED_LOCKED
  throw e
}

export function isLegacyLockedError(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: string }).code === LEGACY_CRED_LOCKED
}

/**
 * 把一份旧格式密文迁成本地密文：已是本地格式返回 null（无需迁移）；
 * 旧格式用主密码解开再本地加密返回新密文；密码不对抛错（调用方计数失败）。
 */
export async function migrateCipherValue(ciphertext: string, pwd: string): Promise<string | null> {
  if (!isLegacyCipher(ciphertext)) return null
  const plain = await decryptSecret(ciphertext, pwd)
  return encryptLocalSecret(plain)
}
