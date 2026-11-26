// 翻译服务商（v0.1.477 两段式 → v0.1.480 三层管理）：翻译助手设置页管
// 「供给」——全部可用来源（自有账户平台 + 免费路线 + WorkBuddy 账号池）按
// Key 管理的分类（备注用途）分大组（免费/账号池/通用/对话），每组带总开关、
// 组内左平台右模型逐个带启用开关与测速耗时；小窗只管「选用」——下拉只列
// 可见的服务商（平台开关开 + 所在组总开关开 + 至少有一个启用的可翻译
// 模型），每项带最近实测耗时，选中记住为翻译专用引擎（仅本机），不跟随
// AI 助手当前选择。
// Key 只在 Key 管理维护，本模块不存任何密钥；偏好（开关/模型/耗时/选中/
// 组开关）仅本机 localStorage，不云同步。
// 翻译执行走 runWorkshopRouteOnce 锁定单路线：选了哪家就用哪家，失败报
// 该家真实原因，不静默切换（Ethan 定案口径）。
// v0.1.480 模型可见性：只展示能做文本翻译的对话模型，分类口径复用 469 的
// classifyMomaModel（对话/视觉/生图/语音合成/语音识别/向量/重排/安全/其他
// 九组，按模型名特征判定）——非「对话」组一律不展示，隐藏数如实标注。

import type { Account } from './types'
import { ENGINE_CATALOG } from '../data/engines'
import {
  loadWorkshopRoutes, runWorkshopRouteOnce, resolveWorkshopModel,
  type WorkshopRoute, type WorkshopRouteData,
} from './workshopChat'
import type { FreeAiOption } from './freeAi'
import { noteCategory } from './io'
import { classifyMomaModel } from './moma'

export const TRANSLATOR_PROVIDERS_KEY = 'acm.translator.providers.v1'
export const TRANSLATOR_ENGINE_KEY = 'acm.translator.engineKey.v1'
export const TRANSLATOR_GROUPS_KEY = 'acm.translator.providerGroups.v1'
/** 小窗「打开翻译设置」的一次性标记：宿主导航前置 1，翻译页挂载时消费并切到设置页签 */
export const TRANSLATOR_OPEN_SETTINGS_KEY = 'acm.translator.openSettings.v1'

export interface TranslatorModelPref {
  enabled?: boolean
  /** 该模型最近一次测速/真实翻译的端到端耗时（毫秒） */
  ms?: number
}

export interface TranslatorProviderPref {
  enabled?: boolean
  modelId?: string
  /** 最近一次测速/真实翻译的端到端耗时（毫秒，服务商级，与选中模型同步） */
  ms?: number
  /** 逐模型偏好（v0.1.480）：开关与耗时按模型分别记 */
  models?: Record<string, TranslatorModelPref>
}

export type TranslatorProviderPrefs = Record<string, TranslatorProviderPref>

/** 大分组（v0.1.480）：与 Key 管理「类型」（备注用途分类）同口径 */
export type TranslatorGroupId = 'free' | 'pool' | 'general' | 'chat'
export const TRANSLATOR_GROUPS: { id: TranslatorGroupId; label: string }[] = [
  { id: 'free', label: '免费' },
  { id: 'pool', label: '账号池' },
  { id: 'general', label: '通用' },
  { id: 'chat', label: '对话' },
]

/**
 * 服务商归哪个大组（纯函数）：账号池自成一组；免费路线归免费；自有账户看
 * Key 管理里的备注分类——含「免费」归免费、含「通用」归通用（如 MoMA 的
 * [通用型]），其余自有账户归对话（Inferbase/One AI/DeepSeek 等）。
 */
export function providerGroupOf(kind: 'free' | 'account' | 'wbpool', noteCat?: string): TranslatorGroupId {
  if (kind === 'wbpool') return 'pool'
  if (kind === 'free') return 'free'
  if (noteCat && noteCat.includes('免费')) return 'free'
  if (noteCat && noteCat.includes('通用')) return 'general'
  return 'chat'
}

/** 模型能否做文本翻译：复用 469 分类口径，只有「对话」组可译 */
export function isTranslatableModel(modelId: string): boolean {
  return classifyMomaModel(modelId) === 'chat'
}

export interface TranslatorModelInfo {
  id: string
  /** 能做文本翻译（469 分类=对话）；false 的不展示、只计入 hiddenCount */
  visible: boolean
  enabled: boolean
  ms?: number
}

export interface TranslatorProviderInfo {
  /** 路线 key（free:… / acct:… / wbpool），与 workshopChat 路线同构 */
  key: string
  label: string
  kind: 'free' | 'account' | 'wbpool'
  /** 当前生效模型（自有账户可改；免费路线/账号池为固定值，池为 ''） */
  modelId: string
  /** 可选模型全集（自有账户来自引擎目录；长度 ≤1 表示固定不可改） */
  modelOptions: string[]
  enabled: boolean
  ms?: number
  /** 路线自带的不可用原因（门槛未过等），如实展示、调用时也会再报一次 */
  disabledReason?: string
  /** 执行用路线（已写入选定 modelId） */
  route: WorkshopRoute
  /** v0.1.480：大分组与组总开关状态 */
  group: TranslatorGroupId
  groupEnabled: boolean
  /** v0.1.480：逐模型明细（可见性/开关/耗时）；账号池为空数组 */
  models: TranslatorModelInfo[]
  /** v0.1.480：被过滤隐藏的非对话模型数（界面灰字如实标注） */
  hiddenCount: number
  /**
   * v0.1.480：是否进小窗下拉/可被选为引擎 = 平台开关开 + 组总开关开 +
   * （账号池恒真 | 至少一个可见且启用的模型）。设置页仍展示全部服务商。
   */
  listed: boolean
}

/** 小窗下拉用的精简摘要（经载荷传给小窗，只含 listed 的） */
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

/** 逐模型偏好写入（v0.1.480）：深合并 models[modelId]，不动服务商级字段 */
export function saveProviderModelPref(key: string, modelId: string, patch: TranslatorModelPref): TranslatorProviderPrefs {
  const prefs = loadProviderPrefs()
  const prev = prefs[key] ?? {}
  prefs[key] = { ...prev, models: { ...(prev.models ?? {}), [modelId]: { ...(prev.models?.[modelId] ?? {}), ...patch } } }
  try { localStorage.setItem(TRANSLATOR_PROVIDERS_KEY, JSON.stringify(prefs)) } catch { /* 忽略 */ }
  return prefs
}

/** 大组总开关偏好（v0.1.480，仅本机）：缺省全开 */
export function loadGroupPrefs(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(TRANSLATOR_GROUPS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, boolean>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}

export function saveGroupPref(group: TranslatorGroupId, enabled: boolean): Record<string, boolean> {
  const prefs = loadGroupPrefs()
  prefs[group] = enabled
  try { localStorage.setItem(TRANSLATOR_GROUPS_KEY, JSON.stringify(prefs)) } catch { /* 忽略 */ }
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

function buildModels(options: string[], pref: TranslatorProviderPref): TranslatorModelInfo[] {
  return options.map(id => ({
    id,
    visible: isTranslatableModel(id),
    enabled: pref.models?.[id]?.enabled ?? true,
    ms: pref.models?.[id]?.ms,
  }))
}

/** 选定模型：偏好值 → 路线默认 → 第一个可见且启用的；都不可用时回路线默认（界面如实标注无可用模型） */
function resolveModelId(models: TranslatorModelInfo[], prefModelId: string | undefined, fallback: string): string {
  const usable = (id?: string): id is string => !!id && models.some(m => m.id === id && m.visible && m.enabled)
  if (usable(prefModelId)) return prefModelId
  if (usable(fallback)) return fallback
  return models.find(m => m.visible && m.enabled)?.id ?? fallback
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
  groupPrefs: Record<string, boolean> = {},
): TranslatorProviderInfo[] {
  const out: TranslatorProviderInfo[] = []
  for (const route of data.routes) {
    const pref = prefs[route.key] ?? {}
    const enabled = pref.enabled ?? true
    if (route.kind === 'free') {
      const opt = data.freeOptions.find(o => `free:${o.key}` === route.key)
      const modelId = opt?.modelId ?? ''
      const models = buildModels(modelId ? [modelId] : [], pref)
      const group = providerGroupOf('free')
      const groupEnabled = groupPrefs[group] !== false
      out.push({
        key: route.key, label: route.label, kind: 'free',
        modelId, modelOptions: modelId ? [modelId] : [],
        enabled, ms: pref.ms, route,
        group, groupEnabled, models,
        hiddenCount: models.filter(m => !m.visible).length,
        listed: enabled && groupEnabled && models.some(m => m.visible && m.enabled),
      })
    } else if (route.kind === 'wbpool') {
      const group = providerGroupOf('wbpool')
      const groupEnabled = groupPrefs[group] !== false
      out.push({
        key: route.key, label: route.label, kind: 'wbpool',
        modelId: '', modelOptions: [], enabled, ms: pref.ms, route,
        group, groupEnabled, models: [], hiddenCount: 0,
        listed: enabled && groupEnabled,
      })
    } else {
      const acct = accounts.find(a => a.id === route.accountId)
      const catalog = acct ? (ENGINE_CATALOG[acct.providerId] ?? []).map(e => e.id) : []
      const fallback = acct ? resolveWorkshopModel(acct, route) : (route.engine ?? '')
      const modelOptions = catalog.length ? catalog : (fallback ? [fallback] : [])
      const models = buildModels(modelOptions, pref)
      const modelId = resolveModelId(models, pref.modelId, fallback)
      const group = providerGroupOf('account', acct ? noteCategory(acct.note) : undefined)
      const groupEnabled = groupPrefs[group] !== false
      const selectedMs = models.find(m => m.id === modelId)?.ms
      out.push({
        key: route.key, label: acct?.label ?? route.label, kind: 'account',
        modelId, modelOptions, enabled, ms: selectedMs ?? pref.ms,
        disabledReason: route.disabledReason,
        route: { ...route, modelId },
        group, groupEnabled, models,
        hiddenCount: models.filter(m => !m.visible).length,
        listed: enabled && groupEnabled && models.some(m => m.visible && m.enabled),
      })
    }
  }
  return out
}

/**
 * 派生字段重算（v0.1.480，纯函数）：开关/选模型后界面本地即时更新用，
 * 口径与 buildProviderInfos 一致（listed、选定模型回落、耗时跟随选定模型）。
 */
function recomputeProvider(info: TranslatorProviderInfo): TranslatorProviderInfo {
  const usable = info.models.filter(m => m.visible && m.enabled)
  let modelId = info.modelId
  if (info.kind === 'account' && !usable.some(m => m.id === modelId)) {
    modelId = usable[0]?.id ?? modelId
  }
  const selMs = info.models.find(m => m.id === modelId)?.ms
  return {
    ...info,
    modelId,
    ms: modelId === info.modelId ? (selMs ?? info.ms) : selMs,
    route: info.route.kind === 'account' ? { ...info.route, modelId } : info.route,
    listed: info.enabled && info.groupEnabled && (info.kind === 'wbpool' || usable.length > 0),
  }
}

export function withProviderEnabled(info: TranslatorProviderInfo, enabled: boolean): TranslatorProviderInfo {
  return recomputeProvider({ ...info, enabled })
}

export function withGroupEnabled(info: TranslatorProviderInfo, groupEnabled: boolean): TranslatorProviderInfo {
  return recomputeProvider({ ...info, groupEnabled })
}

export function withModelEnabled(info: TranslatorProviderInfo, modelId: string, enabled: boolean): TranslatorProviderInfo {
  return recomputeProvider({ ...info, models: info.models.map(m => (m.id === modelId ? { ...m, enabled } : m)) })
}

export function withProviderModel(info: TranslatorProviderInfo, modelId: string): TranslatorProviderInfo {
  return recomputeProvider({ ...info, modelId })
}

export function withModelMs(info: TranslatorProviderInfo, modelId: string, ms: number): TranslatorProviderInfo {
  return recomputeProvider({ ...info, models: info.models.map(m => (m.id === modelId ? { ...m, ms } : m)) })
}

export async function loadTranslatorProviders(accounts: Account[]): Promise<{
  providers: TranslatorProviderInfo[]
  freeOptions: FreeAiOption[]
}> {
  const data = await loadWorkshopRoutes(accounts)
  return { providers: buildProviderInfos(data, accounts, loadProviderPrefs(), loadGroupPrefs()), freeOptions: data.freeOptions }
}

/**
 * 当前翻译引擎（纯函数，可测）：可见（listed）里优先用户上次选中的；
 * 选中项被关掉/所在组被关/不存在时取实测最快者；没有任何测速数据时取
 * 第一个可见的。一个都不可见返回 null——调用方据此如实提示，不许偷偷
 * 用别家（组总开关关掉当前引擎所在组时即靠这条回落，v0.1.480）。
 */
export function pickTranslatorEngine(
  providers: TranslatorProviderInfo[],
  savedKey: string,
): TranslatorProviderInfo | null {
  const enabled = providers.filter(p => p.listed ?? p.enabled)
  if (!enabled.length) return null
  const saved = enabled.find(p => p.key === savedKey)
  if (saved) return saved
  const measured = enabled.filter(p => typeof p.ms === 'number')
  if (measured.length) return measured.reduce((a, b) => ((a.ms ?? Infinity) <= (b.ms ?? Infinity) ? a : b))
  return enabled[0]
}

/** 小窗载荷里的服务商摘要：只含可见（listed）的——关掉的/整组关的/无可译模型的都不出现在小窗下拉 */
export function enabledProviderSummaries(providers: TranslatorProviderInfo[]): TranslatorProviderSummary[] {
  return providers.filter(p => p.listed ?? p.enabled).map(p => ({ key: p.key, label: p.label, ms: p.ms }))
}

const MEASURE_SYSTEM = '你是专业翻译。把用户给出的文本翻译成简体中文。只输出译文，不要解释、不要加引号。'

/**
 * 测速：用该服务商（可指定模型）真实发一条短翻译请求，测端到端耗时并把
 * 结果回填持久化（逐模型 + 服务商级同步；成功才回填，失败抛真实原因，
 * 不写假数据）。
 */
export async function measureProviderMs(opts: {
  accounts: Account[]
  sessionPwd: string
  provider: TranslatorProviderInfo
  freeOptions: FreeAiOption[]
  /** v0.1.480：测指定模型（缺省测服务商当前选定模型） */
  modelId?: string
}): Promise<number> {
  const modelId = opts.modelId ?? opts.provider.modelId
  const route: WorkshopRoute = opts.provider.route.kind === 'account' && modelId
    ? { ...opts.provider.route, modelId }
    : opts.provider.route
  const t0 = performance.now()
  const text = await runWorkshopRouteOnce(route, {
    route,
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
  if (modelId) saveProviderModelPref(opts.provider.key, modelId, { ms })
  if (!opts.modelId || opts.modelId === opts.provider.modelId) saveProviderPref(opts.provider.key, { ms })
  return ms
}
