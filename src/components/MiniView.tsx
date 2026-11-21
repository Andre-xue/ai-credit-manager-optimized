import { useCallback, useEffect, useMemo, useState } from 'react'
import { latestQuota, loadState, todayISO } from '../core/store'
import { predictExhaustion } from '../core/forecast'
import { CHECKIN_TOOLS } from '../data/agentTools'
import { PROVIDER_MAP } from '../data/providers'
import type { AppState } from '../core/types'
import { t } from '../core/i18n'

/**
 * 菜单栏迷你窗（桌面端专用，独立窗口 #/mini）：
 * 读本机已保存状态（主窗口每次变更都会落盘，storage 事件可实时感知），
 * 展示今日待签到与各账户剩余额度，动作按钮通过 Rust 命令唤起主窗口对应页签。
 * 样式用内联 + 自带明暗调色板，不依赖主应用的 CSS 变量作用域。
 */

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
function tauriInvoke(): InvokeFn | undefined {
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke?: InvokeFn } }
  return w.__TAURI_INTERNALS__?.invoke
}

export function MiniView() {
  const [state, setState] = useState<AppState>(() => loadState())
  const [updatedAt, setUpdatedAt] = useState(() => new Date())
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)

  const refresh = useCallback(() => {
    setState(loadState())
    setUpdatedAt(new Date())
  }, [])

  useEffect(() => {
    // 主窗口落盘变更（storage 事件）/ 迷你窗重新聚焦 / 定时，三路刷新
    const onStorage = () => refresh()
    const onFocus = () => refresh()
    window.addEventListener('storage', onStorage)
    window.addEventListener('focus', onFocus)
    const t = window.setInterval(refresh, 30_000)
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onMq = () => setSystemDark(mq.matches)
    mq.addEventListener('change', onMq)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('focus', onFocus)
      window.clearInterval(t)
      mq.removeEventListener('change', onMq)
    }
  }, [refresh])

  const themePref = state.settings.theme ?? 'system'
  const dark = themePref === 'dark' || (themePref === 'system' && systemDark)

  const pending = useMemo(
    () => CHECKIN_TOOLS.filter((t) => !state.checkins.some((c) => c.providerId === t.id && c.date === todayISO() && c.done)),
    [state],
  )
  const balances = useMemo(
    () =>
      state.accounts
        .map((a) => {
          const q = latestQuota(state.quotas, a.id)
          if (!q || q.unit !== 'currency') return null
          const remaining = Math.max(0, q.total - q.used)
          const fc = predictExhaustion(state, a.id)
          return {
            id: a.id, name: a.label || PROVIDER_MAP[a.providerId]?.name || a.providerId, remaining,
            low: remaining < (state.settings.lowBalanceThreshold ?? 10),
            daysLeft: fc.level !== 'insufficient' ? fc.daysLeft : undefined,
          }
        })
        .filter((x): x is NonNullable<typeof x> => !!x)
        .sort((x, y) => y.remaining - x.remaining),
    [state],
  )
  const totalRemaining = balances.reduce((s, b) => s + b.remaining, 0)

  const invoke = tauriInvoke()
  const goMain = (section?: string) => void invoke?.('show_main', { section: section ?? null })
  const hide = () => void invoke?.('mini_hide')
  const quit = () => void invoke?.('quit_app')

  const c = dark
    ? { bg: '#14161c', card: '#1d2027', border: '#2a2e38', text: '#e8eaee', sub: '#9aa1ad', faint: '#6b7280' }
    : { bg: '#ffffff', card: '#f6f6f8', border: '#e7e7ea', text: '#191a1e', sub: '#5f6368', faint: '#9aa0a6' }
  const card: React.CSSProperties = { background: c.card, border: `1px solid ${c.border}`, borderRadius: 14, padding: '12px 14px' }
  const btn: React.CSSProperties = { border: `1px solid ${c.border}`, background: c.card, color: c.text, borderRadius: 10, padding: '7px 10px', fontSize: 12.5, cursor: 'pointer' }
  const fmt = (n: number) => n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })

  return (
    <div
      onMouseEnter={() => void invoke?.('mini_hover', { inside: true })}
      onMouseLeave={() => void invoke?.('mini_hover', { inside: false })}
      onPointerDownCapture={() => void invoke?.('mini_interacted')}
      onKeyDownCapture={() => void invoke?.('mini_interacted')}
      style={{ minHeight: '100vh', background: c.bg, color: c.text, padding: 14, display: 'flex', flexDirection: 'column', gap: 10, fontFamily: '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 26, height: 26, borderRadius: 8, background: 'linear-gradient(135deg,#6d28d9,#9333ea)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 14 }}>✦</span>
        <b style={{ fontSize: 14 }}>{t('AI 积分管家')}</b>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: c.faint }}>{t('更新于 {time}', { time: updatedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) })}</span>
        <button onClick={hide} title={t('收起')} style={{ ...btn, padding: '2px 8px', fontSize: 13 }}>×</button>
      </div>

      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 24, fontWeight: 700, color: pending.length ? '#d97706' : '#16a34a' }}>{pending.length}</span>
          <span style={{ fontSize: 12.5, color: c.sub }}>{t('个工具今日待签到')}</span>
          <button onClick={() => goMain('checkin')} style={{ ...btn, marginLeft: 'auto', background: 'linear-gradient(135deg,#6d28d9,#9333ea)', color: '#fff', border: 'none', fontWeight: 600 }}>{t('去签到')}</button>
        </div>
        {pending.length > 0 && (
          <div style={{ marginTop: 6, fontSize: 12, color: c.sub, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {pending.slice(0, 6).map((tool) => tool.name).join(' · ')}{pending.length > 6 ? ` ${t('等 {count} 个', { count: pending.length })}` : ''}
          </div>
        )}
      </div>

      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 12.5, color: c.sub }}>{t('剩余额度合计')}</span>
          <b style={{ fontSize: 17 }}>¥{fmt(totalRemaining)}</b>
        </div>
        <div style={{ marginTop: 8, display: 'grid', gap: 5 }}>
          {balances.slice(0, 5).map((b) => (
            <div key={b.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 12.5, gap: 8 }}>
              <span style={{ color: c.sub, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{b.name}</span>
              <span style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                <b style={b.low ? { color: '#dc2626' } : undefined}>¥{fmt(b.remaining)}</b>
                {b.daysLeft !== undefined && b.daysLeft <= 60 && (
                  <span style={{ display: 'block', fontSize: 10.5, color: b.daysLeft <= 7 ? '#dc2626' : c.faint }}>{t('约 {days} 天后耗尽', { days: Math.max(0, Math.ceil(b.daysLeft)) })}</span>
                )}
              </span>
            </div>
          ))}
          {balances.length === 0 && <div style={{ fontSize: 12, color: c.faint }}>{t('暂无额度数据，去主窗口添加账户或刷新余额')}</div>}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
        <button onClick={() => goMain('ai')} style={{ ...btn, flex: 1 }}>{t('AI 助手')}</button>
        <button onClick={() => goMain()} style={{ ...btn, flex: 1 }}>{t('打开主界面')}</button>
        <button onClick={quit} style={{ ...btn, flex: 1 }}>{t('退出应用')}</button>
      </div>
    </div>
  )
}
