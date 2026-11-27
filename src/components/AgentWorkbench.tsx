import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot, Play, Square, Copy, Trash2, ShieldAlert, FolderLock, Settings2, LayoutList,
  CheckCircle2, XCircle, Clock3, Hourglass, Hand, ExternalLink, Repeat, ClipboardCheck,
  History, Trophy, Swords,
} from 'lucide-react'
import type { Account } from '../core/types'
import {
  AGENT_REGISTRY, agentDef, agentAvailability, buildCliInvocation, humanizeAgentError, buildShellEnv,
  parseDelegation, pickStartable, isHeavyTask, quotaGate, capCheck, parseCliUsage,
  loadAgentSettings, saveAgentSettings, loadAgentTasks, saveAgentTasks,
  loadAgentLedger, saveAgentLedger, summarizeLedger, ledgerSpentSince,
  effectiveDispatch, multiAccountCapable, pickEntryLru, fillLoginGuide,
  parseSessionId, tierLabel, nativeEntryId,
  markAgentVerified, loginStateText, entryEnvPairs,
  type AgentDef, type AgentSettings, type AgentTask, type AgentLedgerEntry, type AgentDetectResult,
  type AgentAccountEntry,
} from '../core/agents'
import {
  classifyRelayFailure, pickRelayCandidate, buildRelayContextPack, relayTitle,
  buildMasterPrompt, parseMasterPlan, resolvePlanAgent, buildReviewPrompt, parseReviewVerdict,
} from '../core/agentRelay'
import {
  agentDetect, agentLaunchApp, agentRunStart, agentRunPoll, agentRunStop, agentClipboardWrite,
  agentVaultBaseline, agentVaultPoll, agentVaultList, agentVaultRestore, agentVaultDeleteEntries, agentVaultPrune,
  agentVaultStats, agentVaultDeleteBaseline, agentAccountsProbe, agentDshAccountPatch,
  entryProbeIn, agentAgyUnlockKeychain, agentGitInfo, agentWorktreeAdd, agentWorktreeDiff,
  type VaultStatsResult, type AgentAccountStatus, type AgentAccountProbeIn,
} from '../core/agentBridge'
import {
  pickRaceCandidates, raceSpeed, raceFreeShare, last7DaysTrend,
  type RaceCandidateInput,
} from '../core/agentRace'
import { AgentSessionsPanel, type SessionImportPayload } from './AgentSessionsPanel'
import { AgentRaceCompare } from './AgentRaceCompare'
import { parseCliOutput } from '../core/agentOutput'
import { runDelivery, deliveryPresentation, deliveryChipLabel, createBridgeDeliveryProvider } from '../core/agentDelivery'
import { WORKSHOP_SKILLS, buildSkillTaskText, type WorkshopSkill } from '../core/workshopSkills'
import { buildUsageView, buildModelChoices } from '../core/agentUsageView'
import { loadProbeStore } from '../core/probeCenter'
import { onLocalStoreHydrated } from '../core/localStore'
import {
  formatBytes, formatDuration, mergeVaultUsage, loadPruneLog, savePruneLog,
  type VaultEntry, type VaultPruneLog,
} from '../core/agentVault'
import { isDesktopApp } from '../core/openExternal'
import { decryptSecret } from '../core/crypto'
import { enginesFor } from '../data/engines'
import { PROVIDER_MAP } from '../data/providers'
import { AgentSettingsPanel } from './AgentSettingsPanel'

type View = 'board' | 'vault' | 'settings' | 'sessions' | 'compare'

const STATUS_META: Record<AgentTask['status'], { label: string; cls: string }> = {
  queued: { label: '排队', cls: 'q' },
  'queued-heavy': { label: '排队等重活锁', cls: 'q' },
  'waiting-approval': { label: '等你放行', cls: 'wait' },
  'waiting-relay': { label: '等你确认接力', cls: 'wait' },
  running: { label: '运行中', cls: 'run' },
  manual: { label: '已打开 · 待粘贴', cls: 'man' },
  done: { label: '完成', cls: 'done' },
  failed: { label: '失败', cls: 'fail' },
  stopped: { label: '已停止', cls: 'stop' },
  unresolved: { label: '待处理', cls: 'unres' },
}

interface ReviewRun {
  runId: string
  cursor: number
  output: string[]
  reviewerId: string
  reviewerName: string
  kind: 'account' | 'shell'
  entryId?: string
  entryLabel?: string
  startedAt: number
}

let uidSeq = 0
const uid = () => `task-${Date.now()}-${++uidSeq}`

export function AgentWorkbench({ accounts, sessionPwd, notify }: {
  accounts: Account[]
  sessionPwd: string
  notify: (m: string, kind?: 'ok' | 'err') => void
}) {
  const desktop = isDesktopApp()
  const [view, setView] = useState<View>('board')
  const [settings, setSettings] = useState<AgentSettings>(() => loadAgentSettings())
  const [detectMap, setDetectMap] = useState<Record<string, AgentDetectResult>>({})
  const [tasks, setTasks] = useState<AgentTask[]>(() => loadAgentTasks())
  const [ledger, setLedger] = useState<AgentLedgerEntry[]>(() => loadAgentLedger())
  const [vaultEntries, setVaultEntries] = useState<VaultEntry[]>([])
  const [vaultStats, setVaultStats] = useState<VaultStatsResult>({ totalBytes: 0, baselines: [] })
  const [pruneLog, setPruneLog] = useState<VaultPruneLog | null>(() => loadPruneLog())
  const [cleanConfirmId, setCleanConfirmId] = useState<string | null>(null)
  const [accountStatus, setAccountStatus] = useState<Record<string, AgentAccountStatus>>({})
  const [entryPick, setEntryPick] = useState<string>('auto')
  // v0.1.509（A–D）：# 面板原生命令/技能的待生效选择、交接弹窗、用量弹层
  const [pendingReview, setPendingReview] = useState(false)
  const [skillPick, setSkillPick] = useState<WorkshopSkill | null>(null)
  const [handoverFor, setHandoverFor] = useState<AgentTask | null>(null)
  const [hovKey, setHovKey] = useState('')
  const [hovModelId, setHovModelId] = useState('')
  const [usageOpen, setUsageOpen] = useState(false)
  const usage = useMemo(() => buildUsageView(ledger, loadProbeStore()), [ledger])
  // v0.1.512（②）：赛马模式与付费放行面板、对比层定位
  const [raceMode, setRaceMode] = useState(false)
  const [raceNotice, setRaceNotice] = useState<{ text: string; plain?: boolean } | null>(null)
  const [raceApproval, setRaceApproval] = useState<{
    text: string; repo: string
    chosen: Array<RaceCandidateInput & { speed: { basis: string } }>
    needsApproval: Array<RaceCandidateInput & { speed: { basis: string } }>
  } | null>(null)
  const [compareRaceId, setCompareRaceId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [targetAgent, setTargetAgent] = useState<string>('auto')
  const [workdir, setWorkdir] = useState(() => loadAgentSettings().vault.workdir)
  const [heavyMode, setHeavyMode] = useState<'auto' | 'heavy' | 'light'>('auto')
  const [outsideOk, setOutsideOk] = useState(false)
  const [, setNowTick] = useState(0)

  const tasksRef = useRef(tasks)
  tasksRef.current = tasks
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const accountsRef = useRef(accounts)
  accountsRef.current = accounts
  const sessionPwdRef = useRef(sessionPwd)
  sessionPwdRef.current = sessionPwd
  const detectMapRef = useRef(detectMap)
  detectMapRef.current = detectMap
  const accountStatusRef = useRef(accountStatus)
  accountStatusRef.current = accountStatus
  const ledgerRef = useRef(ledger)
  ledgerRef.current = ledger
  const vaultEntriesRef = useRef(vaultEntries)
  vaultEntriesRef.current = vaultEntries
  const reviewRunsRef = useRef(new Map<string, ReviewRun>())
  // v0.1.512（②）：赛马交叉审查的运行表（key = 被审任务 id）与已发起标记（防重复发起）
  const raceReviewRunsRef = useRef(new Map<string, ReviewRun>())
  const raceReviewStartedRef = useRef(new Set<string>())
  const cursorsRef = useRef(new Map<string, number>())
  const outputsRef = useRef(new Map<string, string[]>())
  const startingRef = useRef(new Set<string>())
  const stoppedRef = useRef(new Set<string>())
  const baselinedRef = useRef(new Set<string>())
  const vaultPolledAtRef = useRef(new Map<string, number>())
  const sessionStartRef = useRef(Date.now())

  useEffect(() => { setEntryPick('auto') }, [targetAgent])
  useEffect(() => { saveAgentSettings(settings) }, [settings])
  useEffect(() => { saveAgentTasks(tasks) }, [tasks])
  useEffect(() => { saveAgentLedger(ledger) }, [ledger])

  // v0.1.510：文件层对账完成后重读三份数据 + 清理记录——首屏先用 localStorage
  // 镜像渲染，文件（事实源）到达后纠正，更新重置存储时靠这一步恢复开关/任务/账本
  useEffect(() => onLocalStoreHydrated(() => {
    setSettings(loadAgentSettings())
    setTasks(loadAgentTasks())
    setLedger(loadAgentLedger())
    setPruneLog(loadPruneLog())
    setWorkdir(loadAgentSettings().vault.workdir)
  }), [])

  const updateTask = useCallback((id: string, patch: Partial<AgentTask>) => {
    setTasks(prev => prev.map(t => (t.id === id ? { ...t, ...patch } : t)))
  }, [])

  // v0.1.511（⑤）：DSH 账号路线覆盖层路径——首次派 dsh 的活时向 Rust 懒取一次并缓存
  const dshPatchRef = useRef('')
  const ensureDshPatch = useCallback(async (): Promise<string> => {
    if (!dshPatchRef.current) {
      try { dshPatchRef.current = await agentDshAccountPatch() } catch { dshPatchRef.current = '' }
    }
    return dshPatchRef.current
  }, [])

  const addLedger = useCallback((e: AgentLedgerEntry) => {
    setLedger(prev => [e, ...prev].slice(0, 500))
  }, [])

  const refreshVault = useCallback(async () => {
    const [list, stats] = await Promise.all([agentVaultList(), agentVaultStats()])
    setVaultEntries(list)
    setVaultStats(stats)
  }, [])

  /** 执行清理并把结果记一行（视图里展示最近一次清理记录） */
  const runPrune = useCallback(async (trigger: string) => {
    const s = settingsRef.current
    const removed = await agentVaultPrune(s.vault.retentionDays, s.vault.capGB * 1024 * 1024 * 1024)
    if (removed > 0) {
      const rec = { at: Date.now(), removed, trigger }
      savePruneLog(rec)
      setPruneLog(rec)
    }
    void refreshVault()
    return removed
  }, [refreshVault])

  const runDetect = useCallback(async () => {
    if (!desktop) return
    const results = await agentDetect(AGENT_REGISTRY.map(a => ({
      id: a.id, appNames: a.appNames, bundleIds: a.bundleIds, cliNames: a.cliNames,
    })))
    const map: Record<string, AgentDetectResult> = {}
    for (const r of results) map[r.id] = r
    setDetectMap(map)
    // 多账户条目登录态探测（只查凭据文件/状态目录在不在）；无条目的单账户 Agent 用合成原生条目探测
    const probes: AgentAccountProbeIn[] = []
    for (const e of settingsRef.current.accounts) {
      const d = agentDef(e.agentId)
      if (d) { const p = entryProbeIn(d, e); if (p) probes.push(p) }
    }
    for (const d of AGENT_REGISTRY) {
      if (!multiAccountCapable(d)) {
        const p = entryProbeIn(d, { id: nativeEntryId(d.id), credDir: 'native' })
        if (p) probes.push(p)
      }
    }
    if (probes.length) {
      const statuses = await agentAccountsProbe(probes)
      const smap: Record<string, AgentAccountStatus> = {}
      for (const st of statuses) smap[st.entryId] = st
      setAccountStatus(smap)
    }
  }, [desktop])

  useEffect(() => {
    if (!desktop) return
    void runDetect()
    void refreshVault()
    void runPrune('启动自动清理')
  }, [desktop, runDetect, refreshVault, runPrune])

  // 运行中任务的耗时刷新
  useEffect(() => {
    const t = window.setInterval(() => {
      if (tasksRef.current.some(x => x.status === 'running')) setNowTick(n => n + 1)
    }, 1000)
    return () => window.clearInterval(t)
  }, [])

  /** 供 Key 环境构建（派活与审查共用）：绑定账户时解密注入，Key 只进子进程环境变量 */
  const buildRunEnv = useCallback(async (def: AgentDef, st: AgentSettings, modelOverride?: string): Promise<{ envPairs: Array<[string, string]> } | { error: string }> => {
    const binding = st.bindings[def.id]
    if (binding?.kind === 'account') {
      const acct = accountsRef.current.find(a => a.id === binding.accountId)
      if (!acct?.encryptedKey) return { error: '绑定的账户不存在或没有 Key，已取消派活' }
      const pwd = sessionPwdRef.current
      if (!pwd) return { error: '保险箱未解锁，取不出绑定账户的 Key：请先到「API Key 管理」页解锁，再重新派发' }
      let plain = ''
      try { plain = await decryptSecret(acct.encryptedKey, pwd) } catch { return { error: '解密绑定账户的 Key 失败，已取消派活' } }
      const modelId = modelOverride ?? enginesFor(acct.providerId)[0]?.id
      return { envPairs: Object.entries(buildShellEnv(binding, acct, plain, modelId)) }
    }
    return { envPairs: Object.entries(buildShellEnv(binding, undefined, undefined)) }
  }, [])

  /** 多账户条目解析：定条目 + 凭据目录环境变量。未登录（探测确定）/ 读不到隔离目录时给出 error，
   *  绝不拿其他账户顶替——用错账户比停住更糟。 */
  const resolveEntryCred = useCallback((def: AgentDef, preferredEntryId?: string):
    { entry?: AgentAccountEntry; pairs: Array<[string, string]>; error?: string } => {
    if (!multiAccountCapable(def)) return { pairs: [] }
    const st = settingsRef.current
    const entry = st.accounts.find(e => e.id === preferredEntryId && e.agentId === def.id)
      ?? pickEntryLru(st.accounts.filter(e => e.agentId === def.id))
    if (!entry) return { pairs: [] }
    const status = accountStatusRef.current[entry.id]
    if (status?.login === 'no') {
      return { entry, pairs: [], error: `账户「${entry.label}」还没登录：${fillLoginGuide(def, status.dirPath)}` }
    }
    if (entry.credDir === 'isolated') {
      if (!status?.dirPath) return { entry, pairs: [], error: '读不到该账户的凭据目录，已取消派活（不会拿其他账户顶替）' }
      // env 型注入凭据目录变量；home 型（Antigravity）注入 HOME=<条目目录>
      return { entry, pairs: entryEnvPairs(def, entry, status.dirPath) }
    }
    return { entry, pairs: [] }
  }, [])

  const touchEntryUsed = useCallback((entryId: string) => {
    setSettings(prev => ({ ...prev, accounts: prev.accounts.map(e => (e.id === entryId ? { ...e, lastUsedAt: Date.now() } : e)) }))
  }, [])

  /** v0.1.512（④）：HOME 型条目（Antigravity 隔离账户）派活前先解锁它自己的钥匙串
   *  （重启/睡醒后会锁上）；原生条目与 env 型条目不需要。失败返回人话原因、调用方停住。 */
  const ensureEntryUnlocked = useCallback(async (def: AgentDef, entry?: AgentAccountEntry): Promise<string | null> => {
    if (def.credIsolation !== 'home' || !entry || entry.credDir !== 'isolated') return null
    try {
      await agentAgyUnlockKeychain(entry.id)
      return null
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }, [])

  /** 派生任务（接力 / 主控子任务）过闸：付费账户先停住等放行；超上限落待处理，不静默丢弃 */
  const prepareDerivedTask = useCallback((base: AgentTask): AgentTask => {
    const st = settingsRef.current
    const def = agentDef(base.agentId)
    if (!def) return { ...base, status: 'unresolved', note: '目标 Agent 定义丢失' }
    const gate = quotaGate(st, def, st.bindings[base.agentId], accountsRef.current)
    if (gate.decision === 'approval') return { ...base, status: 'waiting-approval', approvalReason: gate.reason }
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0)
    const cap = capCheck(st, ledgerSpentSince(ledgerRef.current, startOfDay.getTime()), ledgerSpentSince(ledgerRef.current, sessionStartRef.current))
    if (cap === 'over-stop') {
      return { ...base, status: 'unresolved', note: '已达到额度护栏上限（单会话/每日），已停住；到设置 · 额度护栏调整上限后，点任务卡上的「换人」或重新派发' }
    }
    return base
  }, [])

  /** 沿接力链回溯收集整条链的任务（从当前任务到源头） */
  const relayChainOf = useCallback((orig: AgentTask): AgentTask[] => {
    const chain: AgentTask[] = []
    const seen = new Set<string>()
    let cur: AgentTask | undefined = orig
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id)
      chain.push(cur)
      cur = cur.relayFromId ? tasksRef.current.find(t => t.id === cur!.relayFromId) : undefined
    }
    return chain
  }, [])

  /** 真正执行接力：打包上下文 → 生成接棒任务（过闸入队）→ 原任务标「已接力 → XX」 */
  const doRelay = useCallback(async (orig: AgentTask, candidateId: string, reasonLabel: string, opts?: { entryId?: string; modelLabel?: string; modelTargetId?: string }) => {
    const candDef = agentDef(candidateId)
    if (!candDef) return
    // 条目级接力：同平台换账户续跑——接棒条目不能是原条目本身；换账户后会话不通用，走上下文打包
    let succEntryId: string | undefined
    let succEntryLabel: string | undefined
    if (multiAccountCapable(candDef)) {
      const cands = settingsRef.current.accounts.filter(e => e.agentId === candDef.id && e.enabled)
      const entry = opts?.entryId
        ? cands.find(e => e.id === opts.entryId)
        : candDef.id === orig.agentId
          ? pickEntryLru(cands.filter(e => e.id !== orig.accountEntryId))
          : pickEntryLru(cands)
      if (!entry && candDef.id === orig.agentId) {
        updateTask(orig.id, {
          status: 'unresolved', relayProposal: undefined,
          note: `无人可接力：${candDef.name} 没有其他已启用的账户条目可换（同平台换账户续跑需要至少两个条目）`,
        })
        return
      }
      succEntryId = entry?.id
      succEntryLabel = entry?.label
    }
    const chain = relayChainOf(orig)
    const root = chain[chain.length - 1] ?? orig
    const chainIds = new Set(chain.map(t => t.id))
    const freshEntries = await agentVaultList().catch(() => vaultEntriesRef.current)
    const changedFiles = [...new Set(freshEntries.filter(e => chainIds.has(e.taskId)).map(e => e.originalPath))]
    const outputText = (outputsRef.current.get(orig.id) ?? orig.output).join('\n')
    const packInput = {
      originalText: root.text,
      originalTitle: root.title ?? root.text,
      fromAgentName: orig.agentName,
      reason: reasonLabel,
      workdir: orig.workdir,
      output: outputText,
      changedFiles,
      lastStatus: orig.status === 'manual' || orig.relayFromStatus === 'manual'
        ? '桌面应用已打开待粘贴，用户标记额度耗尽'
        : `失败（退出码 ${orig.exitCode ?? '—'}）`,
    }
    // 交接指定模型：仅当接棒者是空壳型且绑定的正是该模型所属的自有账户时，引擎 id 才注入 env 真生效
    let hovEngineId: string | undefined
    if (opts?.modelTargetId?.startsWith('own:')) {
      const parts = opts.modelTargetId.split(':')
      const binding = settingsRef.current.bindings[candDef.id]
      if (binding?.kind === 'account' && binding.accountId === parts[1] && parts[2]) hovEngineId = parts[2]
    }
    const successor = prepareDerivedTask({
      id: uid(), text: buildRelayContextPack(packInput), title: relayTitle(packInput),
      agentId: candDef.id, agentName: candDef.name, kind: candDef.kind,
      workdir: orig.workdir, heavy: orig.heavy, outsideOk: orig.outsideOk,
      status: 'queued', output: [], createdAt: Date.now(),
      relayFromId: orig.id, relayReason: reasonLabel,
      accountEntryId: succEntryId, accountEntryLabel: succEntryLabel,
      handoverModel: opts?.modelLabel, handoverEngineId: hovEngineId,
      note: opts?.modelLabel ? `交接指定模型：${opts.modelLabel}${hovEngineId ? '（已按指定模型派活）' : '（接棒者用自身账号/默认模型时，此指定仅作记录）'}` : undefined,
      // 同 Agent 同条目续跑才走 resume 带会话（当前候选规则下同条目不入选，此为兜底接线）；换账户/换人走上下文包
      sessionId: candDef.id === orig.agentId && succEntryId !== undefined && succEntryId === orig.accountEntryId ? orig.sessionId : undefined,
    })
    const wasManual = orig.status === 'manual' || orig.relayFromStatus === 'manual'
    if (wasManual) {
      const now = Date.now()
      addLedger({
        id: `led-${orig.id}`, taskId: orig.id, agentId: orig.agentId, agentName: orig.agentName, kind: orig.kind,
        agentEntryId: orig.accountEntryId, agentEntryLabel: orig.accountEntryLabel,
        startedAt: orig.startedAt ?? now, endedAt: now, durationMs: now - (orig.startedAt ?? now),
        status: 'manual', costYuan: null,
      })
    }
    const origStatus: AgentTask['status'] = orig.status === 'waiting-relay'
      ? (orig.relayFromStatus === 'manual' ? 'stopped' : (orig.relayFromStatus ?? 'failed'))
      : wasManual ? 'stopped' : orig.status
    setTasks(prev => [successor, ...prev.map(t => (t.id === orig.id
      ? {
          ...t, relayToId: successor.id, relayProposal: undefined, handedOver: true,
          status: origStatus, endedAt: t.endedAt ?? Date.now(),
          note: `已${reasonLabel === '手动交接' ? '交接' : '接力'} → ${candDef.name}${succEntryLabel ? ` · ${succEntryLabel}` : ''}（${reasonLabel}）`,
        }
      : t))])
    notify(`已接力：${orig.agentName} → ${candDef.name} 续跑`)
  }, [addLedger, prepareDerivedTask, relayChainOf, updateTask])

  /** 接力决策：按设置模式自动接力或停住询问；无人可接落「待处理」并写明每个跳过原因 */
  const considerRelay = useCallback((orig: AgentTask, reasonLabel: string) => {
    const st = settingsRef.current
    const chainTasks = relayChainOf(orig)
    const usedEntryIds = new Set(chainTasks.map(t => t.accountEntryId).filter(Boolean))
    const used = chainTasks.map(t => t.agentId).filter(id => {
      const d = agentDef(id)
      if (!d || !multiAccountCapable(d) || id !== orig.agentId) return true
      // 原 Agent 多账户且还有没用过的已启用条目 → 同平台换账户续跑仍可选，不算已用
      return !st.accounts.some(e => e.agentId === id && e.enabled && !usedEntryIds.has(e.id))
    })
    const avail = (id: string) => {
      const d = agentDef(id)
      return d ? agentAvailability(d, detectMapRef.current[id], st, accountsRef.current, st.accounts) : null
    }
    const pick = pickRelayCandidate(st.relay.chain, used, AGENT_REGISTRY, avail)
    if (!pick.candidateId) {
      const reasons = pick.skipped.length
        ? pick.skipped.map(s => `${s.agentName}：${s.reason}`).join('；')
        : '接力链是空的（到设置 · 接力与调度里添加接棒者）'
      const od = agentDef(orig.agentId)
      const usedLabels = od && multiAccountCapable(od)
        ? [...new Set(chainTasks.filter(t => t.agentId === orig.agentId).map(t => t.accountEntryLabel).filter(Boolean))]
        : []
      const entryNote = usedLabels.length ? `；${od!.name} 已用过的账户条目：${usedLabels.join('、')}` : ''
      updateTask(orig.id, { status: 'unresolved', relayProposal: undefined, note: `无人可接力：${reasons}${entryNote}` })
      return
    }
    if (st.relay.mode === 'auto') {
      void doRelay(orig, pick.candidateId, reasonLabel)
      return
    }
    const changed = vaultEntriesRef.current.filter(e => e.taskId === orig.id).length
    updateTask(orig.id, {
      status: 'waiting-relay',
      relayFromStatus: orig.status,
      relayProposal: {
        candidateId: pick.candidateId, candidateName: pick.candidateName ?? pick.candidateId,
        reason: reasonLabel,
        skipped: pick.skipped.map(s => ({ agentName: s.agentName, reason: s.reason })),
        changedFiles: changed,
      },
    })
  }, [doRelay, relayChainOf, updateTask])

  const confirmRelay = useCallback((task: AgentTask) => {
    if (task.relayProposal) void doRelay(task, task.relayProposal.candidateId, task.relayProposal.reason)
  }, [doRelay])

  const cancelRelay = useCallback((task: AgentTask) => {
    updateTask(task.id, {
      status: task.relayFromStatus ?? 'failed', relayProposal: undefined,
      note: '已取消接力（可在任务卡上再次「换人续跑」）',
    })
  }, [updateTask])

  /** 主控拆活回填：解析主控输出 → 生成子任务；解析失败回落整单派给主控 */
  const handleMasterPlan = useCallback((task: AgentTask, outputText: string) => {
    const goal = task.planFor ?? task.text
    const items = parseMasterPlan(outputText)
    if (!items) {
      const fallback = prepareDerivedTask({
        id: uid(), text: goal, title: task.title, agentId: task.agentId, agentName: task.agentName, kind: task.kind,
        workdir: task.workdir, heavy: isHeavyTask(goal), outsideOk: task.outsideOk,
        status: 'queued', output: [], createdAt: Date.now(),
      })
      setTasks(prev => [fallback, ...prev.map(t => (t.id === task.id
        ? { ...t, planGroupId: task.id, note: '拆活输出没能解析成子任务清单，已回落：整单派给主控直接执行' }
        : t))])
      return
    }
    const st = settingsRef.current
    const readyList = AGENT_REGISTRY.filter(a => {
      const d = agentDef(a.id)
      return d && agentAvailability(d, detectMapRef.current[a.id], st, accountsRef.current, st.accounts).state === 'ready'
    })
    const subs: AgentTask[] = []
    for (const item of items) {
      let execDef = resolvePlanAgent(item, readyList)
      if (!execDef) execDef = readyList.find(a => a.id === task.agentId) ?? readyList[0] ?? null
      const base: AgentTask = {
        id: uid(), text: item.task, title: item.title,
        agentId: execDef?.id ?? task.agentId, agentName: execDef?.name ?? task.agentName,
        kind: execDef?.kind ?? task.kind,
        workdir: item.workdir || task.workdir, heavy: item.heavy ?? isHeavyTask(item.task),
        outsideOk: task.outsideOk, status: 'queued', output: [], createdAt: Date.now(),
        planGroupId: task.id,
      }
      subs.push(execDef ? prepareDerivedTask(base) : { ...base, status: 'unresolved', note: '没有可用的执行者（主控建议的与已启用的 Agent 都不可用）' })
    }
    setTasks(prev => [...subs, ...prev.map(t => (t.id === task.id
      ? { ...t, planGroupId: task.id, note: `已拆为 ${items.length} 个子任务，见任务板` }
      : t))])
    notify(`主控已拆活：${items.length} 个子任务入队`)
  }, [prepareDerivedTask])

  /** 交叉审查发起：把目标 + 输出摘要 + 改动清单递给审查者 CLI；失败如实标在任务卡上 */
  const maybeStartReview = useCallback(async (task: AgentTask, outputText: string) => {
    const st = settingsRef.current
    if (!st.master.crossReview && !task.forceReview) return
    const fail = (reason: string, reviewerName?: string) =>
      updateTask(task.id, { review: { state: 'failed', reviewerName, reason } })
    const reviewerId = st.master.reviewerAgentId
    if (!reviewerId) { fail('未选择审查者（到设置 · 主控与审查里选一个）'); return }
    const rDef = agentDef(reviewerId)
    if (!rDef || effectiveDispatch(rDef, detectMapRef.current[reviewerId]) !== 'cli') { fail('审查者不是可真派活的无头/CLI 型 Agent'); return }
    if (reviewerId === task.agentId) { fail('审查者与执行者是同一个，已跳过', rDef.name); return }
    const avail = agentAvailability(rDef, detectMapRef.current[reviewerId], st, accountsRef.current, st.accounts)
    if (avail.state !== 'ready') { fail(`审查者不可用：${avail.reason}`, rDef.name); return }
    updateTask(task.id, { review: { state: 'running', reviewerName: rDef.name } })
    const envRes = await buildRunEnv(rDef, st)
    if ('error' in envRes) { fail(envRes.error, rDef.name); return }
    let reviewEnvPairs = envRes.envPairs
    let reviewEntry: AgentAccountEntry | undefined
    if (rDef.headlessCli) {
      const cred = resolveEntryCred(rDef)
      if (cred.error) { fail(cred.error, rDef.name); return }
      reviewEntry = cred.entry
      if (reviewEntry) touchEntryUsed(reviewEntry.id)
      reviewEnvPairs = [...reviewEnvPairs, ...cred.pairs]
      const unlockErr = await ensureEntryUnlocked(rDef, reviewEntry)
      if (unlockErr) { fail(unlockErr, rDef.name); return }
    }
    const changedFiles = [...new Set(vaultEntriesRef.current.filter(e => e.taskId === task.id).map(e => e.originalPath))]
    const prompt = buildReviewPrompt({
      taskText: task.planFor ?? task.text, taskTitle: task.title,
      agentName: task.agentName, output: outputText, changedFiles,
    })
    // v0.1.511（⑤）：审查者是 DSH 时同样要带账号路线覆盖层
    const inv = buildCliInvocation(rDef.id, prompt, undefined,
      rDef.id === 'dsh' ? { dshPatchPath: await ensureDshPatch() } : undefined)
    if (!inv) { fail('审查者没有 CLI 派活方式', rDef.name); return }
    const runId = `review-${task.id}`
    try {
      await agentRunStart(runId, inv.command, inv.args, task.workdir, reviewEnvPairs)
      reviewRunsRef.current.set(task.id, {
        runId, cursor: 0, output: [], reviewerId: rDef.id, reviewerName: rDef.name, kind: rDef.kind,
        entryId: reviewEntry?.id, entryLabel: reviewEntry?.label, startedAt: Date.now(),
      })
    } catch (e) {
      fail(`审查启动失败：${e instanceof Error ? e.message : String(e)}`, rDef.name)
    }
  }, [buildRunEnv, updateTask, resolveEntryCred, touchEntryUsed, ensureDshPatch, ensureEntryUnlocked])

  /** v0.1.512（②）：赛马两版都完成后互相交叉审查——A 审 B、B 审 A，结论落在被审任务的
   *  raceReview 上（对比层与任务卡共用），费用记审查者名下。审查者在被审者的 worktree 里
   *  跑（能看到真实改动）；任一版没完成就不审，不拿审查结论掩盖失败。 */
  const startRaceReviews = useCallback(async (pair: AgentTask[]) => {
    const donePair = pair.filter(t => t.status === 'done')
    if (donePair.length !== 2) return
    for (const target of donePair) {
      if (raceReviewStartedRef.current.has(target.id)) continue
      raceReviewStartedRef.current.add(target.id)
      const reviewerTask = donePair.find(t => t.id !== target.id)!
      const rDef = agentDef(reviewerTask.agentId)
      const fail = (reason: string) => updateTask(target.id, {
        raceReview: { state: 'failed', reviewerName: rDef?.name, reason },
      })
      if (!rDef) { fail('审查者定义丢失'); continue }
      updateTask(target.id, { raceReview: { state: 'running', reviewerName: rDef.name } })
      const envRes = await buildRunEnv(rDef, settingsRef.current)
      if ('error' in envRes) { fail(envRes.error); continue }
      let envPairs = envRes.envPairs
      let rEntry: AgentAccountEntry | undefined
      if (rDef.headlessCli) {
        const cred = resolveEntryCred(rDef, reviewerTask.accountEntryId)
        if (cred.error) { fail(cred.error); continue }
        rEntry = cred.entry
        if (rEntry) touchEntryUsed(rEntry.id)
        envPairs = [...envPairs, ...cred.pairs]
        const unlockErr = await ensureEntryUnlocked(rDef, rEntry)
        if (unlockErr) { fail(unlockErr); continue }
      }
      let changedFiles: string[] = []
      if (target.raceWorktree) {
        try { changedFiles = (await agentWorktreeDiff(target.raceWorktree)).changedFiles } catch { changedFiles = [] }
      }
      const outputText = (outputsRef.current.get(target.id) ?? target.output).join('\n')
      const prompt = buildReviewPrompt({
        taskText: target.text, taskTitle: target.title, agentName: target.agentName,
        output: outputText, changedFiles,
      })
      const inv = buildCliInvocation(rDef.id, prompt, undefined,
        rDef.id === 'dsh' ? { dshPatchPath: await ensureDshPatch() } : undefined)
      if (!inv) { fail('审查者没有 CLI 派活方式'); continue }
      const runId = `race-review-${target.id}`
      try {
        await agentRunStart(runId, inv.command, inv.args, target.raceWorktree ?? target.workdir, envPairs)
        raceReviewRunsRef.current.set(target.id, {
          runId, cursor: 0, output: [], reviewerId: rDef.id, reviewerName: rDef.name, kind: rDef.kind,
          entryId: rEntry?.id, entryLabel: rEntry?.label, startedAt: Date.now(),
        })
      } catch (e) {
        fail(`审查启动失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }, [buildRunEnv, resolveEntryCred, touchEntryUsed, ensureEntryUnlocked, ensureDshPatch, updateTask])

  /** 赛马收尾判定：一件任务到终局后看对手——两件都终局且都完成才发起交叉审查 */
  const maybeFinishRace = useCallback((finished: AgentTask, status: AgentTask['status']) => {
    if (!finished.raceId) return
    const sibling = tasksRef.current.find(t => t.raceId === finished.raceId && t.id !== finished.id)
    if (!sibling) return
    if (!['done', 'failed', 'stopped', 'unresolved'].includes(sibling.status)) return
    if (status === 'done' && sibling.status === 'done') {
      void startRaceReviews([{ ...finished, status }, sibling])
    }
  }, [startRaceReviews])

  const finalizeCliTask = useCallback(async (task: AgentTask, exitCode: number) => {
    const now = Date.now()
    if (baselinedRef.current.has(task.id)) {
      await agentVaultPoll(task.id).catch(() => null)
      baselinedRef.current.delete(task.id)
      void refreshVault()
    }
    const outputText = (outputsRef.current.get(task.id) ?? task.output).join('\n')
    const usage = parseCliUsage(outputText)
    const wasStopped = stoppedRef.current.has(task.id)
    stoppedRef.current.delete(task.id)
    const status = wasStopped ? 'stopped' : exitCode === 0 ? 'done' : 'failed'
    const binding = settingsRef.current.bindings[task.agentId]
    const acct = binding?.kind === 'account' ? accountsRef.current.find(a => a.id === binding.accountId) : undefined
    addLedger({
      id: `led-${task.id}`, taskId: task.id, agentId: task.agentId, agentName: task.agentName, kind: task.kind,
      agentEntryId: task.accountEntryId, agentEntryLabel: task.accountEntryLabel,
      accountId: acct?.id, accountLabel: acct ? (acct.label || PROVIDER_MAP[acct.providerId]?.name || acct.providerId) : undefined,
      startedAt: task.startedAt ?? now, endedAt: now, durationMs: now - (task.startedAt ?? now),
      status, costYuan: null,
      costUsd: usage ? usage.costUsd : null,
      inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens,
    })
    updateTask(task.id, {
      status, endedAt: now, exitCode,
      note: wasStopped ? '已被你停止' : exitCode === 0 ? undefined : (humanizeAgentError(outputText) || `进程退出码 ${exitCode}`),
    })
    // v0.1.511（②）：钥匙串保管登录态的 Agent 首次派活成功 → 落「已验证」标记，
    // 设置页/条目不再常年显示「读不到」、更不会误以为没登录（标记随 settings 落盘）
    if (status === 'done') {
      const doneDef = agentDef(task.agentId)
      if (doneDef?.credProbeMissing === 'unknown') {
        setSettings(prev => {
          if (prev.verifiedAgents?.[task.agentId]) return prev
          const next = markAgentVerified(prev, task.agentId, Date.now())
          saveAgentSettings(next)
          return next
        })
      }
    }
    // 二期联动（主控拆活回填 / 额度类失败接力 / 完成后的交叉审查）
    if (status === 'done' && task.planFor) {
      handleMasterPlan(task, outputText)
    } else if (status === 'failed') {
      const rel = classifyRelayFailure(outputText, exitCode)
      if (rel) considerRelay({ ...task, status, exitCode }, rel.label)
    } else if (status === 'done') {
      void maybeStartReview(task, outputText)
    }
    // v0.1.512（②）：赛马收尾——两版都到终局后互相交叉审查（结论进对比层）
    if (task.raceId) maybeFinishRace(task, status)
  }, [addLedger, refreshVault, updateTask, handleMasterPlan, considerRelay, maybeStartReview, maybeFinishRace])

  /** 第三档送达（兜底）：复制任务 → 打开应用 → 等窗口就绪自动粘贴（粘贴前校验前台 +
   *  确认输入框焦点，见 agentDelivery / Rust paste_deliver）→ 按设置决定是否连回车发送。
   *  degradeReason 给定时（第一档无头直派失败降级），最终文案如实带上降级说明，绝不假装无头成功。 */
  const deliverToApp = useCallback(async (task: AgentTask, def: AgentDef, degradeReason?: string) => {
    // v0.1.511（⑥）：降级原因先落到任务的持久字段 note——此前只拼在最终 delivery.note 里，
    // 中间覆盖 dispatch/tier 的 updateTask 把它冲得不可见（Codex 真机实证：卡上只剩
    // 「粘贴送达（兜底）」徽标，用户不知道为什么没走无头直派）。原因先人话化再落盘，
    // 且下面每一次 updateTask 都不再清它；最终 delivery.note 也继续带同一句。
    const humanReason = degradeReason ? (humanizeAgentError(degradeReason) || degradeReason) : ''
    const degradeNote = degradeReason
      ? `无头直派失败：${humanReason}，已降级为粘贴送达（兜底）`
      : ''
    if (degradeNote) updateTask(task.id, { note: degradeNote })
    let copied = await agentClipboardWrite(task.text)
    if (!copied) {
      try { await navigator.clipboard?.writeText(task.text); copied = true } catch { copied = false }
    }
    if (copied) {
      updateTask(task.id, { delivery: { state: 'copied', note: '任务已复制到剪贴板，正在打开应用…', at: Date.now() } })
    }
    const ok = await agentLaunchApp(def.appNames, def.bundleIds)
    if (!ok) {
      updateTask(task.id, {
        status: 'failed', endedAt: Date.now(), delivery: undefined,
        note: `${degradeNote ? `${degradeNote}，降级粘贴也没能打开应用。` : ''}没能打开 ${def.name}（可能未安装或被系统拦截）${copied ? '；任务已复制到剪贴板，手动打开应用后按 ⌘V 粘贴发送即可' : '，请手动打开后粘贴任务'}`,
      })
      return
    }
    updateTask(task.id, {
      status: 'manual', dispatch: 'open', tier: 3,
      delivery: { state: 'delivering', note: `已打开 ${def.name}，正在等它的窗口就绪后自动粘贴…`, at: Date.now() },
    })
    const provider = createBridgeDeliveryProvider(def.appNames, def.bundleIds, task.text)
    const result = await runDelivery(provider, { autoSend: settingsRef.current.delivery.autoSend })
    const pres = deliveryPresentation(result, def.name)
    const note = degradeNote ? `${degradeNote}。${pres.note}` : pres.note
    // 送达期间用户可能已标记完成 / 放弃 / 接力走了：只给仍停在待粘贴的卡回填。
    // 守卫必须在 setTasks 的 updater 里用最新状态判——快速送达（首轮即就绪 /
    // 无权限秒回）时 tasksRef 还没刷进 manual 状态，用 ref 判会把结果误丢，
    // 卡片永远停在「送达中」（verify509 实测坐实）。
    setTasks(prev => prev.map(t => (t.id === task.id && t.status === 'manual' && !t.relayToId)
      ? { ...t, delivery: { state: pres.state, note, at: Date.now() } }
      : t))
  }, [updateTask])

  const startTask = useCallback(async (task: AgentTask) => {
    if (startingRef.current.has(task.id)) return
    startingRef.current.add(task.id)
    const def = agentDef(task.agentId)
    const st = settingsRef.current
    try {
      if (!def) { updateTask(task.id, { status: 'failed', note: 'Agent 定义丢失' }); return }
      const det = detectMapRef.current[task.agentId]
      const eff = effectiveDispatch(def, det) ?? def.dispatch
      updateTask(task.id, { status: 'running', startedAt: Date.now(), note: undefined, dispatch: eff, tier: eff === 'cli' ? 1 : 3 })
      if (eff === 'open') {
        // v0.1.511（⑥修订，Ethan 定）：无头型 Agent 彻底取消自动降档粘贴——命令未装就
        // 直接拦下、卡上写明先一键安装（主控拆活/接力派生的任务不走 submit 门控，
        // 在这一层兜底）；粘贴送达只留给本来就只有粘贴档的 Agent（WorkBuddy/Qoder 等）
        if (def.headlessCli) {
          updateTask(task.id, {
            status: 'failed', endedAt: Date.now(),
            note: `${def.cliNames[0]} 命令未安装：无头型派活只走命令、不降级粘贴。先一键安装命令再派活（下方按钮或设置 · Agent 管理）`,
          })
          return
        }
        // 第三档（兜底）：只有粘贴档的 Agent，命令不在、只有桌面应用时走粘贴送达
        await deliverToApp(task, def)
        return
      }
      // v0.1.512（②）：赛马任务开跑前先建自己的 worktree（独立分支、隔离目录），之后
      // 保险箱基线与子进程都落在这个 worktree 里；建不起来如实失败，绝不在主仓库里跑
      let effWorkdir = task.workdir
      if (task.raceId && !task.raceWorktree && task.raceRepo && task.raceSlot) {
        const slot = task.raceSlot.toLowerCase()
        const branch = `acm-race/${task.raceId}-${slot}`
        const repoBase = task.raceRepo.replace(/\/+$/, '')
        const cut = repoBase.lastIndexOf('/')
        const parent = cut > 0 ? repoBase.slice(0, cut) : '/'
        const repoName = repoBase.slice(cut + 1) || 'repo'
        const wt = `${parent}/${repoName}.acm-worktrees/${task.raceId}-${slot}`
        try {
          await agentWorktreeAdd(task.raceRepo, branch, wt)
        } catch (e) {
          updateTask(task.id, { status: 'failed', endedAt: Date.now(), note: `赛马工作区没建起来：${e instanceof Error ? e.message : String(e)}` })
          return
        }
        updateTask(task.id, { raceWorktree: wt, raceBranch: branch, workdir: wt })
        effWorkdir = wt
      }
      // 第一档无头 / 空壳 CLI：先建保险箱基线（安全底线，失败就不跑）
      if (st.vault.enabled && effWorkdir) {
        try {
          await agentVaultBaseline(task.id, def.id, def.name, task.text.slice(0, 60), effWorkdir)
          baselinedRef.current.add(task.id)
        } catch (e) {
          updateTask(task.id, { status: 'failed', endedAt: Date.now(), note: `文件保险箱建基线失败，已取消派活：${e instanceof Error ? e.message : String(e)}` })
          return
        }
      }
      // 供 Key：绑定账户时解密注入（Key 只进子进程环境变量）
      const envRes = await buildRunEnv(def, st, task.handoverEngineId)
      if ('error' in envRes) {
        updateTask(task.id, { status: 'failed', endedAt: Date.now(), note: envRes.error })
        return
      }
      let envPairs = envRes.envPairs
      // 多账户：定条目 + 凭据目录注入；未登录 / 读不到目录如实停住，绝不换账户顶替
      if (def.headlessCli) {
        const cred = resolveEntryCred(def, task.accountEntryId)
        if (cred.error) {
          updateTask(task.id, { status: 'failed', endedAt: Date.now(), note: cred.error })
          return
        }
        if (cred.entry) {
          if (!task.accountEntryId) updateTask(task.id, { accountEntryId: cred.entry.id, accountEntryLabel: cred.entry.label })
          touchEntryUsed(cred.entry.id)
          envPairs = [...envPairs, ...cred.pairs]
          // v0.1.512（④）：HOME 型条目派活前解锁它自己的钥匙串（失败如实停住）
          const unlockErr = await ensureEntryUnlocked(def, cred.entry)
          if (unlockErr) {
            updateTask(task.id, { status: 'failed', endedAt: Date.now(), note: unlockErr })
            return
          }
        }
      }
      // v0.1.511（⑤）：dsh 派活带账号路线覆盖层（--patch），原生与隔离条目同口径
      const inv = buildCliInvocation(def.id, task.text, task.sessionId,
        def.id === 'dsh' ? { dshPatchPath: await ensureDshPatch() } : undefined)
      if (!inv) { updateTask(task.id, { status: 'failed', endedAt: Date.now(), note: '该 Agent 没有 CLI 派活方式' }); return }
      try {
        await agentRunStart(task.id, inv.command, inv.args, effWorkdir, envPairs)
        cursorsRef.current.set(task.id, 0)
        outputsRef.current.set(task.id, [])
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // v0.1.511（⑥修订）：启动失败一律如实失败——无头型绝不自动降级去打开桌面应用
        // 粘贴；失败原因人话化后落卡常驻，修复动作（去登录/一键安装）由卡上按钮承接
        const human = humanizeAgentError(msg)
        updateTask(task.id, { status: 'failed', endedAt: Date.now(), note: human || `启动失败：${msg}` })
      }
    } finally {
      startingRef.current.delete(task.id)
    }
  }, [updateTask, buildRunEnv, deliverToApp, resolveEntryCred, touchEntryUsed, ensureDshPatch, ensureEntryUnlocked])

  // 调度：排队任务按并行上限 + 重活锁启动
  useEffect(() => {
    const startable = pickStartable(tasks, settings.parallel.maxParallel)
    for (const id of startable) {
      const t = tasks.find(x => x.id === id)
      if (t) void startTask(t)
    }
  }, [tasks, settings.parallel.maxParallel, startTask])

  // 轮询运行中 CLI 任务的输出 + 保险箱 diff
  useEffect(() => {
    if (!desktop) return
    const timer = window.setInterval(async () => {
      const running = tasksRef.current.filter(t => t.status === 'running' && (t.dispatch ?? agentDef(t.agentId)?.dispatch) === 'cli')
      for (const task of running) {
        const cursor = cursorsRef.current.get(task.id) ?? 0
        const poll = await agentRunPoll(task.id, cursor)
        cursorsRef.current.set(task.id, poll.next)
        if (poll.lines.length) {
          const acc = [...(outputsRef.current.get(task.id) ?? []), ...poll.lines]
          outputsRef.current.set(task.id, acc.slice(-2000))
          setTasks(prev => prev.map(t => (t.id === task.id
            ? { ...t, output: [...t.output, ...poll.lines].slice(-300) }
            : t)))
          // 无头会话 id 捕获（同账户续跑时走 resume）
          if (!task.sessionId && agentDef(task.agentId)?.headlessCli) {
            const sid = parseSessionId(poll.lines.join('\n'))
            if (sid) updateTask(task.id, { sessionId: sid })
          }
        }
        if (baselinedRef.current.has(task.id)) {
          const last = vaultPolledAtRef.current.get(task.id) ?? 0
          if (Date.now() - last > 4000) {
            vaultPolledAtRef.current.set(task.id, Date.now())
            const r = await agentVaultPoll(task.id)
            if (r.backedUp > 0) void refreshVault()
          }
        }
        if (!poll.running && poll.exitCode !== null) {
          const fresh = tasksRef.current.find(t => t.id === task.id)
          if (fresh && fresh.status === 'running') {
            // v0.1.511（⑥修订）：无头接口失败（版本差异改了参数等）也只如实失败、
            // 不再降级粘贴——统一走 finalizeCliTask（内含保险箱 diff 收尾与人话原因）
            void finalizeCliTask(fresh, poll.exitCode)
          }
        }
      }
      // 交叉审查的运行轮询：结论回填任务卡，费用记审查者名下；审查失败不动原任务完成态
      for (const [taskId, rr] of [...reviewRunsRef.current.entries()]) {
        const poll = await agentRunPoll(rr.runId, rr.cursor)
        rr.cursor = poll.next
        if (poll.lines.length) rr.output.push(...poll.lines)
        if (!poll.running && poll.exitCode !== null) {
          reviewRunsRef.current.delete(taskId)
          const outText = rr.output.join('\n')
          const usage = parseCliUsage(outText)
          const binding = settingsRef.current.bindings[rr.reviewerId]
          const acct = binding?.kind === 'account' ? accountsRef.current.find(a => a.id === binding.accountId) : undefined
          addLedger({
            id: `led-${taskId}-review`, taskId, agentId: rr.reviewerId, agentName: rr.reviewerName, kind: rr.kind,
            agentEntryId: rr.entryId, agentEntryLabel: rr.entryLabel,
            accountId: acct?.id, accountLabel: acct ? (acct.label || PROVIDER_MAP[acct.providerId]?.name || acct.providerId) : undefined,
            startedAt: rr.startedAt, endedAt: Date.now(), durationMs: Date.now() - rr.startedAt,
            status: poll.exitCode === 0 ? 'done' : 'failed', costYuan: null,
            costUsd: usage ? usage.costUsd : null,
            inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens,
          })
          if (poll.exitCode !== 0) {
            updateTask(taskId, { review: { state: 'failed', reviewerName: rr.reviewerName, reason: `审查进程退出码 ${poll.exitCode}` } })
          } else {
            const verdict = parseReviewVerdict(outText)
            if (verdict) {
              updateTask(taskId, { review: { state: verdict.verdict, reviewerName: rr.reviewerName, points: verdict.points } })
            } else {
              updateTask(taskId, { review: { state: 'failed', reviewerName: rr.reviewerName, reason: '审查者没有给出可解析的结论' } })
            }
          }
        }
      }
      // v0.1.512（②）：赛马交叉审查轮询——结论回填被审任务的 raceReview，费用记审查者名下
      for (const [taskId, rr] of [...raceReviewRunsRef.current.entries()]) {
        const poll = await agentRunPoll(rr.runId, rr.cursor)
        rr.cursor = poll.next
        if (poll.lines.length) rr.output.push(...poll.lines)
        if (!poll.running && poll.exitCode !== null) {
          raceReviewRunsRef.current.delete(taskId)
          const outText = rr.output.join('\n')
          const usage = parseCliUsage(outText)
          const binding = settingsRef.current.bindings[rr.reviewerId]
          const acct = binding?.kind === 'account' ? accountsRef.current.find(a => a.id === binding.accountId) : undefined
          addLedger({
            id: `led-${taskId}-race-review`, taskId, agentId: rr.reviewerId, agentName: rr.reviewerName, kind: rr.kind,
            agentEntryId: rr.entryId, agentEntryLabel: rr.entryLabel,
            accountId: acct?.id, accountLabel: acct ? (acct.label || PROVIDER_MAP[acct.providerId]?.name || acct.providerId) : undefined,
            startedAt: rr.startedAt, endedAt: Date.now(), durationMs: Date.now() - rr.startedAt,
            status: poll.exitCode === 0 ? 'done' : 'failed', costYuan: null,
            costUsd: usage ? usage.costUsd : null,
            inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens,
          })
          if (poll.exitCode !== 0) {
            updateTask(taskId, { raceReview: { state: 'failed', reviewerName: rr.reviewerName, reason: `审查进程退出码 ${poll.exitCode}` } })
          } else {
            const verdict = parseReviewVerdict(outText)
            if (verdict) {
              updateTask(taskId, { raceReview: { state: verdict.verdict, reviewerName: rr.reviewerName, points: verdict.points } })
            } else {
              updateTask(taskId, { raceReview: { state: 'failed', reviewerName: rr.reviewerName, reason: '审查者没有给出可解析的结论' } })
            }
          }
        }
      }
    }, 900)
    return () => window.clearInterval(timer)
  }, [desktop, finalizeCliTask, refreshVault, addLedger, updateTask, deliverToApp])

  const availOf = useCallback((id: string) => {
    const def = agentDef(id)
    if (!def) return null
    return agentAvailability(def, detectMap[id], settings, accounts, settings.accounts)
  }, [detectMap, settings, accounts])

  const readyAgents = useMemo(
    () => AGENT_REGISTRY.filter(a => availOf(a.id)?.state === 'ready'),
    [availOf],
  )

  // # 补全：输入末尾正在打 #token 时弹出可委派列表（只列已启用且可用的）
  const hashMatch = input.match(/(^|\s)#([^\s#]*)$/)
  const pickerList = hashMatch
    ? readyAgents.filter(a => a.name.toLowerCase().startsWith(hashMatch[2].toLowerCase()) || a.id.startsWith(hashMatch[2].toLowerCase()))
    : []
  // v0.1.509（A）：# 面板三组——①委派 Agent 细到账户条目 ②原生命令 ③工坊技能（清单读工坊同一份注册表）
  const hashQuery = (hashMatch?.[2] ?? '').toLowerCase()
  const pickerEntries = hashMatch
    ? pickerList.filter(a => multiAccountCapable(a)).flatMap(a =>
        settings.accounts.filter(e => e.agentId === a.id && e.enabled).map(e => ({ agent: a, entry: e })))
    : []
  const pickerCommands = hashMatch
    ? [
        { id: 'compact', name: '压缩上下文', desc: '把最近一件任务的记录打包成上下文摘要（接 508 上下文打包）' },
        { id: 'review', name: '审查', desc: '下一件任务完成后强制交叉审查一次（接 508 交叉审查）' },
      ].filter(c => hashQuery === '' || c.name.includes(hashQuery))
    : []
  const pickerSkills = hashMatch ? WORKSHOP_SKILLS.filter(sk => sk.name.toLowerCase().includes(hashQuery)) : []
  // v0.1.511（⑨）：# 面板方向与高度——向上弹时不得盖页签、不得被窗口顶部裁行；
  // 上方空间不足就改向下弹，高度按可用空间封顶、面板内滚动
  const pickerVisible = pickerList.length > 0 || pickerEntries.length > 0 || pickerCommands.length > 0 || pickerSkills.length > 0
  const inputWrapRef = useRef<HTMLDivElement>(null)
  const [pickerDir, setPickerDir] = useState<{ down: boolean; maxH: number }>({ down: false, maxH: 320 })
  useEffect(() => {
    if (!pickerVisible || !inputWrapRef.current) return
    const r = inputWrapRef.current.getBoundingClientRect()
    const tabsEl = document.querySelector('.aw-tabs')
    const limitTop = (tabsEl ? tabsEl.getBoundingClientRect().bottom : 0) + 8
    const spaceAbove = Math.max(0, r.top - limitTop)
    const spaceBelow = Math.max(0, window.innerHeight - r.bottom - 12)
    const CAP = 320
    if (spaceAbove >= CAP) setPickerDir({ down: false, maxH: CAP })
    else if (spaceBelow > spaceAbove) setPickerDir({ down: true, maxH: Math.max(140, Math.min(CAP, spaceBelow)) })
    else setPickerDir({ down: false, maxH: Math.max(140, spaceAbove) })
  }, [pickerVisible, input])
  // v0.1.511（⑧）：用量浮层点外部关闭
  const usageBarRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!usageOpen) return
    const onDown = (e: MouseEvent) => {
      if (usageBarRef.current && !usageBarRef.current.contains(e.target as Node)) setUsageOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [usageOpen])
  const openHandover = (task: AgentTask) => { setHovKey(''); setHovModelId(''); setHandoverFor(task) }

  const noVaultCoverage = !settings.vault.enabled || !workdir.trim()

  /** 原生命令「压缩上下文」：最近一件任务的记录经 508 上下文打包，生成一件摘要任务派给原 Agent（不可用则主控/首个可用） */
  const dispatchCompact = () => {
    const latest = tasksRef.current.find(t => t.output || t.status === 'done' || t.status === 'failed')
    if (!latest) { notify('还没有可压缩的任务记录', 'err'); return }
    let target = agentDef(latest.agentId)
    if (!target || availOf(target.id)?.state !== 'ready') {
      target = (settings.master.masterAgentId ? agentDef(settings.master.masterAgentId) : undefined) ?? readyAgents[0]
    }
    if (!target || availOf(target.id)?.state !== 'ready') { notify('没有可用的 Agent 来执行压缩', 'err'); return }
    const pack = buildRelayContextPack({
      originalText: latest.text, originalTitle: latest.title ?? latest.text, fromAgentName: latest.agentName,
      reason: '压缩上下文', workdir: latest.workdir,
      output: (outputsRef.current.get(latest.id) ?? latest.output).join('\n'),
      changedFiles: [], lastStatus: latest.status,
    })
    const task: AgentTask = {
      id: uid(),
      text: `请把下面这份任务记录压缩成一份简洁的上下文摘要（包含：原始目标、已完成的工作、改动过的文件、未完成的事项），供后续接力使用：\n\n${pack}`,
      title: `上下文压缩（自：${(latest.title ?? latest.text).slice(0, 40)}）`,
      agentId: target.id, agentName: target.name, kind: target.kind,
      workdir: latest.workdir, heavy: false, outsideOk: latest.outsideOk,
      status: 'queued', output: [], createdAt: Date.now(),
    }
    setTasks(prev => [task, ...prev])
    notify('已派「压缩上下文」任务')
  }

  const submit = () => {
    const parsed = parseDelegation(input)
    if (parsed.unknownToken) { notify(`没有叫 #${parsed.unknownToken} 的 Agent，请从 # 列表里选`, 'err'); return }
    const rawText = (parsed.agentId ? parsed.taskText : input).trim()
    const taskText = skillPick ? buildSkillTaskText(skillPick, rawText) : rawText
    if (!taskText) { notify('先写下要派的活', 'err'); return }
    let agentId = parsed.agentId
    if (!agentId) {
      if (targetAgent !== 'auto') agentId = targetAgent
      else if (settings.master.masterAgentId && availOf(settings.master.masterAgentId)?.state === 'ready') agentId = settings.master.masterAgentId
      else agentId = readyAgents[0]?.id ?? null
    }
    if (!agentId) { notify('没有可委派的 Agent：先到设置 · Agent 管理启用并完成绑定', 'err'); return }
    const def = agentDef(agentId)!
    const avail = availOf(agentId)
    if (avail?.state !== 'ready') { notify(`${def.name} 现在不可委派：${avail?.reason ?? '未就绪'}`, 'err'); return }
    if (noVaultCoverage && !outsideOk) {
      notify(settings.vault.enabled ? '未填工作目录：本次任务没有文件保险箱覆盖，请先勾选风险确认' : '文件保险箱已关闭：请先勾选风险确认（改动不可还原）', 'err')
      return
    }
    const heavy = isHeavyTask(taskText, heavyMode === 'auto' ? undefined : heavyMode === 'heavy')
    let base: AgentTask = {
      id: uid(), text: taskText, agentId, agentName: def.name, kind: def.kind,
      workdir: workdir.trim(), heavy, outsideOk: noVaultCoverage ? outsideOk : false,
      status: 'queued', output: [], createdAt: Date.now(),
      ...(pendingReview ? { forceReview: true } : {}),
      ...(skillPick ? { title: `【技能 · ${skillPick.name}】${rawText.split('\n')[0].slice(0, 48)}` } : {}),
    }
    // 主控拆活（二期）：没写 #、没指定委派对象、落到 CLI 型主控时，先递给主控拆成子任务清单；
    // 桌面型主控只能人工拆活，整单打开它（设置里已明示），行为与一期一致。
    // 多账户落定：界面选了具体条目就用它，否则按最久未用自动选（# 指定也一样）
    if (multiAccountCapable(def)) {
      const explicit = targetAgent === agentId && entryPick !== 'auto'
        ? settings.accounts.find(e => e.id === entryPick && e.agentId === agentId && e.enabled)
        : undefined
      const entry = explicit ?? pickEntryLru(settings.accounts.filter(e => e.agentId === agentId))
      if (entry) base = { ...base, accountEntryId: entry.id, accountEntryLabel: entry.label }
    }
    const viaMaster = !parsed.agentId && targetAgent === 'auto'
      && !!settings.master.masterAgentId && agentId === settings.master.masterAgentId
    if (viaMaster && effectiveDispatch(def, detectMap[agentId]) === 'cli') {
      base = {
        ...base,
        text: buildMasterPrompt(taskText, readyAgents.map(a => a.name)),
        title: taskText.split('\n')[0].slice(0, 60),
        planFor: taskText,
        heavy: false,
      }
    }
    // 额度护栏：付费账户先停住等放行
    const gate = quotaGate(settings, def, settings.bindings[agentId], accounts)
    if (gate.decision === 'approval') {
      setTasks(prev => [{ ...base, status: 'waiting-approval', approvalReason: gate.reason }, ...prev])
      setInput(''); setSkillPick(null); setPendingReview(false)
      notify('已停住：这次派活要花付费账户的钱，请在任务卡上放行')
      return
    }
    // 上限检查（按已记账本金额）
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0)
    const cap = capCheck(settings, ledgerSpentSince(ledger, startOfDay.getTime()), ledgerSpentSince(ledger, sessionStartRef.current))
    if (cap === 'over-stop') { notify('已达到额度护栏上限（单会话/每日），本次派活已停住；到设置 · 额度护栏调整上限后再派', 'err'); return }
    if (cap === 'over-notify') notify('提醒：Agent 花费已超过你设的上限，本次仍继续派活')
    setTasks(prev => [base, ...prev])
    setInput(''); setSkillPick(null); setPendingReview(false)
  }

  /** v0.1.512（①）：导入会话续跑——生成带原会话 id 的任务，派活时走各家 resume 形式 */
  const importSession = (p: SessionImportPayload) => {
    const def = agentDef(p.agentId)
    if (!def) return
    const entry = settings.accounts.find(e => e.id === p.entryId && e.agentId === p.agentId)
    const task: AgentTask = {
      id: uid(), text: p.prompt,
      title: `导入会话续跑：${p.title.slice(0, 44)}`,
      agentId: def.id, agentName: def.name, kind: def.kind,
      workdir: p.cwd, heavy: false, outsideOk: p.outsideOk,
      status: 'queued', output: [], createdAt: Date.now(),
      sessionId: p.sessionId,
      accountEntryId: entry?.id, accountEntryLabel: entry?.label,
      note: `从 ${def.name} 本地存档导入（会话 ${p.sessionId.slice(0, 8)}…），用原会话上下文续跑`,
    }
    setTasks(prev => [task, ...prev])
    setView('board')
    notify(`已导入 ${def.name} 的会话，排队续跑中`)
  }

  /** v0.1.512（②）：建一对赛马任务（同题、双槽位），开跑时各自建 worktree 并行执行 */
  const createRaceTasks = (text: string, repo: string, racers: Array<RaceCandidateInput & { speed: { basis: string } }>) => {
    const raceId = `race-${Date.now().toString(36)}-${++uidSeq}`
    const made: AgentTask[] = racers.slice(0, 2).map((c, i) => {
      const def = agentDef(c.agentId)!
      const other = racers[1 - i]
      return {
        id: uid(), text, title: `赛马 · ${text.split('\n')[0].slice(0, 48)}`,
        agentId: def.id, agentName: def.name, kind: def.kind,
        workdir: repo, heavy: false, outsideOk: noVaultCoverage ? outsideOk : false,
        status: 'queued' as const, output: [], createdAt: Date.now(),
        raceId, raceSlot: (i === 0 ? 'A' : 'B') as 'A' | 'B', raceRepo: repo,
        accountEntryId: c.entryId, accountEntryLabel: c.entryLabel,
        note: `赛马对手：${other.agentName}${other.entryLabel ? ` · ${other.entryLabel}` : ''}；入选依据：${c.speed.basis}`,
      }
    })
    setTasks(prev => [...made, ...prev])
    setInput(''); setSkillPick(null); setPendingReview(false)
    setRaceApproval(null); setRaceNotice(null)
    notify(`赛马开始：${made[0].agentName} vs ${made[1].agentName}，两版完成后先互相审查、再并排对比`)
  }

  /** v0.1.512（②）赛马发起：仅 git 仓库、显式点赛马才走；选人由实测速度挑最快的两个
   *  免费选手；免费不够两个时把付费候选摆出来等放行，绝不静默跑付费。 */
  const submitRace = async () => {
    const parsed = parseDelegation(input)
    if (parsed.unknownToken) { notify(`没有叫 #${parsed.unknownToken} 的 Agent，请从 # 列表里选`, 'err'); return }
    if (parsed.agentId) {
      setRaceNotice({ text: '赛马的选手由实测速度自动挑，不接受 # 指定；要指定单个 Agent 请切回普通派活。' })
      return
    }
    const text = input.trim()
    if (!text) { notify('先写下要派的活', 'err'); return }
    const repo = workdir.trim()
    if (!repo) {
      setRaceNotice({ text: '赛马要先填工作目录：得是一个 git 仓库，两边各开一份隔离工作区（worktree）并行跑同一个任务。' })
      return
    }
    if (noVaultCoverage && !outsideOk) {
      notify(settings.vault.enabled ? '未填工作目录：赛马没有文件保险箱覆盖，请先勾选风险确认' : '文件保险箱已关闭：请先勾选风险确认（赛马的改动也靠保险箱兜底）', 'err')
      return
    }
    const info = await agentGitInfo(repo)
    if (!info.isRepo) {
      setRaceNotice({ text: '这个目录不是 git 仓库，赛马走不了（赛马靠 git worktree 隔离两份代码）。普通派活有文件保险箱兜底，可以照常派。', plain: true })
      return
    }
    // 选手池：已就绪且能无头派活的 Agent、条目级展开；费用类别如实标注
    const cands: RaceCandidateInput[] = []
    for (const def of readyAgents) {
      if (effectiveDispatch(def, detectMap[def.id]) !== 'cli') continue
      const binding = settings.bindings[def.id]
      const paid = def.kind === 'shell' && binding?.kind === 'account'
      const acct = paid && binding?.kind === 'account' ? accounts.find(a => a.id === binding.accountId) : undefined
      const paidLabel = paid ? (acct ? (acct.label || PROVIDER_MAP[acct.providerId]?.name || acct.providerId) : '已绑定的付费账户') : undefined
      if (multiAccountCapable(def)) {
        for (const e of settings.accounts.filter(x => x.agentId === def.id && x.enabled)) {
          cands.push({ agentId: def.id, agentName: def.name, entryId: e.id, entryLabel: e.label, cost: paid ? 'paid' : 'free', paidLabel })
        }
      } else {
        cands.push({ agentId: def.id, agentName: def.name, cost: paid ? 'paid' : 'free', paidLabel })
      }
    }
    const probe = loadProbeStore()
    const pick = pickRaceCandidates(cands, c => {
      const b = settings.bindings[c.agentId]
      return raceSpeed(c.agentId, ledgerRef.current, probe, b?.kind === 'account' ? b.accountId : undefined)
    })
    if (pick.shortReason) { setRaceNotice({ text: pick.shortReason }); return }
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0)
    const cap = capCheck(settings, ledgerSpentSince(ledger, startOfDay.getTime()), ledgerSpentSince(ledger, sessionStartRef.current))
    if (cap === 'over-stop') { notify('已达到额度护栏上限（单会话/每日），赛马已停住；到设置 · 额度护栏调整上限后再发起', 'err'); return }
    if (pick.needsApproval.length) {
      // 免费选手不够两个：付费候选单独摆出来，等用户放行了才凑齐开赛
      setRaceApproval({ text, repo, chosen: pick.chosen, needsApproval: pick.needsApproval })
      return
    }
    createRaceTasks(text, repo, pick.chosen)
  }

  const stopTask = async (task: AgentTask) => {
    stoppedRef.current.add(task.id)
    await agentRunStop(task.id)
    // 进程表条目已被移除，轮询拿不到退出码，这里直接按「已停止」结算
    const fresh = tasksRef.current.find(t => t.id === task.id)
    if (fresh && fresh.status === 'running') void finalizeCliTask(fresh, -1)
  }

  const approveTask = (task: AgentTask) => updateTask(task.id, { status: 'queued', approvalReason: undefined, note: '已放行（付费账户）' })
  const rejectTask = (task: AgentTask) => updateTask(task.id, { status: 'stopped', endedAt: Date.now(), note: '未放行，已取消' })

  const completeManualTask = (task: AgentTask) => {
    const now = Date.now()
    addLedger({
      id: `led-${task.id}`, taskId: task.id, agentId: task.agentId, agentName: task.agentName, kind: task.kind,
      agentEntryId: task.accountEntryId, agentEntryLabel: task.accountEntryLabel,
      startedAt: task.startedAt ?? now, endedAt: now, durationMs: now - (task.startedAt ?? now),
      status: 'manual', costYuan: null,
    })
    updateTask(task.id, { status: 'done', endedAt: now, note: '已在应用内完成（手动标记）' })
  }

  const summary = useMemo(() => summarizeLedger(ledger), [ledger])
  const runningCount = tasks.filter(t => t.status === 'running').length

  if (!desktop) {
    return (
      <div className="aw-wrap">
        <div className="aw-card aw-empty">
          <Bot size={28} />
          <h3>Agent 工作台需要桌面端</h3>
          <p>派活要拉起你电脑上的 Agent 应用与命令行工具，手机端 / 网页版做不到。请在 Mac 桌面端打开本页。</p>
        </div>
      </div>
    )
  }

  return (
    <div className="aw-wrap">
      <div className="aw-topbar">
        <div className="aw-tabs">
          <button className={view === 'board' ? 'on' : ''} onClick={() => setView('board')}><LayoutList size={14} /> 任务板</button>
          <button className={view === 'vault' ? 'on' : ''} onClick={() => setView('vault')}><FolderLock size={14} /> 文件保险箱{vaultEntries.length ? `（${vaultEntries.length}）` : ''}</button>
          <button className={view === 'sessions' ? 'on' : ''} onClick={() => setView('sessions')}><History size={14} /> 导入会话</button>
          <button className={view === 'settings' ? 'on' : ''} onClick={() => setView('settings')}><Settings2 size={14} /> 设置</button>
        </div>
        <span className="aw-topnote">运行中 {runningCount} / 并行上限 {settings.parallel.maxParallel}</span>
      </div>

      {view === 'settings' && (
        <AgentSettingsPanel
          settings={settings} onChange={setSettings} accounts={accounts} detectMap={detectMap} ledger={ledger}
          onRedetect={() => void runDetect()} vaultEntries={vaultEntries}
          onPruneNow={() => { void runPrune('手动清理') }}
          notify={notify}
        />
      )}

      {view === 'sessions' && (
        <AgentSessionsPanel
          settings={settings} detectMap={detectMap} accountStatus={accountStatus}
          onImported={importSession}
          onGoSettings={() => setView('settings')}
        />
      )}

      {view === 'compare' && compareRaceId && (
        <AgentRaceCompare
          raceId={compareRaceId} tasks={tasks} updateTask={updateTask} notify={notify}
          onBack={() => setView('board')}
        />
      )}

      {view === 'vault' && (
        <div className="aw-card">
          <div className="aw-card-head">
            <span>备份条目（仅本机 ~/.ai-credit-manager/agent-vault/，保留 {settings.vault.retentionDays} 天 / 上限 {settings.vault.capGB}GB，超限自动清最旧）</span>
            <button className="btn sm" onClick={() => void refreshVault()}>刷新</button>
          </div>
          {(() => {
            const capBytes = settings.vault.capGB * 1024 * 1024 * 1024
            const totalBytes = vaultStats.totalBytes || vaultEntries.reduce((s, e) => s + e.size, 0)
            const pct = capBytes > 0 ? Math.min(100, Math.round((totalBytes / capBytes) * 100)) : 0
            const usageRows = mergeVaultUsage(vaultEntries, vaultStats.baselines)
            const cleanable = (taskId: string) => {
              const t = tasks.find(x => x.id === taskId)
              if (!t) return true
              return !['queued', 'queued-heavy', 'running', 'waiting-approval', 'waiting-relay'].includes(t.status)
            }
            return (
              <div className="aw-vault-usage">
                <div className="aw-vault-usage-head">
                  <span>保险箱总占用 <b>{formatBytes(totalBytes)}</b> / 上限 {settings.vault.capGB}GB（含基线镜像与版本记录）</span>
                  <span className="aw-note">{pct}%</span>
                </div>
                <div className="aw-progress"><div style={{ width: `${pct}%` }} /></div>
                {pruneLog && (
                  <div className="aw-note">最近一次清理：{new Date(pruneLog.at).toLocaleString()} · 清掉 {pruneLog.removed} 条过期/超限记录（{pruneLog.trigger}）</div>
                )}
                {usageRows.length > 0 && (
                  <>
                    <div className="aw-note">按任务占用（清理基线只删该任务的基线镜像，版本记录保留、仍可一键还原）：</div>
                    {usageRows.map(u => (
                      <div key={u.taskId} className="aw-vault-row">
                        <div className="aw-vault-main">
                          <div className="aw-vault-path">{u.taskTitle || '任务'}</div>
                          <div className="aw-note">
                            {u.agentName} · 基线镜像 {formatBytes(u.baselineBytes)} · 版本记录 {u.entryCount} 条 / {formatBytes(u.entriesBytes)} · 合计 {formatBytes(u.totalBytes)}
                          </div>
                        </div>
                        {u.baselineBytes > 0 && cleanable(u.taskId) && (
                          cleanConfirmId === u.taskId ? (
                            <>
                              <button className="btn sm primary" onClick={async () => {
                                const freed = await agentVaultDeleteBaseline(u.taskId)
                                setCleanConfirmId(null)
                                notify(`已清理基线：释放 ${formatBytes(freed)}（版本记录未动）`)
                                void refreshVault()
                              }}>确认清理基线</button>
                              <button className="btn sm ghost" onClick={() => setCleanConfirmId(null)}>取消</button>
                            </>
                          ) : (
                            <button className="btn sm" onClick={() => setCleanConfirmId(u.taskId)}>清理基线</button>
                          )
                        )}
                        {u.baselineBytes > 0 && !cleanable(u.taskId) && <span className="aw-note">任务未结束，基线保留中</span>}
                      </div>
                    ))}
                  </>
                )}
              </div>
            )
          })()}
          {vaultEntries.length === 0 && <div className="aw-note">还没有备份。给 CLI 型 Agent 派活并让它改动工作目录里的文件后，被改/被删文件的上一版会出现在这里。</div>}
          {vaultEntries.map(e => (
            <div key={e.id} className="aw-vault-row">
              <div className="aw-vault-main">
                <div className="aw-vault-path">{e.originalPath}</div>
                <div className="aw-note">
                  {new Date(e.createdAt).toLocaleString()} · {e.agentName} · {e.taskTitle || '任务'} · {formatBytes(e.size)}
                  {e.kind === 'pre-restore' ? ' · 还原前备份' : ' · 上一版'}
                </div>
              </div>
              <button className="btn sm" onClick={async () => {
                try {
                  await agentVaultRestore(e.id)
                  notify(`已还原：${e.originalPath}（还原前的当前版也已备份）`)
                  void refreshVault()
                } catch (err) { notify(`还原失败：${err instanceof Error ? err.message : String(err)}`, 'err') }
              }}>一键还原</button>
              <button className="btn sm ghost" onClick={async () => { await agentVaultDeleteEntries([e.id]); void refreshVault() }} aria-label="删除条目"><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
      )}

      {view === 'board' && (
        <>
          {!settings.vault.enabled && (
            <div className="aw-risk"><ShieldAlert size={15} /> 文件保险箱已关闭：Agent 以最大权限自动执行，文件改动<b>不可还原</b>。建议到设置 · 权限与保险箱重新打开。</div>
          )}
          <div className="aw-card aw-dispatch">
            <div className="aw-dispatch-row">
              <select className="aw-target" value={targetAgent} onChange={e => setTargetAgent(e.target.value)} disabled={raceMode} title={raceMode ? '赛马模式：选手由实测速度自动挑' : '委派给（# 指定优先）'}>
                <option value="auto">自动（主控/第一个可用）</option>
                {readyAgents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <input className="aw-workdir" type="text" placeholder="工作目录（保险箱基线范围，如 /Users/你/项目）"
                value={workdir} onChange={e => setWorkdir(e.target.value)} />
              <select className="aw-heavy" value={heavyMode} onChange={e => setHeavyMode(e.target.value as typeof heavyMode)} title="重活判定">
                <option value="auto">自动判定轻重</option>
                <option value="heavy">这是重活（构建/测试/打包）</option>
                <option value="light">这是轻活</option>
              </select>
            </div>
            {(() => {
              const selDef = targetAgent !== 'auto' ? agentDef(targetAgent) : undefined
              if (!selDef || !multiAccountCapable(selDef)) return null
              const entries = settings.accounts.filter(e => e.agentId === selDef.id && e.enabled)
              if (entries.length < 2) return null
              return (
                <div className="aw-entry-row">
                  <span className="aw-entry-label">用哪个账户：</span>
                  <button className={`aw-entry-chip ${entryPick === 'auto' ? 'on' : ''}`} onClick={() => setEntryPick('auto')}>自动（最久未用）</button>
                  {entries.map(e => {
                    const login = accountStatus[e.id]?.login
                    const chipText = loginStateText(login, {
                      probeMissing: selDef.credProbeMissing,
                      verifiedAt: settings.verifiedAgents?.[selDef.id],
                    })
                    return (
                      <button key={e.id} className={`aw-entry-chip ${entryPick === e.id ? 'on' : ''}`} onClick={() => setEntryPick(e.id)}>
                        {e.label}{login === 'yes' ? ' · 已登录' : login === 'no' ? ' · 未登录'
                          : settings.verifiedAgents?.[selDef.id] ? ' · 已验证'
                          : login === 'unknown' && selDef.credProbeMissing === 'unknown' ? ' · 待派活验证'
                          : login ? ` · ${chipText}` : ''}
                      </button>
                    )
                  })}
                </div>
              )
            })()}
            <div className="aw-input-wrap" ref={inputWrapRef}>
              <textarea
                className="aw-input" rows={3} value={input}
                placeholder="写下要派的活，打 # 可指定 Agent（如：#Pi 把 src 里的日志改成英文）"
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit() }}
              />
              {pickerVisible && (
                <div className={`aw-picker ${pickerDir.down ? 'down' : ''}`} style={{ maxHeight: pickerDir.maxH }}>
                  {(pickerList.length > 0 || pickerEntries.length > 0) && <div className="aw-picker-group">委派 Agent</div>}
                  {pickerList.map(a => (
                    <button key={a.id} onClick={() => setInput(prev => prev.replace(/(^|\s)#([^\s#]*)$/, `$1#${a.name} `))}>
                      <b>{a.name}</b><span>{a.kind === 'account' ? '账号登录型 · 免 Key' : '空壳型 · 供 Key'}</span>
                    </button>
                  ))}
                  {pickerEntries.map(({ agent, entry }) => (
                    <button key={`${agent.id}:${entry.id}`} onClick={() => { setTargetAgent(agent.id); setEntryPick(entry.id); setInput(prev => prev.replace(/(^|\s)#([^\s#]*)$/, `$1#${agent.name} `)) }}>
                      <b>{agent.name} · {entry.label}</b><span>账户条目</span>
                    </button>
                  ))}
                  {pickerCommands.length > 0 && <div className="aw-picker-group">原生命令</div>}
                  {pickerCommands.map(c => (
                    <button key={c.id} onClick={() => { setInput(prev => prev.replace(/(^|\s)#([^\s#]*)$/, '$1')); if (c.id === 'compact') dispatchCompact(); else setPendingReview(true) }}>
                      <b>{c.name}</b><span>{c.desc}</span>
                    </button>
                  ))}
                  {pickerSkills.length > 0 && <div className="aw-picker-group">工坊技能</div>}
                  {pickerSkills.map(sk => (
                    <button key={sk.id} onClick={() => { setSkillPick(sk); setInput(prev => prev.replace(/(^|\s)#([^\s#]*)$/, '$1')) }}>
                      <b>{sk.name}</b><span>工坊技能 · 选中后写下具体任务，派活时按该技能口径执行</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {(skillPick || pendingReview) && (
              <div className="aw-pick-chips">
                {skillPick && <span className="aw-pick-chip">工坊技能 · {skillPick.name}<button onClick={() => setSkillPick(null)}>×</button></span>}
                {pendingReview && <span className="aw-pick-chip">下一件任务将强制交叉审查<button onClick={() => setPendingReview(false)}>×</button></span>}
              </div>
            )}
            <div className="aw-dispatch-foot">
              {noVaultCoverage ? (
                <label className="aw-ack">
                  <input type="checkbox" checked={outsideOk} onChange={e => setOutsideOk(e.target.checked)} />
                  {settings.vault.enabled
                    ? '我知道：未填工作目录，本次任务没有保险箱覆盖，Agent 可能写入任何位置'
                    : '我知道：保险箱已关闭，本次任务的文件改动不可还原'}
                </label>
              ) : (
                <span className="aw-note">保险箱已覆盖工作目录：开跑前存基线，改动可还原。目录外写入不在覆盖内。</span>
              )}
              <span className="aw-dispatch-actions">
                <span className="aw-seg" role="group" aria-label="派活方式">
                  <button className={!raceMode ? 'on' : ''} onClick={() => { setRaceMode(false); setRaceNotice(null); setRaceApproval(null) }}>普通派活</button>
                  <button className={raceMode ? 'on' : ''} onClick={() => setRaceMode(true)}><Swords size={12} /> 赛马</button>
                </span>
                {raceMode
                  ? <button className="btn primary" onClick={() => void submitRace()}><Swords size={14} /> 开始赛马</button>
                  : <button className="btn primary" onClick={submit}><Play size={14} /> 派活</button>}
              </span>
            </div>
            {raceMode && !raceApproval && (
              <div className="aw-note">赛马：同一个任务让实测最快的两个选手各开一份隔离工作区（git worktree）并行做，完成后先互相审查、再并排对比由你点选胜出合并。只走免费路线，要动付费会先停住问你。</div>
            )}
            {raceNotice && (
              <div className="aw-note warn">
                {raceNotice.text}
                {raceNotice.plain && (
                  <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => { setRaceMode(false); setRaceNotice(null); submit() }}>改用普通派活</button>
                )}
                <button className="btn sm ghost" onClick={() => setRaceNotice(null)}>知道了</button>
              </div>
            )}
            {raceApproval && (
              <div className="aw-approval">
                <div>
                  <Hand size={14} /> 免费选手不够两个。已按实测速度选好：
                  {raceApproval.chosen.map(c => `${c.agentName}${c.entryLabel ? ` · ${c.entryLabel}` : ''}（${c.speed.basis}）`).join('、') || '（无）'}
                  ；再补一个最快的就得用付费路线：
                  {raceApproval.needsApproval.map(c => `${c.agentName}（绑定付费账户「${c.paidLabel ?? '付费账户'}」，按量计费）`).join('、')}。
                  放行后两边一起开跑，付费选手的费用记在它绑定的账户上。
                </div>
                <div className="aw-approval-btns">
                  <button className="btn sm primary" onClick={() => createRaceTasks(raceApproval.text, raceApproval.repo, [...raceApproval.chosen, ...raceApproval.needsApproval])}>放行并开始赛马</button>
                  <button className="btn sm" onClick={() => setRaceApproval(null)}>不放行</button>
                </div>
              </div>
            )}
            {readyAgents.length === 0 && (
              <div className="aw-note warn">当前没有可委派的 Agent：到「设置 · Agent 管理」启用已安装的 Agent（空壳型还需绑定 Key / 免费路线 / 自身登录）。</div>
            )}
            <div className="aw-usagebar" ref={usageBarRef}>
              <button className="aw-usage-main" onClick={() => setUsageOpen(o => !o)}>
                <span>缓存命中率 {usage.cacheHitPct == null ? '—（暂无数据）' : `${usage.cacheHitPct.toFixed(1)}%`}</span>
                <span>输出速度 {usage.lastTps == null ? '—（暂无数据）' : `${usage.lastTps.toFixed(0)} tok/s`}</span>
                <span>费用 ${usage.costUsd.toFixed(2)}{usage.costYuan ? ` / ¥${usage.costYuan.toFixed(2)}` : ''}</span>
                <span>上下文已用 {usage.contextPct == null ? '—（暂无数据）' : `${usage.contextPct.toFixed(0)}%`}</span>
                <span className="aw-usage-toggle">{usageOpen ? '收起用量' : '用量详情'}</span>
              </button>
              {usageOpen && (
                <div className="aw-usage-pop">
                  <div>上下文占用：{usage.contextPct == null ? '暂无数据' : `${usage.contextPct.toFixed(1)}%`}（账本已记录输入+输出共 {usage.contextTokens} tokens）</div>
                  <div>输出速度：最近 {usage.lastTps == null ? '暂无数据' : `${usage.lastTps.toFixed(1)} tok/s`} · 平均 {usage.avgTps == null ? '暂无数据' : `${usage.avgTps.toFixed(1)} tok/s`}</div>
                  <div>首字延迟（探测中心样本）：{usage.ttftMs == null ? '暂无数据' : `${Math.round(usage.ttftMs)} ms`}</div>
                  <div>缓存命中：最近 暂无数据 · 平均 暂无数据（现有数据源没有缓存统计，不编造）</div>
                  <div>输入 tokens：{usage.inputTokens} · 输出 tokens：{usage.outputTokens} · 缓存读取 tokens：暂无数据</div>
                  <div>费用估算：${usage.costUsd.toFixed(4)}{usage.costYuan ? ` / ¥${usage.costYuan.toFixed(4)}` : ''}（账本累计，CLI 自报原值）</div>
                </div>
              )}
            </div>
          </div>

          <div className="aw-card aw-settle">
            <div className="aw-card-head"><span>结算卡（本机账本）</span><span className="aw-note">共 {summary.totalTasks} 个任务</span></div>
            <div className="aw-settle-grid">
              <div><b>{summary.totalTasks}</b><span>总任务</span></div>
              <div><b>{summary.totalTokens ? summary.totalTokens.toLocaleString() : '—'}</b><span>已上报 tokens</span></div>
              <div><b>{summary.totalCostUsd ? `$${summary.totalCostUsd.toFixed(4)}` : '—'}</b><span>CLI 上报金额（美元原值）</span></div>
              <div><b>{summary.totalCostYuan ? `¥${summary.totalCostYuan.toFixed(2)}` : '—'}</b><span>魔方记账金额</span></div>
            </div>
            {(() => {
              // v0.1.512（③）：免费额度占比条 + 近 7 日任务量迷你趋势（数据只来自账本，无数据显空态）
              const share = raceFreeShare(ledger)
              const trend = last7DaysTrend(ledger, Date.now())
              const maxCount = Math.max(1, ...trend.map(d => d.count))
              return (
                <div className="aw-settle-dash">
                  <div className="aw-ratio">
                    <div className="aw-ratio-head">
                      <span>免费路线占比（按任务数）</span>
                      <span className="aw-note">{share.pct == null ? '暂无数据' : `${share.freeTasks} / ${share.totalTasks} 个任务 · ${share.pct}%`}</span>
                    </div>
                    <div className="aw-progress"><div style={{ width: `${share.pct ?? 0}%` }} /></div>
                    <div className="aw-note">账号型自有额度 + 免费路线/自身登录绑定的任务算免费路线；绑付费账户的任务不算。</div>
                  </div>
                  <div className="aw-trend">
                    <div className="aw-ratio-head"><span>近 7 日任务量</span></div>
                    {share.totalTasks === 0
                      ? <div className="aw-note">近 7 日暂无任务记录</div>
                      : (
                        <div className="aw-trend-bars">
                          {trend.map(d => (
                            <div key={d.label} className="aw-trend-col" title={`${d.label}：${d.count} 个任务`}>
                              <span className="aw-trend-num">{d.count || ''}</span>
                              <div className="aw-trend-bar" style={{ height: `${Math.max(4, Math.round((d.count / maxCount) * 36))}px` }} />
                              <span className="aw-trend-label">{d.label}</span>
                            </div>
                          ))}
                        </div>
                      )}
                  </div>
                </div>
              )
            })()}
            {summary.byAgent.length > 0 && (
              <div className="aw-settle-list">
                {summary.byAgent.map(a => (
                  <div key={a.agentId} className="aw-settle-row">
                    <span>{a.agentName}</span>
                    <span className="aw-note">{a.tasks} 个任务 · {formatDuration(a.durationMs)}{a.tokens ? ` · ${a.tokens.toLocaleString()} tokens` : ''}{a.costUsd ? ` · $${a.costUsd.toFixed(4)}` : ''}</span>
                  </div>
                ))}
              </div>
            )}
            {summary.byAccount.length > 0 && (
              <div className="aw-settle-list">
                <div className="aw-note">按账户（空壳型供 Key）</div>
                {summary.byAccount.map(a => (
                  <div key={a.accountId} className="aw-settle-row">
                    <span>{a.accountLabel}</span>
                    <span className="aw-note">{a.tasks} 个任务{a.tokens ? ` · ${a.tokens.toLocaleString()} tokens` : ' · CLI 未上报用量'}{a.costUsd ? ` · $${a.costUsd.toFixed(4)}` : ''}</span>
                  </div>
                ))}
              </div>
            )}
            {summary.accountKindAgents.length > 0 && (
              <div className="aw-settle-list">
                <div className="aw-note">自有额度 · 不计入魔方账本（账号登录型，只记任务数与时长）</div>
                {summary.accountKindAgents.map(a => (
                  <div key={a.agentId} className="aw-settle-row">
                    <span>{a.agentName}</span>
                    <span className="aw-note">{a.tasks} 个任务 · {formatDuration(a.durationMs)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="aw-tasks">
            {tasks.length === 0 && <div className="aw-card aw-note">还没有任务。在上方写下要派的活，点「派活」。</div>}
            {handoverFor && (() => {
              const orig = handoverFor
              const options: Array<{ key: string; label: string; agentId: string; entryId?: string }> = []
              for (const a of readyAgents) {
                if (multiAccountCapable(a)) {
                  for (const e of settings.accounts.filter(x => x.agentId === a.id && x.enabled)) {
                    if (a.id === orig.agentId && e.id === orig.accountEntryId) continue
                    options.push({ key: `${a.id}::${e.id}`, label: `${a.name} · ${e.label}`, agentId: a.id, entryId: e.id })
                  }
                } else if (a.id !== orig.agentId) {
                  options.push({ key: a.id, label: a.name, agentId: a.id })
                }
              }
              const models = buildModelChoices(loadProbeStore())
              const platforms = [...new Set(models.map(m => m.platformName))]
              return (
                <div className="aw-modal-backdrop" onClick={() => setHandoverFor(null)}>
                  <div className="aw-modal" onClick={e => e.stopPropagation()}>
                    <h3>交接任务</h3>
                    <p className="aw-note">把「{orig.title ?? orig.text}」交给另一个 Agent / 账户续跑：原任务卡只读保留并标注已交接，新任务带（续）与上下文包。</p>
                    <div className="aw-modal-label">先选目标 Agent（多账户细到条目）</div>
                    {options.length === 0 && <p className="aw-note">暂无其他可交接的 Agent（都未就绪，或只有当前这一个）。</p>}
                    {options.map(o => (
                      <label key={o.key} className="aw-modal-opt">
                        <input type="radio" name="hov-agent" checked={hovKey === o.key} onChange={() => setHovKey(o.key)} /> {o.label}
                      </label>
                    ))}
                    <div className="aw-modal-label">再选模型（来自探测中心目录，已按平台分组、去重、带实测状态）</div>
                    <select className="aw-modal-select" value={hovModelId} onChange={e => setHovModelId(e.target.value)}>
                      <option value="">不指定（接棒者默认）</option>
                      {platforms.map(pl => (
                        <optgroup key={pl} label={pl}>
                          {models.filter(m => m.platformName === pl).map(m => (
                            <option key={m.id} value={m.id}>{m.label}（{m.status === 'ok' ? '实测可用' : m.status === 'bad' ? '实测不可用' : '未测'}）</option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                    {models.length === 0 && <p className="aw-note">探测中心暂无模型目录（还没测过任何模型），可以先不指定模型。</p>}
                    <div className="aw-modal-actions">
                      <button className="btn" onClick={() => setHandoverFor(null)}>取消</button>
                      <button className="btn primary" disabled={!hovKey} onClick={() => {
                        const opt = options.find(o => o.key === hovKey)
                        if (!opt) return
                        const model = models.find(m => m.id === hovModelId)
                        setHandoverFor(null)
                        void doRelay(orig, opt.agentId, '手动交接', { entryId: opt.entryId, modelLabel: model?.label, modelTargetId: hovModelId || undefined })
                      }}>确认交接</button>
                    </div>
                  </div>
                </div>
              )
            })()}
            {tasks.map(task => {
              const meta = STATUS_META[task.status]
              const elapsed = task.startedAt ? (task.endedAt ?? Date.now()) - task.startedAt : 0
              return (
                <div key={task.id} className={`aw-card aw-task ${task.status === 'running' ? 'running' : ''}`}>
                  <div className="aw-task-head">
                    <b className="aw-task-agent">{task.agentName}</b>
                    {task.accountEntryLabel && <span className="aw-task-entry">· {task.accountEntryLabel}</span>}
                    {(() => {
                      const tt = task.tier ?? (task.dispatch ? (task.dispatch === 'cli' ? 1 : 3) : null)
                      return tt ? <span className={`aw-tier t${tt}`}>{tierLabel(tt as 1 | 3)}</span> : null
                    })()}
                    {task.raceId && <span className="aw-tag heavy"><Swords size={11} /> 赛马 {task.raceSlot}</span>}
                    {task.raceOutcome === 'winner' && <span className="aw-tag ok"><Trophy size={11} /> 胜出（已合并）</span>}
                    {task.raceOutcome === 'loser' && <span className="aw-tag off">落选（已清理）</span>}
                    <span className={`aw-status ${meta.cls}`}>{meta.label}</span>
                    {task.delivery && deliveryChipLabel(task.delivery.state) && (
                      <span className="aw-status dlv">{deliveryChipLabel(task.delivery.state)}</span>
                    )}
                    {task.heavy && <span className="aw-tag heavy">重活</span>}
                    <span className="aw-note">{new Date(task.createdAt).toLocaleTimeString()}{task.startedAt ? ` · ${formatDuration(elapsed)}` : ''}</span>
                    <span className="aw-task-actions">
                      {(task.status === 'done' || task.status === 'failed' || task.status === 'stopped' || task.status === 'unresolved') && (
                        <button className="btn sm ghost" onClick={() => setTasks(prev => prev.filter(t => t.id !== task.id))} aria-label="删除记录"><Trash2 size={13} /></button>
                      )}
                    </span>
                  </div>
                  {task.title ? (
                    <>
                      <div className="aw-task-text">{task.title}</div>
                      <details className="aw-details">
                        <summary>{task.relayFromId ? '上下文包（递给接棒者的完整说明）' : task.planFor ? '拆活提示（递给主控的）' : '任务说明'}</summary>
                        <div className="aw-note aw-details-body">{task.text}</div>
                      </details>
                    </>
                  ) : (
                    <div className="aw-task-text">{task.text}</div>
                  )}
                  {task.relayFromId && (() => {
                    const src = tasks.find(t => t.id === task.relayFromId)
                    return <div className="aw-note">接力自 {src?.agentName ?? '上一棒'}{task.relayReason ? ` · 原因：${task.relayReason}` : ''}（上下文已打包递交）</div>
                  })()}
                  {task.relayToId && (() => {
                    const dst = tasks.find(t => t.id === task.relayToId)
                    return <div className="aw-note">已接力 → {dst?.agentName ?? '接棒者'}（在任务板上续跑）</div>
                  })()}
                  {task.workdir && <div className="aw-note">工作目录：{task.workdir}</div>}
                  {task.approvalReason && task.status === 'waiting-approval' && (
                    <div className="aw-approval">
                      <div><Hand size={14} /> {task.approvalReason}</div>
                      <div className="aw-approval-btns">
                        <button className="btn sm primary" onClick={() => approveTask(task)}>放行并启动</button>
                        <button className="btn sm" onClick={() => rejectTask(task)}>不放行</button>
                      </div>
                    </div>
                  )}
                  {task.status === 'waiting-relay' && task.relayProposal && (
                    <div className="aw-approval">
                      <div><Repeat size={14} /> {task.agentName} 停在这里了（{task.relayProposal.reason}）。按接力链，下一个接棒的是 <b>{task.relayProposal.candidateName}</b>。</div>
                      <div className="aw-note">将带过去：原任务全文、工作目录、输出摘要、已改文件清单（{task.relayProposal.changedFiles} 个，上一版都在保险箱里）。</div>
                      {task.relayProposal.skipped.length > 0 && (
                        <div className="aw-note">链上排在前面但被跳过的：{task.relayProposal.skipped.map(s => `${s.agentName}（${s.reason}）`).join('；')}</div>
                      )}
                      <div className="aw-approval-btns">
                        <button className="btn sm primary" onClick={() => confirmRelay(task)}>确认接力给 {task.relayProposal.candidateName}</button>
                        <button className="btn sm" onClick={() => cancelRelay(task)}>不接力</button>
                      </div>
                    </div>
                  )}
                  {task.note && <div className="aw-note warn">{task.note}</div>}
                  {task.delivery && (
                    <div className={`aw-delivery ${task.delivery.state}`}>{task.delivery.note}</div>
                  )}
                  {task.review && (
                    <div className={`aw-review ${task.review.state}`}>
                      <ClipboardCheck size={14} />
                      {task.review.state === 'running' && <span>交叉审查中（审查者：{task.review.reviewerName}）…</span>}
                      {task.review.state === 'pass' && <span>审查通过（{task.review.reviewerName}）{task.review.points ? `：${task.review.points}` : ''}</span>}
                      {task.review.state === 'issues' && <span>审查发现问题（{task.review.reviewerName}）：{task.review.points || '未给出要点'}</span>}
                      {task.review.state === 'failed' && <span>审查未完成：{task.review.reason}</span>}
                    </div>
                  )}
                  {task.raceReview && (
                    <div className={`aw-review ${task.raceReview.state}`}>
                      <ClipboardCheck size={14} />
                      {task.raceReview.state === 'running' && <span>赛马交叉审查中（对手 {task.raceReview.reviewerName} 在审这一版）…</span>}
                      {task.raceReview.state === 'pass' && <span>赛马对手审查通过（{task.raceReview.reviewerName}）{task.raceReview.points ? `：${task.raceReview.points}` : ''}</span>}
                      {task.raceReview.state === 'issues' && <span>赛马对手审查发现问题（{task.raceReview.reviewerName}）：{task.raceReview.points || '未给出要点'}</span>}
                      {task.raceReview.state === 'failed' && <span>赛马交叉审查未完成：{task.raceReview.reason}</span>}
                    </div>
                  )}
                  {!task.review && settings.master.crossReview && (task.dispatch ?? agentDef(task.agentId)?.dispatch) === 'open'
                    && (task.status === 'manual' || task.status === 'done') && (
                    <div className="aw-note">桌面型任务不支持自动审查（没有可审的输出）</div>
                  )}
                  {task.output.length > 0 && (() => {
                    // v0.1.511（④）：主区域只给人话——进度行 + 最终答复；无头 CLI 的 JSON
                    // 事件流不再整段糊卡，原文折叠进「原始输出」（默认收起）。失败原因走
                    // humanizeAgentError 人话行（解析器抽出的 errorText 优先于卡上 note）。
                    const parsed = parseCliOutput(task.agentId, task.output)
                    const humanFail = task.status === 'failed'
                      ? (humanizeAgentError(parsed.errorText) || task.note || '')
                      : ''
                    const progressTail = parsed.progress.slice(-12)
                    return (
                      <>
                        {progressTail.length > 0 && (
                          <div className="aw-progress-lines">
                            {progressTail.map((p, i) => <div key={i}>{p}</div>)}
                          </div>
                        )}
                        {parsed.finalText && <div className="aw-final">{parsed.finalText}</div>}
                        {humanFail && <div className="aw-note warn">{humanFail}</div>}
                        <details className="aw-raw">
                          <summary>原始输出</summary>
                          <pre className="aw-output">{task.output.slice(-60).join('\n')}</pre>
                        </details>
                      </>
                    )
                  })()}
                  <div className="aw-task-btns">
                    {task.raceId && (() => {
                      const sib = tasks.find(t => t.raceId === task.raceId && t.id !== task.id)
                      const term = (s: AgentTask['status']) => ['done', 'failed', 'stopped', 'unresolved'].includes(s)
                      return sib && term(task.status) && term(sib.status) ? (
                        <button className="btn sm" onClick={() => { setCompareRaceId(task.raceId!); setView('compare') }}><Swords size={13} /> 看赛马对比</button>
                      ) : null
                    })()}
                    {task.status === 'running' && (task.dispatch ?? agentDef(task.agentId)?.dispatch) === 'cli' && (
                      <button className="btn sm" onClick={() => void stopTask(task)}><Square size={13} /> 停止</button>
                    )}
                    {(task.status === 'failed' || task.status === 'stopped' || task.status === 'unresolved') && !task.relayToId && !task.handedOver && (
                      <button className="btn sm" onClick={() => openHandover(task)}><Repeat size={13} /> 换人</button>
                    )}
                    {task.status === 'failed' && /还没登录|登录态/.test(task.note ?? '') && (
                      <button className="btn sm" onClick={() => setView('settings')}>去登录</button>
                    )}
                    {task.status === 'failed' && /未安装|命令不存在/.test(task.note ?? '') && (
                      <button className="btn sm" onClick={() => setView('settings')}>一键安装</button>
                    )}
                    {task.status === 'manual' && (
                      <>
                        <button className="btn sm" onClick={() => { void navigator.clipboard?.writeText(task.text).then(() => notify('任务文本已复制，去应用里粘贴')) }}><Copy size={13} /> 复制任务</button>
                        <button className="btn sm primary" onClick={() => completeManualTask(task)}><CheckCircle2 size={13} /> 标记完成</button>
                        {!task.relayToId && !task.handedOver && (
                          <button className="btn sm" onClick={() => openHandover(task)}><Repeat size={13} /> 换人</button>
                        )}
                        <button className="btn sm ghost" onClick={() => updateTask(task.id, { status: 'stopped', endedAt: Date.now(), note: '已放弃（手动关闭）' })}><XCircle size={13} /> 放弃</button>
                      </>
                    )}
                    {task.status === 'queued' && <span className="aw-note"><Hourglass size={12} /> 等待空位（并行上限 {settings.parallel.maxParallel}，重活全局 1 个）</span>}
                    {task.status === 'running' && (task.dispatch ?? agentDef(task.agentId)?.dispatch) === 'open' && <span className="aw-note"><ExternalLink size={12} /> 正在打开应用…</span>}
                    {task.status === 'waiting-approval' && <span className="aw-note"><Clock3 size={12} /> 已停住，不放行不会启动、不会扣费</span>}
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
