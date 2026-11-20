// 指纹/面容登录（仅安卓/iOS 原生端）：把云账号的账号+密码存进系统钥匙串
// （Android Keystore / iOS Keychain），读取时必须先通过生物识别验证。
// 密码不经过 localStorage、不进云同步；桌面/Web 端全部函数安全地返回不可用。

import { isNativeApp } from './openExternal'

const SERVER = 'acm.cloud.account'
const BOUND_KEY = 'acm.biometric.bound'

async function plugin() {
  const mod = await import('@capgo/capacitor-native-biometric')
  return mod.NativeBiometric
}

/** 本机是否支持生物识别（指纹/面容） */
export async function biometricAvailable(): Promise<boolean> {
  if (!isNativeApp()) return false
  try {
    const r = await (await plugin()).isAvailable()
    return !!r.isAvailable
  } catch { return false }
}

/** 是否已绑定过指纹登录（本地标记；真正的凭据在系统钥匙串里） */
export function biometricBound(): boolean {
  try { return localStorage.getItem(BOUND_KEY) === '1' } catch { return false }
}

/** 把账号密码存入系统钥匙串（密码登录成功后调用，静默绑定/刷新） */
export async function bindBiometricCredentials(username: string, password: string): Promise<boolean> {
  if (!isNativeApp()) return false
  try {
    await (await plugin()).setCredentials({ username, password, server: SERVER })
    try { localStorage.setItem(BOUND_KEY, '1') } catch { /* 忽略 */ }
    return true
  } catch { return false }
}

/** 弹生物识别验证并取回钥匙串里的账号密码；用户取消/失败返回 null */
export async function readBiometricCredentials(): Promise<{ username: string; password: string } | null> {
  if (!isNativeApp()) return null
  try {
    const c = await (await plugin()).getCredentials({ server: SERVER })
    if (c?.username && c?.password) return { username: c.username, password: c.password }
    return null
  } catch { return null }
}

/** 解除绑定（保存的密码失效时调用） */
export async function unbindBiometric(): Promise<void> {
  try { localStorage.removeItem(BOUND_KEY) } catch { /* 忽略 */ }
  if (!isNativeApp()) return
  try { await (await plugin()).deleteCredentials({ server: SERVER }) } catch { /* 忽略 */ }
}
