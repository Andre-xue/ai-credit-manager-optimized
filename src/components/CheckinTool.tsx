import { useCallback, useEffect, useRef, useState } from 'react'
import { CalendarCheck, Fingerprint, Loader2, LogIn, LogOut, RefreshCw, Sparkles } from 'lucide-react'
import { ToolShell } from './WorkshopView'
import { openExternal, biometricAvailable } from '../core/openExternal'
import { resolveBiometricVaultPassword } from '../core/biometric'
import {
  hasCheckinCred, loadCheckinCred, saveCheckinCred, clearCheckinCred,
  minimaxBeginDevice, minimaxPollDevice,
  getCheckinStatus, claimCheckin,
  type CheckinCred, type CheckinStatus, type MinimaxDeviceFlow,
} from '../core/checkin'
import {
  migrateLegacyWorkbuddyCred, poolAccountStatuses, poolClaimOne, listPoolMeta,
  type PoolAccountStatus,
} from '../core/wbPool'
import { getAutoCheckinEnabled, setAutoCheckinEnabled } from '../core/checkinRun'

/**
 * 每日签到工具页（v0.1.356 上线，v0.1.359 WorkBuddy 改走账号池）：
 * WorkBuddy 的签到对象是账号池里的每个账号；MiniMax 仍是单账号授权。
 * 凭据都用保险箱主密码加密、只存本机。
 */
export function CheckinTool({ sessionPwd, onUnlock, notify, onBack }: {
  sessionPwd: string
  onUnlock: (pwd: string) => void
  notify: (msg: string) => void
  onBack: () => void
}) {
  const [pwdInput, setPwdInput] = useState('')
  const [bioOk, setBioOk] = useState(false)
  // MiniMax 单账号
  const [mmCred, setMmCred] = useState<CheckinCred | null>(null)
  const [mmStatus, setMmStatus] = useState<CheckinStatus | null>(null)
  const [mmError, setMmError] = useState('')
  const [mmAuth, setMmAuth] = useState<{ authUrl: string; userCode: string } | null>(null)
  // WorkBuddy 账号池
  const [poolStatuses, setPoolStatuses] = useState<PoolAccountStatus[]>([])
  const [busy, setBusy] = useState('')
  const [autoOn, setAutoOn] = useState(() => getAutoCheckinEnabled())
  const pollRef = useRef<number | null>(null)

  useEffect(() => { void biometricAvailable().then(setBioOk).catch(() => setBioOk(false)) }, [])
  const bioUnlock = async () => {
    const pwd = await resolveBiometricVaultPassword('验证身份以解锁保险箱')
    if (pwd) onUnlock(pwd)
    else notify('未通过指纹验证，或还没开启指纹解锁（先输一次主密码，并在设置里开启指纹/生物解锁后再用）')
  }

  const refreshMm = useCallback(async () => {
    setBusy('mm-status')
    try {
      setMmStatus(await getCheckinStatus('minimax', sessionPwd))
      setMmError('')
    } catch (e) { setMmError(e instanceof Error ? e.message : '查询失败') } finally { setBusy('') }
  }, [sessionPwd])

  const refreshPool = useCallback(async () => {
    setBusy('wb-status')
    try { setPoolStatuses(await poolAccountStatuses(sessionPwd)) } finally { setBusy('') }
  }, [sessionPwd])

  useEffect(() => {
    if (!sessionPwd) return
    let dead = false
    void (async () => {
      await migrateLegacyWorkbuddyCred(sessionPwd).catch(() => false)
      if (dead) return
      if (hasCheckinCred('minimax')) {
        const cred = await loadCheckinCred('minimax', sessionPwd)
        if (!dead && cred) { setMmCred(cred); void refreshMm() }
      }
      if (listPoolMeta().length) void refreshPool()
    })()
    return () => { dead = true }
  }, [sessionPwd, refreshMm, refreshPool])

  useEffect(() => () => { if (pollRef.current) window.clearInterval(pollRef.current) }, [])

  const startMmAuth = async () => {
    setBusy('mm-auth')
    try {
      const flow: MinimaxDeviceFlow = await minimaxBeginDevice()
      setMmAuth({ authUrl: flow.authUrl, userCode: flow.userCode })
      await openExternal(flow.authUrl)
      const deadline = Date.now() + flow.expiresIn * 1000
      const timer = window.setInterval(() => {
        if (Date.now() > deadline) {
          window.clearInterval(timer); setMmAuth(null); notify('授权码已过期，请重新连接'); return
        }
        void minimaxPollDevice(flow).then(async cred => {
          if (!cred) return
          window.clearInterval(timer)
          await saveCheckinCred('minimax', cred, sessionPwd)
          setMmCred(cred); setMmAuth(null)
          notify('MiniMax 已连接')
          void refreshMm()
        }).catch(e => {
          window.clearInterval(timer); setMmAuth(null)
          notify(e instanceof Error ? e.message : '授权失败')
        })
      }, flow.intervalSecs * 1000)
      pollRef.current = timer
    } catch (e) { notify(e instanceof Error ? e.message : '发起授权失败') } finally { setBusy('') }
  }

  const claimMm = async () => {
    setBusy('mm-claim')
    try {
      const r = await claimCheckin('minimax', sessionPwd)
      notify(r.message)
      void refreshMm()
    } catch (e) { notify(e instanceof Error ? e.message : '签到失败') } finally { setBusy('') }
  }

  const claimPoolOne = async (id: string, label: string) => {
    setBusy(`wb-claim:${id}`)
    try {
      const r = await poolClaimOne(sessionPwd, id)
      notify(`${label}：${r.message}`)
      void refreshPool()
    } catch (e) { notify(e instanceof Error ? e.message : '签到失败') } finally { setBusy('') }
  }

  const claimPoolAll = async () => {
    setBusy('wb-claim-all')
    let done = 0
    for (const s of poolStatuses) {
      if (s.status?.state !== 'claimable') continue
      try { await poolClaimOne(sessionPwd, s.meta.id); done++ } catch { /* 单个失败不阻塞其余 */ }
    }
    notify(done ? `已给 ${done} 个账号签到` : '没有可签到的账号')
    void refreshPool()
    setBusy('')
  }

  const claimableCount = poolStatuses.filter(s => s.status?.state === 'claimable').length

  return (
    <ToolShell title="每日签到" desc="WorkBuddy（账号池里的每个号）/ MiniMax Code 的每日积分签到。凭据加密只存本机。" onBack={onBack}>
      {!sessionPwd && (
        <div className="ws-result">
          保险箱还没解锁：签到凭据要用主密码加密保存，在这里直接解锁即可，不用去别的页面。
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input type="password" className="input" style={{ maxWidth: 240 }} placeholder="保险箱主密码"
              value={pwdInput} onChange={e => setPwdInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && pwdInput) { onUnlock(pwdInput); setPwdInput('') } }} />
            <button className="btn sm primary" disabled={!pwdInput} onClick={() => { onUnlock(pwdInput); setPwdInput('') }}>解锁</button>
            {bioOk && <button className="btn sm" onClick={() => void bioUnlock()}><Fingerprint size={14} /> 指纹解锁</button>}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1px solid var(--border)', borderRadius: 14, padding: '10px 16px', background: 'var(--panel)', marginBottom: 12 }}>
        <div style={{ flex: 1 }}>
          <b style={{ fontSize: 13.5 }}>自动签到</b>
          <span style={{ fontSize: 12.5, color: 'var(--text-3)', marginLeft: 8 }}>开着时，App 运行且保险箱解锁后每天自动签一次（结果在菜单栏迷你窗能看到）；App 没运行或保险箱没解锁时不会执行，解锁后会补上。</span>
        </div>
        <button className="btn sm" onClick={() => { const v = !autoOn; setAutoOn(v); setAutoCheckinEnabled(v); notify(v ? '自动签到已开启' : '自动签到已关闭') }}>
          {autoOn ? '已开启' : '已关闭'}
        </button>
      </div>

      {/* WorkBuddy：账号池 */}
      <div style={{ border: '1px solid var(--border)', borderRadius: 14, padding: '14px 16px', background: 'var(--panel)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="ws-tico g2"><CalendarCheck size={20} /></span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>WorkBuddy（账号池）</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>池里每个账号每天 100 积分，在工坊「WorkBuddy 账号池」里添加/管理账号</div>
          </div>
          {poolStatuses.length > 0 && (
            <button className="btn sm" disabled={!sessionPwd || busy === 'wb-status'} onClick={() => void refreshPool()}>
              {busy === 'wb-status' ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} 刷新
            </button>
          )}
          {claimableCount > 0 && (
            <button className="btn sm primary" disabled={busy === 'wb-claim-all'} onClick={() => void claimPoolAll()}>
              {busy === 'wb-claim-all' ? <Loader2 size={14} className="spin" /> : <CalendarCheck size={14} />} 全部签到（{claimableCount}）
            </button>
          )}
        </div>
        {poolStatuses.length === 0 && (
          <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 10 }}>
            {sessionPwd ? '账号池还是空的：去工坊主页打开「WorkBuddy 账号池」，添加账号后回到这里就能逐个签到。' : '解锁后显示池里账号的签到状态。'}
          </div>
        )}
        <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
          {poolStatuses.map(s => (
            <div key={s.meta.id} style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1px solid var(--border)', borderRadius: 10, padding: '8px 12px' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <b style={{ fontSize: 13.5 }}>{s.meta.label}</b>
                <div style={{ fontSize: 12.5, color: s.error ? 'var(--danger, #d33)' : 'var(--text-3)' }}>
                  {s.error ? `查询失败：${s.error}` : s.status
                    ? `${s.status.message}${s.status.streakDays > 0 ? ` · 连签 ${s.status.streakDays} 天` : ''}`
                    : '状态加载中…'}
                </div>
              </div>
              {s.status?.state === 'claimable' && (
                <button className="btn sm primary" disabled={busy === `wb-claim:${s.meta.id}`} onClick={() => void claimPoolOne(s.meta.id, s.meta.label)}>
                  {busy === `wb-claim:${s.meta.id}` ? <Loader2 size={14} className="spin" /> : <CalendarCheck size={14} />} 签到{s.status.points ? ` +${s.status.points}` : ''}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* MiniMax：单账号 */}
      <div style={{ border: '1px solid var(--border)', borderRadius: 14, padding: '14px 16px', background: 'var(--panel)', marginTop: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="ws-tico g3"><CalendarCheck size={20} /></span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>MiniMax Code</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>每日签到基础 400 积分，第 4 / 7 天 1,000</div>
          </div>
          {mmCred && <span className="ws-tag free">{mmCred.label}</span>}
        </div>

        {mmAuth && (
          <div className="ws-result" style={{ marginTop: 10 }}>
            <Loader2 size={14} className="spin" /> 在浏览器里确认授权（约 5 分钟内有效），本页会自动完成连接…
            <div style={{ marginTop: 6 }}>授权码：<b style={{ fontSize: 16, letterSpacing: 2 }}>{mmAuth.userCode}</b>（页面若没自动带上，手动填它）</div>
            <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
              <button className="btn sm" onClick={() => void openExternal(mmAuth.authUrl)}>重新打开授权页</button>
              <button className="btn sm ghost" onClick={() => { if (pollRef.current) window.clearInterval(pollRef.current); setMmAuth(null) }}>取消</button>
            </div>
          </div>
        )}

        {!mmCred && !mmAuth && (
          <div style={{ marginTop: 10 }}>
            <button className="btn primary" disabled={!sessionPwd || busy === 'mm-auth'} onClick={() => void startMmAuth()}>
              {busy === 'mm-auth' ? <Loader2 size={15} className="spin" /> : <LogIn size={15} />} 连接账号
            </button>
            <span style={{ marginLeft: 10, fontSize: 12.5, color: 'var(--text-3)' }}>会打开浏览器让你登录确认，只需一次</span>
          </div>
        )}

        {mmCred && !mmAuth && (
          <div style={{ marginTop: 10 }}>
            {mmError && <div className="ws-result" style={{ color: 'var(--danger, #d33)' }}>状态查询失败：{mmError}</div>}
            {mmStatus && (
              <div style={{ fontSize: 13.5 }}>
                <Sparkles size={14} style={{ verticalAlign: -2 }} /> {mmStatus.message}
                {mmStatus.streakDays > 0 && <span style={{ color: 'var(--text-3)' }}> · 已连签 {mmStatus.streakDays} 天</span>}
                {typeof mmStatus.balance === 'number' && <span style={{ color: 'var(--text-3)' }}> · 剩余积分 {Math.round(mmStatus.balance)}</span>}
              </div>
            )}
            {mmStatus?.days && mmStatus.days.length > 0 && (
              <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                {mmStatus.days.map(d => (
                  <span key={d.dayNo} style={{
                    fontSize: 11.5, padding: '3px 8px', borderRadius: 999,
                    border: d.isToday ? '1.5px solid var(--accent, #6c5ce7)' : '1px solid var(--border)',
                    opacity: d.claimed ? 1 : 0.75, background: d.claimed ? 'var(--panel-2)' : 'transparent',
                  }}>
                    第{d.dayNo}天 · {d.points}{d.claimed ? ' ✓' : d.isToday ? ' · 今天' : ''}
                  </span>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              {mmStatus?.state === 'claimable' && (
                <button className="btn primary" disabled={busy === 'mm-claim'} onClick={() => void claimMm()}>
                  {busy === 'mm-claim' ? <Loader2 size={15} className="spin" /> : <CalendarCheck size={15} />} 立即签到{mmStatus.points ? ` +${mmStatus.points}` : ''}
                </button>
              )}
              <button className="btn" disabled={busy === 'mm-status'} onClick={() => void refreshMm()}>
                {busy === 'mm-status' ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />} 刷新状态
              </button>
              <button className="btn ghost" onClick={() => { clearCheckinCred('minimax'); setMmCred(null); setMmStatus(null); notify('已断开 MiniMax（本机凭据已删除）') }}>
                <LogOut size={15} /> 断开
              </button>
            </div>
          </div>
        )}
      </div>

      <p style={{ fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.7, marginTop: 14 }}>
        说明：签到走各平台客户端同款接口（非公开接口，平台调整后可能失效，失效时这里会如实报错）；
        登录凭据用保险箱主密码加密、只存这台设备，不随云同步走。自动代签到存在平台风控可能，本工具只做手动领取，风险请自行评估。
        做法参考了开源项目 CheckinBox-Tools 与 dsh-xdpool 的公开协议行为，代码为独立实现。
      </p>
    </ToolShell>
  )
}
