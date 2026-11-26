// 后台自动更新状态机（v0.1.474，仅桌面端）：
// 启动延迟静默检查 → 后台把安装包下载好 → 弹窗问「现在更新 / 稍后」；
// 选稍后则布防 Rust 关窗闸门（update_close_arm），用户下次关窗（隐藏进
// 托盘也算）或退出时，Rust 广播 update-close-requested，本模块等进行中的
// 任务（邮件删除/同步、签到、图库索引等，见 appBusy）结束后再安装，
// 不硬打断。状态经 subscribe 供侧边栏入口与弹窗渲染；持久化在 updater.ts。
import { isDesktopApp } from './openExternal'
import {
  checkDesktopUpdate, loadAutoUpdateEnabled, loadPendingUpdate, savePendingUpdate,
  downloadUpdateInBackground, installPendingUpdate, consumeJustUpdated,
  type PendingUpdate,
} from './updater'
import { isAppBusy } from './appBusy'

export type AutoUpdateUiState =
  | { kind: 'idle' }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; version: string; downloaded: number; total?: number }
  | { kind: 'ready'; version: string; promptOpen: boolean }
  | { kind: 'deferred'; version: string }
  | { kind: 'installing'; version: string; waitingBusy: boolean }

let uiState: AutoUpdateUiState = { kind: 'idle' }
const listeners = new Set<() => void>()

function setUiState(s: AutoUpdateUiState): void {
  uiState = s
  for (const fn of [...listeners]) { try { fn() } catch { /* 监听者自理 */ } }
}

export function getAutoUpdateUiState(): AutoUpdateUiState {
  return uiState
}

export function subscribeAutoUpdate(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** 手动检查（更新弹窗）发现新版时点亮侧边栏红点；已是最新时熄灭 */
export function noteManualUpdateFound(version: string): void {
  if (uiState.kind === 'idle' && version) setUiState({ kind: 'available', version })
}

export function noteManualUpToDate(): void {
  if (uiState.kind === 'available') setUiState({ kind: 'idle' })
}

let notifyFn: (msg: string, kind?: 'ok' | 'err') => void = () => {}
let initialized = false
let installing = false

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<T>(cmd, args)
  } catch { return null }
}

const armClose = (armed: boolean) => tauriInvoke('update_close_arm', { armed })
const proceedClose = (action: string) => tauriInvoke('update_close_proceed', { action })

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** 执行安装：先等忙碌任务结束（最长 10 分钟），再装待安装更新并重启 */
async function runInstall(p: PendingUpdate): Promise<boolean> {
  if (installing) return false
  installing = true
  setUiState({ kind: 'installing', version: p.version, waitingBusy: isAppBusy() })
  const deadline = Date.now() + 10 * 60_000
  while (isAppBusy()) {
    if (Date.now() >= deadline) {
      installing = false
      setUiState({ kind: 'deferred', version: p.version })
      return false
    }
    await sleep(1500)
    setUiState({ kind: 'installing', version: p.version, waitingBusy: true })
  }
  setUiState({ kind: 'installing', version: p.version, waitingBusy: false })
  const ok = await installPendingUpdate(p)
  installing = false
  if (!ok) setUiState({ kind: 'ready', version: p.version, promptOpen: false })
  return ok
}

/** 弹窗「现在更新」 */
export async function installDownloadedNow(): Promise<void> {
  const p = loadPendingUpdate()
  if (!p) return
  const ok = await runInstall(p)
  if (!ok) {
    notifyFn('更新安装失败，请稍后重试', 'err')
    setUiState({ kind: 'ready', version: p.version, promptOpen: true })
  }
}

/** 弹窗「稍后」：持久化待安装并布防关窗闸门，下次关窗/退出时自动安装 */
export async function deferDownloadedInstall(): Promise<void> {
  const p = loadPendingUpdate()
  if (!p) return
  p.deferred = true
  savePendingUpdate(p)
  await armClose(true)
  setUiState({ kind: 'deferred', version: p.version })
  notifyFn('将在关闭窗口时自动安装更新')
}

/** 侧边栏入口点开待安装提示弹窗（ready/deferred 状态） */
export function reopenUpdatePrompt(): void {
  if (uiState.kind === 'ready') setUiState({ ...uiState, promptOpen: true })
  else if (uiState.kind === 'deferred') setUiState({ kind: 'ready', version: uiState.version, promptOpen: true })
}

/** 只关弹窗不表态（不等同于「稍后」：不布防关窗安装） */
export function dismissUpdatePrompt(): void {
  if (uiState.kind === 'ready') setUiState({ ...uiState, promptOpen: false })
}

/** Rust 关窗闸门广播：有关待安装的「稍后」更新时，等任务结束装上再放行 */
async function onCloseRequested(action: 'hide' | 'exit'): Promise<void> {
  const p = loadPendingUpdate()
  if (!p || !p.deferred || installing) {
    await proceedClose(action)
    return
  }
  if (isAppBusy()) notifyFn('等待当前任务完成，随后自动安装更新…')
  const ok = await runInstall(p)
  if (!ok) {
    notifyFn('更新安装失败，已保留下载好的安装包，下次启动会再次提示', 'err')
    await proceedClose(action)
  }
  // 成功时安装器已接管进程（退出/重启），不再放行原关窗动作
}

async function silentCheckAndDownload(): Promise<void> {
  if (uiState.kind !== 'idle') return
  let version = ''
  try {
    const u = await checkDesktopUpdate()
    if (u.upToDate) return
    version = u.version
  } catch { return }
  if (!version) return
  setUiState({ kind: 'downloading', version, downloaded: 0 })
  const p = await downloadUpdateInBackground(pr => {
    setUiState({ kind: 'downloading', version, downloaded: pr.downloaded, total: pr.total })
  })
  if (!p) {
    // 下载失败不打扰用户：只在侧边栏留红点，点开可走手动流程
    setUiState({ kind: 'available', version })
    return
  }
  setUiState({ kind: 'ready', version: p.version, promptOpen: true })
}

/** App 主窗口挂载时调用一次（桌面端）：刚更新提示、待安装恢复、启动静默检查、关窗闸门监听 */
export function initAutoUpdate(opts: { notify: (msg: string, kind?: 'ok' | 'err') => void }): void {
  if (initialized || !isDesktopApp()) return
  initialized = true
  notifyFn = opts.notify
  const just = consumeJustUpdated()
  if (just) notifyFn(`已更新到 v${just}`)
  void (async () => {
    try {
      const { listen } = await import('@tauri-apps/api/event')
      await listen<string>('update-close-requested', e => {
        void onCloseRequested(e.payload === 'exit' ? 'exit' : 'hide')
      })
    } catch { /* 非 Tauri 环境忽略 */ }
  })()
  const pending = loadPendingUpdate()
  if (pending) {
    // 上次已下载好但没装成（进程被强杀等）：直接再弹窗询问；曾选过「稍后」的重新布防
    if (pending.deferred) void armClose(true)
    setUiState({ kind: 'ready', version: pending.version, promptOpen: true })
    return
  }
  if (!loadAutoUpdateEnabled()) return
  window.setTimeout(() => { void silentCheckAndDownload() }, 6000)
}
