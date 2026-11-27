// Agent 工作台桌面桥（v0.1.507）：Tauri invoke 封装。非桌面端一律安全降级（空结果/false），
// 界面层会先用 isDesktopApp() 挡住并显示「需要桌面端」占位，这里只是兜底。
import { isDesktopApp } from './openExternal'
import type { AgentDetectResult } from './agents'
import type { VaultEntry, VaultBaselineInfo } from './agentVault'

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

function invokeFn(): InvokeFn | null {
  if (!isDesktopApp()) return null
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke?: InvokeFn } }
  return w.__TAURI_INTERNALS__?.invoke ?? null
}

export interface AgentProbeIn {
  id: string
  appNames: string[]
  bundleIds: string[]
  cliNames: string[]
}

export async function agentDetect(probes: AgentProbeIn[]): Promise<AgentDetectResult[]> {
  const inv = invokeFn()
  if (!inv) return probes.map(p => ({ id: p.id, installed: false, via: '', path: '' }))
  try {
    return await inv<AgentDetectResult[]>('agent_detect', { probes })
  } catch {
    return probes.map(p => ({ id: p.id, installed: false, via: '', path: '' }))
  }
}

export async function agentLaunchApp(appNames: string[], bundleIds: string[]): Promise<boolean> {
  const inv = invokeFn()
  if (!inv) return false
  try { return await inv<boolean>('agent_launch_app', { appNames, bundleIds }) } catch { return false }
}

export async function agentRunStart(
  runId: string, command: string, args: string[], cwd: string, envPairs: Array<[string, string]>,
): Promise<number> {
  const inv = invokeFn()
  if (!inv) throw new Error('仅桌面端可用')
  return inv<number>('agent_run_start', { runId, command, args, cwd, envPairs })
}

export interface AgentRunPollResult {
  lines: string[]
  next: number
  running: boolean
  exitCode: number | null
}

export async function agentRunPoll(runId: string, cursor: number): Promise<AgentRunPollResult> {
  const inv = invokeFn()
  if (!inv) return { lines: [], next: cursor, running: false, exitCode: null }
  try {
    return await inv<AgentRunPollResult>('agent_run_poll', { runId, cursor })
  } catch {
    return { lines: [], next: cursor, running: false, exitCode: null }
  }
}

export async function agentRunStop(runId: string): Promise<void> {
  const inv = invokeFn()
  if (!inv) return
  try { await inv('agent_run_stop', { runId }) } catch { /* 已退出时忽略 */ }
}

export interface VaultScanResult { files: number; bytes: number; skipped: number }

export async function agentVaultScan(workdir: string): Promise<VaultScanResult> {
  const inv = invokeFn()
  if (!inv) throw new Error('仅桌面端可用')
  return inv<VaultScanResult>('agent_vault_scan', { workdir })
}

export async function agentVaultBaseline(
  taskId: string, agentId: string, agentName: string, taskTitle: string, workdir: string,
): Promise<VaultScanResult> {
  const inv = invokeFn()
  if (!inv) throw new Error('仅桌面端可用')
  return inv<VaultScanResult>('agent_vault_baseline', { taskId, agentId, agentName, taskTitle, workdir })
}

export async function agentVaultPoll(taskId: string): Promise<{ backedUp: number; entries: VaultEntry[] }> {
  const inv = invokeFn()
  if (!inv) return { backedUp: 0, entries: [] }
  try {
    return await inv<{ backedUp: number; entries: VaultEntry[] }>('agent_vault_poll', { taskId })
  } catch {
    return { backedUp: 0, entries: [] }
  }
}

export async function agentVaultList(): Promise<VaultEntry[]> {
  const inv = invokeFn()
  if (!inv) return []
  try { return await inv<VaultEntry[]>('agent_vault_list') } catch { return [] }
}

/** 还原一条备份；返回还原前备份的当前版条目 id（无当前文件时为空串） */
export async function agentVaultRestore(entryId: string): Promise<string> {
  const inv = invokeFn()
  if (!inv) throw new Error('仅桌面端可用')
  return inv<string>('agent_vault_restore', { entryId })
}

export async function agentVaultDeleteEntries(ids: string[]): Promise<number> {
  const inv = invokeFn()
  if (!inv) return 0
  try { return await inv<number>('agent_vault_delete_entries', { ids }) } catch { return 0 }
}

export async function agentVaultPrune(retentionDays: number, capBytes: number): Promise<number> {
  const inv = invokeFn()
  if (!inv) return 0
  try { return await inv<number>('agent_vault_prune', { retentionDays, capBytes }) } catch { return 0 }
}

export interface VaultStatsResult { totalBytes: number; baselines: VaultBaselineInfo[] }

/** 保险箱占用统计：整库总字节 + 每任务基线镜像占用（版本条目占用走 agentVaultList） */
export async function agentVaultStats(): Promise<VaultStatsResult> {
  const inv = invokeFn()
  if (!inv) return { totalBytes: 0, baselines: [] }
  try {
    const r = await inv<VaultStatsResult | null>('agent_vault_stats', {})
    if (!r) return { totalBytes: 0, baselines: [] }
    return { totalBytes: r.totalBytes ?? 0, baselines: Array.isArray(r.baselines) ? r.baselines : [] }
  } catch { return { totalBytes: 0, baselines: [] } }
}

/** 清理某任务的基线镜像（版本条目不动）；返回释放字节数 */
export async function agentVaultDeleteBaseline(taskId: string): Promise<number> {
  const inv = invokeFn()
  if (!inv) return 0
  try { return (await inv<number | null>('agent_vault_delete_baseline', { taskId })) ?? 0 } catch { return 0 }
}
