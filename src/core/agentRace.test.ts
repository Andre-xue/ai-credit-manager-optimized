import { describe, it, expect } from 'vitest'
import { raceSpeed, pickRaceCandidates, raceFreeShare, last7DaysTrend, type RaceCandidateInput, type RaceSpeed } from './agentRace'
import type { AgentLedgerEntry } from './agents'
import type { ProbeStore } from './probeCenter'

const entry = (patch: Partial<AgentLedgerEntry>): AgentLedgerEntry => ({
  id: Math.random().toString(36), taskId: 't', agentId: 'dsh', agentName: 'DSH', kind: 'account',
  startedAt: 0, endedAt: 1000, durationMs: 1000, status: 'done', costYuan: null, ...patch,
})

const emptyProbe: ProbeStore = { results: {}, targets: {} }

const speed = (v: number | null): RaceSpeed => ({ tps: v, ttftMs: null, basis: v == null ? '暂无实测数据（第一次参赛）' : `近 1 次实测输出速度约 ${v} tok/s` })

describe('v0.1.512（②）：赛马选人', () => {
  it('raceSpeed：账本最近任务的输出速度优先于探测 TTFT', () => {
    const ledger = [entry({ outputTokens: 2000, durationMs: 10_000 })]
    const s = raceSpeed('dsh', ledger, emptyProbe, undefined)
    expect(s.tps).toBeCloseTo(200)
    expect(s.basis).toContain('实测输出速度')
  })
  it('raceSpeed：无账本数据时退回探测 TTFT 中位数', () => {
    const probe: ProbeStore = {
      targets: {
        x: { id: 'x', name: 'm', platformName: 'p', platformKey: 'p', group: 'chat', autoProbe: true, accountId: 'a1' },
      },
      results: {
        x: { ok: true, source: 'active', checkedAt: 1, latencySamples: [900, 1100], attempts: 2, successes: 2, failStreak: 0 },
      },
    }
    const s = raceSpeed('pi', [], probe, 'a1')
    expect(s.basis).toContain('首字延迟')
    expect(s.ttftMs).toBe(1000)
  })
  it('raceSpeed：两样都没有 → 无数据、依据如实写明', () => {
    const s = raceSpeed('pi', [], emptyProbe, undefined)
    expect(s.tps).toBeNull()
    expect(s.basis).toContain('暂无实测数据')
  })

  const cand = (patch: Partial<RaceCandidateInput>): RaceCandidateInput => ({
    agentId: 'x', agentName: 'X', cost: 'free', ...patch,
  })

  it('pickRaceCandidates：免费选手按实测速度取两个，无数据的排在有数据之后', () => {
    const cands = [
      cand({ agentId: 'slow', agentName: '慢' }),
      cand({ agentId: 'fast', agentName: '快' }),
      cand({ agentId: 'new', agentName: '新' }),
    ]
    const speeds: Record<string, RaceSpeed> = { slow: speed(10), fast: speed(50), new: speed(null) }
    const pick = pickRaceCandidates(cands, c => speeds[c.agentId])
    expect(pick.chosen.map(c => c.agentId)).toEqual(['fast', 'slow'])
    expect(pick.needsApproval).toEqual([])
    expect(pick.shortReason).toBe('')
  })
  it('pickRaceCandidates：免费不够两个 → 付费候选进 needsApproval，不直接入选', () => {
    const cands = [
      cand({ agentId: 'free1', agentName: '免费一' }),
      cand({ agentId: 'paid1', agentName: '付费一', cost: 'paid', paidLabel: '账户-p1' }),
    ]
    const pick = pickRaceCandidates(cands, () => speed(10))
    expect(pick.chosen.map(c => c.agentId)).toEqual(['free1'])
    expect(pick.needsApproval.map(c => c.agentId)).toEqual(['paid1'])
    expect(pick.needsApproval[0].paidLabel).toBe('账户-p1')
  })
  it('pickRaceCandidates：连付费也不够两个 → 给出选手不足的原因', () => {
    const pick = pickRaceCandidates([cand({ agentId: 'only' })], () => speed(1))
    expect(pick.chosen).toHaveLength(1)
    expect(pick.shortReason).toContain('选手不足')
  })
})

describe('v0.1.512（③）：结算卡数据（免费占比 / 近 7 日趋势）', () => {
  it('raceFreeShare：账号型与未绑付费账户算免费侧，绑付费账户的不算', () => {
    const ledger = [
      entry({ kind: 'account' }),
      entry({ kind: 'shell' }),
      entry({ kind: 'shell', accountId: 'a1' }),
      entry({ kind: 'shell', accountId: 'a2' }),
    ]
    expect(raceFreeShare(ledger)).toEqual({ freeTasks: 2, totalTasks: 4, pct: 50 })
    expect(raceFreeShare([])).toEqual({ freeTasks: 0, totalTasks: 0, pct: null })
  })
  it('last7DaysTrend：恰好 7 天、按 startedAt 归日', () => {
    const now = new Date('2026-11-28T12:00:00').getTime()
    const today = new Date('2026-11-28T08:00:00').getTime()
    const threeDaysAgo = new Date('2026-11-25T08:00:00').getTime()
    const ledger = [
      entry({ startedAt: today }), entry({ startedAt: today }),
      entry({ startedAt: threeDaysAgo }),
      entry({ startedAt: now - 30 * 86_400_000 }),
    ]
    const trend = last7DaysTrend(ledger, now)
    expect(trend).toHaveLength(7)
    expect(trend[6].count).toBe(2)
    expect(trend[3].count).toBe(1)
    expect(trend.reduce((s, d) => s + d.count, 0)).toBe(3)
  })
})
