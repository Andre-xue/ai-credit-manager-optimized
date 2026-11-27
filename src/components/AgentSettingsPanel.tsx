import { useMemo, useState } from 'react'
import { Bot, Repeat, ShieldCheck, FolderLock, Crown, ArrowUp, ArrowDown, RefreshCw, AlertTriangle } from 'lucide-react'
import type { Account } from '../core/types'
import {
  AGENT_REGISTRY, agentAvailability, type AgentSettings, type AgentDetectResult, type KeyBinding,
} from '../core/agents'
import { selectPruneVictims, vaultTotals, formatBytes, type VaultEntry } from '../core/agentVault'
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

export function AgentSettingsPanel({ settings, onChange, accounts, detectMap, onRedetect, vaultEntries, onPruneNow, notify }: {
  settings: AgentSettings
  onChange: (s: AgentSettings) => void
  accounts: Account[]
  detectMap: Record<string, AgentDetectResult>
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
        <div className="aw-card">
          <div className="aw-card-head">
            <span>本机 Agent（改动只存本机）</span>
            <button className="btn sm" onClick={onRedetect}><RefreshCw size={13} /> 重新检测</button>
          </div>
          {AGENT_REGISTRY.map(def => {
            const det = detectMap[def.id]
            const avail = agentAvailability(def, det, settings, accounts)
            const installed = !!det?.installed
            return (
              <div key={def.id} className="aw-agent-row">
                <div className="aw-agent-main">
                  <div className="aw-agent-title">
                    <b>{def.name}</b>
                    <span className={`aw-tag ${def.kind === 'account' ? 'acct' : 'shell'}`}>{def.kind === 'account' ? '账号登录型' : '空壳型'}</span>
                    <span className={`aw-tag ${installed ? 'ok' : 'off'}`}>{installed ? `已安装${det?.via === 'app' ? '（应用）' : '（CLI）'}` : '未安装'}</span>
                  </div>
                  {def.qualification && <div className="aw-note warn">{def.qualification}</div>}
                  {!installed && <div className="aw-note">{def.installHint}</div>}
                  {installed && def.kind === 'account' && <div className="aw-note">使用自身登录账号（免 Key），魔方只派活与盯进度，不记细账</div>}
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
              </div>
            )
          })}
        </div>
      )}

      {cat === 'relay' && (
        <div className="aw-card">
          <div className="aw-phase2-banner">接力执行将在二期生效：本期可先排好接力链与模式并保存，任务不会真的自动接力。</div>
          <div className="aw-field">
            <span>接力模式</span>
            <label className="aw-radio"><input type="radio" checked={settings.relay.mode === 'ask'} onChange={() => set({ relay: { ...settings.relay, mode: 'ask' } })} /> 先停住询问（额度耗尽时问过我再换人）</label>
            <label className="aw-radio"><input type="radio" checked={settings.relay.mode === 'auto'} onChange={() => set({ relay: { ...settings.relay, mode: 'auto' } })} /> 自动接力（按接力链顺序换人续跑）<span className="aw-tag phase2">二期生效</span></label>
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
            <label className="aw-radio aw-disabled"><input type="radio" disabled /> 自动接力到免费路线 <span className="aw-tag phase2">二期</span></label>
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
          </div>
          <div className="aw-note">权限口径：Agent 在工作目录内默认最大权限、自动执行不逐项确认，安全靠保险箱可还原；目录外写入与外发数据、改系统设置等非文件操作不在最大权限内，派活时单独明示确认。</div>
        </div>
      )}

      {cat === 'master' && (
        <div className="aw-card">
          <div className="aw-phase2-banner">主控编排与交叉审查将在二期生效：本期可先选好主控并保存，任务仍由你手动委派。</div>
          <div className="aw-field">
            <label className="aw-bind"><span>主控 Agent（未写 # 委派时默认交给谁）</span>
              <select value={settings.master.masterAgentId} onChange={e => set({ master: { ...settings.master, masterAgentId: e.target.value } })}>
                <option value="">未设置（用第一个可用的）</option>
                {AGENT_REGISTRY.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
          </div>
          <div className="aw-agent-row">
            <div className="aw-agent-main">
              <b>交叉审查</b>
              <div className="aw-note">一个 Agent 交活后，由另一个 Agent 复核再结算。<span className="aw-tag phase2">二期生效</span></div>
            </div>
            <JellyToggle checked={settings.master.crossReview} disabled onChange={() => notify('交叉审查将在二期开放')} />
          </div>
        </div>
      )}
    </div>
  )
}
