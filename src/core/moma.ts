// 移动云 MoMA 接入（v0.1.456）：中国移动大模型聚合平台（模型广场），第 61 个平台。
// OpenAI 兼容、API Key 账户，要能真实调用。接入做法照 AnyAPI（v0.1.435）同构。
//
// 官方口径（移动云活动页 + MoMA 官方帮助文档，2026-11-26 实查；公开侧沙箱复核见下）：
// - 模型广场按量网关 Base：https://zhenze-huhehaote.cmecloud.cn/v1（华北-呼和浩特资源池），
//   Bearer 认证；一个 Key 适用于模型广场所有模型（控制台「API Key 管理」页创建，约 1 分钟生效）。
// - GET /v1/models 公开可达：2026-11-26 沙箱实测无 Key 返回 200、172 个模型
//   （OpenAI 格式 {object:"list",data:[{id,...}]}，含语音/生图/视频/视觉等非对话模型，
//   owned_by 为空、无自营标记字段）——模型列表证明不了 Key 有效，Key 有效性以聊天冒烟为准。
// - POST /v1/chat/completions 无 Key 实测 401：
//   {"error":{"code":"1001","message":"Authentication parameter not received in Header,
//   unable to authenticate"}}——错误信封与 OpenAI 同构（error.message）。
// - 自营模型 = 中国移动自研「九天」系列（列表实见 JIUTIAN-75B-32K、JIUTIAN-75B-8K-Chat、
//   jiutian-236b-256k-chat、jiutian-35b-256k-chat 等；jiutian-safe-* 是安全分类模型，
//   不作对话冒烟）。冒烟优先挑九天对话模型：2500 万免费试用仅覆盖部分自营模型，
//   挑自营便于 Ethan 实测时核对冒烟扣的是试用额度还是按量余额。
//
// 无公开余额接口（硬约束）：官方没有给 API Key 用的余额/剩余额度查询端点（只有查已用量的
// OpenAPI，还是另一套凭据），不接自动查余额、不单独做用量接口。额度看板沿用手动录入
// （adapters 的 NO_BALANCE_API_NOTE 会明确提示）；App 内只按本机实际发出的调用做
// 请求/token 计数，界面一律标注「本机估算」。
//
// 启用门槛（与 Inferbase / One AI / AnyAPI 同口径，Ethan 拍板）：必须先用 Ethan 自己的
// Key 在 App 内实测调用成功后才启用。冒烟 = Key 管理页健康检查（查 /v1/models + 从返回
// 列表里挑一个模型发一条测试消息），通过后按账户 + Key 指纹存本机（不进云同步）才启用；
// 未通过前一律「待实测（未启用）」、发送零调用，失败显示真实原因。换 Key 回到待实测。
// 只用 Ethan 自己的 Key：不做多账号池、不绕限额、不共享 Key。
//
// 与免费四平台的关键区别（红线）：MoMA 默认是按量付费平台，不进 433 自动切换链的
// 免费候选——链只在免费路线间切的口径不变；2500 万免费试用也不改变这条口径。
// 它只作为普通平台账户被手动直选（AI 助手选账户、工坊路线选账户）。
//
// 另两条红线（别接错线）：只接模型广场按量网关。不接 Coding Plan（路径 coding-plan-token，
// 其文档明文禁止在编程工具之外调 API）与 Token Plan（路径 tokenplan / tokenplan-personal，
// 个人版是 MobileClaw 手机号登录制、没有给外部 App 的通用 Key）的任何地址；双 11 活动的
// 「1 亿 Token」是 MobileClaw 客户端内额度（仅可用于 MobileClaw 产品），导不出来，不接、
// 不给它做签到入口。
import type { Account } from './types'
import { utcDayKey } from './oneai'

export const MOMA_PROVIDER_ID = 'moma'
export const MOMA_BASE = 'https://zhenze-huhehaote.cmecloud.cn/v1'

/** 平台口径文案（如实标注，不编造价格/限额数字：官方未公布网关单价表在本机侧不可见） */
export function momaLimitsText(): string {
  return '移动云 MoMA（模型广场）：OpenAI 兼容，一个 Key 通吃模型广场 300+ 模型（以 GET /v1/models 按你的 Key 动态拉取为准，不预置）。默认按量付费；另有独立的 2500 万免费试用（控制台模型广场领取，30 天有效，仅部分自营模型，支持 API 调用）——健康检查冒烟优先挑九天自营模型，是否扣试用额度请在控制台核对。无公开余额接口，余额请在 MoMA 控制台查看后手动录入，App 内只有本机调用估算。MoMA 是付费平台，不进入免费路线自动切换链'
}

/** 供门槛/路线消费的健康状态（与 AnyApiRouteState 同口径） */
export type MomaRouteState =
  | 'available'           // 可用（冒烟通过且最近检查正常）
  | 'rate_limited'        // 限流（429，按 Retry-After 冷却，无则 60 秒）
  | 'quota_exceeded'      // 额度不足（402 / 余额不足）
  | 'auth_invalid'        // 密钥失效（401/403）
  | 'network_error'       // 网络不通（含 CORS 被拦）
  | 'model_unavailable'   // 模型不可用（模型不存在/下线）
  | 'pending_verification'// 待实测（未做真实冒烟，未启用）
  | 'error'               // 其他异常（保留原文）

export const MOMA_STATE_LABEL: Record<MomaRouteState, string> = {
  available: '可用',
  rate_limited: '限流',
  quota_exceeded: '额度不足',
  auth_invalid: '密钥失效',
  network_error: '网络不通',
  model_unavailable: '模型不可用',
  pending_verification: '待实测（未启用）',
  error: '异常',
}

export class MomaApiError extends Error {
  status?: number
  state: MomaRouteState
  retryAfterSec?: number
  constructor(message: string, state: MomaRouteState, status?: number, retryAfterSec?: number) {
    super(message)
    this.name = 'MomaApiError'
    this.state = state
    this.status = status
    this.retryAfterSec = retryAfterSec
  }
}

/** 从 HTTP 状态 + 官方错误原文归类状态（错误信封 {error:{code,message}}，401 实测 code 1001） */
export function classifyMomaHttp(status: number, message: string, retryAfterSec?: number): MomaApiError {
  const msg = message || `MoMA 接口返回 ${status}`
  let state: MomaRouteState = 'error'
  if (status === 401 || status === 403) state = 'auth_invalid'
  else if (status === 402) state = 'quota_exceeded'
  else if (status === 429) state = 'rate_limited'
  else if (status === 404 && /model/i.test(msg)) state = 'model_unavailable'
  return new MomaApiError(`MoMA 接口返回 ${status}：${msg}`, state, status, retryAfterSec)
}

/** 任意错误 → 状态（聊天走 callChat 时错误是文本，靠原文归类，原文不丢） */
export function momaStateFromError(e: unknown): MomaRouteState {
  if (e instanceof MomaApiError) return e.state
  const msg = e instanceof Error ? e.message : String(e ?? '')
  if (/401|403|authentication|unauthenticated|unable to authenticate|invalid api key|unauthorized|密钥/i.test(msg)) return 'auth_invalid'
  if (/402|insufficient|quota|余额不足|额度不足|欠费/i.test(msg)) return 'quota_exceeded'
  if (/429|rate.?limit|too many requests|限流/i.test(msg)) return 'rate_limited'
  if (/model.*(not found|does not exist|unavailable|不存在|不可用)|404/i.test(msg)) return 'model_unavailable'
  if (/failed to fetch|network|load failed|cors|网络|桌面代理不可用|请求失败/i.test(msg)) return 'network_error'
  return 'error'
}

export function momaErrorText(e: unknown): string {
  if (e instanceof MomaApiError) {
    return e.retryAfterSec ? `${e.message}（建议 ${e.retryAfterSec} 秒后重试）` : e.message
  }
  return e instanceof Error ? e.message : String(e ?? '未知错误')
}

// ---------------- 429 / 额度冷却口径 ----------------

export const MOMA_RATE_COOLDOWN_MS = 60_000      // 429 无 Retry-After 时的缺省冷却
export const MOMA_QUOTA_COOLDOWN_MS = 10 * 60_000 // 额度不足冷却（网关未公布恢复口径）

export interface MomaCooldown { until: number; reason: string }

/**
 * 限流/额度冷却到哪一刻：有 Retry-After 用 Retry-After；没有时——限流按 60 秒
 * （与 433 切换链缺省口径一致）、额度不足按 10 分钟，reason 写明网关未公布恢复口径，
 * 不编造官方重置时间。
 */
export function momaCooldownFor(state: MomaRouteState, retryAfterSec: number | undefined, nowMs: number): MomaCooldown | null {
  if (state !== 'rate_limited' && state !== 'quota_exceeded') return null
  if (retryAfterSec && retryAfterSec > 0) {
    return { until: nowMs + retryAfterSec * 1000, reason: `按服务端 Retry-After 冷却 ${retryAfterSec} 秒` }
  }
  if (state === 'rate_limited') {
    return { until: nowMs + MOMA_RATE_COOLDOWN_MS, reason: '无 Retry-After，限流冷却 60 秒（网关未公布具体限额）' }
  }
  return { until: nowMs + MOMA_QUOTA_COOLDOWN_MS, reason: '额度不足冷却 10 分钟（网关未公布额度恢复口径）' }
}

function parseRetryAfterSec(msg: string): number | undefined {
  const m = msg.match(/retry[-\s]?after[\s:：]*(\d+)/i) ?? msg.match(/建议\s*(\d+)\s*秒后重试/)
  return m ? Number(m[1]) : undefined
}

// ---------------- 路线运行状态（冷却/密钥失效，仅本机） ----------------

const ROUTE_STATE_KEY = 'acm.moma.routeState.v1'

export interface MomaRouteRuntime {
  cooldownUntil: number
  cooldownReason?: string
  authInvalid?: boolean
  lastState?: MomaRouteState
  lastError?: string
  updatedAt: number
}

function loadRouteStateMap(): Record<string, MomaRouteRuntime> {
  try {
    const raw = localStorage.getItem(ROUTE_STATE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? parsed as Record<string, MomaRouteRuntime> : {}
  } catch { return {} }
}

function saveRouteStateMap(map: Record<string, MomaRouteRuntime>): void {
  try { localStorage.setItem(ROUTE_STATE_KEY, JSON.stringify(map)) } catch { /* 忽略 */ }
}

export function getMomaRouteRuntime(accountId: string): MomaRouteRuntime | undefined {
  return loadRouteStateMap()[accountId]
}

/** 一次真实调用失败后记录运行状态：限流/额度写冷却，401/403 标记密钥失效（停自动重试） */
export function recordMomaRouteFailure(accountId: string, e: unknown, nowMs: number = Date.now()): MomaRouteRuntime {
  const state = momaStateFromError(e)
  const text = momaErrorText(e)
  const map = loadRouteStateMap()
  const prev = map[accountId] ?? { cooldownUntil: 0, updatedAt: 0 }
  const next: MomaRouteRuntime = { ...prev, lastState: state, lastError: text.slice(0, 200), updatedAt: nowMs }
  if (state === 'auth_invalid') {
    next.authInvalid = true
    next.cooldownUntil = 0
    next.cooldownReason = undefined
  } else {
    const cd = momaCooldownFor(state, parseRetryAfterSec(text), nowMs)
    if (cd) { next.cooldownUntil = cd.until; next.cooldownReason = cd.reason }
  }
  map[accountId] = next
  saveRouteStateMap(map)
  return next
}

/** 一次真实调用成功后清掉冷却/失效标记 */
export function recordMomaRouteSuccess(accountId: string): void {
  const map = loadRouteStateMap()
  if (!map[accountId]) return
  delete map[accountId]
  saveRouteStateMap(map)
}

// ---------------- 本机用量估算（仅本机，按 UTC 日切分，沿用 434 口径） ----------------

const USAGE_KEY = 'acm.moma.usage.v1'

export interface MomaLocalUsage { day: string; requests: number; tokens: number }

function loadUsageMap(): Record<string, MomaLocalUsage> {
  try {
    const raw = localStorage.getItem(USAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? parsed as Record<string, MomaLocalUsage> : {}
  } catch { return {} }
}

/** 记一次本机调用（请求 +1；tokens 只记响应 usage 里真实返回的总数，没返回就不记，不编造） */
export function recordMomaLocalUsage(accountId: string, tokens: number, nowMs: number = Date.now()): MomaLocalUsage {
  const day = utcDayKey(nowMs)
  const map = loadUsageMap()
  const cur = map[accountId]
  const next: MomaLocalUsage = cur && cur.day === day
    ? { day, requests: cur.requests + 1, tokens: cur.tokens + Math.max(0, Math.floor(tokens) || 0) }
    : { day, requests: 1, tokens: Math.max(0, Math.floor(tokens) || 0) }
  map[accountId] = next
  try { localStorage.setItem(USAGE_KEY, JSON.stringify(map)) } catch { /* 忽略 */ }
  return next
}

/** 读今日（UTC）估算；跨日自动归零（返回零值，不改存储） */
export function loadMomaLocalUsage(accountId: string, nowMs: number = Date.now()): MomaLocalUsage {
  const day = utcDayKey(nowMs)
  const cur = loadUsageMap()[accountId]
  return cur && cur.day === day ? cur : { day, requests: 0, tokens: 0 }
}

/** 界面展示文案：一律标注「本机估算」；官方口径（按量计费/试用额度）以控制台为准 */
export function momaEstimateText(accountId: string, nowMs: number = Date.now()): string {
  const u = loadMomaLocalUsage(accountId, nowMs)
  return `本机估算：今日（UTC）已用 ${u.requests} 次请求 · 约 ${u.tokens.toLocaleString()} tokens（仅统计本机经 App 发出的调用；按量计费金额与 2500 万免费试用额度的消耗以 MoMA 控制台为准）`
}

// ---------------- 冒烟模型挑选（从 /v1/models 真实返回里挑，不编造） ----------------

/**
 * 模型广场的公开列表混有非对话模型（语音 CosyVoice/SenseVoice、生图 Flux/qwen-image、
 * 视频 seedance/wan、视觉 VL、安全分类 Qwen3Guard/jiutian-safe 等），这些不能作对话冒烟，
 * 先剔除。剔除只是「不拿它冒烟」，不影响用户在模型列表里手动选其他模型。
 */
const MOMA_NON_CHAT_RE = /(cosyvoice|sensevoice|flux|seedance|wan\s?\d|image|asr|tts|guard|jiutian-safe|embedding|rerank|ocr|diffusers|-vl-|qwen\d?-vl)/i

export function isMomaChatCandidate(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && !MOMA_NON_CHAT_RE.test(id)
}

/**
 * 从 Key 实际可调用的模型列表里挑冒烟/默认对话模型：
 * 1) 自营优先——中国移动自研「九天」系列对话模型（jiutian 且带 chat，其次任意 jiutian），
 *    因为 2500 万免费试用仅覆盖部分自营模型，冒烟扣哪份额度要能核对；
 * 2) id 带 free 标记的；3) 开源权重家族；4) 列表第一个对话候选。
 * 挑中的 id 必然来自官方真实返回，不在代码里写死模型名（示例 id 只出现在注释里）。
 */
export function pickMomaSmokeModel(models: string[]): string | undefined {
  const ids = models.filter(isMomaChatCandidate)
  if (!ids.length) return undefined
  const jiutianChat = ids.find(id => /jiutian/i.test(id) && /chat/i.test(id))
  if (jiutianChat) return jiutianChat
  const jiutian = ids.find(id => /jiutian/i.test(id))
  if (jiutian) return jiutian
  const free = ids.find(id => /free/i.test(id))
  if (free) return free
  const open = ids.find(id => /(llama|gemma|mistral|mixtral|qwen|deepseek|phi|falcon)/i.test(id))
  if (open) return open
  return ids[0]
}

// ---------------- 启用门槛（冒烟验证记录，仅本机） ----------------

const VERIFY_KEY = 'acm.moma.verification.v1'

export interface MomaVerification {
  fingerprint?: string
  status: 'verified' | 'failed'
  state: MomaRouteState
  message: string
  /** 冒烟实际用通的模型 id（来自 /v1/models 真实返回）；启用后作默认对话模型 */
  smokeModel?: string
  checkedAt: number
}

function loadVerifyMap(): Record<string, MomaVerification> {
  try {
    const raw = localStorage.getItem(VERIFY_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? parsed as Record<string, MomaVerification> : {}
  } catch { return {} }
}

export function recordMomaVerification(
  account: Pick<Account, 'id' | 'keyFingerprint'>,
  status: 'verified' | 'failed',
  state: MomaRouteState,
  message: string,
  smokeModel?: string,
): void {
  try {
    const map = loadVerifyMap()
    map[account.id] = { fingerprint: account.keyFingerprint, status, state, message, smokeModel, checkedAt: Date.now() }
    localStorage.setItem(VERIFY_KEY, JSON.stringify(map))
  } catch { /* 存储不可用时路线保持未启用，符合门槛 */ }
  if (status === 'verified') recordMomaRouteSuccess(account.id)
}

/** 冒烟通过时实际用通的模型（仅已验证记录才返回）；未验证/失败返回 undefined */
export function getMomaSmokeModel(accountId: string): string | undefined {
  const rec = loadVerifyMap()[accountId]
  return rec?.status === 'verified' ? rec.smokeModel : undefined
}

export interface MomaGate { enabled: boolean; state: MomaRouteState; message: string }

export const MOMA_PENDING_MESSAGE =
  '移动云 MoMA 待实测（未启用）：先到「Key 管理」页对这个账户点健康检查——会用你自己的 Key 做一次真实冒烟（查 /v1/models 模型列表 + 优先挑九天自营模型发一条测试消息），通过后才启用；未通过前不会调用它。现在可直接改用其他路线。'

/**
 * 路线是否可用：冒烟通过且 Key 指纹未变、且不在限流冷却中、且未被标记密钥失效，才 enabled。
 * 换 Key 后自动回到待实测；冷却/失效的真实原因写在 message 里，不静默放行。
 * 注意：MoMA 是按量付费平台，本门槛只管「手动直选时能不能发」，它不进自动切换链。
 */
export function momaGate(account: Pick<Account, 'id' | 'providerId' | 'keyFingerprint'>, nowMs: number = Date.now()): MomaGate {
  if (account.providerId !== MOMA_PROVIDER_ID) return { enabled: true, state: 'available', message: '' }
  const rec = loadVerifyMap()[account.id]
  if (!rec || (rec.fingerprint ?? undefined) !== (account.keyFingerprint ?? undefined)) {
    return { enabled: false, state: 'pending_verification', message: MOMA_PENDING_MESSAGE }
  }
  if (rec.status !== 'verified') {
    return {
      enabled: false,
      state: rec.state,
      message: `移动云 MoMA 冒烟未通过（${MOMA_STATE_LABEL[rec.state]}）：${rec.message}。修正后到「Key 管理」页重新点健康检查；现在可直接改用其他路线。`,
    }
  }
  const rt = getMomaRouteRuntime(account.id)
  if (rt?.authInvalid) {
    return {
      enabled: false, state: 'auth_invalid',
      message: `移动云 MoMA 密钥失效，已停止自动重试：${rt.lastError ?? ''}。请确认 Key 后到「Key 管理」页重新点健康检查；现在可直接改用其他路线。`,
    }
  }
  if (rt && rt.cooldownUntil > nowMs) {
    const state = rt.lastState === 'quota_exceeded' ? 'quota_exceeded' : 'rate_limited'
    return {
      enabled: false, state,
      message: `移动云 MoMA ${MOMA_STATE_LABEL[state]}冷却中：${rt.cooldownReason ?? ''}（至 ${new Date(rt.cooldownUntil).toISOString()}）；最近失败：${rt.lastError ?? ''}。现在可直接改用其他路线。`,
    }
  }
  return { enabled: true, state: 'available', message: rec.message }
}
