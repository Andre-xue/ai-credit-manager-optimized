// 钥匙串长期解锁（v0.1.486，Ethan 2026-11-27 拍板的折中方案）。
//
// 定案边界（不可变）：
// - API Key 本身继续用主密码（WebCrypto PBKDF2+AES-GCM）加密，密文与云同步/备份载荷一律不动。
// - 本模块只把「解密能力」托管给系统钥匙串：本机手动解锁一次后，把主密码存进
//   系统钥匙串（与移动端指纹解锁既有的钥匙串存法一致），启动时静默读回并通过
//   保险箱校验后恢复 Key 使用能力，免去每次重启 App 输主密码。
// - 存的只有主密码本身，且只进系统钥匙串：绝不进 localStorage、云同步或备份。
// - 通道：桌面端走 Tauri Rust keyring 命令（macOS 钥匙串 / Windows 凭据管理器 /
//   Linux Secret Service）；安卓/iOS 走 @capgo/capacitor-native-biometric 的钥匙串
//   （专用 server，与指纹解锁条目分开；该通道读取时系统会要求过一次生物验证，
//   是平台钥匙串的既定行为）；网页版没有系统钥匙串，全部函数安全返回不可用、保持现状。
//
// 解锁态分两种（step-up 边界，单测钉死）：
// - manual：本会话内当场验过（密码/指纹）——看明文、删 Key 数据按既有口径直接放行。
// - auto：启动时从钥匙串静默恢复——「用 Key 本身」的场景（聊天/健康检查/网关/生图）
//   直接可用，但看明文、删 Key 数据必须当场再验一次（requiresStepUp）。

import { isDesktopApp, isNativeApp } from './openExternal'
import { isVaultInitialized, verifyVault } from './crypto'
import { readPref, writePref } from './localStore'

export type UnlockKind = 'none' | 'manual' | 'auto'

const PREF_KEY = 'acm.vault.keepUnlocked.v1'
const NATIVE_SERVER = 'acm.vault.keepalive'
const NATIVE_BOUND_KEY = 'acm.vault.keepAliveBound'

/** 「在这台设备上保持解锁」开关（仅本机，默认开；不进云同步/备份；v0.1.510 起 prefs 文件兜底） */
export function keepUnlockedEnabled(): boolean {
  try { return readPref(PREF_KEY) !== '0' } catch { return true }
}

export function setKeepUnlockedPref(on: boolean): void {
  writePref(PREF_KEY, on ? '1' : '0')
}

/** 当前平台有没有系统钥匙串通道（桌面 Tauri / 原生 App）；网页版没有 */
export function keychainAvailable(): boolean {
  return isDesktopApp() || isNativeApp()
}

/** 自动解锁态能不能直接「用 Key 本身」（聊天/健康检查/本地网关/生图/视频等） */
export function canUseKeyMaterial(kind: UnlockKind): boolean {
  return kind !== 'none'
}

/**
 * 看 Key 明文 / 删除 Key 数据是否必须当场再验一次：
 * 只有钥匙串自动解锁态需要 step-up；手动验证过的会话内按既有口径不再加烦。
 */
export function requiresStepUp(kind: UnlockKind): boolean {
  return kind === 'auto'
}

// ---- 钥匙串后端（可注入替身供单测/无头验证） ----
export interface KeychainBackend {
  get(): Promise<string | null>
  set(password: string): Promise<boolean>
  remove(): Promise<void>
}

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke?: (c: string, a?: Record<string, unknown>) => Promise<T> } }
  if (!w.__TAURI_INTERNALS__?.invoke) throw new Error('Tauri invoke 不可用')
  return w.__TAURI_INTERNALS__.invoke(cmd, args)
}

const desktopBackend: KeychainBackend = {
  async get() {
    try { return (await tauriInvoke<string | null>('vault_keychain_get')) ?? null } catch { return null }
  },
  async set(password) {
    try { await tauriInvoke<void>('vault_keychain_set', { password }); return true } catch { return false }
  },
  async remove() {
    try { await tauriInvoke<void>('vault_keychain_delete') } catch { /* 删不掉不阻断 */ }
  },
}

function nativeBound(): boolean {
  try { return localStorage.getItem(NATIVE_BOUND_KEY) === '1' } catch { return false }
}

const nativeBackend: KeychainBackend = {
  async get() {
    // 没写过条目时直接返回 null，避免启动时无谓地弹生物验证
    if (!nativeBound()) return null
    try {
      const { NativeBiometric } = await import('@capgo/capacitor-native-biometric')
      const c = await NativeBiometric.getCredentials({ server: NATIVE_SERVER })
      return c?.password || null
    } catch { return null }
  },
  async set(password) {
    try {
      const { NativeBiometric } = await import('@capgo/capacitor-native-biometric')
      await NativeBiometric.setCredentials({ username: 'master', password, server: NATIVE_SERVER })
      try { localStorage.setItem(NATIVE_BOUND_KEY, '1') } catch { /* 忽略 */ }
      return true
    } catch { return false }
  },
  async remove() {
    try { localStorage.removeItem(NATIVE_BOUND_KEY) } catch { /* 忽略 */ }
    try {
      const { NativeBiometric } = await import('@capgo/capacitor-native-biometric')
      await NativeBiometric.deleteCredentials({ server: NATIVE_SERVER })
    } catch { /* 忽略 */ }
  },
}

let backendOverride: KeychainBackend | null = null
/** 仅供单测/无头验证注入钥匙串替身 */
export function __setKeychainBackendForTest(b: KeychainBackend | null): void {
  backendOverride = b
}

function backend(): KeychainBackend | null {
  if (backendOverride) return backendOverride
  if (isDesktopApp()) return desktopBackend
  if (isNativeApp()) return nativeBackend
  return null
}

/** 把主密码存入系统钥匙串（手动解锁成功后调用）。无通道/失败返回 false，不打扰用户 */
export async function keychainStoreMasterPassword(password: string): Promise<boolean> {
  const b = backend()
  if (!b || !password) return false
  return b.set(password)
}

/** 从系统钥匙串读回主密码（不做校验）；无条目/无通道返回 null */
export async function keychainReadMasterPassword(): Promise<string | null> {
  const b = backend()
  if (!b) return null
  return b.get()
}

/** 删除系统钥匙串里的主密码条目（关开关/重置保险箱/条目失效时调用） */
export async function keychainDeleteMasterPassword(): Promise<void> {
  const b = backend()
  if (!b) return
  await b.remove()
}

/**
 * 启动自动解锁：开关开 + 保险箱已建 + 钥匙串条目存在且能通过保险箱校验
 * → 返回主密码（调用方据此恢复 Key 使用能力，记 unlockKind='auto'）。
 * 任一不满足返回 null，静默回落手动解锁流程，不报错、不循环弹。
 * 保险箱已建但条目解不开（改过密码又没同步更新、导入了别台设备的备份等）
 * → 条目已失效，顺手删掉，避免每次启动白试。
 * 保险箱尚未建（云端材料可能稍后才到）时不删条目，留待材料齐后手动解锁刷新。
 */
export async function tryKeychainAutoUnlock(): Promise<string | null> {
  if (!keepUnlockedEnabled()) return null
  if (!isVaultInitialized()) return null
  const pwd = await keychainReadMasterPassword()
  if (!pwd) return null
  if (await verifyVault(pwd)) return pwd
  await keychainDeleteMasterPassword()
  return null
}

/**
 * 「保持解锁」开关变更的统一处理：
 * - 关：立即删除钥匙串条目，之后回到重启需输密码。
 * - 开：只记偏好；条目在下次手动解锁成功时写入（若当前会话已手动解锁，
 *   调用方可顺手用会话密码立即补写）。
 */
export async function applyKeepUnlockedChange(on: boolean): Promise<void> {
  setKeepUnlockedPref(on)
  if (!on) await keychainDeleteMasterPassword()
}

/**
 * 改主密码成功后的钥匙串生命周期：开关开则把条目换成新密码（下次启动用新密码
 * 自动解锁）；开关关则确保条目不存在。旧条目若留着，启动校验必然失败被清，
 * 这里主动同步更新，省去一次无谓的失败尝试。
 */
export async function refreshKeychainAfterPasswordChange(newPassword: string): Promise<void> {
  if (!keepUnlockedEnabled()) {
    await keychainDeleteMasterPassword()
    return
  }
  await keychainStoreMasterPassword(newPassword)
}
