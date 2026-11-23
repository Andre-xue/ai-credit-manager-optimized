import { useCallback, useEffect, useRef, useState } from 'react'
import { CalendarCheck, Fingerprint, Loader2, Pin, PinOff, Play, Power, RefreshCw, Send, Trash2, UserPlus, XCircle } from 'lucide-react'
import { ToolShell } from './WorkshopView'
import { openExternal, biometricAvailable } from '../core/openExternal'
import { resolveBiometricVaultPassword } from '../core/biometric'
import { workbuddyBegin, workbuddyPoll, type WorkbuddyFlow } from '../core/checkin'
import {
  listPoolMeta, addPoolAccount, removePoolAccount, poolCredBox, migrateLegacyWorkbuddyCred,
  getPoolState, patchPoolState, poolModels, poolChat, poolAccountStatuses, poolClaimOne,
  getPoolModelPref, setPoolModelPref,
  type PoolAccountMeta, type PoolAccountState, type PoolAccountStatus, type WbModel,
} from '../core/wbPool'

/**
 * WorkBuddy 账号池管理页（v0.1.359）：OAuth 授权入池、多账号状态总览、
 * 对话轮换/失败切换的测试台。池同时供工坊工具的「WorkBuddy 账号池」路线与每日签到使用。
 */
export function WbPoolTool({ sessionPwd, onUnlock, notify, onBack }: {
  sessionPwd: string
  onUnlock: (pwd: string) => void
  notify: (msg: string) => void
  onBack: () => void
}) {
  const [pwdInput, setPwdInput] = useState('')
  const [bioOk, setBioOk] = useState(false)
  const [metas, setMetas] = useState<PoolAccountMeta[]>([])
  const [poolState, setPoolState] = useState<Record<string, PoolAccountState>>({})
  const [expires, setExpires] = useState<Record<string, number>>({})
  const [statuses, setStatuses] = useState<PoolAccountStatus[]>([])
  const [models, setModels] = useState<WbModel[]>([])
  const [model, setModel] = useState(() => getPoolModelPref())
  const [busy, setBusy] = useState('')
  const [authing, setAuthing] = useState(false)
  const [testInput, setTestInput] = useState('你好，简单介绍一下你自己')
  const [testReply, setTestReply] = useState('')
  const [testMeta, setTestMeta] = useState('')
  const pollRef = useRef<number | null>(null)

  useEffect(() => { void biometricAvailable().then(setBioOk).catch(() => setBioOk(false)) }, [])
  const bioUnlock = async () => {
    const pwd = await resolveBiometricVaultPassword('验证身份以解锁保险箱')
    if (pwd) onUnlock(pwd)
    else notify('未通过指纹验证，或还没开启指纹解锁（先输一次主密码，并在设置里开启指纹/生物解锁后再用）')
  }

  const reloadLocal = useCallback(() => {
    setMetas(listPoolMeta())
    setPoolState(getPoolState())
  }, [])

  const loadExpires = useCallback(async (pwd: string, list: PoolAccountMeta[]) => {
    const out: Record<string, number> = {}
    for (const m of list) {
      const cred = await poolCredBox(m.id, pwd).load()
      if (cred) out[m.id] = cred.expiresAt
    }
    setExpires(out)
  }, [])

  const refreshStatuses = useCallback(async () => {
    if (!sessionPwd) return
    setBusy('status')
    try { setStatuses(await poolAccountStatuses(sessionPwd)) }
    finally { setBusy('') }
  }, [sessionPwd])

  useEffect(() => {
    reloadLocal()
    if (!sessionPwd) return
    let dead = false
    void (async () => {
      await migrateLegacyWorkbuddyCred(sessionPwd).catch(() => false)
      if (dead) return
      reloadLocal()
      const list = listPoolMeta()
      void loadExpires(sessionPwd, list)
      void refreshStatuses()
      const ms = await poolModels(sessionPwd).catch(() => [])
      if (!dead) setModels(ms)
    })()
    return () => { dead = true }
  }, [sessionPwd, reloadLocal, loadExpires, refreshStatuses])

  useEffect(() => () => { if (pollRef.current) window.clearInterval(pollRef.current) }, [])

  const startAuth = async () => {
    setBusy('auth')
    try {
      const flow: WorkbuddyFlow = await workbuddyBegin()
      setAuthing(true)
      await openExternal(flow.authUrl)
      const deadline = Date.now() + 5 * 60 * 1000
      const timer = window.setInterval(() => {
        if (Date.now() > deadline) {
          window.clearInterval(timer); setAuthing(false); notify('等待授权超时，请重试'); return
        }
        void workbuddyPoll(flow).then(async cred => {
          if (!cred) return
          window.clearInterval(timer)
          setAuthing(false)
          const meta = await addPoolAccount(cred, sessionPwd)
          notify(`已入池：${meta.label}`)
          reloadLocal()
          void loadExpires(sessionPwd, listPoolMeta())
          void refreshStatuses()
        }).catch(e => {
          window.clearInterval(timer); setAuthing(false)
          notify(e instanceof Error ? e.message : '授权失败')
        })
      }, 3000)
      pollRef.current = timer
    } catch (e) {
      notify(e instanceof Error ? e.message : '发起授权失败')
    } finally { setBusy('') }
  }

  const claim = async (id: string, label: string) => {
    setBusy(`claim:${id}`)
    try {
      const r = await poolClaimOne(sessionPwd, id)
      notify(`${label}：${r.message}`)
      void refreshStatuses()
    } catch (e) { notify(e instanceof Error ? e.message : '签到失败') } finally { setBusy('') }
  }

  const runTest = async () => {
    if (!testInput.trim()) return
    setBusy('test'); setTestReply(''); setTestMeta('')
    try {
      const r = await poolChat(sessionPwd, [{ role: 'user', content: testInput.trim() }], { model: model || undefined })
      setTestReply(r.text)
      setTestMeta(`由「${r.accountLabel}」应答 · 模型 ${r.model}`)
    } catch (e) {
      notify(e instanceof Error ? e.message : '调用失败')
      reloadLocal()
    } finally { setBusy('') }
  }

  const statusOf = (id: string) => statuses.find(s => s.meta.id === id)

  return (
    <ToolShell title="WorkBuddy 账号池" desc="多个 WorkBuddy 账号授权入池，对外当一个模型来源：对话自动轮换、限流自动冷却切换。工坊工具里选「WorkBuddy 账号池」路线即可用，每日签到也会带上池里的账号。" onBack={onBack}>
      {!sessionPwd && (
        <div className="ws-result">
          保险箱还没解锁：池里的账号凭据要用主密码加密保存，在这里直接解锁即可。
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input type="password" className="input" style={{ maxWidth: 240 }} placeholder="保险箱主密码"
              value={pwdInput} onChange={e => setPwdInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && pwdInput) { onUnlock(pwdInput); setPwdInput('') } }} />
            <button className="btn sm primary" disabled={!pwdInput} onClick={() => { onUnlock(pwdInput); setPwdInput('') }}>解锁</button>
            {bioOk && <button className="btn sm" onClick={() => void bioUnlock()}><Fingerprint size={14} /> 指纹解锁</button>}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn primary" disabled={!sessionPwd || authing || busy === 'auth'} onClick={() => void startAuth()}>
          {authing || busy === 'auth' ? <Loader2 size={15} className="spin" /> : <UserPlus size={15} />} {authing ? '等待浏览器授权…' : '添加 WorkBuddy 账号'}
        </button>
        <button className="btn" disabled={!sessionPwd || busy === 'status'} onClick={() => void refreshStatuses()}>
          {busy === 'status' ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />} 刷新全部状态
        </button>
        <span style={{ fontSize: 12.5, color: 'var(--text-3)' }}>池里共 {metas.length} 个账号。在浏览器里换个账号登录确认，就能把另一个号也加进来。</span>
      </div>

      <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
        {metas.map(m => {
          const st = poolState[m.id] ?? {}
          const info = statusOf(m.id)
          const exp = expires[m.id]
          const cooling = (st.cooldownUntil ?? 0) > Date.now()
          return (
            <div key={m.id} style={{ border: '1px solid var(--border)', borderRadius: 14, padding: '12px 16px', background: 'var(--panel)', opacity: st.disabled ? 0.6 : 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <b style={{ fontSize: 14.5 }}>{m.label}</b>
                {st.pinned && <span className="ws-tag">置顶优先</span>}
                {st.disabled && <span className="ws-tag">已停用</span>}
                {cooling && <span className="ws-tag">冷却中（至 {new Date(st.cooldownUntil!).toLocaleTimeString()}）</span>}
                <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                  {exp ? `令牌到期 ${new Date(exp).toLocaleString()}` : ''}
                  {st.lastUsedAt ? ` · 最近调用 ${new Date(st.lastUsedAt).toLocaleTimeString()}` : ''}
                </span>
              </div>
              {st.lastError && <div style={{ fontSize: 12.5, color: 'var(--danger, #d33)', marginTop: 4 }}>最近错误：{st.lastError}</div>}
              <div style={{ fontSize: 13, marginTop: 6 }}>
                {info?.error && <span style={{ color: 'var(--danger, #d33)' }}>签到状态查询失败：{info.error}</span>}
                {info?.status && (
                  <span>
                    <CalendarCheck size={13} style={{ verticalAlign: -2 }} /> {info.status.message}
                    {info.status.streakDays > 0 && <span style={{ color: 'var(--text-3)' }}> · 连签 {info.status.streakDays} 天</span>}
                  </span>
                )}
                {!info && sessionPwd && <span style={{ color: 'var(--text-3)' }}>状态加载中…</span>}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                {info?.status?.state === 'claimable' && (
                  <button className="btn sm primary" disabled={busy === `claim:${m.id}`} onClick={() => void claim(m.id, m.label)}>
                    {busy === `claim:${m.id}` ? <Loader2 size={14} className="spin" /> : <CalendarCheck size={14} />} 签到{info.status.points ? ` +${info.status.points}` : ''}
                  </button>
                )}
                <button className="btn sm" onClick={() => { patchPoolState(m.id, { pinned: !st.pinned }); reloadLocal() }}>
                  {st.pinned ? <PinOff size={14} /> : <Pin size={14} />} {st.pinned ? '取消置顶' : '置顶'}
                </button>
                <button className="btn sm" onClick={() => { patchPoolState(m.id, { disabled: !st.disabled }); reloadLocal() }}>
                  <Power size={14} /> {st.disabled ? '启用' : '停用'}
                </button>
                {cooling && (
                  <button className="btn sm" onClick={() => { patchPoolState(m.id, { cooldownUntil: undefined }); reloadLocal() }}>
                    <XCircle size={14} /> 清除冷却
                  </button>
                )}
                <button className="btn sm ghost" onClick={() => { removePoolAccount(m.id); reloadLocal(); notify('已移出池子（本机凭据已删除）') }}>
                  <Trash2 size={14} /> 移出
                </button>
              </div>
            </div>
          )
        })}
        {metas.length === 0 && sessionPwd && (
          <div className="ws-result">池子还是空的：点上方「添加 WorkBuddy 账号」，在浏览器里登录确认，账号就入池了。有多个号就重复添加（每次在浏览器里换号登录）。</div>
        )}
      </div>

      {metas.length > 0 && (
        <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <label className="ws-route" style={{ margin: 0 }}>
              <span>池默认模型</span>
              <select className="select" value={model} onChange={e => { setModel(e.target.value); setPoolModelPref(e.target.value) }}>
                <option value="">自动（目录第一个）</option>
                {models.map(mo => <option key={mo.id} value={mo.id}>{mo.name}{mo.credits ? ` · ${mo.credits} 倍率` : ''}</option>)}
              </select>
            </label>
            {models.length === 0 && sessionPwd && <span style={{ fontSize: 12.5, color: 'var(--text-3)' }}>模型目录还没拉到，刷新状态后会自动重试</span>}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <input className="input" style={{ flex: 1 }} value={testInput} onChange={e => setTestInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void runTest() }} placeholder="给池子发一句话试试" />
            <button className="btn primary" disabled={!sessionPwd || busy === 'test'} onClick={() => void runTest()}>
              {busy === 'test' ? <Loader2 size={15} className="spin" /> : <Send size={15} />} 发送测试
            </button>
          </div>
          {testMeta && <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginTop: 8 }}><Play size={12} style={{ verticalAlign: -1 }} /> {testMeta}</div>}
          {testReply && <div className="ws-result" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{testReply}</div>}
        </div>
      )}

      <p style={{ fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.7, marginTop: 14 }}>
        说明：池凭据只存本机、不云同步——WorkBuddy 的 refresh token 每次续期都会轮换，多台设备同时用同一个号会互相作废，所以池子按单设备设计。
        对话走 WorkBuddy 客户端同款接口（非公开接口，可能随平台更新失效）；自动切换只在限流/积分不足/登录过期时发生，失败原因会如实记在对应账号卡上。
        做法参考开源项目 dsh-xdpool（MIT）的公开协议行为，代码为独立实现。
      </p>
    </ToolShell>
  )
}
