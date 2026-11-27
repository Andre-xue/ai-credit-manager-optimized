// 全局模型探测中心（v0.1.504）：全 App 一份探测引擎、一份结果存储（本机）。
//
// 设计口径（2026-11-27 Ethan 拍板，预览 mo-xing-tan-ce-gai-ban-yu-lan 定版）：
// - 结果带时间戳缓存，多模块共用同一份（AI 助手本版首个接入；翻译/图库后续版本读同一份）。
// - 探测只是参考状态：绝不因探测不可用拦发送（发送以真实调用为准、免费链兜底不变），
//   绝不替用户改已选模型/平台/分类（v0.1.499 定案）；「优先」只决定排序 + 「推荐」标记。
// - 能力分开标记：聊天测通 ≠ 视觉可用，视觉结果单独存（visionOk），图库后续只读视觉结果。
// - 高效七条：①被动优先（真实发送顺手记结果，主动只补冷门）②分层探测（列表验在不在 →
//   1-token 真请求，执行侧负责，本模块管调度判定）③速度口径=首字延迟最近样本中位数
//   ④失败退避（限流按 Retry-After；只标记暂不可用）⑤有效价格=标价÷成功率，价格未知垫底
//   ⑥礼让调度（执行侧在用户聊天时暂停，本模块只给到期清单）⑦账号池护栏（同 poolKey
//   每轮主动只测一个）+ MoMA 合作模型等按量扣费模型 autoProbe=false 不进自动探测。
import { classifyChainError } from './freeChain'

export type ProbeGroup = 'free' | 'chat' | 'general'
export type ProbeFailKind = 'rate' | 'quota' | 'auth' | 'timeout' | 'model' | 'network' | 'server' | 'empty' | 'other'

export const PROBE_FAIL_LABEL: Record<ProbeFailKind, string> = {
  rate: '限流冷却中', quota: '额度不足', auth: '密钥失效', timeout: '连接超时',
  model: '模型不存在', network: '网络不通', server: '服务异常', empty: '返回为空', other: '调用失败',
}

export interface ProbeTarget {
  /** 稳定唯一键：选项键（免费/本地）或 own:<账户id>:<引擎id>（自有账户引擎） */
  id: string
  /** 展示名（模型名） */
  name: string
  /** 平台展示名 */
  platformName: string
  /** 并发分组键（同平台串行/限并发） */
  platformKey: string
  /** 面板分组：免费型 / 对话型 / 通用型（视觉型是横切视图，见 vision 标记） */
  group: ProbeGroup
  /** 是否具备视觉能力（图库索引可用候选）：视觉结果单独存 visionOk */
  vision?: boolean
  /** 相对标价（引擎倍率等）；null/undefined = 价格未知，不猜价 */
  price?: number | null
  /** 护栏：false = 不进自动探测（按量扣费/未过门槛等），只吃被动数据或手动单测 */
  autoProbe: boolean
  /** 账号池护栏键：同 poolKey 的目标每轮主动探测只放行一个（最便宜优先） */
  poolKey?: string
  accountId?: string
}

export interface ProbeResult {
  ok: boolean
  source: 'passive' | 'active'
  checkedAt: number
  /** 最近成功样本（首字延迟优先、无流式时总耗时），保留最近 5 次 */
  latencySamples: number[]
  attempts: number
  successes: number
  failStreak: number
  failKind?: ProbeFailKind
  /** 人话失败原因（面板/菜单展示用） */
  failReason?: string
  /** 限流冷却到期（Retry-After） */
  retryAfterUntil?: number
  /** 失败退避：下次可主动探测的时间 */
  nextProbeAt?: number
  /** 视觉能力单独结果：null/undefined = 未测 */
  visionOk?: boolean | null
  visionCheckedAt?: number
}

export interface ProbeStore {
  targets: Record<string, ProbeTarget>
  results: Record<string, ProbeResult>
}

const STORE_KEY = 'acm.probeCenter.v1'
export const PROBE_CHANGED_EVENT = 'acm-probe-changed'
/** 可用结果新鲜期：期内不重复主动探测（被动数据随时更新） */
export const PROBE_FRESH_MS = 30 * 60_000
const MAX_SAMPLES = 5

export function loadProbeStore(): ProbeStore {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return { targets: {}, results: {} }
    const p = JSON.parse(raw) as Partial<ProbeStore>
    return {
      targets: p.targets && typeof p.targets === 'object' ? p.targets : {},
      results: p.results && typeof p.results === 'object' ? p.results : {},
    }
  } catch { return { targets: {}, results: {} } }
}

export function saveProbeStore(store: ProbeStore): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store))
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(PROBE_CHANGED_EVENT))
  } catch { /* 存储不可用时静默：探测是参考状态，不阻断功能 */ }
}

/** 消费者注册/刷新目标清单（多模块共用：后注册的同 id 目标覆盖元数据，结果保留） */
export function syncProbeTargets(targets: readonly ProbeTarget[]): void {
  const store = loadProbeStore()
  let changed = false
  for (const t of targets) {
    const prev = store.targets[t.id]
    if (!prev || JSON.stringify(prev) !== JSON.stringify(t)) { store.targets[t.id] = t; changed = true }
  }
  if (changed) saveProbeStore(store)
}

// ---------------- 纯函数：口径计算 ----------------

/** 中位数（速度口径：取最近几次的中位数，不被单次抖动带偏） */
export function medianSamples(samples: readonly number[]): number | null {
  if (!samples.length) return null
  const s = [...samples].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

export function successRate(r?: ProbeResult | null): number | null {
  if (!r || r.attempts <= 0) return null
  return r.successes / r.attempts
}

/** 有效价格 = 标价 ÷ 成功率；价格未知或无从计算时返回 null（排序垫底、标「价格未知」） */
export function effectivePrice(t: ProbeTarget, r?: ProbeResult | null): number | null {
  if (t.price === null || t.price === undefined) return null
  const rate = successRate(r)
  if (rate !== null && rate <= 0) return Number.POSITIVE_INFINITY
  return t.price / (rate ?? 1)
}

/** 失败退避时长：限流按 Retry-After；auth/model 长退避（等用户修 Key/模型下线，非重试能解）；
 *  其余按连续失败次数指数退避（1 分钟起、封顶 30 分钟） */
export function probeBackoffMs(failStreak: number, kind: ProbeFailKind, retryAfterSec?: number): number {
  if (kind === 'rate' && retryAfterSec && retryAfterSec > 0) return retryAfterSec * 1000
  if (kind === 'rate' || kind === 'quota') return 10 * 60_000
  if (kind === 'auth' || kind === 'model') return 24 * 3600_000
  const base = 60_000 * Math.pow(2, Math.max(0, failStreak - 1))
  return Math.min(base, 30 * 60_000)
}

/** 结果是否新鲜（可用结果在新鲜期内不重测；失败结果过了退避期即视为过期） */
export function isProbeFresh(r: ProbeResult | undefined, now: number): boolean {
  if (!r) return false
  if (r.ok) return now - r.checkedAt < PROBE_FRESH_MS
  return now < (r.nextProbeAt ?? r.checkedAt + probeBackoffMs(r.failStreak, r.failKind ?? 'other'))
}

/** 把任意错误归类为探测失败类型 + 人话原因（复用免费链分类口径，同一事实同一分类） */
export function classifyProbeError(e: unknown): { kind: ProbeFailKind; reason: string; retryAfterSec?: number } {
  const cls = classifyChainError(e)
  const low = cls.message.toLowerCase()
  let kind: ProbeFailKind
  if (/model_not_found|model.*(?:not found|not available|does not exist|no such model)|no such model|模型(?:不存在|不可用|未找到|已下线)/.test(low)) kind = 'model'
  else if (cls.kind === 'rate') kind = 'rate'
  else if (cls.kind === 'quota') kind = 'quota'
  else if (cls.kind === 'auth') kind = 'auth'
  else if (cls.kind === 'timeout') kind = 'timeout'
  else if (cls.kind === 'network') kind = 'network'
  else if (cls.kind === 'server') kind = 'server'
  else if (cls.kind === 'empty') kind = 'empty'
  else kind = 'other'
  return { kind, reason: PROBE_FAIL_LABEL[kind], retryAfterSec: cls.retryAfterSec }
}

// ---------------- 结果写入 ----------------

export interface ProbeOutcome {
  ok: boolean
  /** 成功时的延迟样本（首字延迟优先） */
  ms?: number
  failKind?: ProbeFailKind
  failReason?: string
  retryAfterSec?: number
  source: 'passive' | 'active'
  /** 本次是否同时验证了视觉能力（带图发送成功/失败） */
  vision?: boolean
}

/** 记录一次探测/真实调用结果（被动与主动共用同一入口，同一事实只记一份） */
export function recordProbeOutcome(id: string, o: ProbeOutcome, now = Date.now()): ProbeResult {
  const store = loadProbeStore()
  const prev = store.results[id]
  const r: ProbeResult = prev ?? {
    ok: false, source: o.source, checkedAt: 0, latencySamples: [], attempts: 0, successes: 0, failStreak: 0,
  }
  r.ok = o.ok
  r.source = o.source
  r.checkedAt = now
  r.attempts += 1
  if (o.ok) {
    r.successes += 1
    r.failStreak = 0
    r.failKind = undefined
    r.failReason = undefined
    r.retryAfterUntil = undefined
    r.nextProbeAt = now + PROBE_FRESH_MS
    if (typeof o.ms === 'number' && o.ms > 0) {
      r.latencySamples = [...r.latencySamples, Math.round(o.ms)].slice(-MAX_SAMPLES)
    }
  } else {
    r.failStreak = (prev?.ok ? 0 : r.failStreak) + 1
    r.failKind = o.failKind ?? 'other'
    r.failReason = o.failReason ?? PROBE_FAIL_LABEL[r.failKind]
    const backoff = probeBackoffMs(r.failStreak, r.failKind, o.retryAfterSec)
    r.nextProbeAt = now + backoff
    r.retryAfterUntil = r.failKind === 'rate' && o.retryAfterSec ? now + o.retryAfterSec * 1000 : undefined
  }
  if (o.vision !== undefined) { r.visionOk = o.vision; r.visionCheckedAt = now }
  store.results[id] = r
  saveProbeStore(store)
  return r
}

/** 只播种不覆盖：已有结果时不写入（健康检查/门槛等既有事实作被动数据源用） */
export function seedProbeOutcome(id: string, o: ProbeOutcome, checkedAt: number, now = Date.now()): boolean {
  if (loadProbeStore().results[id]) return false
  const store = loadProbeStore()
  const r: ProbeResult = {
    ok: o.ok, source: 'passive', checkedAt, latencySamples: o.ok && o.ms ? [Math.round(o.ms)] : [],
    attempts: 1, successes: o.ok ? 1 : 0, failStreak: o.ok ? 0 : 1,
    failKind: o.ok ? undefined : (o.failKind ?? 'other'),
    failReason: o.ok ? undefined : (o.failReason ?? PROBE_FAIL_LABEL[o.failKind ?? 'other']),
    nextProbeAt: o.ok ? checkedAt + PROBE_FRESH_MS : checkedAt + probeBackoffMs(1, o.failKind ?? 'other', o.retryAfterSec),
  }
  store.results[id] = r
  saveProbeStore(store)
  void now
  return true
}

// ---------------- 汇总 / 排序 / 调度（纯函数） ----------------

export interface ProbeSummary { total: number; ok: number; bad: number; untested: number }

/** 三处计数同源（面板总览 / 图标角标 / 折叠分组都用这一份）：total=目标数，bad=角标数 */
export function probeSummary(targets: readonly ProbeTarget[], results: Record<string, ProbeResult>): ProbeSummary {
  let ok = 0, bad = 0
  for (const t of targets) {
    const r = results[t.id]
    if (!r) continue
    if (r.ok) ok++; else bad++
  }
  return { total: targets.length, ok, bad, untested: targets.length - ok - bad }
}

export function unavailableTargets(targets: readonly ProbeTarget[], results: Record<string, ProbeResult>): { target: ProbeTarget; result: ProbeResult }[] {
  return targets
    .filter(t => results[t.id] && !results[t.id].ok)
    .map(t => ({ target: t, result: results[t.id] }))
    .sort((a, b) => b.result.checkedAt - a.result.checkedAt)
}

export interface ProbeRankRow {
  target: ProbeTarget
  result?: ProbeResult
  /** 排序指标：free/chat=中位延迟 ms；general=有效价格；null=无指标（垫底） */
  metric: number | null
  metricLabel: string
  recommended: boolean
}

/**
 * 分组排名（只排可用与未测，不可用不在主列表）：可用优先——
 * free/chat 按首字延迟中位数升序（无样本的可用排可用末尾）；general 按有效价格升序
 * （价格未知垫底并标「价格未知」）；未测排在可用之后。榜首可用项标 recommended。
 */
export function rankProbeGroup(targets: readonly ProbeTarget[], results: Record<string, ProbeResult>, group: ProbeGroup): ProbeRankRow[] {
  const inGroup = targets.filter(t => t.group === group)
  const rows: ProbeRankRow[] = inGroup.map(t => {
    const r = results[t.id]
    const metric = group === 'general' ? effectivePrice(t, r) : medianSamples(r?.latencySamples ?? [])
    const metricLabel = !r ? '未测'
      : group === 'general'
        ? (metric === null ? '价格未知' : `有效价格 ${formatMetric(metric)}`)
        : (metric === null ? '可用' : `首字 ${formatMs(metric)}`)
    return { target: t, result: r, metric, metricLabel, recommended: false }
  })
  const avail = rows.filter(x => x.result?.ok)
  const untested = rows.filter(x => !x.result)
  const byMetric = (a: ProbeRankRow, b: ProbeRankRow) => {
    if (a.metric === null && b.metric === null) return 0
    if (a.metric === null) return 1
    if (b.metric === null) return -1
    return a.metric - b.metric
  }
  avail.sort(byMetric)
  if (avail.length) avail[0].recommended = true
  return [...avail, ...untested]
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}
function formatMetric(n: number): string {
  return n === Number.POSITIVE_INFINITY ? '∞' : `${Math.round(n * 100) / 100}×`
}

/**
 * 本轮主动探测清单（纯判定）：跳过新鲜结果、退避未到、autoProbe=false 的目标；
 * 账号池护栏：同 poolKey 只放行一个（价格低者优先，无价格按清单顺序）；
 * 冷门优先排序：从未测过的在前，其次按上次检测时间从旧到新。
 * force=true 时忽略新鲜期与退避（用户手动「重新探测」），但护栏仍生效。
 */
export function selectProbeBatch(
  targets: readonly ProbeTarget[], results: Record<string, ProbeResult>,
  now: number, opts?: { force?: boolean },
): ProbeTarget[] {
  const due = targets.filter(t => {
    if (!t.autoProbe) return false
    if (opts?.force) return true
    const r = results[t.id]
    if (!r) return true
    if (isProbeFresh(r, now)) return false
    if (!r.ok && r.nextProbeAt && now < r.nextProbeAt) return false
    return true
  })
  const poolPicked = new Set<string>()
  const out: ProbeTarget[] = []
  const poolGroups = new Map<string, ProbeTarget[]>()
  for (const t of due) {
    if (!t.poolKey) { out.push(t); continue }
    const arr = poolGroups.get(t.poolKey) ?? []
    arr.push(t)
    poolGroups.set(t.poolKey, arr)
  }
  for (const [key, arr] of poolGroups) {
    arr.sort((a, b) => (a.price ?? Number.POSITIVE_INFINITY) - (b.price ?? Number.POSITIVE_INFINITY))
    poolPicked.add(arr[0].id)
    void key
    out.push(arr[0])
  }
  void poolPicked
  out.sort((a, b) => {
    const ra = results[a.id], rb = results[b.id]
    if (!ra && rb) return -1
    if (ra && !rb) return 1
    return (ra?.checkedAt ?? 0) - (rb?.checkedAt ?? 0)
  })
  return out
}

/** 菜单排序：把一组目标按探测口径排序（可用按指标在前、未测居中、不可用最后），返回 id 顺序 */
export function probeOrderIds(targets: readonly ProbeTarget[], results: Record<string, ProbeResult>, group: ProbeGroup): string[] {
  const ranked = rankProbeGroup(targets, results, group).map(r => r.target.id)
  const bad = unavailableTargets(targets, results).map(x => x.target.id)
  const inGroup = new Set(targets.filter(t => t.group === group).map(t => t.id))
  return [...ranked, ...bad.filter(id => inGroup.has(id))]
}
