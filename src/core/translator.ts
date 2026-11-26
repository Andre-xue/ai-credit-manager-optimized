// 翻译助手（v0.1.440）：工坊新工具。划词/截图/输入三入口共用一套设置与翻译通道。
// 引擎不新增服务：复用工坊路线（loadWorkshopRoutes + runWorkshopChat，内含 433 免费
// 路线自动切换链与 439 的全局模式设置）。桌面原生能力（全局快捷键、模拟复制取词、
// 截图框选、Vision OCR、权限查询）在 Rust 侧 translator.rs，本模块只做 invoke 封装。
// 设置仅本机保存（localStorage），不云同步——含快捷键与权限这类设备级偏好。

import type { Account } from './types'
import { loadWorkshopRoutes, runWorkshopChat } from './workshopChat'
import { isValidAccelerator, humanizeShortcutError } from './hotkey'

export const TRANSLATOR_SETTINGS_KEY = 'acm.translator.settings.v1'
export const TRANSLATOR_ROUTE_KEY = 'acm.translator.routeKey.v1'
export const TRANSLATOR_SETTINGS_EVENT = 'acm-translator-settings-changed'

export type OpsDisplay = 'icon' | 'text' | 'both'

export interface TranslatorSettings {
  /** 划词翻译功能总开关（关了快捷键与双击都不触发） */
  selectionEnabled: boolean
  /** 截图翻译功能总开关 */
  screenshotEnabled: boolean
  /** 划词浮窗启用（关了则译文直接复制到剪贴板并提示，不弹小窗） */
  popEnabled: boolean
  /** 监听鼠标双击自动划词 */
  doubleClick: boolean
  /** 浮窗操作条显示方式 */
  opsDisplay: OpsDisplay
  /** 浮窗相对鼠标的水平/垂直偏移（pt） */
  offsetX: number
  offsetY: number
  /** 默认目标语言（显示名） */
  targetLang: string
  /** 备用目标语言：源语言与默认目标相同时改用它 */
  fallbackLang: string
  /** 原文预处理：智能删换行 + 拆分驼峰/下划线/连字符命名 */
  preprocess: boolean
  /** 全局快捷键（'CommandOrControl+Shift+A' 式组合，空串=未注册） */
  shortcutSelection: string
  shortcutScreenshot: string
  shortcutInput: string
  /** 在全屏应用中禁用快捷键 */
  disableInFullscreen: boolean
}

export const DEFAULT_TRANSLATOR_SETTINGS: TranslatorSettings = {
  selectionEnabled: true,
  screenshotEnabled: true,
  popEnabled: true,
  doubleClick: false,
  opsDisplay: 'both',
  offsetX: 12,
  offsetY: 16,
  targetLang: '简体中文',
  fallbackLang: '英语',
  preprocess: true,
  shortcutSelection: 'Alt+D',
  shortcutScreenshot: 'Alt+S',
  shortcutInput: 'Alt+T',
  disableInFullscreen: false,
}

export const TRANSLATOR_LANGS = [
  '简体中文', '繁体中文', '英语', '日语', '韩语', '法语', '德语', '西班牙语', '俄语', '葡萄牙语', '意大利语',
] as const

export type TranslatorShortcutField = 'shortcutSelection' | 'shortcutScreenshot' | 'shortcutInput'
const SHORTCUT_FIELDS: TranslatorShortcutField[] = ['shortcutSelection', 'shortcutScreenshot', 'shortcutInput']
const invalidShortcutFields = new Set<TranslatorShortcutField>()

/** 上次读设置时发现的无效快捷键字段（旧版本存的坏值，如「Alt+Œ」）：设置页据此显示「未注册（请重新录入）」 */
export function getInvalidTranslatorShortcutFields(): TranslatorShortcutField[] {
  return [...invalidShortcutFields]
}

export function loadTranslatorSettings(): TranslatorSettings {
  try {
    const raw = localStorage.getItem(TRANSLATOR_SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_TRANSLATOR_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<TranslatorSettings>
    const merged = { ...DEFAULT_TRANSLATOR_SETTINGS, ...parsed }
    // v0.1.451：旧版本用 e.key 录入存下过坏值（Alt+Œ），Tauri 解析不了、每次
    // 启动都注册失败。读时识别为无效：字段按未注册处理（不再下发注册），
    // 并记下字段名让设置页提示重新录入；用户重录后新值合法即自动恢复正常。
    for (const f of SHORTCUT_FIELDS) {
      const v = merged[f]
      if (v && !isValidAccelerator(v)) {
        invalidShortcutFields.add(f)
        merged[f] = ''
      } else if (v) {
        invalidShortcutFields.delete(f)
      }
    }
    return merged
  } catch { return { ...DEFAULT_TRANSLATOR_SETTINGS } }
}

export function saveTranslatorSettings(s: TranslatorSettings): void {
  try { localStorage.setItem(TRANSLATOR_SETTINGS_KEY, JSON.stringify(s)) } catch { /* 忽略 */ }
  try { window.dispatchEvent(new Event(TRANSLATOR_SETTINGS_EVENT)) } catch { /* 非浏览器环境 */ }
}

export function loadTranslatorRouteKey(): string {
  try { return localStorage.getItem(TRANSLATOR_ROUTE_KEY) ?? '' } catch { return '' }
}

export function saveTranslatorRouteKey(k: string): void {
  try { localStorage.setItem(TRANSLATOR_ROUTE_KEY, k) } catch { /* 忽略 */ }
}

// ---------------- 语种识别与目标语言 ----------------

export type LangFamily = 'zh' | 'ja' | 'ko' | 'ru' | 'en' | 'other'

/** 粗粒度源语言识别（只为决定目标语言是否撞车，不做精确检测）：假名优先于汉字判日语 */
export function detectSourceLang(text: string): LangFamily {
  const t = text.slice(0, 500)
  let kana = 0, hangul = 0, cjk = 0, cyr = 0, latin = 0
  for (const ch of t) {
    const c = ch.codePointAt(0) ?? 0
    if ((c >= 0x3040 && c <= 0x30ff)) kana++
    else if (c >= 0xac00 && c <= 0xd7af) hangul++
    else if (c >= 0x4e00 && c <= 0x9fff) cjk++
    else if (c >= 0x0400 && c <= 0x04ff) cyr++
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) latin++
  }
  const scored: [LangFamily, number][] = [['ja', kana * 2], ['ko', hangul], ['zh', cjk], ['ru', cyr], ['en', latin]]
  scored.sort((a, b) => b[1] - a[1])
  return scored[0][1] > 0 ? scored[0][0] : 'other'
}

const LANG_FAMILY: Record<string, LangFamily> = {
  '简体中文': 'zh', '繁体中文': 'zh', '英语': 'en', '日语': 'ja', '韩语': 'ko', '俄语': 'ru',
}

/** 本次翻译实际目标语言：源语言与默认目标同族时改用备用目标（Manggo 同款规则） */
export function pickTargetLang(text: string, s: TranslatorSettings): string {
  const src = detectSourceLang(text)
  const targetFam = LANG_FAMILY[s.targetLang]
  if (targetFam && src === targetFam) return s.fallbackLang
  return s.targetLang
}

const SOURCE_LANG_LABEL: Record<LangFamily, string> = {
  zh: '中文', ja: '日语', ko: '韩语', ru: '俄语', en: '英语', other: '自动检测',
}

/** 小窗语言行展示的源语言名（自动检测的结果，如「英语」；认不出给「自动检测」） */
export function sourceLangLabel(text: string): string {
  return SOURCE_LANG_LABEL[detectSourceLang(text)]
}

// ---------------- 原文预处理 ----------------

const CJK_RE = /[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/

/**
 * 原文预处理（纯函数）：①拆分代码式命名（camelCase / PascalCase / snake_case /
 * kebab-case）为带空格的词组；②智能删除换行——单换行按两侧字符拼接（CJK 两侧
 * 直接相连，其余补空格），空行段落保留。
 */
/** 智能删换行（小窗操作行同款）：单换行按两侧字符拼接，空行段落保留 */
export function removeSmartNewlines(text: string): string {
  const lines = text.split('\n')
  const joined: string[] = []
  for (const line of lines) {
    const prev = joined[joined.length - 1]
    if (prev === undefined || prev === '' || line.trim() === '') { joined.push(line); continue }
    const left = prev.slice(-1), right = line.charAt(0)
    const glue = CJK_RE.test(left) || CJK_RE.test(right) || /\s/.test(left) || /\s/.test(right) ? '' : ' '
    joined[joined.length - 1] = prev + glue + line
  }
  return joined.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function preprocessText(text: string, enabled: boolean): string {
  if (!enabled) return text
  const split = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z0-9])_([A-Za-z0-9])/g, '$1 $2')
    .replace(/([A-Za-z0-9])-([A-Za-z0-9])/g, '$1 $2')
  return removeSmartNewlines(split)
}

// ---------------- Tauri 封装 ----------------

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
function tauriInvoke(): InvokeFn | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke?: InvokeFn } }
  return w.__TAURI_INTERNALS__?.invoke ?? null
}

export interface TranslatorPermissions {
  macos: boolean
  accessibility: boolean
  screenCapture: boolean
}

/**
 * 权限载荷契约解析（v0.1.453）：Rust 侧 TranslatorPermissions 序列化为
 * { macos, accessibility, screenCapture }（screen_capture 带 serde rename）。
 * 451 在同一功能坐实过 snake_case/camelCase 对不上、无头 stub 掩盖真机契约的
 * 教训，这里把消费侧契约锁死：只认严格 true；screenCapture 缺失时回退读
 * screen_capture，防 Rust 侧 rename 丢失时前端恒读 false 且无声无息。
 */
export function parseTranslatorPermissions(raw: unknown): TranslatorPermissions {
  if (!raw || typeof raw !== 'object') return { macos: false, accessibility: false, screenCapture: false }
  const r = raw as Record<string, unknown>
  return {
    macos: r.macos === true,
    accessibility: r.accessibility === true,
    screenCapture: (r.screenCapture ?? r.screen_capture) === true,
  }
}

export async function getTranslatorPermissions(): Promise<TranslatorPermissions> {
  const inv = tauriInvoke()
  if (!inv) return { macos: false, accessibility: false, screenCapture: false }
  try {
    return parseTranslatorPermissions(await inv('translator_permissions'))
  } catch { return { macos: false, accessibility: false, screenCapture: false } }
}

/** 打开路径面包屑（v0.1.462）：把前端节点（页面挂载、首轮权限返回、快捷键
 * 下发结果）写进 Rust 侧 diag.log，与 perm-open / apply 步骤行拼成时间线；
 * 再闪退时看日志尾部就知道死在哪两步之间。非 Tauri 环境静默跳过，
 * 失败绝不影响功能（全程吞错）。 */
export async function noteTranslatorDiag(note: string): Promise<void> {
  const inv = tauriInvoke()
  if (!inv) return
  try { await inv('translator_diag_note', { note }) } catch { /* 忽略 */ }
}

/** 触发辅助功能系统授权请求（系统会把 App 登记进辅助功能列表并弹窗） */
export async function requestAccessibility(): Promise<boolean> {
  const inv = tauriInvoke()
  if (!inv) return false
  try { return await inv('translator_request_accessibility') as boolean } catch { return false }
}

/** 触发录屏系统授权请求 */
export async function requestScreenCapture(): Promise<boolean> {
  const inv = tauriInvoke()
  if (!inv) return false
  try { return await inv('translator_request_screen') as boolean } catch { return false }
}

/** 直达 macOS 系统设置对应隐私面板 */
export async function openPermissionSettings(kind: 'accessibility' | 'screen'): Promise<void> {
  const inv = tauriInvoke()
  if (!inv) return
  try { await inv('translator_open_settings', { kind }) } catch { /* 忽略 */ }
}

/** 把当前设置下发 Rust 注册全局快捷键（功能关掉的传空，Rust 只注销自己管的那批）。
 * 无效值（旧版本存的坏值）在这一层就滤掉、不下发，免得每次启动反复注册失败；
 * 注册真失败时把原因转成人话再报，不透上游英文原文与链接。 */
export async function applyTranslatorShortcuts(s: TranslatorSettings): Promise<string | null> {
  const inv = tauriInvoke()
  if (!inv) return null
  const valid = (v: string) => (v && isValidAccelerator(v) ? v : null)
  try {
    await inv('translator_shortcuts_apply', {
      selection: s.selectionEnabled ? valid(s.shortcutSelection) : null,
      screenshot: s.screenshotEnabled ? valid(s.shortcutScreenshot) : null,
      input: valid(s.shortcutInput),
      disableFullscreen: s.disableInFullscreen,
      doubleClick: s.selectionEnabled && s.doubleClick,
    })
    return null
  } catch (e) {
    return humanizeShortcutError(e instanceof Error ? e.message : String(e ?? '快捷键注册失败'))
  }
}

export interface SelectionOutcome {
  text: string | null
  error: string | null
  x: number
  y: number
}

/** 模拟复制取当前选中文本（Rust 侧）；失败时 error 带真实原因、x/y 仍是鼠标位置 */
export async function getSelectedText(): Promise<SelectionOutcome> {
  const inv = tauriInvoke()
  if (!inv) return { text: null, error: '划词翻译仅在桌面端可用', x: 0, y: 0 }
  return await inv('translator_get_selection') as SelectionOutcome
}

export async function showTranslatorPop(payload: {
  source: string; translated: string; targetLang: string; sourceLang?: string; error: string | null; ops: OpsDisplay; x: number; y: number
}): Promise<void> {
  const inv = tauriInvoke()
  if (!inv) return
  await inv('translator_show_pop', { sourceLang: '', ...payload } as unknown as Record<string, unknown>)
}

export async function writeClipboard(text: string): Promise<void> {
  const inv = tauriInvoke()
  if (inv) { try { await inv('translator_clipboard_write', { text }); return } catch { /* 落到浏览器剪贴板 */ } }
  try { await navigator.clipboard?.writeText(text) } catch { /* 忽略 */ }
}

/** 读剪贴板（小窗「粘贴并翻译」用；桌面端走 Rust pbpaste） */
export async function readClipboard(): Promise<string> {
  const inv = tauriInvoke()
  if (inv) {
    try { return await inv('translator_clipboard_read') as string } catch { /* 落到浏览器剪贴板 */ }
  }
  try { return await navigator.clipboard?.readText() ?? '' } catch { return '' }
}

/** 小窗置顶开关（对齐 Manggo 小窗的图钉） */
export async function setPopAlwaysOnTop(on: boolean): Promise<void> {
  const inv = tauriInvoke()
  if (!inv) return
  try { await inv('translator_pop_set_on_top', { on }) } catch { /* 忽略 */ }
}

// ---------------- 翻译执行（复用工坊路线 + 免费切换链） ----------------

export interface TranslateOutcome { translated: string; targetLang: string; usedLabel: string }

async function runTranslate(opts: {
  accounts: Account[]
  sessionPwd: string
  text: string
  targetLang: string
  sourceLangName?: string
  onChainNote?: (msg: string) => void
}): Promise<TranslateOutcome> {
  const { accounts, sessionPwd, targetLang } = opts
  const data = await loadWorkshopRoutes(accounts)
  if (!data.routes.length) throw new Error('没有可用模型：先在 AI 助手登录云账号或添加账户')
  const savedKey = loadTranslatorRouteKey()
  const route = data.routes.find(r => r.key === savedKey) ?? data.routes[0]
  if (route.kind === 'account' && route.disabledReason) throw new Error(route.disabledReason)
  const hint = opts.sourceLangName && opts.sourceLangName !== '自动检测' ? `源语言是${opts.sourceLangName}。` : ''
  const translated = await runWorkshopChat({
    route, freeOptions: data.freeOptions, accounts, sessionPwd,
    system: `你是专业翻译。${hint}把用户给出的文本翻译成${targetLang}。只输出译文，不要解释、不要加引号、不要保留原文。保留原有的段落与换行结构。`,
    user: opts.text.slice(0, 8000),
    onChainNote: opts.onChainNote,
  })
  return { translated: translated.trim(), targetLang, usedLabel: route.label }
}

export async function translateWithRoutes(opts: {
  accounts: Account[]
  sessionPwd: string
  text: string
  settings: TranslatorSettings
  onChainNote?: (msg: string) => void
}): Promise<TranslateOutcome> {
  const targetLang = pickTargetLang(opts.text, opts.settings)
  return runTranslate({
    accounts: opts.accounts, sessionPwd: opts.sessionPwd, text: opts.text,
    targetLang, onChainNote: opts.onChainNote,
  })
}

/** 小窗里切换目标语言/改原文后的重译：目标语言由用户显式选定，不走撞车改备用规则 */
export async function translateToTarget(opts: {
  accounts: Account[]
  sessionPwd: string
  text: string
  targetLang: string
  sourceLangName?: string
  onChainNote?: (msg: string) => void
}): Promise<TranslateOutcome> {
  return runTranslate(opts)
}

/** 语言显示名 → speechSynthesis 的 BCP47 代码（朗读用） */
const SPEAK_LANG: Record<string, string> = {
  '简体中文': 'zh-CN', '繁体中文': 'zh-TW', '英语': 'en-US', '日语': 'ja-JP', '韩语': 'ko-KR',
  '法语': 'fr-FR', '德语': 'de-DE', '西班牙语': 'es-ES', '俄语': 'ru-RU', '葡萄牙语': 'pt-PT', '意大利语': 'it-IT',
}
export function speakLangOf(name: string): string { return SPEAK_LANG[name] ?? 'zh-CN' }

// ---------------- 输入翻译入口（快捷键 → 打开工具页输入页签） ----------------

let pendingTab: 'input' | null = null
export function setPendingTranslatorTab(tab: 'input'): void { pendingTab = tab }
export function takePendingTranslatorTab(): 'input' | null {
  const t = pendingTab
  pendingTab = null
  return t
}
