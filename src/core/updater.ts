// 应用更新：按平台走各自的更新机制。
// - 桌面 Tauri：官方 updater（检查 → 下载安装 → 重启）
// - Docker/Web：网页无法操作宿主容器/服务器，用 GitHub Releases 检查版本 + 给出可复制的更新指令
// - 微信小程序：wx.getUpdateManager() 官方更新（检查 → 下载 → 重启）
// - 安卓 APK：给出下载最新 APK 的链接（无法静默安装，需用户确认）

import { isDesktopApp, isNativeApp } from './openExternal'

import pkg from '../../package.json'

/** 当前版本直接取自 package.json，避免手写常量过期 */
export const APP_VERSION = pkg.version

const REPO = 'Andre-xue/ai-credit-manager-optimized'
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`
const RELEASES_LIST_API = `https://api.github.com/repos/${REPO}/releases?per_page=10`
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`
/** Tauri 更新清单直链：走 Release 资产 CDN，不经过 api.github.com（未认证 60 次/小时/IP，极易触发限流） */
const LATEST_JSON_URL = `https://github.com/${REPO}/releases/latest/download/latest.json`

/** 更新镜像（v0.1.346）：直连 + 公共加速前缀；检查清单多源竞速、下载测速选最快 */
export const UPDATE_MIRROR_PREFIXES = [
  'https://gh-proxy.com/https://github.com',
  'https://ghproxy.net/https://github.com',
  'https://ghfast.top/https://github.com',
  'https://github.com',
]
const LATEST_JSON_CANDIDATES = [...UPDATE_MIRROR_PREFIXES.slice(0, 3).map(p => `${p}/${REPO}/releases/latest/download/latest.json`), LATEST_JSON_URL]

/** 拉一个文本 URL：安卓原生端走 CapacitorHttp（原生网络栈、无 CORS 限制）；其余走 fetch */
export async function fetchUrlText(url: string, timeoutMs = 8000): Promise<string> {
  if (isNativeApp()) {
    const { CapacitorHttp } = await import('@capacitor/core')
    const res = await Promise.race([
      CapacitorHttp.request({ url, method: 'GET', responseType: 'text', connectTimeout: timeoutMs, readTimeout: timeoutMs }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs + 1000)),
    ]) as { status: number; data: unknown }
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`)
    return typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
  }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } finally { clearTimeout(timer) }
}

/** 多源竞速拉一个小文件：谁先完整返回用谁（单源 6 秒超时） */
export async function fetchFastestText(urls: string[], timeoutMs = 6000): Promise<string | null> {
  try {
    return await Promise.any(urls.map(u => fetchUrlText(u, timeoutMs)))
  } catch { return null }
}

/** 解析 latest.json（Tauri updater 清单）；无效返回 null */
export function parseLatestJson(text: string): { version: string; notes: string; pubDate?: string } | null {
  try {
    const j = JSON.parse(text) as { version?: string; notes?: string; pub_date?: string }
    const version = (j.version ?? '').replace(/^v/i, '').trim()
    if (!version) return null
    return { version, notes: j.notes ?? '', pubDate: j.pub_date }
  } catch { return null }
}

/** 某版本的 APK 直链（资产名由发布流程固定为 app-release.apk） */
export function apkUrlForVersion(version: string): string {
  const v = version.replace(/^v/i, '')
  return `https://github.com/${REPO}/releases/download/v${v}/app-release.apk`
}

/** 先经 latest.json 查更新（不限流）；清单存在即说明该版本安装包已就绪 */
async function checkViaLatestJson(): Promise<UpdateInfo | null> {
  const text = await fetchFastestText(LATEST_JSON_CANDIDATES)
  if (!text) return null
  const parsed = parseLatestJson(text)
  if (!parsed) return null
  return {
    current: APP_VERSION,
    latest: parsed.version,
    hasUpdate: versionGreater(parsed.version, APP_VERSION),
    releaseUrl: `https://github.com/${REPO}/releases/tag/v${parsed.version}`,
    notes: parsed.notes,
    publishedAt: parsed.pubDate,
    installersReady: true,
  }
}

export type UpdatePlatform = 'desktop' | 'android' | 'docker' | 'web' | 'miniapp'

export function currentPlatform(): UpdatePlatform {
  if (isDesktopApp()) return 'desktop'
  if (typeof wx !== 'undefined' && typeof (wx as WxLike).getUpdateManager === 'function') return 'miniapp'
  if (isNativeApp()) return 'android'
  // Docker 与 Web 都是浏览器；通过端口/域名粗判（docker 常见 8080），供文案区分
  if (typeof location !== 'undefined' && (location.port === '8080' || /docker/i.test(location.hostname))) return 'docker'
  return 'web'
}

/** 版本比较：返回 a > b。忽略前导 v 与非数字后缀 */
function versionGreater(a: string, b: string): boolean {
  const pa = a.replace(/^v/i, '').split(/[.\-]/).map(x => parseInt(x, 10) || 0)
  const pb = b.replace(/^v/i, '').split(/[.\-]/).map(x => parseInt(x, 10) || 0)
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

export interface UpdateInfo {
  current: string
  latest: string
  hasUpdate: boolean
  releaseUrl: string
  notes: string
  publishedAt?: string
  /** 网络/接口错误说明；有值时界面展示具体原因而不是"检查网络" */
  error?: string
  /** 该 Release 是否已经上传桌面安装包与更新清单 */
  installersReady?: boolean
  /** true = 最新版桌面包尚未就绪，回退到了最近一个带完整安装包的版本 */
  fallback?: boolean
}

interface GitHubRelease {
  tag_name: string
  body?: string
  published_at?: string
  assets?: Array<{ name: string; browser_download_url: string }>
  draft?: boolean
  prerelease?: boolean
}

/** 一个 Release 是否带有完整的桌面安装包与更新清单 */
function hasDesktopInstallers(rel: GitHubRelease): boolean {
  const assets = rel.assets ?? []
  return assets.some(a => a.name === 'latest.json')
    && assets.some(a => /\.(dmg|exe|msi|AppImage|deb)$/i.test(a.name))
}

function toInfo(rel: GitHubRelease, fallback: boolean): UpdateInfo {
  const latest = rel.tag_name?.replace(/^v/i, '') ?? ''
  const ready = hasDesktopInstallers(rel)
  return {
    current: APP_VERSION,
    latest,
    hasUpdate: versionGreater(latest, APP_VERSION),
    releaseUrl: `https://github.com/${REPO}/releases/tag/${rel.tag_name}`,
    notes: rel.body ?? '',
    publishedAt: rel.published_at,
    installersReady: ready,
    fallback,
  }
}

/**
 * 从 GitHub Releases 查询最新版本（Web/Docker/安卓用）。
 * requireDesktopInstaller=true（桌面端）时：若最新版桌面包仍在构建，
 * 自动回退到最近一个带完整安装包的版本，界面始终给出可下载按钮。
 */
export async function checkReleaseUpdate(requireDesktopInstaller = false): Promise<UpdateInfo | null> {
  const base: UpdateInfo = {
    current: APP_VERSION, latest: '', hasUpdate: false, releaseUrl: RELEASES_PAGE, notes: '',
  }
  // 首选 latest.json 直链：不走 GitHub API、没有频率限制（v0.1.311，修安卓端检查更新常报限流）
  try {
    const viaJson = await checkViaLatestJson()
    if (viaJson) return viaJson
  } catch { /* 清单不可达 → 回退 API 流程 */ }
  try {
    let rel: GitHubRelease
    try {
      rel = JSON.parse(await fetchUrlText(RELEASES_API)) as GitHubRelease
    } catch (e) {
      const m = (e as Error)?.message ?? ''
      return {
        ...base,
        error: /HTTP 403/.test(m)
          ? 'GitHub 接口触发访问频率限制，请稍后再试（网络正常也会出现）'
          : /HTTP (\d+)/.test(m) ? `GitHub 接口返回 ${m.match(/HTTP (\d+)/)?.[1]}` : `无法连接 GitHub：${m}`,
      }
    }
    const latest = rel.tag_name?.replace(/^v/i, '') ?? ''
    if (!latest) return { ...base, error: 'GitHub 未返回版本号' }

    // 桌面端：最新版如果还没有桌面包，往前找最近一个完整版本
    if (requireDesktopInstaller && !hasDesktopInstallers(rel)) {
      try {
        const list = JSON.parse(await fetchUrlText(RELEASES_LIST_API)) as GitHubRelease[]
        const usable = list.find(r => !r.draft && !r.prerelease && hasDesktopInstallers(r))
        if (usable) return toInfo(usable, true)
      } catch { /* 列表失败按构建中处理 */ }
      // 拉取列表失败或没有可用版本：回报构建中，由界面提示稍后重试
      return { ...toInfo(rel, false), installersReady: false }
    }

    return toInfo(rel, false)
  } catch (e) {
    return { ...base, error: `无法连接 GitHub：${(e as Error)?.message ?? String(e)}` }
  }
}

/** 把更新器底层错误翻成可读中文 */
function friendlyUpdateError(e: unknown): string {
  const m = String((e as Error)?.message ?? e ?? '')
  if (/error sending request|failed to fetch|connection|timeout|dns|tcp/i.test(m)) {
    return '连接 GitHub 更新服务器失败（网络抖动或代理问题），请稍后重试'
  }
  if (/signature|public key|verify/i.test(m)) return '更新包签名校验失败，请确认应用为官方版本'
  return m.slice(0, 200)
}

/**
 * 桌面检查更新的总超时预算（v0.1.464）：20 秒封顶，含 latest.json 竞速、插件
 * 检查与一次重试。旧实现对插件 check() 没有任何超时——它按 tauri.conf 的
 * 端点串行查（gh-proxy → ghproxy → github 直连），某个镜像端点挂死就能无限
 * 转圈（Ethan 实机录屏 13 秒以上无结果；沙箱实测同款端点：gh-proxy 25 秒
 * 未返回、ghproxy 12.7 秒、github 直连 1.7 秒——沙箱网络与本机 Clash 路径
 * 不同，只作量级参考）。到点必须如实报超时，不许无限转。
 */
export const DESKTOP_CHECK_BUDGET_MS = 20_000
/** 插件单次检查的等待上限（总预算内还要留重试与回退的余量） */
const PLUGIN_CHECK_ATTEMPT_MS = 12_000

export type DesktopCheckStage = 'connecting' | 'comparing' | 'retrying'

export class CheckTimeoutError extends Error {
  constructor(ms: number) { super(`timeout after ${ms}ms`); this.name = 'CheckTimeoutError' }
}

/** 给任意 Promise 套硬超时：到点以 CheckTimeoutError 拒绝（底层请求不取消，但不再等它） */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new CheckTimeoutError(ms)), ms)),
  ])
}

/**
 * 桌面端检查更新（v0.1.464 重做检查环节，下载/安装流程不动）：
 * 1) 先走 latest.json 多源竞速（单源 6 秒、谁先完整返回用谁）——已是最新时
 *    立刻回 upToDate，不再等插件串行慢查（旧实现插件回「无更新」后界面还要
 *    再走一遍 GitHub 回退流程，白等十几秒）；
 * 2) 有新版或清单不可达时再调插件 check() 拿可安装的更新对象，单次等待
 *    有上限、失败重试一次，全程不超过 DESKTOP_CHECK_BUDGET_MS；
 * 3) 超时/失败如实回 error（超时有专属文案），插件失败但清单已确认有新版时
 *    把版本号一并交出，界面可直接走手动下载通道。
 */
export async function checkDesktopUpdate(onStage?: (s: DesktopCheckStage) => void): Promise<{
  version: string; currentVersion: string; body?: string; error?: string; upToDate?: boolean
}> {
  const deadline = Date.now() + DESKTOP_CHECK_BUDGET_MS
  const remain = () => Math.max(0, deadline - Date.now())
  onStage?.('connecting')
  let viaJson: UpdateInfo | null = null
  try { viaJson = await checkViaLatestJson() } catch { /* 清单不可达 → 继续走插件检查 */ }
  if (viaJson && !viaJson.hasUpdate) {
    return { version: viaJson.latest, currentVersion: APP_VERSION, upToDate: true }
  }
  onStage?.('comparing')
  let lastErr = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      if (remain() <= 2_000) break
      onStage?.('retrying')
      await new Promise(r => setTimeout(r, 1500)) // 网络抖动重试
      if (remain() <= 1_000) break
    }
    try {
      const { check } = await import('@tauri-apps/plugin-updater')
      const update = await withTimeout(check(), Math.min(PLUGIN_CHECK_ATTEMPT_MS, remain()))
      if (!update) return { version: APP_VERSION, currentVersion: APP_VERSION, upToDate: true }
      return { version: update.version, currentVersion: update.currentVersion, body: update.body }
    } catch (e) {
      lastErr = e instanceof CheckTimeoutError
        ? '检查超时：网络慢或连不上更新服务器，请稍后重试'
        : friendlyUpdateError(e)
    }
  }
  if (viaJson?.hasUpdate) {
    return { version: viaJson.latest, currentVersion: APP_VERSION, body: viaJson.notes, error: lastErr || '自动更新通道暂时不可用' }
  }
  return { version: '', currentVersion: APP_VERSION, error: lastErr || '检查更新失败，请稍后重试' }
}

export interface InstallProgress { downloaded: number; total?: number }

/** 桌面端：下载并安装更新。macOS/Linux 安装后需调用 relaunchApp() */
export async function installDesktopUpdate(onProgress?: (p: InstallProgress) => void): Promise<boolean> {
  // 先走镜像快速通道（v0.1.346）：测速选源、慢了自动换、SHA256 校验、本地安装；
  // 任一步失败都回退下面的官方 updater，保证更新不会被镜像问题卡死
  try {
    const fast = await installViaMirrorFast(onProgress)
    if (fast) return true
  } catch { /* 回退官方通道 */ }
  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await check()
    if (!update) return false
    let downloaded = 0
    let total = 0
    await update.downloadAndInstall((event) => {
      if (event.event === 'Started') {
        total = event.data.contentLength ?? 0
        onProgress?.({ downloaded: 0, total })
      } else if (event.event === 'Progress') {
        downloaded += event.data.chunkLength
        onProgress?.({ downloaded, total: total || undefined })
      }
    })
    return true
  } catch { return false }
}

/** 从 latest.json 解析本平台的镜像更新包（版本/相对路径/文件名）；无可用包返回 null */
async function resolveMirrorPackage(): Promise<{ version: string; notes?: string; path: string; fileName: string } | null> {
  const text = await fetchFastestText(LATEST_JSON_CANDIDATES)
  if (!text) return null
  const manifest = JSON.parse(text) as { version?: string; notes?: string; platforms?: Record<string, { url?: string }> }
  if (!manifest.version || !manifest.platforms) return null
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  const keys = /Mac/i.test(ua)
    ? ['darwin-aarch64', 'darwin-x86_64']
    : /Win/i.test(ua)
      ? ['windows-x86_64', 'windows-aarch64']
      : ['linux-x86_64', 'linux-aarch64']
  const key = keys.find(k => manifest.platforms?.[k]?.url)
  if (!key) return null
  const url = manifest.platforms[key].url as string
  const marker = `github.com/${REPO}/`
  const idx = url.indexOf(marker)
  if (idx < 0) return null
  const path = url.slice(idx + marker.length)
  const fileName = decodeURIComponent(path.split('/').pop() ?? '')
  if (!fileName) return null
  return { version: manifest.version.replace(/^v/i, ''), notes: manifest.notes, path, fileName }
}

/** 镜像快速更新：交给 Rust 测速下载+校验+安装 */
async function installViaMirrorFast(onProgress?: (p: InstallProgress) => void): Promise<boolean> {
  const pkg = await resolveMirrorPackage()
  if (!pkg) return false
  const { invoke, Channel } = await import('@tauri-apps/api/core')
  const channel = new Channel<number>()
  channel.onmessage = (downloaded: number) => onProgress?.({ downloaded })
  await invoke('update_fast_install', { path: pkg.path, fileName: pkg.fileName, onProgress: channel })
  return true
}

// ---- 待安装更新（v0.1.474 后台自动更新） ----
// 流程：启动静默检查 → 后台把包下载好 → 弹窗问「现在更新 / 稍后」；选稍后
// 则持久化待安装状态并布防 Rust 关窗闸门，用户下次关窗/退出时等任务结束
// 再安装。全部状态仅本机保存（localStorage），不进云同步。

const PENDING_KEY = 'acm.update.pending.v1'
const AUTO_KEY = 'acm.update.autoEnabled.v1'
const JUST_KEY = 'acm.update.justUpdated.v1'

export interface PendingUpdate {
  version: string
  notes?: string
  /** mirror = 安装包已落盘（filePath 跨进程存活）；plugin = 已下载对象只在内存里 */
  via: 'mirror' | 'plugin'
  filePath?: string
  fileName?: string
  downloadedAt: number
  /** 用户已选过「稍后」：关窗/退出时自动安装 */
  deferred: boolean
}

export function loadPendingUpdate(): PendingUpdate | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as PendingUpdate
    if (!p || typeof p.version !== 'string' || !versionGreater(p.version, APP_VERSION)) {
      // 损坏或版本不大于当前的待安装一律作废并清掉，防反复弹/装回旧版
      try { localStorage.removeItem(PENDING_KEY) } catch { /* 忽略 */ }
      return null
    }
    return p
  } catch { return null }
}

export function savePendingUpdate(p: PendingUpdate): void {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(p)) } catch { /* 忽略 */ }
}

export function clearPendingUpdate(): void {
  try { localStorage.removeItem(PENDING_KEY) } catch { /* 忽略 */ }
}

/** 「自动更新」开关：默认开，仅本机保存 */
export function loadAutoUpdateEnabled(): boolean {
  try { return localStorage.getItem(AUTO_KEY) !== '0' } catch { return true }
}

export function saveAutoUpdateEnabled(on: boolean): void {
  try { localStorage.setItem(AUTO_KEY, on ? '1' : '0') } catch { /* 忽略 */ }
}

/** 安装前落标记：安装会退出/重启进程，重启回来据此轻提示一次「已更新到 vX」 */
export function markJustUpdated(version: string): void {
  try { localStorage.setItem(JUST_KEY, version.replace(/^v/i, '')) } catch { /* 忽略 */ }
}

export function clearJustUpdated(): void {
  try { localStorage.removeItem(JUST_KEY) } catch { /* 忽略 */ }
}

/** 读并清除「刚更新完」标记：版本与当前一致才返回（只提示一次） */
export function consumeJustUpdated(): string | null {
  try {
    const v = localStorage.getItem(JUST_KEY)
    if (!v) return null
    localStorage.removeItem(JUST_KEY)
    return v.replace(/^v/i, '') === APP_VERSION ? v.replace(/^v/i, '') : null
  } catch { return null }
}

/** 官方 updater 已下载待安装对象（内存态，进程重启即失） */
let pluginPendingUpdate: import('@tauri-apps/plugin-updater').Update | null = null

/**
 * 后台下载更新包（不安装）：优先镜像通道（落盘、可跨进程）；镜像不可用时
 * 回退官方 updater 的 download()（只下载、对象留内存）。成功后待安装状态
 * 已持久化并返回；无更新/失败返回 null。
 */
export async function downloadUpdateInBackground(onProgress?: (p: InstallProgress) => void): Promise<PendingUpdate | null> {
  try {
    const pkg = await resolveMirrorPackage()
    if (pkg && versionGreater(pkg.version, APP_VERSION)) {
      const { invoke, Channel } = await import('@tauri-apps/api/core')
      const channel = new Channel<number>()
      channel.onmessage = (downloaded: number) => onProgress?.({ downloaded })
      const filePath = await invoke<string>('update_fast_download', { path: pkg.path, fileName: pkg.fileName, onProgress: channel })
      const p: PendingUpdate = {
        version: pkg.version, notes: pkg.notes, via: 'mirror',
        filePath, fileName: pkg.fileName, downloadedAt: Date.now(), deferred: false,
      }
      savePendingUpdate(p)
      return p
    }
  } catch { /* 镜像不可用 → 回退官方通道 */ }
  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await withTimeout(check(), PLUGIN_CHECK_ATTEMPT_MS)
    if (!update) return null
    let downloaded = 0
    let total = 0
    await update.download((event) => {
      if (event.event === 'Started') {
        total = event.data.contentLength ?? 0
        onProgress?.({ downloaded: 0, total })
      } else if (event.event === 'Progress') {
        downloaded += event.data.chunkLength
        onProgress?.({ downloaded, total: total || undefined })
      }
    })
    pluginPendingUpdate = update
    const p: PendingUpdate = {
      version: update.version, notes: update.body, via: 'plugin',
      downloadedAt: Date.now(), deferred: false,
    }
    savePendingUpdate(p)
    return p
  } catch { return null }
}

/**
 * 安装一份待安装更新并重启进新版。镜像包走 Rust 装已落盘文件（macOS/
 * Windows 安装器自带重启）；官方通道走内存对象的 install() + relaunch。
 * 已下载对象丢失（进程重启过）时整段重走「检查+下载+安装」。失败返回
 * false 且保留待安装状态，不静默吞掉（调用方负责报错）。
 */
export async function installPendingUpdate(p: PendingUpdate): Promise<boolean> {
  markJustUpdated(p.version)
  try {
    if (p.via === 'mirror' && p.filePath && p.fileName) {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('update_install_downloaded', { filePath: p.filePath, fileName: p.fileName })
      clearPendingUpdate()
      return true
    }
    if (p.via === 'plugin' && pluginPendingUpdate) {
      await pluginPendingUpdate.install()
      pluginPendingUpdate = null
      clearPendingUpdate()
      await relaunchApp()
      return true
    }
  } catch { /* 已下载对象不可用 → 整段重走 */ }
  const ok = await installDesktopUpdate()
  if (ok) {
    clearPendingUpdate()
    await relaunchApp()
    return true
  }
  clearJustUpdated()
  return false
}

/** 桌面端：重启应用以启用新版本 */
export async function relaunchApp(): Promise<void> {
  try {
    const { relaunch } = await import('@tauri-apps/plugin-process')
    await relaunch()
  } catch { /* 不支持时忽略，用户可手动重启 */ }
}

/** Docker 更新指令：拉新镜像 → 停旧容器 → 删旧容器 → 起新实例（数据卷保留） */
export function dockerUpdateCommands(): string {
  return [
    '# 更新 AI 魔方 Docker 实例（保留数据卷）',
    'docker pull Andre-xue/ai-credit-manager:latest',
    'docker stop ai-credit-manager 2>/dev/null || true',
    'docker rm ai-credit-manager 2>/dev/null || true',
    'docker run -d --name ai-credit-manager -p 8080:80 -v ai-credit-data:/data --restart unless-stopped Andre-xue/ai-credit-manager:latest',
    '# 完成后刷新本页即可使用新版本',
  ].join('\n')
}

/** 获取最新 APK 下载地址 */
export async function latestApkUrl(): Promise<string | null> {
  // 同样优先 latest.json（不限流、多源竞速），拿到版本号后拼固定资产直链
  try {
    const text = await fetchFastestText(LATEST_JSON_CANDIDATES)
    if (text) {
      const parsed = parseLatestJson(text)
      if (parsed) return apkUrlForVersion(parsed.version)
    }
  } catch { /* 回退 API */ }
  try {
    const rel = JSON.parse(await fetchUrlText(RELEASES_API)) as GitHubRelease
    const apk = rel.assets?.find(a => /\.apk$/i.test(a.name))
    return apk?.browser_download_url ?? RELEASES_PAGE
  } catch { return null }
}

// ---- 微信小程序更新 ----
type WxLike = {
  getUpdateManager?: () => {
    onCheckForUpdate: (cb: (r: { hasUpdate: boolean }) => void) => void
    onUpdateReady: (cb: () => void) => void
    onUpdateFailed: (cb: () => void) => void
    applyUpdate: () => void
  }
  showModal?: (o: Record<string, unknown>) => void
}
declare const wx: WxLike | undefined

/**
 * 小程序：启动时自动检查更新，下载完成后弹窗询问是否重启应用新版本。
 * 平台托管机制：只能更新已发布到微信后台的版本，无法自定义下载安装包。
 */
export function initMiniappUpdate(notify: (m: string) => void): void {
  if (typeof wx === 'undefined' || typeof wx.getUpdateManager !== 'function') return
  try {
    const um = wx.getUpdateManager()
    um.onCheckForUpdate(res => {
      if (res.hasUpdate) notify('发现新版本，正在后台下载…')
    })
    um.onUpdateReady(() => {
      const w = wx as WxLike
      if (w.showModal) {
        w.showModal({
          title: '更新提示',
          content: '新版本已下载完成，重启后即可使用。是否立即重启？',
          confirmText: '立即重启',
          cancelText: '稍后',
          success: (r: { confirm: boolean }) => { if (r.confirm) um.applyUpdate() },
        })
      } else {
        notify('新版本已就绪，请重启小程序')
      }
    })
    um.onUpdateFailed(() => notify('新版本下载失败，请检查网络后重试'))
  } catch { /* 非小程序环境忽略 */ }
}

/** 手动触发小程序更新检查（设置页按钮） */
export function checkMiniappUpdate(notify: (m: string) => void): void {
  initMiniappUpdate(notify)
  notify('已触发更新检查，如有新版本将自动下载')
}
