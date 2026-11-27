import { describe, expect, it } from 'vitest'
import { buildModelChoices, buildUsageView } from './agentUsageView'
import type { AgentLedgerEntry } from './agents'
import type { ProbeStore } from './probeCenter'

function le(p: Partial<AgentLedgerEntry>): AgentLedgerEntry {
  return { id: Math.random().toString(36).slice(2), taskId: 't1', agentId: 'claude-code', agentName: 'Claude Code', kind: 'shell', startedAt: 0, endedAt: 1, durationMs: 0, status: 'done', costYuan: null, ...p }
}

describe('buildUsageView（C：只复用账本与探测中心现成数据）', () => {
  it('无数据：速度/缓存/上下文全 null，费用 0（界面显示暂无数据，不编造）', () => {
    const v = buildUsageView([], null)
    expect(v.lastTps).toBeNull()
    expect(v.avgTps).toBeNull()
    expect(v.cacheHitPct).toBeNull()
    expect(v.cacheReadTokens).toBeNull()
    expect(v.contextPct).toBeNull()
    expect(v.ttftMs).toBeNull()
    expect(v.costUsd).toBe(0)
    expect(v.contextTokens).toBe(0)
  })
  it('有数据：费用/tokens 累计，TPS 由输出 token÷时长算出（最近一次与平均）', () => {
    const v = buildUsageView([
      le({ costUsd: 0.5, inputTokens: 1000, outputTokens: 2000, durationMs: 10_000 }),
      le({ costUsd: 0.25, inputTokens: 500, outputTokens: 3000, durationMs: 10_000 }),
    ], null)
    expect(v.costUsd).toBeCloseTo(0.75)
    expect(v.inputTokens).toBe(1500)
    expect(v.outputTokens).toBe(5000)
    expect(v.lastTps).toBeCloseTo(300)
    expect(v.avgTps).toBeCloseTo(250)
    expect(v.contextTokens).toBe(6500)
  })
  it('TTFT 取探测中心成功样本的中位数；失败样本不计', () => {
    const probe: ProbeStore = {
      targets: {},
      results: {
        a: { ok: true, source: 'active', checkedAt: 1, latencySamples: [100, 300], attempts: 2, successes: 2, failStreak: 0 },
        b: { ok: false, source: 'active', checkedAt: 1, latencySamples: [9999], attempts: 1, successes: 0, failStreak: 1 },
      },
    }
    const v = buildUsageView([], probe)
    expect(v.ttftMs).toBe(200)
  })
})

describe('buildModelChoices（D④：探测中心目录、分组去重、带状态）', () => {
  it('同平台同名只出现一次；状态取实测结果', () => {
    const probe: ProbeStore = {
      targets: {
        t1: { id: 't1', name: 'gpt-x', platformName: '平台A', platformKey: 'pa', group: 'general', autoProbe: true },
        t2: { id: 't2', name: 'gpt-x', platformName: '平台A', platformKey: 'pa', group: 'general', autoProbe: true },
        t3: { id: 't3', name: 'gpt-y', platformName: '平台A', platformKey: 'pa', group: 'general', autoProbe: true },
      },
      results: { t1: { ok: true, source: 'active', checkedAt: 1, latencySamples: [1], attempts: 1, successes: 1, failStreak: 0 } },
    }
    const cs = buildModelChoices(probe)
    expect(cs.map(c => c.label)).toEqual(['gpt-x', 'gpt-y'])
    expect(cs[0].status).toBe('ok')
    expect(cs[1].status).toBe('untested')
  })
  it('无探测数据返回空（弹窗如实提示暂无目录）', () => {
    expect(buildModelChoices(null)).toEqual([])
  })
})
