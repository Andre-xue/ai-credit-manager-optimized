// One AI API Key 接入（v0.1.434）：一个 Key 通吃多家模型的预付费网关，OpenAI 兼容。
//
// 官方口径（oneaiapikey.com 官网/文档，2026-11-25 实查）：
// - OpenAI 兼容基址 https://api.oneaiapikey.com/v1，Bearer 认证；
//   另有 Anthropic 兼容入口 https://api.oneaiapikey.com（根域名，SDK 自加 /v1/messages），本版只接 OpenAI 兼容。
// - GET /v1/models 返回「你的 Key 能调用的模型 id」（需带 Key；无 Key 实测 401 Invalid API key）。
// - 免费模型 id 以 :free 结尾（46 个），共享免费档：每天 100 次请求 + 500 万 tokens，
//   00:00 UTC 重置；注册送 $10 不过期、免绑卡，$10 先于免费档抵扣付费模型。
// - 每 Key 同时只允许 1 个免费车道请求在飞。
//
// 无公开余额接口（硬约束）：官方没有给 API Key 用的余额/用量查询端点，不要编造自动余额。
// 额度看板沿用手动录入（adapters 的 NO_BALANCE_API_NOTE 会明确提示去官网控制台看）；
// App 内只按本机实际发出的调用做请求/token 计数，界面一律标注「本机估算」。
//
// 启用门槛（与 Inferbase 同口径，Ethan 2026-11-26 拍板）：路线在真实冒烟通过前不得启用。
// 冒烟 = Key 管理页健康检查（用 Ethan 自己的 Key 查 /v1/models + 用免费模型发一条测试
// 消息），通过后按账户 + Key 指纹存本机（不进云同步）才启用；失败显示真实原因、零调用、
// 不进 433 自动切换链。只用 Ethan 自己的 Key：不做多账号池、不绕限额、不共享 Key。
import type { Account } from './types'

export const ONEAI_PROVIDER_ID = 'oneai'
export const ONEAI_BASE = 'https://api.oneaiapikey.com/v1'
/** 冒烟用免费车道模型（:free，不烧 $10 注册额度；官方免费列表首位推荐款） */
export const ONEAI_SMOKE_MODEL = 'gpt-6-luna:free'

/** 免费档限制（官方 free models 页 2026-11-25 实查，界面如实展示，不编造） */
export const ONEAI_FREE_LIMITS = {
  dailyRequests: 100,        // 免费车道每天 100 次请求（全账户共享）
  dailyTokens: 5_000_000,    // 免费车道每天 500 万 tokens
  signupCreditUsd: 10,       // 注册送 $10，不过期，免绑卡
  resetUtcHour: 0,           // 00:00 UTC 重置
} as const

export function oneAiLimitsText(): string {
  const L = ONEAI_FREE_LIMITS
  return `免费档：免费模型（id 以 :free 结尾）每天 ${L.dailyRequests} 次请求 + ${L.dailyTokens.toLocaleString()} tokens（00:00 UTC 重置，全账户共享）；注册送 $${L.signupCreditUsd} 不过期、免绑卡。无公开余额接口，余额请在官网控制台查看后手动录入，App 内只有本机调用估算`
}

/** 供 433 自动切换链消费的健康/额度状态（与 InferbaseRouteState 同口径） */
export type OneAiRouteState =
  | 'available'           // 可用（冒烟通过且最近检查正常）
  | 'rate_limited'        // 限流（429，冷却到下一个 UTC 零点或 Retry-After）
  | 'quota_exceeded'      // 额度不足（402 / 每日免费档用完 / $10 与充值额度耗尽）
  | 'auth_invalid'        // 密钥失效（401/403）
  | 'network_error'       // 网络不通（含 CORS 被拦）
  | 'model_unavailable'   // 模型不可用（模型不存在/下线）
  | 'pending_verification'// 待实测（未做真实冒烟，未启用）
  | 'error'               // 其他异常（保留原文）

export const ONEAI_STATE_LABEL: Record<OneAiRouteState, string> = {
  available: '可用',
  rate_limited: '限流',
  quota_exceeded: '额度不足',
  auth_invalid: '密钥失效',
  network_error: '网络不通',
  model_unavailable: '模型不可用',
  pending_verification: '待实测（未启用）',
  error: '异常',
}

export class OneAiApiError extends Error {
  status?: number
  state: OneAiRouteState
  retryAfterSec?: number
  constructor(message: string, state: OneAiRouteState, status?: number, retryAfterSec?: number) {
    super(message)
    this.name = 'OneAiApiError'
    this.state = state
    this.status = status
    this.retryAfterSec = retryAfterSec
  }
}

/** 从 HTTP 状态 + 官方错误原文归类状态（错误信封 {error:{message,type,code}}） */
export function classifyOneAiHttp(status: number, message: string, retryAfterSec?: number): OneAiApiError {
  const msg = message || `One AI API Key 接口返回 ${status}`
  let state: OneAiRouteState = 'error'
  if (status === 401 || status === 403) state = 'auth_invalid'
  else if (status === 402) state = 'quota_exceeded'
  else if (status === 429) state = 'rate_limited'
  else if (status === 404 && /model/i.test(msg)) state = 'model_unavailable'
  return new OneAiApiError(`One AI API Key 接口返回 ${status}：${msg}`, state, status, retryAfterSec)
}

/** 任意错误 → 状态（聊天走 callChat 时错误是文本，靠原文归类，原文不丢） */
export function oneAiStateFromError(e: unknown): OneAiRouteState {
  if (e instanceof OneAiApiError) return e.state
  const msg = e instanceof Error ? e.message : String(e ?? '')
  if (/401|403|invalid api key|unauthorized|authentication/i.test(msg)) return 'auth_invalid'
  if (/402|insufficient|quota|plan_limit|额度不足|余额不足|daily.*(limit|allowance)|free lane.*(pause|cap)/i.test(msg)) return 'quota_exceeded'
  if (/429|rate.?limit|too many requests|限流/i.test(msg)) return 'rate_limited'
  if (/model.*(not found|does not exist|unavailable|不存在|不可用)|404/i.test(msg)) return 'model_unavailable'
  if (/failed to fetch|network|load failed|cors|网络|桌面代理不可用|请求失败/i.test(msg)) return 'network_error'
  return 'error'
}

export function oneAiErrorText(e: unknown): string {
  if (e instanceof OneAiApiError) {
    return e.retryAfterSec ? `${e.message}（建议 ${e.retryAfterSec} 秒后重试）` : e.message
  }
  return e instanceof Error ? e.message : String(e ?? '未知错误')
}

// ---------------- 429 冷却口径 ----------------

/** 下一个 UTC 零点（毫秒） */
export function nextUtcMidnight(nowMs: number): number {
  const d = new Date(nowMs)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0)
}

export interface OneAiCooldown { until: number; reason: string }

/**
 * 限流/额度冷却到哪一刻：有 Retry-After 用 Retry-After（服务端明确给的等待时长更可解释），
 * 没有就冷却到下一个 UTC 零点（免费档 00:00 UTC 重置）。reason 写明口径，进状态展示。
 */
export function oneAiCooldownFor(state: OneAiRouteState, retryAfterSec: number | undefined, nowMs: number): OneAiCooldown | null {
  if (state !== 'rate_limited' && state !== 'quota_exceeded') return null
  if (retryAfterSec && retryAfterSec > 0) {
    return { until: nowMs + retryAfterSec * 1000, reason: `按服务端 Retry-After 冷却 ${retryAfterSec} 秒` }
  }
  return { until: nextUtcMidnight(nowMs), reason: '冷却到下一个 UTC 零点（免费档 00:00 UTC 重置）' }
}

function parseRetryAfterSec(msg: string): number | undefined {
  const m = msg.match(/retry[-\s]?after[\s:：]*(\d+)/i) ?? msg.match(/建议\s*(\d+)\s*秒后重试/)
  return m ? Number(m[1]) : undefined
}

// ---------------- 路线运行状态（冷却/密钥失效，仅本机） ----------------

const ROUTE_STATE_KEY = 'acm.oneai.routeState.v1'

export interface OneAiRouteRuntime {
  cooldownUntil: number
  cooldownReason?: string
  authInvalid?: boolean
  lastState?: OneAiRouteState
  lastError?: string
  updatedAt: number
}

function loadRouteStateMap(): Record<string, OneAiRouteRuntime> {
  try {
    const raw = localStorage.getItem(ROUTE_STATE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? parsed as Record<string, OneAiRouteRuntime> : {}
  } catch { return {} }
}

function saveRouteStateMap(map: Record<string, OneAiRouteRuntime>): void {
  try { localStorage.setItem(ROUTE_STATE_KEY, JSON.stringify(map)) } catch { /* 忽略 */ }
}

export function getOneAiRouteRuntime(accountId: string): OneAiRouteRuntime | undefined {
  return loadRouteStateMap()[accountId]
}

/** 一次真实调用失败后记录运行状态：限流/额度写冷却，401/403 标记密钥失效（停自动重试） */
export function recordOneAiRouteFailure(accountId: string, e: unknown, nowMs: number = Date.now()): OneAiRouteRuntime {
  const state = oneAiStateFromError(e)
  const text = oneAiErrorText(e)
  const map = loadRouteStateMap()
  const prev = map[accountId] ?? { cooldownUntil: 0, updatedAt: 0 }
  const next: OneAiRouteRuntime = { ...prev, lastState: state, lastError: text.slice(0, 200), updatedAt: nowMs }
  if (state === 'auth_invalid') {
    next.authInvalid = true
    next.cooldownUntil = 0
    next.cooldownReason = undefined
  } else {
    const cd = oneAiCooldownFor(state, parseRetryAfterSec(text), nowMs)
    if (cd) { next.cooldownUntil = cd.until; next.cooldownReason = cd.reason }
  }
  map[accountId] = next
  saveRouteStateMap(map)
  return next
}

/** 一次真实调用成功后清掉冷却/失效标记 */
export function recordOneAiRouteSuccess(accountId: string): void {
  const map = loadRouteStateMap()
  if (!map[accountId]) return
  delete map[accountId]
  saveRouteStateMap(map)
}

// ---------------- 本机用量估算（仅本机，按 UTC 日切分） ----------------

const USAGE_KEY = 'acm.oneai.usage.v1'

export interface OneAiLocalUsage { day: string; requests: number; tokens: number }

export function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10)
}

function loadUsageMap(): Record<string, OneAiLocalUsage> {
  try {
    const raw = localStorage.getItem(USAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? parsed as Record<string, OneAiLocalUsage> : {}
  } catch { return {} }
}

/** 记一次本机调用（请求 +1；tokens 只记响应 usage 里真实返回的总数，没返回就不记，不编造） */
export function recordOneAiLocalUsage(accountId: string, tokens: number, nowMs: number = Date.now()): OneAiLocalUsage {
  const day = utcDayKey(nowMs)
  const map = loadUsageMap()
  const cur = map[accountId]
  const next: OneAiLocalUsage = cur && cur.day === day
    ? { day, requests: cur.requests + 1, tokens: cur.tokens + Math.max(0, Math.floor(tokens) || 0) }
    : { day, requests: 1, tokens: Math.max(0, Math.floor(tokens) || 0) }
  map[accountId] = next
  try { localStorage.setItem(USAGE_KEY, JSON.stringify(map)) } catch { /* 忽略 */ }
  return next
}

/** 读今日（UTC）估算；跨日自动归零（返回零值，不改存储） */
export function loadOneAiLocalUsage(accountId: string, nowMs: number = Date.now()): OneAiLocalUsage {
  const day = utcDayKey(nowMs)
  const cur = loadUsageMap()[accountId]
  return cur && cur.day === day ? cur : { day, requests: 0, tokens: 0 }
}

/** 界面展示文案：一律标注「本机估算」，口径是免费档每日上限 */
export function oneAiEstimateText(accountId: string, nowMs: number = Date.now()): string {
  const u = loadOneAiLocalUsage(accountId, nowMs)
  const L = ONEAI_FREE_LIMITS
  return `本机估算：今日（UTC）已用 ${u.requests}/${L.dailyRequests} 次请求 · ${u.tokens.toLocaleString()}/${L.dailyTokens.toLocaleString()} tokens（仅统计本机经 App 发出的调用，官方口径以控制台为准）`
}

// ---------------- 启用门槛（冒烟验证记录，仅本机） ----------------

const VERIFY_KEY = 'acm.oneai.verification.v1'

export interface OneAiVerification {
  fingerprint?: string
  status: 'verified' | 'failed'
  state: OneAiRouteState
  message: string
  checkedAt: number
}

function loadVerifyMap(): Record<string, OneAiVerification> {
  try {
    const raw = localStorage.getItem(VERIFY_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? parsed as Record<string, OneAiVerification> : {}
  } catch { return {} }
}

export function recordOneAiVerification(
  account: Pick<Account, 'id' | 'keyFingerprint'>,
  status: 'verified' | 'failed',
  state: OneAiRouteState,
  message: string,
): void {
  try {
    const map = loadVerifyMap()
    map[account.id] = { fingerprint: account.keyFingerprint, status, state, message, checkedAt: Date.now() }
    localStorage.setItem(VERIFY_KEY, JSON.stringify(map))
  } catch { /* 存储不可用时路线保持未启用，符合门槛 */ }
  if (status === 'verified') recordOneAiRouteSuccess(account.id)
}

export interface OneAiGate { enabled: boolean; state: OneAiRouteState; message: string }

export const ONEAI_PENDING_MESSAGE =
  'One AI API Key 待实测（未启用）：先到「Key 管理」页对这个账户点健康检查——会用你自己的 Key 做一次真实冒烟（查 /v1/models 模型列表 + 用免费模型发一条测试消息），通过后才启用；未通过前不会调用它，也不会自动切换到它。现在可直接改用其他路线。'

/**
 * 路线是否可用：冒烟通过且 Key 指纹未变、且不在限流冷却中、且未被标记密钥失效，才 enabled。
 * 换 Key 后自动回到待实测；冷却/失效的真实原因写在 message 里，不静默放行。
 */
export function oneAiGate(account: Pick<Account, 'id' | 'providerId' | 'keyFingerprint'>, nowMs: number = Date.now()): OneAiGate {
  if (account.providerId !== ONEAI_PROVIDER_ID) return { enabled: true, state: 'available', message: '' }
  const rec = loadVerifyMap()[account.id]
  if (!rec || (rec.fingerprint ?? undefined) !== (account.keyFingerprint ?? undefined)) {
    return { enabled: false, state: 'pending_verification', message: ONEAI_PENDING_MESSAGE }
  }
  if (rec.status !== 'verified') {
    return {
      enabled: false,
      state: rec.state,
      message: `One AI API Key 冒烟未通过（${ONEAI_STATE_LABEL[rec.state]}）：${rec.message}。修正后到「Key 管理」页重新点健康检查；现在可直接改用其他路线。`,
    }
  }
  const rt = getOneAiRouteRuntime(account.id)
  if (rt?.authInvalid) {
    return {
      enabled: false, state: 'auth_invalid',
      message: `One AI API Key 密钥失效，已停止自动重试：${rt.lastError ?? ''}。请确认 Key 后到「Key 管理」页重新点健康检查；现在可直接改用其他路线。`,
    }
  }
  if (rt && rt.cooldownUntil > nowMs) {
    const state = rt.lastState === 'quota_exceeded' ? 'quota_exceeded' : 'rate_limited'
    return {
      enabled: false, state,
      message: `One AI API Key ${ONEAI_STATE_LABEL[state]}冷却中：${rt.cooldownReason ?? ''}（至 ${new Date(rt.cooldownUntil).toISOString()}）；最近失败：${rt.lastError ?? ''}。现在可直接改用其他路线。`,
    }
  }
  return { enabled: true, state: 'available', message: rec.message }
}
