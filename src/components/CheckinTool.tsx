import { useCallback, useEffect, useRef, useState } from 'react'
import { CalendarCheck, Fingerprint, Loader2, LogIn, LogOut, RefreshCw, Sparkles } from 'lucide-react'
import { ToolShell } from './WorkshopView'
import { openExternal, biometricAvailable } from '../core/openExternal'
import { resolveBiometricVaultPassword } from '../core/biometric'
import {
  hasCheckinCred, loadCheckinCred, saveCheckinCred, clearCheckinCred,
  minimaxBeginDevice, minimaxPollDevice, workbuddyBegin, workbuddyPoll,
  getCheckinStatus, claimCheckin,
  type CheckinPlatform, type CheckinCred, type CheckinStatus, type MinimaxDeviceFlow, type WorkbuddyFlow,
} from '../core/checkin'

/**
 * 每日签到工具页（v0.1.356）：WorkBuddy / MiniMax Code 每日积分签到。
 * 授权一次（浏览器确认），token 加密存本机；之后打开本页自动查状态，点一下领取。
 */
interface PlatformMeta { id: CheckinPlatform; name: string; desc: string; grad: string }
const PLATFORMS: PlatformMeta[] = [
  { id: 'workbuddy', name: 'WorkBuddy', desc: '腾讯 CodeBuddy / WorkBuddy，每日签到 100 积分', grad: 'g2' },
  { id: 'minimax', name: 'MiniMax Code', desc: '每日签到基础 400 积分，第 4 / 7 天 1,000', grad: 'g3' },
]

interface AuthState {
  platform: CheckinPlatform
  authUrl: string
  userCode?: string
  note: string
}

export function CheckinTool({ sessionPwd, onUnlock, notify, onBack }: {
  sessionPwd: string
  onUnlock: (pwd: string) => void
  notify: (msg: string) => void
  onBack: () => void
}) {
  const [pwdInput, setPwdInput] = useState('')
  const [bioOk, setBioOk] = useState(false)
  useEffect(() => { void biometricAvailable().then(setBioOk).catch(() => setBioOk(false)) }, [])
  const bioUnlock = async () => {
    const pwd = await resolveBiometricVaultPassword('验证身份以解锁保险箱')
    if (pwd) onUnlock(pwd)
    else notify('未通过指纹验证，或还没开启指纹解锁（先输一次主密码，并在设置里开启指纹/生物解锁后再用）')
  }
  const [creds, setCreds] = useState<Partial<Record<CheckinPlatform, CheckinCred>>>({})
  const [statuses, setStatuses] = useState<Partial<Record<CheckinPlatform, CheckinStatus>>>({})
  const [errors, setErrors] = useState<Partial<Record<CheckinPlatform, string>>>({})
  const [busy, setBusy] = useState<string>('')
  const [auth, setAuth] = useState<AuthState | null>(null)
  const pollRef = useRef<{ timer: number; deadline: number } | null>(null)

  const stopPolling = useCallback(() => {
    if (pollRef.current) { window.clearInterval(pollRef.current.timer); pollRef.current = null }
  }, [])

  const refreshStatus = useCallback(async (platform: CheckinPlatform) => {
    setBusy(`status:${platform}`)
    try {
      const st = await getCheckinStatus(platform, sessionPwd)
      setStatuses(prev => ({ ...prev, [platform]: st }))
      setErrors(prev => ({ ...prev, [platform]: undefined }))
    } catch (e) {
      setErrors(prev => ({ ...prev, [platform]: e instanceof Error ? e.message : '查询失败' }))
    } finally { setBusy('') }
  }, [sessionPwd])

  // 进入页面：加载已保存的凭据并自动查状态
  useEffect(() => {
    if (!sessionPwd) return
    let dead = false
    void (async () => {
      const loaded: Partial<Record<CheckinPlatform, CheckinCred>> = {}
      for (const p of PLATFORMS) {
        if (hasCheckinCred(p.id)) {
          const cred = await loadCheckinCred(p.id, sessionPwd)
          if (cred) loaded[p.id] = cred
        }
      }
      if (dead) return
      setCreds(loaded)
      for (const p of PLATFORMS) if (loaded[p.id]) void refreshStatus(p.id)
    })()
    return () => { dead = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionPwd])

  useEffect(() => stopPolling, [stopPolling])

  const finishAuth = useCallback(async (platform: CheckinPlatform, cred: CheckinCred) => {
    await saveCheckinCred(platform, cred, sessionPwd)
    setCreds(prev => ({ ...prev, [platform]: cred }))
    setAuth(null)
    notify(`${platform === 'workbuddy' ? 'WorkBuddy' : 'MiniMax'} 已连接`)
    void refreshStatus(platform)
  }, [notify, refreshStatus, sessionPwd])

  const startAuth = async (platform: CheckinPlatform) => {
    setBusy(`auth:${platform}`)
    try {
      if (platform === 'minimax') {
        const flow: MinimaxDeviceFlow = await minimaxBeginDevice()
        setAuth({ platform, authUrl: flow.authUrl, userCode: flow.userCode, note: '在浏览器里确认授权（约 5 分钟内有效），本页会自动完成连接…' })
        await openExternal(flow.authUrl)
        stopPolling()
        const deadline = Date.now() + flow.expiresIn * 1000
        const timer = window.setInterval(() => {
          if (Date.now() > deadline) {
            stopPolling(); setAuth(null); notify('授权码已过期，请重新连接'); return
          }
          void minimaxPollDevice(flow).then(cred => {
            if (cred) { stopPolling(); void finishAuth('minimax', cred) }
          }).catch(e => {
            stopPolling(); setAuth(null); notify(e instanceof Error ? e.message : '授权失败')
          })
        }, flow.intervalSecs * 1000)
        pollRef.current = { timer, deadline }
      } else {
        const flow: WorkbuddyFlow = await workbuddyBegin()
        setAuth({ platform, authUrl: flow.authUrl, note: '在浏览器里登录并确认授权，本页会自动完成连接…' })
        await openExternal(flow.authUrl)
        stopPolling()
        const deadline = Date.now() + 5 * 60 * 1000
        const timer = window.setInterval(() => {
          if (Date.now() > deadline) {
            stopPolling(); setAuth(null); notify('等待授权超时，请重新连接'); return
          }
          void workbuddyPoll(flow).then(cred => {
            if (cred) { stopPolling(); void finishAuth('workbuddy', cred) }
          }).catch(e => {
            stopPolling(); setAuth(null); notify(e instanceof Error ? e.message : '授权失败')
          })
        }, 3000)
        pollRef.current = { timer, deadline }
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : '发起授权失败')
    } finally { setBusy('') }
  }

  const claim = async (platform: CheckinPlatform) => {
    setBusy(`claim:${platform}`)
    try {
      const r = await claimCheckin(platform, sessionPwd)
      notify(r.message)
      void refreshStatus(platform)
    } catch (e) {
      notify(e instanceof Error ? e.message : '签到失败')
    } finally { setBusy('') }
  }

  const disconnect = (platform: CheckinPlatform) => {
    clearCheckinCred(platform)
    setCreds(prev => ({ ...prev, [platform]: undefined }))
    setStatuses(prev => ({ ...prev, [platform]: undefined }))
    notify('已断开该平台（本机保存的登录凭据已删除）')
  }

  return (
    <ToolShell title="每日签到" desc="WorkBuddy / MiniMax Code 的每日积分签到：授权一次，每天来点一下领取。凭据加密只存本机。" onBack={onBack}>
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
      <div style={{ display: 'grid', gap: 12 }}>
        {PLATFORMS.map(p => {
          const cred = creds[p.id]
          const st = statuses[p.id]
          const err = errors[p.id]
          const isAuthing = auth?.platform === p.id
          return (
            <div key={p.id} className="ws-checkin-card" style={{ border: '1px solid var(--border)', borderRadius: 14, padding: '14px 16px', background: 'var(--panel)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className={`ws-tico ${p.grad}`}><CalendarCheck size={20} /></span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>{p.name}</div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>{p.desc}</div>
                </div>
                {cred && <span className="ws-tag free">{cred.label}</span>}
              </div>

              {isAuthing && auth && (
                <div className="ws-result" style={{ marginTop: 10 }}>
                  <Loader2 size={14} className="spin" /> {auth.note}
                  {auth.userCode && <div style={{ marginTop: 6 }}>授权码：<b style={{ fontSize: 16, letterSpacing: 2 }}>{auth.userCode}</b>（页面若没自动带上，手动填它）</div>}
                  <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                    <button className="btn sm" onClick={() => void openExternal(auth.authUrl)}>重新打开授权页</button>
                    <button className="btn sm ghost" onClick={() => { stopPolling(); setAuth(null) }}>取消</button>
                  </div>
                </div>
              )}

              {!cred && !isAuthing && (
                <div style={{ marginTop: 10 }}>
                  <button className="btn primary" disabled={!sessionPwd || busy === `auth:${p.id}`} onClick={() => void startAuth(p.id)}>
                    {busy === `auth:${p.id}` ? <Loader2 size={15} className="spin" /> : <LogIn size={15} />} 连接账号
                  </button>
                  <span style={{ marginLeft: 10, fontSize: 12.5, color: 'var(--text-3)' }}>会打开浏览器让你登录确认，只需一次</span>
                </div>
              )}

              {cred && !isAuthing && (
                <div style={{ marginTop: 10 }}>
                  {err && <div className="ws-result" style={{ color: 'var(--danger, #d33)' }}>状态查询失败：{err}</div>}
                  {st && (
                    <div style={{ fontSize: 13.5 }}>
                      <Sparkles size={14} style={{ verticalAlign: -2 }} /> {st.message}
                      {st.streakDays > 0 && <span style={{ color: 'var(--text-3)' }}> · 已连签 {st.streakDays} 天</span>}
                      {typeof st.balance === 'number' && <span style={{ color: 'var(--text-3)' }}> · 剩余积分 {Math.round(st.balance)}</span>}
                    </div>
                  )}
                  {st?.days && st.days.length > 0 && (
                    <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                      {st.days.map(d => (
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
                    {st?.state === 'claimable' && (
                      <button className="btn primary" disabled={busy === `claim:${p.id}`} onClick={() => void claim(p.id)}>
                        {busy === `claim:${p.id}` ? <Loader2 size={15} className="spin" /> : <CalendarCheck size={15} />} 立即签到{st.points ? ` +${st.points}` : ''}
                      </button>
                    )}
                    <button className="btn" disabled={busy === `status:${p.id}`} onClick={() => void refreshStatus(p.id)}>
                      {busy === `status:${p.id}` ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />} 刷新状态
                    </button>
                    <button className="btn ghost" onClick={() => disconnect(p.id)}><LogOut size={15} /> 断开</button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.7, marginTop: 14 }}>
        说明：签到走各平台客户端同款接口（非公开接口，平台调整后可能失效，失效时这里会如实报错）；
        登录凭据用保险箱主密码加密、只存这台设备，不随云同步走。自动代签到存在平台风控可能，本工具只做手动领取，风险请自行评估。
        做法参考了开源项目 CheckinBox-Tools 的公开协议行为，代码为独立实现。
      </p>
    </ToolShell>
  )
}
