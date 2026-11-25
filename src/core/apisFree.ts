// APIsFreeLLM 免 Key 兜底免费通道（v0.1.433）：第三方免费服务，免注册免 Key，OpenAI 兼容。
//
// 官方域名核对（2026-11-26）：官网 apisfreellm.com 与多方转载的官方文档一致指向
// https://api.apisfreellm.com/v1（模型 free-ai）；实测该端点响应头与官方规格完全一致
// （X-RateLimit-Limit-Requests: 10000、X-RateLimit-Limit-Tokens: 10000000）。
// 存在形近域名混杂，只认这一个，不要改成其他域名。
//
// 启用门槛（硬约束）：沙箱实测时该端点对沙箱出口 IP 的最小请求回 403 拒绝
// （出口 IP 被对方风控，与 Ethan 本人网络无关，也证明不了他那边可用）。
// 因此通道默认未启用：在 App 内打开开关后必须先用「测活」在用户自己网络下真实调通，
// 测通才进自动切换链当候选（且永远排最后兜底）；测不通保持未启用并展示真实错误，
// 不编造可用、不静默进链。剩余量只读 X-RateLimit-* 响应头，读不到就显示未知，不猜。
import { isNativeApp } from './openExternal'
import { isDesktopShell, pluginHttpDesktop } from './plugins'
import { parseUpstreamChatText } from './upstreamFree'

export const APISFREE_BASE = 'https://api.apisfreellm.com/v1'
export const APISFREE_MODEL = 'free-ai'

/** 官方限额（官网文档 2026-11-26 核对，界面如实展示） */
export const APISFREE_LIMITS_TEXT =
  '按 IP 限额：每 IP 每天 10,000 次请求或 10,000,000 tokens（00:00 UTC 重置）、1 请求/秒、2 并发、上下文 32k。第三方免费服务，稳定性未知；请勿发送密码、密钥、私密文档等敏感内容'

export interface ApisFreeRate {
  limitRequests?: number
  remainingRequests?: number
  limitTokens?: number
  remainingTokens?: number
  at: number
}

export interface ApisFreeState {
  /** 用户开关（本机偏好，不云同步） */
  enabled: boolean
  /** 最近一次真实测活通过的时间；0 = 未测通，不进切换链 */
  verifiedAt: number
  lastTestAt: number
  lastError?: string
  rate?: ApisFreeRate
}

const STORE_KEY = 'acm.apisfree.v1'
export const APISFREE_CHANGED_EVENT = 'acm-apisfree-changed'

export function loadApisFreeState(): ApisFreeState {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<ApisFreeState>
      return {
        enabled: p.enabled === true,
        verifiedAt: typeof p.verifiedAt === 'number' ? p.verifiedAt : 0,
        lastTestAt: typeof p.lastTestAt === 'number' ? p.lastTestAt : 0,
        lastError: typeof p.lastError === 'string' ? p.lastError : undefined,
        rate: p.rate && typeof p.rate === 'object' ? p.rate : undefined,
      }
    }
  } catch { /* 忽略 */ }
  return { enabled: false, verifiedAt: 0, lastTestAt: 0 }
}

export function saveApisFreeState(patch: Partial<ApisFreeState>): ApisFreeState {
  const next = { ...loadApisFreeState(), ...patch }
  try { localStorage.setItem(STORE_KEY, JSON.stringify(next)) } catch { /* 忽略 */ }
  try { window.dispatchEvent(new Event(APISFREE_CHANGED_EVENT)) } catch { /* 非浏览器环境 */ }
  return next
}

/** 能否进自动切换链当候选：开关开 + 真实测活通过 */
export function apisFreeReady(state: ApisFreeState = loadApisFreeState()): boolean {
  return state.enabled && state.verifiedAt > 0
}

/** 解析 X-RateLimit-* 响应头（键名大小写不敏感）；没有有效字段返回 null */
export function parseRateLimitHeaders(headers: Record<string, string>): ApisFreeRate | null {
  const lower: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers ?? {})) lower[k.toLowerCase()] = v
  const num = (name: string): number | undefined => {
    const n = Number(lower[name])
    return Number.isFinite(n) && lower[name] !== undefined && lower[name] !== '' ? n : undefined
  }
  const rate: ApisFreeRate = {
    limitRequests: num('x-ratelimit-limit-requests'),
    remainingRequests: num('x-ratelimit-remaining-requests'),
    limitTokens: num('x-ratelimit-limit-tokens'),
    remainingTokens: num('x-ratelimit-remaining-tokens'),
    at: Date.now(),
  }
  return rate.limitRequests !== undefined || rate.remainingRequests !== undefined
    || rate.limitTokens !== undefined || rate.remainingTokens !== undefined ? rate : null
}

export function apisFreeRateText(rate?: ApisFreeRate): string {
  if (!rate) return '剩余量未知（尚未拿到响应头）'
  const parts: string[] = []
  if (rate.remainingRequests !== undefined) parts.push(`今日剩余请求 ${rate.remainingRequests.toLocaleString()}${rate.limitRequests !== undefined ? ` / ${rate.limitRequests.toLocaleString()}` : ''}`)
  if (rate.remainingTokens !== undefined) parts.push(`剩余 tokens ${rate.remainingTokens.toLocaleString()}${rate.limitTokens !== undefined ? ` / ${rate.limitTokens.toLocaleString()}` : ''}`)
  return parts.length ? parts.join(' · ') : '剩余量未知（响应头无有效字段）'
}

interface HttpResult { status: number; text: string; headers: Record<string, string> }

async function httpAny(url: string, opts: { method: string; headers?: Record<string, string>; body?: string }): Promise<HttpResult> {
  const headers = opts.headers ?? {}
  if (isDesktopShell()) {
    const r = await pluginHttpDesktop(url, opts.method, headers, opts.body)
    return { status: r.status, text: r.text, headers: r.headers ?? {} }
  }
  if (isNativeApp()) {
    const { CapacitorHttp } = await import('@capacitor/core')
    const res = await CapacitorHttp.request({ url, method: opts.method, headers, data: opts.body, responseType: 'text' })
    const hdrs: Record<string, string> = {}
    for (const [k, v] of Object.entries(res.headers ?? {})) hdrs[k] = String(v)
    return { status: res.status, text: typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? ''), headers: hdrs }
  }
  const res = await fetch(url, { method: opts.method, headers, body: opts.body })
  const hdrs: Record<string, string> = {}
  res.headers.forEach((v, k) => { hdrs[k] = v })
  return { status: res.status, text: await res.text(), headers: hdrs }
}

export class ApisFreeError extends Error {
  status?: number
  retryAfterSec?: number
  constructor(message: string, status?: number, retryAfterSec?: number) {
    super(message)
    this.name = 'ApisFreeError'
    this.status = status
    this.retryAfterSec = retryAfterSec
  }
}

function retryAfterFromHeaders(headers: Record<string, string>): number | undefined {
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k.toLowerCase() === 'retry-after') {
      const n = Number(v)
      if (Number.isFinite(n) && n > 0) return n
    }
  }
  return undefined
}

/** 向 APIsFreeLLM 发一轮对话（非流式）；失败抛 ApisFreeError，带状态码与上游原文 */
export async function chatApisFree(messages: { role: string; content: string }[], maxTokens?: number): Promise<string> {
  const r = await httpAny(`${APISFREE_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: APISFREE_MODEL, messages, stream: false, ...(maxTokens ? { max_tokens: maxTokens } : {}) }),
  })
  const rate = parseRateLimitHeaders(r.headers)
  if (rate) saveApisFreeState({ rate })
  if (r.status < 200 || r.status >= 300) {
    let serverMsg = r.text.slice(0, 200)
    try {
      const j = JSON.parse(r.text) as { error?: { message?: string } }
      if (j.error?.message) serverMsg = j.error.message.slice(0, 200)
    } catch { /* 用原文片段 */ }
    throw new ApisFreeError(`APIsFreeLLM 返回 ${r.status}：${serverMsg}`, r.status, retryAfterFromHeaders(r.headers))
  }
  const text = parseUpstreamChatText(r.text)
  if (!text.trim()) throw new ApisFreeError('APIsFreeLLM 未返回文本内容（空响应）')
  return text
}

export interface ApisFreeTestResult { ok: boolean; ms: number; error?: string; rate?: ApisFreeRate | null }

/**
 * 真实测活：发一句最小请求验证在「当前网络」下真能跑通（遵守其 1 请求/秒限额，只发一条）。
 * 结果写入本机状态：通过 → verifiedAt 更新（可进切换链）；失败 → verifiedAt 清零并保存真实错误。
 */
export async function testApisFree(timeoutMs = 20000): Promise<ApisFreeTestResult> {
  const t0 = Date.now()
  try {
    const text = await Promise.race([
      chatApisFree([
        { role: 'system', content: '你是一个连通性测试程序，只需按要求回复。' },
        { role: 'user', content: '请只回复两个字：可用' },
      ], 16),
      new Promise<never>((_, rej) => { setTimeout(() => rej(new ApisFreeError('响应超时')), timeoutMs) }),
    ])
    if (!text.trim()) throw new ApisFreeError('接口返回为空')
    const st = saveApisFreeState({ verifiedAt: Date.now(), lastTestAt: Date.now(), lastError: undefined })
    return { ok: true, ms: Date.now() - t0, rate: st.rate }
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e ?? '')).slice(0, 200)
    saveApisFreeState({ verifiedAt: 0, lastTestAt: Date.now(), lastError: msg })
    return { ok: false, ms: Date.now() - t0, error: msg }
  }
}
