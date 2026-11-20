// 额度日历：月历上标注签到、用量与额度重置/到期日，点某天看明细。
import { useMemo, useState } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'
import type { AppState } from '../core/types'
import { buildCalendarMonth, monthGrid, shiftMonth } from '../core/calendar'

const WEEK = ['一', '二', '三', '四', '五', '六', '日']

export function CalendarView({ state }: { state: AppState }) {
  const now = new Date()
  const curMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const today = `${curMonth}-${String(now.getDate()).padStart(2, '0')}`
  const [month, setMonth] = useState(curMonth)
  const [selected, setSelected] = useState<string>(today)

  const cal = useMemo(() => buildCalendarMonth(state, month), [state, month])
  const cells = useMemo(() => monthGrid(month), [month])
  const sel = selected.startsWith(month) ? cal.days.get(selected) : undefined

  const monthCheckinDays = [...cal.days.values()].filter((d) => d.checkins.length > 0).length
  const monthCost = [...cal.days.values()].reduce((s, d) => s + d.cost, 0)

  return (
    <div>
      <div className="section-head">
        <h2><CalendarDays size={17} style={{ verticalAlign: -3, marginRight: 6 }} />额度日历
          <span className="hint">本月签到 {monthCheckinDays} 天 · 用量 ¥{monthCost.toFixed(2)}</span>
        </h2>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn sm ghost" onClick={() => setMonth((m) => shiftMonth(m, -1))}><ChevronLeft size={14} /></button>
          <b style={{ fontSize: 13.5, minWidth: 74, textAlign: 'center' }}>{month.replace('-', ' 年 ')} 月</b>
          <button className="btn sm ghost" onClick={() => setMonth((m) => shiftMonth(m, 1))}><ChevronRight size={14} /></button>
          {month !== curMonth && <button className="btn sm" onClick={() => { setMonth(curMonth); setSelected(today) }}>回到本月</button>}
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
        </div>
      </div>

      <div className="panel" style={{ padding: 16, marginTop: 14 }}>
        <b style={{ fontSize: 13.5 }}>{selected} 明细</b>
        {!sel || (!sel.checkins.length && !sel.cost && !sel.resets.length)
          ? <div style={{ color: 'var(--text-3)', fontSize: 13, marginTop: 8 }}>这一天没有签到、用量或额度事件。</div>
          : <div style={{ marginTop: 8, display: 'grid', gap: 6, fontSize: 13 }}>
              {sel.checkins.length > 0 && <div>✅ 已签到：{sel.checkins.join('、')}</div>}
              {sel.cost > 0 && <div>💰 用量：¥{sel.cost.toFixed(2)} · {sel.tokens.toLocaleString()} Tokens</div>}
              {sel.resets.length > 0 && <div>⏰ 额度重置/到期：{sel.resets.join('、')}</div>}
            </div>}
      </div>
    </div>
  )
}
