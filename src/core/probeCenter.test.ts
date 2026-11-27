import { describe, it, expect, beforeEach } from 'vitest'
import {
  medianSamples, successRate, effectivePrice, probeBackoffMs, isProbeFresh,
  classifyProbeError, recordProbeOutcome, seedProbeOutcome, loadProbeStore,
  probeSummary, unavailableTargets, rankProbeGroup, selectProbeBatch, probeOrderIds,
  type ProbeTarget, type ProbeResult,
} from './probeCenter'

class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}
;(globalThis as any).localStorage = new MemStorage()

const T = (id: string, over: Partial<ProbeTarget> = {}): ProbeTarget => ({
  id, name: id, platformName: 'P', platformKey: 'p', group: 'free', autoProbe: true, ...over,
})
const R = (over: Partial<ProbeResult> = {}): ProbeResult => ({
  ok: true, source: 'active', checkedAt: 1000, latencySamples: [500], attempts: 4, successes: 4, failStreak: 0, ...over,
})

describe('中位数与成功率', () => {
  it('中位数：奇数取中、偶数取中二均值、空为 null', () => {
    expect(medianSamples([300, 100, 200])).toBe(200)
    expect(medianSamples([100, 300])).toBe(200)
    expect(medianSamples([])).toBeNull()
    expect(medianSamples([900, 100, 110, 120, 130])).toBe(120) // 单次抖动不带偏
  })
  it('成功率：无样本为 null', () => {
    expect(successRate(undefined)).toBeNull()
    expect(successRate(R({ attempts: 0, successes: 0 }))).toBeNull()
    expect(successRate(R({ attempts: 4, successes: 3 }))).toBe(0.75)
  })
})

describe('有效价格排序口径', () => {
  it('有效价格 = 标价 ÷ 成功率；成功率 0 为无穷大', () => {
    expect(effectivePrice(T('a', { price: 2 }), R({ attempts: 4, successes: 2 }))).toBe(4)
    expect(effectivePrice(T('a', { price: 2 }), R({ attempts: 2, successes: 0 }))).toBe(Number.POSITIVE_INFINITY)
    expect(effectivePrice(T('a', { price: 2 }), undefined)).toBe(2) // 无数据按标价
  })
  it('价格未知返回 null 并在通用型排名垫底、标「价格未知」', () => {
    expect(effectivePrice(T('a', { price: null }), R())).toBeNull()
    const targets = [T('unknown', { group: 'general', price: null }), T('cheap', { group: 'general', price: 1 }), T('dear', { group: 'general', price: 3 })]
    const results = { unknown: R(), cheap: R(), dear: R() }
    const rows = rankProbeGroup(targets, results, 'general')
    expect(rows.map(r => r.target.id)).toEqual(['cheap', 'dear', 'unknown'])
    expect(rows[2].metricLabel).toBe('价格未知')
    expect(rows[0].recommended).toBe(true)
    expect(rows[0].metricLabel).toContain('最便宜'.length ? '有效价格' : '')
  })
  it('免费/对话型按首字延迟中位数排名，榜首标推荐', () => {
    const targets = [T('slow'), T('fast'), T('mid')]
    const results = {
      slow: R({ latencySamples: [900, 950] }), fast: R({ latencySamples: [120, 130] }), mid: R({ latencySamples: [400] }),
    }
    const rows = rankProbeGroup(targets, results, 'free')
    expect(rows.map(r => r.target.id)).toEqual(['fast', 'mid', 'slow'])
    expect(rows[0].recommended).toBe(true)
    expect(rows[0].metricLabel).toContain('首字')
  })
  it('不可用不进主排名；未测排在可用之后', () => {
    const targets = [T('bad'), T('ok1'), T('new')]
    const rows = rankProbeGroup(targets, { bad: R({ ok: false }), ok1: R() }, 'free')
    expect(rows.map(r => r.target.id)).toEqual(['ok1', 'new'])
  })
})

describe('失败退避', () => {
  it('限流优先按 Retry-After，其次固定 10 分钟', () => {
    expect(probeBackoffMs(1, 'rate', 45)).toBe(45_000)
    expect(probeBackoffMs(1, 'rate')).toBe(600_000)
    expect(probeBackoffMs(3, 'quota')).toBe(600_000)
  })
  it('auth/model 长退避；其余指数退避封顶 30 分钟', () => {
    expect(probeBackoffMs(1, 'auth')).toBe(24 * 3600_000)
    expect(probeBackoffMs(1, 'model')).toBe(24 * 3600_000)
    expect(probeBackoffMs(1, 'timeout')).toBe(60_000)
    expect(probeBackoffMs(2, 'timeout')).toBe(120_000)
    expect(probeBackoffMs(9, 'network')).toBe(30 * 60_000)
  })
  it('新鲜判定：可用 30 分钟内新鲜；失败退避期内新鲜、过后过期', () => {
    const now = 10_000_000
    expect(isProbeFresh(R({ checkedAt: now - 60_000 }), now)).toBe(true)
    expect(isProbeFresh(R({ checkedAt: now - 31 * 60_000 }), now)).toBe(false)
    expect(isProbeFresh(R({ ok: false, checkedAt: now - 60_000, nextProbeAt: now + 60_000, failStreak: 1 }), now)).toBe(true)
    expect(isProbeFresh(R({ ok: false, checkedAt: now - 600_000, nextProbeAt: now - 1, failStreak: 1 }), now)).toBe(false)
    expect(isProbeFresh(undefined, now)).toBe(false)
  })
})

describe('错误分类（人话原因）', () => {
  it('429→限流冷却中、401→密钥失效、超时→连接超时、model_not_found→模型不存在', () => {
    expect(classifyProbeError(new Error('HTTP 429 too many')).kind).toBe('rate')
    expect(classifyProbeError(new Error('401 invalid api key')).kind).toBe('auth')
    expect(classifyProbeError(new Error('request timeout')).kind).toBe('timeout')
    const m = classifyProbeError(new Error('400 model_not_found: model x is not available'))
    expect(m.kind).toBe('model') // 不许误报成额度/限流（464 口径）
    expect(m.reason).toBe('模型不存在')
  })
})

describe('计数三处同源', () => {
  it('probeSummary 与 unavailableTargets 计数一致（面板/角标/折叠同源）', () => {
    const targets = [T('a'), T('b'), T('c'), T('d')]
    const results = { a: R(), b: R({ ok: false }), c: R({ ok: false }) }
    const s = probeSummary(targets, results)
    expect(s).toEqual({ total: 4, ok: 1, bad: 2, untested: 1 })
    expect(unavailableTargets(targets, results).length).toBe(s.bad)
    expect(unavailableTargets(targets, results).map(x => x.target.id).sort()).toEqual(['b', 'c'])
  })
})

describe('结果写入与被动优先', () => {
  beforeEach(() => { localStorage.clear() })
  it('recordProbeOutcome 累积样本（保留最近 5 次）与成功率，失败写退避', () => {
    const now = 1_000_000
    for (let i = 0; i < 7; i++) recordProbeOutcome('x', { ok: true, ms: 100 + i, source: 'passive' }, now + i)
    let r = loadProbeStore().results['x']
    expect(r.latencySamples).toEqual([102, 103, 104, 105, 106])
    expect(r.attempts).toBe(7)
    expect(r.successes).toBe(7)
    recordProbeOutcome('x', { ok: false, failKind: 'timeout', source: 'active' }, now + 100)
    r = loadProbeStore().results['x']
    expect(r.ok).toBe(false)
    expect(r.failStreak).toBe(1)
    expect(r.nextProbeAt).toBe(now + 100 + 60_000)
  })
  it('被动写入新鲜结果后，主动探测清单跳过该项（被动优先）', () => {
    const now = 5_000_000
    recordProbeOutcome('hot', { ok: true, ms: 200, source: 'passive' }, now)
    const batch = selectProbeBatch([T('hot'), T('cold')], loadProbeStore().results, now + 1000)
    expect(batch.map(t => t.id)).toEqual(['cold'])
  })
  it('seedProbeOutcome 只播种不覆盖既有结果', () => {
    recordProbeOutcome('x', { ok: true, ms: 100, source: 'passive' }, 1000)
    expect(seedProbeOutcome('x', { ok: false, failKind: 'auth', source: 'passive' }, 2000)).toBe(false)
    expect(loadProbeStore().results['x'].ok).toBe(true)
    expect(seedProbeOutcome('y', { ok: false, failKind: 'auth', source: 'passive' }, 2000)).toBe(true)
    expect(loadProbeStore().results['y'].failReason).toBe('密钥失效')
  })
})

describe('护栏判定', () => {
  it('MoMA 合作模型等 autoProbe=false 永不进主动清单（force 也不进）', () => {
    const targets = [T('moma-partner', { autoProbe: false }), T('normal')]
    expect(selectProbeBatch(targets, {}, 1000).map(t => t.id)).toEqual(['normal'])
    expect(selectProbeBatch(targets, {}, 1000, { force: true }).map(t => t.id)).toEqual(['normal'])
  })
  it('账号池护栏：同 poolKey 每轮只放行一个（价格低者优先）', () => {
    const targets = [
      T('pool-a', { poolKey: 'wb', price: 3 }), T('pool-b', { poolKey: 'wb', price: 1 }), T('pool-c', { poolKey: 'wb', price: 2 }),
    ]
    const batch = selectProbeBatch(targets, {}, 1000)
    expect(batch.map(t => t.id)).toEqual(['pool-b'])
  })
  it('退避未到的失败项不进清单；force 可绕过新鲜与退避', () => {
    const now = 9_000_000
    const results = { x: R({ ok: false, checkedAt: now - 1000, nextProbeAt: now + 600_000, failStreak: 1 }) }
    expect(selectProbeBatch([T('x')], results, now)).toEqual([])
    expect(selectProbeBatch([T('x')], results, now, { force: true }).map(t => t.id)).toEqual(['x'])
  })
  it('冷门优先：从未测过的排在已测过期的前面', () => {
    const now = 9_000_000
    const results = { old: R({ checkedAt: now - 3600_000 }) }
    const batch = selectProbeBatch([T('old'), T('never')], results, now)
    expect(batch.map(t => t.id)).toEqual(['never', 'old'])
  })
})

describe('菜单排序', () => {
  it('probeOrderIds：可用按指标在前、未测居中、不可用最后', () => {
    const targets = [T('bad'), T('slow'), T('fast'), T('new')]
    const results = {
      bad: R({ ok: false }), slow: R({ latencySamples: [800] }), fast: R({ latencySamples: [100] }),
    }
    expect(probeOrderIds(targets, results, 'free')).toEqual(['fast', 'slow', 'new', 'bad'])
  })
})
