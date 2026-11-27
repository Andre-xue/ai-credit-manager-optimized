// Agent 工作台（v0.1.507 一期）：注册表 / 设置（仅本机）/ 派活纯逻辑 / 账本。
// 硬规则：账号登录型用自身账号、免 Key、不记细账；空壳型由魔方供 Key（环境变量注入）、
// 用量打 Agent 归因；额度护栏默认只走免费路线，借付费账户必须人工放行，绝不静默扣费。
import type { Account } from './types'
import { PROVIDER_MAP } from '../data/providers'

export type AgentKind = 'account' | 'shell'
export type AgentDispatch = 'cli' | 'open'

export interface AgentDef {
  id: string
  name: string
  kind: AgentKind
  /** 派活方式：cli = 子进程真派活；open = 打开应用 + 手动粘贴（一期桌面型） */
  dispatch: AgentDispatch
  /** 检测：桌面应用名（/Applications 与 ~/Applications 下的 .app） */
  appNames: string[]
  bundleIds: string[]
  /** 检测/启动：CLI 命令名 */
  cliNames: string[]
  /** 资格如实标注（展示给用户，不达资格时配合 availability 给出不可委派原因） */
  qualification?: string
  installHint: string
  /** 是否提供「使用自身登录」绑定（CLI 自带登录态，如 Claude Code 的 Pro 登录） */
  selfLogin?: boolean
}

export const AGENT_REGISTRY: AgentDef[] = [
  // ---------- 账号登录型（桌面应用，自身账号免 Key） ----------
  {
    id: 'dsh', name: 'DSH', kind: 'account', dispatch: 'open',
    appNames: ['DeepSeek Harness', 'DSH', 'DeepSeek'], bundleIds: [], cliNames: ['dsh'],
    installHint: '到 deepseek.com/download 下载 DeepSeek Harness 桌面端（macOS 需 Apple 芯片 + macOS 13 以上）',
  },
  {
    id: 'antigravity', name: 'Antigravity', kind: 'account', dispatch: 'open',
    appNames: ['Antigravity'], bundleIds: [], cliNames: [],
    qualification: '已装可接；其内置 Claude 模型官方标注 2026-11-30 下线，之后以 Gemini 为主',
    installHint: '到 antigravity.google 下载 Antigravity 桌面端并登录 Google 账号',
  },
  {
    id: 'codex-desktop', name: 'Codex 桌面端', kind: 'account', dispatch: 'open',
    appNames: ['Codex'], bundleIds: ['com.openai.codex'], cliNames: [],
    qualification: '免费档可用（桌面端限量模型）',
    installHint: '到 OpenAI 官网下载 Codex 桌面端并登录账号',
  },
  {
    id: 'workbuddy-app', name: 'WorkBuddy', kind: 'account', dispatch: 'open',
    appNames: ['WorkBuddy'], bundleIds: [], cliNames: [],
    installHint: '到 workbuddy.cn 下载 WorkBuddy 客户端并登录',
  },
  {
    id: 'qoder-app', name: 'Qoder', kind: 'account', dispatch: 'open',
    appNames: ['Qoder'], bundleIds: [], cliNames: [],
    installHint: '到 qoder.com 下载 Qoder 客户端并登录',
  },
  // ---------- 空壳型（CLI，魔方供 Key） ----------
  {
    id: 'pi', name: 'Pi', kind: 'shell', dispatch: 'cli',
    appNames: [], bundleIds: [], cliNames: ['pi'], selfLogin: true,
    installHint: '终端运行 npm install -g @mariozechner/pi-coding-agent',
  },
  {
    id: 'opencode', name: 'OpenCode', kind: 'shell', dispatch: 'cli',
    appNames: [], bundleIds: [], cliNames: ['opencode'], selfLogin: true,
    installHint: '终端运行 npm install -g opencode-ai（或 brew install opencode）',
  },
  {
    id: 'qwen-code', name: 'Qwen Code', kind: 'shell', dispatch: 'cli',
    appNames: [], bundleIds: [], cliNames: ['qwen'], selfLogin: true,
    installHint: '终端运行 npm install -g @qwen-code/qwen-code',
  },
  {
    id: 'kimi-code', name: 'Kimi Code', kind: 'shell', dispatch: 'cli',
    appNames: [], bundleIds: [], cliNames: ['kimi'], selfLogin: true,
    installHint: '按 Moonshot 官方文档安装 Kimi Code CLI（kimi 命令）',
  },
  {
    id: 'claude-code', name: 'Claude Code', kind: 'shell', dispatch: 'cli',
    appNames: [], bundleIds: [], cliNames: ['claude'], selfLogin: true,
    qualification: '免费档不含，需 Pro 订阅或绑定 Anthropic API 账户',
    installHint: '终端运行 npm install -g @anthropic-ai/claude-code',
  },
]

export function agentDef(id: string): AgentDef | undefined {
  return AGENT_REGISTRY.find(a => a.id === id)
}

/** 各 CLI 的非交互派活命令（按各自官方 CLI 约定；kimi 的 --print 组合待真机核对） */
export function buildCliInvocation(agentId: string, taskText: string): { command: string; args: string[] } | null {
  switch (agentId) {
    case 'pi': return { command: 'pi', args: ['-p', taskText] }
    case 'opencode': return { command: 'opencode', args: ['run', taskText] }
    case 'qwen-code': return { command: 'qwen', args: ['-p', taskText] }
    case 'kimi-code': return { command: 'kimi', args: ['--print', '-p', taskText] }
    case 'claude-code': return { command: 'claude', args: ['-p', taskText] }
    default: return null
  }
}

// ---------------- 设置（仅本机，绝不进 AppState 同步） ----------------

export type KeyBinding =
  | { kind: 'free' }
  | { kind: 'self' }
  | { kind: 'account'; accountId: string }

export interface AgentSettings {
  enabled: Record<string, boolean>
  bindings: Record<string, KeyBinding>
  quota: {
    freeOnly: boolean
    /** 单会话上限（元），null = 不限 */
    perSessionCap: number | null
    /** 每日上限（元），null = 不限 */
    dailyCap: number | null
    overLimit: 'stop' | 'notify'
  }
  parallel: { maxParallel: number }
  vault: { enabled: boolean; retentionDays: number; capGB: number; workdir: string }
  /** 二期执行：一期可存（链顺序/模式），界面如实标「二期生效」 */
  relay: { chain: string[]; mode: 'auto' | 'ask' }
  /** 二期执行：一期可存主控选择，交叉审查置灰 */
  master: { masterAgentId: string; crossReview: boolean }
}

export const AGENT_SETTINGS_KEY = 'acm.agents.settings.v1'

export function defaultAgentSettings(): AgentSettings {
  return {
    enabled: {},
    bindings: {},
    quota: { freeOnly: true, perSessionCap: null, dailyCap: null, overLimit: 'stop' },
    parallel: { maxParallel: 3 },
    vault: { enabled: true, retentionDays: 30, capGB: 5, workdir: '' },
    relay: { chain: [], mode: 'ask' },
    master: { masterAgentId: '', crossReview: false },
  }
}

export function loadAgentSettings(): AgentSettings {
  const base = defaultAgentSettings()
  try {
    const raw = localStorage.getItem(AGENT_SETTINGS_KEY)
    if (!raw) return base
    const p = JSON.parse(raw) as Partial<AgentSettings>
    return {
      enabled: p.enabled ?? {},
      bindings: p.bindings ?? {},
      quota: { ...base.quota, ...(p.quota ?? {}) },
      parallel: { maxParallel: Math.min(5, Math.max(1, p.parallel?.maxParallel ?? 3)) },
      vault: { ...base.vault, ...(p.vault ?? {}) },
      relay: { chain: Array.isArray(p.relay?.chain) ? p.relay!.chain : [], mode: p.relay?.mode === 'auto' ? 'auto' : 'ask' },
      master: { masterAgentId: p.master?.masterAgentId ?? '', crossReview: !!p.master?.crossReview },
    }
  } catch { return base }
}

export function saveAgentSettings(s: AgentSettings): void {
  try { localStorage.setItem(AGENT_SETTINGS_KEY, JSON.stringify(s)) } catch { /* 本机存储不可用时静默 */ }
}

// ---------------- 检测结果 ----------------

export interface AgentDetectResult {
  id: string
  installed: boolean
  via: string
  path: string
}

// ---------------- 可用性判定（纯函数） ----------------

export type AgentAvailState = 'not-installed' | 'disabled' | 'blocked' | 'ready'
export interface AgentAvailability { state: AgentAvailState; reason: string }

export function agentAvailability(
  def: AgentDef,
  detect: AgentDetectResult | undefined,
  settings: AgentSettings,
  accounts: Account[],
): AgentAvailability {
  if (!detect?.installed) return { state: 'not-installed', reason: def.installHint }
  if (!settings.enabled[def.id]) return { state: 'disabled', reason: '已安装，未启用（到设置 · Agent 管理打开）' }
  if (def.kind === 'account') return { state: 'ready', reason: '使用自身登录账号（免 Key）' }
  // 空壳型必须先有凭据来源
  const binding = settings.bindings[def.id]
  if (!binding) {
    if (def.id === 'claude-code') {
      return { state: 'blocked', reason: '免费档不含：请在设置里绑定 Anthropic 账户，或选「使用自身登录」（需 Pro 订阅）' }
    }
    return { state: 'blocked', reason: '尚未绑定 Key：请在设置里绑定账户、选免费路线或使用自身登录' }
  }
  if (binding.kind === 'account') {
    const acct = accounts.find(a => a.id === binding.accountId)
    if (!acct) return { state: 'blocked', reason: '绑定的账户已不存在，请重新绑定' }
    if (!acct.encryptedKey) return { state: 'blocked', reason: '绑定的账户没有保存 Key，请重新绑定' }
  }
  return { state: 'ready', reason: binding.kind === 'free' ? '免费路线（自动）' : binding.kind === 'self' ? '使用自身登录' : '已绑定账户' }
}

// ---------------- 额度护栏（纯函数） ----------------

export type QuotaGate =
  | { decision: 'pass' }
  | { decision: 'approval'; reason: string }

/** 派活前额度闸门：绑定付费账户且「只走免费路线」开着 → 必须停住等人工放行 */
export function quotaGate(settings: AgentSettings, def: AgentDef, binding: KeyBinding | undefined, accounts: Account[]): QuotaGate {
  if (def.kind !== 'shell' || !binding || binding.kind !== 'account') return { decision: 'pass' }
  if (!settings.quota.freeOnly) return { decision: 'pass' }
  const acct = accounts.find(a => a.id === binding.accountId)
  const name = acct ? (acct.label || PROVIDER_MAP[acct.providerId]?.name || acct.providerId) : '已绑定账户'
  return {
    decision: 'approval',
    reason: `「只走免费路线」开着，而 ${def.name} 绑定的是付费账户「${name}」，本次任务将按该账户的按量价格计费。放行后才启动，费用记入该账户并打上 ${def.name} 归因。`,
  }
}

export type CapCheck = 'ok' | 'over-stop' | 'over-notify'

/** 上限检查：spentToday / spentSession 为魔方账本里 Agent 归因的已记费用（元） */
export function capCheck(settings: AgentSettings, spentToday: number, spentSession: number): CapCheck {
  const { dailyCap, perSessionCap, overLimit } = settings.quota
  const over = (dailyCap !== null && spentToday >= dailyCap) || (perSessionCap !== null && spentSession >= perSessionCap)
  if (!over) return 'ok'
  return overLimit === 'stop' ? 'over-stop' : 'over-notify'
}

// ---------------- 环境变量注入（纯函数，Key 只进子进程环境，不进 UI/日志） ----------------

/** 免费路线端点：与 App 内置免费通道同一上游（OpenCode Zen 公共网关，免 Key 模型） */
export const FREE_ROUTE_BASE_URL = 'https://opencode.ai/zen/v1'

export function buildShellEnv(
  binding: KeyBinding | undefined,
  account: Account | undefined,
  plainKey: string | undefined,
  modelId?: string,
): Record<string, string> {
  if (!binding) return {}
  if (binding.kind === 'self') return {}
  if (binding.kind === 'free') {
    return { OPENAI_API_KEY: 'public', OPENAI_BASE_URL: FREE_ROUTE_BASE_URL }
  }
  // 绑定账户：按平台协议族注入
  if (!account || !plainKey) return {}
  const base = (account.apiUrl || PROVIDER_MAP[account.providerId]?.apiBaseUrl || '').replace(/\/+$/, '')
  const env: Record<string, string> = {}
  if (account.providerId === 'anthropic') {
    env.ANTHROPIC_API_KEY = plainKey
    if (base) env.ANTHROPIC_BASE_URL = base.replace(/\/v1$/, '')
  } else {
    env.OPENAI_API_KEY = plainKey
    if (base) env.OPENAI_BASE_URL = base
    // 兼容 Anthropic 协议的 CLI（Claude Code 等）：同账户 Key 走 Anthropic 变量再给一份
    env.ANTHROPIC_API_KEY = plainKey
    if (base) env.ANTHROPIC_BASE_URL = base.replace(/\/v1$/, '')
    if (account.providerId === 'kim' || account.providerId === 'moonshot') env.MOONSHOT_API_KEY = plainKey
    if (modelId) env.OPENAI_MODEL = modelId
  }
  return env
}

// ---------------- # 委派解析（纯函数） ----------------

export interface DelegationParse {
  agentId: string | null
  unknownToken: string | null
  taskText: string
}

/** 解析总控输入：`#DSH 修一下构建脚本` → 命中注册表别名（名称/id，大小写不敏感；
 *  名称可含空格如「Codex 桌面端」，按最长名前缀匹配） */
export function parseDelegation(text: string, registry: AgentDef[] = AGENT_REGISTRY): DelegationParse {
  const hashIdx = text.search(/(^|\s)#/)
  if (hashIdx < 0) return { agentId: null, unknownToken: null, taskText: text.trim() }
  const at = text.indexOf('#', hashIdx)
  const after = text.slice(at + 1)
  // 先按最长名称/id 前缀匹配（长的优先，避免 Pi 抢了 Pi X 之类）
  const candidates = registry
    .flatMap(a => [{ id: a.id, key: a.name }, { id: a.id, key: a.id }])
    .sort((x, y) => y.key.length - x.key.length)
  for (const c of candidates) {
    if (after.toLowerCase().startsWith(c.key.toLowerCase())) {
      const rest = (text.slice(0, at) + after.slice(c.key.length)).trim()
      return { agentId: c.id, unknownToken: null, taskText: rest }
    }
  }
  const m = after.match(/^([^\s#]+)\s*/)
  const token = m ? m[1] : ''
  const rest = (text.slice(0, at) + after.slice(token.length)).trim()
  return { agentId: null, unknownToken: token || null, taskText: rest }
}

// ---------------- 调度（纯函数） ----------------

export interface SchedTask {
  id: string
  heavy: boolean
  status: string // queued | running | ...
}

/** 挑出当前可启动的排队任务：并行上限内、重活全局只许 1 个（重活被挡不挡轻活） */
export function pickStartable(tasks: SchedTask[], maxParallel: number): string[] {
  const running = tasks.filter(t => t.status === 'running')
  let slots = Math.max(0, maxParallel - running.length)
  let heavyRunning = running.some(t => t.heavy)
  const out: string[] = []
  for (const t of tasks) {
    if (slots <= 0) break
    if (t.status !== 'queued') continue
    if (t.heavy && heavyRunning) continue
    out.push(t.id)
    slots--
    if (t.heavy) heavyRunning = true
  }
  return out
}

const HEAVY_WORDS = ['构建', '打包', '编译', '跑测试', '发布', '部署', 'build', 'test', 'package', 'bundle', 'release', 'deploy', 'compile']

export function isHeavyTask(text: string, manual?: boolean): boolean {
  if (typeof manual === 'boolean') return manual
  const lower = text.toLowerCase()
  return HEAVY_WORDS.some(w => lower.includes(w))
}

// ---------------- CLI 输出用量解析（纯函数） ----------------

/** Claude Code -p 的 JSON 输出含 usage/total_cost_usd；其他 CLI 无结构化用量时返回 null（如实不编造） */
export function parseCliUsage(output: string): { inputTokens: number; outputTokens: number; costUsd: number } | null {
  const lines = output.split('\n').map(l => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const j = JSON.parse(lines[i]) as { usage?: { input_tokens?: number; output_tokens?: number }; total_cost_usd?: number }
      if (j && typeof j === 'object' && j.usage) {
        return {
          inputTokens: j.usage.input_tokens ?? 0,
          outputTokens: j.usage.output_tokens ?? 0,
          costUsd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : 0,
        }
      }
    } catch { /* 非 JSON 行跳过 */ }
  }
  return null
}

// ---------------- 任务与账本（仅本机存储） ----------------

export type AgentTaskStatus =
  | 'queued' | 'queued-heavy' | 'waiting-approval' | 'running' | 'manual' | 'done' | 'failed' | 'stopped'

export interface AgentTask {
  id: string
  text: string
  agentId: string
  agentName: string
  kind: AgentKind
  workdir: string
  heavy: boolean
  /** 已确认「可能写入工作目录之外 / 无保险箱覆盖」 */
  outsideOk: boolean
  status: AgentTaskStatus
  output: string[]
  createdAt: number
  startedAt?: number
  endedAt?: number
  exitCode?: number | null
  approvalReason?: string
  note?: string
}

export const AGENT_TASKS_KEY = 'acm.agents.tasks.v1'

export function loadAgentTasks(): AgentTask[] {
  try {
    const raw = localStorage.getItem(AGENT_TASKS_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as AgentTask[]
    if (!Array.isArray(arr)) return []
    // 上次进程退出时仍在运行/排队的任务不可能还活着：如实标成已中断
    return arr.map(t => (t.status === 'running' || t.status === 'queued' || t.status === 'queued-heavy')
      ? { ...t, status: 'stopped' as AgentTaskStatus, note: 'App 已退出，任务中断' }
      : t)
  } catch { return [] }
}

export function saveAgentTasks(tasks: AgentTask[]): void {
  try { localStorage.setItem(AGENT_TASKS_KEY, JSON.stringify(tasks.slice(0, 100))) } catch { /* ignore */ }
}

export interface AgentLedgerEntry {
  id: string
  taskId: string
  agentId: string
  agentName: string
  kind: AgentKind
  /** 空壳型绑定的账户（账号型为空） */
  accountId?: string
  accountLabel?: string
  startedAt: number
  endedAt: number
  durationMs: number
  status: 'done' | 'failed' | 'stopped' | 'manual'
  /** 有结构化用量时才记（元）；无则 null，结算卡如实显示「未上报」 */
  costYuan: number | null
  /** CLI 自报金额（美元原值，如 Claude Code 的 total_cost_usd）；不做汇率换算、不编造 */
  costUsd?: number | null
  inputTokens?: number
  outputTokens?: number
}

export const AGENT_LEDGER_KEY = 'acm.agents.ledger.v1'

export function loadAgentLedger(): AgentLedgerEntry[] {
  try {
    const raw = localStorage.getItem(AGENT_LEDGER_KEY)
    const arr = raw ? JSON.parse(raw) as AgentLedgerEntry[] : []
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}

export function saveAgentLedger(entries: AgentLedgerEntry[]): void {
  try { localStorage.setItem(AGENT_LEDGER_KEY, JSON.stringify(entries.slice(0, 500))) } catch { /* ignore */ }
}

export interface LedgerSummary {
  totalTasks: number
  totalCostYuan: number
  totalCostUsd: number
  totalTokens: number
  byAgent: Array<{ agentId: string; agentName: string; kind: AgentKind; tasks: number; durationMs: number; costYuan: number; costUsd: number; tokens: number }>
  byAccount: Array<{ accountId: string; accountLabel: string; tasks: number; costYuan: number; costUsd: number; tokens: number }>
  /** 账号型：只有任务数/时长，不计入魔方账本金额 */
  accountKindAgents: Array<{ agentId: string; agentName: string; tasks: number; durationMs: number }>
}

export function summarizeLedger(entries: AgentLedgerEntry[]): LedgerSummary {
  const byAgentMap = new Map<string, LedgerSummary['byAgent'][number]>()
  const byAccountMap = new Map<string, LedgerSummary['byAccount'][number]>()
  const acctKindMap = new Map<string, LedgerSummary['accountKindAgents'][number]>()
  let totalCostYuan = 0
  let totalCostUsd = 0
  let totalTokens = 0
  for (const e of entries) {
    const toks = (e.inputTokens ?? 0) + (e.outputTokens ?? 0)
    const a = byAgentMap.get(e.agentId) ?? { agentId: e.agentId, agentName: e.agentName, kind: e.kind, tasks: 0, durationMs: 0, costYuan: 0, costUsd: 0, tokens: 0 }
    a.tasks++; a.durationMs += e.durationMs; a.costYuan += e.costYuan ?? 0; a.costUsd += e.costUsd ?? 0; a.tokens += toks
    byAgentMap.set(e.agentId, a)
    totalCostYuan += e.costYuan ?? 0
    totalCostUsd += e.costUsd ?? 0
    totalTokens += toks
    if (e.kind === 'account') {
      const k = acctKindMap.get(e.agentId) ?? { agentId: e.agentId, agentName: e.agentName, tasks: 0, durationMs: 0 }
      k.tasks++; k.durationMs += e.durationMs
      acctKindMap.set(e.agentId, k)
    } else if (e.accountId) {
      const ac = byAccountMap.get(e.accountId) ?? { accountId: e.accountId, accountLabel: e.accountLabel ?? e.accountId, tasks: 0, costYuan: 0, costUsd: 0, tokens: 0 }
      ac.tasks++; ac.costYuan += e.costYuan ?? 0; ac.costUsd += e.costUsd ?? 0; ac.tokens += toks
      byAccountMap.set(e.accountId, ac)
    }
  }
  return {
    totalTasks: entries.length,
    totalCostYuan,
    totalCostUsd,
    totalTokens,
    byAgent: [...byAgentMap.values()].sort((x, y) => y.tasks - x.tasks),
    byAccount: [...byAccountMap.values()],
    accountKindAgents: [...acctKindMap.values()],
  }
}

/** 今日 Agent 归因已记费用（给额度护栏上限检查用） */
export function ledgerSpentSince(entries: AgentLedgerEntry[], sinceMs: number): number {
  return entries.filter(e => e.startedAt >= sinceMs).reduce((s, e) => s + (e.costYuan ?? 0), 0)
}
