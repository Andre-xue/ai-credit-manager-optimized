// 免费路线自动切换链（v0.1.433）：AI 助手与工坊共用的故障转移状态机。
//
// 模式（本机偏好，不云同步）：
// - locked 手动锁定：选中哪家用哪家，失败只报真实原因（433 之前的行为）。
// - auto 自动模式：首选失败且属于可切换类（限流/额度不足/5xx/超时/空响应/网络不通/
//   鉴权失效）时，按候选顺序切到下一条可用免费路线，并把切换原因交给界面明示，
//   不静默兜底；全部失败时汇总每条路线的真实原因。
//
// 健康状态只存本机：失败分类 → 冷却（429 按 Retry-After，否则分级时长；额度不足 10 分钟）、
// 连续失败 3 次熔断 5 分钟（到期后半开探测一次）、401/403 标记密钥失效并停止自动重试
// 该路线（等用户修好 Key/重新测活后用 clearChainRoute 手动恢复）。
// 流式已输出部分内容后失败（ctx.markEmitted）不自动重发，避免两条路线的回答混杂。
import { InferbaseApiError } from './inferbase'

export type ChainErrorKind = 'rate' | 'quota' | 'auth' | 'server' | 'timeout' | 'empty' | 'network' | 'abort' | 'other'

export const CHAIN_KIND_REASON: Record<ChainErrorKind, string> = {
  rate: '限流', quota: '额度不足', auth: '密钥失效', server: '服务异常', timeout: '响应超时',
  empty: '返回为空', network: '网络不通', abort: '已停止', other: '调用失败',
}

export interface ChainClassified { kind: ChainErrorKind; message: string; status?: number; retryAfterSec?: number }

/** 从错误对象/文案里提取 HTTP 状态码（结构化 status 优先，其次解析「返回 429」等文案） */
export function extractHttpStatus(e: unknown): number | undefined {
  const s = (e as { status?: unknown })?.status
  if (typeof s === 'number' && s >= 100 && s < 600) return s
  const msg = (e as Error)?.message ?? String(e ?? '')
  const m = msg.match(/(?:返回|HTTP|status|code)[\s:：]*(\d{3})/i) ?? msg.match(/\b(401|402|403|429|5\d{2})\b/)
  return m ? Number(m[1]) : undefined
}

function extractRetryAfterSec(e: unknown): number | undefined {
  if (e instanceof InferbaseApiError && e.retryAfterSec) return e.retryAfterSec
  const s = (e as { retryAfterSec?: unknown })?.retryAfterSec
  if (typeof s === 'number' && s > 0) return s
  const msg = (e as Error)?.message ?? String(e ?? '')
  const m = msg.match(/retry[-\s]?after[\s:：]*(\d+)/i) ?? msg.match(/建议\s*(\d+)\s*秒后重试/)
  return m ? Number(m[1]) : undefined
}

/** 把任意失败归类为链路错误类型（纯函数，可测）。顺序即优先级，勿随意调换 */
export function classifyChainError(e: unknown): ChainClassified {
  const message = ((e as Error)?.message ?? String(e ?? '')).slice(0, 300)
  const status = extractHttpStatus(e)
  const retryAfterSec = extractRetryAfterSec(e)
  const low = message.toLowerCase()
  let kind: ChainErrorKind = 'other'
  if (/已停止|aborted|aborterror/.test(low)) kind = 'abort'
  else if (status === 401 || status === 403 || /unauthor|invalid[_\s]?api[_\s]?key|invalid_api_key|密钥失效|auth_invalid|authentication failed/.test(low)) kind = 'auth'
  else if (status === 402 || /quota|额度|insufficient|plan_limit|freeusagelimit|余额不足/.test(low)) kind = 'quota'
  else if (status === 429 || /rate[_\s]?limit|限流|too many requests/.test(low)) kind = 'rate'
  else if (/timeout|timed out|超时/.test(low)) kind = 'timeout'
  else if (/未返回文本|返回为空|空响应|empty response|no text/.test(low)) kind = 'empty'
  else if (status !== undefined && status >= 500) kind = 'server'
  else if (/failed to fetch|network|load failed|网络|econn|enotfound|dns|cors|connect/.test(low)) kind = 'network'
  return { kind, message, status, retryAfterSec }
}

/** 哪些失败值得切下一条路线；abort/other（如 400 请求本身不合法）不切，原样报给用户 */
export function failoverEligible(kind: ChainErrorKind): boolean {
  return kind === 'rate' || kind === 'quota' || kind === 'auth' || kind === 'server'
    || kind === 'timeout' || kind === 'empty' || kind === 'network'
}

// ---------------- 健康状态（本机） ----------------

export interface ChainRouteHealth {
  failStreak: number
  cooldownUntil: number
  breakerUntil: number
  authDead: boolean
  lastError?: string
  lastOkAt?: number
}

const HEALTH_KEY = 'acm.freeChain.v1'
const BREAKER_THRESHOLD = 3
const BREAKER_MS = 5 * 60_000
const QUOTA_COOLDOWN_MS = 10 * 60_000

export function loadChainHealth(): Record<string, ChainRouteHealth> {
  try {
    const raw = localStorage.getItem(HEALTH_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, ChainRouteHealth> : {}
  } catch { return {} }
}

function saveChainHealth(map: Record<string, ChainRouteHealth>): void {
  try { localStorage.setItem(HEALTH_KEY, JSON.stringify(map)) } catch { /* 忽略 */ }
}

const freshHealth = (): ChainRouteHealth => ({ failStreak: 0, cooldownUntil: 0, breakerUntil: 0, authDead: false })

export function getChainRouteHealth(id: string): ChainRouteHealth {
  return loadChainHealth()[id] ?? freshHealth()
}

export function recordChainSuccess(id: string, now = Date.now()): void {
  const map = loadChainHealth()
  map[id] = { ...freshHealth(), lastOkAt: now }
  saveChainHealth(map)
}

/** 记录一次失败并算出冷却/熔断；other 类只记错误原文，不冷却不计数（避免误伤路线） */
export function recordChainFailure(id: string, cls: ChainClassified, now = Date.now()): ChainRouteHealth {
  const map = loadChainHealth()
  const h = map[id] ?? freshHealth()
  h.lastError = cls.message.slice(0, 200)
  if (cls.kind === 'auth') {
    h.authDead = true
    h.cooldownUntil = 0
    h.breakerUntil = 0
  } else if (failoverEligible(cls.kind)) {
    h.failStreak += 1
    let cooldownMs: number
    if (cls.kind === 'rate') cooldownMs = (cls.retryAfterSec ?? 60) * 1000
    else if (cls.kind === 'quota') cooldownMs = QUOTA_COOLDOWN_MS
    else cooldownMs = Math.min(60_000 * h.failStreak, 600_000)
    h.cooldownUntil = now + cooldownMs
    if (h.failStreak >= BREAKER_THRESHOLD) h.breakerUntil = now + BREAKER_MS
  }
  map[id] = h
  saveChainHealth(map)
  return h
}

/** 手动恢复一条路线（修好 Key / 重新测活通过后调用） */
export function clearChainRoute(id: string): void {
  const map = loadChainHealth()
  delete map[id]
  saveChainHealth(map)
}

export interface ChainAvailability { available: boolean; probe: boolean; reason?: string }

/** 路线当前能否被链选中；熔断到期返回 probe=true（半开：放一次真实请求试探） */
export function chainAvailability(id: string, now = Date.now()): ChainAvailability {
  const h = getChainRouteHealth(id)
  if (h.authDead) return { available: false, probe: false, reason: `密钥失效，已停止自动重试（${h.lastError ?? ''}）`.slice(0, 120) }
  if (h.breakerUntil > now) return { available: false, probe: false, reason: '连续失败熔断冷却中' }
  if (h.cooldownUntil > now) return { available: false, probe: false, reason: `冷却中（${h.lastError ?? '上次失败'}）`.slice(0, 120) }
  return { available: true, probe: h.breakerUntil > 0 || h.failStreak > 0 }
}

// ---------------- 模式偏好 ----------------

export type ChainMode = 'auto' | 'locked'
const MODE_KEY = 'acm.freeChain.mode.v1'
export const CHAIN_MODE_EVENT = 'acm-chain-mode-changed'

export function loadChainMode(): ChainMode {
  try { return localStorage.getItem(MODE_KEY) === 'locked' ? 'locked' : 'auto' } catch { return 'auto' }
}

export function saveChainMode(mode: ChainMode): void {
  try { localStorage.setItem(MODE_KEY, mode) } catch { /* 忽略 */ }
  try { window.dispatchEvent(new Event(CHAIN_MODE_EVENT)) } catch { /* 非浏览器环境 */ }
}

// ---------------- 链执行 ----------------

/** 候选类别的缺省顺序（首选之外按此排；APIsFreeLLM 永远最后兜底） */
export const CHAIN_KIND_ORDER = ['cloud', 'zen', 'kilo', 'inferbase', 'oneai', 'anyapi', 'wbpool', 'apisfree']

/** 首选置顶，其余按类别顺序稳定排序（纯函数） */
export function orderChainCandidates<T extends { id: string; kind: string }>(selectedId: string, list: T[]): T[] {
  const idx = (kind: string) => { const i = CHAIN_KIND_ORDER.indexOf(kind); return i < 0 ? CHAIN_KIND_ORDER.length : i }
  const sel = list.find(x => x.id === selectedId)
  const rest = list.filter(x => x.id !== selectedId)
  rest.sort((a, b) => idx(a.kind) - idx(b.kind))
  return sel ? [sel, ...rest] : rest
}

export interface ChainCandidate { id: string; label: string; kind: string }
export interface ChainAttemptCtx { markEmitted: () => void }
export interface ChainSwitch { fromId: string; fromLabel: string; toId: string; toLabel: string; kind: ChainErrorKind; reason: string }
export interface ChainFailure { id: string; label: string; kind: ChainErrorKind; message: string }
export interface ChainResult {
  text: string
  usedId: string
  usedLabel: string
  switches: ChainSwitch[]
  failures: ChainFailure[]
}

export class ChainAllFailedError extends Error {
  failures: ChainFailure[]
  skipped: { id: string; label: string; reason: string }[]
  constructor(failures: ChainFailure[], skipped: { id: string; label: string; reason: string }[]) {
    const parts = [
      ...failures.map(f => `${f.label}：${f.message}`),
      ...skipped.map(s => `${s.label}：${s.reason}`),
    ]
    super(`全部路线都不可用——${parts.join('；')}`.slice(0, 600))
    this.name = 'ChainAllFailedError'
    this.failures = failures
    this.skipped = skipped
  }
}

/** 已输出部分内容后失败：不自动重发，原文错误向上抛，由界面提示可手动重试/切换 */
export class ChainPartialError extends Error {
  cause: unknown
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause ?? '调用失败'))
    this.name = 'ChainPartialError'
    this.cause = cause
  }
}

/**
 * 跑一次链：依次尝试可用候选，成功即返回（并记录切换明细供界面明示）；
 * 可切换失败记录健康状态后继续；不可切换失败（400 类/abort/门槛类）原样抛出；
 * 已输出后失败抛 ChainPartialError；全部失败抛 ChainAllFailedError（汇总真实原因）。
 */
export async function runFreeChain(
  candidates: ChainCandidate[],
  attempt: (cand: ChainCandidate, ctx: ChainAttemptCtx) => Promise<string>,
  opts?: { extraAvailability?: (cand: ChainCandidate) => ChainAvailability | null },
): Promise<ChainResult> {
  const failures: ChainFailure[] = []
  const skipped: { id: string; label: string; reason: string }[] = []
  for (const cand of candidates) {
    const extra = opts?.extraAvailability?.(cand)
    const avail = extra ?? chainAvailability(cand.id)
    if (!avail.available) { skipped.push({ id: cand.id, label: cand.label, reason: avail.reason ?? '暂不可用' }); continue }
    let emitted = false
    const ctx: ChainAttemptCtx = { markEmitted: () => { emitted = true } }
    try {
      const text = await attempt(cand, ctx)
      if (!text.trim()) throw new Error('接口返回为空（空响应）')
      recordChainSuccess(cand.id)
      const switches: ChainSwitch[] = failures.map(f => ({
        fromId: f.id, fromLabel: f.label, toId: cand.id, toLabel: cand.label,
        kind: f.kind, reason: CHAIN_KIND_REASON[f.kind],
      }))
      return { text, usedId: cand.id, usedLabel: cand.label, switches, failures }
    } catch (e) {
      if (emitted) throw new ChainPartialError(e)
      const cls = classifyChainError(e)
      if (cls.kind === 'abort') throw e
      recordChainFailure(cand.id, cls)
      if (!failoverEligible(cls.kind)) throw e
      failures.push({ id: cand.id, label: cand.label, kind: cls.kind, message: cls.message })
    }
  }
  throw new ChainAllFailedError(failures, skipped)
}
