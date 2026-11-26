// 翻译助手（v0.1.440）：工坊新工具。划词/截图/输入三入口共用一套设置与翻译通道。
// 引擎不新增服务：复用工坊路线（loadWorkshopRoutes + runWorkshopChat，内含 433 免费
// 路线自动切换链与 439 的全局模式设置）。桌面原生能力（全局快捷键、模拟复制取词、
// 截图框选、Vision OCR、权限查询）在 Rust 侧 translator.rs，本模块只做 invoke 封装。
// 设置仅本机保存（localStorage），不云同步——含快捷键与权限这类设备级偏好。

import type { Account } from './types'
import { loadWorkshopRoutes, runWorkshopChat } from './workshopChat'

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

export function loadTranslatorSettings(): TranslatorSettings {
  try {
    const raw = localStorage.getItem(TRANSLATOR_SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_TRANSLATOR_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<TranslatorSettings>
    return { ...DEFAULT_TRANSLATOR_SETTINGS, ...parsed }
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

// ---------------- 原文预处理 ----------------

const CJK_RE = /[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/

/**
 * 原文预处理（纯函数）：①拆分代码式命名（camelCase / PascalCase / snake_case /
 * kebab-case）为带空格的词组；②智能删除换行——单换行按两侧字符拼接（CJK 两侧
 * 直接相连，其余补空格），空行段落保留。
 */
export function preprocessText(text: string, enabled: boolean): string {
  if (!enabled) return text
  let out = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z0-9])_([A-Za-z0-9])/g, '$1 $2')
    .replace(/([A-Za-z0-9])-([A-Za-z0-9])/g, '$1 $2')
  const lines = out.split('\n')
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

export async function getTranslatorPermissions(): Promise<TranslatorPermissions> {
  const inv = tauriInvoke()
  if (!inv) return { macos: false, accessibility: false, screenCapture: false }
  try {
    return await inv('translator_permissions') as TranslatorPermissions
  } catch { return { macos: false, accessibility: false, screenCapture: false } }
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

/** 把当前设置下发 Rust 注册全局快捷键（功能关掉的传空，Rust 只注销自己管的那批） */
export async function applyTranslatorShortcuts(s: TranslatorSettings): Promise<string | null> {
  const inv = tauriInvoke()
  if (!inv) return null
  try {
    await inv('translator_shortcuts_apply', {
      selection: s.selectionEnabled && s.shortcutSelection ? s.shortcutSelection : null,
      screenshot: s.screenshotEnabled && s.shortcutScreenshot ? s.shortcutScreenshot : null,
      input: s.shortcutInput ? s.shortcutInput : null,
      disableFullscreen: s.disableInFullscreen,
      doubleClick: s.selectionEnabled && s.doubleClick,
    })
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e ?? '快捷键注册失败')
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
  source: string; translated: string; targetLang: string; error: string | null; ops: OpsDisplay; x: number; y: number
}): Promise<void> {
  const inv = tauriInvoke()
  if (!inv) return
  await inv('translator_show_pop', payload as unknown as Record<string, unknown>)
}

export async function writeClipboard(text: string): Promise<void> {
  const inv = tauriInvoke()
  if (inv) { try { await inv('translator_clipboard_write', { text }); return } catch { /* 落到浏览器剪贴板 */ } }
  try { await navigator.clipboard?.writeText(text) } catch { /* 忽略 */ }
}

// ---------------- 翻译执行（复用工坊路线 + 免费切换链） ----------------

export interface TranslateOutcome { translated: string; targetLang: string; usedLabel: string }

export async function translateWithRoutes(opts: {
  accounts: Account[]
  sessionPwd: string
  text: string
  settings: TranslatorSettings
  onChainNote?: (msg: string) => void
}): Promise<TranslateOutcome> {
  const { accounts, sessionPwd, settings } = opts
  const targetLang = pickTargetLang(opts.text, settings)
  const data = await loadWorkshopRoutes(accounts)
  if (!data.routes.length) throw new Error('没有可用模型：先在 AI 助手登录云账号或添加账户')
  const savedKey = loadTranslatorRouteKey()
  const route = data.routes.find(r => r.key === savedKey) ?? data.routes[0]
  if (route.kind === 'account' && route.disabledReason) throw new Error(route.disabledReason)
  const translated = await runWorkshopChat({
    route, freeOptions: data.freeOptions, accounts, sessionPwd,
    system: `你是专业翻译。把用户给出的文本翻译成${targetLang}。只输出译文，不要解释、不要加引号、不要保留原文。保留原有的段落与换行结构。`,
    user: opts.text.slice(0, 8000),
    onChainNote: opts.onChainNote,
  })
  return { translated: translated.trim(), targetLang, usedLabel: route.label }
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
