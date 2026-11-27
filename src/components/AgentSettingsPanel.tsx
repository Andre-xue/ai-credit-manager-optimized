import { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, Repeat, ShieldCheck, FolderLock, Crown, ArrowUp, ArrowDown, RefreshCw, AlertTriangle, Trash2 } from 'lucide-react'
import type { Account } from '../core/types'
import {
  AGENT_REGISTRY, agentDef, agentAvailability, multiAccountCapable, makeAccountEntry, dispatchTier, tierLabel,
  detectHasCli, detectHasApp, nativeEntryId, fillLoginGuide, buildInstallCommand, loginCommandFor,
  loginStateText,
  type AgentSettings, type AgentDetectResult, type KeyBinding, type AgentDef, type AgentLedgerEntry,
} from '../core/agents'
import {
  agentAccountsProbe, agentAccountCreateDir, agentWhich, agentRunStart, agentRunPoll, agentRunStop,
  entryProbeIn, agentAgySetupEntry,
  type AgentAccountStatus, type AgentAccountProbeIn,
} from '../core/agentBridge'
import { selectPruneVictims, vaultTotals, formatBytes, formatDuration, type VaultEntry } from '../core/agentVault'
import { PROVIDER_MAP } from '../data/providers'
import { JellyToggle } from './agentUi'

type Cat = 'agents' | 'relay' | 'quota' | 'vault' | 'master'

const CATS: Array<{ id: Cat; name: string; desc: string; icon: typeof Bot }> = [
  { id: 'agents', name: 'Agent 管理', desc: '启用开关与供 Key 绑定', icon: Bot },
  { id: 'relay', name: '接力与调度', desc: '接力链与并行调度', icon: Repeat },
  { id: 'quota', name: '额度护栏', desc: '只走免费与花费上限', icon: ShieldCheck },
  { id: 'vault', name: '权限与保险箱', desc: '最大权限与文件可还原', icon: FolderLock },
  { id: 'master', name: '主控与审查', desc: '主控选择与交叉审查', icon: Crown },
]

function bindingValue(b: KeyBinding | undefined): string {
  if (!b) return ''
  if (b.kind === 'free') return 'free'
  if (b.kind === 'self') return 'self'
  return `account:${b.accountId}`
}

function parseBinding(v: string): KeyBinding | undefined {
  if (!v) return undefined
  if (v === 'free') return { kind: 'free' }
  if (v === 'self') return { kind: 'self' }
  if (v.startsWith('account:')) return { kind: 'account', accountId: v.slice('account:'.length) }
  return undefined
}

export function AgentSettingsPanel({ settings, onChange, accounts, detectMap, ledger, onRedetect, vaultEntries, onPruneNow, notify }: {
  settings: AgentSettings
  onChange: (s: AgentSettings) => void
  accounts: Account[]
  detectMap: Record<string, AgentDetectResult>
  ledger: AgentLedgerEntry[]
  onRedetect: () => void
  vaultEntries: VaultEntry[]
  onPruneNow: () => void
  notify: (m: string, kind?: 'ok' | 'err') => void
}) {
  const [cat, setCat] = useState<Cat>('agents')
  const set = (patch: Partial<AgentSettings>) => onChange({ ...settings, ...patch })
  const keyAccounts = useMemo(() => accounts.filter(a => !!a.encryptedKey), [accounts])
  const vaultStats = useMemo(() => vaultTotals(vaultEntries), [vaultEntries])
  const prunePreview = useMemo(
    () => selectPruneVictims(vaultEntries, Date.now(), settings.vault.retentionDays, settings.vault.capGB * 1024 * 1024 * 1024).length,
    [vaultEntries, settings.vault.retentionDays, settings.vault.capGB],
  )

  const [acctStatus, setAcctStatus] = useState<Record<string, AgentAccountStatus>>({})
  const [guide, setGuide] = useState<Record<string, string>>({})

  // 账户条目登录态探测（只查凭据文件在不在，绝不读内容）；单账户 Agent 用合成原生条目
  useEffect(() => {
    const probes: AgentAccountProbeIn[] = []
    for (const e of settings.accounts) {
      const d = agentDef(e.agentId)
      if (d) { const p = entryProbeIn(d, e); if (p) probes.push(p) }
    }
    for (const d of AGENT_REGISTRY) {
      if (!multiAccountCapable(d)) {
        const p = entryProbeIn(d, { id: nativeEntryId(d.id), credDir: 'native' })
        if (p) probes.push(p)
      }
    }
    if (!probes.length) return
    let cancelled = false
    void agentAccountsProbe(probes).then(statuses => {
      if (cancelled) return
      const m: Record<string, AgentAccountStatus> = {}
      for (const st of statuses) m[st.entryId] = st
      setAcctStatus(m)
    })
    return () => { cancelled = true }
  }, [settings.accounts, detectMap])

  // v0.1.511（②）：统一走 loginStateText——unknown 且凭据在钥匙串的显示「钥匙串保管…」，
  // 有派活成功标记的显示「已验证（派活成功）」，不再用误导性的「读不到」。
  const loginText = (login?: string, def?: AgentDef) => loginStateText(
    login === 'yes' || login === 'no' || login === 'unknown' ? login : undefined,
    { probeMissing: def?.credProbeMissing, verifiedAt: def ? settings.verifiedAgents?.[def.id] : undefined },
  )
  const entryStats = (entryId: string) => {
    const es = ledger.filter(l => l.agentEntryId === entryId)
    return { count: es.length, ms: es.reduce((sum, l) => sum + (l.durationMs || 0), 0) }
  }
  const addEntry = async (def: AgentDef) => {
    const entry = makeAccountEntry(def.id, settings.accounts, Date.now())
    let path = ''
    if (def.credIsolation === 'home') {
      // v0.1.512（④）：HOME 型条目（Antigravity）建目录时连钥匙串一起预建，
      // 建不出来就如实报错、不建半成品条目（否则登录时必弹「找不到钥匙串」）
      try {
        path = await agentAgySetupEntry(entry.id)
      } catch (e) {
        notify(`添加账户失败：${e instanceof Error ? e.message : String(e)}`, 'err')
        return
      }
      if (!path) { notify('添加账户失败：条目目录没建起来', 'err'); return }
    } else {
      path = await agentAccountCreateDir(def.id, entry.id)
    }
    onChange({ ...settings, accounts: [...settings.accounts, entry] })
    setGuide(g => ({ ...g, [def.id]: `新账户「${entry.label}」的凭据目录已建好${path ? `（${path}）` : ''}。${fillLoginGuide(def, path)}` }))
    notify(`已添加账户「${entry.label}」：按行内指引在终端登录后，点「重新检测」确认登录态`)
  }

  // ---- 一键安装（官方路线）：确认闸 → 子进程流式输出 → 装完自动重新检测 ----
  const [npmPath, setNpmPath] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void agentWhich('npm').then(p => { if (!cancelled) setNpmPath(p) })
    return () => { cancelled = true }
  }, [])
  const [installs, setInstalls] = useState<Record<string, { phase: 'confirm' | 'running' | 'done' | 'failed'; lines: string[]; error?: string }>>({})
  const [loginOpen, setLoginOpen] = useState<Record<string, boolean>>({})
  const installCursors = useRef(new Map<string, number>())
  useEffect(() => {
    const active = Object.keys(installs).filter(id => installs[id]?.phase === 'running')
    if (!active.length) return
    const timer = window.setInterval(async () => {
      for (const agentId of active) {
        const runId = `install-${agentId}`
        const poll = await agentRunPoll(runId, installCursors.current.get(agentId) ?? 0)
        installCursors.current.set(agentId, poll.next)
        if (poll.lines.length) {
          setInstalls(prev => (prev[agentId] ? { ...prev, [agentId]: { ...prev[agentId], lines: [...prev[agentId].lines, ...poll.lines].slice(-200) } } : prev))
        }
        if (!poll.running && poll.exitCode !== null) {
          if (poll.exitCode === 0) {
            setInstalls(prev => (prev[agentId] ? { ...prev, [agentId]: { ...prev[agentId], phase: 'done' } } : prev))
            onRedetect()
          } else {
            setInstalls(prev => {
              const cur = prev[agentId]
              if (!cur) return prev
              const tail = [...cur.lines, ...poll.lines].slice(-2).join(' ').slice(0, 200)
              return { ...prev, [agentId]: { ...cur, phase: 'failed', error: tail || `安装进程退出码 ${poll.exitCode}` } }
            })
          }
        }
      }
    }, 700)
    return () => window.clearInterval(timer)
  }, [installs, onRedetect])

  const startInstall = async (def: AgentDef) => {
    const plan = buildInstallCommand(def)
    if (!plan) return
    installCursors.current.set(def.id, 0)
    setInstalls(prev => ({ ...prev, [def.id]: { phase: 'running', lines: [`$ ${plan.display}`] } }))
    try {
      await agentRunStart(`install-${def.id}`, plan.command, plan.args, '', [])
    } catch (e) {
      setInstalls(prev => ({ ...prev, [def.id]: { phase: 'failed', lines: prev[def.id]?.lines ?? [], error: `启动安装失败：${e instanceof Error ? e.message : String(e)}` } }))
    }
  }
  const stopInstall = async (def: AgentDef) => {
    await agentRunStop(`install-${def.id}`)
    setInstalls(prev => (prev[def.id] ? { ...prev, [def.id]: { ...prev[def.id], phase: 'failed', error: '已被你停止' } } : prev))
  }

  const chainOrdered = useMemo(() => {
    const chosen = settings.relay.chain.filter(id => AGENT_REGISTRY.some(a => a.id === id))
    const rest = AGENT_REGISTRY.filter(a => !chosen.includes(a.id)).map(a => a.id)
    return { chosen, rest }
  }, [settings.relay.chain])

  const moveChain = (id: string, dir: -1 | 1) => {
    const chain = [...chainOrdered.chosen]
    const i = chain.indexOf(id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= chain.length) return
    ;[chain[i], chain[j]] = [chain[j], chain[i]]
    set({ relay: { ...settings.relay, chain } })
  }

  return (
    <div>
      <div className="aw-cat-row">
        {CATS.map(c => (
          <button key={c.id} className={`aw-cat-card ${cat === c.id ? 'on' : ''}`} onClick={() => setCat(c.id)}>
            <c.icon size={17} />
            <span className="aw-cat-name">{c.name}</span>
            <span className="aw-cat-desc">{c.desc}</span>
          </button>
        ))}
      </div>

      {cat === 'agents' && (
        <>
        <div className="aw-card">
          <div className="aw-card-head">
            <span>本机 Agent（改动只存本机）</span>
            <button className="btn sm" onClick={onRedetect}><RefreshCw size={13} /> 重新检测</button>
          </div>
          {/* v0.1.511（⑦）：全局设置收成一条横向条，置于平台卡片网格上方 */}
          <div className="asp-global-bar">
            <div className="aw-agent-main">
              <b>桌面型送达后自动发送（回车）</b>
              <div className="aw-note">派活分三档：有官方命令的走「无头直派」（第一档，如 dsh headless / codex exec / agy）；只有桌面应用时才走「粘贴送达（兜底）」——自动等窗口就绪并粘贴进输入框。开这个开关后，粘贴完连回车一起按、直接发出；关着时只粘贴，你到应用里确认后再按发送。自动粘贴需要辅助功能权限（与翻译功能共用同一个权限）。</div>
            </div>
            <JellyToggle checked={settings.delivery.autoSend} onChange={v => set({ delivery: { autoSend: v } })} />
          </div>
        </div>
        {/* v0.1.511（⑦）：平台横向卡片网格（宽屏三列、窄屏自动换行）——行为逻辑与旧竖排一致 */}
        <div className="asp-grid">
          {AGENT_REGISTRY.map(def => {
            const det = detectMap[def.id]
            const avail = agentAvailability(def, det, settings, accounts, settings.accounts)
            const installed = !!det?.installed
            return (
              <div key={def.id} className="aw-agent-row asp-card">
                <div className="aw-agent-main">
                  <div className="aw-agent-title">
                    <span className="asp-avatar">{(def.name.match(/^[A-Za-z]+/)?.[0] ?? def.name).slice(0, 2)}</span>
                    <b>{def.name}</b>
                    <span className={`aw-tag ${def.kind === 'account' ? 'acct' : 'shell'}`}>{def.kind === 'account' ? '账号登录型' : '空壳型'}</span>
                    {def.headlessCli
                      ? <span className={`aw-tag ${detectHasCli(det) ? 'ok' : 'off'}`}>{detectHasCli(det) ? '已安装（命令）' : detectHasApp(det) ? '未安装（命令）' : '未安装'}</span>
                      : <span className={`aw-tag ${installed ? 'ok' : 'off'}`}>{installed ? `已安装${det?.cliPath ? '（命令）' : det?.appPath ? '（应用）' : det?.via === 'app' ? '（应用）' : '（命令）'}` : '未安装'}</span>}
                    {installed && dispatchTier(def, det) && <span className="aw-tag tier">{tierLabel(dispatchTier(def, det)!)}</span>}
                    {installed && det?.cliVersion && <span className="aw-note">{det.cliVersion}</span>}
                  </div>
                  {def.headlessCli && !detectHasCli(det) && detectHasApp(det) && (
                    <div className="aw-note">桌面应用已安装，但无头型派活只走命令、不走粘贴送达；命令没装之前派活会被拦下。</div>
                  )}
                  {(() => {
                    const plan = buildInstallCommand(def)
                    const inst = installs[def.id]
                    const hasCli = detectHasCli(det)
                    if (!plan || hasCli) return null
                    return (
                      <div className="asp-install">
                        {!inst && (plan.needsNpm && npmPath === ''
                          ? <div className="aw-note warn">未检测到 npm：先装 Node.js（nodejs.org 官网或 brew install node），再回来一键安装</div>
                          : <button className="btn sm primary" onClick={() => setInstalls(prev => ({ ...prev, [def.id]: { phase: 'confirm', lines: [] } }))}>一键安装</button>)}
                        {inst?.phase === 'confirm' && (
                          <div className="asp-install-confirm">
                            <div className="aw-note">将要执行（官方路线，确认后才会运行）：</div>
                            <code className="asp-install-cmd">{plan.display}</code>
                            <div className="asp-install-btns">
                              <button className="btn sm primary" onClick={() => void startInstall(def)}>确认安装</button>
                              <button className="btn sm ghost" onClick={() => setInstalls(prev => { const n = { ...prev }; delete n[def.id]; return n })}>取消</button>
                            </div>
                          </div>
                        )}
                        {(inst?.phase === 'running' || inst?.phase === 'done' || inst?.phase === 'failed') && (
                          <div className="asp-install-run">
                            <div className="asp-install-head">
                              <span>{inst.phase === 'running' ? '安装中…' : inst.phase === 'done' ? '安装完成，已重新检测' : `安装失败：${inst.error ?? ''}`}</span>
                              {inst.phase === 'running' && <button className="btn sm" onClick={() => void stopInstall(def)}>停止</button>}
                              {inst.phase === 'failed' && <button className="btn sm" onClick={() => setInstalls(prev => ({ ...prev, [def.id]: { phase: 'confirm', lines: [] } }))}>重试</button>}
                            </div>
                            <pre className="asp-install-out">{inst.lines.slice(-30).join('\n')}</pre>
                          </div>
                        )}
                      </div>
                    )
                  })()}
                  {def.qualification && <div className="aw-note warn">{def.qualification}</div>}
                  {!installed && <div className="aw-note">{def.installHint}</div>}
                  {installed && def.headlessCli && !detectHasCli(det) && def.cliInstallHint && (
                    <div className="aw-note warn">未检测到 {def.cliNames[0]} 命令，派活会被拦下；装上命令即可无头直派：{def.cliInstallHint}</div>
                  )}
                  {installed && def.kind === 'account' && !def.headlessCli && <div className="aw-note">使用自身登录账号（免 Key），魔方只派活与盯进度，不记细账</div>}
                  {installed && def.headlessCli && avail.state === 'ready' && <div className="aw-note">{avail.reason}，魔方只派活与盯进度，不记细账</div>}
                  {installed && avail.state === 'blocked' && <div className="aw-note warn">{avail.reason}</div>}
                  {installed && def.kind === 'shell' && (
                    <label className="aw-bind">
                      <span>供 Key 绑定</span>
                      <select
                        value={bindingValue(settings.bindings[def.id])}
                        onChange={e => {
                          const b = parseBinding(e.target.value)
                          const bindings = { ...settings.bindings }
                          if (b) bindings[def.id] = b; else delete bindings[def.id]
                          set({ bindings })
                        }}>
                        <option value="">未绑定（不可委派）</option>
                        <option value="free">免费路线（自动）</option>
                        {def.selfLogin && <option value="self">使用自身登录（如订阅账号）</option>}
                        {keyAccounts.map(a => (
                          <option key={a.id} value={`account:${a.id}`}>
                            {a.label || PROVIDER_MAP[a.providerId]?.name || a.providerId}（{PROVIDER_MAP[a.providerId]?.shortName ?? a.providerId}）
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
                <JellyToggle
                  checked={!!settings.enabled[def.id]}
                  disabled={!installed}
                  onChange={v => set({ enabled: { ...settings.enabled, [def.id]: v } })}
                />
                {installed && def.headlessCli && (
                  multiAccountCapable(def) ? (
                    <div className="asp-entries">
                      {settings.accounts.filter(e => e.agentId === def.id).map(e => {
                        const st = acctStatus[e.id]
                        const stats = entryStats(e.id)
                        // v0.1.511（②）语义在条目行同样成立：钥匙串保管、探测只能 unknown 的
                        // Agent，未验证时把口径说清；派活成功落「已验证」后不再挂「去登录」
                        const verifiedAt = settings.verifiedAgents?.[def.id]
                        const keychainUnknown = st?.login === 'unknown' && def.credProbeMissing === 'unknown'
                        return (
                          <div key={e.id} className="asp-entry-row">
                            <div className="asp-entry-main">
                              <div className="asp-entry-title">
                                <b>{e.label}</b>
                                <span className="aw-tag off">{e.credDir === 'native' ? '原生目录' : '隔离目录'}</span>
                                <span className={`asp-login ${st?.login ?? 'unknown'}`}>{loginText(st?.login, def)}</span>
                                <span className="aw-note">{stats.count} 件任务 · 累计 {formatDuration(stats.ms)}</span>
                              </div>
                              {st?.dirPath && <div className="aw-note asp-dir">{st.dirPath}</div>}
                              {keychainUnknown && !verifiedAt && <div className="aw-note">登录态由系统钥匙串保管，魔方读不到，以派活结果为准；派活成功一次后这里会显示「已验证」。</div>}
                              {st?.login !== 'yes' && !(keychainUnknown && verifiedAt) && (def.loginCommandNative || def.loginCommandIsolated) && (
                                <div className="asp-login-wrap">
                                  <button className={`btn sm ${st?.login === 'unknown' && def.credProbeMissing === 'unknown' ? 'ghost' : ''}`} onClick={() => setLoginOpen(o => ({ ...o, [e.id]: !o[e.id] }))}>去登录</button>
                                  {loginOpen[e.id] && (
                                    <div className="asp-login-box">
                                      <div className="aw-note">{def.id === 'dsh'
                                        ? '登录由你本人在官方流程里完成，魔方不经手账号密码。在终端运行下面这条命令，会打开浏览器登录页，登录完回到这里点「重新检测」：'
                                        : '登录由你本人在官方流程里完成，魔方不经手账号密码。在终端运行下面这条命令，登录完点上方「重新检测」：'}</div>
                                      <code className="asp-install-cmd">{loginCommandFor(def, e, st?.dirPath ?? '')}</code>
                                      <button className="btn sm ghost" onClick={() => { void navigator.clipboard?.writeText(loginCommandFor(def, e, st?.dirPath ?? '')); notify('登录命令已复制，去终端粘贴运行') }}>复制命令</button>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                            <JellyToggle
                              checked={e.enabled}
                              onChange={v => onChange({ ...settings, accounts: settings.accounts.map(x => (x.id === e.id ? { ...x, enabled: v } : x)) })}
                            />
                            {e.credDir === 'isolated' && (
                              <button className="btn sm ghost" aria-label="删除账户条目" onClick={() => onChange({ ...settings, accounts: settings.accounts.filter(x => x.id !== e.id) })}>
                                <Trash2 size={13} />
                              </button>
                            )}
                          </div>
                        )
                      })}
                      <div className="asp-entry-actions">
                        <button className="btn sm" onClick={() => void addEntry(def)}>＋ 添加账户</button>
                        <span className="aw-note">派活默认用最久未用的已启用账户；每个账户一份独立凭据目录，只存你本机登录产生的文件，魔方不收集账号密码。</span>
                      </div>
                      {guide[def.id] && <div className="aw-note">{guide[def.id]}</div>}
                    </div>
                  ) : (() => {
                    const singleLogin = acctStatus[nativeEntryId(def.id)]?.login
                    const verifiedAt = settings.verifiedAgents?.[def.id]
                    const keychainUnknown = singleLogin === 'unknown' && def.credProbeMissing === 'unknown'
                    return (
                      <div className="asp-entries">
                        <div className="aw-note">
                          <span className="aw-tag off">仅单账户</span> {def.multiAccountNote} · 当前登录态：{loginText(singleLogin, def)}
                          {keychainUnknown && !verifiedAt && '——登录态由系统钥匙串保管，魔方读不到，以派活结果为准；派活成功一次后这里会显示「已验证」。'}
                        </div>
                        {def.loginCommandNative && !(keychainUnknown && verifiedAt) && (
                          <div className="asp-login-wrap">
                            <button className={`btn sm ${keychainUnknown ? 'ghost' : ''}`} onClick={() => setLoginOpen(o => ({ ...o, [def.id]: !o[def.id] }))}>{keychainUnknown ? '重新登录' : '去登录'}</button>
                            {loginOpen[def.id] && (
                              <div className="asp-login-box">
                                <div className="aw-note">登录由你本人在官方流程里完成，魔方不经手账号密码。在终端运行下面这条命令，在打开的界面里用 Google 账号登录，完后点上方「重新检测」：</div>
                                <code className="asp-install-cmd">{def.loginCommandNative}</code>
                                <button className="btn sm ghost" onClick={() => { void navigator.clipboard?.writeText(def.loginCommandNative ?? ''); notify('登录命令已复制，去终端粘贴运行') }}>复制命令</button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })()
                )}
              </div>
            )
          })}
        </div>
        <div className="asp-summary">
          共 {AGENT_REGISTRY.length} 个平台 · 已启用 {AGENT_REGISTRY.filter(d => settings.enabled[d.id]).length} 个 · 派活方式：无头直派优先；无头型启动失败如实报错、不自动降级粘贴
        </div>
        </>
      )}

      {cat === 'relay' && (
        <div className="aw-card">
          <div className="aw-field">
            <span>接力模式</span>
            <label className="aw-radio"><input type="radio" checked={settings.relay.mode === 'ask'} onChange={() => set({ relay: { ...settings.relay, mode: 'ask' } })} /> 先停住询问（额度耗尽时问过我再换人）</label>
            <label className="aw-radio"><input type="radio" checked={settings.relay.mode === 'auto'} onChange={() => set({ relay: { ...settings.relay, mode: 'auto' } })} /> 自动接力（按接力链顺序换人续跑）</label>
            <div className="aw-note">触发接力的情形：CLI 任务因额度耗尽 / 限流失败（自动识别）；任务卡上手动「换人续跑」；桌面型任务手动标「额度耗尽，换人」。接棒者同样过额度护栏（付费路线先停住等你放行）。</div>
          </div>
          <div className="aw-field">
            <span>接力链（上 = 先接棒）</span>
            {chainOrdered.chosen.length === 0 && <div className="aw-note">还没选接棒者，从下面点 ＋ 加入。</div>}
            {chainOrdered.chosen.map((id, i) => {
              const def = AGENT_REGISTRY.find(a => a.id === id)!
              return (
                <div key={id} className="aw-chain-row">
                  <span className="aw-chain-idx">{i + 1}</span>
                  <span className="aw-chain-name">{def.name}</span>
                  <span className={`aw-tag ${def.kind === 'account' ? 'acct' : 'shell'}`}>{def.kind === 'account' ? '账号型' : '空壳型'}</span>
                  <button className="btn sm ghost" onClick={() => moveChain(id, -1)} aria-label="上移"><ArrowUp size={13} /></button>
                  <button className="btn sm ghost" onClick={() => moveChain(id, 1)} aria-label="下移"><ArrowDown size={13} /></button>
                  <button className="btn sm ghost" onClick={() => set({ relay: { ...settings.relay, chain: chainOrdered.chosen.filter(x => x !== id) } })}>移除</button>
                </div>
              )
            })}
            <div className="aw-chain-add">
              {chainOrdered.rest.map(id => {
                const def = AGENT_REGISTRY.find(a => a.id === id)!
                return (
                  <button key={id} className="btn sm" onClick={() => set({ relay: { ...settings.relay, chain: [...chainOrdered.chosen, id] } })}>＋ {def.name}</button>
                )
              })}
            </div>
          </div>
          <div className="aw-field">
            <span>并行上限（本期生效）</span>
            <label className="aw-bind">
              <span>同时运行的任务数（1–5，默认 3；本地重活全局只许 1 个）</span>
              <select value={settings.parallel.maxParallel} onChange={e => set({ parallel: { maxParallel: Number(e.target.value) } })}>
                {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          </div>
        </div>
      )}

      {cat === 'quota' && (
        <div className="aw-card">
          <div className="aw-agent-row">
            <div className="aw-agent-main">
              <b>只走免费路线</b>
              <div className="aw-note">开着时：空壳型绑定的付费账户在每次派活前都会停住等你放行，绝不静默扣费。账号型用自身额度，不受此限。</div>
            </div>
            <JellyToggle checked={settings.quota.freeOnly} onChange={v => set({ quota: { ...settings.quota, freeOnly: v } })} />
          </div>
          <div className="aw-field">
            <span>花费上限（按魔方账本里 Agent 归因的已记金额）</span>
            <label className="aw-bind"><span>单会话上限（元，空 = 不限）</span>
              <input type="number" min="0" step="0.1" placeholder="不限"
                value={settings.quota.perSessionCap ?? ''}
                onChange={e => set({ quota: { ...settings.quota, perSessionCap: e.target.value === '' ? null : Number(e.target.value) } })} />
            </label>
            <label className="aw-bind"><span>每日上限（元，空 = 不限）</span>
              <input type="number" min="0" step="0.1" placeholder="不限"
                value={settings.quota.dailyCap ?? ''}
                onChange={e => set({ quota: { ...settings.quota, dailyCap: e.target.value === '' ? null : Number(e.target.value) } })} />
            </label>
          </div>
          <div className="aw-field">
            <span>超限动作</span>
            <label className="aw-radio"><input type="radio" checked={settings.quota.overLimit === 'stop'} onChange={() => set({ quota: { ...settings.quota, overLimit: 'stop' } })} /> 停住等确认</label>
            <label className="aw-radio"><input type="radio" checked={settings.quota.overLimit === 'notify'} onChange={() => set({ quota: { ...settings.quota, overLimit: 'notify' } })} /> 只提醒，继续派活</label>
          </div>
        </div>
      )}

      {cat === 'vault' && (
        <div className="aw-card">
          <div className="aw-agent-row">
            <div className="aw-agent-main">
              <b>文件保险箱</b>
              <div className="aw-note">任务开跑前对工作目录存基线，运行中被改/被删文件的上一版自动备份，可一键还原。仅存本机 ~/.ai-credit-manager/agent-vault/，不云同步。跳过 .git、node_modules 等大目录与单文件 &gt; 64MB 的文件。</div>
            </div>
            <JellyToggle checked={settings.vault.enabled} onChange={v => set({ vault: { ...settings.vault, enabled: v } })} />
          </div>
          {!settings.vault.enabled && (
            <div className="aw-risk"><AlertTriangle size={15} /> 保险箱已关闭：Agent 权限默认最大、自动执行，关掉后文件改动<b>不可还原</b>，派活前每次都会要求你勾选风险确认。</div>
          )}
          <div className="aw-field">
            <label className="aw-bind"><span>默认工作目录</span>
              <input type="text" placeholder="如 /Users/你/项目目录（派活时可改）"
                value={settings.vault.workdir}
                onChange={e => set({ vault: { ...settings.vault, workdir: e.target.value } })} />
            </label>
            <label className="aw-bind"><span>保留天数</span>
              <input type="number" min="1" max="365" value={settings.vault.retentionDays}
                onChange={e => set({ vault: { ...settings.vault, retentionDays: Math.max(1, Number(e.target.value) || 30) } })} />
            </label>
            <label className="aw-bind"><span>容量上限（GB）</span>
              <input type="number" min="0.1" step="0.5" value={settings.vault.capGB}
                onChange={e => set({ vault: { ...settings.vault, capGB: Math.max(0.1, Number(e.target.value) || 5) } })} />
            </label>
          </div>
          <div className="aw-field">
            <span>当前占用：{vaultStats.count} 条 · {formatBytes(vaultStats.bytes)}（按当前规则将清理 {prunePreview} 条）</span>
            <button className="btn sm" onClick={() => { onPruneNow(); notify('保险箱清理已执行') }}>立即按规则清理</button>
            <div className="aw-note">每任务占用（含基线镜像）与基线清理入口在「文件保险箱」视图里。基线镜像在 macOS 上优先用 APFS 克隆复制（写时复制、近零成本），失败自动回落普通复制。</div>
          </div>
          <div className="aw-note">关于系统快照：Time Machine 本地快照（tmutil）需要管理员权限，App 内无法调用，故不接入；现行方案就是上面的目录级保险箱（基线 + 上一版），不依赖系统快照。</div>
          <div className="aw-note">权限口径：Agent 在工作目录内默认最大权限、自动执行不逐项确认，安全靠保险箱可还原；目录外写入与外发数据、改系统设置等非文件操作不在最大权限内，派活时单独明示确认。</div>
        </div>
      )}

      {cat === 'master' && (
        <div className="aw-card">
          <div className="aw-field">
            <label className="aw-bind"><span>主控 Agent（未写 #、未指定委派对象时，先交给它拆活）</span>
              <select value={settings.master.masterAgentId} onChange={e => set({ master: { ...settings.master, masterAgentId: e.target.value } })}>
                <option value="">未设置（用第一个可用的，不拆活）</option>
                {AGENT_REGISTRY.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
            {(() => {
              const m = AGENT_REGISTRY.find(a => a.id === settings.master.masterAgentId)
              if (!m) return <div className="aw-note">未设主控时，不带 # 的任务直接派给第一个可用的 Agent，不做拆活。</div>
              if (m.dispatch === 'open') return <div className="aw-note warn">{m.name} 是桌面应用型主控：没法自动拆活，任务会整单打开它、由你在应用内人工拆活粘贴。</div>
              return <div className="aw-note">{m.name} 是 CLI 型主控：不带 # 的任务会先递给它拆成子任务清单，再逐个派发（拆活本身记 {m.name} 的账）。</div>
            })()}
          </div>
          <div className="aw-agent-row">
            <div className="aw-agent-main">
              <b>交叉审查</b>
              <div className="aw-note">CLI 型任务完成后，自动把目标 + 输出摘要 + 改动文件清单递给审查者复核，结论回填任务卡；审查费用记审查者名下。桌面型任务没有可审的输出，不自动审查。</div>
            </div>
            <JellyToggle checked={settings.master.crossReview} onChange={v => set({ master: { ...settings.master, crossReview: v } })} />
          </div>
          {settings.master.crossReview && (
            <div className="aw-field">
              <label className="aw-bind"><span>审查者（另一个可真派活的 CLI 型 Agent）</span>
                <select value={settings.master.reviewerAgentId} onChange={e => set({ master: { ...settings.master, reviewerAgentId: e.target.value } })}>
                  <option value="">未选择（审查不会启动，任务卡会如实标注）</option>
                  {AGENT_REGISTRY.filter(a => a.dispatch === 'cli').map(a => (
                    <option key={a.id} value={a.id} disabled={a.id === settings.master.masterAgentId}>{a.name}{a.id === settings.master.masterAgentId ? '（与主控相同，请选另一个）' : ''}</option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
