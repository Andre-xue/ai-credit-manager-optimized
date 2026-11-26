// 邮箱账户存储可靠性（v0.1.461 复现 + 回归）：
// 实机故障：加第二个起的 Gmail OAuth 账户时「账户已保存，但连接失败：保险箱里
// 没有这个账户的凭据」。根因在账户文件的读-改-写不设防：
//  (1) 竞态丢失更新——addMailAccount / saveMailSecret 都是「读全量 → await 加密
//      → 写全量」，授权要等浏览器回调的几分钟里，后台同步给其它账户刷新令牌的
//      saveMailSecret 若读在新账户写入前、写在写入后，会用不含新账户的旧快照
//      把整个文件盖回去，新账户连元信息带凭据一起消失（连接时按 id 查不到）。
//  (2) 配额静默吞错——writeJson 把 setItem 的 QuotaExceededError 吞掉：正文缓存
//      （40 封 × 最大 1M 字符）与头部缓存把 localStorage 撑满后，账户写入静默
//      失败，流程却照常往下走，到连接阶段才暴露成「没有凭据」。
// 本文件用可控加密（手动放行）把交错时序钉死、用配额存储把满盘钉死，先红后绿。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  manual: false,
  pending: [] as Array<{ plain: string; resolve: (v: string) => void }>,
}))
vi.mock('./crypto', () => ({
  encryptSecret: (plain: string) => (h.manual
    ? new Promise<string>(resolve => { h.pending.push({ plain, resolve }) })
    : Promise.resolve('enc:' + plain)),
  decryptSecret: async (cipher: string) => {
    if (!cipher.startsWith('enc:')) throw new Error('bad cipher')
    return cipher.slice(4)
  },
}))

import {
  addMailAccount, listMailAccounts, loadMailSecret, saveMailSecret,
  setMailAccountTransport, type MailSecret,
} from './mail'

class MemStorage {
  protected m = new Map<string, string>()
  getItem(k: string) { return this.m.get(k) ?? null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}
class QuotaStorage extends MemStorage {
  budget = Number.POSITIVE_INFINITY
  override setItem(k: string, v: string) {
    let total = String(v).length
    for (const [kk, vv] of this.m) if (kk !== k) total += vv.length
    if (total > this.budget) {
      const e = new Error('QuotaExceededError: 本机存储空间不足')
      e.name = 'QuotaExceededError'
      throw e
    }
    super.setItem(k, v)
  }
}

const storage = new QuotaStorage()
;(globalThis as unknown as { localStorage: QuotaStorage }).localStorage = storage

const tick = () => new Promise(r => setTimeout(r, 0))
async function resolveNextEncrypt() {
  // 等到确有加密挂起再放行（串行链下后一个变更要等前一个写完才走到加密）
  for (let i = 0; i < 100 && !h.pending.length; i++) await tick()
  const item = h.pending.shift()
  if (!item) throw new Error('没有等待中的加密')
  item.resolve('enc:' + item.plain)
  await tick()
}

const oauthSecret = (tag: string): MailSecret => ({
  kind: 'oauth', accessTok: `at-${tag}`, refreshTok: `rt-${tag}`, expiresAt: Date.now() + 3600_000,
  clientId: 'cid', clientSecret: 'sec',
})
const metaOf = (email: string) => ({
  platformId: 'gmail' as const, email, label: email, host: 'imap.gmail.com', port: 993,
})

beforeEach(() => {
  storage.clear()
  storage.budget = Number.POSITIVE_INFINITY
  h.manual = false
  h.pending = []
})

afterEach(async () => {
  // 排空可能挂起的加密与串行链，避免单个用例失败毒化后续用例
  h.manual = false
  for (const item of h.pending.splice(0)) item.resolve('enc:' + item.plain)
  await tick()
})

describe('账户文件写入可靠性（v0.1.461）', () => {
  it('交错写入不丢账户：加账户在途时其它账户的令牌保存不得用旧快照盖掉新账户', async () => {
    const a = await addMailAccount(metaOf('a@gmail.com'), oauthSecret('a'), 'pwd')
    h.manual = true
    // 加 B：读到 [A] 后挂在加密上（模拟授权/保存的异步间隙）
    const pB = addMailAccount(metaOf('b@gmail.com'), oauthSecret('b'), 'pwd')
    await tick()
    // 同一间隙里，后台给 A 刷新令牌的保存也发起（旧代码此刻已读到旧快照 [A]）
    const pS = saveMailSecret(a.id, oauthSecret('a2'), 'pwd')
    await tick()
    await resolveNextEncrypt() // B 先写：[A, B]
    await resolveNextEncrypt() // A 的保存后写：旧代码会用 [A'] 盖掉 B
    const metaB = await pB
    await pS
    h.manual = false
    expect(listMailAccounts().map(x => x.email)).toContain('b@gmail.com')
    const secB = await loadMailSecret(metaB.id, 'pwd')
    expect(secB?.kind).toBe('oauth')
    if (secB?.kind === 'oauth') expect(secB.refreshTok).toBe('rt-b')
    // A 的新令牌也不能丢
    const secA = await loadMailSecret(a.id, 'pwd')
    if (secA?.kind === 'oauth') expect(secA.refreshTok).toBe('rt-a2')
    else throw new Error('A 的凭据丢了')
  })

  it('通道回填与加账户交错：两者都必须落盘', async () => {
    const a = await addMailAccount(metaOf('a@gmail.com'), oauthSecret('a'), 'pwd')
    h.manual = true
    const pB = addMailAccount(metaOf('b@gmail.com'), oauthSecret('b'), 'pwd')
    await tick()
    const pT = Promise.resolve(setMailAccountTransport(a.id, 'imap'))
    while (h.pending.length) await resolveNextEncrypt()
    await pB
    await pT
    h.manual = false
    const list = listMailAccounts()
    expect(list.map(x => x.email)).toContain('b@gmail.com')
    expect(list.find(x => x.id === a.id)?.transport).toBe('imap')
  })

  it('配额被正文缓存占满时，账户写入要清缓存让路而不是静默丢失', async () => {
    storage.setItem('acm.mail.bodies.v1', 'x'.repeat(100_000))
    storage.budget = 100_150 // 只剩 150 字符余量，一条账户记录（约 295 字符）写不下
    const meta = await addMailAccount(metaOf('b@gmail.com'), oauthSecret('b'), 'pwd')
    expect(listMailAccounts().map(x => x.email)).toContain('b@gmail.com')
    const sec = await loadMailSecret(meta.id, 'pwd')
    expect(sec?.kind).toBe('oauth')
    // 可再生缓存已被清掉给凭据让路
    expect(storage.getItem('acm.mail.bodies.v1')).toBeNull()
  })

  it('存储彻底写不下时 addMailAccount 必须抛真实错误且不留幻影账户', async () => {
    storage.setItem('acm.state.v1', 'x'.repeat(100_000)) // 不可再生的占用，清缓存也救不回
    storage.budget = 100_150
    await expect(addMailAccount(metaOf('b@gmail.com'), oauthSecret('b'), 'pwd'))
      .rejects.toThrow(/写入失败|保存失败/)
    expect(listMailAccounts().map(x => x.email)).not.toContain('b@gmail.com')
  })

  it('saveMailSecret 对不存在的账户返回 false（不再静默装作存好）', async () => {
    await expect(saveMailSecret('mail-nope', oauthSecret('x'), 'pwd')).resolves.toBe(false)
    const a = await addMailAccount(metaOf('a@gmail.com'), oauthSecret('a'), 'pwd')
    await expect(saveMailSecret(a.id, oauthSecret('a2'), 'pwd')).resolves.toBe(true)
  })
})
