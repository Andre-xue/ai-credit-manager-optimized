// AnyAPI.ai 接入（v0.1.435）：多模型聚合网关，OpenAI 兼容。免费服务队列第四优先。
//
// 官方口径（anyapi.ai 官网 + docs.anyapi.ai，2026-11-26 实查）：
// - OpenAI 兼容基址 https://api.anyapi.ai/v1，Bearer 认证。
// - GET /v1/models 需带 Key（无 Key 实测 401 {"error":{"message":"Invalid credentials",
//   "type":"auth_error","code":"401"}}）；模型全量以该接口按 Key 动态拉取为准——
//   官网未公开可核实的免费模型 id 清单，引擎目录不预置、不编造模型名。
// - 免费档：每天 100,000 AnyTokens、免绑卡，仅免费（基础）模型可用；API 调用受限，
//   但官网未公布具体限额数字（界面如实写「官网未公布具体限额」，不编造）。
//
// 无公开余额接口（硬约束）：官方没有给 API Key 用的余额/用量查询端点，不要编造自动余额。
// 额度看板沿用手动录入（adapters 的 NO_BALANCE_API_NOTE 会明确提示去官网控制台看）；
// App 内只按本机实际发出的调用做请求/token 计数，界面一律标注「本机估算」
// （官方额度单位是 AnyTokens，本机 token 数只是参考估算）。
//
// 启用门槛（本版核心，与 Inferbase / One AI 同口径，Ethan 2026-11-26 拍板）：必须先用
// Ethan 自己的账号在 App 内实测免费模型调用成功后才默认启用并进入自动切换链。
// 冒烟 = Key 管理页健康检查（用他自己的 Key 查 /v1/models + 从返回列表里挑一个模型
// 发一条测试消息），通过后按账户 + Key 指纹存本机（不进云同步）才启用；未通过前一律
// 「待实测（未启用）」、发送零调用、不进 433 自动切换链候选，失败显示真实原因。
// 只用 Ethan 自己的 Key：不做多账号池、不绕限额、不共享 Key。
import type { Account } from './types'
import { utcDayKey } from './oneai'

export const ANYAPI_PROVIDER_ID = 'anyapi'
export const ANYAPI_BASE = 'https://api.anyapi.ai/v1'

/** 免费档（docs.anyapi.ai 定价页 2026-11-26 实查，界面如实展示，不编造） */
export const ANYAPI_FREE_LIMITS = {
  dailyAnyTokens: 100_000,   // 每天 100,000 AnyTokens（官方额度单位）
} as const

export function anyApiLimitsText(): string {
  const L = ANYAPI_FREE_LIMITS
  return `免费档：每天 ${L.dailyAnyTokens.toLocaleString()} AnyTokens、免绑卡，仅免费（基础）模型可用；API 调用受限，官网未公布具体限额。无公开余额接口，余额请在官网控制台查看后手动录入，App 内只有本机调用估算`
}

/** 供 433 自动切换链消费的健康/额度状态（与 InferbaseRouteState / OneAiRouteState 同口径） */
export type AnyApiRouteState =
  | 'available'           // 可用（冒烟通过且最近检查正常）
  | 'rate_limited'        // 限流（429，按 Retry-After 冷却，无则 60 秒）
  | 'quota_exceeded'      // 额度不足（402 / AnyTokens 用完）
  | 'auth_invalid'        // 密钥失效（401/403）
  | 'network_error'       // 网络不通（含 CORS 被拦）
  | 'model_unavailable'   // 模型不可用（模型不存在/下线）
  | 'pending_verification'// 待实测（未做真实冒烟，未启用）
  | 'error'               // 其他异常（保留原文）

export const ANYAPI_STATE_LABEL: Record<AnyApiRouteState, string> = {
  available: '可用',
  rate_limited: '限流',
  quota_exceeded: '额度不足',
  auth_invalid: '密钥失效',
  network_error: '网络不通',
  model_unavailable: '模型不可用',
  pending_verification: '待实测（未启用）',
  error: '异常',
}

export class AnyApiApiError extends Error {
  status?: number
  state: AnyApiRouteState
  retryAfterSec?: number
  constructor(message: string, state: AnyApiRouteState, status?: number, retryAfterSec?: number) {
    super(message)
    this.name = 'AnyApiApiError'
    this.state = state
    this.status = status
    this.retryAfterSec = retryAfterSec
  }
}

/** 从 HTTP 状态 + 官方错误原文归类状态（错误信封 {error:{message,type,code}}，401 实测为 auth_error） */
export function classifyAnyApiHttp(status: number, message: string, retryAfterSec?: number): AnyApiApiError {
  const msg = message || `AnyAPI 接口返回 ${status}`
  let state: AnyApiRouteState = 'error'
  if (status === 401 || status === 403) state = 'auth_invalid'
  else if (status === 402) state = 'quota_exceeded'
  else if (status === 429) state = 'rate_limited'
  else if (status === 404 && /model/i.test(msg)) state = 'model_unavailable'
  return new AnyApiApiError(`AnyAPI 接口返回 ${status}：${msg}`, state, status, retryAfterSec)
}

/** 任意错误 → 状态（聊天走 callChat 时错误是文本，靠原文归类，原文不丢） */
export function anyApiStateFromError(e: unknown): AnyApiRouteState {
  if (e instanceof AnyApiApiError) return e.state
  const msg = e instanceof Error ? e.message : String(e ?? '')
  if (/401|403|invalid credentials|invalid api key|unauthorized|authentication/i.test(msg)) return 'auth_invalid'
  if (/402|insufficient|quota|plan_limit|额度不足|余额不足|anytokens/i.test(msg)) return 'quota_exceeded'
  if (/429|rate.?limit|too many requests|限流/i.test(msg)) return 'rate_limited'
  if (/model.*(not found|does not exist|unavailable|不存在|不可用)|404/i.test(msg)) return 'model_unavailable'
  if (/failed to fetch|network|load failed|cors|网络|桌面代理不可用|请求失败/i.test(msg)) return 'network_error'
  return 'error'
}

export function anyApiErrorText(e: unknown): string {
  if (e instanceof AnyApiApiError) {
    return e.retryAfterSec ? `${e.message}（建议 ${e.retryAfterSec} 秒后重试）` : e.message
  }
  return e instanceof Error ? e.message : String(e ?? '未知错误')
}

// ---------------- 429 / 额度冷却口径 ----------------

export const ANYAPI_RATE_COOLDOWN_MS = 60_000      // 429 无 Retry-After 时的缺省冷却
export const ANYAPI_QUOTA_COOLDOWN_MS = 10 * 60_000 // 额度不足冷却（官网未公布恢复口径）

export interface AnyApiCooldown { until: number; reason: string }

/**
 * 限流/额度冷却到哪一刻：有 Retry-After 用 Retry-After（服务端明确给的等待时长最可解释）；
 * 没有时——限流按 60 秒（与 433 切换链缺省口径一致）、额度不足按 10 分钟，reason 写明
 * 「官网未公布具体限额/恢复口径」，不编造官方重置时间。
 */
export function anyApiCooldownFor(state: AnyApiRouteState, retryAfterSec: number | undefined, nowMs: number): AnyApiCooldown | null {
  if (state !== 'rate_limited' && state !== 'quota_exceeded') return null
  if (retryAfterSec && retryAfterSec > 0) {
    return { until: nowMs + retryAfterSec * 1000, reason: `按服务端 Retry-After 冷却 ${retryAfterSec} 秒` }
  }
  if (state === 'rate_limited') {
    return { until: nowMs + ANYAPI_RATE_COOLDOWN_MS, reason: '无 Retry-After，限流冷却 60 秒（官网未公布具体限额）' }
  }
  return { until: nowMs + ANYAPI_QUOTA_COOLDOWN_MS, reason: '额度不足冷却 10 分钟（官网未公布额度恢复口径）' }
}

function parseRetryAfterSec(msg: string): number | undefined {
  const m = msg.match(/retry[-\s]?after[\s:：]*(\d+)/i) ?? msg.match(/建议\s*(\d+)\s*秒后重试/)
  return m ? Number(m[1]) : undefined
}

// ---------------- 路线运行状态（冷却/密钥失效，仅本机） ----------------

const ROUTE_STATE_KEY = 'acm.anyapi.routeState.v1'

export interface AnyApiRouteRuntime {
  cooldownUntil: number
  cooldownReason?: string
  authInvalid?: boolean
  lastState?: AnyApiRouteState
  lastError?: string
  updatedAt: number
}

function loadRouteStateMap(): Record<string, AnyApiRouteRuntime> {
  try {
    const raw = localStorage.getItem(ROUTE_STATE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? parsed as Record<string, AnyApiRouteRuntime> : {}
  } catch { return {} }
}

function saveRouteStateMap(map: Record<string, AnyApiRouteRuntime>): void {
  try { localStorage.setItem(ROUTE_STATE_KEY, JSON.stringify(map)) } catch { /* 忽略 */ }
}

export function getAnyApiRouteRuntime(accountId: string): AnyApiRouteRuntime | undefined {
  return loadRouteStateMap()[accountId]
}

/** 一次真实调用失败后记录运行状态：限流/额度写冷却，401/403 标记密钥失效（停自动重试） */
export function recordAnyApiRouteFailure(accountId: string, e: unknown, nowMs: number = Date.now()): AnyApiRouteRuntime {
  const state = anyApiStateFromError(e)
  const text = anyApiErrorText(e)
  const map = loadRouteStateMap()
  const prev = map[accountId] ?? { cooldownUntil: 0, updatedAt: 0 }
  const next: AnyApiRouteRuntime = { ...prev, lastState: state, lastError: text.slice(0, 200), updatedAt: nowMs }
  if (state === 'auth_invalid') {
    next.authInvalid = true
    next.cooldownUntil = 0
    next.cooldownReason = undefined
  } else {
    const cd = anyApiCooldownFor(state, parseRetryAfterSec(text), nowMs)
    if (cd) { next.cooldownUntil = cd.until; next.cooldownReason = cd.reason }
  }
  map[accountId] = next
  saveRouteStateMap(map)
  return next
}

/** 一次真实调用成功后清掉冷却/失效标记 */
export function recordAnyApiRouteSuccess(accountId: string): void {
  const map = loadRouteStateMap()
  if (!map[accountId]) return
  delete map[accountId]
  saveRouteStateMap(map)
}

// ---------------- 本机用量估算（仅本机，按 UTC 日切分，沿用 434 口径） ----------------

const USAGE_KEY = 'acm.anyapi.usage.v1'

export interface AnyApiLocalUsage { day: string; requests: number; tokens: number }

function loadUsageMap(): Record<string, AnyApiLocalUsage> {
  try {
    const raw = localStorage.getItem(USAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? parsed as Record<string, AnyApiLocalUsage> : {}
  } catch { return {} }
}

/** 记一次本机调用（请求 +1；tokens 只记响应 usage 里真实返回的总数，没返回就不记，不编造） */
export function recordAnyApiLocalUsage(accountId: string, tokens: number, nowMs: number = Date.now()): AnyApiLocalUsage {
  const day = utcDayKey(nowMs)
  const map = loadUsageMap()
  const cur = map[accountId]
  const next: AnyApiLocalUsage = cur && cur.day === day
    ? { day, requests: cur.requests + 1, tokens: cur.tokens + Math.max(0, Math.floor(tokens) || 0) }
    : { day, requests: 1, tokens: Math.max(0, Math.floor(tokens) || 0) }
  map[accountId] = next
  try { localStorage.setItem(USAGE_KEY, JSON.stringify(map)) } catch { /* 忽略 */ }
  return next
}

/** 读今日（UTC）估算；跨日自动归零（返回零值，不改存储） */
export function loadAnyApiLocalUsage(accountId: string, nowMs: number = Date.now()): AnyApiLocalUsage {
  const day = utcDayKey(nowMs)
  const cur = loadUsageMap()[accountId]
  return cur && cur.day === day ? cur : { day, requests: 0, tokens: 0 }
}

/** 界面展示文案：一律标注「本机估算」；官方额度单位是 AnyTokens，本机 token 数只是参考 */
export function anyApiEstimateText(accountId: string, nowMs: number = Date.now()): string {
  const u = loadAnyApiLocalUsage(accountId, nowMs)
  const L = ANYAPI_FREE_LIMITS
  return `本机估算：今日（UTC）已用 ${u.requests} 次请求 · 约 ${u.tokens.toLocaleString()} tokens（官方免费额度单位是 AnyTokens，每天 ${L.dailyAnyTokens.toLocaleString()}；本机 token 数仅作参考估算，官方口径以控制台为准）`
}

// ---------------- 冒烟模型挑选（从 /v1/models 真实返回里挑，不编造） ----------------

/**
 * 从 Key 实际可调用的模型列表里挑冒烟/默认对话模型：优先 id 带 free 标记的，
 * 其次开源权重家族（免费档「仅基础/免费模型可用」，这类最可能在免费档内），
 * 都没有就用列表第一个。挑中的 id 必然来自官方真实返回，不在代码里写死模型名。
 */
export function pickAnyApiSmokeModel(models: string[]): string | undefined {
  const ids = models.filter(id => typeof id === 'string' && id.length > 0)
  if (!ids.length) return undefined
  const free = ids.find(id => /free/i.test(id))
  if (free) return free
  const open = ids.find(id => /(llama|gemma|mistral|mixtral|qwen|deepseek|phi|falcon)/i.test(id))
  if (open) return open
  return ids[0]
}

// ---------------- 启用门槛（冒烟验证记录，仅本机） ----------------

const VERIFY_KEY = 'acm.anyapi.verification.v1'

export interface AnyApiVerification {
  fingerprint?: string
  status: 'verified' | 'failed'
  state: AnyApiRouteState
  message: string
  /** 冒烟实际用通的模型 id（来自 /v1/models 真实返回）；启用后作默认对话模型 */
  smokeModel?: string
  checkedAt: number
}

function loadVerifyMap(): Record<string, AnyApiVerification> {
  try {
    const raw = localStorage.getItem(VERIFY_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? parsed as Record<string, AnyApiVerification> : {}
  } catch { return {} }
}

export function recordAnyApiVerification(
  account: Pick<Account, 'id' | 'keyFingerprint'>,
  status: 'verified' | 'failed',
  state: AnyApiRouteState,
  message: string,
  smokeModel?: string,
): void {
  try {
    const map = loadVerifyMap()
    map[account.id] = { fingerprint: account.keyFingerprint, status, state, message, smokeModel, checkedAt: Date.now() }
    localStorage.setItem(VERIFY_KEY, JSON.stringify(map))
  } catch { /* 存储不可用时路线保持未启用，符合门槛 */ }
  if (status === 'verified') recordAnyApiRouteSuccess(account.id)
}

/** 冒烟通过时实际用通的模型（仅已验证记录才返回）；未验证/失败返回 undefined */
export function getAnyApiSmokeModel(accountId: string): string | undefined {
  const rec = loadVerifyMap()[accountId]
  return rec?.status === 'verified' ? rec.smokeModel : undefined
}

export interface AnyApiGate { enabled: boolean; state: AnyApiRouteState; message: string }

export const ANYAPI_PENDING_MESSAGE =
  'AnyAPI 待实测（未启用）：先到「Key 管理」页对这个账户点健康检查——会用你自己的 Key 做一次真实冒烟（查 /v1/models 模型列表 + 发一条测试消息），通过后才启用；未通过前不会调用它，也不会自动切换到它。现在可直接改用其他路线。'

/**
 * 路线是否可用：冒烟通过且 Key 指纹未变、且不在限流冷却中、且未被标记密钥失效，才 enabled。
 * 换 Key 后自动回到待实测；冷却/失效的真实原因写在 message 里，不静默放行。
 */
export function anyApiGate(account: Pick<Account, 'id' | 'providerId' | 'keyFingerprint'>, nowMs: number = Date.now()): AnyApiGate {
  if (account.providerId !== ANYAPI_PROVIDER_ID) return { enabled: true, state: 'available', message: '' }
  const rec = loadVerifyMap()[account.id]
  if (!rec || (rec.fingerprint ?? undefined) !== (account.keyFingerprint ?? undefined)) {
    return { enabled: false, state: 'pending_verification', message: ANYAPI_PENDING_MESSAGE }
  }
  if (rec.status !== 'verified') {
    return {
      enabled: false,
      state: rec.state,
      message: `AnyAPI 冒烟未通过（${ANYAPI_STATE_LABEL[rec.state]}）：${rec.message}。修正后到「Key 管理」页重新点健康检查；现在可直接改用其他路线。`,
    }
  }
  const rt = getAnyApiRouteRuntime(account.id)
  if (rt?.authInvalid) {
    return {
      enabled: false, state: 'auth_invalid',
      message: `AnyAPI 密钥失效，已停止自动重试：${rt.lastError ?? ''}。请确认 Key 后到「Key 管理」页重新点健康检查；现在可直接改用其他路线。`,
    }
  }
  if (rt && rt.cooldownUntil > nowMs) {
    const state = rt.lastState === 'quota_exceeded' ? 'quota_exceeded' : 'rate_limited'
    return {
      enabled: false, state,
      message: `AnyAPI ${ANYAPI_STATE_LABEL[state]}冷却中：${rt.cooldownReason ?? ''}（至 ${new Date(rt.cooldownUntil).toISOString()}）；最近失败：${rt.lastError ?? ''}。现在可直接改用其他路线。`,
    }
  }
  return { enabled: true, state: 'available', message: rec.message }
}
