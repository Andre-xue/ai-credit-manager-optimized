// 移动云 MoMA 接入（v0.1.456）：平台预设、无余额接口口径、健康状态机、启用门槛、
// 429 冷却口径、本机用量估算、冒烟模型挑选（九天自营优先）、不进自动切换链红线。
// 沙箱无 Ethan 的真实 Key：聊天冒烟用 mock 验证状态机；公开侧已实测（2026-11-26）：
// GET /v1/models 无 Key 返回 200、172 个模型（公开目录，owned_by 为空、无自营标记）；
// POST /v1/chat/completions 无 Key 返回 401 {"error":{"code":"1001","message":
// "Authentication parameter not received in Header, unable to authenticate"}}。
// 真实 Key 的冒烟待 Ethan 在 App 里加 Key 后实测（健康检查即冒烟入口，看扣哪份额度）。
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { PROVIDER_MAP } from '../data/providers'
import { ENGINE_CATALOG } from '../data/engines'
import { getAdapter, NO_BALANCE_API_NOTE } from './adapters'
import {
  classifyMomaHttp, momaStateFromError, MomaApiError, momaGate, recordMomaVerification,
  momaCooldownFor, recordMomaRouteFailure, recordMomaRouteSuccess,
  recordMomaLocalUsage, loadMomaLocalUsage, momaEstimateText, momaLimitsText,
  pickMomaSmokeModel, getMomaSmokeModel, isMomaChatCandidate,
  MOMA_BASE, MOMA_RATE_COOLDOWN_MS, MOMA_QUOTA_COOLDOWN_MS,
} from './moma'
import { CHAIN_KIND_ORDER } from './freeChain'

vi.mock('./crypto', () => ({ decryptSecret: async () => 'test-key' }))

class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}
;(globalThis as any).localStorage = new MemStorage()

const acct = { id: 'mm1', providerId: 'moma', keyFingerprint: 'fp1' }

describe('MoMA 平台预设（第 61 个平台）', () => {
  it('目录里有 moma，Base URL 是模型广场按量网关（呼和浩特 /v1）', () => {
    const p = PROVIDER_MAP['moma']
    expect(p).toBeTruthy()
    expect(p.apiBaseUrl).toBe(MOMA_BASE)
    expect(p.apiBaseUrl).toBe('https://zhenze-huhehaote.cmecloud.cn/v1')
    expect(p.apiKeyUrl).toContain('ecloud.10086.cn')
    expect(p.apiKeyUrl).toContain('apiKeyManage')
    expect(p.note).toContain('无公开余额接口')
    expect(p.note).toContain('2500 万免费试用')
  })
  it('红线：预设地址不含 Coding Plan / Token Plan 路径', () => {
    const p = PROVIDER_MAP['moma']
    for (const u of [p.apiBaseUrl, p.apiKeyUrl, p.officialUrl, p.usageUrl]) {
      expect(u ?? '').not.toMatch(/coding-plan-token|tokenplan/i)
    }
    expect(MOMA_BASE).not.toMatch(/coding-plan-token|tokenplan/i)
  })
  it('无公开余额接口：适配器不支持自动查余额，提示去控制台手动录入', () => {
    expect(getAdapter('moma').supported).toBe(false)
    expect(NO_BALANCE_API_NOTE['moma']).toContain('无公开余额接口')
    expect(NO_BALANCE_API_NOTE['moma']).toContain('手动录入')
  })
  it('引擎目录不预置模型：全量走 /v1/models 动态拉取', () => {
    expect(ENGINE_CATALOG['moma']).toBeUndefined()
  })
  it('口径文案如实：按量付费 + 2500 万试用 + 本机估算 + 不进自动切换链', () => {
    const text = momaLimitsText()
    expect(text).toContain('按量付费')
    expect(text).toContain('2500 万免费试用')
    expect(text).toContain('无公开余额接口')
    expect(text).toContain('手动录入')
    expect(text).toContain('不进入免费路线自动切换链')
  })
})

describe('MoMA 状态归类', () => {
  it('HTTP 状态归类与 AnyAPI 同口径（401 用官方实测原文）', () => {
    expect(classifyMomaHttp(401, 'Authentication parameter not received in Header, unable to authenticate').state).toBe('auth_invalid')
    expect(classifyMomaHttp(403, 'forbidden').state).toBe('auth_invalid')
    expect(classifyMomaHttp(402, 'insufficient credit').state).toBe('quota_exceeded')
    expect(classifyMomaHttp(429, 'too many', 30).state).toBe('rate_limited')
    expect(classifyMomaHttp(429, 'too many', 30).retryAfterSec).toBe(30)
    expect(classifyMomaHttp(404, 'model not found').state).toBe('model_unavailable')
    expect(classifyMomaHttp(500, 'boom').state).toBe('error')
  })
  it('文本错误归类保留原文（含实测 401 英文原文）', () => {
    expect(momaStateFromError(new Error('接口返回 401：{"error":{"code":"1001","message":"Authentication parameter not received in Header, unable to authenticate"}}'))).toBe('auth_invalid')
    expect(momaStateFromError(new Error('接口返回 429：rate limit'))).toBe('rate_limited')
    expect(momaStateFromError(new Error('Failed to fetch'))).toBe('network_error')
    expect(momaStateFromError(new MomaApiError('x', 'quota_exceeded'))).toBe('quota_exceeded')
  })
})

describe('MoMA 冷却口径', () => {
  const now = Date.UTC(2026, 10, 26, 5, 30, 0) // 2026-11-26 05:30 UTC
  it('有 Retry-After 用 Retry-After 并写明口径', () => {
    const cd = momaCooldownFor('rate_limited', 120, now)!
    expect(cd.until).toBe(now + 120_000)
    expect(cd.reason).toContain('Retry-After')
  })
  it('429 无 Retry-After → 60 秒冷却，原因写明网关未公布限额（不编造重置时间）', () => {
    const cd = momaCooldownFor('rate_limited', undefined, now)!
    expect(cd.until).toBe(now + MOMA_RATE_COOLDOWN_MS)
    expect(cd.until).toBe(now + 60_000)
    expect(cd.reason).toContain('未公布')
  })
  it('额度不足无 Retry-After → 10 分钟冷却，原因写明网关未公布恢复口径', () => {
    const cd = momaCooldownFor('quota_exceeded', undefined, now)!
    expect(cd.until).toBe(now + MOMA_QUOTA_COOLDOWN_MS)
    expect(cd.reason).toContain('未公布')
  })
  it('非限流/额度状态不冷却', () => {
    expect(momaCooldownFor('auth_invalid', undefined, now)).toBeNull()
    expect(momaCooldownFor('available', undefined, now)).toBeNull()
  })
})

describe('MoMA 冒烟模型挑选（只从真实返回里挑，自营优先）', () => {
  // 形态取自 2026-11-26 公开实测列表（172 个，含非对话模型混杂）
  const realish = ['qwen/qwen4-max', 'Qwen3Guard-Gen-8B', 'CosyVoice', 'SenseVoice', 'JIUTIAN-75B-32K', 'JIUTIAN-75B-8K-Chat', 'jiutian-safe-40b', 'deepseek-v4.1-flash', 'Flux.1-dev']
  it('自营优先：挑九天对话模型（带 chat 优先于不带 chat）', () => {
    expect(pickMomaSmokeModel(realish)).toBe('JIUTIAN-75B-8K-Chat')
    expect(pickMomaSmokeModel(['qwen/qwen4-max', 'JIUTIAN-75B-32K', 'deepseek-v4.1-flash'])).toBe('JIUTIAN-75B-32K')
  })
  it('非对话模型不作冒烟候选（语音/生图/安全分类/视觉）', () => {
    expect(isMomaChatCandidate('CosyVoice')).toBe(false)
    expect(isMomaChatCandidate('SenseVoice')).toBe(false)
    expect(isMomaChatCandidate('Flux.1-dev')).toBe(false)
    expect(isMomaChatCandidate('jiutian-safe-40b')).toBe(false)
    expect(isMomaChatCandidate('qwen3-vl-32b-instruct')).toBe(false)
    expect(pickMomaSmokeModel(['CosyVoice', 'SenseVoice', 'jiutian-safe-40b'])).toBeUndefined()
    expect(pickMomaSmokeModel([])).toBeUndefined()
  })
  it('没有自营时依次 free 标记 → 开源家族 → 第一个对话候选', () => {
    expect(pickMomaSmokeModel(['gpt-x-pro', 'some-model-free'])).toBe('some-model-free')
    expect(pickMomaSmokeModel(['gpt-x-pro', 'deepseek-v4.1-flash'])).toBe('deepseek-v4.1-flash')
    expect(pickMomaSmokeModel(['gpt-x-pro', 'claude-y'])).toBe('gpt-x-pro')
  })
})

describe('MoMA 启用门槛与运行状态', () => {
  beforeEach(() => { ;(localStorage as any).clear() })
  it('未冒烟 → 待实测未启用', () => {
    const g = momaGate(acct)
    expect(g.enabled).toBe(false)
    expect(g.state).toBe('pending_verification')
    expect(g.message).toContain('健康检查')
    expect(getMomaSmokeModel(acct.id)).toBeUndefined()
  })
  it('冒烟失败 → 保持未启用并带真实状态', () => {
    recordMomaVerification(acct, 'failed', 'auth_invalid', '聊天冒烟失败：接口返回 401')
    const g = momaGate(acct)
    expect(g.enabled).toBe(false)
    expect(g.state).toBe('auth_invalid')
    expect(g.message).toContain('冒烟未通过')
  })
  it('冒烟通过 → 启用且记住用通的模型；换 Key（指纹变）→ 回到待实测', () => {
    recordMomaVerification(acct, 'verified', 'available', '冒烟通过', 'JIUTIAN-75B-8K-Chat')
    expect(momaGate(acct).enabled).toBe(true)
    expect(getMomaSmokeModel(acct.id)).toBe('JIUTIAN-75B-8K-Chat')
    expect(momaGate({ ...acct, keyFingerprint: 'fp2' }).enabled).toBe(false)
    expect(momaGate({ ...acct, keyFingerprint: 'fp2' }).state).toBe('pending_verification')
  })
  it('已验证账户真实调用 429 → 门槛转冷却未启用，原因写明口径；成功后恢复', () => {
    recordMomaVerification(acct, 'verified', 'available', '冒烟通过', 'JIUTIAN-75B-8K-Chat')
    const now = Date.UTC(2026, 10, 26, 5, 30, 0)
    recordMomaRouteFailure(acct.id, new Error('接口返回 429：rate limit exceeded'), now)
    const g = momaGate(acct, now + 1000)
    expect(g.enabled).toBe(false)
    expect(g.state).toBe('rate_limited')
    expect(g.message).toContain('未公布')
    expect(momaGate(acct, now + MOMA_RATE_COOLDOWN_MS + 1).enabled).toBe(true)
    recordMomaRouteFailure(acct.id, new Error('接口返回 429：rate limit exceeded'), now)
    recordMomaRouteSuccess(acct.id)
    expect(momaGate(acct, now + 1000).enabled).toBe(true)
  })
  it('已验证账户 401 → 标记密钥失效停用，重新冒烟通过后恢复', () => {
    recordMomaVerification(acct, 'verified', 'available', '冒烟通过', 'JIUTIAN-75B-8K-Chat')
    recordMomaRouteFailure(acct.id, new Error('接口返回 401：Authentication parameter not received in Header, unable to authenticate'))
    const g = momaGate(acct)
    expect(g.enabled).toBe(false)
    expect(g.state).toBe('auth_invalid')
    recordMomaVerification(acct, 'verified', 'available', '重新冒烟通过', 'JIUTIAN-75B-8K-Chat')
    expect(momaGate(acct).enabled).toBe(true)
  })
  it('非 moma 账户不受门槛影响', () => {
    expect(momaGate({ id: 'x', providerId: 'deepseek' }).enabled).toBe(true)
  })
})

describe('MoMA 本机用量估算', () => {
  beforeEach(() => { ;(localStorage as any).clear() })
  it('按 UTC 日累计请求与 tokens，文案标注本机估算与控制台口径', () => {
    const now = Date.UTC(2026, 10, 26, 5, 0, 0)
    recordMomaLocalUsage('mm1', 1200, now)
    recordMomaLocalUsage('mm1', 800, now + 60_000)
    const u = loadMomaLocalUsage('mm1', now + 120_000)
    expect(u.requests).toBe(2)
    expect(u.tokens).toBe(2000)
    const text = momaEstimateText('mm1', now + 120_000)
    expect(text).toContain('本机估算')
    expect(text).toContain('控制台为准')
    expect(text).toContain('2500 万免费试用')
  })
  it('跨 UTC 日自动归零', () => {
    const day1 = Date.UTC(2026, 10, 26, 23, 59, 0)
    recordMomaLocalUsage('mm1', 500, day1)
    const day2 = Date.UTC(2026, 10, 27, 0, 1, 0)
    expect(loadMomaLocalUsage('mm1', day2).requests).toBe(0)
    recordMomaLocalUsage('mm1', 300, day2)
    expect(loadMomaLocalUsage('mm1', day2).requests).toBe(1)
    expect(loadMomaLocalUsage('mm1', day2).tokens).toBe(300)
  })
  it('无 usage 返回时只记请求数、tokens 记 0（不编造）', () => {
    const now = Date.UTC(2026, 10, 26, 5, 0, 0)
    recordMomaLocalUsage('mm1', 0, now)
    expect(loadMomaLocalUsage('mm1', now)).toEqual({ day: '2026-11-26', requests: 1, tokens: 0 })
  })
})

describe('MoMA 不进自动切换链（红线）', () => {
  it('切换链类别顺序里没有 moma', () => {
    expect(CHAIN_KIND_ORDER).not.toContain('moma')
  })
})

describe('MoMA 健康检查 = 真实冒烟（mock 网络验证状态机）', () => {
  beforeEach(() => { ;(localStorage as any).clear() })
  afterEach(() => vi.unstubAllGlobals())
  const account = {
    id: 'mm1', providerId: 'moma', label: 'MoMA', mode: 'api' as const,
    apiUrl: 'https://zhenze-huhehaote.cmecloud.cn/v1', encryptedKey: 'enc', keyFingerprint: 'fp1',
    modelCapability: 'chat' as const, note: '[通用型]', createdAt: '2026-01-01', updatedAt: '2026-01-01',
  }
  it('未解锁（无 Key）→ 待实测、零请求', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { checkKeyHealth } = await import('./healthCheck')
    const r = await checkKeyHealth(account, undefined)
    expect(r.status).toBe('pending')
    expect(r.message).toContain('待实测')
    expect(fetchMock.mock.calls.length).toBe(0)
    expect(momaGate(account).enabled).toBe(false)
  })
  it('模型列表 + 九天冒烟通过 → 已验证启用，记住冒烟模型', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: { body?: string }) => {
      if (String(url).includes('/models')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'qwen/qwen4-max' }, { id: 'CosyVoice' }, { id: 'JIUTIAN-75B-8K-Chat' }] }) }
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'OK' } }], usage: { total_tokens: 5 } }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    const { checkKeyHealth } = await import('./healthCheck')
    const r = await checkKeyHealth(account, 'test-key')
    expect(r.status).toBe('ok')
    expect(r.modelCount).toBe(3)
    expect(r.message).toContain('JIUTIAN-75B-8K-Chat')
    expect(r.message).toContain('2500 万免费试用')
    expect(momaGate(account).enabled).toBe(true)
    expect(getMomaSmokeModel('mm1')).toBe('JIUTIAN-75B-8K-Chat')
    // 聊天请求发的确实是九天模型（冒烟优先自营的证据）
    const chatCall = fetchMock.mock.calls.find(c => String(c[0]).includes('/chat/completions'))
    expect(chatCall).toBeTruthy()
    expect(JSON.parse((chatCall![1] as any).body).model).toBe('JIUTIAN-75B-8K-Chat')
  })
  it('聊天 401（官方实测信封）→ 密钥失效、保持未启用、原文透传', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/models')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'JIUTIAN-75B-8K-Chat' }] }) }
      }
      return { ok: false, status: 401, text: async () => '{"error":{"code":"1001","message":"Authentication parameter not received in Header, unable to authenticate"}}' }
    })
    vi.stubGlobal('fetch', fetchMock)
    const { checkKeyHealth } = await import('./healthCheck')
    const r = await checkKeyHealth(account, 'bad-key')
    expect(r.status).toBe('auth')
    expect(r.message).toContain('Authentication parameter not received')
    const g = momaGate(account)
    expect(g.enabled).toBe(false)
    expect(g.state).toBe('auth_invalid')
  })
})

describe('MoMA 工坊路线门槛（v0.1.456）', () => {
  beforeEach(() => { ;(localStorage as any).clear() })
  afterEach(() => vi.unstubAllGlobals())
  const account = {
    id: 'mm1', providerId: 'moma', label: 'MoMA', mode: 'api' as const,
    apiUrl: 'https://zhenze-huhehaote.cmecloud.cn/v1', encryptedKey: 'enc', keyFingerprint: 'fp1',
    modelCapability: 'chat' as const, note: '[通用型]', createdAt: '2026-01-01', updatedAt: '2026-01-01',
  }
  it('未冒烟的 MoMA 路线带 disabledReason，发送时原样抛真实原因且零调用', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const { loadWorkshopRoutes, runWorkshopChat } = await import('./workshopChat')
    const { routes } = await loadWorkshopRoutes([account])
    const route = routes.find(r => r.kind === 'account')
    expect(route).toBeTruthy()
    expect((route as { label: string }).label).toContain('待实测')
    expect((route as { disabledReason?: string }).disabledReason).toContain('健康检查')
    const callsBefore = fetchMock.mock.calls.length
    let errMsg = ''
    try {
      await runWorkshopChat({
        route: route!, freeOptions: [], accounts: [account],
        sessionPwd: 'pwd', system: 's', user: 'u',
      })
    } catch (e) { errMsg = e instanceof Error ? e.message : String(e) }
    expect(errMsg).toContain('待实测')
    expect(fetchMock.mock.calls.length).toBe(callsBefore) // 门槛拦截发生在解密/发请求之前
  })
  it('冒烟通过的 MoMA 账户不进自动切换链候选（红线），但工坊模型用冒烟用通的模型', async () => {
    const { buildWorkshopChainRoutes, resolveWorkshopModel } = await import('./workshopChat')
    recordMomaVerification(account, 'verified', 'available', '冒烟通过', 'JIUTIAN-75B-8K-Chat')
    const chain = await buildWorkshopChainRoutes({
      route: { kind: 'free', key: 'free:up:zen:m', label: '免费 · M' },
      freeOptions: [], accounts: [account], sessionPwd: 'pwd', system: 's', user: 'u',
    })
    expect(chain.some(r => r.key === 'acct:mm1')).toBe(false)
    expect(resolveWorkshopModel(account)).toBe('JIUTIAN-75B-8K-Chat')
  })
})
