import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot, Play, Square, Copy, Trash2, ShieldAlert, FolderLock, Settings2, LayoutList,
  CheckCircle2, XCircle, Clock3, Hourglass, Hand, ExternalLink, Repeat, ClipboardCheck,
} from 'lucide-react'
import type { Account } from '../core/types'
import {
  AGENT_REGISTRY, agentDef, agentAvailability, buildCliInvocation, buildShellEnv,
  parseDelegation, pickStartable, isHeavyTask, quotaGate, capCheck, parseCliUsage,
  loadAgentSettings, saveAgentSettings, loadAgentTasks, saveAgentTasks,
  loadAgentLedger, saveAgentLedger, summarizeLedger, ledgerSpentSince,
  type AgentDef, type AgentSettings, type AgentTask, type AgentLedgerEntry, type AgentDetectResult,
} from '../core/agents'
import {
  classifyRelayFailure, pickRelayCandidate, buildRelayContextPack, relayTitle,
  buildMasterPrompt, parseMasterPlan, resolvePlanAgent, buildReviewPrompt, parseReviewVerdict,
} from '../core/agentRelay'
import {
  agentDetect, agentLaunchApp, agentRunStart, agentRunPoll, agentRunStop,
  agentVaultBaseline, agentVaultPoll, agentVaultList, agentVaultRestore, agentVaultDeleteEntries, agentVaultPrune,
  agentVaultStats, agentVaultDeleteBaseline, type VaultStatsResult,
} from '../core/agentBridge'
import {
  formatBytes, formatDuration, mergeVaultUsage, loadPruneLog, savePruneLog,
  type VaultEntry, type VaultPruneLog,
} from '../core/agentVault'
import { isDesktopApp } from '../core/openExternal'
import { decryptSecret } from '../core/crypto'
import { enginesFor } from '../data/engines'
import { PROVIDER_MAP } from '../data/providers'
import { AgentSettingsPanel } from './AgentSettingsPanel'

type View = 'board' | 'vault' | 'settings'

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
  const ledgerRef = useRef(ledger)
  ledgerRef.current = ledger
  const vaultEntriesRef = useRef(vaultEntries)
  vaultEntriesRef.current = vaultEntries
  const reviewRunsRef = useRef(new Map<string, ReviewRun>())
  const cursorsRef = useRef(new Map<string, number>())
  const outputsRef = useRef(new Map<string, string[]>())
  const startingRef = useRef(new Set<string>())
  const stoppedRef = useRef(new Set<string>())
  const baselinedRef = useRef(new Set<string>())
  const vaultPolledAtRef = useRef(new Map<string, number>())
  const sessionStartRef = useRef(Date.now())

  useEffect(() => { saveAgentSettings(settings) }, [settings])
  useEffect(() => { saveAgentTasks(tasks) }, [tasks])
  useEffect(() => { saveAgentLedger(ledger) }, [ledger])

  const updateTask = useCallback((id: string, patch: Partial<AgentTask>) => {
    setTasks(prev => prev.map(t => (t.id === id ? { ...t, ...patch } : t)))
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
  const buildRunEnv = useCallback(async (def: AgentDef, st: AgentSettings): Promise<{ envPairs: Array<[string, string]> } | { error: string }> => {
    const binding = st.bindings[def.id]
    if (binding?.kind === 'account') {
      const acct = accountsRef.current.find(a => a.id === binding.accountId)
      if (!acct?.encryptedKey) return { error: '绑定的账户不存在或没有 Key，已取消派活' }
      const pwd = sessionPwdRef.current
      if (!pwd) return { error: '保险箱未解锁，取不出绑定账户的 Key：请先到「API Key 管理」页解锁，再重新派发' }
      let plain = ''
      try { plain = await decryptSecret(acct.encryptedKey, pwd) } catch { return { error: '解密绑定账户的 Key 失败，已取消派活' } }
      const modelId = enginesFor(acct.providerId)[0]?.id
      return { envPairs: Object.entries(buildShellEnv(binding, acct, plain, modelId)) }
    }
    return { envPairs: Object.entries(buildShellEnv(binding, undefined, undefined)) }
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
      return { ...base, status: 'unresolved', note: '已达到额度护栏上限（单会话/每日），已停住；到设置 · 额度护栏调整上限后，点任务卡上的「换人续跑」或重新派发' }
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
  const doRelay = useCallback(async (orig: AgentTask, candidateId: string, reasonLabel: string) => {
    const candDef = agentDef(candidateId)
    if (!candDef) return
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
    const successor = prepareDerivedTask({
      id: uid(), text: buildRelayContextPack(packInput), title: relayTitle(packInput),
      agentId: candDef.id, agentName: candDef.name, kind: candDef.kind,
      workdir: orig.workdir, heavy: orig.heavy, outsideOk: orig.outsideOk,
      status: 'queued', output: [], createdAt: Date.now(),
      relayFromId: orig.id, relayReason: reasonLabel,
    })
    const wasManual = orig.status === 'manual' || orig.relayFromStatus === 'manual'
    if (wasManual) {
      const now = Date.now()
      addLedger({
        id: `led-${orig.id}`, taskId: orig.id, agentId: orig.agentId, agentName: orig.agentName, kind: orig.kind,
        startedAt: orig.startedAt ?? now, endedAt: now, durationMs: now - (orig.startedAt ?? now),
        status: 'manual', costYuan: null,
      })
    }
    const origStatus: AgentTask['status'] = orig.status === 'waiting-relay'
      ? (orig.relayFromStatus === 'manual' ? 'stopped' : (orig.relayFromStatus ?? 'failed'))
      : wasManual ? 'stopped' : orig.status
    setTasks(prev => [successor, ...prev.map(t => (t.id === orig.id
      ? {
          ...t, relayToId: successor.id, relayProposal: undefined,
          status: origStatus, endedAt: t.endedAt ?? Date.now(),
          note: `已接力 → ${candDef.name}（${reasonLabel}）`,
        }
      : t))])
    notify(`已接力：${orig.agentName} → ${candDef.name} 续跑`)
  }, [addLedger, prepareDerivedTask, relayChainOf])

  /** 接力决策：按设置模式自动接力或停住询问；无人可接落「待处理」并写明每个跳过原因 */
  const considerRelay = useCallback((orig: AgentTask, reasonLabel: string) => {
    const st = settingsRef.current
    const used = relayChainOf(orig).map(t => t.agentId)
    const avail = (id: string) => {
      const d = agentDef(id)
      return d ? agentAvailability(d, detectMapRef.current[id], st, accountsRef.current) : null
    }
    const pick = pickRelayCandidate(st.relay.chain, used, AGENT_REGISTRY, avail)
    if (!pick.candidateId) {
      const reasons = pick.skipped.length
        ? pick.skipped.map(s => `${s.agentName}：${s.reason}`).join('；')
        : '接力链是空的（到设置 · 接力与调度里添加接棒者）'
      updateTask(orig.id, { status: 'unresolved', relayProposal: undefined, note: `无人可接力：${reasons}` })
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
      return d && agentAvailability(d, detectMapRef.current[a.id], st, accountsRef.current).state === 'ready'
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
    if (!st.master.crossReview) return
    const fail = (reason: string, reviewerName?: string) =>
      updateTask(task.id, { review: { state: 'failed', reviewerName, reason } })
    const reviewerId = st.master.reviewerAgentId
    if (!reviewerId) { fail('未选择审查者（到设置 · 主控与审查里选一个）'); return }
    const rDef = agentDef(reviewerId)
    if (!rDef || rDef.dispatch !== 'cli') { fail('审查者不是可真派活的 CLI 型 Agent'); return }
    if (reviewerId === task.agentId) { fail('审查者与执行者是同一个，已跳过', rDef.name); return }
    const avail = agentAvailability(rDef, detectMapRef.current[reviewerId], st, accountsRef.current)
    if (avail.state !== 'ready') { fail(`审查者不可用：${avail.reason}`, rDef.name); return }
    updateTask(task.id, { review: { state: 'running', reviewerName: rDef.name } })
    const envRes = await buildRunEnv(rDef, st)
    if ('error' in envRes) { fail(envRes.error, rDef.name); return }
    const changedFiles = [...new Set(vaultEntriesRef.current.filter(e => e.taskId === task.id).map(e => e.originalPath))]
    const prompt = buildReviewPrompt({
      taskText: task.planFor ?? task.text, taskTitle: task.title,
      agentName: task.agentName, output: outputText, changedFiles,
    })
    const inv = buildCliInvocation(rDef.id, prompt)
    if (!inv) { fail('审查者没有 CLI 派活方式', rDef.name); return }
    const runId = `review-${task.id}`
    try {
      await agentRunStart(runId, inv.command, inv.args, task.workdir, envRes.envPairs)
      reviewRunsRef.current.set(task.id, {
        runId, cursor: 0, output: [], reviewerId: rDef.id, reviewerName: rDef.name, startedAt: Date.now(),
      })
    } catch (e) {
      fail(`审查启动失败：${e instanceof Error ? e.message : String(e)}`, rDef.name)
    }
  }, [buildRunEnv, updateTask])

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
      accountId: acct?.id, accountLabel: acct ? (acct.label || PROVIDER_MAP[acct.providerId]?.name || acct.providerId) : undefined,
      startedAt: task.startedAt ?? now, endedAt: now, durationMs: now - (task.startedAt ?? now),
      status, costYuan: null,
      costUsd: usage ? usage.costUsd : null,
      inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens,
    })
    updateTask(task.id, {
      status, endedAt: now, exitCode,
      note: wasStopped ? '已被你停止' : exitCode === 0 ? undefined : `进程退出码 ${exitCode}`,
    })
    // 二期联动（主控拆活回填 / 额度类失败接力 / 完成后的交叉审查）
    if (status === 'done' && task.planFor) {
      handleMasterPlan(task, outputText)
    } else if (status === 'failed') {
      const rel = classifyRelayFailure(outputText, exitCode)
      if (rel) considerRelay({ ...task, status, exitCode }, rel.label)
    } else if (status === 'done') {
      void maybeStartReview(task, outputText)
    }
  }, [addLedger, refreshVault, updateTask, handleMasterPlan, considerRelay, maybeStartReview])

  const startTask = useCallback(async (task: AgentTask) => {
    if (startingRef.current.has(task.id)) return
    startingRef.current.add(task.id)
    const def = agentDef(task.agentId)
    const st = settingsRef.current
    try {
      if (!def) { updateTask(task.id, { status: 'failed', note: 'Agent 定义丢失' }); return }
      updateTask(task.id, { status: 'running', startedAt: Date.now(), note: undefined })
      if (def.dispatch === 'open') {
        const ok = await agentLaunchApp(def.appNames, def.bundleIds)
        if (ok) {
          updateTask(task.id, { status: 'manual', note: `已为你打开 ${def.name}，请在应用内粘贴任务（点任务卡上的「复制任务」）` })
        } else {
          updateTask(task.id, { status: 'failed', endedAt: Date.now(), note: `没能打开 ${def.name}（可能未安装或被系统拦截），请手动打开后粘贴任务` })
        }
        return
      }
      // CLI 型：先建保险箱基线（安全底线，失败就不跑）
      if (st.vault.enabled && task.workdir) {
        try {
          await agentVaultBaseline(task.id, def.id, def.name, task.text.slice(0, 60), task.workdir)
          baselinedRef.current.add(task.id)
        } catch (e) {
          updateTask(task.id, { status: 'failed', endedAt: Date.now(), note: `文件保险箱建基线失败，已取消派活：${e instanceof Error ? e.message : String(e)}` })
          return
        }
      }
      // 供 Key：绑定账户时解密注入（Key 只进子进程环境变量）
      const envRes = await buildRunEnv(def, st)
      if ('error' in envRes) {
        updateTask(task.id, { status: 'failed', endedAt: Date.now(), note: envRes.error })
        return
      }
      const envPairs = envRes.envPairs
      const inv = buildCliInvocation(def.id, task.text)
      if (!inv) { updateTask(task.id, { status: 'failed', endedAt: Date.now(), note: '该 Agent 没有 CLI 派活方式' }); return }
      try {
        await agentRunStart(task.id, inv.command, inv.args, task.workdir, envPairs)
        cursorsRef.current.set(task.id, 0)
        outputsRef.current.set(task.id, [])
      } catch (e) {
        updateTask(task.id, { status: 'failed', endedAt: Date.now(), note: `启动失败：${e instanceof Error ? e.message : String(e)}` })
      }
    } finally {
      startingRef.current.delete(task.id)
    }
  }, [updateTask, buildRunEnv])

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
      const running = tasksRef.current.filter(t => t.status === 'running' && agentDef(t.agentId)?.dispatch === 'cli')
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
          if (fresh && fresh.status === 'running') void finalizeCliTask(fresh, poll.exitCode)
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
            id: `led-${taskId}-review`, taskId, agentId: rr.reviewerId, agentName: rr.reviewerName, kind: 'shell',
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
    }, 900)
    return () => window.clearInterval(timer)
  }, [desktop, finalizeCliTask, refreshVault, addLedger, updateTask])

  const availOf = useCallback((id: string) => {
    const def = agentDef(id)
    if (!def) return null
    return agentAvailability(def, detectMap[id], settings, accounts)
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

  const noVaultCoverage = !settings.vault.enabled || !workdir.trim()

  const submit = () => {
    const parsed = parseDelegation(input)
    if (parsed.unknownToken) { notify(`没有叫 #${parsed.unknownToken} 的 Agent，请从 # 列表里选`, 'err'); return }
    const taskText = (parsed.agentId ? parsed.taskText : input).trim()
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
    }
    // 主控拆活（二期）：没写 #、没指定委派对象、落到 CLI 型主控时，先递给主控拆成子任务清单；
    // 桌面型主控只能人工拆活，整单打开它（设置里已明示），行为与一期一致。
    const viaMaster = !parsed.agentId && targetAgent === 'auto'
      && !!settings.master.masterAgentId && agentId === settings.master.masterAgentId
    if (viaMaster && def.dispatch === 'cli') {
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
      setInput('')
      notify('已停住：这次派活要花付费账户的钱，请在任务卡上放行')
      return
    }
    // 上限检查（按已记账本金额）
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0)
    const cap = capCheck(settings, ledgerSpentSince(ledger, startOfDay.getTime()), ledgerSpentSince(ledger, sessionStartRef.current))
    if (cap === 'over-stop') { notify('已达到额度护栏上限（单会话/每日），本次派活已停住；到设置 · 额度护栏调整上限后再派', 'err'); return }
    if (cap === 'over-notify') notify('提醒：Agent 花费已超过你设的上限，本次仍继续派活')
    setTasks(prev => [base, ...prev])
    setInput('')
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
          <button className={view === 'settings' ? 'on' : ''} onClick={() => setView('settings')}><Settings2 size={14} /> 设置</button>
        </div>
        <span className="aw-topnote">运行中 {runningCount} / 并行上限 {settings.parallel.maxParallel}</span>
      </div>

      {view === 'settings' && (
        <AgentSettingsPanel
          settings={settings} onChange={setSettings} accounts={accounts} detectMap={detectMap}
          onRedetect={() => void runDetect()} vaultEntries={vaultEntries}
          onPruneNow={() => { void runPrune('手动清理') }}
          notify={notify}
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
              <select className="aw-target" value={targetAgent} onChange={e => setTargetAgent(e.target.value)} title="委派给（# 指定优先）">
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
            <div className="aw-input-wrap">
              <textarea
                className="aw-input" rows={3} value={input}
                placeholder="写下要派的活，打 # 可指定 Agent（如：#Pi 把 src 里的日志改成英文）"
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit() }}
              />
              {pickerList.length > 0 && (
                <div className="aw-picker">
                  {pickerList.map(a => (
                    <button key={a.id} onClick={() => setInput(prev => prev.replace(/(^|\s)#([^\s#]*)$/, `$1#${a.name} `))}>
                      <b>{a.name}</b><span>{a.kind === 'account' ? '账号登录型 · 免 Key' : '空壳型 · 供 Key'}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
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
              <button className="btn primary" onClick={submit}><Play size={14} /> 派活</button>
            </div>
            {readyAgents.length === 0 && (
              <div className="aw-note warn">当前没有可委派的 Agent：到「设置 · Agent 管理」启用已安装的 Agent（空壳型还需绑定 Key / 免费路线 / 自身登录）。</div>
            )}
          </div>

          <div className="aw-card aw-settle">
            <div className="aw-card-head"><span>结算卡（本机账本）</span><span className="aw-note">共 {summary.totalTasks} 个任务</span></div>
            <div className="aw-settle-grid">
              <div><b>{summary.totalTasks}</b><span>总任务</span></div>
              <div><b>{summary.totalTokens ? summary.totalTokens.toLocaleString() : '—'}</b><span>已上报 tokens</span></div>
              <div><b>{summary.totalCostUsd ? `$${summary.totalCostUsd.toFixed(4)}` : '—'}</b><span>CLI 上报金额（美元原值）</span></div>
              <div><b>{summary.totalCostYuan ? `¥${summary.totalCostYuan.toFixed(2)}` : '—'}</b><span>魔方记账金额</span></div>
            </div>
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
            {tasks.map(task => {
              const meta = STATUS_META[task.status]
              const elapsed = task.startedAt ? (task.endedAt ?? Date.now()) - task.startedAt : 0
              return (
                <div key={task.id} className="aw-card aw-task">
                  <div className="aw-task-head">
                    <b className="aw-task-agent">{task.agentName}</b>
                    <span className={`aw-status ${meta.cls}`}>{meta.label}</span>
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
                  {task.review && (
                    <div className={`aw-review ${task.review.state}`}>
                      <ClipboardCheck size={14} />
                      {task.review.state === 'running' && <span>交叉审查中（审查者：{task.review.reviewerName}）…</span>}
                      {task.review.state === 'pass' && <span>审查通过（{task.review.reviewerName}）{task.review.points ? `：${task.review.points}` : ''}</span>}
                      {task.review.state === 'issues' && <span>审查发现问题（{task.review.reviewerName}）：{task.review.points || '未给出要点'}</span>}
                      {task.review.state === 'failed' && <span>审查未完成：{task.review.reason}</span>}
                    </div>
                  )}
                  {!task.review && settings.master.crossReview && agentDef(task.agentId)?.dispatch === 'open'
                    && (task.status === 'manual' || task.status === 'done') && (
                    <div className="aw-note">桌面型任务不支持自动审查（没有可审的输出）</div>
                  )}
                  {task.output.length > 0 && (
                    <pre className="aw-output">{task.output.slice(-60).join('\n')}</pre>
                  )}
                  <div className="aw-task-btns">
                    {task.status === 'running' && agentDef(task.agentId)?.dispatch === 'cli' && (
                      <button className="btn sm" onClick={() => void stopTask(task)}><Square size={13} /> 停止</button>
                    )}
                    {(task.status === 'failed' || task.status === 'stopped' || task.status === 'unresolved') && !task.relayToId && (
                      <button className="btn sm" onClick={() => considerRelay(task, '手动换人')}><Repeat size={13} /> 换人续跑</button>
                    )}
                    {task.status === 'manual' && (
                      <>
                        <button className="btn sm" onClick={() => { void navigator.clipboard?.writeText(task.text).then(() => notify('任务文本已复制，去应用里粘贴')) }}><Copy size={13} /> 复制任务</button>
                        <button className="btn sm primary" onClick={() => completeManualTask(task)}><CheckCircle2 size={13} /> 标记完成</button>
                        {!task.relayToId && (
                          <button className="btn sm" onClick={() => considerRelay(task, '额度耗尽（手动标记）')}><Repeat size={13} /> 额度耗尽，换人</button>
                        )}
                        <button className="btn sm ghost" onClick={() => updateTask(task.id, { status: 'stopped', endedAt: Date.now(), note: '已放弃（手动关闭）' })}><XCircle size={13} /> 放弃</button>
                      </>
                    )}
                    {task.status === 'queued' && <span className="aw-note"><Hourglass size={12} /> 等待空位（并行上限 {settings.parallel.maxParallel}，重活全局 1 个）</span>}
                    {task.status === 'running' && agentDef(task.agentId)?.dispatch === 'open' && <span className="aw-note"><ExternalLink size={12} /> 正在打开应用…</span>}
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
