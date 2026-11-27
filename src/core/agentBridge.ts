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

// ---------------- 多账户凭据目录（v0.1.509） ----------------

export interface AgentAccountProbeIn {
  entryId: string
  agentId: string
  credDir: 'native' | 'isolated'
  nativeHome: string
  probeFile: string
  missingMeans: 'no' | 'unknown'
}

export interface AgentAccountStatus {
  entryId: string
  dirPath: string
  dirExists: boolean
  /** yes = 探测到登录凭据文件；no = 确定未登录；unknown = 读不到（如登录在系统钥匙串） */
  login: 'yes' | 'no' | 'unknown'
}

/** 批量探测账户条目登录态（只查凭据文件在不在，不读内容）；非桌面端一律 unknown */
export async function agentAccountsProbe(probes: AgentAccountProbeIn[]): Promise<AgentAccountStatus[]> {
  const inv = invokeFn()
  if (!inv) return probes.map(p => ({ entryId: p.entryId, dirPath: '', dirExists: false, login: 'unknown' as const }))
  try {
    const r = await inv<AgentAccountStatus[]>('agent_account_probe', { probes })
    return Array.isArray(r) ? r : probes.map(p => ({ entryId: p.entryId, dirPath: '', dirExists: false, login: 'unknown' as const }))
  } catch {
    return probes.map(p => ({ entryId: p.entryId, dirPath: '', dirExists: false, login: 'unknown' as const }))
  }
}

/** 为新条目建隔离凭据目录，返回绝对路径；失败返回空串 */
export async function agentAccountCreateDir(agentId: string, entryId: string): Promise<string> {
  const inv = invokeFn()
  if (!inv) return ''
  try { return await inv<string>('agent_account_create_dir', { agentId, entryId }) } catch { return '' }
}

/** 查命令解析路径（找不到返回空串）；一键安装前探 npm 用 */
export async function agentWhich(name: string): Promise<string> {
  const inv = invokeFn()
  if (!inv) return ''
  try { return await inv<string>('agent_which', { name }) } catch { return '' }
}

/** v0.1.511（⑤）：确保 DSH 账号路线覆盖层文件存在于 App 自己目录
 *  （~/.ai-credit-manager/agents/dsh-account-route.yml），返回绝对路径；
 *  非桌面端 / 失败返回空串（派活回落到不带覆盖层的旧形式）。 */
export async function agentDshAccountPatch(): Promise<string> {
  const inv = invokeFn()
  if (!inv) return ''
  try { return await inv<string>('agent_dsh_account_patch') } catch { return '' }
}

// ---------------- 桌面型自动送达（v0.1.509，仅 macOS） ----------------

/** 写系统剪贴板（复用翻译模块的 pbcopy 命令）；成功返回 true */
export async function agentClipboardWrite(text: string): Promise<boolean> {
  const inv = invokeFn()
  if (!inv) return false
  try { await inv('translator_clipboard_write', { text }); return true } catch { return false }
}

/** 辅助功能权限是否已授（自动粘贴合成按键的前提） */
export async function agentAxTrusted(): Promise<boolean> {
  const inv = invokeFn()
  if (!inv) return false
  try { return await inv<boolean>('agent_ax_trusted') } catch { return false }
}

export interface AgentAppProbe {
  running: boolean
  hasWindow: boolean
  isFrontmost: boolean
  frontmostName: string
  frontmostBundleId: string
  bundleId: string
  pid: number
}

const EMPTY_PROBE: AgentAppProbe = {
  running: false, hasWindow: false, isFrontmost: false,
  frontmostName: '', frontmostBundleId: '', bundleId: '', pid: 0,
}

/** 目标应用窗口快照：进程在否 / 有可见窗口否 / 是否在前台 / 当前前台是谁 */
export async function agentAppProbe(appNames: string[], bundleIds: string[]): Promise<AgentAppProbe> {
  const inv = invokeFn()
  if (!inv) return EMPTY_PROBE
  try {
    const r = await inv<AgentAppProbe | null>('agent_app_probe', { appNames, bundleIds })
    return r ? { ...EMPTY_PROBE, ...r } : EMPTY_PROBE
  } catch { return EMPTY_PROBE }
}

/** 把目标应用激活到前台（open -a 后用户又切走时用） */
export async function agentActivateApp(appNames: string[], bundleIds: string[]): Promise<boolean> {
  const inv = invokeFn()
  if (!inv) return false
  try { return await inv<boolean>('agent_activate_app', { appNames, bundleIds }) } catch { return false }
}

export type AgentPasteStatus = 'pasted' | 'sent' | 'mismatch' | 'no-input' | 'no-permission' | 'clipboard-failed' | 'unsupported'

/**
 * 原子送达（Rust 侧一口气做完）：再验前台是目标应用 → 写剪贴板 → 合成 ⌘V →
 * （autoSend 时）600ms 后复验前台仍是目标才合成回车。任何一步不符如实返回。
 */
export async function agentPasteDeliver(
  appNames: string[], bundleIds: string[], text: string, autoSend: boolean,
): Promise<{ status: AgentPasteStatus; frontmostName: string }> {
  const inv = invokeFn()
  if (!inv) return { status: 'unsupported', frontmostName: '' }
  try {
    const r = await inv<{ status: AgentPasteStatus; frontmostName: string } | null>(
      'agent_paste_deliver', { appNames, bundleIds, text, autoSend },
    )
    return r ?? { status: 'unsupported', frontmostName: '' }
  } catch { return { status: 'unsupported', frontmostName: '' } }
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
