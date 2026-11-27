// Agent 工作台三期（v0.1.512 ②③）纯逻辑：worktree 赛马选人 + 结算卡仪表盘口径。
// 红线：速度只认实测（账本真实任务的输出速度、探测中心 TTFT 样本），没有就如实写
// 「暂无实测数据」垫底，不编造；付费候选永远单独列出等放行，绝不混进已选。
import type { AgentLedgerEntry } from './agents'
import { medianSamples, type ProbeStore } from './probeCenter'

export interface RaceCandidateInput {
  agentId: string
  agentName: string
  entryId?: string
  entryLabel?: string
  /** free = 自有额度（账号型）/ 免费路线 / 自身登录；paid = 绑定的付费账户（按量计费） */
  cost: 'free' | 'paid'
  /** paid 时的人话说明（绑定的付费账户名） */
  paidLabel?: string
}

export interface RaceSpeed {
  /** 账本最近 5 条带 token 任务的输出速度（tok/s），无数据为 null */
  tps: number | null
  /** 探测中心该绑定账户的 TTFT 中位数（ms），无样本为 null */
  ttftMs: number | null
  /** 依据人话（写在赛马卡上，让用户知道为什么选它） */
  basis: string
}

/** 实测速度证据：账本输出速度优先，其次探测 TTFT；都没有 → 暂无实测数据 */
export function raceSpeed(
  agentId: string,
  ledger: readonly AgentLedgerEntry[],
  probe: ProbeStore | null,
  boundAccountId?: string,
): RaceSpeed {
  // 账本按新→旧存（新条目在前），取前 5 条即最近 5 次
  const withTokens = ledger
    .filter(e => e.agentId === agentId && (e.outputTokens ?? 0) > 0 && (e.durationMs ?? 0) > 0)
    .slice(0, 5)
  let tps: number | null = null
  if (withTokens.length) {
    const out = withTokens.reduce((s, e) => s + (e.outputTokens ?? 0), 0)
    const ms = withTokens.reduce((s, e) => s + (e.durationMs ?? 0), 0)
    if (ms > 0) tps = out / (ms / 1000)
  }
  let ttftMs: number | null = null
  if (probe && boundAccountId) {
    const medians: number[] = []
    for (const t of Object.values(probe.targets)) {
      if (t.accountId !== boundAccountId) continue
      const r = probe.results[t.id]
      if (!r?.ok) continue
      const m = medianSamples(r.latencySamples)
      if (m != null) medians.push(m)
    }
    if (medians.length) ttftMs = medianSamples(medians)
  }
  const basis = tps != null
    ? `近 ${withTokens.length} 次实测输出速度约 ${Math.round(tps)} tok/s`
    : ttftMs != null
      ? `探测中心实测首字延迟约 ${Math.round(ttftMs)} ms`
      : '暂无实测数据（第一次参赛）'
  return { tps, ttftMs, basis }
}

/** 速度排序键：有输出速度的按速度降序 → 有 TTFT 的按延迟升序 → 无数据的垫底；
 *  同档按名字稳定排序。返回负数 = a 更快。 */
export function compareRaceSpeed(a: RaceSpeed, b: RaceSpeed): number {
  if (a.tps != null && b.tps != null) return b.tps - a.tps
  if (a.tps != null) return -1
  if (b.tps != null) return 1
  if (a.ttftMs != null && b.ttftMs != null) return a.ttftMs - b.ttftMs
  if (a.ttftMs != null) return -1
  if (b.ttftMs != null) return 1
  return 0
}

export interface RacePick {
  /** 已选定的选手（≤2）：优先免费路线、按实测速度排序 */
  chosen: Array<RaceCandidateInput & { speed: RaceSpeed }>
  /** 免费选手不足两个时，需要用户放行的付费候选（按速度取最快的补位） */
  needsApproval: Array<RaceCandidateInput & { speed: RaceSpeed }>
  /** 选手总池不足两个（连付费放行也凑不齐）时的人话原因；可开赛时为空串 */
  shortReason: string
}

/** 赛马选人：只走免费路线凑两个；不够时把付费候选单独列出等放行，绝不静默选入 */
export function pickRaceCandidates(
  cands: readonly RaceCandidateInput[],
  speedOf: (c: RaceCandidateInput) => RaceSpeed,
): RacePick {
  const annotated = cands.map(c => ({ ...c, speed: speedOf(c) }))
  const bySpeed = (x: typeof annotated[number], y: typeof annotated[number]) =>
    compareRaceSpeed(x.speed, y.speed) || x.agentName.localeCompare(y.agentName) || (x.entryLabel ?? '').localeCompare(y.entryLabel ?? '')
  const free = annotated.filter(c => c.cost === 'free').sort(bySpeed)
  const paid = annotated.filter(c => c.cost === 'paid').sort(bySpeed)
  const chosen = free.slice(0, 2)
  const needsApproval = chosen.length < 2 ? paid.slice(0, 2 - chosen.length) : []
  const shortReason = chosen.length + needsApproval.length < 2
    ? '可参赛的选手不足两个：赛马需要至少两个已就绪、能无头派活的 Agent（或同一 Agent 的两个账户条目）。先到设置 · Agent 管理启用更多 Agent。'
    : ''
  return { chosen, needsApproval, shortReason }
}

// ---------------- 结算卡仪表盘口径（③） ----------------

export interface FreeShare { freeTasks: number; totalTasks: number; pct: number | null }

/** 免费路线占比（按任务数）：账号型自有额度 + 空壳型未绑付费账户（免费路线/自身登录）
 *  的任务占全部账本任务的比例；没有账本时 pct = null（界面显空态，不编造）。 */
export function raceFreeShare(ledger: readonly AgentLedgerEntry[]): FreeShare {
  const total = ledger.length
  if (!total) return { freeTasks: 0, totalTasks: 0, pct: null }
  const free = ledger.filter(e => e.kind === 'account' || !e.accountId).length
  return { freeTasks: free, totalTasks: total, pct: Math.round((free / total) * 100) }
}

export interface DayTrend { label: string; count: number }

/** 近 7 日任务量（按账本条目的开始时间归日，含今天在内 7 天，旧→新） */
export function last7DaysTrend(ledger: readonly AgentLedgerEntry[], now: number): DayTrend[] {
  const days: DayTrend[] = []
  const dayMs = 24 * 3600 * 1000
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  for (let i = 6; i >= 0; i--) {
    const start = startOfToday.getTime() - i * dayMs
    const end = start + dayMs
    const d = new Date(start)
    days.push({
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      count: ledger.filter(e => e.startedAt >= start && e.startedAt < end).length,
    })
  }
  return days
}
