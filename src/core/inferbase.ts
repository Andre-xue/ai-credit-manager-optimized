// Inferbase 接入（v0.1.432）：智能路由网关，OpenAI 兼容。
//
// 官方基址分工（inferbase.ai/docs/api，2026-11-25 实查）：
// - 模型端点（chat/responses/messages/models…）：https://api.inferbase.ai/v1
// - Key/余额/用量/模型健康只在完整基址下：https://api.inferbase.ai/api/v1/inference
//   GET /credits、GET /credits/transactions、GET /usage 都是相对这个基址的路径
//   （相对 /v1 请求这三个端点实测 404，不是端点不存在，是基址不对）。
//
// 启用门槛（Ethan 2026-11-26 拍板）：Inferbase 路线在真实冒烟通过前不得默认启用。
// 冒烟 = Key 管理页的健康检查（用 Ethan 自己的 Key 查余额/用量 + 用 auto 模型发一条
// 测试消息），通过后把结果按账户 + Key 指纹存本机（不进云同步），路线才可用；
// 失败保持未启用并显示真实原因，不静默兜底、不自动切换（自动切换链在 v0.1.433 落地）。
// 只用 Ethan 自己的 Key：不做多账号池、不绕限额、不共享 Key。
import { isNativeApp } from './openExternal'
import type { Account } from './types'

export const INFERBASE_CHAT_BASE = 'https://api.inferbase.ai/v1'
export const INFERBASE_API_BASE = 'https://api.inferbase.ai/api/v1/inference'
export const INFERBASE_SMOKE_MODEL = 'auto'

/** 免费档限制（官方 pricing 页 2026-11-25 实查，界面如实展示，不编造） */
export const INFERBASE_FREE_LIMITS = {
  monthlyRequests: 5000,          // 每月 5,000 次请求
  dailyManagedRequests: 100,      // 每天 100 次托管（用平台额度）请求
  dailyManagedCreditUsd: 0.5,     // 每天 $0.50 托管模型额度
  keyRpm: 60,                     // 60 rpm / Key
  managedOrgRpm: 10,              // 托管 10 rpm / 组织
  managedMaxOutputUsdPerMTokens: 2, // 托管模型输出价上限 $2 / 1M tokens
  maxInputTokens: 8192,           // 单次输入上限
  maxOutputTokens: 1024,          // 单次输出上限
} as const

export function inferbaseLimitsText(): string {
  const L = INFERBASE_FREE_LIMITS
  return `免费档：每月 ${L.monthlyRequests.toLocaleString()} 次请求 · 每天 ${L.dailyManagedRequests} 次托管请求 + $${L.dailyManagedCreditUsd} 托管模型额度 · 免绑卡；托管模型输出价上限 $${L.managedMaxOutputUsdPerMTokens}/1M tokens、单次输入 ${L.maxInputTokens} / 输出 ${L.maxOutputTokens} tokens、${L.keyRpm} rpm/Key、托管 ${L.managedOrgRpm} rpm/组织`
}

/** 供 433 自动切换链消费的健康/额度状态（本版只产出，不做自动切换） */
export type InferbaseRouteState =
  | 'available'           // 可用（冒烟通过且最近检查正常）
  | 'rate_limited'        // 限流（429，可稍后重试）
  | 'quota_exceeded'      // 额度不足（402 / plan_limit / 每日托管额度或月额度用完）
  | 'auth_invalid'        // 密钥失效（401/403）
  | 'network_error'       // 网络不通（含 CORS 被拦）
  | 'model_unavailable'   // 模型不可用（模型不存在/下线/健康端点报不可达）
  | 'pending_verification'// 待实测（未做真实冒烟，未启用）
  | 'error'               // 其他异常（保留原文）

export const INFERBASE_STATE_LABEL: Record<InferbaseRouteState, string> = {
  available: '可用',
  rate_limited: '限流',
  quota_exceeded: '额度不足',
  auth_invalid: '密钥失效',
  network_error: '网络不通',
  model_unavailable: '模型不可用',
  pending_verification: '待实测（未启用）',
  error: '异常',
}

export class InferbaseApiError extends Error {
  status?: number
  state: InferbaseRouteState
  retryAfterSec?: number
  constructor(message: string, state: InferbaseRouteState, status?: number, retryAfterSec?: number) {
    super(message)
    this.name = 'InferbaseApiError'
    this.state = state
    this.status = status
    this.retryAfterSec = retryAfterSec
  }
}

/** 从 HTTP 状态 + 官方错误原文归类状态（错误信封 {error:{message,type,code}, detail}） */
export function classifyInferbaseHttp(status: number, message: string, retryAfterSec?: number): InferbaseApiError {
  const msg = message || `Inferbase 接口返回 ${status}`
  let state: InferbaseRouteState = 'error'
  if (status === 401 || status === 403) state = 'auth_invalid'
  else if (status === 402) state = 'quota_exceeded'
  else if (status === 429) state = 'rate_limited'
  else if (status === 404 && /model/i.test(msg)) state = 'model_unavailable'
  return new InferbaseApiError(`Inferbase 接口返回 ${status}：${msg}`, state, status, retryAfterSec)
}

/** 任意错误 → 状态（聊天走 call_provider_api 时错误是文本，靠原文归类，原文不丢） */
export function inferbaseStateFromError(e: unknown): InferbaseRouteState {
  if (e instanceof InferbaseApiError) return e.state
  const msg = e instanceof Error ? e.message : String(e ?? '')
  if (/401|403|invalid api key|unauthorized|authentication/i.test(msg)) return 'auth_invalid'
  if (/402|insufficient|quota|plan_limit|额度不足|余额不足/i.test(msg)) return 'quota_exceeded'
  if (/429|rate.?limit|too many requests|限流/i.test(msg)) return 'rate_limited'
  if (/model.*(not found|does not exist|unavailable|不存在|不可用)|404/i.test(msg)) return 'model_unavailable'
  if (/failed to fetch|network|load failed|cors|网络|桌面代理不可用|请求失败/i.test(msg)) return 'network_error'
  return 'error'
}

export function inferbaseErrorText(e: unknown): string {
  if (e instanceof InferbaseApiError) {
    return e.retryAfterSec ? `${e.message}（建议 ${e.retryAfterSec} 秒后重试）` : e.message
  }
  return e instanceof Error ? e.message : String(e ?? '未知错误')
}

// ---------------- 传输层 ----------------
// 官方 CORS 只放行官网来源（实测响应仅对 Origin: https://inferbase.ai 回
// Access-Control-Allow-Origin），应用内直连 fetch 会被浏览器/WebView 拦：
// 桌面端走 Tauri 原生命令、手机端走 CapacitorHttp 原生层，网页版才直连 fetch
// （被拦时错误会明确归类为网络不通，不静默失败）。

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

interface HttpResult { status: number; text: string; headers: Record<string, string> }

async function httpGet(url: string, apiKey?: string): Promise<HttpResult> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
  try {
    if (inTauri()) {
      const { invoke } = await import('@tauri-apps/api/core')
      const raw = await invoke<string>('plugin_http', {
        url, method: 'GET',
        headersJson: JSON.stringify(headers), body: null,
      })
      const parsed = JSON.parse(raw) as { status: number; body: string; headers?: Record<string, string> }
      return { status: parsed.status, text: parsed.body, headers: parsed.headers ?? {} }
    }
    if (isNativeApp()) {
      const { CapacitorHttp } = await import('@capacitor/core')
      const res = await CapacitorHttp.request({ url, method: 'GET', headers, responseType: 'text' })
      const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '')
      return { status: res.status, text, headers: (res.headers ?? {}) as Record<string, string> }
    }
    const resp = await fetch(url, { headers })
    const text = await resp.text()
    const hs: Record<string, string> = {}
    resp.headers.forEach((v, k) => { hs[k] = v })
    return { status: resp.status, text, headers: hs }
  } catch (e) {
    if (e instanceof InferbaseApiError) throw e
    const msg = e instanceof Error ? e.message : String(e ?? '网络请求失败')
    throw new InferbaseApiError(`Inferbase 网络请求失败：${msg}`, 'network_error')
  }
}

function headerNum(headers: Record<string, string>, name: string): number | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()]
  const n = v ? Number(v) : NaN
  return Number.isFinite(n) ? n : undefined
}

/** GET JSON：非 2xx 抛带状态归类的 InferbaseApiError（保留官方原文） */
async function httpGetJson(url: string, apiKey?: string): Promise<{ json: unknown; headers: Record<string, string> }> {
  const r = await httpGet(url, apiKey)
  let json: unknown = null
  try { json = JSON.parse(r.text) } catch { /* 非 JSON 响应按原文处理 */ }
  if (r.status < 200 || r.status >= 300) {
    const j = json as { error?: { message?: string }; detail?: string } | null
    const serverMsg = j?.error?.message || j?.detail || r.text.slice(0, 300) || `HTTP ${r.status}`
    throw classifyInferbaseHttp(r.status, serverMsg, headerNum(r.headers, 'retry-after'))
  }
  return { json, headers: r.headers }
}

// ---------------- 模型列表（公开，无需认证） ----------------

export interface InferbaseModelInfo { id: string; name?: string }

export function parseInferbaseModels(json: unknown): InferbaseModelInfo[] {
  const data = (json as { data?: unknown })?.data
  const rows = Array.isArray(data) ? data : Array.isArray(json) ? json : []
  const out: InferbaseModelInfo[] = []
  for (const row of rows) {
    const r = row as { id?: unknown; name?: unknown }
    if (typeof r?.id === 'string' && r.id) out.push({ id: r.id, name: typeof r.name === 'string' ? r.name : undefined })
  }
  return out
}

/** 公开模型列表（官方注明无需凭据）；桌面/手机走原生层绕开官网-only 的 CORS */
export async function fetchInferbaseModels(): Promise<InferbaseModelInfo[]> {
  const { json } = await httpGetJson(`${INFERBASE_CHAT_BASE}/models`)
  const models = parseInferbaseModels(json)
  if (models.length === 0) throw new InferbaseApiError('Inferbase 模型列表为空或结构无法识别', 'model_unavailable')
  return models
}

// ---------------- 余额 / 用量 / 交易解析 ----------------

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); if (Number.isFinite(n)) return n }
  return undefined
}

function pickNum(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = num(obj[k])
    if (v !== undefined) return v
    if (k in obj && typeof obj[k] === 'object' && obj[k] !== null) {
      const inner = pickNum(obj[k] as Record<string, unknown>, keys)
      if (inner !== undefined) return inner
    }
  }
  return undefined
}

export interface InferbaseCredits { balanceUsd: number; grantedUsd?: number; purchasedUsd?: number }

export function parseInferbaseCredits(json: unknown): InferbaseCredits {
  const root = ((json as { data?: unknown })?.data ?? json) as Record<string, unknown> | null
  if (!root || typeof root !== 'object') {
    throw new Error(`Inferbase 余额接口返回无法识别：${JSON.stringify(json)?.slice(0, 200) ?? ''}`)
  }
  const balanceUsd = pickNum(root, [
    'balance_usd', 'balanceUsd', 'available_balance_usd', 'available_usd', 'remaining_usd',
    'current_balance', 'balance', 'credits_balance', 'credits',
  ])
  if (balanceUsd === undefined) {
    throw new Error(`Inferbase 余额接口返回无法识别（找不到美元余额字段）：${JSON.stringify(json)?.slice(0, 200) ?? ''}`)
  }
  return {
    balanceUsd,
    grantedUsd: pickNum(root, ['granted_usd', 'grant_usd', 'free_credit_usd', 'beta_credit_usd', 'granted']),
    purchasedUsd: pickNum(root, ['purchased_usd', 'topup_usd', 'paid_usd', 'topped_up_usd', 'purchased']),
  }
}

export interface InferbaseUsageAgg {
  rowsReturned: number
  totalReported?: number
  totalCostUsd: number
  totalTokens: number
  /** 按用量日志时间戳统计的本月请求数（无时间戳时为 undefined，不编造） */
  monthRequests?: number
  /** 近 24 小时请求数与花费（托管每日限额的近似观察值，日志可能分页不全） */
  last24hRequests?: number
  last24hCostUsd?: number
  failedRequests: number
}

function rowsOf(json: unknown): Record<string, unknown>[] {
  if (Array.isArray(json)) return json as Record<string, unknown>[]
  const j = json as Record<string, unknown> | null
  if (!j || typeof j !== 'object') return []
  for (const k of ['data', 'usage', 'logs', 'items', 'results', 'records']) {
    if (Array.isArray(j[k])) return j[k] as Record<string, unknown>[]
    const inner = j[k] as Record<string, unknown> | null
    if (inner && typeof inner === 'object' && Array.isArray(inner.data)) return inner.data as Record<string, unknown>[]
  }
  return []
}

function rowCostUsd(r: Record<string, unknown>): number {
  const micros = pickNum(r, ['cost_micros', 'cost_usd_micros', 'amount_micros'])
  if (micros !== undefined) return micros / 1_000_000
  return pickNum(r, ['cost_usd', 'cost', 'amount_usd', 'total_cost_usd', 'price_usd']) ?? 0
}

function rowTokens(r: Record<string, unknown>): number {
  const total = pickNum(r, ['total_tokens', 'tokens'])
  if (total !== undefined) return total
  const inp = pickNum(r, ['input_tokens', 'prompt_tokens']) ?? 0
  const out = pickNum(r, ['output_tokens', 'completion_tokens']) ?? 0
  return inp + out
}

function rowTimeMs(r: Record<string, unknown>): number | undefined {
  const raw = r['created_at'] ?? r['timestamp'] ?? r['time'] ?? r['created'] ?? r['date']
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw > 1e12 ? raw : raw * 1000
  if (typeof raw === 'string' && raw) { const t = Date.parse(raw); if (Number.isFinite(t)) return t }
  return undefined
}

export function parseInferbaseUsage(json: unknown, nowMs: number = Date.now()): InferbaseUsageAgg {
  const rows = rowsOf(json)
  const j = json as Record<string, unknown> | null
  const totalReported = j && typeof j === 'object'
    ? pickNum(j, ['total', 'count', 'total_count']) ?? (Array.isArray((j as { data?: unknown }).data) ? undefined : undefined)
    : undefined
  let totalCostUsd = 0, totalTokens = 0, failedRequests = 0
  let monthRequests: number | undefined, last24hRequests: number | undefined, last24hCostUsd: number | undefined
  const now = new Date(nowMs)
  let timed = 0, month = 0, day = 0, dayCost = 0
  for (const r of rows) {
    const c = rowCostUsd(r); totalCostUsd += c; totalTokens += rowTokens(r)
    const st = String(r['status'] ?? r['state'] ?? '')
    if (/fail|error/i.test(st)) failedRequests++
    const t = rowTimeMs(r)
    if (t !== undefined) {
      timed++
      const d = new Date(t)
      if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) month++
      if (nowMs - t <= 24 * 3600 * 1000 && t <= nowMs) { day++; dayCost += c }
    }
  }
  if (timed > 0) { monthRequests = month; last24hRequests = day; last24hCostUsd = dayCost }
  return { rowsReturned: rows.length, totalReported, totalCostUsd, totalTokens, monthRequests, last24hRequests, last24hCostUsd, failedRequests }
}

export interface InferbaseTxAgg { count: number; latestText?: string }

export function parseInferbaseTransactions(json: unknown): InferbaseTxAgg {
  const rows = rowsOf(json)
  let latestText: string | undefined
  const first = rows[0] as Record<string, unknown> | undefined
  if (first) {
    const amt = pickNum(first, ['amount_usd', 'amount', 'delta_usd', 'change_usd'])
    const kind = String(first['type'] ?? first['kind'] ?? first['reason'] ?? '变动')
    if (amt !== undefined) latestText = `${kind} $${Math.abs(amt)}`
  }
  return { count: rows.length, latestText }
}

// ---------------- 账户数据拉取（credits 必达；usage/transactions 失败带真实原因返回） ----------------

export interface InferbaseAccountData {
  credits: InferbaseCredits
  usage?: InferbaseUsageAgg
  transactions?: InferbaseTxAgg
  /** usage/transactions 拉取失败的真实原因（不静默吞掉，随结果一起展示） */
  partialErrors: string[]
}

export interface InferbaseRawCombined { credits: unknown; usage?: unknown; transactions?: unknown; usageError?: string; transactionsError?: string }

function unwrapDesktopPart(v: unknown): { json?: unknown; error?: string } {
  const o = v as { __error?: unknown; status?: unknown } | null
  if (o && typeof o === 'object' && typeof o.__error === 'string') {
    return { error: `Inferbase 接口返回 ${typeof o.status === 'number' ? o.status : ''}：${o.__error}`.replace('：', '：') }
  }
  return { json: v }
}

async function fetchInferbaseRaw(apiKey: string): Promise<InferbaseRawCombined> {
  if (inTauri()) {
    // 桌面端：Rust proxy_usage 的 inferbase 分支一次拉齐三个端点并回组合 JSON
    const { invoke } = await import('@tauri-apps/api/core')
    let rawVal: unknown
    try {
      rawVal = await invoke('proxy_usage', { provider: 'inferbase', apiKey })
    } catch (e) {
      const msg = typeof e === 'string' ? e : e instanceof Error ? e.message : '桌面代理不可用'
      throw new InferbaseApiError(msg, inferbaseStateFromError(msg))
    }
    let combined: { credits?: unknown; usage?: unknown; transactions?: unknown }
    if (typeof rawVal === 'string') {
      try { combined = JSON.parse(rawVal) } catch {
        throw new InferbaseApiError('Inferbase 余额接口返回无法解析', 'error')
      }
    } else if (rawVal && typeof rawVal === 'object') {
      combined = rawVal as { credits?: unknown; usage?: unknown; transactions?: unknown }
    } else {
      throw new InferbaseApiError('Inferbase 余额接口返回无法解析', 'error')
    }
    const c = unwrapDesktopPart(combined.credits)
    if (c.error || combined.credits === undefined) {
      throw new InferbaseApiError(c.error ?? 'Inferbase 余额接口无响应', inferbaseStateFromError(c.error ?? ''))
    }
    const u = unwrapDesktopPart(combined.usage)
    const t = unwrapDesktopPart(combined.transactions)
    return { credits: c.json, usage: u.json, transactions: t.json, usageError: u.error, transactionsError: t.error }
  }
  const credits = (await httpGetJson(`${INFERBASE_API_BASE}/credits`, apiKey)).json
  let usage: unknown, transactions: unknown, usageError: string | undefined, transactionsError: string | undefined
  try { usage = (await httpGetJson(`${INFERBASE_API_BASE}/usage`, apiKey)).json }
  catch (e) { usageError = inferbaseErrorText(e) }
  try { transactions = (await httpGetJson(`${INFERBASE_API_BASE}/credits/transactions`, apiKey)).json }
  catch (e) { transactionsError = inferbaseErrorText(e) }
  return { credits, usage, transactions, usageError, transactionsError }
}

/** 组合原始返回 → 结构化账户数据（credits 解析失败抛错，其余失败进 partialErrors） */
export function buildInferbaseAccountData(rawIn: InferbaseRawCombined): InferbaseAccountData {
  // 桌面组合 JSON 里失败的可选部分是 {__error, status} 标记，先归一化成 error 字段
  const raw: InferbaseRawCombined = { ...rawIn }
  for (const k of ['usage', 'transactions'] as const) {
    const part = raw[k] as { __error?: unknown; status?: unknown } | undefined
    if (part && typeof part === 'object' && typeof part.__error === 'string') {
      const msg = `Inferbase 接口返回 ${typeof part.status === 'number' ? part.status : ''}：${part.__error}`
      if (k === 'usage' && !raw.usageError) raw.usageError = msg
      if (k === 'transactions' && !raw.transactionsError) raw.transactionsError = msg
      raw[k] = undefined
    }
  }
  const creditsPart = raw.credits as { __error?: unknown; status?: unknown } | null
  if (creditsPart && typeof creditsPart === 'object' && typeof creditsPart.__error === 'string') {
    throw new InferbaseApiError(
      `Inferbase 接口返回 ${typeof creditsPart.status === 'number' ? creditsPart.status : ''}：${creditsPart.__error}`,
      inferbaseStateFromError(String(creditsPart.__error)),
      typeof creditsPart.status === 'number' ? creditsPart.status : undefined,
    )
  }
  const credits = parseInferbaseCredits(raw.credits)
  const partialErrors: string[] = []
  let usage: InferbaseUsageAgg | undefined
  let transactions: InferbaseTxAgg | undefined
  if (raw.usage !== undefined) {
    try { usage = parseInferbaseUsage(raw.usage) } catch (e) { partialErrors.push(`用量解析失败：${inferbaseErrorText(e)}`) }
  } else if (raw.usageError) partialErrors.push(`用量同步失败：${raw.usageError}`)
  if (raw.transactions !== undefined) {
    try { transactions = parseInferbaseTransactions(raw.transactions) } catch (e) { partialErrors.push(`交易记录解析失败：${inferbaseErrorText(e)}`) }
  } else if (raw.transactionsError) partialErrors.push(`交易记录同步失败：${raw.transactionsError}`)
  return { credits, usage, transactions, partialErrors }
}

/** 拉齐余额 + 用量 + 交易；credits 失败直接抛（带状态归类），其余失败进 partialErrors */
export async function fetchInferbaseAccountData(apiKey: string): Promise<InferbaseAccountData> {
  return buildInferbaseAccountData(await fetchInferbaseRaw(apiKey))
}

// ---------------- 启用门槛（冒烟验证记录，仅本机） ----------------

const VERIFY_KEY = 'acm.inferbase.verification.v1'

export interface InferbaseVerification {
  fingerprint?: string
  status: 'verified' | 'failed'
  state: InferbaseRouteState
  message: string
  checkedAt: number
}

function loadVerifyMap(): Record<string, InferbaseVerification> {
  try {
    const raw = localStorage.getItem(VERIFY_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? parsed as Record<string, InferbaseVerification> : {}
  } catch { return {} }
}

export function recordInferbaseVerification(
  account: Pick<Account, 'id' | 'keyFingerprint'>,
  status: 'verified' | 'failed',
  state: InferbaseRouteState,
  message: string,
): void {
  try {
    const map = loadVerifyMap()
    map[account.id] = { fingerprint: account.keyFingerprint, status, state, message, checkedAt: Date.now() }
    localStorage.setItem(VERIFY_KEY, JSON.stringify(map))
  } catch { /* 存储不可用时仅本次会话生效失败——路线保持未启用，符合门槛 */ }
}

export interface InferbaseGate { enabled: boolean; state: InferbaseRouteState; message: string }

export const INFERBASE_PENDING_MESSAGE =
  'Inferbase 待实测（未启用）：先到「Key 管理」页对这个账户点健康检查——会用你自己的 Key 做一次真实冒烟（查余额/用量 + 用 auto 模型发一条测试消息），通过后才启用；未通过前不会调用它，也不会自动切换到它（自动切换在后续版本）。现在可直接改用其他路线。'

/** 路线是否可用：只有冒烟通过且 Key 指纹未变的账户才 enabled；换 Key 后自动回到待实测 */
export function inferbaseGate(account: Pick<Account, 'id' | 'providerId' | 'keyFingerprint'>): InferbaseGate {
  if (account.providerId !== 'inferbase') return { enabled: true, state: 'available', message: '' }
  const rec = loadVerifyMap()[account.id]
  if (!rec || (rec.fingerprint ?? undefined) !== (account.keyFingerprint ?? undefined)) {
    return { enabled: false, state: 'pending_verification', message: INFERBASE_PENDING_MESSAGE }
  }
  if (rec.status === 'verified') return { enabled: true, state: 'available', message: rec.message }
  return {
    enabled: false,
    state: rec.state,
    message: `Inferbase 冒烟未通过（${INFERBASE_STATE_LABEL[rec.state]}）：${rec.message}。修正后到「Key 管理」页重新点健康检查；现在可直接改用其他路线。`,
  }
}
