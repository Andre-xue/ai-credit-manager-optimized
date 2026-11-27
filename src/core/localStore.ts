// 本机关键数据文件存储（v0.1.510）
// 背景：Agent 工作台的设置/任务/账本与静默更新开关等关键本机数据原存 WebView
// localStorage，App 更新换包时这块存储被重置（2026-11-27 实报：507 上开过的
// Agent 开关装 508 后全关、任务记录消失）。桌面端改以实体文件为事实源：
// ~/.ai-credit-manager/local-store/*.json（Rust local_store_read/write，
// 更新只换 .app 包、动不到）；localStorage 退为镜像——每次写同步镜像、
// 启动 hydrate 时文件覆盖镜像。非桌面端（网页/安卓）无文件层，行为不变。
import { isDesktopApp } from './openExternal'

export type LocalStoreName = 'agents-settings' | 'agents-tasks' | 'agents-ledger' | 'agents-vault-prune-log'

const STORE_KEY: Record<LocalStoreName, string> = {
  'agents-settings': 'acm.agents.settings.v1',
  'agents-tasks': 'acm.agents.tasks.v1',
  'agents-ledger': 'acm.agents.ledger.v1',
  'agents-vault-prune-log': 'acm.agents.vaultPruneLog.v1',
}

/**
 * prefs 文件收纳的本机偏好键（仅本机、更新丢了要重设的开关/模式/更新状态类）。
 * 清单口径：开关类 + 更新偏好类 + 仅本机定版的模式类；不扩散到全部 acm.* 键。
 * 各键的日常读写仍走原 helper（读 localStorage），hydrate 负责文件↔镜像对账，
 * 写点经 writePref 同步落盘。
 */
export const PREFS_KEYS = [
  'acm.update.autoEnabled.v1', // 静默更新开关（本版点名必入）
  'acm.update.pending.v1', // 待安装更新状态（更新链关键状态）
  'acm.update.justUpdated.v1', // 「已更新到 vX」一次性标记
  'acm.vault.keepUnlocked.v1', // 在这台设备上保持解锁
  'acm.checkin.auto.v1', // 自动签到开关
  'acm.comfyui.scanDesktop', // ComfyUI 扫描覆盖 Desktop（仅本机）
  'acm.comfyui.launchDesktop', // ComfyUI 拉起 Desktop（仅本机）
  'acm.moma.freeOnly.v1', // MoMA 只显示免费通道（仅本机）
  'acm.watch.showAdult.v1', // 18+ 页签显隐（仅本机）
  'acm.freeChain.mode.v1', // 免费路线模式（自动/锁定）
  'acm.lang', // 界面语言（仅本机定版）
] as const

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

function invokeFn(): InvokeFn | null {
  if (!isDesktopApp()) return null
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke?: InvokeFn } }
  return w.__TAURI_INTERNALS__?.invoke ?? null
}

const cache = new Map<LocalStoreName, string | null>()
let hydrated = false
let hydratePromise: Promise<void> | null = null
const listeners = new Set<() => void>()

export function isLocalStoreHydrated(): boolean { return hydrated }

/** hydrate 完成后回调（已完成则立即回调）；返回取消订阅函数 */
export function onLocalStoreHydrated(fn: () => void): () => void {
  if (hydrated) { fn(); return () => { /* 已执行 */ } }
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function lsGet(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function lsSet(key: string, v: string): void {
  try { localStorage.setItem(key, v) } catch { /* 镜像写不下不阻断，文件为准 */ }
}
function lsDel(key: string): void {
  try { localStorage.removeItem(key) } catch { /* ignore */ }
}

/** 读一份数据：hydrate 后以文件缓存为准；hydrate 前先读 localStorage 镜像兜底（首屏不空等） */
export function readLocalStore(name: LocalStoreName): string | null {
  if (cache.has(name)) return cache.get(name) ?? null
  return lsGet(STORE_KEY[name])
}

/**
 * 写一份数据：更新缓存 + localStorage 镜像 + 桌面端落文件。
 * hydrate 完成前不动文件（防首屏旧镜像覆盖文件里的新数据），hydrate 时统一对账。
 * 落盘失败只留 console 痕：内存缓存与镜像仍在，本次运行不丢，下次启动再对账。
 */
export function writeLocalStore(name: LocalStoreName, content: string): void {
  cache.set(name, content)
  lsSet(STORE_KEY[name], content)
  if (!hydrated) return
  const inv = invokeFn()
  if (!inv) return
  inv('local_store_write', { name, content }).catch(e => {
    console.warn(`[localStore] ${name} 落盘失败（本次运行靠内存与本地镜像，重启后可能回退）`, e)
  })
}

/**
 * prefs 读：直接读 localStorage 镜像——同运行期内它就是共享真值（主窗/迷你窗
 * 共用同一份 localStorage），hydrate 已在启动时把文件值对账进来。不另设内存
 * 缓存：缓存与镜像一旦分叉（如外部清存储），读到的就是错值（v0.1.510 单测实证）。
 */
export function readPref(key: string): string | null {
  return lsGet(key)
}

/** prefs 写（value=null 表示删除）：同步 localStorage 镜像，hydrate 后整表落文件 */
export function writePref(key: string, value: string | null): void {
  if (!(PREFS_KEYS as readonly string[]).includes(key)) return
  if (value == null) lsDel(key); else lsSet(key, value)
  persistPrefs()
}

function persistPrefs(): void {
  if (!hydrated) return
  const inv = invokeFn()
  if (!inv) return
  const obj: Record<string, string> = {}
  for (const k of PREFS_KEYS) {
    const v = lsGet(k)
    if (v != null) obj[k] = v
  }
  inv('local_store_write', { name: 'prefs', content: JSON.stringify(obj) }).catch(e => {
    console.warn('[localStore] prefs 落盘失败（本次运行靠本地镜像，重启后可能回退）', e)
  })
}

/**
 * 启动时调用一次（App 挂载）：把文件事实源对账进缓存与 localStorage 镜像。
 * 口径：文件有 → 文件赢（覆盖镜像）；文件无 → localStorage 旧值一次性迁移落盘；
 * 文件读失败/损坏 → 回落 localStorage 镜像并留痕，绝不静默丢数据、不崩。
 * 完成后通知订阅者（Agent 工作台据此重读三份数据，首屏镜像与文件不一致时纠正）。
 */
export function hydrateLocalStore(): Promise<void> {
  if (hydratePromise) return hydratePromise
  hydratePromise = (async () => {
    const inv = invokeFn()
    if (inv) {
      for (const name of Object.keys(STORE_KEY) as LocalStoreName[]) {
        const key = STORE_KEY[name]
        try {
          const content = await inv<string | null>('local_store_read', { name })
          if (content != null) {
            cache.set(name, content)
            lsSet(key, content)
          } else {
            const legacy = lsGet(key)
            if (legacy != null) {
              cache.set(name, legacy)
              try { await inv('local_store_write', { name, content: legacy }) }
              catch (e) { console.warn(`[localStore] ${name} 旧值迁移落盘失败`, e) }
            } else {
              cache.set(name, null)
            }
          }
        } catch (e) {
          console.warn(`[localStore] ${name} 文件读取失败，回落本地镜像`, e)
          cache.set(name, lsGet(key))
        }
      }
      try {
        const raw = await inv<string | null>('local_store_read', { name: 'prefs' })
        if (raw != null) {
          let obj: Record<string, unknown> = {}
          try {
            const p = JSON.parse(raw) as unknown
            if (p && typeof p === 'object') obj = p as Record<string, unknown>
          } catch { console.warn('[localStore] prefs 文件损坏，回落本地镜像') }
          for (const k of PREFS_KEYS) {
            const v = obj[k]
            if (typeof v === 'string') lsSet(k, v)
          }
        } else {
          hydrated = true // 先置位，persistPrefs 才肯落盘（把现有镜像整表迁移）
          persistPrefs()
        }
      } catch (e) {
        console.warn('[localStore] prefs 文件读取失败，回落本地镜像', e)
      }
    }
    hydrated = true
    listeners.forEach(fn => { try { fn() } catch { /* 单个订阅者异常不阻断其余 */ } })
    listeners.clear()
  })()
  return hydratePromise
}
