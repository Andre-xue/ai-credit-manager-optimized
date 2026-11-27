// TokenRouter 接入（v0.1.514）：多模型聚合网关，OpenAI 兼容，第 62 个平台。
// 运营方 Artemis Tokenrouter Inc.，是第三方中转——请求数据经 TokenRouter 与其
// 上游服务商处理，不要用它跑敏感内容（平台说明与添加账户提示里如实写明）。
//
// 官方口径（tokenrouter.com，2026-11-27 主聊天核查、双来源互证）：
// - OpenAI 兼容基址 https://api.tokenrouter.com/v1，Bearer 认证。
// - 免费模型会轮换（Kimi K3、Qwen Max 的免费版都出过又下线）：接入时 $0 名单为
//   deepseek/deepseek-v4.1-flash-1017-free（主力，底层 DeepSeek-V4.1-Flash-1017，
//   1M 上下文）与 nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free（备胎，弱一截）。
//   同系列付费版 deepseek-v4.1-flash-1017 约 $0.075–0.08 输入 / $0.30 输出
//   每百万 tokens（平台标价口径）。
// - 平台全量目录有 100+ 模型：本 App 不拉全量，只用下方精选清单常量（3 个）——
//   免费名单轮换时改这一处常量即可，不做动态全量拉取（防「145 个模型找花眼」）。
//
// 无公开余额/额度接口（硬约束）：官方没有给 API Key 用的余额/剩余额度查询端点，
// 免费额度也未公布具体数值——界面一律标「免费额度未公布」，不编造数字。
// 额度看板沿用手动录入（adapters 的 NO_BALANCE_API_NOTE 会明确提示）；App 内只按
// 本机实际发出的调用做请求/token 计数，界面一律标注「本机估算」。
//
// 启用门槛（与 Inferbase / One AI / AnyAPI 同口径，Ethan 拍板）：必须先用 Ethan
// 自己的 Key 在 App 内实测调用成功后才启用。冒烟 = Key 管理页健康检查（用免费
// 主力模型发一条测试消息——精选清单是本机常量、不发列表请求，Key 有效性以聊天
// 冒烟为准，与 MoMA /v1/models 证明不了 Key 有效同理），通过后按账户 + Key 指纹
// 存本机（不进云同步）才启用；未通过前一律「待实测（未启用）」、发送零调用。
// 只用 Ethan 自己的 Key：不做多账号池、不绕限额、不共享 Key。
//
// 免费自动切换链（433）：TokenRouter 定位低优先级免费通道，进链**末位**
// （Inferbase → One AI → AnyAPI.ai → WorkBuddy 账号池 → APIsFreeLLM 之后）。
// 链上只用两个免费模型——付费版 deepseek-v4.1-flash-1017 永不被自动切入，
// 只能由用户手动直选（与自有付费账户同口径）。免费模型下线后网关会回
// model_not_found：链与门槛都按「模型不可用」如实显示，不误报额度/限流。
import type { Account } from './types'
import { utcDayKey } from './oneai'

export const TOKENROUTER_PROVIDER_ID = 'tokenrouter'
export const TOKENROUTER_BASE = 'https://api.tokenrouter.com/v1'

// ---------------- 精选模型清单（平台精选常量，免费名单轮换时只改这里） ----------------

export interface TokenRouterModel {
  id: string
  /** 是否 $0 免费模型（平台标价口径，接入时核实） */
  free: boolean
  /** 展示侧的计费标注：免费款标免费，付费款带平台标价，不编造 */
  priceNote: string
}

/** 精选短名单：两个免费模型置顶，付费版紧随其后并明确标价。不拉全量目录。 */
export const TOKENROUTER_MODELS: TokenRouterModel[] = [
  { id: 'deepseek/deepseek-v4.1-flash-1017-free', free: true, priceNote: '免费（$0）· 1M 上下文' },
  { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', free: true, priceNote: '免费（$0）· 备选，能力弱一截' },
  { id: 'deepseek-v4.1-flash-1017', free: false, priceNote: '付费 · 约 $0.075–0.08 输入 / $0.30 输出 每百万 tokens（平台标价）' },
]

export const TOKENROUTER_FREE_MODELS: string[] = TOKENROUTER_MODELS.filter(m => m.free).map(m => m.id)

/** 冒烟与切换链默认用的免费主力模型（精选清单第一个免费款） */
export const TOKENROUTER_SMOKE_MODEL = TOKENROUTER_FREE_MODELS[0]

export function isTokenRouterFreeModel(id: string): boolean {
  return TOKENROUTER_FREE_MODELS.includes(id)
}

/** 模型列表计费标注：以精选清单为准；清单外的 id 不猜价格，如实标未收录 */
export function tokenRouterModelPriceNote(id: string): string {
  return TOKENROUTER_MODELS.find(m => m.id === id)?.priceNote ?? '未收录精选清单，价格以平台为准'
}

/** 平台口径文案（风险提示如实写全：第三方中转 / 数据经手 / 免费未公布额度 / 免费随时下线） */
export function tokenRouterLimitsText(): string {
  return 'TokenRouter（运营方 Artemis Tokenrouter Inc.）是第三方中转网关：请求数据会经 TokenRouter 及其上游服务商处理，不要用它跑敏感内容。OpenAI 兼容，精选清单只有 3 个模型（不拉全量目录）：两个免费模型（$0）置顶、同系列付费版单独标价。免费额度未公布、无公开余额接口，余额请在官网控制台查看后手动录入，App 内只有本机调用估算。免费模型随时可能下线，下线后会如实显示不可用。已实测启用的账户会进入免费路线自动切换链末位（只切两个免费模型，付费版永不被自动切入）'
}

/** 供门槛/路线消费的健康状态（与 AnyApiRouteState 同口径） */
export type TokenRouterRouteState =
  | 'available'           // 可用（冒烟通过且最近检查正常）
  | 'rate_limited'        // 限流（429，按 Retry-After 冷却，无则 60 秒）
  | 'quota_exceeded'      // 额度不足（402 / 余额不足）
  | 'auth_invalid'        // 密钥失效（401/403）
  | 'network_error'       // 网络不通（含 CORS 被拦）
  | 'model_unavailable'   // 模型不可用（模型不存在/下线——免费轮换下线走这里）
  | 'pending_verification'// 待实测（未做真实冒烟，未启用）
  | 'error'               // 其他异常（保留原文）

export const TOKENROUTER_STATE_LABEL: Record<TokenRouterRouteState, string> = {
  available: '可用',
  rate_limited: '限流',
  quota_exceeded: '额度不足',
  auth_invalid: '密钥失效',
  network_error: '网络不通',
  model_unavailable: '模型不可用',
  pending_verification: '待实测（未启用）',
  error: '异常',
}

export class TokenRouterApiError extends Error {
  status?: number
  state: TokenRouterRouteState
  retryAfterSec?: number
  constructor(message: string, state: TokenRouterRouteState, status?: number, retryAfterSec?: number) {
    super(message)
    this.name = 'TokenRouterApiError'
    this.state = state
    this.status = status
    this.retryAfterSec = retryAfterSec
  }
}

/** 「网关不认此模型」强特征（v0.1.464，与 moma / anyapi 同口径）：免费模型轮换
 * 下线后网关回 model_not_found，必须最先归类成 model_unavailable，不许被额度/
 * 限流误吞并给账户上冷却。 */
export const TOKENROUTER_MODEL_NOT_FOUND_RE = /model_not_found|model.*(?:not found|not available|does not exist|no such model)|no such model|模型(?:不存在|不可用|未找到|已下线)/i

/** 从 HTTP 状态 + 官方错误原文归类状态（错误信封与 OpenAI 同构 {error:{message}}） */
export function classifyTokenRouterHttp(status: number, message: string, retryAfterSec?: number): TokenRouterApiError {
  const msg = message || `TokenRouter 接口返回 ${status}`
  let state: TokenRouterRouteState = 'error'
  if ((status === 400 || status === 404) && TOKENROUTER_MODEL_NOT_FOUND_RE.test(msg)) state = 'model_unavailable'
  else if (status === 401 || status === 403) state = 'auth_invalid'
  else if (status === 402) state = 'quota_exceeded'
  else if (status === 429) state = 'rate_limited'
  else if (status === 404 && /model/i.test(msg)) state = 'model_unavailable'
  return new TokenRouterApiError(`TokenRouter 接口返回 ${status}：${msg}`, state, status, retryAfterSec)
}

/** 任意错误 → 状态（聊天走 callChat 时错误是文本，靠原文归类，原文不丢） */
export function tokenRouterStateFromError(e: unknown): TokenRouterRouteState {
  if (e instanceof TokenRouterApiError) return e.state
  const msg = e instanceof Error ? e.message : String(e ?? '')
  if (TOKENROUTER_MODEL_NOT_FOUND_RE.test(msg)) return 'model_unavailable'
  if (/401|403|invalid api key|unauthorized|authentication/i.test(msg)) return 'auth_invalid'
  if (/402|insufficient|quota|额度不足|余额不足/i.test(msg)) return 'quota_exceeded'
  if (/429|rate.?limit|too many requests|限流/i.test(msg)) return 'rate_limited'
  if (/model.*(not found|does not exist|unavailable|不存在|不可用)|404/i.test(msg)) return 'model_unavailable'
  if (/failed to fetch|network|load failed|cors|网络|桌面代理不可用|请求失败/i.test(msg)) return 'network_error'
  return 'error'
}

export function tokenRouterErrorText(e: unknown): string {
  if (e instanceof TokenRouterApiError) {
    return e.retryAfterSec ? `${e.message}（建议 ${e.retryAfterSec} 秒后重试）` : e.message
  }
  return e instanceof Error ? e.message : String(e ?? '未知错误')
}

// ---------------- 429 / 额度冷却口径 ----------------

export const TOKENROUTER_RATE_COOLDOWN_MS = 60_000      // 429 无 Retry-After 时的缺省冷却
export const TOKENROUTER_QUOTA_COOLDOWN_MS = 10 * 60_000 // 额度不足冷却（平台未公布恢复口径）

export interface TokenRouterCooldown { until: number; reason: string }

/**
 * 限流/额度冷却到哪一刻：有 Retry-After 用 Retry-After；没有时——限流按 60 秒
 * （与 433 切换链缺省口径一致）、额度不足按 10 分钟，reason 写明平台未公布
 * 限额/恢复口径，不编造官方重置时间（TokenRouter 免费额度本就未公布）。
 */
export function tokenRouterCooldownFor(state: TokenRouterRouteState, retryAfterSec: number | undefined, nowMs: number): TokenRouterCooldown | null {
  if (state !== 'rate_limited' && state !== 'quota_exceeded') return null
  if (retryAfterSec && retryAfterSec > 0) {
    return { until: nowMs + retryAfterSec * 1000, reason: `按服务端 Retry-After 冷却 ${retryAfterSec} 秒` }
  }
  if (state === 'rate_limited') {
    return { until: nowMs + TOKENROUTER_RATE_COOLDOWN_MS, reason: '无 Retry-After，限流冷却 60 秒（平台未公布具体限额）' }
  }
  return { until: nowMs + TOKENROUTER_QUOTA_COOLDOWN_MS, reason: '额度不足冷却 10 分钟（平台未公布额度恢复口径）' }
}

function parseRetryAfterSec(msg: string): number | undefined {
  const m = msg.match(/retry[-\s]?after[\s:：]*(\d+)/i) ?? msg.match(/建议\s*(\d+)\s*秒后重试/)
  return m ? Number(m[1]) : undefined
}

// ---------------- 路线运行状态（冷却/密钥失效，仅本机） ----------------

const ROUTE_STATE_KEY = 'acm.tokenrouter.routeState.v1'

export interface TokenRouterRouteRuntime {
  cooldownUntil: number
  cooldownReason?: string
  authInvalid?: boolean
  lastState?: TokenRouterRouteState
  lastError?: string
  updatedAt: number
}

function loadRouteStateMap(): Record<string, TokenRouterRouteRuntime> {
  try {
    const raw = localStorage.getItem(ROUTE_STATE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? parsed as Record<string, TokenRouterRouteRuntime> : {}
  } catch { return {} }
}

function saveRouteStateMap(map: Record<string, TokenRouterRouteRuntime>): void {
  try { localStorage.setItem(ROUTE_STATE_KEY, JSON.stringify(map)) } catch { /* 忽略 */ }
}

export function getTokenRouterRouteRuntime(accountId: string): TokenRouterRouteRuntime | undefined {
  return loadRouteStateMap()[accountId]
}

/** 一次真实调用失败后记录运行状态：限流/额度写冷却，401/403 标记密钥失效（停自动重试） */
export function recordTokenRouterRouteFailure(accountId: string, e: unknown, nowMs: number = Date.now()): TokenRouterRouteRuntime {
  const state = tokenRouterStateFromError(e)
  const text = tokenRouterErrorText(e)
  const map = loadRouteStateMap()
  const prev = map[accountId] ?? { cooldownUntil: 0, updatedAt: 0 }
  const next: TokenRouterRouteRuntime = { ...prev, lastState: state, lastError: text.slice(0, 200), updatedAt: nowMs }
  if (state === 'auth_invalid') {
    next.authInvalid = true
    next.cooldownUntil = 0
    next.cooldownReason = undefined
  } else {
    const cd = tokenRouterCooldownFor(state, parseRetryAfterSec(text), nowMs)
    if (cd) { next.cooldownUntil = cd.until; next.cooldownReason = cd.reason }
  }
  map[accountId] = next
  saveRouteStateMap(map)
  return next
}

/** 一次真实调用成功后清掉冷却/失效标记 */
export function recordTokenRouterRouteSuccess(accountId: string): void {
  const map = loadRouteStateMap()
  if (!map[accountId]) return
  delete map[accountId]
  saveRouteStateMap(map)
}

// ---------------- 本机用量估算（仅本机，按 UTC 日切分，沿用 434 口径） ----------------

const USAGE_KEY = 'acm.tokenrouter.usage.v1'

export interface TokenRouterLocalUsage { day: string; requests: number; tokens: number }

function loadUsageMap(): Record<string, TokenRouterLocalUsage> {
  try {
    const raw = localStorage.getItem(USAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? parsed as Record<string, TokenRouterLocalUsage> : {}
  } catch { return {} }
}

/** 记一次本机调用（请求 +1；tokens 只记响应 usage 里真实返回的总数，没返回就不记，不编造） */
export function recordTokenRouterLocalUsage(accountId: string, tokens: number, nowMs: number = Date.now()): TokenRouterLocalUsage {
  const day = utcDayKey(nowMs)
  const map = loadUsageMap()
  const cur = map[accountId]
  const next: TokenRouterLocalUsage = cur && cur.day === day
    ? { day, requests: cur.requests + 1, tokens: cur.tokens + Math.max(0, Math.floor(tokens) || 0) }
    : { day, requests: 1, tokens: Math.max(0, Math.floor(tokens) || 0) }
  map[accountId] = next
  try { localStorage.setItem(USAGE_KEY, JSON.stringify(map)) } catch { /* 忽略 */ }
  return next
}

/** 读今日（UTC）估算；跨日自动归零（返回零值，不改存储） */
export function loadTokenRouterLocalUsage(accountId: string, nowMs: number = Date.now()): TokenRouterLocalUsage {
  const day = utcDayKey(nowMs)
  const cur = loadUsageMap()[accountId]
  return cur && cur.day === day ? cur : { day, requests: 0, tokens: 0 }
}

/** 界面展示文案：一律标注「本机估算」；免费额度平台未公布，不拿本机数冒充官方额度 */
export function tokenRouterEstimateText(accountId: string, nowMs: number = Date.now()): string {
  const u = loadTokenRouterLocalUsage(accountId, nowMs)
  return `本机估算：今日（UTC）已用 ${u.requests} 次请求 · 约 ${u.tokens.toLocaleString()} tokens（仅统计本机经 App 发出的调用；TokenRouter 免费额度未公布，官方口径以控制台为准）`
}

// ---------------- 冒烟模型挑选（只从精选清单里挑，不拉全量） ----------------

/**
 * 冒烟/默认对话模型：精选清单里的第一个免费模型。入参是账户的模型清单
 * （本 App 对 TokenRouter 恒为精选清单），清单里找不到免费款时回落常量主力款。
 */
export function pickTokenRouterSmokeModel(models: string[]): string {
  const free = models.find(id => isTokenRouterFreeModel(id))
  return free ?? TOKENROUTER_SMOKE_MODEL
}

// ---------------- 启用门槛（冒烟验证记录，仅本机） ----------------

const VERIFY_KEY = 'acm.tokenrouter.verification.v1'

export interface TokenRouterVerification {
  fingerprint?: string
  status: 'verified' | 'failed'
  state: TokenRouterRouteState
  message: string
  /** 冒烟实际用通的模型 id（必为精选清单里的免费模型）；启用后作默认对话模型 */
  smokeModel?: string
  checkedAt: number
}

function loadVerifyMap(): Record<string, TokenRouterVerification> {
  try {
    const raw = localStorage.getItem(VERIFY_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? parsed as Record<string, TokenRouterVerification> : {}
  } catch { return {} }
}

export function recordTokenRouterVerification(
  account: Pick<Account, 'id' | 'keyFingerprint'>,
  status: 'verified' | 'failed',
  state: TokenRouterRouteState,
  message: string,
  smokeModel?: string,
): void {
  try {
    const map = loadVerifyMap()
    map[account.id] = { fingerprint: account.keyFingerprint, status, state, message, smokeModel, checkedAt: Date.now() }
    localStorage.setItem(VERIFY_KEY, JSON.stringify(map))
  } catch { /* 存储不可用时路线保持未启用，符合门槛 */ }
  if (status === 'verified') recordTokenRouterRouteSuccess(account.id)
}

/** 冒烟通过时实际用通的模型（仅已验证记录才返回）；未验证/失败返回 undefined */
export function getTokenRouterSmokeModel(accountId: string): string | undefined {
  const rec = loadVerifyMap()[accountId]
  return rec?.status === 'verified' ? rec.smokeModel : undefined
}

export interface TokenRouterGate { enabled: boolean; state: TokenRouterRouteState; message: string }

export const TOKENROUTER_PENDING_MESSAGE =
  'TokenRouter 待实测（未启用）：先到「Key 管理」页对这个账户点健康检查——会用你自己的 Key 拿免费模型发一条测试消息做真实冒烟，通过后才启用；未通过前不会调用它，也不会自动切换到它。现在可直接改用其他路线。'

/**
 * 路线是否可用：冒烟通过且 Key 指纹未变、且不在限流冷却中、且未被标记密钥失效，才 enabled。
 * 换 Key 后自动回到待实测；冷却/失效的真实原因写在 message 里，不静默放行。
 */
export function tokenRouterGate(account: Pick<Account, 'id' | 'providerId' | 'keyFingerprint'>, nowMs: number = Date.now()): TokenRouterGate {
  if (account.providerId !== TOKENROUTER_PROVIDER_ID) return { enabled: true, state: 'available', message: '' }
  const rec = loadVerifyMap()[account.id]
  if (!rec || (rec.fingerprint ?? undefined) !== (account.keyFingerprint ?? undefined)) {
    return { enabled: false, state: 'pending_verification', message: TOKENROUTER_PENDING_MESSAGE }
  }
  if (rec.status !== 'verified') {
    return {
      enabled: false,
      state: rec.state,
      message: `TokenRouter 冒烟未通过（${TOKENROUTER_STATE_LABEL[rec.state]}）：${rec.message}。修正后到「Key 管理」页重新点健康检查；现在可直接改用其他路线。`,
    }
  }
  const rt = getTokenRouterRouteRuntime(account.id)
  if (rt?.authInvalid) {
    return {
      enabled: false, state: 'auth_invalid',
      message: `TokenRouter 密钥失效，已停止自动重试：${rt.lastError ?? ''}。请确认 Key 后到「Key 管理」页重新点健康检查；现在可直接改用其他路线。`,
    }
  }
  if (rt && rt.cooldownUntil > nowMs) {
    const state = rt.lastState === 'quota_exceeded' ? 'quota_exceeded' : 'rate_limited'
    return {
      enabled: false, state,
      message: `TokenRouter ${TOKENROUTER_STATE_LABEL[state]}冷却中：${rt.cooldownReason ?? ''}（至 ${new Date(rt.cooldownUntil).toISOString()}）；最近失败：${rt.lastError ?? ''}。现在可直接改用其他路线。`,
    }
  }
  return { enabled: true, state: 'available', message: rec.message }
}
