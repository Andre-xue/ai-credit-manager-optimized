// 额度日历：月历上标注签到、用量与额度重置/到期日，点某天看明细。
import { useMemo, useState } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'
import type { AppState } from '../core/types'
import { buildCalendarMonth, checkinHeatmap, checkinStreak, monthGrid, shiftMonth } from '../core/calendar'
import { predictExhaustion } from '../core/forecast'
import { buildICalendar } from '../core/ical'
import { saveExportFile } from '../core/saveFile'
import { buildAchievements } from '../core/achievements'

const WEEK = ['一', '二', '三', '四', '五', '六', '日']

export function CalendarView({ state }: { state: AppState }) {
  const now = new Date()
  const curMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const today = `${curMonth}-${String(now.getDate()).padStart(2, '0')}`
  const [month, setMonth] = useState(curMonth)
  const [exportNote, setExportNote] = useState('')
  const [selected, setSelected] = useState<string>(today)

  const cal = useMemo(() => buildCalendarMonth(state, month), [state, month])
  const cells = useMemo(() => monthGrid(month), [month])
  const sel = selected.startsWith(month) ? cal.days.get(selected) : undefined

  const monthCheckinDays = [...cal.days.values()].filter((d) => d.checkins.length > 0).length
  const monthCost = [...cal.days.values()].reduce((s, d) => s + d.cost, 0)

  const streak = useMemo(() => checkinStreak(state, today), [state, today])
  const achievements = useMemo(() => buildAchievements(state, today), [state, today])
  const heat = useMemo(() => checkinHeatmap(state, today, 18), [state, today])
  const heatLead = heat.length ? (new Date(heat[0].date + 'T00:00:00').getDay() + 6) % 7 : 0
  /** 各账户预计耗尽日（按当前消耗速度预测）→ 日期 → 账户名 */
  const exhaustMarks = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const a of state.accounts) {
      const fc = predictExhaustion(state, a.id)
      if (fc.exhaustDate) {
        const arr = m.get(fc.exhaustDate) ?? []
        arr.push(a.label || a.providerId)
        m.set(fc.exhaustDate, arr)
      }
    }
    return m
  }, [state])
  const selExhaust = exhaustMarks.get(selected)

  return (
    <div>
      <div className="section-head">
        <h2><CalendarDays size={17} style={{ verticalAlign: -3, marginRight: 6 }} />额度日历
          <span className="hint">本月签到 {monthCheckinDays} 天 · 用量 ¥{monthCost.toFixed(2)}{streak > 0 ? ` · 🔥 连续签到 ${streak} 天` : ''}</span>
        </h2>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn sm ghost" onClick={() => setMonth((m) => shiftMonth(m, -1))}><ChevronLeft size={14} /></button>
          <b style={{ fontSize: 13.5, minWidth: 74, textAlign: 'center' }}>{month.replace('-', ' 年 ')} 月</b>
          <button className="btn sm ghost" onClick={() => setMonth((m) => shiftMonth(m, 1))}><ChevronRight size={14} /></button>
          {month !== curMonth && <button className="btn sm" onClick={() => { setMonth(curMonth); setSelected(today) }}>回到本月</button>}
          <button className="btn sm" title="把未来 90 天的额度重置/到期日 + 每日签到提醒导出为 .ics 文件，可导入手机/电脑自带日历" onClick={async () => {
            const r = await saveExportFile(`AI积分管家日历-${today}.ics`, buildICalendar(state, today))
            if (r.cancelled) return
            setExportNote(r.ok ? `已导出到：${r.where}` : `导出失败：${r.error ?? '未知错误'}`)
            setTimeout(() => setExportNote(''), 5000)
          }}>导出日历</button>
          {exportNote && <span style={{ fontSize: 12, color: 'var(--text-3)', alignSelf: 'center' }}>{exportNote}</span>}
        </div>
      </div>

      <div className="panel cal-panel">
        <div className="cal-week">{WEEK.map((w) => <span key={w}>周{w}</span>)}</div>
        <div className="cal-grid">
          {cells.map((date, i) => {
            if (!date) return <div key={`e-${i}`} className="cal-cell empty" />
            const d = cal.days.get(date)
            const isToday = date === today
            const isSel = date === selected
            return (
              <button key={date} className={`cal-cell ${isToday ? 'today' : ''} ${isSel ? 'selected' : ''}`} onClick={() => setSelected(date)}>
                <span className="cal-daynum">{Number(date.slice(8))}</span>
                <span className="cal-marks">
                  {d?.checkins.length ? <i className="cal-dot checkin" title="已签到" /> : null}
                  {d?.cost ? <i className="cal-dot usage" title="有用量" /> : null}
                  {d?.resets.length ? <i className="cal-dot reset" title="额度重置/到期" /> : null}
                  {exhaustMarks.get(date)?.length ? <i className="cal-dot exhaust" title="预计额度耗尽" /> : null}
                </span>
                {d?.cost ? <span className="cal-cost">¥{d.cost.toFixed(0)}</span> : null}
              </button>
            )
          })}
        </div>
        <div className="cal-legend">
          <span><i className="cal-dot checkin" /> 已签到</span>
          <span><i className="cal-dot usage" /> 有用量</span>
          <span><i className="cal-dot reset" /> 额度重置/到期</span>
          <span><i className="cal-dot exhaust" /> 预计耗尽</span>
        </div>
      </div>

      <div className="panel" style={{ padding: 16, marginTop: 14 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <b style={{ fontSize: 13.5 }}>签到热力图</b>
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>最近 18 周{streak > 0 ? ` · 🔥 已连续签到 ${streak} 天` : ''}</span>
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-3)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            少 <i className="heat-cell lv0" /><i className="heat-cell lv1" /><i className="heat-cell lv2" /><i className="heat-cell lv3" /><i className="heat-cell lv4" /> 多
          </span>
        </div>
        <div className="heatmap" style={{ marginTop: 10 }}>
          {Array.from({ length: heatLead }).map((_, i) => <i key={`b-${i}`} className="heat-cell blank" />)}
          {heat.map((d) => (
            <i key={d.date} className={`heat-cell lv${Math.min(4, d.count)}`} title={`${d.date} · 签到 ${d.count} 个工具`} />
          ))}
        </div>
      </div>

      <div className="panel" style={{ padding: 16, marginTop: 14 }}>
        <b style={{ fontSize: 13.5 }}>签到成就</b>
        <span style={{ fontSize: 12, color: 'var(--text-3)', marginLeft: 8 }}>已点亮 {achievements.filter((a) => a.earned).length} / {achievements.length} 枚徽章</span>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10, marginTop: 12 }}>
          {achievements.map((a) => (
            <div key={a.id} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: '10px 12px', opacity: a.earned ? 1 : 0.62, background: a.earned ? 'rgba(109,40,217,.07)' : 'transparent' }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{a.earned ? '🏅 ' : '🔒 '}{a.title}</div>
              <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>{a.desc}</div>
              <div style={{ height: 5, borderRadius: 3, background: 'var(--border)', marginTop: 8, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${Math.round((a.current / a.target) * 100)}%`, background: a.earned ? '#16a34a' : 'var(--primary)', borderRadius: 3 }} />
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>{a.current} / {a.target}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="panel" style={{ padding: 16, marginTop: 14 }}>
        <b style={{ fontSize: 13.5 }}>{selected} 明细</b>
        {(!sel || (!sel.checkins.length && !sel.cost && !sel.resets.length)) && !selExhaust?.length
          ? <div style={{ color: 'var(--text-3)', fontSize: 13, marginTop: 8 }}>这一天没有签到、用量或额度事件。</div>
          : <div style={{ marginTop: 8, display: 'grid', gap: 6, fontSize: 13 }}>
              {sel && sel.checkins.length > 0 && <div>✅ 已签到：{sel.checkins.join('、')}</div>}
              {sel && sel.cost > 0 && <div>💰 用量：¥{sel.cost.toFixed(2)} · {sel.tokens.toLocaleString()} Tokens</div>}
              {sel && sel.resets.length > 0 && <div>⏰ 额度重置/到期：{sel.resets.join('、')}</div>}
              {selExhaust && selExhaust.length > 0 && <div>🔻 预计额度耗尽：{selExhaust.join('、')}（按当前消耗速度预测）</div>}
            </div>}
      </div>
    </div>
  )
}
