// AnyAPI.ai 接入（v0.1.435）：平台预设、无余额接口口径、健康状态机、启用门槛、
// 429 冷却口径、本机用量估算、冒烟模型挑选。沙箱无 Ethan 的真实 Key：聊天冒烟用
// mock 验证状态机；公开侧已实测 GET /v1/models 无 Key 返回 401
// {"error":{"message":"Invalid credentials","type":"auth_error","code":"401"}}
// （docs.anyapi.ai 确认端点与免费档：每天 100,000 AnyTokens、仅基础/免费模型）。
// 真实 Key 的冒烟待 Ethan 在 App 里加 Key 后实测（健康检查即冒烟入口）。
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { PROVIDER_MAP } from '../data/providers'
import { ENGINE_CATALOG } from '../data/engines'
import { getAdapter, NO_BALANCE_API_NOTE } from './adapters'
import {
  classifyAnyApiHttp, anyApiStateFromError, AnyApiApiError, anyApiGate, recordAnyApiVerification,
  anyApiCooldownFor, recordAnyApiRouteFailure, recordAnyApiRouteSuccess,
  recordAnyApiLocalUsage, loadAnyApiLocalUsage, anyApiEstimateText, anyApiLimitsText,
  pickAnyApiSmokeModel, getAnyApiSmokeModel,
  ANYAPI_FREE_LIMITS, ANYAPI_BASE, ANYAPI_RATE_COOLDOWN_MS, ANYAPI_QUOTA_COOLDOWN_MS,
} from './anyapi'
import { orderChainCandidates, CHAIN_KIND_ORDER } from './freeChain'

vi.mock('./crypto', () => ({ decryptSecret: async () => 'test-key' }))

class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}
;(globalThis as any).localStorage = new MemStorage()

const acct = { id: 'aa1', providerId: 'anyapi', keyFingerprint: 'fp1' }

describe('AnyAPI 平台预设', () => {
  it('目录里有 anyapi，Base URL 与官方一致', () => {
    const p = PROVIDER_MAP['anyapi']
    expect(p).toBeTruthy()
    expect(p.apiBaseUrl).toBe(ANYAPI_BASE)
    expect(p.apiBaseUrl).toBe('https://api.anyapi.ai/v1')
    expect(p.note).toContain('无公开余额接口')
    expect(p.note).toContain('100,000 AnyTokens')
  })
  it('无公开余额接口：适配器不支持自动查余额，提示去控制台手动录入', () => {
    expect(getAdapter('anyapi').supported).toBe(false)
    expect(NO_BALANCE_API_NOTE['anyapi']).toContain('无公开余额接口')
    expect(NO_BALANCE_API_NOTE['anyapi']).toContain('手动录入')
  })
  it('引擎目录不预置模型：官网无可核实的免费模型 id 清单，只走 /v1/models 动态拉取', () => {
    expect(ENGINE_CATALOG['anyapi']).toBeUndefined()
  })
  it('免费档常量与官方一致，界面文案如实标注（限额不编造数字）', () => {
    expect(ANYAPI_FREE_LIMITS.dailyAnyTokens).toBe(100_000)
    const text = anyApiLimitsText()
    expect(text).toContain('100,000 AnyTokens')
    expect(text).toContain('免绑卡')
    expect(text).toContain('官网未公布具体限额')
    expect(text).toContain('无公开余额接口')
  })
})

describe('AnyAPI 状态归类', () => {
  it('HTTP 状态归类与 Inferbase / One AI 同口径（401 用官方实测原文）', () => {
    expect(classifyAnyApiHttp(401, 'Invalid credentials').state).toBe('auth_invalid')
    expect(classifyAnyApiHttp(403, 'forbidden').state).toBe('auth_invalid')
    expect(classifyAnyApiHttp(402, 'insufficient credit').state).toBe('quota_exceeded')
    expect(classifyAnyApiHttp(429, 'too many', 30).state).toBe('rate_limited')
    expect(classifyAnyApiHttp(429, 'too many', 30).retryAfterSec).toBe(30)
    expect(classifyAnyApiHttp(404, 'model not found').state).toBe('model_unavailable')
    expect(classifyAnyApiHttp(500, 'boom').state).toBe('error')
    // v0.1.464：400 model_not_found（官方措辞 code + "is not available"）如实归类
    expect(classifyAnyApiHttp(400, 'The requested model is not available on this endpoint.').state).toBe('model_unavailable')
    expect(classifyAnyApiHttp(400, 'model_not_found').state).toBe('model_unavailable')
    expect(anyApiStateFromError(new Error('接口返回 400：{"error":{"code":"model_not_found","message":"The requested model is not available on this endpoint."}}'))).toBe('model_unavailable')
  })
  it('文本错误归类保留原文', () => {
    expect(anyApiStateFromError(new Error('接口返回 429：rate limit'))).toBe('rate_limited')
    expect(anyApiStateFromError(new Error('接口返回 401：Invalid credentials'))).toBe('auth_invalid')
    expect(anyApiStateFromError(new Error('Failed to fetch'))).toBe('network_error')
    expect(anyApiStateFromError(new AnyApiApiError('x', 'quota_exceeded'))).toBe('quota_exceeded')
  })
})

describe('AnyAPI 冷却口径', () => {
  const now = Date.UTC(2026, 10, 26, 5, 30, 0) // 2026-11-26 05:30 UTC
  it('有 Retry-After 用 Retry-After 并写明口径', () => {
    const cd = anyApiCooldownFor('rate_limited', 120, now)!
    expect(cd.until).toBe(now + 120_000)
    expect(cd.reason).toContain('Retry-After')
  })
  it('429 无 Retry-After → 60 秒冷却，原因写明官网未公布限额（不编造重置时间）', () => {
    const cd = anyApiCooldownFor('rate_limited', undefined, now)!
    expect(cd.until).toBe(now + ANYAPI_RATE_COOLDOWN_MS)
    expect(cd.until).toBe(now + 60_000)
    expect(cd.reason).toContain('官网未公布')
  })
  it('额度不足无 Retry-After → 10 分钟冷却，原因写明官网未公布恢复口径', () => {
    const cd = anyApiCooldownFor('quota_exceeded', undefined, now)!
    expect(cd.until).toBe(now + ANYAPI_QUOTA_COOLDOWN_MS)
    expect(cd.reason).toContain('官网未公布')
  })
  it('非限流/额度状态不冷却', () => {
    expect(anyApiCooldownFor('auth_invalid', undefined, now)).toBeNull()
    expect(anyApiCooldownFor('available', undefined, now)).toBeNull()
  })
})

describe('AnyAPI 冒烟模型挑选（只从真实返回里挑）', () => {
  it('优先 id 带 free 标记的', () => {
    expect(pickAnyApiSmokeModel(['gpt-x-pro', 'some-model-free', 'llama-y'])).toBe('some-model-free')
  })
  it('没有 free 标记时选开源权重家族', () => {
    expect(pickAnyApiSmokeModel(['gpt-x-pro', 'meta-llama/llama-3.1-8b'])).toBe('meta-llama/llama-3.1-8b')
  })
  it('都没有就用列表第一个；空列表返回 undefined', () => {
    expect(pickAnyApiSmokeModel(['gpt-x-pro', 'claude-y'])).toBe('gpt-x-pro')
    expect(pickAnyApiSmokeModel([])).toBeUndefined()
  })
})

describe('AnyAPI 启用门槛与运行状态', () => {
  beforeEach(() => { ;(localStorage as any).clear() })
  it('未冒烟 → 待实测未启用', () => {
    const g = anyApiGate(acct)
    expect(g.enabled).toBe(false)
    expect(g.state).toBe('pending_verification')
    expect(g.message).toContain('健康检查')
    expect(getAnyApiSmokeModel(acct.id)).toBeUndefined()
  })
  it('冒烟失败 → 保持未启用并带真实状态', () => {
    recordAnyApiVerification(acct, 'failed', 'auth_invalid', '模型列表拉取失败：接口返回 401')
    const g = anyApiGate(acct)
    expect(g.enabled).toBe(false)
    expect(g.state).toBe('auth_invalid')
    expect(g.message).toContain('冒烟未通过')
  })
  it('冒烟通过 → 启用且记住用通的模型；换 Key（指纹变）→ 回到待实测', () => {
    recordAnyApiVerification(acct, 'verified', 'available', '冒烟通过', 'meta-llama/llama-3.1-8b')
    expect(anyApiGate(acct).enabled).toBe(true)
    expect(getAnyApiSmokeModel(acct.id)).toBe('meta-llama/llama-3.1-8b')
    expect(anyApiGate({ ...acct, keyFingerprint: 'fp2' }).enabled).toBe(false)
    expect(anyApiGate({ ...acct, keyFingerprint: 'fp2' }).state).toBe('pending_verification')
  })
  it('已验证账户真实调用 429 → 门槛转冷却未启用，原因写明口径；成功后恢复', () => {
    recordAnyApiVerification(acct, 'verified', 'available', '冒烟通过', 'm1')
    const now = Date.UTC(2026, 10, 26, 5, 30, 0)
    recordAnyApiRouteFailure(acct.id, new Error('接口返回 429：rate limit exceeded'), now)
    const g = anyApiGate(acct, now + 1000)
    expect(g.enabled).toBe(false)
    expect(g.state).toBe('rate_limited')
    expect(g.message).toContain('官网未公布')
    // 冷却到期后恢复可用
    expect(anyApiGate(acct, now + ANYAPI_RATE_COOLDOWN_MS + 1).enabled).toBe(true)
    // 再次失败后一次成功清掉运行状态
    recordAnyApiRouteFailure(acct.id, new Error('接口返回 429：rate limit exceeded'), now)
    recordAnyApiRouteSuccess(acct.id)
    expect(anyApiGate(acct, now + 1000).enabled).toBe(true)
  })
  it('已验证账户 401 → 标记密钥失效停用，重新冒烟通过后恢复', () => {
    recordAnyApiVerification(acct, 'verified', 'available', '冒烟通过', 'm1')
    recordAnyApiRouteFailure(acct.id, new Error('接口返回 401：Invalid credentials'))
    const g = anyApiGate(acct)
    expect(g.enabled).toBe(false)
    expect(g.state).toBe('auth_invalid')
    recordAnyApiVerification(acct, 'verified', 'available', '重新冒烟通过', 'm1')
    expect(anyApiGate(acct).enabled).toBe(true)
  })
  it('非 anyapi 账户不受门槛影响', () => {
    expect(anyApiGate({ id: 'x', providerId: 'deepseek' }).enabled).toBe(true)
  })
})

describe('AnyAPI 本机用量估算', () => {
  beforeEach(() => { ;(localStorage as any).clear() })
  it('按 UTC 日累计请求与 tokens，文案标注本机估算与 AnyTokens 口径', () => {
    const now = Date.UTC(2026, 10, 26, 5, 0, 0)
    recordAnyApiLocalUsage('aa1', 1200, now)
    recordAnyApiLocalUsage('aa1', 800, now + 60_000)
    const u = loadAnyApiLocalUsage('aa1', now + 120_000)
    expect(u.requests).toBe(2)
    expect(u.tokens).toBe(2000)
    const text = anyApiEstimateText('aa1', now + 120_000)
    expect(text).toContain('本机估算')
    expect(text).toContain('AnyTokens')
    expect(text).toContain('100,000')
  })
  it('跨 UTC 日自动归零', () => {
    const day1 = Date.UTC(2026, 10, 26, 23, 59, 0)
    recordAnyApiLocalUsage('aa1', 500, day1)
    const day2 = Date.UTC(2026, 10, 27, 0, 1, 0)
    expect(loadAnyApiLocalUsage('aa1', day2).requests).toBe(0)
    recordAnyApiLocalUsage('aa1', 300, day2)
    expect(loadAnyApiLocalUsage('aa1', day2).requests).toBe(1)
    expect(loadAnyApiLocalUsage('aa1', day2).tokens).toBe(300)
  })
  it('无 usage 返回时只记请求数、tokens 记 0（不编造）', () => {
    const now = Date.UTC(2026, 10, 26, 5, 0, 0)
    recordAnyApiLocalUsage('aa1', 0, now)
    expect(loadAnyApiLocalUsage('aa1', now)).toEqual({ day: '2026-11-26', requests: 1, tokens: 0 })
  })
})

describe('AnyAPI 进 433 切换链的顺序', () => {
  it('anyapi 在 oneai 之后、wbpool 之前、apisfree 兜底之前', () => {
    const idx = (k: string) => CHAIN_KIND_ORDER.indexOf(k)
    expect(idx('anyapi')).toBeGreaterThan(idx('oneai'))
    expect(idx('anyapi')).toBeLessThan(idx('wbpool'))
    expect(idx('anyapi')).toBeLessThan(idx('apisfree'))
    const ordered = orderChainCandidates('sel', [
      { id: 'a', kind: 'apisfree' }, { id: 'b', kind: 'anyapi' }, { id: 'c', kind: 'zen' },
    ])
    expect(ordered.map(x => x.id)).toEqual(['c', 'b', 'a'])
  })
})

describe('AnyAPI 工坊路线门槛（v0.1.435）', () => {
  beforeEach(() => { ;(localStorage as any).clear() })
  afterEach(() => vi.unstubAllGlobals())
  it('未冒烟的 AnyAPI 路线带 disabledReason，发送时原样抛真实原因且零调用', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const { loadWorkshopRoutes, runWorkshopChat } = await import('./workshopChat')
    const account = {
      id: 'aa1', providerId: 'anyapi', label: 'AnyAPI', mode: 'api' as const,
      apiUrl: 'https://api.anyapi.ai/v1', encryptedKey: 'enc', modelCapability: 'chat' as const,
      note: '[通用型]', createdAt: '2026-01-01', updatedAt: '2026-01-01',
    }
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
  it('冒烟通过的 AnyAPI 账户进自动切换链候选，且工坊模型用冒烟用通的模型', async () => {
    const { buildWorkshopChainRoutes, resolveWorkshopModel } = await import('./workshopChat')
    const account = {
      id: 'aa1', providerId: 'anyapi', label: 'AnyAPI', mode: 'api' as const,
      apiUrl: 'https://api.anyapi.ai/v1', encryptedKey: 'enc', modelCapability: 'chat' as const,
      note: '[通用型]', createdAt: '2026-01-01', updatedAt: '2026-01-01',
    }
    recordAnyApiVerification(account, 'verified', 'available', '冒烟通过', 'meta-llama/llama-3.1-8b')
    const chain = await buildWorkshopChainRoutes({
      route: { kind: 'free', key: 'free:up:zen:m', label: '免费 · M' },
      freeOptions: [], accounts: [account], sessionPwd: 'pwd', system: 's', user: 'u',
    })
    expect(chain.some(r => r.key === 'acct:aa1')).toBe(true)
    expect(resolveWorkshopModel(account)).toBe('meta-llama/llama-3.1-8b')
  })
})
