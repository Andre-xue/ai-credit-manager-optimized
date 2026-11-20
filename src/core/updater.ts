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
  try {
    const res = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } })
    if (!res.ok) return {
      ...base,
      error: res.status === 403
        ? 'GitHub 接口触发访问频率限制，请稍后再试（网络正常也会出现）'
        : `GitHub 接口返回 ${res.status}`,
    }
    const rel = await res.json() as GitHubRelease
    const latest = rel.tag_name?.replace(/^v/i, '') ?? ''
    if (!latest) return { ...base, error: 'GitHub 未返回版本号' }

    // 桌面端：最新版如果还没有桌面包，往前找最近一个完整版本
    if (requireDesktopInstaller && !hasDesktopInstallers(rel)) {
      const listRes = await fetch(RELEASES_LIST_API, { headers: { Accept: 'application/vnd.github+json' } })
      if (listRes.ok) {
        const list = await listRes.json() as GitHubRelease[]
        const usable = list.find(r => !r.draft && !r.prerelease && hasDesktopInstallers(r))
        if (usable) return toInfo(usable, true)
      }
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

/** 桌面端：用 Tauri updater 检查。网络抖动时自动重试一次。返回 { update, error } */
export async function checkDesktopUpdate(): Promise<{
  version: string; currentVersion: string; body?: string; error?: string
} | null> {
  let lastErr = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { check } = await import('@tauri-apps/plugin-updater')
      const update = await check()
      if (!update) return null
      return { version: update.version, currentVersion: update.currentVersion, body: update.body }
    } catch (e) {
      lastErr = friendlyUpdateError(e)
      if (attempt === 0) await new Promise(r => setTimeout(r, 1500)) // 网络抖动重试
    }
  }
  return { version: '', currentVersion: APP_VERSION, error: lastErr }
}

export interface InstallProgress { downloaded: number }

/** 桌面端：下载并安装更新。macOS/Linux 安装后需调用 relaunchApp() */
export async function installDesktopUpdate(onProgress?: (p: InstallProgress) => void): Promise<boolean> {
  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await check()
    if (!update) return false
    let downloaded = 0
    await update.downloadAndInstall((event) => {
      if (event.event === 'Progress') {
        downloaded += event.data.chunkLength
        onProgress?.({ downloaded })
      }
    })
    return true
  } catch { return false }
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
    '# 更新 AI 积分管家 Docker 实例（保留数据卷）',
    'docker pull Andre-xue/ai-credit-manager:latest',
    'docker stop ai-credit-manager 2>/dev/null || true',
    'docker rm ai-credit-manager 2>/dev/null || true',
    'docker run -d --name ai-credit-manager -p 8080:80 -v ai-credit-data:/data --restart unless-stopped Andre-xue/ai-credit-manager:latest',
    '# 完成后刷新本页即可使用新版本',
  ].join('\n')
}

/** 获取最新 APK 下载地址 */
export async function latestApkUrl(): Promise<string | null> {
  try {
    const res = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } })
    if (!res.ok) return null
    const rel = await res.json() as GitHubRelease
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
