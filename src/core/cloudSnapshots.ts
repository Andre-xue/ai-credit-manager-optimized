// 云端快照备份（v0.1.330）：把整份状态的时间点副本存进云端同步载荷的 stateSnapshots 列表。
// 与云同步互补：同步是镜像（改错会同步掉），快照按时间留多份、可回滚。
// 快照内容口径与同步一致：剥离网关令牌与界面语言；本地模型账户默认不进（除非开了同步本地账户）。
// 偏好（开关/间隔/保留份数）是设备级设置，只存本机 localStorage，不云同步（避免多端抢着备份）。

import type { AppState } from './types'
import { isLocalProvider } from './types'
import { pullPayload, pushPayload, getClientId, type StateSnapshot } from './sync'
import { getVaultSyncMaterial, type VaultSyncMaterial } from './crypto'

const PREFS_KEY = 'acm.cloudBackup.prefs.v1'
const LAST_KEY = 'acm.cloudBackup.lastAt'

export interface CloudBackupPrefs {
  enabled: boolean
  /** 备份间隔（小时）：6 / 24 / 168 */
  intervalHours: number
  /** 保留份数：3 / 5 / 10 */
  keep: number
}

export function loadCloudBackupPrefs(): CloudBackupPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') as Partial<CloudBackupPrefs> | null
    return {
      enabled: !!raw?.enabled,
      intervalHours: [6, 24, 168].includes(raw?.intervalHours ?? 0) ? raw!.intervalHours! : 24,
      keep: [3, 5, 10].includes(raw?.keep ?? 0) ? raw!.keep! : 5,
    }
  } catch { return { enabled: false, intervalHours: 24, keep: 5 } }
}

export function saveCloudBackupPrefs(p: CloudBackupPrefs): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)) } catch { /* 忽略 */ }
}

export function cloudBackupLastAt(): number {
  try { return Number(localStorage.getItem(LAST_KEY) ?? 0) || 0 } catch { return 0 }
}

function markBackupDone(): void {
  try { localStorage.setItem(LAST_KEY, String(Date.now())) } catch { /* 忽略 */ }
}

/** 快照用的状态副本：与 pushPayload 的同步口径一致（剥令牌/语言，本地账户按设置决定） */
export function snapshotStateOf(appState: AppState): AppState {
  const includeLocal = !!appState.settings.syncLocalProviders
  const base: AppState = { ...appState, settings: { ...appState.settings, gatewayToken: undefined, language: undefined } }
  if (includeLocal) return base
  const localIds = new Set(appState.accounts.filter(a => isLocalProvider(a.providerId)).map(a => a.id))
  if (!localIds.size) return base
  return {
    ...base,
    accounts: base.accounts.filter(a => !localIds.has(a.id)),
    quotas: base.quotas.filter(q => !localIds.has(q.accountId)),
    usage: base.usage.filter(u => !localIds.has(u.accountId)),
    checkins: base.checkins.filter(c => !c.accountId || !localIds.has(c.accountId)),
  }
}

/** 只保留最近 keep 份（列表按时间旧→新） */
export function trimSnapshots<T>(list: T[], keep: number): T[] {
  return list.slice(-Math.max(1, keep))
}

export interface SnapshotMeta {
  id: string
  createdAt: string
  note?: string
  /** 序列化后近似字节数（展示用） */
  size: number
  /** 是否本机产生的 */
  mine: boolean
}

function toMeta(s: StateSnapshot): SnapshotMeta {
  let size = 0
  try { size = JSON.stringify(s.state).length } catch { /* 忽略 */ }
  return { id: s.id, createdAt: s.createdAt, note: s.note, size, mine: s.clientId === getClientId() }
}

/** 创建一份快照并推送（会顺带完成一次常规同步推送） */
export async function createCloudSnapshot(appState: AppState, keep: number, note?: string): Promise<{ ok: boolean; error?: string }> {
  const pulled = await pullPayload()
  if (!pulled.ok) return { ok: false, error: pulled.error ?? '读取云端失败' }
  const prev = pulled.payload?.stateSnapshots ?? []
  const snap: StateSnapshot = {
    id: `snap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    createdAt: new Date().toISOString(),
    clientId: getClientId(),
    note,
    state: snapshotStateOf(appState),
    vault: getVaultSyncMaterial(),
  }
  const r = await pushPayload(appState, undefined, {
    includeLocal: !!appState.settings.syncLocalProviders,
    snapshots: trimSnapshots([...prev, snap], keep),
  })
  if (!r.ok) return { ok: false, error: r.error ?? '推送失败' }
  markBackupDone()
  return { ok: true }
}

/** 快照列表（新→旧） */
export async function listCloudSnapshots(): Promise<{ ok: boolean; list: SnapshotMeta[]; error?: string }> {
  const pulled = await pullPayload()
  if (!pulled.ok) return { ok: false, list: [], error: pulled.error ?? '读取云端失败' }
  const list = (pulled.payload?.stateSnapshots ?? []).map(toMeta).reverse()
  return { ok: true, list }
}

/** 删除一份快照 */
export async function deleteCloudSnapshot(appState: AppState, id: string): Promise<{ ok: boolean; error?: string }> {
  const pulled = await pullPayload()
  if (!pulled.ok) return { ok: false, error: pulled.error ?? '读取云端失败' }
  const prev = pulled.payload?.stateSnapshots ?? []
  const next = prev.filter(s => s.id !== id)
  if (next.length === prev.length) return { ok: false, error: '快照不存在' }
  const r = await pushPayload(appState, undefined, {
    includeLocal: !!appState.settings.syncLocalProviders,
    snapshots: next,
  })
  return r.ok ? { ok: true } : { ok: false, error: r.error ?? '推送失败' }
}

/** 取一份快照的完整内容（恢复用） */
export async function getCloudSnapshot(id: string): Promise<{ state: AppState; vault: VaultSyncMaterial } | null> {
  const pulled = await pullPayload()
  if (!pulled.ok || !pulled.payload) return null
  const snap = (pulled.payload.stateSnapshots ?? []).find(s => s.id === id)
  return snap ? { state: snap.state, vault: snap.vault } : null
}

/** 自动备份是否到期（供 App 定时器判断） */
export function cloudBackupDue(prefs: CloudBackupPrefs, now = Date.now()): boolean {
  if (!prefs.enabled) return false
  return now - cloudBackupLastAt() >= prefs.intervalHours * 3600_000
}
