import { useCallback, useEffect, useRef, useState } from 'react'
import { CalendarCheck, Fingerprint, Loader2, LogOut, RefreshCw, Sparkles, UserPlus } from 'lucide-react'
import { ToolShell } from './WorkshopView'
import { openExternal, biometricAvailable } from '../core/openExternal'
import { resolveBiometricVaultPassword } from '../core/biometric'
import {
  minimaxBeginDevice, minimaxPollDevice,
  type MinimaxDeviceFlow,
} from '../core/checkin'
import {
  migrateLegacyWorkbuddyCred, poolAccountStatuses, poolClaimOne, listPoolMeta,
  type PoolAccountStatus,
} from '../core/wbPool'
import {
  migrateLegacyMinimaxCred, listMmMeta, addMmAccount, removeMmAccount,
  mmAccountStatuses, mmClaimOne, type MmAccountStatus,
} from '../core/mmPool'
import { getAutoCheckinEnabled, setAutoCheckinEnabled, readLastCheckinRun, summarizeCheckinRun, recordCheckinOutcome, type CheckinRun } from '../core/checkinRun'

/**
 * 每日签到工具页（v0.1.356 上线；359 WorkBuddy 走账号池；363 MiniMax 改多账号）：
 * 两个平台都是多账号——逐个查状态、可逐个签或全部签。
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
  const [autoOn, setAutoOn] = useState(() => getAutoCheckinEnabled())
  const [poolStatuses, setPoolStatuses] = useState<PoolAccountStatus[]>([])
  const [mmStatuses, setMmStatuses] = useState<MmAccountStatus[]>([])
  const [mmAuth, setMmAuth] = useState<{ authUrl: string; userCode: string } | null>(null)
  const [lastRun, setLastRun] = useState<CheckinRun | null>(() => readLastCheckinRun())
  const [busy, setBusy] = useState('')
  const [wbOpen, setWbOpen] = useState<boolean | null>(null)
  const [mmOpen, setMmOpen] = useState<boolean | null>(null)
  const pollRef = useRef<number | null>(null)

  useEffect(() => { void biometricAvailable().then(setBioOk).catch(() => setBioOk(false)) }, [])
  const bioUnlock = async () => {
    const pwd = await resolveBiometricVaultPassword('验证身份以解锁保险箱')
    if (pwd) onUnlock(pwd)
    else notify('未通过指纹验证，或还没开启指纹解锁（先输一次主密码，并在设置里开启指纹/生物解锁后再用）')
  }

  const refreshPool = useCallback(async () => {
    setBusy('wb-status')
    try { setPoolStatuses(await poolAccountStatuses(sessionPwd)) } finally { setBusy('') }
  }, [sessionPwd])

  const refreshMm = useCallback(async () => {
    setBusy('mm-status')
    try { setMmStatuses(await mmAccountStatuses(sessionPwd)) } finally { setBusy('') }
  }, [sessionPwd])

  useEffect(() => {
    if (!sessionPwd) return
    let dead = false
    void (async () => {
      await migrateLegacyWorkbuddyCred(sessionPwd).catch(() => false)
      await migrateLegacyMinimaxCred(sessionPwd).catch(() => false)
      if (dead) return
      if (listPoolMeta().length) void refreshPool()
      if (listMmMeta().length) void refreshMm()
    })()
    return () => { dead = true }
  }, [sessionPwd, refreshPool, refreshMm])

  useEffect(() => () => { if (pollRef.current) window.clearInterval(pollRef.current) }, [])

  // 与迷你窗/自动签到同步：窗口重新聚焦、或签到留痕被更新时，自动重查各账号状态
  useEffect(() => {
    if (!sessionPwd) return
    const onWake = () => {
      setLastRun(readLastCheckinRun())
      if (listPoolMeta().length) void refreshPool()
      if (listMmMeta().length) void refreshMm()
    }
    const onStorage = (e: StorageEvent) => { if (e.key === 'acm.checkin.lastRun.v1') onWake() }
    window.addEventListener('focus', onWake)
    window.addEventListener('storage', onStorage)
    window.addEventListener('acm-checkin-done', onWake)
    return () => {
      window.removeEventListener('focus', onWake)
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('acm-checkin-done', onWake)
    }
  }, [sessionPwd, refreshPool, refreshMm])

  // ---------- MiniMax 添加账号（设备码授权） ----------
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
          const meta = await addMmAccount(cred, sessionPwd)
          setMmAuth(null)
          notify(`MiniMax 已添加：${meta.label}`)
          void refreshMm()
        }).catch(e => {
          window.clearInterval(timer); setMmAuth(null)
          notify(e instanceof Error ? e.message : '授权失败')
        })
      }, flow.intervalSecs * 1000)
      pollRef.current = timer
    } catch (e) { notify(e instanceof Error ? e.message : '发起授权失败') } finally { setBusy('') }
  }

  const claimPoolOne = async (id: string, label: string) => {
    setBusy(`wb-claim:${id}`)
    try {
      const r = await poolClaimOne(sessionPwd, id)
      recordCheckinOutcome({ label: `WorkBuddy · ${label}`, outcome: 'claimed', message: r.message, points: r.points })
      notify(`${label}：${r.message}`)
      void refreshPool()
    } catch (e) { notify(e instanceof Error ? e.message : '签到失败') } finally { setBusy('') }
  }

  const claimPoolAll = async () => {
    setBusy('wb-claim-all')
    let done = 0
    for (const s of poolStatuses) {
      if (s.status?.state !== 'claimable') continue
      try {
        const r = await poolClaimOne(sessionPwd, s.meta.id)
        recordCheckinOutcome({ label: `WorkBuddy · ${s.meta.label}`, outcome: 'claimed', message: r.message, points: r.points })
        done++
      } catch { /* 单个失败不阻塞其余 */ }
    }
    notify(done ? `已给 ${done} 个 WorkBuddy 账号签到` : '没有可签到的 WorkBuddy 账号')
    void refreshPool()
    setBusy('')
  }

  const claimMmOne = async (id: string, label: string) => {
    setBusy(`mm-claim:${id}`)
    try {
      const r = await mmClaimOne(sessionPwd, id)
      recordCheckinOutcome({ label: `MiniMax · ${label}`, outcome: 'claimed', message: r.message, points: r.points })
      notify(`${label}：${r.message}`)
      void refreshMm()
    } catch (e) { notify(e instanceof Error ? e.message : '签到失败') } finally { setBusy('') }
  }

  const claimMmAll = async () => {
    setBusy('mm-claim-all')
    let done = 0
    for (const s of mmStatuses) {
      if (s.status?.state !== 'claimable') continue
      try {
        const r = await mmClaimOne(sessionPwd, s.meta.id)
        recordCheckinOutcome({ label: `MiniMax · ${s.meta.label}`, outcome: 'claimed', message: r.message, points: r.points })
        done++
      } catch { /* 单个失败不阻塞其余 */ }
    }
    notify(done ? `已给 ${done} 个 MiniMax 账号签到` : '没有可签到的 MiniMax 账号')
    void refreshMm()
    setBusy('')
  }

  const wbClaimable = poolStatuses.filter(s => s.status?.state === 'claimable').length
  const mmClaimable = mmStatuses.filter(s => s.status?.state === 'claimable').length
  const wbDone = poolStatuses.filter(s => s.status?.state === 'claimed').length
  const mmDone = mmStatuses.filter(s => s.status?.state === 'claimed').length
  const wbShowList = wbOpen ?? (wbClaimable > 0 || poolStatuses.some(x => x.error))
  const mmShowList = mmOpen ?? (mmClaimable > 0 || mmStatuses.some(x => x.error) || !!mmAuth)
  const aggText = (total: number, done: number, claimable: number) =>
    !total ? '' : claimable > 0 ? `${total} 个账号 · ${claimable} 个待签到` : done === total ? `${total} 个账号 · 今日全部已签 ✓` : `${total} 个账号 · 已签 ${done}`

  return (
    <ToolShell title="每日签到" desc="WorkBuddy（账号池）/ MiniMax Code 的每日积分签到，两个平台都支持多账号。凭据加密只存本机。" onBack={onBack}>
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
          <span style={{ fontSize: 12.5, color: 'var(--text-3)', marginLeft: 8 }}>开着时，App 运行且保险箱解锁后每天自动把所有账号签一遍（结果在菜单栏迷你窗能看到）；App 没运行或保险箱没解锁时不会执行，解锁后会补上。</span>
        </div>
        <button className="btn sm" onClick={() => { const v = !autoOn; setAutoOn(v); setAutoCheckinEnabled(v); notify(v ? '自动签到已开启' : '自动签到已关闭') }}>
          {autoOn ? '已开启' : '已关闭'}
        </button>
      </div>

      {lastRun && (
        <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginBottom: 12, padding: '0 4px' }}>
          最近一次签到：{new Date(lastRun.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {summarizeCheckinRun(lastRun)}（菜单栏一键签到、自动签到都会记在这里）
        </div>
      )}

      {/* WorkBuddy：账号池 */}
      <div style={{ border: '1px solid var(--border)', borderRadius: 14, padding: '14px 16px', background: 'var(--panel)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="ws-tico g2"><CalendarCheck size={20} /></span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>WorkBuddy（账号池）</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>{aggText(poolStatuses.length, wbDone, wbClaimable) || '池里每个账号每天 100 积分，在工坊「WorkBuddy 账号池」里添加/管理账号'}</div>
          </div>
          {poolStatuses.length > 1 && (
            <button className="btn sm ghost" onClick={() => setWbOpen(!wbShowList)}>{wbShowList ? '收起' : '展开'}</button>
          )}
          {poolStatuses.length > 0 && (
            <button className="btn sm" disabled={!sessionPwd || busy === 'wb-status'} onClick={() => void refreshPool()}>
              {busy === 'wb-status' ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} 刷新
            </button>
          )}
          {wbClaimable > 0 && (
            <button className="btn sm primary" disabled={busy === 'wb-claim-all'} onClick={() => void claimPoolAll()}>
              {busy === 'wb-claim-all' ? <Loader2 size={14} className="spin" /> : <CalendarCheck size={14} />} 全部签到（{wbClaimable}）
            </button>
          )}
        </div>
        {poolStatuses.length === 0 && (
          <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 10 }}>
            {sessionPwd ? '账号池还是空的：去工坊主页打开「WorkBuddy 账号池」，添加账号后回到这里就能逐个签到。' : '解锁后显示池里账号的签到状态。'}
          </div>
        )}
        {wbShowList && (
          <div style={{ marginTop: 6 }}>
            {poolStatuses.map(s => (
              <div key={s.meta.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 2px', borderTop: '1px solid var(--border)' }}>
                <span style={{ flexShrink: 0, fontSize: 11, padding: '1px 8px', borderRadius: 999, background: 'var(--panel-2)', color: s.error ? 'var(--danger, #d33)' : s.status?.state === 'claimable' ? 'var(--accent, #6c5ce7)' : 'var(--text-3)' }}>
                  {s.error ? '异常' : s.status?.state === 'claimable' ? '待签到' : s.status?.state === 'claimed' ? '已签 ✓' : '…'}
                </span>
                <b style={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '38%' }}>{s.meta.label}</b>
                <span style={{ fontSize: 12, color: s.error ? 'var(--danger, #d33)' : 'var(--text-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {s.error ? s.error : s.status ? `${s.status.message}${s.status.streakDays > 0 ? ` · 连签 ${s.status.streakDays} 天` : ''}` : '状态加载中…'}
                </span>
                {s.status?.state === 'claimable' && (
                  <button className="btn sm primary" style={{ marginLeft: 'auto', flexShrink: 0 }} disabled={busy === `wb-claim:${s.meta.id}`} onClick={() => void claimPoolOne(s.meta.id, s.meta.label)}>
                    {busy === `wb-claim:${s.meta.id}` ? <Loader2 size={14} className="spin" /> : <CalendarCheck size={14} />} 签到{s.status.points ? ` +${s.status.points}` : ''}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* MiniMax：多账号 */}
      <div style={{ border: '1px solid var(--border)', borderRadius: 14, padding: '14px 16px', background: 'var(--panel)', marginTop: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="ws-tico g3"><CalendarCheck size={20} /></span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>MiniMax Code（多账号）</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>{aggText(mmStatuses.length, mmDone, mmClaimable) || '每个账号每日签到基础 400 积分，第 4 / 7 天 1,000'}</div>
          </div>
          {mmStatuses.length > 1 && (
            <button className="btn sm ghost" onClick={() => setMmOpen(!mmShowList)}>{mmShowList ? '收起' : '展开'}</button>
          )}
          <button className="btn sm" disabled={!sessionPwd || busy === 'mm-auth' || !!mmAuth} onClick={() => void startMmAuth()}>
            {busy === 'mm-auth' ? <Loader2 size={14} className="spin" /> : <UserPlus size={14} />} 添加账号
          </button>
          {mmStatuses.length > 0 && (
            <button className="btn sm" disabled={!sessionPwd || busy === 'mm-status'} onClick={() => void refreshMm()}>
              {busy === 'mm-status' ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} 刷新
            </button>
          )}
          {mmClaimable > 0 && (
            <button className="btn sm primary" disabled={busy === 'mm-claim-all'} onClick={() => void claimMmAll()}>
              {busy === 'mm-claim-all' ? <Loader2 size={14} className="spin" /> : <CalendarCheck size={14} />} 全部签到（{mmClaimable}）
            </button>
          )}
        </div>

        {mmAuth && (
          <div className="ws-result" style={{ marginTop: 10 }}>
            <Loader2 size={14} className="spin" /> 在浏览器里确认授权（约 5 分钟内有效），本页会自动完成添加。要加另一个号，先在浏览器里切换成那个账号再确认。
            <div style={{ marginTop: 6 }}>授权码：<b style={{ fontSize: 16, letterSpacing: 2 }}>{mmAuth.userCode}</b>（页面若没自动带上，手动填它）</div>
            <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
              <button className="btn sm" onClick={() => void openExternal(mmAuth.authUrl)}>重新打开授权页</button>
              <button className="btn sm ghost" onClick={() => { if (pollRef.current) window.clearInterval(pollRef.current); setMmAuth(null) }}>取消</button>
            </div>
          </div>
        )}

        {mmStatuses.length === 0 && !mmAuth && (
          <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 10 }}>
            {sessionPwd ? '还没有 MiniMax 账号：点右上「添加账号」，在浏览器登录确认即可；多个号就重复添加（每次换号登录）。' : '解锁后显示各账号的签到状态。'}
          </div>
        )}

        {mmShowList && (
          <div style={{ marginTop: 6 }}>
            {mmStatuses.map(s => (
              <div key={s.meta.id} style={{ padding: '7px 2px', borderTop: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ flexShrink: 0, fontSize: 11, padding: '1px 8px', borderRadius: 999, background: 'var(--panel-2)', color: s.error ? 'var(--danger, #d33)' : s.status?.state === 'claimable' ? 'var(--accent, #6c5ce7)' : 'var(--text-3)' }}>
                    {s.error ? '异常' : s.status?.state === 'claimable' ? '待签到' : s.status?.state === 'claimed' ? '已签 ✓' : '…'}
                  </span>
                  <b style={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '34%' }}>{s.meta.label}</b>
                  <span style={{ fontSize: 12, color: s.error ? 'var(--danger, #d33)' : 'var(--text-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {s.error ? s.error : s.status ? <><Sparkles size={11} style={{ verticalAlign: -1 }} /> {s.status.message}{s.status.streakDays > 0 ? ` · 连签 ${s.status.streakDays} 天` : ''}{typeof s.status.balance === 'number' ? ` · 剩余 ${Math.round(s.status.balance)}` : ''}</> : '状态加载中…'}
                  </span>
                  {s.status?.state === 'claimable' && (
                    <button className="btn sm primary" style={{ marginLeft: 'auto', flexShrink: 0 }} disabled={busy === `mm-claim:${s.meta.id}`} onClick={() => void claimMmOne(s.meta.id, s.meta.label)}>
                      {busy === `mm-claim:${s.meta.id}` ? <Loader2 size={14} className="spin" /> : <CalendarCheck size={14} />} 签到{s.status.points ? ` +${s.status.points}` : ''}
                    </button>
                  )}
                  <button className="btn sm ghost" style={{ flexShrink: 0 }} onClick={() => { removeMmAccount(s.meta.id); void refreshMm(); notify('已移除该 MiniMax 账号（本机凭据已删除）') }}>
                    <LogOut size={14} /> 移除
                  </button>
                </div>
                {s.status?.days && s.status.days.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                    {s.status.days.map(d => (
                      <span key={d.dayNo} style={{
                        fontSize: 11, padding: '2px 7px', borderRadius: 999,
                        border: d.isToday ? '1.5px solid var(--accent, #6c5ce7)' : '1px solid var(--border)',
                        opacity: d.claimed ? 1 : 0.75, background: d.claimed ? 'var(--panel-2)' : 'transparent',
                      }}>
                        第{d.dayNo}天 · {d.points}{d.claimed ? ' ✓' : d.isToday ? ' · 今天' : ''}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <p style={{ fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.7, marginTop: 14 }}>
        说明：签到走各平台客户端同款接口（非公开接口，平台调整后可能失效，失效时这里会如实报错）；
        登录凭据用保险箱主密码加密、只存这台设备，不随云同步走。自动签到同样基于这套凭据，平台风控风险请自行评估。
        做法参考了开源项目 CheckinBox-Tools 与 dsh-xdpool 的公开协议行为，代码为独立实现。
      </p>
    </ToolShell>
  )
}
