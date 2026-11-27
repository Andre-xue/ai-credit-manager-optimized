// 文件保险箱（v0.1.507 一期）：纯逻辑层。
// 文件操作在 Rust 侧（agent_vault_* 命令）：基线镜像 + diff 时把被改/被删文件的上一版沉入保险箱。
// 这里放与 Rust 同一口径的清理选择（selectPruneVictims）、统计与格式化，供界面预览与单测锁定口径。
import { readLocalStore, writeLocalStore } from './localStore'

export interface VaultEntry {
  id: string
  taskId: string
  agentId: string
  agentName: string
  taskTitle: string
  originalPath: string
  storedRel: string
  size: number
  createdAt: number
  kind: string // prev-version | pre-restore
}

/**
 * 清理选择（与 Rust agent_vault_prune 同一口径）：
 * 1) 先选过期条目（createdAt 早于保留期截止）；
 * 2) 剩余总大小仍超容量上限时，从最旧开始继续选，直到达标。
 */
export function selectPruneVictims(
  entries: VaultEntry[],
  nowMs: number,
  retentionDays: number,
  capBytes: number,
): string[] {
  const cutoff = nowMs - Math.max(0, retentionDays) * 86_400_000
  const victims: string[] = []
  const remaining: VaultEntry[] = []
  for (const e of entries) {
    if (e.createdAt < cutoff) victims.push(e.id)
    else remaining.push(e)
  }
  let total = remaining.reduce((s, e) => s + e.size, 0)
  if (total > capBytes) {
    const sorted = [...remaining].sort((a, b) => a.createdAt - b.createdAt)
    for (const e of sorted) {
      if (total <= capBytes) break
      victims.push(e.id)
      total -= e.size
    }
  }
  return victims
}

export function vaultTotals(entries: VaultEntry[]): { count: number; bytes: number } {
  return { count: entries.length, bytes: entries.reduce((s, e) => s + e.size, 0) }
}

// ---------------- 二期（v0.1.508）：占用汇总 / APFS 克隆回落 / 清理记录 ----------------

/** Rust agent_vault_stats 回报的每任务基线信息（镜像目录占用） */
export interface VaultBaselineInfo {
  taskId: string
  taskTitle: string
  agentName: string
  createdAt: number
  baselineBytes: number
}

export interface VaultTaskUsage {
  taskId: string
  taskTitle: string
  agentName: string
  baselineBytes: number
  entriesBytes: number
  entryCount: number
  totalBytes: number
}

/** 把版本条目与基线镜像按任务合并成占用汇总（按总占用降序） */
export function mergeVaultUsage(entries: VaultEntry[], baselines: VaultBaselineInfo[]): VaultTaskUsage[] {
  const map = new Map<string, VaultTaskUsage>()
  const ensure = (taskId: string, taskTitle: string, agentName: string) => {
    const cur = map.get(taskId) ?? {
      taskId, taskTitle, agentName, baselineBytes: 0, entriesBytes: 0, entryCount: 0, totalBytes: 0,
    }
    if (!cur.taskTitle && taskTitle) cur.taskTitle = taskTitle
    if (!cur.agentName && agentName) cur.agentName = agentName
    map.set(taskId, cur)
    return cur
  }
  for (const b of baselines) {
    const u = ensure(b.taskId, b.taskTitle, b.agentName)
    u.baselineBytes += b.baselineBytes
  }
  for (const e of entries) {
    const u = ensure(e.taskId, e.taskTitle, e.agentName)
    u.entriesBytes += e.size
    u.entryCount += 1
  }
  for (const u of map.values()) u.totalBytes = u.baselineBytes + u.entriesBytes
  return [...map.values()].sort((a, b) => b.totalBytes - a.totalBytes)
}

/**
 * APFS 克隆复制的回落判定（与 Rust vault_copy_file 同一口径，命令结果可注入便于单测）：
 * 只有 macOS 才尝试克隆（cp -c）；克隆成功记 cloned，其余一律回落普通复制记 copied。
 */
export function shouldAttemptClone(isMacos: boolean): boolean {
  return isMacos
}

export function apfsCopyOutcome(isMacos: boolean, cloneSucceeded: boolean): 'cloned' | 'copied' {
  return isMacos && cloneSucceeded ? 'cloned' : 'copied'
}

// 最近一次自动/手动清理的记录（prune 只由前端两处触发，记录留本机，视图里展示一行）
export interface VaultPruneLog { at: number; removed: number; trigger: string }

export const VAULT_PRUNE_LOG_KEY = 'acm.agents.vaultPruneLog.v1'

export function loadPruneLog(): VaultPruneLog | null {
  try {
    const raw = readLocalStore('agents-vault-prune-log')
    if (!raw) return null
    const p = JSON.parse(raw) as VaultPruneLog
    return typeof p?.at === 'number' && typeof p?.removed === 'number' ? p : null
  } catch { return null }
}

export function savePruneLog(rec: VaultPruneLog): void {
  writeLocalStore('agents-vault-prune-log', JSON.stringify(rec))
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}
