import { useCallback, useEffect, useState } from 'react'
import { History, RefreshCw, Play, ShieldAlert } from 'lucide-react'
import {
  agentDef, detectHasCli, type AgentSettings, type AgentDetectResult,
} from '../core/agents'
import {
  agentListSessions, type AgentAccountStatus, type AgentSessionItem,
} from '../core/agentBridge'
import { buildSessionHomes, sessionDisplayTitle, sessionTitleSourceNote } from '../core/agentSessions'

export interface SessionImportPayload {
  agentId: string
  entryId: string
  sessionId: string
  title: string
  cwd: string
  prompt: string
  outsideOk: boolean
}

const IMPORTABLE = ['dsh', 'codex-desktop']

interface AgentSessionsState {
  loading: boolean
  sessions: AgentSessionItem[]
  skipped: number
  error: string
}

/** 导入会话（v0.1.512 ①）：读 DSH / Codex 本地会话存档列清单，选一条续跑。
 *  只读元信息；解析失败的存档计数跳过并注明，CLI 没装时给一键安装入口，不空白页。 */
export function AgentSessionsPanel({ settings, detectMap, accountStatus, onImported, onGoSettings }: {
  settings: AgentSettings
  detectMap: Record<string, AgentDetectResult>
  accountStatus: Record<string, AgentAccountStatus>
  onImported: (p: SessionImportPayload) => void
  onGoSettings: () => void
}) {
  const [states, setStates] = useState<Record<string, AgentSessionsState>>({})
  const [openKey, setOpenKey] = useState('')
  const [prompt, setPrompt] = useState('')
  const [ack, setAck] = useState(false)

  const load = useCallback(async () => {
    for (const agentId of IMPORTABLE) {
      const def = agentDef(agentId)
      if (!def) continue
      setStates(prev => ({ ...prev, [agentId]: { loading: true, sessions: prev[agentId]?.sessions ?? [], skipped: 0, error: '' } }))
      try {
        const homes = buildSessionHomes(def, settings.accounts, accountStatus)
        const r = await agentListSessions(agentId, homes)
        setStates(prev => ({ ...prev, [agentId]: { loading: false, sessions: r.sessions, skipped: r.skipped, error: '' } }))
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setStates(prev => ({
          ...prev,
          [agentId]: { loading: false, sessions: [], skipped: 0, error: `读取 ${def.name} 的会话存档失败：${msg || '未知原因'}。可以点「重新读取」再试，或确认该 Agent 的凭据目录还在。` },
        }))
      }
    }
  }, [settings.accounts, accountStatus])

  useEffect(() => { void load() }, [load])

  const keyOf = (agentId: string, s: AgentSessionItem) => `${agentId}:${s.entryId}:${s.sessionId}`

  return (
    <div className="aw-card">
      <div className="aw-card-head">
        <span><History size={15} /> 导入会话（读本机存档，选中一条接着原会话续跑）</span>
        <button className="btn sm" onClick={() => void load()}><RefreshCw size={13} /> 重新读取</button>
      </div>
      <div className="aw-note" style={{ marginBottom: 12 }}>
        这里列的是 DSH 与 Codex 在你电脑上留下的会话存档（原生登录与每个隔离账户各一份）。选中一条、写下接着要它做的事，就会生成一件工作台任务，用原会话的上下文继续跑。只有标题、时间、工作目录这些元信息会被读出来展示，不会把整段对话搬进工作台。
      </div>
      {IMPORTABLE.map(agentId => {
        const def = agentDef(agentId)!
        const st = states[agentId]
        const hasCli = detectHasCli(detectMap[agentId])
        return (
          <div key={agentId} className="aw-session-group">
            <div className="aw-session-group-head">
              <b>{def.name}</b>
              {hasCli
                ? <span className="aw-tag ok">命令已装</span>
                : <span className="aw-tag off">命令未安装</span>}
              {st?.loading && <span className="aw-note">读取中…</span>}
            </div>
            {!hasCli && (
              <div className="aw-note warn" style={{ marginBottom: 8 }}>
                {def.name} 的命令还没装：存档可以先看，但要续跑得先装命令。
                <button className="btn sm" style={{ marginLeft: 8 }} onClick={onGoSettings}>去一键安装</button>
              </div>
            )}
            {st?.error && <div className="aw-note warn" style={{ marginBottom: 8 }}>{st.error}</div>}
            {!st?.loading && !st?.error && st && st.sessions.length === 0 && (
              <div className="aw-note" style={{ marginBottom: 8 }}>
                没找到 {def.name} 的会话存档：可能还没用它跑过会话，或存档目录不在已知的凭据目录下。
              </div>
            )}
            {st && st.skipped > 0 && (
              <div className="aw-note" style={{ marginBottom: 8 }}>有 {st.skipped} 条存档读不出结构，已跳过（不影响其他会话导入）。</div>
            )}
            {(st?.sessions ?? []).map(s => {
              const k = keyOf(agentId, s)
              const open = openKey === k
              const covered = settings.vault.enabled && !!s.cwd
              return (
                <div key={k} className="aw-session-row">
                  <button className="aw-session-main" onClick={() => { setOpenKey(open ? '' : k); setPrompt(''); setAck(false) }}>
                    <span className="aw-session-title">{sessionDisplayTitle(s)}</span>
                    <span className="aw-note">
                      {s.entryLabel} · 更新于 {new Date(s.updatedAt).toLocaleString()}
                      {s.cwd ? ` · ${s.cwd}` : ' · 存档没记工作目录'}
                      {sessionTitleSourceNote(s) ? ` · ${sessionTitleSourceNote(s)}` : ''}
                    </span>
                  </button>
                  {open && (
                    <div className="aw-session-form">
                      <textarea
                        className="aw-input" rows={2} value={prompt}
                        placeholder="接着让它做什么（如：把刚才那个问题继续修完，并跑一遍测试）"
                        onChange={e => setPrompt(e.target.value)}
                      />
                      {!covered && (
                        <label className="aw-ack">
                          <input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} />
                          {settings.vault.enabled
                            ? '我知道：这条存档没记工作目录，本次续跑没有文件保险箱覆盖，Agent 可能写入任何位置'
                            : '我知道：文件保险箱已关闭，本次续跑的文件改动不可还原'}
                        </label>
                      )}
                      {covered && <div className="aw-note">保险箱已覆盖存档里的工作目录：开跑前存基线，改动可还原。</div>}
                      <div className="aw-task-btns">
                        <button
                          className="btn sm primary"
                          disabled={!hasCli || !prompt.trim() || (!covered && !ack)}
                          onClick={() => onImported({
                            agentId, entryId: s.entryId, sessionId: s.sessionId,
                            title: sessionDisplayTitle(s), cwd: s.cwd, prompt: prompt.trim(),
                            outsideOk: !covered && ack,
                          })}
                        ><Play size={13} /> 以此会话续跑</button>
                        {!hasCli && <span className="aw-note"><ShieldAlert size={12} /> 先装 {def.name} 命令才能续跑</span>}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
