// One AI API Key 接入（v0.1.434）：平台预设、无余额接口口径、健康状态机、启用门槛、
// 429 的 UTC 零点冷却、本机用量估算。沙箱无 Ethan 的真实 Key：聊天冒烟用 mock 验证
// 状态机；公开侧已实测 GET /v1/models 无 Key 返回 401（官方文档确认该端点存在）。
// 真实 Key 的冒烟待 Ethan 在 App 里加 Key 后实测（健康检查即冒烟入口）。
import { describe, it, expect, beforeEach } from 'vitest'
import { PROVIDER_MAP } from '../data/providers'
import { ENGINE_CATALOG } from '../data/engines'
import { getAdapter, NO_BALANCE_API_NOTE } from './adapters'
import {
  classifyOneAiHttp, oneAiStateFromError, OneAiApiError, oneAiGate, recordOneAiVerification,
  oneAiCooldownFor, nextUtcMidnight, recordOneAiRouteFailure, recordOneAiRouteSuccess,
  recordOneAiLocalUsage, loadOneAiLocalUsage, oneAiEstimateText, oneAiLimitsText,
  ONEAI_FREE_LIMITS, ONEAI_SMOKE_MODEL, ONEAI_BASE,
} from './oneai'
import { orderChainCandidates, CHAIN_KIND_ORDER } from './freeChain'

class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}
;(globalThis as any).localStorage = new MemStorage()

const acct = { id: 'oa1', providerId: 'oneai', keyFingerprint: 'fp1' }

describe('One AI 平台预设', () => {
  it('目录里有 oneai，Base URL 与官方一致', () => {
    const p = PROVIDER_MAP['oneai']
    expect(p).toBeTruthy()
    expect(p.apiBaseUrl).toBe(ONEAI_BASE)
    expect(p.apiBaseUrl).toBe('https://api.oneaiapikey.com/v1')
    expect(p.note).toContain('Anthropic 兼容入口')
    expect(p.note).toContain('无公开余额接口')
  })
  it('无公开余额接口：适配器不支持自动查余额，提示去控制台手动录入', () => {
    expect(getAdapter('oneai').supported).toBe(false)
    expect(NO_BALANCE_API_NOTE['oneai']).toContain('无公开余额接口')
    expect(NO_BALANCE_API_NOTE['oneai']).toContain('手动录入')
  })
  it('引擎目录是官方 :free 真实 id，冒烟款是旗舰免费款', () => {
    const list = ENGINE_CATALOG['oneai']
    expect(list?.length).toBeGreaterThan(0)
    expect(list.every(e => e.id.endsWith(':free'))).toBe(true)
    expect(list.find(e => e.flagship)?.id).toBe(ONEAI_SMOKE_MODEL)
    expect(list.some(e => e.id === 'moonshotai-kimi-k3.1-pro:free')).toBe(true)
  })
  it('免费档限额常量与官方一致，界面文案如实标注', () => {
    expect(ONEAI_FREE_LIMITS.dailyRequests).toBe(100)
    expect(ONEAI_FREE_LIMITS.dailyTokens).toBe(5_000_000)
    expect(ONEAI_FREE_LIMITS.signupCreditUsd).toBe(10)
    const text = oneAiLimitsText()
    expect(text).toContain('100 次请求')
    expect(text).toContain('00:00 UTC 重置')
    expect(text).toContain('$10')
    expect(text).toContain('无公开余额接口')
  })
})

describe('One AI 状态归类', () => {
  it('HTTP 状态归类与 Inferbase 同口径', () => {
    expect(classifyOneAiHttp(401, 'Invalid API key.').state).toBe('auth_invalid')
    expect(classifyOneAiHttp(403, 'forbidden').state).toBe('auth_invalid')
    expect(classifyOneAiHttp(402, 'insufficient credit').state).toBe('quota_exceeded')
    expect(classifyOneAiHttp(429, 'too many', 30).state).toBe('rate_limited')
    expect(classifyOneAiHttp(429, 'too many', 30).retryAfterSec).toBe(30)
    expect(classifyOneAiHttp(404, 'model not found').state).toBe('model_unavailable')
    expect(classifyOneAiHttp(500, 'boom').state).toBe('error')
  })
  it('文本错误归类保留原文', () => {
    expect(oneAiStateFromError(new Error('接口返回 429：rate limit'))).toBe('rate_limited')
    expect(oneAiStateFromError(new Error('接口返回 401：Invalid API key'))).toBe('auth_invalid')
    expect(oneAiStateFromError(new Error('Failed to fetch'))).toBe('network_error')
    expect(oneAiStateFromError(new OneAiApiError('x', 'quota_exceeded'))).toBe('quota_exceeded')
  })
})

describe('One AI 429 冷却口径', () => {
  const now = Date.UTC(2026, 10, 26, 5, 30, 0) // 2026-11-26 05:30 UTC
  it('下一个 UTC 零点计算正确', () => {
    expect(nextUtcMidnight(now)).toBe(Date.UTC(2026, 10, 27, 0, 0, 0))
  })
  it('有 Retry-After 用 Retry-After 并写明口径', () => {
    const cd = oneAiCooldownFor('rate_limited', 120, now)!
    expect(cd.until).toBe(now + 120_000)
    expect(cd.reason).toContain('Retry-After')
  })
  it('无 Retry-After 冷却到下一个 UTC 零点并写明口径', () => {
    const cd = oneAiCooldownFor('rate_limited', undefined, now)!
    expect(cd.until).toBe(Date.UTC(2026, 10, 27, 0, 0, 0))
    expect(cd.reason).toContain('UTC 零点')
    const cd2 = oneAiCooldownFor('quota_exceeded', undefined, now)!
    expect(cd2.until).toBe(Date.UTC(2026, 10, 27, 0, 0, 0))
  })
  it('非限流/额度状态不冷却', () => {
    expect(oneAiCooldownFor('auth_invalid', undefined, now)).toBeNull()
    expect(oneAiCooldownFor('available', undefined, now)).toBeNull()
  })
})

describe('One AI 启用门槛与运行状态', () => {
  beforeEach(() => { ;(localStorage as any).clear() })
  it('未冒烟 → 待实测未启用', () => {
    const g = oneAiGate(acct)
    expect(g.enabled).toBe(false)
    expect(g.state).toBe('pending_verification')
    expect(g.message).toContain('健康检查')
  })
  it('冒烟失败 → 保持未启用并带真实状态', () => {
    recordOneAiVerification(acct, 'failed', 'auth_invalid', '模型列表拉取失败：接口返回 401')
    const g = oneAiGate(acct)
    expect(g.enabled).toBe(false)
    expect(g.state).toBe('auth_invalid')
    expect(g.message).toContain('冒烟未通过')
  })
  it('冒烟通过 → 启用；换 Key（指纹变）→ 回到待实测', () => {
    recordOneAiVerification(acct, 'verified', 'available', '冒烟通过')
    expect(oneAiGate(acct).enabled).toBe(true)
    expect(oneAiGate({ ...acct, keyFingerprint: 'fp2' }).enabled).toBe(false)
    expect(oneAiGate({ ...acct, keyFingerprint: 'fp2' }).state).toBe('pending_verification')
  })
  it('已验证账户真实调用 429 → 门槛转冷却未启用，原因写明 UTC 口径；成功后恢复', () => {
    recordOneAiVerification(acct, 'verified', 'available', '冒烟通过')
    const now = Date.UTC(2026, 10, 26, 5, 30, 0)
    recordOneAiRouteFailure(acct.id, new Error('接口返回 429：rate limit exceeded'), now)
    const g = oneAiGate(acct, now + 1000)
    expect(g.enabled).toBe(false)
    expect(g.state).toBe('rate_limited')
    expect(g.message).toContain('UTC 零点')
    // 冷却到期后恢复可用
    expect(oneAiGate(acct, Date.UTC(2026, 10, 27, 0, 0, 1)).enabled).toBe(true)
    // 再次失败后一次成功清掉运行状态
    recordOneAiRouteFailure(acct.id, new Error('接口返回 429：rate limit exceeded'), now)
    recordOneAiRouteSuccess(acct.id)
    expect(oneAiGate(acct, now + 1000).enabled).toBe(true)
  })
  it('已验证账户 401 → 标记密钥失效停用，重新冒烟通过后恢复', () => {
    recordOneAiVerification(acct, 'verified', 'available', '冒烟通过')
    recordOneAiRouteFailure(acct.id, new Error('接口返回 401：Invalid API key'))
    const g = oneAiGate(acct)
    expect(g.enabled).toBe(false)
    expect(g.state).toBe('auth_invalid')
    recordOneAiVerification(acct, 'verified', 'available', '重新冒烟通过')
    expect(oneAiGate(acct).enabled).toBe(true)
  })
  it('非 oneai 账户不受门槛影响', () => {
    expect(oneAiGate({ id: 'x', providerId: 'deepseek' }).enabled).toBe(true)
  })
})

describe('One AI 本机用量估算', () => {
  beforeEach(() => { ;(localStorage as any).clear() })
  it('按 UTC 日累计请求与 tokens，文案标注本机估算与上限', () => {
    const now = Date.UTC(2026, 10, 26, 5, 0, 0)
    recordOneAiLocalUsage('oa1', 1200, now)
    recordOneAiLocalUsage('oa1', 800, now + 60_000)
    const u = loadOneAiLocalUsage('oa1', now + 120_000)
    expect(u.requests).toBe(2)
    expect(u.tokens).toBe(2000)
    const text = oneAiEstimateText('oa1', now + 120_000)
    expect(text).toContain('本机估算')
    expect(text).toContain('2/100 次请求')
    expect(text).toContain('2,000/5,000,000 tokens')
  })
  it('跨 UTC 日自动归零', () => {
    const day1 = Date.UTC(2026, 10, 26, 23, 59, 0)
    recordOneAiLocalUsage('oa1', 500, day1)
    const day2 = Date.UTC(2026, 10, 27, 0, 1, 0)
    expect(loadOneAiLocalUsage('oa1', day2).requests).toBe(0)
    recordOneAiLocalUsage('oa1', 300, day2)
    expect(loadOneAiLocalUsage('oa1', day2).requests).toBe(1)
    expect(loadOneAiLocalUsage('oa1', day2).tokens).toBe(300)
  })
  it('无 usage 返回时只记请求数、tokens 记 0（不编造）', () => {
    const now = Date.UTC(2026, 10, 26, 5, 0, 0)
    recordOneAiLocalUsage('oa1', 0, now)
    expect(loadOneAiLocalUsage('oa1', now)).toEqual({ day: '2026-11-26', requests: 1, tokens: 0 })
  })
})

describe('One AI 进 433 切换链的顺序', () => {
  it('oneai 在 inferbase 之后、wbpool 之前、apisfree 兜底之前', () => {
    const idx = (k: string) => CHAIN_KIND_ORDER.indexOf(k)
    expect(idx('oneai')).toBeGreaterThan(idx('inferbase'))
    expect(idx('oneai')).toBeLessThan(idx('wbpool'))
    expect(idx('oneai')).toBeLessThan(idx('apisfree'))
    const ordered = orderChainCandidates('sel', [
      { id: 'a', kind: 'apisfree' }, { id: 'b', kind: 'oneai' }, { id: 'c', kind: 'zen' },
    ])
    expect(ordered.map(x => x.id)).toEqual(['c', 'b', 'a'])
  })
})
