import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Trophy, RefreshCw, ClipboardCheck } from 'lucide-react'
import type { AgentTask } from '../core/agents'
import {
  agentWorktreeDiff, agentWorktreeMerge, agentWorktreeRemove, type AgentWorktreeDiff,
} from '../core/agentBridge'
import { formatDuration } from '../core/agentVault'

const TERMINAL = ['done', 'failed', 'stopped', 'unresolved']

/** 赛马对比层（v0.1.512 ②）：点开任务卡展开为整个内容区——两版 diff 并排/单看，
 *  附各自的交叉审查结论；点选胜出 → 合并胜出分支、落选自动清理并在卡上留痕。 */
export function AgentRaceCompare({ raceId, tasks, updateTask, notify, onBack }: {
  raceId: string
  tasks: AgentTask[]
  updateTask: (id: string, patch: Partial<AgentTask>) => void
  notify: (m: string, kind?: 'ok' | 'err') => void
  onBack: () => void
}) {
  const pair = useMemo(
    () => tasks.filter(t => t.raceId === raceId).sort((a, b) => (a.raceSlot ?? 'A').localeCompare(b.raceSlot ?? 'A')),
    [tasks, raceId],
  )
  const [mode, setMode] = useState<'split' | 'A' | 'B'>(() => (typeof window !== 'undefined' && window.innerWidth < 900 ? 'A' : 'split'))
  const [diffs, setDiffs] = useState<Record<string, AgentWorktreeDiff | null>>({})
  const [diffErr, setDiffErr] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [mergeError, setMergeError] = useState('')
  const decided = pair.some(t => t.raceOutcome)

  const loadDiffs = async () => {
    for (const t of pair) {
      if (!t.raceWorktree) continue
      try {
        const d = await agentWorktreeDiff(t.raceWorktree)
        setDiffs(prev => ({ ...prev, [t.id]: d }))
        setDiffErr(prev => ({ ...prev, [t.id]: '' }))
      } catch (e) {
        setDiffs(prev => ({ ...prev, [t.id]: null }))
        setDiffErr(prev => ({ ...prev, [t.id]: e instanceof Error ? e.message : String(e) }))
      }
    }
  }
  useEffect(() => { void loadDiffs() }, [raceId]) // eslint-disable-line react-hooks/exhaustive-deps

  const pickWinner = async (winner: AgentTask, loser: AgentTask) => {
    if (!winner.raceRepo || !winner.raceBranch || !winner.raceWorktree || !loser.raceWorktree || !loser.raceBranch) {
      setMergeError('赛马工作区信息不完整，没法合并：请到仓库目录里手动处理这两个分支')
      return
    }
    setBusy(true)
    setMergeError('')
    try {
      await agentWorktreeMerge(winner.raceRepo, winner.raceBranch)
    } catch (e) {
      // 合并没成：什么都不清，两个工作区原样保留，用户处理完可再点
      setMergeError(e instanceof Error ? e.message : String(e))
      setBusy(false)
      return
    }
    const r1 = await agentWorktreeRemove(winner.raceRepo, winner.raceWorktree, winner.raceBranch)
    const r2 = await agentWorktreeRemove(winner.raceRepo, loser.raceWorktree, loser.raceBranch)
    const cleanNote = (r: { worktreeRemoved: boolean; branchDeleted: boolean; note: string }) =>
      r.worktreeRemoved && r.branchDeleted ? '工作区与分支已清理' : `清理不完全（${r.note || '请到仓库里手动检查 .acm-worktrees 残留'}）`
    updateTask(winner.id, {
      raceOutcome: 'winner',
      note: `赛马胜出：已合并回主仓库当前分支；${cleanNote(r1)}`,
    })
    updateTask(loser.id, {
      raceOutcome: 'loser',
      note: `赛马落选：${cleanNote(r2)}（它的产出随 worktree 一并清掉，审查结论还留在这张卡上）`,
    })
    notify(`赛马结束：${winner.agentName} 的版本已合并`)
    setBusy(false)
  }

  const side = (t: AgentTask) => {
    const d = diffs[t.id]
    const elapsed = t.startedAt ? (t.endedAt ?? Date.now()) - t.startedAt : 0
    const other = pair.find(x => x.id !== t.id)
    const canPick = !decided && t.status === 'done' && !!t.raceWorktree && !!other
    return (
      <div key={t.id} className="aw-compare-side">
        <div className="aw-compare-side-head">
          <b>版本 {t.raceSlot} · {t.agentName}{t.accountEntryLabel ? ` · ${t.accountEntryLabel}` : ''}</b>
          {t.raceOutcome === 'winner' && <span className="aw-tag ok"><Trophy size={11} /> 胜出（已合并）</span>}
          {t.raceOutcome === 'loser' && <span className="aw-tag off">落选（已清理）</span>}
          {!t.raceOutcome && <span className="aw-note">{t.status === 'done' ? '已完成' : t.status === 'failed' ? '失败' : t.status}{t.startedAt ? ` · ${formatDuration(elapsed)}` : ''}</span>}
        </div>
        {t.raceReview && (
          <div className={`aw-review ${t.raceReview.state}`}>
            <ClipboardCheck size={14} />
            {t.raceReview.state === 'running' && <span>对手审查中（审查者：{t.raceReview.reviewerName}）…</span>}
            {t.raceReview.state === 'pass' && <span>对手审查通过（{t.raceReview.reviewerName}）{t.raceReview.points ? `：${t.raceReview.points}` : ''}</span>}
            {t.raceReview.state === 'issues' && <span>对手审查发现问题（{t.raceReview.reviewerName}）：{t.raceReview.points || '未给出要点'}</span>}
            {t.raceReview.state === 'failed' && <span>对手审查未完成：{t.raceReview.reason}</span>}
          </div>
        )}
        {!t.raceReview && TERMINAL.includes(t.status) && other && TERMINAL.includes(other.status) && (
          <div className="aw-note">交叉审查结论还没回来（在任务卡上也会同步显示）。</div>
        )}
        {diffErr[t.id] && <div className="aw-note warn">这一版的改动明细读不出来：{diffErr[t.id]}</div>}
        {d && (
          <>
            <div className="aw-note">改动文件 {d.changedFiles.length} 个：{d.changedFiles.slice(0, 12).join('、')}{d.changedFiles.length > 12 ? ` 等 ${d.changedFiles.length} 个` : ''}</div>
            {d.stat && <pre className="aw-output aw-diff-pre">{d.stat}</pre>}
            {d.diff
              ? <pre className="aw-output aw-diff-pre tall">{d.diff}</pre>
              : <div className="aw-note">没有相对仓库基线的代码改动。</div>}
          </>
        )}
        {!d && !diffErr[t.id] && t.raceWorktree && <div className="aw-note">改动明细读取中…</div>}
        {!t.raceWorktree && <div className="aw-note">这一版没能建起赛马工作区（见任务卡上的失败原因）。</div>}
        {canPick && (
          <button className="btn primary" disabled={busy} onClick={() => void pickWinner(t, other)}>
            <Trophy size={14} /> 选这一版胜出并合并
          </button>
        )}
      </div>
    )
  }

  const shown = mode === 'split' ? pair : pair.filter(t => t.raceSlot === mode)
  return (
    <div className="aw-card aw-compare">
      <div className="aw-card-head">
        <button className="btn sm ghost" onClick={onBack}><ArrowLeft size={13} /> 回任务板</button>
        <span>赛马对比</span>
        <button className="btn sm" onClick={() => void loadDiffs()}><RefreshCw size={13} /> 刷新改动</button>
      </div>
      {pair[0] && (
        <div className="aw-task-text">{pair[0].title ?? pair[0].text}</div>
      )}
      {pair[0]?.raceRepo && <div className="aw-note">仓库：{pair[0].raceRepo}（两版各在独立 worktree 里并行完成，互不干扰；胜出才合并回主仓库）</div>}
      <div className="aw-seg" role="group" aria-label="对比看法">
        <button className={mode === 'split' ? 'on' : ''} onClick={() => setMode('split')}>并排</button>
        <button className={mode === 'A' ? 'on' : ''} onClick={() => setMode('A')}>只看 A</button>
        <button className={mode === 'B' ? 'on' : ''} onClick={() => setMode('B')}>只看 B</button>
      </div>
      {mergeError && <div className="aw-note warn" style={{ margin: '8px 0' }}>{mergeError}</div>}
      {decided && <div className="aw-note" style={{ margin: '8px 0' }}>赛马已定：胜出版本已合并，落选工作区已清理。下面是当时的改动记录（工作区已删，明细以任务卡与仓库历史为准）。</div>}
      <div className={`aw-compare-grid ${mode === 'split' ? 'split' : 'single'}`}>
        {shown.map(side)}
      </div>
      {pair.length < 2 && <div className="aw-note warn">这一组赛马只剩一件任务了（另一件可能被删掉），没法对比。</div>}
    </div>
  )
}
