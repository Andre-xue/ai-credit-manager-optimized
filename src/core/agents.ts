// Agent 工作台（v0.1.507 一期）：注册表 / 设置（仅本机）/ 派活纯逻辑 / 账本。
// 硬规则：账号登录型用自身账号、免 Key、不记细账；空壳型由魔方供 Key（环境变量注入）、
// 用量打 Agent 归因；额度护栏默认只走免费路线，借付费账户必须人工放行，绝不静默扣费。
import type { Account } from './types'
import { PROVIDER_MAP } from '../data/providers'
import { readLocalStore, writeLocalStore } from './localStore'

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
  /** # 解析的历史别名（如改名前的旧称，用户打旧名也要认） */
  aliases?: string[]
  /** v0.1.509：有官方无头/CLI 通道（第一档）；命令在走无头直派，只有应用走第三档粘贴兜底 */
  headlessCli?: boolean
  /** 多账户：凭据目录环境变量（DSH_HOME / CODEX_HOME）；有值 = 支持按目录隔离多账户 */
  credHomeEnv?: string
  /** v0.1.512（④）：多账户隔离方式——env = 凭据目录变量（DSH/Codex）；
   *  home = 整个 HOME 隔离（Antigravity：agy 无凭据目录变量，但登录按 HOME 隔离，
   *  2026-11-28 真机实证；条目目录即 HOME、状态落其下 .gemini、钥匙串由 App 预建） */
  credIsolation?: 'env' | 'home'
  /** 原生凭据目录（相对 HOME，如 .dsh）；也是登录态探测的基准目录 */
  nativeCredHome?: string
  /** 登录态探测文件（相对凭据目录）；只查在不在，绝不读内容 */
  credProbeFile?: string
  /** 原生目录探测文件缺失的语义：no = 确定未登录；unknown = 读不到（如登录在系统钥匙串） */
  credProbeMissing?: 'no' | 'unknown'
  /** v0.1.517：探测只取凭据目录路径、登录态永不下结论（DSH：.credentials.yaml 在不在
   *  与官方 API 路线能不能派活无关——文件里可能只有别的记录；登录态改看条目 Key
   *  绑定与派活实证，不再拿文件存在性冒充「已登录」） */
  probeInconclusive?: boolean
  /** 装命令的一行指引（只有应用、没命令时在 Agent 管理里提示） */
  cliInstallHint?: string
  /** 新账户条目的登录指引模板（{dir} 替换为隔离凭据目录路径） */
  loginGuide?: string
  /** 不支持多账户时的如实说明（界面展示） */
  multiAccountNote?: string
  /** 一键安装（仅官方路线）：npm 包或官方安装脚本；无 = 不给一键安装（如纯桌面应用） */
  installPlan?: { type: 'npm'; pkg: string } | { type: 'script'; url: string }
  /** 去登录命令原文：原生目录 / 隔离目录（{dir} 替换为凭据目录路径） */
  loginCommandNative?: string
  loginCommandIsolated?: string
}

/** 一键安装的命令拼装（纯函数）：返回给用户确认的完整命令原文与实际执行形式 */
/** v0.1.509（D）：把 CLI/运行时的原始报错翻成人话（失败态规矩：不许英文原文直出）。
 * 命中已知模式返回人话原因；命不中返回 ''（调用方保留原有文案，原始信息仍留在任务输出区供排查）。 */
export function humanizeAgentError(raw: string): string {
  const t = String(raw ?? '')
  if (!t) return ''
  // v0.1.511（⑤）单独成类、v0.1.517 改文案：DSH 走官方 API 路线，MISSING_CREDENTIAL =
  // 凭据存储与启动环境里都没有 DeepSeek API Key。原文带 credentials 字样曾被下面的鉴权
  // 规则误判成「登录失效」——必须先于鉴权规则单独成类，并直接给出两条补 Key 的路。
  if (/MISSING_CREDENTIAL|no API key for provider route/i.test(t)) return 'DSH 还没有可用的 DeepSeek API Key：给条目绑定 Key 管理里的 DeepSeek 账户，或在 DSH 网页版设置→模型里存入 Key 后重试'
  if (/quota|额度|余额不足|insufficient|exceeded your|resource_exhausted/i.test(t)) return '额度或余额不足，对方平台拒绝继续执行'
  if (/rate.?limit|too many requests|\b429\b|限流/i.test(t)) return '被对方平台限流了，需要等一会儿再试'
  if (/env: (node|python3?|bash|sh)\b/.test(t)) return '命令依赖的运行环境没找到（启动路径里缺 node 等运行时）'
  if (/auth|unauthor|\b401\b|登录|not logged in|credentials|sign in/i.test(t)) return '登录态失效或还没登录，需要重新登录'
  if (/command not found|ENOENT|no such file|找不到命令/i.test(t)) return '命令不存在，可能没装好或被移动了'
  if (/ENOTFOUND|ECONN|network|fetch failed|网络/i.test(t)) return '网络连不上对方服务'
  if (/timed? ?out|超时/i.test(t)) return '执行超时被中断'
  if (/unknown option|unexpected argument/i.test(t)) return '本机命令的版本与工作台的调用方式对不上'
  return ''
}

export function buildInstallCommand(def: AgentDef): { display: string; command: string; args: string[]; needsNpm: boolean } | null {
  const plan = def.installPlan
  if (!plan) return null
  if (plan.type === 'npm') {
    return { display: `npm install -g ${plan.pkg}`, command: 'npm', args: ['install', '-g', plan.pkg], needsNpm: true }
  }
  const display = `curl -fsSL ${plan.url} | bash`
  return { display, command: 'bash', args: ['-c', display], needsNpm: false }
}

/** 去登录命令原文（登录由用户本人在官方流程里完成，工作台不经手密码） */
export function loginCommandFor(def: AgentDef, entry: AgentAccountEntry, dirPath: string): string {
  if (entry.credDir === 'isolated') return (def.loginCommandIsolated ?? '').replace('{dir}', dirPath || '<凭据目录>')
  return def.loginCommandNative ?? ''
}

/** 支持多账户（凭据目录可隔离）的 Agent */
export function multiAccountCapable(def: AgentDef): boolean {
  return !!def.credIsolation
}

/** 条目派活时的环境注入（纯函数）：env 型注入凭据目录变量（DSH_HOME / CODEX_HOME）；
 *  home 型隔离条目注入 HOME=<条目目录>；原生条目一律不注入（走用户真实环境）。
 *  dirPath 为空（探测不到目录）时返回空——调用方必须先拦下报错，绝不拿别的目录顶替。 */
export function entryEnvPairs(def: AgentDef, entry: AgentAccountEntry, dirPath: string): Array<[string, string]> {
  if (entry.credDir !== 'isolated' || !dirPath) return []
  if (def.credIsolation === 'home') return [['HOME', dirPath]]
  if (def.credHomeEnv) return [[def.credHomeEnv, dirPath]]
  return []
}

/** v0.1.517：DSH 条目 Key 绑定的环境注入（纯函数）——条目绑了 Key 管理账户且调用方
 *  解出了明文 Key 时，以官方认的环境变量名注入子进程；与 entryEnvPairs 并列叠加，
 *  原生/隔离条目同口径。Key 只进子进程环境：不落盘、不进 UI 文案与日志。 */
export function entryKeyEnvPairs(entry: AgentAccountEntry | undefined, plainKey: string | undefined): Array<[string, string]> {
  if (!entry || entry.keyBinding?.kind !== 'account' || !plainKey) return []
  return [['DEEPSEEK_API_KEY', plainKey]]
}

/** v0.1.517：DSH 条目的配置状态（取代旧「.credentials.yaml 在不在 = 已登录」口径）：
 *  派活成功过（账本实证）→ 已验证；绑了 Key 还没派活成功 → 已绑定 Key · 待派活验证；
 *  什么都没有 → 未配置 Key（仍可派活：用户可能已在 DSH 网页版模型页存过 Key）。 */
export function dshEntryKeyState(
  entry: AgentAccountEntry, hasDoneTask: boolean,
): { state: 'verified' | 'bound' | 'none'; text: string } {
  if (hasDoneTask) return { state: 'verified', text: '已验证' }
  if (entry.keyBinding?.kind === 'account') return { state: 'bound', text: '已绑定 Key · 待派活验证' }
  return { state: 'none', text: '未配置 Key' }
}

export const AGENT_REGISTRY: AgentDef[] = [
  // ---------- 账号登录型（桌面应用，自身账号免 Key） ----------
  {
    id: 'dsh', name: 'DSH', kind: 'account', dispatch: 'open',
    appNames: ['DeepSeek Harness', 'DSH', 'DeepSeek'], bundleIds: [], cliNames: ['dsh'],
    headlessCli: true, credHomeEnv: 'DSH_HOME', credIsolation: 'env', nativeCredHome: '.dsh',
    credProbeFile: '.credentials.yaml', credProbeMissing: 'unknown', probeInconclusive: true,
    installPlan: { type: 'npm', pkg: '@deepseek-ai/dsh' },
    installHint: '装 dsh 命令：终端运行 npm install -g @deepseek-ai/dsh（有命令走无头直派）；或到 deepseek.com/download 装桌面端（macOS 需 Apple 芯片 + macOS 13 以上）',
    cliInstallHint: 'npm install -g @deepseek-ai/dsh',
    // v0.1.517：DSH 0.2.2-rc.5 的账号路线对命令行不可用（登录记录不落 CLI 凭据存储，
    // 2026-11-28 五路验死），派活改走默认 official 路线 + DeepSeek API Key，不再有终端登录命令。
    loginGuide: '给这个条目绑定 Key 管理里的 DeepSeek 账户即可派活（派活时自动注入 Key、不落盘）；或在 DSH 网页版 设置→模型 存入 DeepSeek API Key，二选一；把条目改成所绑 DeepSeek 账户的名字，就不会认错',
  },
  {
    id: 'antigravity', name: 'Antigravity', kind: 'account', dispatch: 'open',
    appNames: ['Antigravity'], bundleIds: [], cliNames: ['agy'],
    headlessCli: true, credIsolation: 'home', nativeCredHome: '.gemini/antigravity-cli',
    credProbeFile: 'antigravity-oauth-token', credProbeMissing: 'unknown',
    installPlan: { type: 'script', url: 'https://antigravity.google/cli/install.sh' },
    loginCommandNative: 'agy', loginCommandIsolated: 'HOME={dir} agy',
    qualification: '已装可接；其内置 Claude 模型官方标注 2026-11-30 下线，之后以 Gemini 为主',
    installHint: '装 agy 命令：按 antigravity.google 的 CLI 安装指引安装（与桌面端同一个 Google 账号、共用登录态）；或到 antigravity.google 下载桌面端并登录',
    cliInstallHint: '按 antigravity.google 的 CLI 安装指引安装 agy 命令',
    loginGuide: '在终端运行 HOME={dir} agy，在打开的界面里用要添加的 Google 账号登录（这个目录的钥匙串已由魔方预建好，不会再弹「找不到钥匙串」）；登录完成后，CLI 界面顶部会显示当前登录的账号，回到这里把条目改成那个名字，就不会认错；最后点「重新检测」',
  },
  {
    id: 'codex-desktop', name: 'Codex', kind: 'account', dispatch: 'open', aliases: ['Codex 桌面端'],
    appNames: ['Codex'], bundleIds: ['com.openai.codex'], cliNames: ['codex'],
    headlessCli: true, credHomeEnv: 'CODEX_HOME', credIsolation: 'env', nativeCredHome: '.codex',
    credProbeFile: 'auth.json', credProbeMissing: 'unknown',
    installPlan: { type: 'npm', pkg: '@openai/codex' },
    loginCommandNative: 'codex login', loginCommandIsolated: 'CODEX_HOME={dir} codex login',
    qualification: '免费档可用（桌面端限量模型）；命令版 codex exec 与桌面端共用同一 ChatGPT 登录',
    installHint: '装 codex 命令：终端运行 npm install -g @openai/codex（有命令走无头直派，与桌面端共用 ~/.codex 登录）；或到 OpenAI 官网下载 Codex 桌面端并登录账号',
    cliInstallHint: 'npm install -g @openai/codex',
    loginGuide: '在终端运行 CODEX_HOME={dir} codex login，登录要添加的账号（该目录已预置 cli_auth_credentials_store = "file"，登录会落到这个目录的 auth.json）；登录完成后，CLI 界面顶部会显示当前登录的账号，回到这里把条目改成那个名字，就不会认错；最后点「重新检测」',
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
    installPlan: { type: 'npm', pkg: '@mariozechner/pi-coding-agent' },
    installHint: '终端运行 npm install -g @mariozechner/pi-coding-agent',
  },
  {
    id: 'opencode', name: 'OpenCode', kind: 'shell', dispatch: 'cli',
    appNames: [], bundleIds: [], cliNames: ['opencode'], selfLogin: true,
    installPlan: { type: 'npm', pkg: 'opencode-ai' },
    installHint: '终端运行 npm install -g opencode-ai（或 brew install opencode）',
  },
  {
    id: 'qwen-code', name: 'Qwen Code', kind: 'shell', dispatch: 'cli',
    appNames: [], bundleIds: [], cliNames: ['qwen'], selfLogin: true,
    installPlan: { type: 'npm', pkg: '@qwen-code/qwen-code' },
    installHint: '终端运行 npm install -g @qwen-code/qwen-code',
  },
  {
    id: 'kimi-code', name: 'Kimi Code', kind: 'shell', dispatch: 'cli',
    appNames: [], bundleIds: [], cliNames: ['kimi'], selfLogin: true,
    installPlan: { type: 'script', url: 'https://code.kimi.com/kimi-code/install.sh' },
    installHint: '官方脚本：curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash（免 Node）；或 npm install -g @moonshot-ai/kimi-code（需 Node 22.19+）',
  },
  {
    id: 'claude-code', name: 'Claude Code', kind: 'shell', dispatch: 'cli',
    appNames: [], bundleIds: [], cliNames: ['claude'], selfLogin: true,
    installPlan: { type: 'npm', pkg: '@anthropic-ai/claude-code' },
    qualification: '免费档不含，需 Pro 订阅或绑定 Anthropic API 账户',
    installHint: '终端运行 npm install -g @anthropic-ai/claude-code',
  },
]

export function agentDef(id: string): AgentDef | undefined {
  return AGENT_REGISTRY.find(a => a.id === id)
}

/** 各 CLI 的非交互派活命令（按各自官方 CLI 约定核实；kimi 的 --print 组合待真机核对）。
 *  sessionId 给定时走各家官方续会话形式（DSH --session-id / Codex exec resume / agy --conversation）。 */
export function buildCliInvocation(
  agentId: string, taskText: string, sessionId?: string,
): { command: string; args: string[] } | null {
  switch (agentId) {
    case 'pi': return { command: 'pi', args: ['-p', taskText] }
    case 'opencode': return { command: 'opencode', args: ['run', taskText] }
    case 'qwen-code': return { command: 'qwen', args: ['-p', taskText] }
    case 'kimi-code': return { command: 'kimi', args: ['--print', '-p', taskText] }
    case 'claude-code': return { command: 'claude', args: ['-p', taskText] }
    // v0.1.509 第一档（官方无头）：flags 必须在任务文本之前。
    // v0.1.517：撤掉 511 的 --patch 账号路线覆盖层——账号路线（deepseek-account）对
    // 0.2.2-rc.5 的命令行不可用（登录记录不落 CLI 凭据存储、无头派活恒报
    // ACCOUNT_SIGN_IN_REQUIRED，2026-11-28 真机五路验死）；改走 headless 档案默认的
    // official 路线，Key 由派活侧以 DEEPSEEK_API_KEY 环境变量注入（或用户在 DSH
    // 网页版模型页存过）。启动器参数（--profile）必须排在 --json 之前。
    case 'dsh': {
      const args = ['--profile', 'headless', '--json']
      if (sessionId) args.push('--session-id', sessionId)
      args.push(taskText)
      return { command: 'dsh', args }
    }
    case 'codex-desktop': return sessionId
      ? { command: 'codex', args: ['exec', 'resume', '--json', '--full-auto', '--skip-git-repo-check', sessionId, taskText] }
      : { command: 'codex', args: ['exec', '--json', '--full-auto', '--skip-git-repo-check', taskText] }
    case 'antigravity': {
      const args = ['--output-format', 'stream-json', '--print-timeout', '30m']
      if (sessionId) args.push('--conversation', sessionId)
      args.push('-p', taskText)
      return { command: 'agy', args }
    }
    default: return null
  }
}

/** 从无头 CLI 的 JSON 事件输出里捕获会话 id（Codex thread.started 的 thread_id；
 *  DSH 开场 session 事件 / agy 结果里的 sessionId / conversation_id 等）。供同账户续跑 resume 用。 */
export function parseSessionId(output: string): string | null {
  for (const line of output.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      const o = JSON.parse(t) as Record<string, unknown>
      if (typeof o.thread_id === 'string' && o.thread_id) return o.thread_id
      for (const k of ['sessionId', 'session_id', 'conversation_id', 'conversationId']) {
        if (typeof o[k] === 'string' && o[k]) return o[k] as string
      }
      if (o.type === 'session' && typeof o.id === 'string' && o.id) return o.id
    } catch { /* 非 JSON 行跳过 */ }
  }
  return null
}

/** 无头接口失败判定（版本差异把 --json/子命令改掉时）：命中才允许降级到第三档粘贴，
 *  额度/登录/任务本身的失败不算接口失败，照常如实报错、不降级掩盖。 */
export function isHeadlessInterfaceFailure(output: string, exitCode: number | null): boolean {
  const tail = output.split('\n').slice(-12).join('\n')
  if (/unknown (command|option|argument|flag)|unexpected argument|unrecognized (option|argument)|invalid option|no such command|command not found/i.test(tail)) return true
  if (exitCode === 2 && /usage:/i.test(tail)) return true
  return false
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
  /** 接力：链顺序 + 模式（v0.1.508 起执行） */
  relay: { chain: string[]; mode: 'auto' | 'ask' }
  /** 主控与审查（v0.1.508 起执行）：主控拆活 + 交叉审查 */
  master: { masterAgentId: string; crossReview: boolean; reviewerAgentId: string }
  /** 桌面型自动送达（v0.1.509）：粘贴后是否连回车一起自动发送（默认关） */
  delivery: { autoSend: boolean }
  /** 多账户条目（v0.1.509）：支持隔离的 Agent（DSH / Codex 凭据目录、Antigravity 整个 HOME）有条目 */
  accounts: AgentAccountEntry[]
  /** v0.1.511（②）：登录态读不到（凭据在系统钥匙串）的 Agent 首次派活成功的时间戳。
   *  探测永远只能报 unknown，靠真实派活成功落「已验证」标记，免得界面常年挂着像没登录。 */
  verifiedAgents?: Record<string, number>
  /** v0.1.516：Agent 管理页签行里被隐藏的平台 id（仅本机偏好，随本设置一同存本机文件）。
   *  隐藏只是不在设置页显示：不停用、不删数据，不影响检测、派活与记账。 */
  hiddenPlatforms?: string[]
}

/** 标记某 Agent 已由真实派活验证过登录可用（幂等：已有标记不覆盖，保留首次时间） */
export function markAgentVerified(s: AgentSettings, agentId: string, now: number): AgentSettings {
  if (s.verifiedAgents?.[agentId]) return s
  return { ...s, verifiedAgents: { ...(s.verifiedAgents ?? {}), [agentId]: now } }
}

/** 条目/单账户的登录态展示文案（v0.1.511 ②）：unknown 不再说「读不到」——
 *  凭据由系统钥匙串保管、魔方按设计不读；有派活成功标记时直接报已验证。 */
export function loginStateText(
  login: 'yes' | 'no' | 'unknown' | undefined,
  opts?: { probeMissing?: 'no' | 'unknown'; verifiedAt?: number },
): string {
  if (login === 'yes') return '已登录'
  if (login === 'no') return '未登录'
  if (login === 'unknown') {
    if (opts?.verifiedAt) return '已验证（派活成功）'
    if (opts?.probeMissing === 'unknown') return '钥匙串保管，魔方读不到'
    return '读不到'
  }
  return '检测中…'
}

/** Agent × 账户条目：独立开关 / 独立凭据目录 / 独立记账。凭据只存用户本机登录产生的文件，App 不收集密码。 */
export interface AgentAccountEntry {
  id: string
  agentId: string
  label: string
  /** v0.1.515：用户自定的显示名（多账户后靠它分清谁是谁）。只改展示，不动 id / 凭据目录 / 记账归因；未设或清空时回落 label */
  customLabel?: string
  /** v0.1.515：派活事件流初始化事件自带的账号身份，只存打码形态（原始邮箱不落盘）。
   *  2026-11-28 查证三家当前事件流均无身份字段（见 agentOutput.parseCliIdentity），故恒为空、条目行不显示。 */
  identity?: string
  /** native = 用户原生凭据目录（复用现有登录）；isolated = ~/.ai-credit-manager/agents/creds/<agent>/<id> */
  credDir: 'native' | 'isolated'
  /** v0.1.517（DSH 专用）：条目级 Key 绑定——复用 KeyBinding 数据结构，绑定对象限定
   *  Key 管理里的 DeepSeek 平台账户；派活时把该账户的 Key 以 DEEPSEEK_API_KEY 注入
   *  子进程环境（不落盘）。其它 Agent 的条目不设此字段。 */
  keyBinding?: KeyBinding
  enabled: boolean
  lastUsedAt?: number
  createdAt: number
}

/** 条目展示名：改过名用改的名，没改/清空回落默认名 label（三处展示统一走这里） */
export function entryDisplayName(e: AgentAccountEntry): string {
  const c = e.customLabel?.trim()
  return c ? c : e.label
}

/** 给条目改名：name 去空白后为空 = 清除自定义名、回落默认名；没变化返回原 settings（引用不变） */
export function renameAccountEntry(s: AgentSettings, entryId: string, name: string): AgentSettings {
  const next = name.trim() || undefined
  let changed = false
  const accounts = s.accounts.map(e => {
    if (e.id !== entryId || (e.customLabel ?? undefined) === next) return e
    changed = true
    return { ...e, customLabel: next }
  })
  return changed ? { ...s, accounts } : s
}

/** v0.1.518：删除隔离条目的二次确认文案（纯函数）：说清删的是卡 + 本机登录文件、
 *  账号本身不受影响、重新添加要重新登录 */
export function entryDeleteConfirmText(e: AgentAccountEntry): string {
  return `删除账户卡「${entryDisplayName(e)}」？它在本机的登录文件会一并删掉（账号本身不受影响，在别处照常能用），删除后重新添加需要重新登录一次。`
}

/** v0.1.518：删除隔离条目的结果提示（纯函数）：目录删成功 = 卡与登录文件都删了；
 *  删失败 = 卡仍移除（设置记录不留半截），但如实提示登录文件还在、位置在哪，不许静默 */
export function entryDeleteNotice(e: AgentAccountEntry, dirDeleted: boolean, dirPath: string): string {
  const name = entryDisplayName(e)
  if (dirDeleted) return `已删除账户卡「${name}」，它在本机的登录文件也一并删掉了`
  return `账户卡「${name}」已删除，但它在本机的登录文件没能删掉${dirPath ? `，位置在 ${dirPath}` : ''}，可以手动删掉那个文件夹`
}

/** 把派活查到的打码身份存到条目上（与现值相同返回原 settings） */
export function setEntryIdentity(s: AgentSettings, entryId: string, identity: string): AgentSettings {
  let changed = false
  const accounts = s.accounts.map(e => {
    if (e.id !== entryId || e.identity === identity) return e
    changed = true
    return { ...e, identity }
  })
  return changed ? { ...s, accounts } : s
}

export const nativeEntryId = (agentId: string) => `native-${agentId}`

/** 归一化账户条目：给每个多账户 Agent 补上「默认（现有登录）」原生条目（幂等） */
export function normalizeAccountEntries(raw: unknown): AgentAccountEntry[] {
  const arr = Array.isArray(raw)
    ? (raw as AgentAccountEntry[]).filter(e => e && typeof e.id === 'string' && typeof e.agentId === 'string' && (e.credDir === 'native' || e.credDir === 'isolated'))
    : []
  const natives: AgentAccountEntry[] = []
  for (const def of AGENT_REGISTRY) {
    if (!multiAccountCapable(def)) continue
    if (!arr.some(e => e.agentId === def.id && e.credDir === 'native')) {
      natives.push({ id: nativeEntryId(def.id), agentId: def.id, label: '默认（现有登录）', credDir: 'native', enabled: true, createdAt: 0 })
    }
  }
  return [...natives, ...arr]
}

const ENTRY_LETTERS = 'ABCDEFGH'

/** 新建隔离条目（标签自动按 账号A / 账号B… 递增） */
export function makeAccountEntry(agentId: string, existing: AgentAccountEntry[], now: number): AgentAccountEntry {
  const isolated = existing.filter(e => e.agentId === agentId && e.credDir === 'isolated')
  const label = `账号${ENTRY_LETTERS[isolated.length] ?? String(isolated.length + 1)}`
  return { id: `ent-${agentId}-${now.toString(36)}-${isolated.length}`, agentId, label, credDir: 'isolated', enabled: true, createdAt: now }
}

/** 最久未用优先（额度信息读不到时就按这个选，不编造额度）：lastUsedAt 小者先；同值原生条目优先、再按创建序 */
export function pickEntryLru(entries: AgentAccountEntry[]): AgentAccountEntry | undefined {
  const en = entries.filter(e => e.enabled)
  if (!en.length) return undefined
  return [...en].sort((a, b) =>
    (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0)
    || (a.credDir === 'native' ? 0 : 1) - (b.credDir === 'native' ? 0 : 1)
    || a.createdAt - b.createdAt)[0]
}

/** 登录指引填入实际目录路径 */
export function fillLoginGuide(def: AgentDef, dirPath: string): string {
  return (def.loginGuide ?? '').replace('{dir}', dirPath || '<凭据目录>')
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
    master: { masterAgentId: '', crossReview: false, reviewerAgentId: '' },
    delivery: { autoSend: false },
    accounts: normalizeAccountEntries(undefined),
    hiddenPlatforms: [],
  }
}

export function loadAgentSettings(): AgentSettings {
  const base = defaultAgentSettings()
  try {
    const raw = readLocalStore('agents-settings')
    if (!raw) return base
    const p = JSON.parse(raw) as Partial<AgentSettings>
    return {
      enabled: p.enabled ?? {},
      bindings: p.bindings ?? {},
      quota: { ...base.quota, ...(p.quota ?? {}) },
      parallel: { maxParallel: Math.min(5, Math.max(1, p.parallel?.maxParallel ?? 3)) },
      vault: { ...base.vault, ...(p.vault ?? {}) },
      relay: { chain: Array.isArray(p.relay?.chain) ? p.relay!.chain : [], mode: p.relay?.mode === 'auto' ? 'auto' : 'ask' },
      master: { masterAgentId: p.master?.masterAgentId ?? '', crossReview: !!p.master?.crossReview, reviewerAgentId: p.master?.reviewerAgentId ?? '' },
      delivery: { autoSend: !!p.delivery?.autoSend },
      accounts: normalizeAccountEntries(p.accounts),
      verifiedAgents: (p.verifiedAgents && typeof p.verifiedAgents === 'object' && !Array.isArray(p.verifiedAgents))
        ? p.verifiedAgents : {},
      hiddenPlatforms: Array.isArray(p.hiddenPlatforms)
        ? p.hiddenPlatforms.filter((x): x is string => typeof x === 'string') : [],
    }
  } catch { return base }
}

export function saveAgentSettings(s: AgentSettings): void {
  writeLocalStore('agents-settings', JSON.stringify(s))
}

// ---------------- 派活卡草稿（v0.1.519 ①） ----------------
// 派活卡的输入原本只是组件 useState：切换模块组件卸载就全清（2026-11-28 录屏实证）。
// 草稿独立存一份文件存储（agents-draft），与设置分开：改草稿不惊动设置保存链。

export interface AgentDispatchDraft {
  input: string
  targetAgent: string
  entryPick: string
  workdir: string
  heavyMode: 'auto' | 'heavy' | 'light'
  outsideOk: boolean
}

/** 没有草稿时的初始值：工作目录取设置里的默认工作目录，其余取派活卡出厂态 */
export function defaultDispatchDraft(settingsWorkdir: string): AgentDispatchDraft {
  return { input: '', targetAgent: 'auto', entryPick: 'auto', workdir: settingsWorkdir, heavyMode: 'auto', outsideOk: false }
}

export function loadDispatchDraft(): AgentDispatchDraft | null {
  try {
    const raw = readLocalStore('agents-draft')
    if (!raw) return null
    const p = JSON.parse(raw) as Partial<AgentDispatchDraft>
    if (!p || typeof p !== 'object') return null
    return {
      input: typeof p.input === 'string' ? p.input : '',
      targetAgent: typeof p.targetAgent === 'string' && p.targetAgent ? p.targetAgent : 'auto',
      entryPick: typeof p.entryPick === 'string' && p.entryPick ? p.entryPick : 'auto',
      workdir: typeof p.workdir === 'string' ? p.workdir : '',
      heavyMode: p.heavyMode === 'heavy' || p.heavyMode === 'light' ? p.heavyMode : 'auto',
      outsideOk: !!p.outsideOk,
    }
  } catch { return null }
}

export function saveDispatchDraft(d: AgentDispatchDraft): void {
  writeLocalStore('agents-draft', JSON.stringify(d))
}

/**
 * 草稿恢复优先级（519 单测口径）：有草稿 → 全部字段以草稿为准（包括被用户
 * 清空的工作目录，不许拿默认值把清空的又填回来）；没草稿 → 默认值。
 */
export function resolveDispatchDraft(draft: AgentDispatchDraft | null, settingsWorkdir: string): AgentDispatchDraft {
  return draft ?? defaultDispatchDraft(settingsWorkdir)
}

// ---------------- 检测结果 ----------------

export interface AgentDetectResult {
  id: string
  installed: boolean
  via: string
  path: string
  /** v0.1.509 双通道：桌面应用路径 / CLI 命令路径 / CLI 版本行（旧数据缺失时按 via 兜底） */
  appPath?: string
  cliPath?: string
  cliVersion?: string
}

export function detectHasCli(det: AgentDetectResult | undefined): boolean {
  if (!det?.installed) return false
  if (typeof det.cliPath === 'string') return det.cliPath.length > 0
  return det.via === 'cli'
}

export function detectHasApp(det: AgentDetectResult | undefined): boolean {
  if (!det?.installed) return false
  if (typeof det.appPath === 'string') return det.appPath.length > 0
  return det.via === 'app'
}

/** 有效派活通道：第一档 = 官方无头/CLI；第三档 = 打开应用 + 粘贴送达（兜底）。
 *  桌面 App 在不在不影响档位——命令在就是第一档。 */
export function effectiveDispatch(def: AgentDef, det: AgentDetectResult | undefined): AgentDispatch | null {
  if (!det?.installed) return null
  if (def.dispatch === 'cli') return 'cli'
  if (def.headlessCli && detectHasCli(det)) return 'cli'
  if (detectHasApp(det)) return 'open'
  return null
}

export type DispatchTier = 1 | 3

export function dispatchTier(def: AgentDef, det: AgentDetectResult | undefined): DispatchTier | null {
  const d = effectiveDispatch(def, det)
  return d === 'cli' ? 1 : d === 'open' ? 3 : null
}

export function tierLabel(tier: DispatchTier): string {
  return tier === 1 ? '无头直派' : '粘贴送达（兜底）'
}

// ---------------- 可用性判定（纯函数） ----------------

export type AgentAvailState = 'not-installed' | 'disabled' | 'blocked' | 'ready'
export interface AgentAvailability { state: AgentAvailState; reason: string }

export function agentAvailability(
  def: AgentDef,
  detect: AgentDetectResult | undefined,
  settings: AgentSettings,
  accounts: Account[],
  entries?: AgentAccountEntry[],
): AgentAvailability {
  if (!detect?.installed) return { state: 'not-installed', reason: def.installHint }
  if (!settings.enabled[def.id]) return { state: 'disabled', reason: '已安装，未启用（到设置 · Agent 管理打开）' }
  if (def.kind === 'account') {
    // 检测口径（v0.1.509 Ethan 定）：无头三家的就绪只认 CLI 命令在不在——桌面应用在、
    // 命令不在 = 未安装（桌面应用仅是第三档粘贴兜底的存在条件，不算就绪）
    if (def.headlessCli && !detectHasCli(detect)) {
      return {
        state: 'not-installed',
        reason: detectHasApp(detect)
          ? `桌面应用已装，但 ${def.cliNames[0]} 命令未安装：无头型派活只走命令、不降级粘贴，先一键安装命令再派活`
          : def.installHint,
      }
    }
    if (entries && multiAccountCapable(def) && !entries.some(e => e.agentId === def.id && e.enabled)) {
      return { state: 'blocked', reason: '账户条目都已停用（到设置 · Agent 管理启用至少一个账户）' }
    }
    if (def.headlessCli) {
      // v0.1.517：DSH 例外——走官方 API 路线、需要 DeepSeek API Key（条目绑定自动注入，
      // 或用户在 DSH 网页版模型页存过），不再是「自身登录免 Key」
      if (def.id === 'dsh') {
        return { state: 'ready', reason: '无头直派（dsh 命令）· 走 DeepSeek 官方 API：条目绑定的 Key 自动注入，或用 DSH 网页版里存过的 Key' }
      }
      return { state: 'ready', reason: `无头直派（${def.cliNames[0]} 命令）· 使用自身登录账号，免 Key` }
    }
    return { state: 'ready', reason: '使用自身登录账号（免 Key）' }
  }
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
    .flatMap(a => [{ id: a.id, key: a.name }, { id: a.id, key: a.id }, ...(a.aliases ?? []).map(al => ({ id: a.id, key: al }))])
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
  type UsageShape = { input_tokens?: number; output_tokens?: number }
  const lines = output.split('\n').map(l => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      // v0.1.515：agy 的 usage 嵌在 result.usage / step_update.usage 里（不是顶层），一并认；
      // 从尾行往前找，agy 的 result 行在最后、装的是全程总量，先命中它
      const j = JSON.parse(lines[i]) as {
        usage?: UsageShape; total_cost_usd?: number
        result?: { usage?: UsageShape }; step_update?: { usage?: UsageShape }
      }
      if (j && typeof j === 'object') {
        const usage = j.usage ?? j.result?.usage ?? j.step_update?.usage
        if (usage) {
          return {
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            costUsd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : 0,
          }
        }
      }
    } catch { /* 非 JSON 行跳过 */ }
  }
  return null
}

// ---------------- 任务与账本（仅本机存储） ----------------

export type AgentTaskStatus =
  | 'queued' | 'queued-heavy' | 'waiting-approval' | 'running' | 'manual' | 'done' | 'failed' | 'stopped'
  /** v0.1.508：接力询问模式下停住等用户确认换人 */
  | 'waiting-relay'
  /** v0.1.508：接力链走完无人可接（或派生任务无可用执行者/已达上限），等人处理 */
  | 'unresolved'

/** 交叉审查在任务卡上的状态（v0.1.508） */
export type AgentReviewState =
  | { state: 'running'; reviewerName: string }
  | { state: 'pass' | 'issues'; reviewerName: string; points: string }
  | { state: 'failed'; reviewerName?: string; reason: string }

/** 接力询问模式的确认卡数据（v0.1.508） */
export interface RelayProposal {
  candidateId: string
  candidateName: string
  reason: string
  skipped: Array<{ agentName: string; reason: string }>
  changedFiles: number
}

/** 桌面型自动送达状态（v0.1.509）：只记如实结果，失败态都带可手动 ⌘V 的回落文案 */
export interface AgentDeliveryState {
  state: 'copied' | 'delivering' | 'pasted' | 'sent' | 'no-permission' | 'timeout' | 'mismatch' | 'no-input' | 'failed'
  note: string
  at: number
}

export interface AgentTask {
  id: string
  text: string
  /** 展示标题（接力任务为「原标题（续）」、主控子任务为子任务标题）；缺省时卡片直接显示 text */
  title?: string
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
  /** v0.1.508 接力：本任务接自哪个任务 / 已接力给哪个任务 / 接力原因 */
  relayFromId?: string
  relayToId?: string
  relayReason?: string
  /** 接力询问模式：待确认的接力方案（status = waiting-relay 时有值） */
  relayProposal?: RelayProposal
  /** 进入 waiting-relay 之前的原状态（用户点「不接力」时恢复） */
  relayFromStatus?: AgentTaskStatus
  /** v0.1.508 主控拆活：本任务是拆活请求时，值为用户原始目标文本；子任务带同一 planGroupId */
  planFor?: string
  planGroupId?: string
  /** v0.1.508 交叉审查 */
  review?: AgentReviewState
  /** v0.1.509 桌面型自动送达（仅 dispatch=open 的任务有） */
  delivery?: AgentDeliveryState
  /** v0.1.509 本任务实际走的派活通道与档位（1 = 无头直派 / 3 = 粘贴送达兜底），卡片如实标注 */
  dispatch?: AgentDispatch
  tier?: DispatchTier
  /** v0.1.509 无头会话 id（从 JSON 事件输出捕获，同账户续跑时走 resume） */
  sessionId?: string
  /** v0.1.509 多账户：本任务用的账户条目（仅 DSH / Codex 等可隔离凭据的 Agent） */
  accountEntryId?: string
  accountEntryLabel?: string
  /** v0.1.509（A–D）：已被交接/接力——原卡只读保留，不再给收尾动作 */
  handedOver?: boolean
  /** v0.1.509（A–D）：本任务被 # 面板「审查」命令或交接指定强制交叉审查 */
  forceReview?: boolean
  /** v0.1.509（A–D）：交接时指定的模型展示名（能否真正生效看接棒者，卡上如实标注） */
  handoverModel?: string
  /** 交接指定模型命中的自有账户引擎 id（仅空壳型绑定同一账户时注入 env 真生效） */
  handoverEngineId?: string
  /** v0.1.512（②）赛马：同组两件任务共享 raceId、槽位 A/B；raceRepo 为原仓库目录，
   *  开跑时各自建 worktree（raceWorktree / raceBranch），workdir 随之改为 worktree 路径 */
  raceId?: string
  raceSlot?: 'A' | 'B'
  raceRepo?: string
  raceBranch?: string
  raceWorktree?: string
  /** 赛马交叉审查结论（对手审本任务产出的结论，复用审查状态结构） */
  raceReview?: AgentReviewState
  /** 赛马结局：winner = 胜出已合并；loser = 落选已清理 */
  raceOutcome?: 'winner' | 'loser'
}

export const AGENT_TASKS_KEY = 'acm.agents.tasks.v1'

export function loadAgentTasks(): AgentTask[] {
  try {
    const raw = readLocalStore('agents-tasks')
    if (!raw) return []
    const arr = JSON.parse(raw) as AgentTask[]
    if (!Array.isArray(arr)) return []
    // 上次进程退出时仍在运行/排队的任务不可能还活着：如实标成已中断
    return arr.map(t => {
      const base = (t.status === 'running' || t.status === 'queued' || t.status === 'queued-heavy')
        ? { ...t, status: 'stopped' as AgentTaskStatus, note: 'App 已退出，任务中断' }
        : t
      // 送达进行中被 App 退出打断：不能留着「正在粘贴」的假状态，如实标中断
      if (base.delivery?.state === 'delivering') {
        return {
          ...base,
          delivery: {
            state: 'failed' as const, at: base.delivery.at,
            note: 'App 已退出，自动送达中断；任务文本可点「复制任务」重新复制后到应用里 ⌘V',
          },
        }
      }
      return base
    })
  } catch { return [] }
}

export function saveAgentTasks(tasks: AgentTask[]): void {
  writeLocalStore('agents-tasks', JSON.stringify(tasks.slice(0, 100)))
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
  /** v0.1.509 多账户条目归因（DSH / Codex 的账户条目，独立记任务数/时长） */
  agentEntryId?: string
  agentEntryLabel?: string
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
    const raw = readLocalStore('agents-ledger')
    const arr = raw ? JSON.parse(raw) as AgentLedgerEntry[] : []
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}

export function saveAgentLedger(entries: AgentLedgerEntry[]): void {
  writeLocalStore('agents-ledger', JSON.stringify(entries.slice(0, 500)))
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
