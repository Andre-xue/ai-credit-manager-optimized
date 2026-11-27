// v0.1.509（C）：任务卡状态行 + 用量弹层的数据装配（只做呈现层）。
// 数据全部复用现成来源，不新采、不编造：
// - 费用 / 输入输出 tokens / 输出速度：507 账本（CLI 自报 usage 与任务时长）；
// - 首字延迟（TTFT）：504 探测中心的延迟样本中位数；
// - 缓存命中率 / 上下文占用 %：现有数据源都没有 → 如实 null（界面显示「暂无数据」）。
import type { AgentLedgerEntry } from './agents'
import { medianSamples, type ProbeStore } from './probeCenter'

export interface UsageView {
  /** 缓存命中率 %（无数据源 → null） */
  cacheHitPct: number | null
  /** 最近一次有 token 数据的 CLI 任务的输出速度（tok/s） */
  lastTps: number | null
  /** 全部有 token 数据任务的平均输出速度（总输出 ÷ 总时长） */
  avgTps: number | null
  /** 账本累计费用（CLI 自报美元原值） */
  costUsd: number
  /** 账本累计费用（人民币原值） */
  costYuan: number
  inputTokens: number
  outputTokens: number
  /** 缓存读取 token（无数据源 → null） */
  cacheReadTokens: number | null
  /** 探测样本的首字延迟中位数（ms） */
  ttftMs: number | null
  /** 上下文已用 %（无窗口大小数据 → null） */
  contextPct: number | null
  /** 上下文绝对量（输入+输出 token 合计，账本口径） */
  contextTokens: number
}

export function buildUsageView(ledger: readonly AgentLedgerEntry[], probe: ProbeStore | null): UsageView {
  let costUsd = 0, costYuan = 0, inputTokens = 0, outputTokens = 0
  let tpsOut = 0, tpsMs = 0, lastTps: number | null = null
  // ledger 按时间正序追加：最后一个有完整数据的即最近一次
  for (const e of ledger) {
    costUsd += e.costUsd ?? 0
    costYuan += e.costYuan ?? 0
    inputTokens += e.inputTokens ?? 0
    outputTokens += e.outputTokens ?? 0
    if ((e.outputTokens ?? 0) > 0 && (e.durationMs ?? 0) > 0) {
      const tps = (e.outputTokens as number) / ((e.durationMs as number) / 1000)
      lastTps = tps
      tpsOut += e.outputTokens as number
      tpsMs += e.durationMs as number
    }
  }
  let ttftMs: number | null = null
  if (probe) {
    const medians: number[] = []
    for (const r of Object.values(probe.results)) {
      if (!r.ok) continue
      const m = medianSamples(r.latencySamples)
      if (m != null) medians.push(m)
    }
    if (medians.length) ttftMs = medianSamples(medians)
  }
  return {
    cacheHitPct: null,
    lastTps,
    avgTps: tpsMs > 0 ? tpsOut / (tpsMs / 1000) : null,
    costUsd, costYuan,
    inputTokens, outputTokens,
    cacheReadTokens: null,
    ttftMs,
    contextPct: null,
    contextTokens: inputTokens + outputTokens,
  }
}

export interface ModelChoice { id: string; label: string; platformName: string; status: 'ok' | 'bad' | 'untested' }

/** v0.1.509（D④）：交接弹窗的模型目录——直接复用 504 探测中心的目标表：
 * 已分组（按平台）、按「平台+模型名」去重（同一模型不许出现两次）、带实测状态。 */
export function buildModelChoices(probe: ProbeStore | null): ModelChoice[] {
  if (!probe) return []
  const seen = new Set<string>()
  const out: ModelChoice[] = []
  for (const t of Object.values(probe.targets)) {
    const key = `${t.platformKey}::${t.name}`
    if (seen.has(key)) continue
    seen.add(key)
    const r = probe.results[t.id]
    out.push({ id: t.id, label: t.name, platformName: t.platformName, status: !r ? 'untested' : r.ok ? 'ok' : 'bad' })
  }
  out.sort((a, b) => a.platformName.localeCompare(b.platformName) || a.label.localeCompare(b.label))
  return out
}
