// 月度报告：选定月份的消费/签到/预算汇总，可复制为文本分享。
import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, ClipboardCopy, FileBarChart } from 'lucide-react'
import type { AppState } from '../core/types'
import { buildMonthlyReport, reportToText } from '../core/monthlyReport'
import { shiftMonth } from '../core/calendar'

export function ReportView({ state, notify }: { state: AppState; notify: (msg: string) => void }) {
  const now = new Date()
  const curMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const [month, setMonth] = useState(curMonth)
  const r = useMemo(() => buildMonthlyReport(state, month), [state, month])

  const copy = async () => {
    try { await navigator.clipboard.writeText(reportToText(r)); notify('报告文本已复制') }
    catch { notify('复制失败，请检查浏览器权限') }
  }

  return (
    <div>
      <div className="section-head">
        <h2><FileBarChart size={17} style={{ verticalAlign: -3, marginRight: 6 }} />月度报告</h2>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn sm ghost" onClick={() => setMonth((m) => shiftMonth(m, -1))}><ChevronLeft size={14} /></button>
          <b style={{ fontSize: 13.5, minWidth: 74, textAlign: 'center' }}>{month.replace('-', ' 年 ')} 月</b>
          <button className="btn sm ghost" disabled={month >= curMonth} onClick={() => setMonth((m) => shiftMonth(m, 1))}><ChevronRight size={14} /></button>
          <button className="btn sm" onClick={() => void copy()}><ClipboardCopy size={13} /> 复制报告</button>
        </div>
      </div>

      <div className="bento-grid">
        <div className="bento-tile">
          <div className="bento-label">总消费</div>
          <div className="bento-num">¥{r.totalCost.toFixed(2)}</div>
          <div className="bento-sub">
            {r.costDeltaPct !== null
              ? `环比上月 ${r.costDeltaPct >= 0 ? '↑' : '↓'} ${Math.abs(r.costDeltaPct * 100).toFixed(0)}%（上月 ¥${r.prevCost.toFixed(2)}）`
              : `上月 ¥${r.prevCost.toFixed(2)}`}
          </div>
        </div>
        <div className="bento-tile">
          <div className="bento-label">总 Tokens</div>
          <div className="bento-num">{r.totalTokens.toLocaleString()}</div>
          <div className="bento-sub">{r.recordCount} 条记录 · 活跃 {r.activeDays} 天</div>
        </div>
        <div className="bento-tile">
          <div className="bento-label">签到</div>
          <div className="bento-num">{r.checkinCount} 次</div>
          <div className="bento-sub">覆盖 {r.checkinDays} 天</div>
        </div>
        <div className="bento-tile">
          <div className="bento-label">预算使用</div>
          <div className="bento-num">{r.budgetRate !== null ? `${(r.budgetRate * 100).toFixed(0)}%` : '未设置'}</div>
          <div className="bento-sub">{r.budgetRate !== null ? `月预算 ¥${r.budget.toFixed(0)}` : '在用量页或设置里设置月预算'}</div>
        </div>
      </div>

      <div className="section-head"><h2>分平台消费</h2></div>
      <div className="panel" style={{ padding: 18 }}>
        {r.byPlatform.length === 0
          ? <div style={{ color: 'var(--text-3)', fontSize: 13 }}>这个月暂无用量记录</div>
          : r.byPlatform.map((p) => (
            <div key={p.providerId} style={{ marginBottom: 13 }}>
              <div className="row between" style={{ fontSize: 12.5, marginBottom: 6 }}>
                <span style={{ fontWeight: 500 }}>{p.name}</span>
                <span style={{ color: 'var(--text-2)' }}>¥{p.cost.toFixed(2)} · {(p.share * 100).toFixed(0)}% · {p.tokens.toLocaleString()} Tokens</span>
              </div>
              <div className="progress"><div style={{ width: `${Math.max(2, p.share * 100)}%`, background: 'var(--primary)' }} /></div>
            </div>
          ))}
      </div>

      {r.topModels.length > 0 && <>
        <div className="section-head"><h2>模型消费 Top</h2></div>
        <div className="panel" style={{ padding: 18 }}>
          {r.topModels.map((m) => (
            <div key={m.model} className="row between" style={{ fontSize: 13, padding: '5px 0' }}>
              <span className="mono">{m.model}</span>
              <span style={{ color: 'var(--text-2)' }}>¥{m.cost.toFixed(2)} · {m.tokens.toLocaleString()} Tokens</span>
            </div>
          ))}
        </div>
      </>}
    </div>
  )
}
