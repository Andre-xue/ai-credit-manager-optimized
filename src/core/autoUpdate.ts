// 后台自动更新状态机（v0.1.474，仅桌面端；v0.1.495 起「静默更新」新口径；
// v0.1.498 补静默接管与运行期复查）：
// 启动延迟静默检查 → 后台把安装包下载好 → 静默更新开启时等空闲（appBusy）
// 自动安装并重启（scheduleSilentAutoInstall），弹窗同时给出「现在更新 /
// 稍后」供手动介入；关闭静默更新则只弹窗等用户点。选稍后则布防 Rust 关窗
// 闸门（update_close_arm），用户下次关窗（隐藏进托盘也算）或退出时，Rust
// 广播 update-close-requested，本模块等进行中的任务（邮件删除/同步、签到、
// 图库索引等，见 appBusy）结束后再安装，不硬打断。闸门也是静默自动装等
// 不到空闲时的兜底。状态经 subscribe 供侧边栏入口与弹窗渲染；持久化在 updater.ts。
// v0.1.498：手动打开弹窗/手动检查发现新版同样被静默接管（takeoverUpdate
// Discovery）；运行期间每 2 小时复查一次；下载双通道卡死有看门狗兜底、
// 失败落 dlError 态带人话原因与重试，全链关键事件记 update diag 日志。
// v0.1.503（真机「已下载好点现在更新没反应」二修）：① 待安装记录以内存
// 副本为第一来源——旧实现安装入口全靠从 localStorage 重读，持久化副本
// 一旦读不回来（写入被配额吞掉/被作废），界面照常显示「已下载好」但点
// 击死在重读处：无状态变化、无报错、diag 全空白（2026-11-27 录屏+日志
// 实证）。② 「现在更新」定案回归：立即安装、不等忙碌（忙碌等待只留给
// 自动安装与关窗闸门两条路径）。③ 每次安装请求与每种被挡结局都记 diag
// （install-requested / install-blocked / busy-expired），杜绝无声失败。
// ④ 自动路径等忙碌时把「在等什么」写进状态供界面明示，不再沉默干等。
import { isDesktopApp } from './openExternal'
import {
  checkDesktopUpdate, loadAutoUpdateEnabled, loadPendingUpdate, savePendingUpdate,
  downloadUpdateInBackground, installPendingUpdate, consumeJustUpdated,
  onSilentUpdatePrefChange, updateDiag, getLastInstallError,
  type PendingUpdate,
} from './updater'
import { shouldPeriodicRecheck } from './updateStall'
import { isAppBusy, appBusyEntries, pruneStaleBusy, busyKeyLabel } from './appBusy'

export type AutoUpdateUiState =
  | { kind: 'idle' }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; version: string; downloaded: number; total?: number; since?: number }
  | { kind: 'ready'; version: string; promptOpen: boolean }
  | { kind: 'deferred'; version: string }
  | { kind: 'installing'; version: string; waitingBusy: boolean; waitingFor?: string[] }
  | { kind: 'dlError'; version: string; message: string }

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
/** 上次静默检查时刻（启动检查与运行期复查共用，复查间隔据此判定） */
let lastCheckAt = 0

// ---- 待安装记录：内存副本第一来源（v0.1.503） ----
// 下载完成时状态机手里就有这份对象，先存内存再落盘持久化；安装入口一律
// 走 currentPending()（内存优先、落盘兜底），不再出现「界面显示已下载
// 好、手里这份却被弃之不用、非要重读落盘副本」的中空环节。
let pendingMem: PendingUpdate | null = null

function currentPending(): PendingUpdate | null {
  const want = (uiState as { version?: string }).version
  if (pendingMem && (!want || pendingMem.version === want)) return pendingMem
  const p = loadPendingUpdate()
  if (p && (!want || p.version === want)) { pendingMem = p; return p }
  return null
}

function rememberPending(p: PendingUpdate | null): void {
  pendingMem = p
}

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<T>(cmd, args)
  } catch { return null }
}

const armClose = (armed: boolean) => tauriInvoke('update_close_arm', { armed })
const proceedClose = (action: string) => tauriInvoke('update_close_proceed', { action })

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** 当前忙碌来源的人话名列表（等待提示与 diag 用） */
function busyLabels(): string[] {
  return appBusyEntries().map(e => busyKeyLabel(e.key))
}

/** 回收泄漏的忙碌登记并逐条记 diag（防泄漏兜底，见 appBusy 的 TTL） */
function pruneBusyWithDiag(): void {
  for (const key of pruneStaleBusy()) updateDiag('busy-expired', `key=${key}`)
}

export type InstallSource = 'modal-now' | 'auto-idle' | 'gate-close' | 'menu'
type InstallMode = 'now' | 'wait'

/**
 * 执行安装（v0.1.503 分模式）：
 * - mode 'now'（用户点「现在更新」）：立即安装，不等忙碌——这是用户明确
 *   拍板（2026-11-26 定案「现在就是立即重启」）；旧实现与自动路径共用
 *   等忙碌逻辑，点击后最长 10 分钟看似没反应。
 * - mode 'wait'（静默自动安装 / 关窗闸门）：等忙碌结束再装，最长 10 分
 *   钟；等待期间状态带 waitingFor 明示在等什么，等不到回落 deferred。
 * 每种结局都记 diag：install-requested / install-blocked(reason) / 后续
 * install-start、install-done、install-fail 由 installPendingUpdate 与
 * Rust 侧续记。
 */
async function runInstall(p: PendingUpdate, mode: InstallMode, source: InstallSource): Promise<boolean> {
  updateDiag('install-requested', `source=${source} version=${p.version} mode=${mode}`)
  if (installing) {
    updateDiag('install-blocked', `reason=already-installing version=${p.version}`)
    return false
  }
  installing = true
  if (mode === 'wait') {
    pruneBusyWithDiag()
    if (isAppBusy()) {
      setUiState({ kind: 'installing', version: p.version, waitingBusy: true, waitingFor: busyLabels() })
      const deadline = Date.now() + 10 * 60_000
      while (isAppBusy()) {
        if (Date.now() >= deadline) {
          updateDiag('install-blocked', `reason=busy-timeout version=${p.version} waiting=${busyLabels().join(',')}`)
          installing = false
          setUiState({ kind: 'deferred', version: p.version })
          return false
        }
        await sleep(1500)
        pruneBusyWithDiag()
        if (isAppBusy()) setUiState({ kind: 'installing', version: p.version, waitingBusy: true, waitingFor: busyLabels() })
      }
    }
  }
  setUiState({ kind: 'installing', version: p.version, waitingBusy: false })
  const ok = await installPendingUpdate(p)
  installing = false
  if (ok) rememberPending(null)
  else setUiState({ kind: 'ready', version: p.version, promptOpen: false })
  return ok
}

/**
 * 待安装记录彻底丢失时的收尾（v0.1.503）：界面还停在「已下载好」但内存
 * 与落盘两份都读不回来——不许再像旧版那样静默 return：记 diag、给用户
 * 人话提示，并对已知版本自动重新下载一份（包还在服务器上，重下即恢复）。
 */
function onPendingMissing(source: InstallSource): void {
  const version = (uiState as { version?: string }).version ?? ''
  updateDiag('install-blocked', `reason=pending-missing source=${source} state=${uiState.kind} version=${version}`)
  if (version) {
    notifyFn('更新包记录异常，正在重新下载，请稍候', 'err')
    void startBackgroundDownload(version)
  } else {
    notifyFn('没有可安装的更新包，请先检查更新', 'err')
  }
}

/** 弹窗「现在更新」：立即安装并重启，不等忙碌任务（定案口径） */
export async function installDownloadedNow(): Promise<void> {
  if (uiState.kind === 'installing') {
    updateDiag('install-blocked', 'reason=already-installing source=modal-now')
    return
  }
  const p = currentPending()
  if (!p) { onPendingMissing('modal-now'); return }
  const ok = await runInstall(p, 'now', 'modal-now')
  if (!ok) {
    const reason = getLastInstallError()
    notifyFn(reason ? `更新安装失败：${reason}` : '更新安装失败，请稍后重试', 'err')
    setUiState({ kind: 'ready', version: p.version, promptOpen: true })
  }
}

/** 弹窗「稍后」：持久化待安装并布防关窗闸门，下次关窗/退出时自动安装 */
export async function deferDownloadedInstall(): Promise<void> {
  const p = currentPending()
  if (!p) { onPendingMissing('modal-now'); return }
  p.deferred = true
  rememberPending(p)
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

let silentInstallToken = 0

/** 静默更新开启时（v0.1.495 新口径，覆盖 474 的「只下载等询问」）：下载就绪后
    先布防关窗闸门兜底，再等空闲自动安装并重启——runInstall 的 wait 模式
    复用 appBusy 等空闲、最长 10 分钟，等不到回落 deferred 由闸门在关窗
    时兜底。用户点「稍后」/关掉静默更新/本轮已被接管时取消自动装（token
    + 状态双重校验）。 */
function scheduleSilentAutoInstall(version: string): void {
  if (!loadAutoUpdateEnabled()) return
  const token = ++silentInstallToken
  void armClose(true)
  void (async () => {
    // 留 3 秒让「已下载好」状态先被看到，随后安装遮罩会接管界面
    await sleep(3000)
    if (token !== silentInstallToken) return
    const s = uiState
    if (s.kind !== 'ready' || s.version !== version) return
    if (!loadAutoUpdateEnabled()) return
    const p = currentPending()
    if (!p) { onPendingMissing('auto-idle'); return }
    const ok = await runInstall(p, 'wait', 'auto-idle')
    // 等不到空闲回落 deferred 是设计内兜底（关窗闸门接手），不算失败不弹错；
    // 真失败时 runInstall 已把状态打回 ready，据此才提示。
    if (!ok && uiState.kind === 'ready') notifyFn('更新安装失败，请稍后重试', 'err')
  })()
}

/** Rust 关窗闸门广播：有待安装更新（选过「稍后」，或静默更新开启等空闲兜底）时，等任务结束装上再放行 */
async function onCloseRequested(action: 'hide' | 'exit'): Promise<void> {
  const p = currentPending()
  if (!p || installing || (!p.deferred && !loadAutoUpdateEnabled())) {
    await proceedClose(action)
    return
  }
  if (isAppBusy()) notifyFn('等待当前任务完成，随后自动安装更新…')
  const ok = await runInstall(p, 'wait', 'gate-close')
  if (!ok) {
    notifyFn('更新安装失败，已保留下载好的安装包，下次启动会再次提示', 'err')
    await proceedClose(action)
  }
  // 成功时安装器已接管进程（退出/重启），不再放行原关窗动作
}

/**
 * 后台下载一段已发现的新版（v0.1.498 抽出）：启动检查、运行期复查、手动
 * 发现接管、失败重试共用同一条链。下载全程状态机驱动悬浮卡/弹窗呈现；
 * 双通道都失败时落 dlError 态（人话原因 + 重试），不再静默吞掉。
 */
async function startBackgroundDownload(version: string): Promise<void> {
  if (uiState.kind === 'downloading' || uiState.kind === 'installing') return
  const since = Date.now()
  setUiState({ kind: 'downloading', version, downloaded: 0, since })
  const { pending, error } = await downloadUpdateInBackground(pr => {
    if (uiState.kind === 'downloading') {
      setUiState({ kind: 'downloading', version, downloaded: pr.downloaded, total: pr.total, since })
    }
  })
  if (!pending) {
    updateDiag('download-fail', `version=${version} surfaced=1`)
    setUiState({ kind: 'dlError', version, message: error || '下载失败，请检查网络后重试' })
    return
  }
  rememberPending(pending)
  setUiState({ kind: 'ready', version: pending.version, promptOpen: true })
  scheduleSilentAutoInstall(pending.version)
}

async function silentCheckAndDownload(): Promise<void> {
  if (uiState.kind !== 'idle') return
  lastCheckAt = Date.now()
  let version = ''
  try {
    const u = await checkDesktopUpdate()
    if (u.upToDate) return
    version = u.version
  } catch { return }
  if (!version) return
  await startBackgroundDownload(version)
}

/**
 * 静默接管（v0.1.498）：手动途径（打开更新弹窗/点检查更新）发现新版时，
 * 只要静默更新开着就立即接管进后台下载链——旧版弹窗只点亮红点、仍摆手动
 * 按钮等用户点，是 2026-11-27 真机「静默没生效」的实处。静默关时维持旧
 * 行为（只点亮红点，手动流程在弹窗里走）。
 */
export function takeoverUpdateDiscovery(version: string): void {
  if (!version) return
  if (!loadAutoUpdateEnabled()) { noteManualUpdateFound(version); return }
  if (uiState.kind === 'idle' || uiState.kind === 'available' || uiState.kind === 'dlError') {
    updateDiag('takeover', `version=${version} from=manual`)
    void startBackgroundDownload(version)
  }
}

/** 下载失败卡上的「重试」：对同一版本重走后台下载链 */
export function retryBackgroundDownload(): void {
  if (uiState.kind !== 'dlError') return
  const { version } = uiState
  updateDiag('download-retry', `version=${version}`)
  void startBackgroundDownload(version)
}

/** 关掉下载失败卡：回落到红点态，点开弹窗仍可走手动/接管流程 */
export function dismissDownloadError(): void {
  if (uiState.kind === 'dlError') setUiState({ kind: 'available', version: uiState.version })
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
  // 运行期定时复查（v0.1.498）：静默开时每 2 小时静默查一次新版——旧版只在
  // 启动时查一次，App 长开期间发布的新版永远等不到，是真机「静默没生效」
  // 的另一半原因。决策走纯函数 shouldPeriodicRecheck，复查不弹窗不打扰。
  window.setInterval(() => {
    if (shouldPeriodicRecheck({
      enabled: loadAutoUpdateEnabled(),
      stateKind: uiState.kind,
      hasPending: !!currentPending(),
      now: Date.now(),
      lastCheckAt,
    })) {
      updateDiag('recheck', 'periodic=1')
      void silentCheckAndDownload()
    }
  }, 60_000)
  // 静默开关从关→开时若已有手动发现的新版（红点态），立即接管下载
  onSilentUpdatePrefChange(on => {
    if (on && uiState.kind === 'available') {
      updateDiag('takeover', `version=${uiState.version} from=pref-on`)
      void startBackgroundDownload(uiState.version)
    }
  })
  const pending = loadPendingUpdate()
  if (pending) {
    rememberPending(pending)
    // 上次已下载好但没装成（进程被强杀等）：直接再弹窗询问；曾选过「稍后」的重新布防
    if (pending.deferred) void armClose(true)
    setUiState({ kind: 'ready', version: pending.version, promptOpen: true })
    // 没表态过的待安装 + 静默更新开启：接回空闲自动安装链；选过「稍后」的尊重其选择，不自动装
    if (!pending.deferred) scheduleSilentAutoInstall(pending.version)
    return
  }
  if (!loadAutoUpdateEnabled()) return
  lastCheckAt = Date.now()
  window.setTimeout(() => { void silentCheckAndDownload() }, 6000)
}
