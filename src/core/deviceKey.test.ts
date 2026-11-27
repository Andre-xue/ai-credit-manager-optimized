import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { webcrypto } from 'node:crypto'

// Node 环境 polyfill：WebCrypto + localStorage
beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true })
  if (!(globalThis as unknown as Record<string, unknown>).localStorage) {
    const m = new Map<string, string>()
    ;(globalThis as unknown as Record<string, unknown>).localStorage = {
      getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
      setItem: (k: string, v: string) => { m.set(k, v) },
      removeItem: (k: string) => { m.delete(k) },
      clear: () => m.clear(),
    }
  }
})

import {
  encryptLocalSecret, decryptLocalSecret, isLocalCipher, isLegacyCipher,
  decryptStoredSecret, migrateCipherValue, isLegacyLockedError, LOCAL_CIPHER_PREFIX,
} from './deviceKey'
import { initVault, encryptSecret } from './crypto'

const PWD = 'test1234'

beforeEach(() => { localStorage.clear() })

describe('deviceKey 设备本地密钥加密 (v0.1.470)', () => {
  it('本地密文带 L1. 前缀，无需任何密码即可解开', async () => {
    const c = await encryptLocalSecret('{"token":"abc"}')
    expect(c.startsWith(LOCAL_CIPHER_PREFIX)).toBe(true)
    expect(isLocalCipher(c)).toBe(true)
    expect(isLegacyCipher(c)).toBe(false)
    expect(await decryptLocalSecret(c)).toBe('{"token":"abc"}')
    expect(await decryptStoredSecret(c)).toBe('{"token":"abc"}')
  })

  it('设备密钥只生成一次并复用（换密钥会让旧密文解不开）', async () => {
    const c1 = await encryptLocalSecret('one')
    const key1 = localStorage.getItem('acm.device.key.v1')
    const c2 = await encryptLocalSecret('two')
    expect(localStorage.getItem('acm.device.key.v1')).toBe(key1)
    expect(await decryptLocalSecret(c1)).toBe('one')
    expect(await decryptLocalSecret(c2)).toBe('two')
  })

  it('旧格式（主密码）密文：给对密码能解开，不给密码抛 LEGACY_CRED_LOCKED', async () => {
    await initVault(PWD)
    const legacy = await encryptSecret('{"token":"old"}', PWD)
    expect(isLegacyCipher(legacy)).toBe(true)
    expect(await decryptStoredSecret(legacy, PWD)).toBe('{"token":"old"}')
    await expect(decryptStoredSecret(legacy)).rejects.toSatisfy(isLegacyLockedError)
    // 密码不对：AES-GCM 解不开直接抛底层错误（不是 LEGACY_CRED_LOCKED）
    const wrongErr = await decryptStoredSecret(legacy, 'wrong-pwd').catch(e => e)
    expect(wrongErr).toBeInstanceOf(Error)
    expect(isLegacyLockedError(wrongErr)).toBe(false)
  })

  it('migrateCipherValue：旧密文换成本地密文且内容不变；本地密文与错密码返回 null', async () => {
    await initVault(PWD)
    const legacy = await encryptSecret('secret-value', PWD)
    const migrated = await migrateCipherValue(legacy, PWD)
    expect(migrated).not.toBeNull()
    expect(isLocalCipher(migrated)).toBe(true)
    expect(await decryptStoredSecret(migrated!)).toBe('secret-value')
    // 已是本地密文：无需迁移
    expect(await migrateCipherValue(migrated!, PWD)).toBeNull()
    // 密码不对：抛错（调用方捕获后跳过并保留旧密文）
    await expect(migrateCipherValue(legacy, 'wrong-pwd')).rejects.toThrow()
  })

  it('本地密文被篡改后解不开（AES-GCM 完整性）', async () => {
    const c = await encryptLocalSecret('integrity')
    const tampered = c.slice(0, -4) + (c.endsWith('AAAA') ? 'BBBB' : 'AAAA')
    await expect(decryptLocalSecret(tampered)).rejects.toThrow()
  })
})
