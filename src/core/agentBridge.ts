// Agent 工作台桌面桥（v0.1.507）：Tauri invoke 封装。非桌面端一律安全降级（空结果/false），
// 界面层会先用 isDesktopApp() 挡住并显示「需要桌面端」占位，这里只是兜底。
import { isDesktopApp } from './openExternal'
import type { AgentDetectResult, AgentDef, AgentAccountEntry } from './agents'
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
  /** v0.1.512（④）：多段相对探测路径（HOME 型隔离条目查状态目录）；设置时 Rust 优先用它 */
  probePath?: string
  /** 探测目标存在时的语义：'unknown' = 存在不等于已登录（agy 状态目录登录前就会建出来） */
  probeExistsMeans?: string
}

/** 条目登录态探测入参的统一拼装（设置面板与工作台共用）：
 *  HOME 型隔离条目查条目 HOME 下的状态目录 .gemini/antigravity-cli；其余查凭据文件。
 *  没有可探测文件的 Agent 返回 null。 */
export function entryProbeIn(def: AgentDef, entry: Pick<AgentAccountEntry, 'id' | 'credDir'>): AgentAccountProbeIn | null {
  if (!def.nativeCredHome || !def.credProbeFile) return null
  const base: AgentAccountProbeIn = {
    entryId: entry.id, agentId: def.id, credDir: entry.credDir,
    nativeHome: def.nativeCredHome, probeFile: def.credProbeFile,
    missingMeans: def.credProbeMissing ?? 'unknown',
  }
  if (def.credIsolation === 'home' && entry.credDir === 'isolated') {
    // 状态目录在跑过一次 agy 后就在（登录前也会建），只证明跑过、不证明已登录：
    // 登录态保持 unknown，靠首次派活成功落「已验证」标记（与原生条目同口径）
    return { ...base, probeFile: '', probePath: '.gemini/antigravity-cli', probeExistsMeans: 'unknown' }
  }
  if (def.probeInconclusive) {
    // v0.1.517（DSH）：探测只为拿凭据目录路径（隔离条目派活要 DSH_HOME），登录态
    // 永不下结论——.credentials.yaml 在不在与官方 API 路线能否派活无关，状态改看
    // 条目 Key 绑定与派活实证（dshEntryKeyState）
    return { ...base, missingMeans: 'unknown', probeExistsMeans: 'unknown' }
  }
  return base
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

// ---------------- Antigravity HOME 型条目（v0.1.512 ④） ----------------

/** 建 Antigravity 隔离条目：HOME 目录 + 预建钥匙串；返回条目目录绝对路径。
 *  失败时抛 Rust 给的人话原因（钥匙串建不出来等），调用方如实展示、不许静默吞。 */
export async function agentAgySetupEntry(entryId: string): Promise<string> {
  const inv = invokeFn()
  if (!inv) throw new Error('仅桌面端可用')
  return inv<string>('agent_agy_setup_entry', { entryId })
}

/** 派活前解锁条目钥匙串；失败抛人话原因 */
export async function agentAgyUnlockKeychain(entryId: string): Promise<void> {
  const inv = invokeFn()
  if (!inv) throw new Error('仅桌面端可用')
  await inv('agent_agy_unlock_keychain', { entryId })
}

// ---------------- 导入会话（v0.1.512 ①） ----------------

export interface AgentSessionHomeIn {
  entryId: string
  entryLabel: string
  homePath: string
}

export interface AgentSessionItem {
  entryId: string
  entryLabel: string
  sessionId: string
  title: string
  /** archive = 存档自带标题；first-input = 取首条用户输入（界面注明）；none = 无标题 */
  titleSource: 'archive' | 'first-input' | 'none'
  cwd: string
  createdAt: number
  updatedAt: number
}

/** 列出某 Agent 在各条目 HOME 下的本地会话存档（只读元信息）；失败抛错由页面如实展示 */
export async function agentListSessions(
  agentId: string, homes: AgentSessionHomeIn[],
): Promise<{ sessions: AgentSessionItem[]; skipped: number }> {
  const inv = invokeFn()
  if (!inv) throw new Error('仅桌面端可用')
  const r = await inv<{ sessions: AgentSessionItem[]; skipped: number }>('agent_list_sessions', { agentId, homes })
  return { sessions: Array.isArray(r?.sessions) ? r.sessions : [], skipped: r?.skipped ?? 0 }
}

// ---------------- 赛马 git worktree（v0.1.512 ②） ----------------

export async function agentGitInfo(dir: string): Promise<{ isRepo: boolean; branch: string }> {
  const inv = invokeFn()
  if (!inv) return { isRepo: false, branch: '' }
  try {
    const r = await inv<{ isRepo: boolean; branch: string }>('agent_git_info', { dir })
    return { isRepo: !!r?.isRepo, branch: r?.branch ?? '' }
  } catch { return { isRepo: false, branch: '' } }
}

/** 给赛马选手建隔离工作区（新分支 + worktree）；失败抛 git 的人话原因 */
export async function agentWorktreeAdd(repo: string, branch: string, path: string): Promise<void> {
  const inv = invokeFn()
  if (!inv) throw new Error('仅桌面端可用')
  await inv('agent_worktree_add', { repo, branch, path })
}

export interface AgentWorktreeDiff {
  stat: string
  diff: string
  changedFiles: string[]
}

export async function agentWorktreeDiff(worktree: string): Promise<AgentWorktreeDiff> {
  const inv = invokeFn()
  if (!inv) throw new Error('仅桌面端可用')
  const r = await inv<AgentWorktreeDiff>('agent_worktree_diff', { worktree })
  return { stat: r?.stat ?? '', diff: r?.diff ?? '', changedFiles: Array.isArray(r?.changedFiles) ? r.changedFiles : [] }
}

/** 把胜出分支合并回主仓库当前分支；主工作区不干净/冲突时抛人话原因，什么都不动 */
export async function agentWorktreeMerge(repo: string, branch: string): Promise<void> {
  const inv = invokeFn()
  if (!inv) throw new Error('仅桌面端可用')
  await inv('agent_worktree_merge', { repo, branch })
}

export interface AgentWorktreeRemoveResult { worktreeRemoved: boolean; branchDeleted: boolean; note: string }

export async function agentWorktreeRemove(repo: string, path: string, branch: string): Promise<AgentWorktreeRemoveResult> {
  const inv = invokeFn()
  if (!inv) return { worktreeRemoved: false, branchDeleted: false, note: '' }
  try {
    const r = await inv<AgentWorktreeRemoveResult>('agent_worktree_remove', { repo, path, branch })
    return { worktreeRemoved: !!r?.worktreeRemoved, branchDeleted: !!r?.branchDeleted, note: r?.note ?? '' }
  } catch { return { worktreeRemoved: false, branchDeleted: false, note: '' } }
}
