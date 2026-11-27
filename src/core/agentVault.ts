// 文件保险箱（v0.1.507 一期）：纯逻辑层。
// 文件操作在 Rust 侧（agent_vault_* 命令）：基线镜像 + diff 时把被改/被删文件的上一版沉入保险箱。
// 这里放与 Rust 同一口径的清理选择（selectPruneVictims）、统计与格式化，供界面预览与单测锁定口径。

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
