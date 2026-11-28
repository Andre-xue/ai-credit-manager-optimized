import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { webcrypto } from 'node:crypto'

// Node 环境 polyfill：WebCrypto + localStorage（与 credMigration.test.ts 同款）
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

import { initVault } from './crypto'
import {
  __setKeychainBackendForTest, applyKeepUnlockedChange, canUseKeyMaterial,
  keepUnlockedEnabled, keychainStoreMasterPassword, keychainReadMasterPassword,
  keychainDeleteMasterPassword, refreshKeychainAfterPasswordChange,
  requiresStepUp, tryKeychainAutoUnlock, resolveVaultPassword, VAULT_KEY_CANCELLED_ERROR,
  type KeychainBackend,
} from './persistentUnlock'

const PWD = 'test1234'
const NEW_PWD = 'newpass5678'

/** 内存钥匙串替身：模拟系统钥匙串的存/取/删 */
function memoryBackend(): KeychainBackend & { value: string | null } {
  const b = {
    value: null as string | null,
    async get() { return b.value },
    async set(p: string) { b.value = p; return true },
    async remove() { b.value = null },
  }
  return b
}

let kc: ReturnType<typeof memoryBackend>

beforeEach(async () => {
  localStorage.clear()
  kc = memoryBackend()
  __setKeychainBackendForTest(kc)
  await initVault(PWD)
})

describe('解锁态边界（step-up 钉死）', () => {
  it('用 Key 本身：manual/auto 都放行，none 不放行', () => {
    expect(canUseKeyMaterial('manual')).toBe(true)
    expect(canUseKeyMaterial('auto')).toBe(true)
    expect(canUseKeyMaterial('none')).toBe(false)
  })

  it('看明文/删 Key 数据：只有 auto 态必须当场再验，manual 会话内不再加烦', () => {
    expect(requiresStepUp('auto')).toBe(true)
    expect(requiresStepUp('manual')).toBe(false)
    expect(requiresStepUp('none')).toBe(false)
  })
})

describe('钥匙串托管与启动自动解锁', () => {
  it('手动解锁后托管：存入并能读回主密码', async () => {
    expect(await keychainStoreMasterPassword(PWD)).toBe(true)
    expect(await keychainReadMasterPassword()).toBe(PWD)
  })

  it('自动解锁：开关开 + 条目有效 → 返回主密码恢复 Key 使用能力', async () => {
    await keychainStoreMasterPassword(PWD)
    expect(keepUnlockedEnabled()).toBe(true) // 默认开
    expect(await tryKeychainAutoUnlock()).toBe(PWD)
  })

  it('自动解锁：开关关 → 不读钥匙串，回落手动', async () => {
    await keychainStoreMasterPassword(PWD)
    await applyKeepUnlockedChange(false)
    expect(await tryKeychainAutoUnlock()).toBe(null)
  })

  it('条目失效（密码对不上保险箱校验）→ 返回 null 且顺手删掉失效条目，不循环', async () => {
    await keychainStoreMasterPassword('wrong-password')
    expect(await tryKeychainAutoUnlock()).toBe(null)
    expect(kc.value).toBe(null)
    // 再试一次仍是 null（条目已清，不会反复尝试）
    expect(await tryKeychainAutoUnlock()).toBe(null)
  })

  it('保险箱未建时不删条目（云端材料可能稍后才到）', async () => {
    localStorage.removeItem('acm.vault.salt')
    localStorage.removeItem('acm.vault.verify')
    await keychainStoreMasterPassword(PWD)
    expect(await tryKeychainAutoUnlock()).toBe(null)
    expect(kc.value).toBe(PWD)
  })

  it('删除条目后读回为空', async () => {
    await keychainStoreMasterPassword(PWD)
    await keychainDeleteMasterPassword()
    expect(await keychainReadMasterPassword()).toBe(null)
  })
})

describe('生命周期', () => {
  it('关掉「保持解锁」：偏好落盘且钥匙串条目立即删除', async () => {
    await keychainStoreMasterPassword(PWD)
    await applyKeepUnlockedChange(false)
    expect(keepUnlockedEnabled()).toBe(false)
    expect(kc.value).toBe(null)
  })

  it('重新打开「保持解锁」：只记偏好，条目等下次手动解锁写入', async () => {
    await applyKeepUnlockedChange(false)
    await applyKeepUnlockedChange(true)
    expect(keepUnlockedEnabled()).toBe(true)
    expect(kc.value).toBe(null)
  })

  it('改主密码后：条目同步换成新密码，旧密码条目不再残留', async () => {
    await keychainStoreMasterPassword(PWD)
    await refreshKeychainAfterPasswordChange(NEW_PWD)
    expect(kc.value).toBe(NEW_PWD)
  })

  it('改主密码时开关是关的：确保条目被清掉', async () => {
    await keychainStoreMasterPassword(PWD)
    await applyKeepUnlockedChange(false)
    await keychainStoreMasterPassword(PWD) // 模拟残留
    await refreshKeychainAfterPasswordChange(NEW_PWD)
    expect(kc.value).toBe(null)
  })
})

describe('v0.1.518：派活取 Key 的按需解锁编排 resolveVaultPassword', () => {
  it('会话已有密码：直接 ready/session，恢复与弹框都不触发', async () => {
    let recoverCalls = 0, promptCalls = 0
    const r = await resolveVaultPassword(PWD, {
      recover: async () => { recoverCalls++; return NEW_PWD },
      prompt: async () => { promptCalls++; return NEW_PWD },
    })
    expect(r).toEqual({ status: 'ready', pwd: PWD, via: 'session' })
    expect(recoverCalls).toBe(0)
    expect(promptCalls).toBe(0)
  })

  it('会话为空：先静默恢复，恢复成功走 recovered、绝不弹框（用户无感）', async () => {
    let promptCalls = 0
    const r = await resolveVaultPassword('', {
      recover: async () => PWD,
      prompt: async () => { promptCalls++; return NEW_PWD },
    })
    expect(r).toEqual({ status: 'ready', pwd: PWD, via: 'recovered' })
    expect(promptCalls).toBe(0)
  })

  it('恢复不到才弹框：弹框成功走 prompt 续跑', async () => {
    const r = await resolveVaultPassword('', {
      recover: async () => null,
      prompt: async () => NEW_PWD,
    })
    expect(r).toEqual({ status: 'ready', pwd: NEW_PWD, via: 'prompt' })
  })

  it('恢复抛错也继续走弹框，不许把异常当取消', async () => {
    const r = await resolveVaultPassword('', {
      recover: async () => { throw new Error('钥匙串不可用') },
      prompt: async () => NEW_PWD,
    })
    expect(r).toEqual({ status: 'ready', pwd: NEW_PWD, via: 'prompt' })
  })

  it('恢复不到 + 用户取消弹框 → cancelled，落卡文案是「已取消」口径', async () => {
    const r = await resolveVaultPassword('', {
      recover: async () => null,
      prompt: async () => null,
    })
    expect(r).toEqual({ status: 'cancelled' })
    expect(VAULT_KEY_CANCELLED_ERROR).toContain('已取消')
    expect(VAULT_KEY_CANCELLED_ERROR).not.toContain('API Key 管理')
  })
})
