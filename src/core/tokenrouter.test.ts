// TokenRouter 接入（v0.1.514）：第 62 个平台——平台预设、精选清单（3 个、免费置顶、
// 付费标价）、无余额接口口径、状态归类、冷却口径、启用门槛、免费链末位、本机估算。
// 沙箱无 Ethan 的真实 Key：聊天冒烟用状态机验证；真实 Key 的冒烟待 Ethan 在 App 里
// 加 Key 后实测（健康检查即冒烟入口）。平台事实 2026-11-27 经主聊天双来源核查：
// 免费 deepseek/deepseek-v4.1-flash-1017-free 与 nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free、
// 付费 deepseek-v4.1-flash-1017 约 $0.075–0.08/$0.30 每百万 tokens。
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { PROVIDERS, PROVIDER_MAP } from '../data/providers'
import { ENGINE_CATALOG, enginesFor } from '../data/engines'
import { getAdapter, NO_BALANCE_API_NOTE } from './adapters'
import {
  classifyTokenRouterHttp, tokenRouterStateFromError, TokenRouterApiError, tokenRouterGate,
  recordTokenRouterVerification, tokenRouterCooldownFor, recordTokenRouterRouteFailure,
  recordTokenRouterRouteSuccess, recordTokenRouterLocalUsage, loadTokenRouterLocalUsage,
  tokenRouterEstimateText, tokenRouterLimitsText, pickTokenRouterSmokeModel, getTokenRouterSmokeModel,
  isTokenRouterFreeModel, tokenRouterModelPriceNote,
  TOKENROUTER_MODELS, TOKENROUTER_FREE_MODELS, TOKENROUTER_SMOKE_MODEL,
  TOKENROUTER_BASE, TOKENROUTER_RATE_COOLDOWN_MS, TOKENROUTER_QUOTA_COOLDOWN_MS,
} from './tokenrouter'
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

const acct = { id: 'tr1', providerId: 'tokenrouter', keyFingerprint: 'fp1' }

describe('TokenRouter 平台预设（第 62 个平台）', () => {
  it('目录里有 tokenrouter，总数 62，Base URL 是官方网关', () => {
    expect(PROVIDERS.length).toBe(62)
    const p = PROVIDER_MAP['tokenrouter']
    expect(p).toBeTruthy()
    expect(p.name).toBe('TokenRouter')
    expect(p.apiBaseUrl).toBe(TOKENROUTER_BASE)
    expect(p.apiBaseUrl).toBe('https://api.tokenrouter.com/v1')
    expect(p.apiKeyUrl).toMatch(/^https:\/\//)
  })
  it('平台说明如实写风险：第三方中转 / 不要跑敏感内容 / 免费额度未公布 / 免费随时下线 / 无公开余额接口', () => {
    const p = PROVIDER_MAP['tokenrouter']
    expect(p.note).toContain('第三方中转')
    expect(p.note).toContain('不要跑敏感内容')
    expect(p.note).toContain('免费额度未公布')
    expect(p.note).toContain('无公开余额接口')
    expect(p.note).toContain('随时可能下线')
    const text = tokenRouterLimitsText()
    expect(text).toContain('第三方中转')
    expect(text).toContain('不要用它跑敏感内容')
    expect(text).toContain('免费额度未公布')
    expect(text).toContain('随时可能下线')
    expect(text).toContain('下线后会如实显示不可用')
  })
  it('无公开余额接口：适配器不支持自动查余额，提示去控制台手动录入，不编造数字', () => {
    expect(getAdapter('tokenrouter').supported).toBe(false)
    expect(NO_BALANCE_API_NOTE['tokenrouter']).toContain('无公开余额接口')
    expect(NO_BALANCE_API_NOTE['tokenrouter']).toContain('免费额度未公布')
    expect(NO_BALANCE_API_NOTE['tokenrouter']).toContain('手动录入')
  })
})

describe('TokenRouter 精选清单（不拉全量）', () => {
  it('只有 3 个模型：两个免费置顶、付费版在最后并明确标价', () => {
    expect(TOKENROUTER_MODELS.length).toBe(3)
    expect(TOKENROUTER_MODELS[0]).toMatchObject({ id: 'deepseek/deepseek-v4.1-flash-1017-free', free: true })
    expect(TOKENROUTER_MODELS[1]).toMatchObject({ id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', free: true })
    expect(TOKENROUTER_MODELS[2]).toMatchObject({ id: 'deepseek-v4.1-flash-1017', free: false })
    expect(TOKENROUTER_MODELS[2].priceNote).toContain('$0.30')
    expect(TOKENROUTER_FREE_MODELS).toEqual([
      'deepseek/deepseek-v4.1-flash-1017-free',
      'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    ])
    expect(TOKENROUTER_SMOKE_MODEL).toBe('deepseek/deepseek-v4.1-flash-1017-free')
  })
  it('免费判定与标价标注：付费版永不算免费，清单外不猜价', () => {
    expect(isTokenRouterFreeModel('deepseek/deepseek-v4.1-flash-1017-free')).toBe(true)
    expect(isTokenRouterFreeModel('nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free')).toBe(true)
    expect(isTokenRouterFreeModel('deepseek-v4.1-flash-1017')).toBe(false)
    expect(tokenRouterModelPriceNote('deepseek-v4.1-flash-1017')).toContain('付费')
    expect(tokenRouterModelPriceNote('unknown/model-x')).toContain('未收录')
  })
  it('引擎目录与精选清单同一份：3 个、免费在前（倍率 0）、付费版倍率 > 0', () => {
    const engines = enginesFor('tokenrouter')
    expect(engines.map(e => e.id)).toEqual(TOKENROUTER_MODELS.map(m => m.id))
    expect(ENGINE_CATALOG['tokenrouter']!.filter(e => e.multiplier === 0).map(e => e.id)).toEqual(TOKENROUTER_FREE_MODELS)
    expect(engines[2].multiplier).toBeGreaterThan(0)
    expect(engines.find(e => e.id === TOKENROUTER_SMOKE_MODEL)?.flagship).toBe(true)
  })
  it('冒烟模型恒为免费款：清单里挑第一个免费，清单异常时回落免费主力常量', () => {
    expect(pickTokenRouterSmokeModel(TOKENROUTER_MODELS.map(m => m.id))).toBe(TOKENROUTER_SMOKE_MODEL)
    expect(pickTokenRouterSmokeModel(['deepseek-v4.1-flash-1017'])).toBe(TOKENROUTER_SMOKE_MODEL)
    expect(isTokenRouterFreeModel(pickTokenRouterSmokeModel([]))).toBe(true)
  })
})

describe('TokenRouter 状态归类', () => {
  it('HTTP 状态归类与 AnyAPI / MoMA 同口径', () => {
    expect(classifyTokenRouterHttp(401, 'Invalid API key').state).toBe('auth_invalid')
    expect(classifyTokenRouterHttp(403, 'forbidden').state).toBe('auth_invalid')
    expect(classifyTokenRouterHttp(402, 'insufficient credit').state).toBe('quota_exceeded')
    expect(classifyTokenRouterHttp(429, 'too many', 30).state).toBe('rate_limited')
    expect(classifyTokenRouterHttp(429, 'too many', 30).retryAfterSec).toBe(30)
    expect(classifyTokenRouterHttp(404, 'model not found').state).toBe('model_unavailable')
    expect(classifyTokenRouterHttp(500, 'boom').state).toBe('error')
  })
  it('免费模型下线（model_not_found）最先归类，不被误判成额度/限流', () => {
    expect(classifyTokenRouterHttp(400, 'model_not_found').state).toBe('model_unavailable')
    expect(classifyTokenRouterHttp(400, 'The requested model is not available on this endpoint.').state).toBe('model_unavailable')
    expect(tokenRouterStateFromError(new Error('接口返回 400：{"error":{"code":"model_not_found","message":"model is not available, quota plan n/a"}}'))).toBe('model_unavailable')
  })
  it('文本错误归类保留原文', () => {
    expect(tokenRouterStateFromError(new Error('接口返回 429：rate limit'))).toBe('rate_limited')
    expect(tokenRouterStateFromError(new Error('接口返回 401：unauthorized'))).toBe('auth_invalid')
    expect(tokenRouterStateFromError(new Error('Failed to fetch'))).toBe('network_error')
    expect(tokenRouterStateFromError(new TokenRouterApiError('x', 'quota_exceeded'))).toBe('quota_exceeded')
  })
})

describe('TokenRouter 冷却口径', () => {
  const now = Date.UTC(2026, 10, 28, 5, 30, 0)
  it('有 Retry-After 用 Retry-After 并写明口径', () => {
    const cd = tokenRouterCooldownFor('rate_limited', 120, now)!
    expect(cd.until).toBe(now + 120_000)
    expect(cd.reason).toContain('Retry-After')
  })
  it('429 无 Retry-After → 60 秒冷却，原因写明平台未公布限额（不编造重置时间）', () => {
    const cd = tokenRouterCooldownFor('rate_limited', undefined, now)!
    expect(cd.until).toBe(now + TOKENROUTER_RATE_COOLDOWN_MS)
    expect(cd.until).toBe(now + 60_000)
    expect(cd.reason).toContain('未公布')
  })
  it('额度不足无 Retry-After → 10 分钟冷却，原因写明平台未公布恢复口径', () => {
    const cd = tokenRouterCooldownFor('quota_exceeded', undefined, now)!
    expect(cd.until).toBe(now + TOKENROUTER_QUOTA_COOLDOWN_MS)
    expect(cd.reason).toContain('未公布')
  })
  it('非限流/额度状态不冷却', () => {
    expect(tokenRouterCooldownFor('auth_invalid', undefined, now)).toBeNull()
    expect(tokenRouterCooldownFor('model_unavailable', undefined, now)).toBeNull()
    expect(tokenRouterCooldownFor('available', undefined, now)).toBeNull()
  })
})

describe('TokenRouter 启用门槛与运行状态', () => {
  beforeEach(() => { ;(localStorage as any).clear() })
  it('未冒烟 → 待实测未启用', () => {
    const g = tokenRouterGate(acct)
    expect(g.enabled).toBe(false)
    expect(g.state).toBe('pending_verification')
    expect(g.message).toContain('健康检查')
    expect(getTokenRouterSmokeModel(acct.id)).toBeUndefined()
  })
  it('冒烟失败 → 保持未启用并带真实状态', () => {
    recordTokenRouterVerification(acct, 'failed', 'auth_invalid', '聊天冒烟失败：接口返回 401')
    const g = tokenRouterGate(acct)
    expect(g.enabled).toBe(false)
    expect(g.state).toBe('auth_invalid')
    expect(g.message).toContain('冒烟未通过')
  })
  it('冒烟通过 → 启用且记住用通的免费模型；换 Key（指纹变）→ 回到待实测', () => {
    recordTokenRouterVerification(acct, 'verified', 'available', '冒烟通过', TOKENROUTER_SMOKE_MODEL)
    expect(tokenRouterGate(acct).enabled).toBe(true)
    expect(getTokenRouterSmokeModel(acct.id)).toBe(TOKENROUTER_SMOKE_MODEL)
    expect(isTokenRouterFreeModel(getTokenRouterSmokeModel(acct.id)!)).toBe(true)
    expect(tokenRouterGate({ ...acct, keyFingerprint: 'fp2' }).enabled).toBe(false)
    expect(tokenRouterGate({ ...acct, keyFingerprint: 'fp2' }).state).toBe('pending_verification')
  })
  it('已验证账户真实调用 429 → 门槛转冷却未启用；冷却到期恢复；成功清状态', () => {
    recordTokenRouterVerification(acct, 'verified', 'available', '冒烟通过', TOKENROUTER_SMOKE_MODEL)
    const now = Date.UTC(2026, 10, 28, 5, 30, 0)
    recordTokenRouterRouteFailure(acct.id, new Error('接口返回 429：rate limit exceeded'), now)
    const g = tokenRouterGate(acct, now + 1000)
    expect(g.enabled).toBe(false)
    expect(g.state).toBe('rate_limited')
    expect(tokenRouterGate(acct, now + TOKENROUTER_RATE_COOLDOWN_MS + 1).enabled).toBe(true)
    recordTokenRouterRouteFailure(acct.id, new Error('接口返回 429：rate limit exceeded'), now)
    recordTokenRouterRouteSuccess(acct.id)
    expect(tokenRouterGate(acct, now + 1000).enabled).toBe(true)
  })
  it('已验证账户 401 → 标记密钥失效停用，重新冒烟通过后恢复', () => {
    recordTokenRouterVerification(acct, 'verified', 'available', '冒烟通过', TOKENROUTER_SMOKE_MODEL)
    recordTokenRouterRouteFailure(acct.id, new Error('接口返回 401：Invalid API key'))
    const g = tokenRouterGate(acct)
    expect(g.enabled).toBe(false)
    expect(g.state).toBe('auth_invalid')
    recordTokenRouterVerification(acct, 'verified', 'available', '重新冒烟通过', TOKENROUTER_SMOKE_MODEL)
    expect(tokenRouterGate(acct).enabled).toBe(true)
  })
  it('非 tokenrouter 账户不受门槛影响', () => {
    expect(tokenRouterGate({ id: 'x', providerId: 'deepseek' }).enabled).toBe(true)
  })
})

describe('TokenRouter 免费链落位（末位）', () => {
  it('CHAIN_KIND_ORDER 里 tokenrouter 在 apisfree 之后、是全链最后一类', () => {
    expect(CHAIN_KIND_ORDER[CHAIN_KIND_ORDER.length - 1]).toBe('tokenrouter')
    expect(CHAIN_KIND_ORDER.indexOf('tokenrouter')).toBeGreaterThan(CHAIN_KIND_ORDER.indexOf('apisfree'))
    expect(CHAIN_KIND_ORDER.indexOf('tokenrouter')).toBeGreaterThan(CHAIN_KIND_ORDER.indexOf('wbpool'))
    expect(CHAIN_KIND_ORDER.indexOf('tokenrouter')).toBeGreaterThan(CHAIN_KIND_ORDER.indexOf('anyapi'))
    expect(CHAIN_KIND_ORDER.indexOf('tokenrouter')).toBeGreaterThan(CHAIN_KIND_ORDER.indexOf('inferbase'))
  })
  it('orderChainCandidates：无首选时 tokenrouter 排在 apisfree / wbpool / anyapi 之后', () => {
    const list = [
      { id: 'tr', kind: 'tokenrouter' }, { id: 'af', kind: 'apisfree' }, { id: 'wp', kind: 'wbpool' },
      { id: 'aa', kind: 'anyapi' }, { id: 'ib', kind: 'inferbase' }, { id: 'cl', kind: 'cloud' },
    ]
    expect(orderChainCandidates('', list).map(x => x.id)).toEqual(['cl', 'ib', 'aa', 'wp', 'af', 'tr'])
  })
})

describe('TokenRouter 本机用量估算', () => {
  beforeEach(() => { ;(localStorage as any).clear() })
  it('按 UTC 日累计请求与 tokens，文案标注本机估算与免费额度未公布', () => {
    const now = Date.UTC(2026, 10, 28, 5, 0, 0)
    recordTokenRouterLocalUsage('tr1', 1200, now)
    recordTokenRouterLocalUsage('tr1', 800, now + 60_000)
    const u = loadTokenRouterLocalUsage('tr1', now + 120_000)
    expect(u.requests).toBe(2)
    expect(u.tokens).toBe(2000)
    const text = tokenRouterEstimateText('tr1', now + 120_000)
    expect(text).toContain('本机估算')
    expect(text).toContain('免费额度未公布')
  })
  it('跨 UTC 日自动归零；无 usage 时只记请求数（不编造）', () => {
    const day1 = Date.UTC(2026, 10, 28, 23, 59, 0)
    recordTokenRouterLocalUsage('tr1', 500, day1)
    const day2 = Date.UTC(2026, 10, 29, 0, 1, 0)
    expect(loadTokenRouterLocalUsage('tr1', day2).requests).toBe(0)
    recordTokenRouterLocalUsage('tr1', 0, day2)
    expect(loadTokenRouterLocalUsage('tr1', day2)).toEqual({ day: '2026-11-29', requests: 1, tokens: 0 })
  })
})
