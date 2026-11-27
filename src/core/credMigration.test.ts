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

import { countLegacyOperationalCreds, hasLegacyOperationalCreds, migrateAllOperationalCreds } from './credMigration'
import { initVault, encryptSecret } from './crypto'
import { isLocalCipher } from './deviceKey'
import { poolCredBox } from './wbPool'
import { loadMailSecret } from './mail'
import { loadTmdbKey } from './watch'

const PWD = 'test1234'

beforeEach(() => { localStorage.clear() })

/** 在三个代表性存储里各塞一份 470 前的旧格式（主密码加密）运营凭据 */
async function seedLegacyCreds(): Promise<void> {
  await initVault(PWD)
  const poolCipher = await encryptSecret(
    JSON.stringify({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 3600_000, uid: 'u1', label: '池号' }), PWD)
  localStorage.setItem('acm.wbpool.v1', JSON.stringify({ accounts: [{ id: 'p1', label: '池号', cipher: poolCipher }] }))
  const mailCipher = await encryptSecret(JSON.stringify({ kind: 'password', password: 'mail-auth-code' }), PWD)
  localStorage.setItem('acm.mail.accounts.v1', JSON.stringify({ accounts: [
    { id: 'm1', platform: 'qq', label: 'QQ 邮箱', address: 'a@qq.com', host: 'imap.qq.com', port: 993, cipher: mailCipher },
  ] }))
  const tmdbCipher = await encryptSecret('tmdb-key-xyz', PWD)
  localStorage.setItem('acm.watch.tmdb.v1', JSON.stringify({ cipher: tmdbCipher }))
}

describe('credMigration 运营凭据一次性迁移 (v0.1.470)', () => {
  it('迁移前：旧凭据计数正确，且无密码解不开', async () => {
    await seedLegacyCreds()
    expect(countLegacyOperationalCreds()).toBe(3)
    expect(hasLegacyOperationalCreds()).toBe(true)
    expect(await poolCredBox('p1').load()).toBeNull()
    expect(await loadTmdbKey()).toBeNull()
  })

  it('迁移后：全部变本地密文、无密码可读、内容不变', async () => {
    await seedLegacyCreds()
    const r = await migrateAllOperationalCreds(PWD)
    expect(r.migrated).toBe(3)
    expect(r.remaining).toBe(0)
    expect(hasLegacyOperationalCreds()).toBe(false)
    const poolFile = JSON.parse(localStorage.getItem('acm.wbpool.v1')!)
    expect(isLocalCipher(poolFile.accounts[0].cipher)).toBe(true)
    const cred = await poolCredBox('p1').load()
    expect(cred?.accessToken).toBe('AT')
    expect(cred?.refreshToken).toBe('RT')
    const mailSecret = await loadMailSecret('m1')
    expect(mailSecret).toMatchObject({ kind: 'password', password: 'mail-auth-code' })
    expect(await loadTmdbKey()).toBe('tmdb-key-xyz')
  })

  it('幂等：重复迁移不再动已迁凭据', async () => {
    await seedLegacyCreds()
    await migrateAllOperationalCreds(PWD)
    const before = localStorage.getItem('acm.wbpool.v1')
    const r2 = await migrateAllOperationalCreds(PWD)
    expect(r2.migrated).toBe(0)
    expect(r2.remaining).toBe(0)
    expect(localStorage.getItem('acm.wbpool.v1')).toBe(before)
  })

  it('密码不对：一个都迁不动，旧密文原样保留并计数', async () => {
    await seedLegacyCreds()
    const before = localStorage.getItem('acm.wbpool.v1')
    const r = await migrateAllOperationalCreds('wrong-pwd')
    expect(r.migrated).toBe(0)
    expect(r.remaining).toBe(3)
    expect(localStorage.getItem('acm.wbpool.v1')).toBe(before)
  })

  it('API Key 数据不在迁移范围：无关存储纹丝不动', async () => {
    await seedLegacyCreds()
    const sentinel = JSON.stringify({ accounts: [{ id: 'k1', encryptedKey: await encryptSecret('sk-ant-xxx', PWD) }] })
    localStorage.setItem('acm.test.apikeys', sentinel)
    await migrateAllOperationalCreds(PWD)
    expect(localStorage.getItem('acm.test.apikeys')).toBe(sentinel)
  })
})
