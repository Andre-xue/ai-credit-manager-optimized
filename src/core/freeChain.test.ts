// 免费路线自动切换链（v0.1.433）：错误分类、冷却/熔断/密钥失效、链执行与可见切换。
import { describe, it, expect, beforeEach } from 'vitest'
import {
  classifyChainError, failoverEligible, extractHttpStatus,
  recordChainFailure, recordChainSuccess, chainAvailability, clearChainRoute, getChainRouteHealth,
  runFreeChain, orderChainCandidates, ChainAllFailedError, ChainPartialError,
  loadChainMode, saveChainMode, type ChainCandidate,
} from './freeChain'
import { ApisFreeError } from './apisFree'
import { InferbaseApiError } from './inferbase'

class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}
;(globalThis as any).localStorage = new MemStorage()

beforeEach(() => { (localStorage as any).clear() })

describe('classifyChainError 错误分类', () => {
  it('429 → rate，并解析 Retry-After 结构化字段', () => {
    const c = classifyChainError(new ApisFreeError('APIsFreeLLM 返回 429：slow down', 429, 30))
    expect(c.kind).toBe('rate')
    expect(c.retryAfterSec).toBe(30)
  })
  it('402 / quota 文案 → quota', () => {
    expect(classifyChainError(new Error('接口返回 402：plan_limit exceeded')).kind).toBe('quota')
    expect(classifyChainError(new Error('FreeUsageLimitError — Free usage limit reached')).kind).toBe('quota')
  })
  it('401/403 → auth', () => {
    expect(classifyChainError(new Error('接口返回 401：invalid api key')).kind).toBe('auth')
    expect(classifyChainError(new InferbaseApiError('Invalid API key.', 'auth_invalid', 401)).kind).toBe('auth')
  })
  it('403 的上游策略拒绝（child_safety）也归 auth 类：停止自动重试该路线', () => {
    expect(classifyChainError(new ApisFreeError('APIsFreeLLM 返回 403：Request refused: policy', 403)).kind).toBe('auth')
  })
  it('5xx → server，超时 → timeout，空响应 → empty，网络 → network', () => {
    expect(classifyChainError(new Error('免费通道（Zen）返回 503：upstream down')).kind).toBe('server')
    expect(classifyChainError(new Error('响应超时')).kind).toBe('timeout')
    expect(classifyChainError(new Error('接口返回为空（空响应）')).kind).toBe('empty')
    expect(classifyChainError(new Error('Failed to fetch')).kind).toBe('network')
  })
  it('400 模型错误 → other（不可切换）', () => {
    const c = classifyChainError(new Error("接口返回 400：Model 'GLM' does not exist"))
    expect(c.kind).toBe('other')
    expect(failoverEligible(c.kind)).toBe(false)
  })
  it('400 model_not_found（官方 code 措辞）→ other，不许误判 quota/rate（v0.1.464）', () => {
    const c = classifyChainError(new Error('接口返回 400：{"error":{"code":"model_not_found","message":"The requested model is not available on this endpoint."}}'))
    expect(c.kind).toBe('other')
    expect(failoverEligible(c.kind)).toBe(false)
    expect(c.message).toContain('model_not_found')
  })
  it('extractHttpStatus 结构化优先、文案兜底', () => {
    expect(extractHttpStatus(new ApisFreeError('x', 429))).toBe(429)
    expect(extractHttpStatus(new Error('接口返回 503：x'))).toBe(503)
    expect(extractHttpStatus(new Error('没有状态码'))).toBeUndefined()
  })
})

describe('健康状态：冷却 / 熔断 / 密钥失效', () => {
  const t0 = 1_000_000_000_000
  it('429 按 Retry-After 冷却；无 Retry-After 默认 60 秒', () => {
    recordChainFailure('r1', { kind: 'rate', message: 'x', retryAfterSec: 30 }, t0)
    expect(chainAvailability('r1', t0 + 29_000).available).toBe(false)
    expect(chainAvailability('r1', t0 + 31_000).available).toBe(true)
    recordChainFailure('r2', { kind: 'rate', message: 'x' }, t0)
    expect(getChainRouteHealth('r2').cooldownUntil).toBe(t0 + 60_000)
  })
  it('额度不足冷却 10 分钟', () => {
    recordChainFailure('q1', { kind: 'quota', message: 'x' }, t0)
    expect(getChainRouteHealth('q1').cooldownUntil).toBe(t0 + 600_000)
  })
  it('连续失败 3 次熔断 5 分钟，到期后半开（probe）', () => {
    for (let i = 0; i < 3; i++) recordChainFailure('s1', { kind: 'server', message: 'x' }, t0)
    const h = getChainRouteHealth('s1')
    expect(h.failStreak).toBe(3)
    expect(h.breakerUntil).toBe(t0 + 300_000)
    expect(chainAvailability('s1', t0 + 1000).available).toBe(false)
    const half = chainAvailability('s1', t0 + 301_000)
    expect(half.available).toBe(true)
    expect(half.probe).toBe(true)
  })
  it('401/403 标记密钥失效：不再自动可选，clearChainRoute 后恢复', () => {
    recordChainFailure('a1', { kind: 'auth', message: 'invalid key' }, t0)
    expect(getChainRouteHealth('a1').authDead).toBe(true)
    expect(chainAvailability('a1', t0 + 999_000_000).available).toBe(false)
    clearChainRoute('a1')
    expect(chainAvailability('a1', t0).available).toBe(true)
  })
  it('成功清零失败计数与冷却', () => {
    recordChainFailure('ok1', { kind: 'rate', message: 'x' }, t0)
    recordChainSuccess('ok1', t0 + 1000)
    const h = getChainRouteHealth('ok1')
    expect(h.failStreak).toBe(0)
    expect(h.cooldownUntil).toBe(0)
    expect(h.lastOkAt).toBe(t0 + 1000)
  })
  it('other 类只记错误，不冷却不计数', () => {
    recordChainFailure('o1', { kind: 'other', message: 'bad request' }, t0)
    const h = getChainRouteHealth('o1')
    expect(h.failStreak).toBe(0)
    expect(h.cooldownUntil).toBe(0)
    expect(h.lastError).toBe('bad request')
  })
})

describe('orderChainCandidates 排序', () => {
  it('首选置顶，其余按 cloud→zen→kilo→inferbase→wbpool→apisfree', () => {
    const list = [
      { id: 'af', kind: 'apisfree' }, { id: 'kl', kind: 'kilo' }, { id: 'ib', kind: 'inferbase' },
      { id: 'zn', kind: 'zen' }, { id: 'cl', kind: 'cloud' }, { id: 'wp', kind: 'wbpool' },
    ]
    expect(orderChainCandidates('kl', list).map(x => x.id)).toEqual(['kl', 'cl', 'zn', 'ib', 'wp', 'af'])
    expect(orderChainCandidates('', list).map(x => x.id)).toEqual(['cl', 'zn', 'kl', 'ib', 'wp', 'af'])
  })
})

describe('runFreeChain 链执行', () => {
  const cand = (id: string, kind = 'zen'): ChainCandidate => ({ id, label: `路线${id}`, kind })
  it('首选限流 → 切下一条成功，switches 带原因，失败路线进冷却', async () => {
    const res = await runFreeChain([cand('a'), cand('b', 'kilo')], async c => {
      if (c.id === 'a') throw new Error('接口返回 429：rate limit')
      return '答案B'
    })
    expect(res.text).toBe('答案B')
    expect(res.usedId).toBe('b')
    expect(res.switches).toHaveLength(1)
    expect(res.switches[0]).toMatchObject({ fromId: 'a', toId: 'b', kind: 'rate', reason: '限流' })
    expect(chainAvailability('a').available).toBe(false) // 已进冷却，下次自动跳过
  })
  it('冷却中的路线被跳过，直接用下一条', async () => {
    recordChainFailure('a', { kind: 'quota', message: '额度不足' })
    const tried: string[] = []
    const res = await runFreeChain([cand('a'), cand('b', 'kilo')], async c => { tried.push(c.id); return 'ok' })
    expect(tried).toEqual(['b'])
    expect(res.usedId).toBe('b')
  })
  it('不可切换失败（400）原样抛出，不试下一条', async () => {
    const tried: string[] = []
    await expect(runFreeChain([cand('a'), cand('b', 'kilo')], async c => {
      tried.push(c.id)
      throw new Error("接口返回 400：Model 'X' does not exist")
    })).rejects.toThrow('does not exist')
    expect(tried).toEqual(['a'])
  })
  it('已输出部分内容后失败 → ChainPartialError，不重发', async () => {
    const tried: string[] = []
    await expect(runFreeChain([cand('a'), cand('b', 'kilo')], async (c, ctx) => {
      tried.push(c.id)
      ctx.markEmitted()
      throw new Error('接口返回 503：中途断了')
    })).rejects.toBeInstanceOf(ChainPartialError)
    expect(tried).toEqual(['a'])
  })
  it('全部失败 → ChainAllFailedError 汇总每条真实原因', async () => {
    const err = await runFreeChain([cand('a'), cand('b', 'kilo')], async c => {
      throw new Error(c.id === 'a' ? '接口返回 429：限流' : '响应超时')
    }).catch(e => e)
    expect(err).toBeInstanceOf(ChainAllFailedError)
    expect(err.message).toContain('路线a')
    expect(err.message).toContain('429')
    expect(err.message).toContain('路线b')
    expect(err.message).toContain('响应超时')
  })
  it('空响应视为可切换失败', async () => {
    const res = await runFreeChain([cand('a'), cand('b', 'kilo')], async c => (c.id === 'a' ? '   ' : '有内容'))
    expect(res.usedId).toBe('b')
    expect(res.failures[0].kind).toBe('empty')
  })
})

describe('模式偏好', () => {
  it('默认 auto，locked 可存可读', () => {
    expect(loadChainMode()).toBe('auto')
    saveChainMode('locked')
    expect(loadChainMode()).toBe('locked')
    saveChainMode('auto')
    expect(loadChainMode()).toBe('auto')
  })
})
