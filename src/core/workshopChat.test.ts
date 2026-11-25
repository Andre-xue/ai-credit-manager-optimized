import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account } from './types'
import { loadWorkshopRoutes, runWorkshopChat, resolveWorkshopModel, defaultChatEngine } from './workshopChat'
import { saveChainMode } from './freeChain'
import type { FreeAiOption } from './freeAi'

vi.mock('./crypto', () => ({ decryptSecret: async () => 'test-key' }))

const acct = (providerId: string, label: string, apiUrl = 'https://api.example.com', id = 'a1'): Account => ({
  id, providerId, label, mode: 'api', apiUrl,
  encryptedKey: 'enc', modelCapability: 'chat', note: '[通用型]',
  createdAt: '2026-01-01', updatedAt: '2026-01-01',
})

afterEach(() => vi.unstubAllGlobals())

const okFetch = (text = '推荐：舌尖上的中国') => vi.fn().mockResolvedValue({
  ok: true,
  text: async () => JSON.stringify({ choices: [{ message: { content: text } }] }),
})

/** 平台 400 拒绝（模型名不认）：directFetch 抛「接口返回 400：…」 */
const errFetch = (detail = "Model 'Kimi' does not exist") => vi.fn().mockResolvedValue({
  ok: false, status: 400,
  text: async () => JSON.stringify({ error: { message: detail, code: 'invalid_model' } }),
})

const modelSent = (fetchMock: ReturnType<typeof okFetch>) =>
  JSON.parse(String(fetchMock.mock.calls[0][1].body)).model as string

describe('defaultChatEngine（v0.1.430：平台首选对话模型）', () => {
  it('有旗舰款的取旗舰', () => {
    expect(defaultChatEngine('kim')).toBe('kimi-k3.1-pro')
    expect(defaultChatEngine('deepseek')).toBe('deepseek-flash')
    expect(defaultChatEngine('glm')).toBe('glm-4.6')
    expect(defaultChatEngine('qwen')).toBe('qwen4-max')
  })
  it('未收录的平台返回 undefined', () => {
    expect(defaultChatEngine('siliconflow')).toBeUndefined()
    expect(defaultChatEngine('custom-endpoint')).toBeUndefined()
  })
})

describe('runWorkshopChat 自有账户不再拿账户名当模型发（v0.1.430）', () => {
  it('Kimi 账户发 kimi-k3.1-pro，而不是「Kimi」', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    const text = await runWorkshopChat({
      route: { kind: 'account', key: 'acct:a1', label: 'Kimi', accountId: 'a1' },
      freeOptions: [], accounts: [acct('kim', 'Kimi', 'https://api.moonshot.cn')],
      sessionPwd: 'pwd', system: '你是找剧助手', user: '科幻',
    })
    expect(text).toContain('舌尖上的中国')
    expect(modelSent(fetchMock)).toBe('kimi-k3.1-pro')
  })

  it('DeepSeek 账户发 deepseek-flash，而不是「DeepSeek」', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    await runWorkshopChat({
      route: { kind: 'account', key: 'acct:a1', label: 'DeepSeek', accountId: 'a1' },
      freeOptions: [], accounts: [acct('deepseek', 'DeepSeek', 'https://api.deepseek.com')],
      sessionPwd: 'pwd', system: '你是找剧助手', user: '喜剧',
    })
    expect(modelSent(fetchMock)).toBe('deepseek-flash')
  })

  it('GLM 账户发 glm-4.6，而不是「GLM」', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    await runWorkshopChat({
      route: { kind: 'account', key: 'acct:a1', label: 'GLM', accountId: 'a1' },
      freeOptions: [], accounts: [acct('glm', 'GLM', 'https://open.bigmodel.cn/api/paas/v4')],
      sessionPwd: 'pwd', system: '你是找剧助手', user: '爱情',
    })
    expect(modelSent(fetchMock)).toBe('glm-4.6')
  })

  it('label 本身就是目录里的模型 id 时优先用 label', () => {
    expect(resolveWorkshopModel(acct('kim', 'kimi-k3'))).toBe('kimi-k3')
    expect(resolveWorkshopModel(acct('glm', 'glm-4.5-flash'))).toBe('glm-4.5-flash')
  })

  it('未收录的平台回落到备注/标签里的模型 id（旧行为保留）', () => {
    expect(resolveWorkshopModel(acct('siliconflow', 'Qwen/Qwen3-32B'))).toBe('Qwen/Qwen3-32B')
    expect(resolveWorkshopModel(acct('custom-endpoint', 'my-model-1'))).toBe('my-model-1')
  })

  it('路线自带的 modelId/engine 优先', () => {
    const a = acct('kim', 'Kimi')
    expect(resolveWorkshopModel(a, { kind: 'account', key: 'acct:a1:m', label: 'x', accountId: 'a1', modelId: 'kimi-k3' })).toBe('kimi-k3')
    expect(resolveWorkshopModel(a, { kind: 'account', key: 'acct:a1', label: 'x', accountId: 'a1', engine: 'kimi-k3.1-pro-highspeed' })).toBe('kimi-k3.1-pro-highspeed')
  })
})

describe('runWorkshopChat 失败时抛出真原因（v0.1.430）', () => {
  it('平台 400 拒绝时报错里有 400 与平台原文，不再是光秃秃的「调用失败」', async () => {
    vi.stubGlobal('fetch', errFetch("Model 'GLM' does not exist"))
    let errMsg = ''
    try {
      await runWorkshopChat({
        route: { kind: 'account', key: 'acct:a1', label: 'GLM', accountId: 'a1' },
        freeOptions: [], accounts: [acct('glm', 'GLM', 'https://open.bigmodel.cn/api/paas/v4')],
        sessionPwd: 'pwd', system: '你是找剧助手', user: '爱情',
      })
    } catch (e) {
      errMsg = e instanceof Error ? e.message : String(e)
    }
    expect(errMsg).toContain('400')
    expect(errMsg).toContain('does not exist')
    expect(errMsg).not.toBe('调用失败')
  })
})

describe('loadWorkshopRoutes 给自有账户路线带上 engine（v0.1.430）', () => {
  it('Kimi/GLM/DeepSeek 路线都带真实模型 id', async () => {
    const { routes } = await loadWorkshopRoutes([
      acct('kim', 'Kimi', 'https://api.moonshot.cn', 'k1'),
      acct('glm', 'GLM', 'https://open.bigmodel.cn/api/paas/v4', 'g1'),
      acct('deepseek', 'DeepSeek', 'https://api.deepseek.com', 'd1'),
    ])
    const byId = new Map(routes.filter(r => r.kind === 'account').map(r => [r.accountId, r]))
    expect((byId.get('k1') as { engine?: string } | undefined)?.engine).toBe('kimi-k3.1-pro')
    expect((byId.get('g1') as { engine?: string } | undefined)?.engine).toBe('glm-4.6')
    expect((byId.get('d1') as { engine?: string } | undefined)?.engine).toBe('deepseek-flash')
    const engines = routes.filter(r => r.kind === 'account').map(r => (r as { engine?: string }).engine)
    expect(engines).toContain('kimi-k3.1-pro')
    expect(engines).toContain('glm-4.6')
    expect(engines).toContain('deepseek-flash')
    expect(engines).not.toContain('Kimi')
    expect(engines).not.toContain('GLM')
    expect(engines).not.toContain('DeepSeek')
  })
})

describe('Inferbase 工坊路线（v0.1.432：冒烟门槛 + auto 模型）', () => {
  it('Inferbase 首选模型是 auto（智能路由），不拿账户名当模型', () => {
    expect(defaultChatEngine('inferbase')).toBe('auto')
    expect(resolveWorkshopModel(acct('inferbase', 'Inferbase', 'https://api.inferbase.ai/v1', 'ib1'))).toBe('auto')
  })
  it('未冒烟的 Inferbase 路线带 disabledReason，发送时原样抛真实原因且不发请求', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    const { routes } = await loadWorkshopRoutes([acct('inferbase', 'Inferbase', 'https://api.inferbase.ai/v1', 'ib1')])
    const route = routes.find(r => r.kind === 'account')
    expect(route).toBeTruthy()
    expect((route as { label: string }).label).toContain('待实测')
    expect((route as { disabledReason?: string }).disabledReason).toContain('健康检查')
    const callsBefore = fetchMock.mock.calls.length // loadWorkshopRoutes 拉免费列表的请求不算
    let errMsg = ''
    try {
      await runWorkshopChat({
        route: route!, freeOptions: [],
        accounts: [acct('inferbase', 'Inferbase', 'https://api.inferbase.ai/v1', 'ib1')],
        sessionPwd: 'pwd', system: 's', user: 'u',
      })
    } catch (e) { errMsg = e instanceof Error ? e.message : String(e) }
    expect(errMsg).toContain('待实测')
    expect(fetchMock.mock.calls.length).toBe(callsBefore) // 门槛拦截发生在解密/发请求之前
  })
})

describe('runWorkshopChat 自动切换链（v0.1.433）', () => {
  class MemStorage {
    private m = new Map<string, string>()
    getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
    setItem(k: string, v: string) { this.m.set(k, String(v)) }
    removeItem(k: string) { this.m.delete(k) }
    clear() { this.m.clear() }
  }
  beforeEach(() => { ;(globalThis as any).localStorage = new MemStorage() })
  afterEach(() => { delete (globalThis as any).localStorage })

  const zenOpt: FreeAiOption = { key: 'up:zen:m-free', label: 'M · Zen', group: 'Zen 免费通道', source: 'zen', modelId: 'm-free' }
  const kiloOpt: FreeAiOption = { key: 'up:kilo:free-x', label: 'X · Kilo', group: 'Kilo 免费通道', source: 'kilo', modelId: 'free-x' }
  const zenRoute = { kind: 'free' as const, key: 'free:up:zen:m-free', label: '免费 · M · Zen' }

  /** Zen 429、Kilo 正常：按 URL 分流的 fetch */
  const zenDownKiloOk = () => vi.fn(async (url: unknown) => {
    if (String(url).includes('opencode.ai')) return { status: 429, text: async () => 'rate limit exceeded' }
    return { status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'Kilo 的答案' } }] }) }
  })

  it('自动模式：Zen 限流自动切 Kilo，并通过 onChainNote 明示原因', async () => {
    const fetchMock = zenDownKiloOk()
    vi.stubGlobal('fetch', fetchMock)
    const notes: string[] = []
    const text = await runWorkshopChat({
      route: zenRoute, freeOptions: [zenOpt, kiloOpt], accounts: [],
      sessionPwd: '', system: 's', user: 'u', onChainNote: m => notes.push(m),
    })
    expect(text).toBe('Kilo 的答案')
    expect(notes.join(' ')).toContain('限流')
    expect(notes.join(' ')).toContain('已自动切换到')
  })

  it('手动锁定：Zen 限流直接报错，不试 Kilo', async () => {
    saveChainMode('locked')
    const fetchMock = zenDownKiloOk()
    vi.stubGlobal('fetch', fetchMock)
    await expect(runWorkshopChat({
      route: zenRoute, freeOptions: [zenOpt, kiloOpt], accounts: [],
      sessionPwd: '', system: 's', user: 'u',
    })).rejects.toThrow('429')
    expect(fetchMock.mock.calls.some(c => String(c[0]).includes('kilo.ai'))).toBe(false)
  })

  it('自动模式：自有付费账户 429 后只切免费路线（不切其他付费账户）', async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes('moonshot.cn')) return { ok: false, status: 429, text: async () => JSON.stringify({ error: { message: 'rate limit exceeded' } }) }
      if (String(url).includes('opencode.ai')) return { status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'Zen 的答案' } }] }) }
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '不该被调用' } }] }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    const notes: string[] = []
    const text = await runWorkshopChat({
      route: { kind: 'account', key: 'acct:a1', label: 'Kimi', accountId: 'a1' },
      freeOptions: [zenOpt], accounts: [acct('kim', 'Kimi', 'https://api.moonshot.cn'), acct('glm', 'GLM', 'https://open.bigmodel.cn/api/paas/v4', 'a2')],
      sessionPwd: 'pwd', system: 's', user: 'u', onChainNote: m => notes.push(m),
    })
    expect(text).toBe('Zen 的答案')
    expect(fetchMock.mock.calls.some(c => String(c[0]).includes('bigmodel.cn'))).toBe(false)
    expect(notes.join(' ')).toContain('已自动切换到')
  })

  it('自动模式：全部免费路线失败时汇总各路线真实原因', async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes('opencode.ai')) return { status: 429, text: async () => 'rate limit exceeded' }
      return { status: 503, text: async () => 'gateway down' }
    })
    vi.stubGlobal('fetch', fetchMock)
    let errMsg = ''
    try {
      await runWorkshopChat({
        route: zenRoute, freeOptions: [zenOpt, kiloOpt], accounts: [],
        sessionPwd: '', system: 's', user: 'u',
      })
    } catch (e) { errMsg = e instanceof Error ? e.message : String(e) }
    expect(errMsg).toContain('全部路线都不可用')
    expect(errMsg).toContain('429')
    expect(errMsg).toContain('503')
  })
})
