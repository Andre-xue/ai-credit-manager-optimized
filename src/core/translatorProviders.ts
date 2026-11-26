// 翻译服务商（v0.1.477 两段式）：翻译助手设置页管「供给」——全部可用来源
// （自有账户平台 + 免费路线 + WorkBuddy 账号池）逐家带启用开关、默认模型、
// 测速耗时；小窗只管「选用」——下拉只列已启用的服务商，每项带最近实测耗时，
// 选中记住为翻译专用引擎（仅本机），不跟随 AI 助手当前选择。
// Key 只在 Key 管理维护，本模块不存任何密钥；偏好（开关/模型/耗时/选中）
// 仅本机 localStorage，不云同步。
// 翻译执行走 runWorkshopRouteOnce 锁定单路线：选了哪家就用哪家，失败报
// 该家真实原因，不静默切换（Ethan 定案口径）。

import type { Account } from './types'
import { ENGINE_CATALOG } from '../data/engines'
import {
  loadWorkshopRoutes, runWorkshopRouteOnce, resolveWorkshopModel,
  type WorkshopRoute, type WorkshopRouteData,
} from './workshopChat'
import type { FreeAiOption } from './freeAi'

export const TRANSLATOR_PROVIDERS_KEY = 'acm.translator.providers.v1'
export const TRANSLATOR_ENGINE_KEY = 'acm.translator.engineKey.v1'
/** 小窗「打开翻译设置」的一次性标记：宿主导航前置 1，翻译页挂载时消费并切到设置页签 */
export const TRANSLATOR_OPEN_SETTINGS_KEY = 'acm.translator.openSettings.v1'

export interface TranslatorProviderPref {
  enabled?: boolean
  modelId?: string
  /** 最近一次测速/真实翻译的端到端耗时（毫秒） */
  ms?: number
}

export type TranslatorProviderPrefs = Record<string, TranslatorProviderPref>

export interface TranslatorProviderInfo {
  /** 路线 key（free:… / acct:… / wbpool），与 workshopChat 路线同构 */
  key: string
  label: string
  kind: 'free' | 'account' | 'wbpool'
  /** 当前生效模型（自有账户可改；免费路线/账号池为固定值，池为 ''） */
  modelId: string
  /** 可选模型（自有账户来自引擎目录；长度 ≤1 表示固定不可改） */
  modelOptions: string[]
  enabled: boolean
  ms?: number
  /** 路线自带的不可用原因（门槛未过等），如实展示、调用时也会再报一次 */
  disabledReason?: string
  /** 执行用路线（已写入选定 modelId） */
  route: WorkshopRoute
}

/** 小窗下拉用的精简摘要（经载荷传给小窗，只含已启用） */
export interface TranslatorProviderSummary {
  key: string
  label: string
  ms?: number
}

export function loadProviderPrefs(): TranslatorProviderPrefs {
  try {
    const raw = localStorage.getItem(TRANSLATOR_PROVIDERS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as TranslatorProviderPrefs
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}

export function saveProviderPref(key: string, patch: TranslatorProviderPref): TranslatorProviderPrefs {
  const prefs = loadProviderPrefs()
  prefs[key] = { ...prefs[key], ...patch }
  try { localStorage.setItem(TRANSLATOR_PROVIDERS_KEY, JSON.stringify(prefs)) } catch { /* 忽略 */ }
  return prefs
}

export function loadTranslatorEngineKey(): string {
  try { return localStorage.getItem(TRANSLATOR_ENGINE_KEY) ?? '' } catch { return '' }
}

export function saveTranslatorEngineKey(k: string): void {
  try { localStorage.setItem(TRANSLATOR_ENGINE_KEY, k) } catch { /* 忽略 */ }
}

/** 耗时展示：<1s 给毫秒、≥1s 给一位小数秒（与小窗「耗时 0.9s」口径一致） */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * 路线列表 + 账户 + 偏好 → 服务商清单（纯函数，可测）。
 * 自有账户的模型选项来自引擎目录；目录未收录的平台（MoMA/AnyAPI 等）
 * 用冒烟/解析出的默认模型单项固定。免费路线每条自成一家、模型固定。
 */
export function buildProviderInfos(
  data: WorkshopRouteData,
  accounts: Account[],
  prefs: TranslatorProviderPrefs,
): TranslatorProviderInfo[] {
  const out: TranslatorProviderInfo[] = []
  for (const route of data.routes) {
    const pref = prefs[route.key] ?? {}
    const enabled = pref.enabled ?? true
    if (route.kind === 'free') {
      const opt = data.freeOptions.find(o => `free:${o.key}` === route.key)
      const modelId = opt?.modelId ?? ''
      out.push({
        key: route.key, label: route.label, kind: 'free',
        modelId, modelOptions: modelId ? [modelId] : [],
        enabled, ms: pref.ms, route,
      })
    } else if (route.kind === 'wbpool') {
      out.push({
        key: route.key, label: route.label, kind: 'wbpool',
        modelId: '', modelOptions: [], enabled, ms: pref.ms, route,
      })
    } else {
      const acct = accounts.find(a => a.id === route.accountId)
      const catalog = acct ? (ENGINE_CATALOG[acct.providerId] ?? []).map(e => e.id) : []
      const fallback = acct ? resolveWorkshopModel(acct, route) : (route.engine ?? '')
      const modelOptions = catalog.length ? catalog : (fallback ? [fallback] : [])
      const modelId = pref.modelId && modelOptions.includes(pref.modelId)
        ? pref.modelId
        : (modelOptions.includes(fallback) ? fallback : modelOptions[0] ?? fallback)
      out.push({
        key: route.key, label: acct?.label ?? route.label, kind: 'account',
        modelId, modelOptions, enabled, ms: pref.ms,
        disabledReason: route.disabledReason,
        route: { ...route, modelId },
      })
    }
  }
  return out
}

export async function loadTranslatorProviders(accounts: Account[]): Promise<{
  providers: TranslatorProviderInfo[]
  freeOptions: FreeAiOption[]
}> {
  const data = await loadWorkshopRoutes(accounts)
  return { providers: buildProviderInfos(data, accounts, loadProviderPrefs()), freeOptions: data.freeOptions }
}

/**
 * 当前翻译引擎（纯函数，可测）：已启用里优先用户上次选中的；
 * 选中项被关掉/不存在时取实测最快者；没有任何测速数据时取第一个已启用。
 * 一个都没启用返回 null——调用方据此如实提示，不许偷偷用别家。
 */
export function pickTranslatorEngine(
  providers: TranslatorProviderInfo[],
  savedKey: string,
): TranslatorProviderInfo | null {
  const enabled = providers.filter(p => p.enabled)
  if (!enabled.length) return null
  const saved = enabled.find(p => p.key === savedKey)
  if (saved) return saved
  const measured = enabled.filter(p => typeof p.ms === 'number')
  if (measured.length) return measured.reduce((a, b) => ((a.ms ?? Infinity) <= (b.ms ?? Infinity) ? a : b))
  return enabled[0]
}

/** 小窗载荷里的服务商摘要：只含已启用（关掉的不出现在小窗下拉） */
export function enabledProviderSummaries(providers: TranslatorProviderInfo[]): TranslatorProviderSummary[] {
  return providers.filter(p => p.enabled).map(p => ({ key: p.key, label: p.label, ms: p.ms }))
}

const MEASURE_SYSTEM = '你是专业翻译。把用户给出的文本翻译成简体中文。只输出译文，不要解释、不要加引号。'

/**
 * 测速：用该服务商真实发一条短翻译请求，测端到端耗时并把结果回填
 * 持久化（成功才回填；失败抛真实原因，不写假数据）。
 */
export async function measureProviderMs(opts: {
  accounts: Account[]
  sessionPwd: string
  provider: TranslatorProviderInfo
  freeOptions: FreeAiOption[]
}): Promise<number> {
  const t0 = performance.now()
  const text = await runWorkshopRouteOnce(opts.provider.route, {
    route: opts.provider.route,
    freeOptions: opts.freeOptions,
    accounts: opts.accounts,
    sessionPwd: opts.sessionPwd,
    system: MEASURE_SYSTEM,
    user: 'Hello',
    maxTokens: 256,
    reasoningEffort: 'minimal',
  })
  if (!text.trim()) throw new Error('测速请求返回了空译文')
  const ms = Math.round(performance.now() - t0)
  saveProviderPref(opts.provider.key, { ms })
  return ms
}
