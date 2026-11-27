import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot, Play, Square, Copy, Trash2, ShieldAlert, FolderLock, Settings2, LayoutList,
  CheckCircle2, XCircle, Clock3, Hourglass, Hand, ExternalLink,
} from 'lucide-react'
import type { Account } from '../core/types'
import {
  AGENT_REGISTRY, agentDef, agentAvailability, buildCliInvocation, buildShellEnv,
  parseDelegation, pickStartable, isHeavyTask, quotaGate, capCheck, parseCliUsage,
  loadAgentSettings, saveAgentSettings, loadAgentTasks, saveAgentTasks,
  loadAgentLedger, saveAgentLedger, summarizeLedger, ledgerSpentSince,
  type AgentSettings, type AgentTask, type AgentLedgerEntry, type AgentDetectResult,
} from '../core/agents'
import {
  agentDetect, agentLaunchApp, agentRunStart, agentRunPoll, agentRunStop,
  agentVaultBaseline, agentVaultPoll, agentVaultList, agentVaultRestore, agentVaultDeleteEntries, agentVaultPrune,
} from '../core/agentBridge'
import { formatBytes, formatDuration, type VaultEntry } from '../core/agentVault'
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
  running: { label: '运行中', cls: 'run' },
  manual: { label: '已打开 · 待粘贴', cls: 'man' },
  done: { label: '完成', cls: 'done' },
  failed: { label: '失败', cls: 'fail' },
  stopped: { label: '已停止', cls: 'stop' },
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
    const list = await agentVaultList()
    setVaultEntries(list)
  }, [])

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
    const s = loadAgentSettings()
    void agentVaultPrune(s.vault.retentionDays, s.vault.capGB * 1024 * 1024 * 1024).then(() => refreshVault())
  }, [desktop, runDetect, refreshVault])

  // 运行中任务的耗时刷新
  useEffect(() => {
    const t = window.setInterval(() => {
      if (tasksRef.current.some(x => x.status === 'running')) setNowTick(n => n + 1)
    }, 1000)
    return () => window.clearInterval(t)
  }, [])

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
  }, [addLedger, refreshVault, updateTask])

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
      const binding = st.bindings[def.id]
      let envPairs: Array<[string, string]> = []
      if (binding?.kind === 'account') {
        const acct = accountsRef.current.find(a => a.id === binding.accountId)
        if (!acct?.encryptedKey) {
          updateTask(task.id, { status: 'failed', endedAt: Date.now(), note: '绑定的账户不存在或没有 Key，已取消派活' })
          return
        }
        const pwd = sessionPwdRef.current
        if (!pwd) {
          updateTask(task.id, { status: 'failed', endedAt: Date.now(), note: '保险箱未解锁，取不出绑定账户的 Key：请先到「API Key 管理」页解锁，再重新派发' })
          return
        }
        let plain = ''
        try { plain = await decryptSecret(acct.encryptedKey, pwd) } catch {
          updateTask(task.id, { status: 'failed', endedAt: Date.now(), note: '解密绑定账户的 Key 失败，已取消派活' })
          return
        }
        const modelId = enginesFor(acct.providerId)[0]?.id
        envPairs = Object.entries(buildShellEnv(binding, acct, plain, modelId))
      } else {
        envPairs = Object.entries(buildShellEnv(binding, undefined, undefined))
      }
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
  }, [updateTask])

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
    }, 900)
    return () => window.clearInterval(timer)
  }, [desktop, finalizeCliTask, refreshVault])

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
    const base: AgentTask = {
      id: uid(), text: taskText, agentId, agentName: def.name, kind: def.kind,
      workdir: workdir.trim(), heavy, outsideOk: noVaultCoverage ? outsideOk : false,
      status: 'queued', output: [], createdAt: Date.now(),
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
          onPruneNow={() => { void agentVaultPrune(settings.vault.retentionDays, settings.vault.capGB * 1024 * 1024 * 1024).then(() => refreshVault()) }}
          notify={notify}
        />
      )}

      {view === 'vault' && (
        <div className="aw-card">
          <div className="aw-card-head">
            <span>备份条目（仅本机 ~/.ai-credit-manager/agent-vault/，保留 {settings.vault.retentionDays} 天 / 上限 {settings.vault.capGB}GB，超限自动清最旧）</span>
            <button className="btn sm" onClick={() => void refreshVault()}>刷新</button>
          </div>
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
                      {(task.status === 'done' || task.status === 'failed' || task.status === 'stopped') && (
                        <button className="btn sm ghost" onClick={() => setTasks(prev => prev.filter(t => t.id !== task.id))} aria-label="删除记录"><Trash2 size={13} /></button>
                      )}
                    </span>
                  </div>
                  <div className="aw-task-text">{task.text}</div>
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
                  {task.note && <div className="aw-note warn">{task.note}</div>}
                  {task.output.length > 0 && (
                    <pre className="aw-output">{task.output.slice(-60).join('\n')}</pre>
                  )}
                  <div className="aw-task-btns">
                    {task.status === 'running' && agentDef(task.agentId)?.dispatch === 'cli' && (
                      <button className="btn sm" onClick={() => void stopTask(task)}><Square size={13} /> 停止</button>
                    )}
                    {task.status === 'manual' && (
                      <>
                        <button className="btn sm" onClick={() => { void navigator.clipboard?.writeText(task.text).then(() => notify('任务文本已复制，去应用里粘贴')) }}><Copy size={13} /> 复制任务</button>
                        <button className="btn sm primary" onClick={() => completeManualTask(task)}><CheckCircle2 size={13} /> 标记完成</button>
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
