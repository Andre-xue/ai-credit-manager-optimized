// 插件化数据源适配器。
// 合规约束：仅调用官方只读端点；不使用 Cookie / 会话令牌；不模拟登录；不执行领取动作。
// 桌面端（Tauri）走 Rust 代理以绕过 CORS，且端点在后端白名单校验，防止开放代理。
import type { CreditUnit, DataSourceAdapter } from './types'
import { PROVIDER_MAP } from '../data/providers'

interface UsageResult {
  used: number
  total?: number
  unit: CreditUnit
  remaining?: number
  symbol?: string
  detail?: string
  label?: string
}

/** parse 的统一产物：用量型给 used/total；余额型给 remaining（并镜像 total=remaining, used=0） */
export interface ParsedUsage {
  used: number
  total?: number
  remaining?: number
  symbol?: string
  detail?: string
  label?: string
}

interface Endpoint {
  url: string
  unit?: CreditUnit
  parse: (json: any) => ParsedUsage
}

/** 接口通了但结构对不上时，带一截原始返回，方便用户截图反馈后适配 */
function shapeError(name: string, j: any): Error {
  return new Error(`${name}接口返回结构无法识别（${JSON.stringify(j)?.slice(0, 120) ?? ''}），请截图反馈以便适配`)
}

/** DeepSeek：GET /user/balance → balance_infos[0]（金额为字符串，currency CNY/USD） */
export function parseDeepseekBalance(j: any): ParsedUsage {
  const info = j?.balance_infos?.[0]
  const total = Number.parseFloat(info?.total_balance)
  if (!info || !Number.isFinite(total)) throw shapeError('DeepSeek 余额', j)
  const sym = info.currency === 'USD' ? '$' : '¥'
  const topped = Number.parseFloat(info.topped_up_balance)
  const granted = Number.parseFloat(info.granted_balance)
  const parts: string[] = []
  if (Number.isFinite(topped)) parts.push(`充值 ${sym}${topped}`)
  if (Number.isFinite(granted) && granted > 0) parts.push(`赠金 ${sym}${granted}`)
  return { used: 0, total, remaining: total, symbol: sym, detail: parts.join(' · ') || undefined }
}

/** Kimi/Moonshot：GET /v1/users/me/balance → data.available_balance（人民币） */
export function parseMoonshotBalance(j: any): ParsedUsage {
  const d = j?.data
  const avail = Number(d?.available_balance)
  if (!d || !Number.isFinite(avail)) throw shapeError('Kimi 余额', j)
  const voucher = Number(d?.voucher_balance)
  return {
    used: 0, total: avail, remaining: avail, symbol: '¥',
    detail: Number.isFinite(voucher) && voucher > 0 ? `含代金券 ¥${voucher}` : undefined,
  }
}

/** 智谱 GLM：GET /api/paas/v4/balance（端点存在性已实测；字段名多版本并存，防御式提取） */
export function parseGlmBalance(j: any): ParsedUsage {
  const cands = [j?.data?.available_balance, j?.data?.balance, j?.data?.total_balance, j?.data?.amount,
    j?.available_balance, j?.balance, j?.total_balance]
  const hit = cands.find(v => v !== undefined && v !== null && Number.isFinite(Number(v)))
  if (hit === undefined) throw shapeError('GLM 余额', j)
  const n = Number(hit)
  return { used: 0, total: n, remaining: n, symbol: '¥' }
}

/** 硅基流动：GET /v1/user/info → data.balance（字符串，人民币） */
export function parseSiliconflowUserInfo(j: any): ParsedUsage {
  const bal = Number.parseFloat(j?.data?.balance)
  if (!j?.data || !Number.isFinite(bal)) throw shapeError('硅基流动余额', j)
  return { used: 0, total: bal, remaining: bal, symbol: '¥' }
}

/** OpenRouter：GET /api/v1/auth/key → data{usage, limit}（美元；limit 为 null 表示无上限） */
export function parseOpenrouterKeyInfo(j: any): ParsedUsage {
  const d = j?.data
  if (!d) throw shapeError('OpenRouter 额度', j)
  const usage = Number(d.usage ?? 0)
  if (d.limit === null || d.limit === undefined) {
    return { used: usage, label: `已用 $${usage} · 该 Key 无额度上限` }
  }
  const limit = Number(d.limit)
  return { used: usage, total: limit, remaining: Math.max(0, limit - usage), symbol: '$', detail: `总额度 $${limit}` }
}

/** 官方只读用量/余额端点白名单（Web 直连；桌面端后端有对应白名单） */
const API_ENDPOINTS: Record<string, Endpoint> = {
  openai: {
    url: 'https://api.openai.com/v1/organization/usage/completions',
    parse: (j) => ({ used: j.total_usage ?? 0 }),
  },
  anthropic: {
    url: 'https://api.anthropic.com/v1/usage',
    parse: (j) => ({ used: j.data?.reduce((s: number, d: any) => s + (d.input_tokens || 0) + (d.output_tokens || 0), 0) ?? 0 }),
  },
  deepseek: { url: 'https://api.deepseek.com/user/balance', unit: 'currency', parse: parseDeepseekBalance },
  kim: { url: 'https://api.moonshot.cn/v1/users/me/balance', unit: 'currency', parse: parseMoonshotBalance },
  glm: { url: 'https://open.bigmodel.cn/api/paas/v4/balance', unit: 'currency', parse: parseGlmBalance },
  siliconflow: { url: 'https://api.siliconflow.cn/v1/user/info', unit: 'currency', parse: parseSiliconflowUserInfo },
  openrouter: { url: 'https://openrouter.ai/api/v1/auth/key', unit: 'currency', parse: parseOpenrouterKeyInfo },
}

/** 把 fetchUsage 的结果格式化成一行可读文案（添加账户弹窗 / Key 列表刷新共用） */
export function formatUsageBalance(r: UsageResult): string {
  if (r.label) return r.label
  if (r.remaining !== undefined) {
    const sym = r.symbol ?? '¥'
    const num = r.remaining.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
    return `剩余 ${sym}${num}${r.detail ? ` · ${r.detail}` : ''}`
  }
  return `剩余 ${Math.max(0, (r.total ?? r.used) - r.used).toLocaleString()} ${r.unit}`
}

/** 检测是否运行在 Tauri 桌面端 */
function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** 调用 Tauri 后端代理命令（动态读取，Web 端不会执行） */
async function tauriProxyUsage(providerId: string, apiKey: string): Promise<any> {
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args: Record<string, unknown>) => Promise<any> } }
  if (!w.__TAURI_INTERNALS__?.invoke) throw new Error('桌面端代理不可用，请升级应用')
  return w.__TAURI_INTERNALS__.invoke('proxy_usage', { provider: providerId, apiKey })
}

export function getAdapter(providerId: string): DataSourceAdapter {
  const p = PROVIDER_MAP[providerId]
  const endpoint = API_ENDPOINTS[providerId]
  return {
    providerId,
    mode: p?.modes[0] ?? 'manual',
    supported: !!endpoint && !!p?.modes.includes('api'),
    usageUrl: p?.usageUrl ?? p?.officialUrl ?? '#',
    async fetchUsage(apiKey: string): Promise<UsageResult> {
      if (!endpoint) throw new Error(`${p?.name ?? providerId} 无公开只读用量 API，请到官方页面查看后手动录入`)

      let data: any
      if (inTauri()) {
        // 桌面端：由 Rust 后端请求官方端点，无 CORS 限制
        data = await tauriProxyUsage(providerId, apiKey)
      } else {
        // Web/手机端：直连官方接口（手机走原生网络层；Web 可能因 CORS 失败）
        const res = await fetch(endpoint.url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        })
        if (!res.ok) throw new Error(`官方接口返回 ${res.status}。请确认 Key 正确；Web 端受 CORS 限制时建议使用桌面端或手动录入`)
        data = await res.json()
      }
      const parsed = endpoint.parse(data)
      return { ...parsed, unit: endpoint.unit ?? 'token' }
    },
  }
}

export function listApiProviders(): string[] {
  return Object.keys(API_ENDPOINTS)
}

export function isDesktopProxyAvailable(): boolean {
  return inTauri()
}
