// 邮箱工具（v0.1.436，一期，仅桌面端）：统一收件箱 / 全宽阅读 / 账户设置。
// 大厂风格：中性灰阶 + 单一品牌色、扁平卡片、线性图标；交互照预览定案：
// 新邮件滑入高亮、悬停快捷操作、多选批量条、未读徽标、果冻开关。
// 同步方式如实标注：IDLE 实时推送 / 服务器不支持 IDLE 时轮询 / 失败显示服务器原文。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Mail, RefreshCw, Settings, Plus, Trash2, Star, Archive, Search, Lock, X, ChevronLeft, ChevronRight,
  Paperclip, Copy, Sparkles, AlertTriangle, CheckCircle2, Loader2, FolderInput, ShieldCheck,
} from 'lucide-react'
import type { Account } from '../core/types'
import {
  MAIL_PLATFORMS, MAIL_CATEGORIES, MAIL_CATEGORY_LABELS, mailPlatform,
  listMailAccounts, addMailAccount, removeMailAccount,
  loadMailVisibility, saveMailVisibility, isAccountVisible,
  loadMailCache, applyCategoryOverrides, setCategoryOverride,
  mailSyncAccount, mailSetFlag, mailMoveMessages, mailDeleteMessages, mailFetchBody, mailSaveAttachment,
  mailDeleteAllPreview, mailDeleteAll, mailOAuthListenStart, mailOAuthListenResult, mailOAuthExchange,
  mailEnsureConnected, mailCancelConnect, sanitizeMailHtml, buildOAuthUrl,
  displayMailError, shouldSuggestCredentialCheck,
  type MailAccountMeta, type MailMessage, type MailCategory, type MailPlatformId, type MailSecret,
  type MailBodyContent, type MailDeleteAllReport,
} from '../core/mail'
import { loadWorkshopRoutes, runWorkshopChat, type WorkshopRoute, type WorkshopRouteData } from '../core/workshopChat'
import { openExternal } from '../core/openExternal'

function JellyToggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  const [anim, setAnim] = useState<'on' | 'off' | null>(null)
  const prev = useRef(checked)
  useEffect(() => {
    if (prev.current !== checked) {
      setAnim(checked ? 'on' : 'off')
      prev.current = checked
      const t = window.setTimeout(() => setAnim(null), 360)
      return () => window.clearTimeout(t)
    }
  }, [checked])
  return (
    <button role="switch" aria-checked={checked} aria-label={label} title={label}
      onClick={e => { e.stopPropagation(); onChange(!checked) }}
      className={`jelly-toggle ${checked ? 'is-on' : ''}`}>
      <span className={`jelly-dot ${anim ? `anim-${anim}` : (checked ? 'static-on' : 'static-off')}`} />
    </button>
  )
}

function fmtTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return d.toTimeString().slice(0, 5)
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

type SyncState = 'idle' | 'syncing' | 'live' | 'poll' | 'error'
interface AccountSync { state: SyncState; message?: string }

type View = 'inbox' | 'reader' | 'settings' | 'add'
type QuickFilter = 'all' | 'unread' | 'starred' | 'attach'

export function MailTool({ accounts, sessionPwd, onUnlock, notify }: {
  accounts: Account[]
  sessionPwd: string
  onUnlock: (pwd: string) => void
  notify: (msg: string) => void
}) {
  const [view, setView] = useState<View>('inbox')
  const [metas, setMetas] = useState<MailAccountMeta[]>(() => listMailAccounts())
  const [visibility, setVisibility] = useState(loadMailVisibility)
  const [cacheVersion, setCacheVersion] = useState(0)
  const [syncMap, setSyncMap] = useState<Record<string, AccountSync>>({})
  const [accountFilter, setAccountFilter] = useState<string>('all')
  const [category, setCategory] = useState<'all' | MailCategory>('all')
  const [quick, setQuick] = useState<QuickFilter>('all')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [freshKeys, setFreshKeys] = useState<Set<string>>(new Set())
  const [currentKey, setCurrentKey] = useState<string | null>(null)
  const [pwdInput, setPwdInput] = useState('')
  const [deleteAllOpen, setDeleteAllOpen] = useState(false)
  const syncingRef = useRef<Set<string>>(new Set())
  const pwd = sessionPwd

  const cache = useMemo(() => loadMailCache(), [cacheVersion])
  const refreshCache = useCallback(() => setCacheVersion(v => v + 1), [])

  const visibleMetas = useMemo(() => metas.filter(a => isAccountVisible(visibility, a)), [metas, visibility])
  const allMessages = useMemo(() => {
    const list: MailMessage[] = []
    for (const a of visibleMetas) {
      const entry = cache[a.id]
      if (entry) list.push(...entry.messages)
    }
    return applyCategoryOverrides(list).sort((x, y) => y.date - x.date)
  }, [cache, visibleMetas])

  const unreadByAccount = useMemo(() => {
    const map: Record<string, number> = {}
    for (const m of allMessages) if (!m.flags.includes('\\Seen')) map[m.accountId] = (map[m.accountId] ?? 0) + 1
    return map
  }, [allMessages])

  const filtered = useMemo(() => {
    let list = allMessages
    if (accountFilter !== 'all') list = list.filter(m => m.accountId === accountFilter)
    if (category !== 'all') list = list.filter(m => m.category === category)
    if (quick === 'unread') list = list.filter(m => !m.flags.includes('\\Seen'))
    if (quick === 'starred') list = list.filter(m => m.flags.includes('\\Flagged'))
    if (quick === 'attach') list = list.filter(m => m.hasAttach)
    const q = query.trim().toLowerCase()
    if (q) list = list.filter(m => `${m.subject} ${m.from} ${m.fromAddr} ${m.snippet}`.toLowerCase().includes(q))
    return list
  }, [allMessages, accountFilter, category, quick, query])

  const categoryCounts = useMemo(() => {
    const base = accountFilter === 'all' ? allMessages : allMessages.filter(m => m.accountId === accountFilter)
    const counts: Record<string, number> = { all: base.length }
    for (const c of MAIL_CATEGORIES) counts[c] = base.filter(m => m.category === c).length
    return counts
  }, [allMessages, accountFilter])

  const syncOne = useCallback(async (account: MailAccountMeta, silent = false) => {
    if (!pwd || syncingRef.current.has(account.id)) return
    syncingRef.current.add(account.id)
    setSyncMap(prev => ({ ...prev, [account.id]: { state: 'syncing' } }))
    const outcome = await mailSyncAccount(account, pwd)
    syncingRef.current.delete(account.id)
    if (outcome.ok) {
      setSyncMap(prev => ({ ...prev, [account.id]: { state: outcome.idleSupported ? 'live' : 'poll' } }))
      if (outcome.newKeys.length) {
        setFreshKeys(prev => new Set([...prev, ...outcome.newKeys]))
        if (!silent) notify(`「${account.email}」收到 ${outcome.newKeys.length} 封新邮件`)
        window.setTimeout(() => {
          setFreshKeys(prev => { const next = new Set(prev); for (const k of outcome.newKeys) next.delete(k); return next })
        }, 8000)
      }
    } else {
      setSyncMap(prev => ({ ...prev, [account.id]: { state: 'error', message: outcome.error } }))
      if (!silent) notify(`「${account.email}」同步失败：${outcome.error}`)
    }
    refreshCache()
  }, [pwd, notify, refreshCache])

  const syncAll = useCallback((silent = false) => {
    for (const a of visibleMetas) void syncOne(a, silent)
  }, [visibleMetas, syncOne])

  // 进入工具/解锁后：同步全部可见账户
  useEffect(() => {
    if (pwd && visibleMetas.length) syncAll(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pwd, metas.length])

  // IDLE 事件：新邮件/变化 → 增量同步；状态如实回告
  useEffect(() => {
    if (!pwd) return
    let unlisten: (() => void) | undefined
    let dead = false
    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        const un = await listen<{ accountId: string; kind: string; message?: string }>('mail_idle', event => {
          const p = event.payload
          const account = metas.find(a => a.id === p.accountId)
          if (!account) return
          if (p.kind === 'newmail' || p.kind === 'changed' || p.kind === 'tick') void syncOne(account)
          else if (p.kind === 'connected') setSyncMap(prev => ({ ...prev, [p.accountId]: { state: 'live' } }))
          else if (p.kind === 'unsupported') setSyncMap(prev => ({ ...prev, [p.accountId]: { state: 'poll' } }))
          else if (p.kind === 'error') setSyncMap(prev => ({ ...prev, [p.accountId]: { state: 'error', message: p.message } }))
          else if (p.kind === 'reconnecting') setSyncMap(prev => ({ ...prev, [p.accountId]: { state: 'syncing' } }))
        })
        if (dead) un()
        else unlisten = un
      } catch { /* 网页环境无事件通道：靠手动刷新与轮询 */ }
    })()
    return () => { dead = true; unlisten?.() }
  }, [pwd, metas, syncOne])

  // 轮询兜底：状态为 poll 的账户每 3 分钟同步一次
  useEffect(() => {
    const t = window.setInterval(() => {
      for (const a of visibleMetas) if (syncMap[a.id]?.state === 'poll') void syncOne(a, true)
    }, 180_000)
    return () => window.clearInterval(t)
  }, [visibleMetas, syncMap, syncOne])

  const aggregate = useMemo((): { text: string; cls: string } => {
    const states = visibleMetas.map(a => syncMap[a.id]?.state ?? 'idle')
    if (!visibleMetas.length) return { text: '未添加账户', cls: 'off' }
    if (states.some(s => s === 'syncing')) return { text: '同步中…', cls: 'busy' }
    if (states.some(s => s === 'error')) return { text: '部分账户同步失败', cls: 'err' }
    if (states.every(s => s === 'live')) return { text: '已连接 · 实时推送', cls: 'ok' }
    if (states.some(s => s === 'poll')) return { text: '已连接 · 轮询同步', cls: 'ok' }
    return { text: '已连接', cls: 'ok' }
  }, [visibleMetas, syncMap])

  const metaOf = (id: string) => metas.find(a => a.id === id)
  const current = currentKey ? filtered.find(m => m.key === currentKey) ?? allMessages.find(m => m.key === currentKey) ?? null : null

  const openMessage = (m: MailMessage) => {
    setCurrentKey(m.key)
    setView('reader')
    if (!m.flags.includes('\\Seen')) {
      const account = metaOf(m.accountId)
      if (account) {
        void mailSetFlag(account, m, '\\Seen', true).then(refreshCache).catch(e => notify(`标记已读失败：${e instanceof Error ? e.message : String(e)}`))
      }
    }
  }

  const toggleStar = async (m: MailMessage) => {
    const account = metaOf(m.accountId)
    if (!account) return
    const starred = m.flags.includes('\\Flagged')
    try { await mailSetFlag(account, m, '\\Flagged', !starred); refreshCache() } catch (e) { notify(`星标失败：${e instanceof Error ? e.message : String(e)}`) }
  }

  const archiveMessage = async (m: MailMessage) => {
    const account = metaOf(m.accountId)
    if (!account) return
    const archive = (cache[m.accountId]?.folders ?? []).find(f => f.role === 'archive')
    if (!archive) { notify('该邮箱没有归档文件夹，无法归档'); return }
    try { await mailMoveMessages(account, [m], archive.name); refreshCache(); notify('已归档') } catch (e) { notify(`归档失败：${e instanceof Error ? e.message : String(e)}`) }
  }

  const deleteMessages = async (msgs: MailMessage[]) => {
    const byAccount = new Map<string, MailMessage[]>()
    for (const m of msgs) byAccount.set(m.accountId, [...(byAccount.get(m.accountId) ?? []), m])
    for (const [accountId, list] of byAccount) {
      const account = metaOf(accountId)
      if (!account) continue
      try {
        const mode = await mailDeleteMessages(account, list)
        notify(mode === 'trash' ? `已移入垃圾箱（${list.length} 封）` : `已彻底删除（${list.length} 封）`)
      } catch (e) { notify(`删除失败：${e instanceof Error ? e.message : String(e)}`) }
    }
    setSelected(new Set())
    refreshCache()
  }

  const batchMarkRead = async () => {
    const msgs = filtered.filter(m => selected.has(m.key) && !m.flags.includes('\\Seen'))
    for (const m of msgs) {
      const account = metaOf(m.accountId)
      if (account) { try { await mailSetFlag(account, m, '\\Seen', true) } catch { /* 单封失败不阻断批量 */ } }
    }
    setSelected(new Set())
    refreshCache()
  }

  const toggleSelect = (key: string) => setSelected(prev => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

  if (!pwd) {
    return (
      <div className="mail-locked">
        <Lock size={28} />
        <h4>邮箱凭据锁在保险箱里</h4>
        <p>邮箱账户的授权码与令牌用保险箱主密码加密、只存本机。输入主密码解锁后即可同步邮件。</p>
        <div className="mail-locked-row">
          <input type="password" className="input" placeholder="保险箱主密码" value={pwdInput}
            onChange={e => setPwdInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && pwdInput) { onUnlock(pwdInput); setPwdInput('') } }} />
          <button className="btn primary" disabled={!pwdInput} onClick={() => { onUnlock(pwdInput); setPwdInput('') }}>解锁</button>
        </div>
      </div>
    )
  }

  return (
    <div className="mail-tool">
      {view === 'inbox' && (
        <>
          <div className="mail-topbar">
            <span className={`mail-sync-dot ${aggregate.cls}`} />
            <span className="mail-sync-text">{aggregate.text}</span>
            <span className="mail-topbar-spacer" />
            <button className="btn sm ghost" onClick={() => syncAll()} title="刷新全部账户"><RefreshCw size={14} /> 刷新</button>
            <button className="btn sm ghost" onClick={() => setView('add')}><Plus size={14} /> 添加账户</button>
            <button className="btn sm ghost" onClick={() => setView('settings')}><Settings size={14} /> 账户设置</button>
            <button className="btn sm danger-ghost" disabled={!metas.length} onClick={() => setDeleteAllOpen(true)}><Trash2 size={14} /> 一键删除全部邮件</button>
          </div>

          <div className="mail-account-bar">
            <button className={`mail-chip ${accountFilter === 'all' ? 'active' : ''}`} onClick={() => setAccountFilter('all')}>
              全部账户
              {Object.values(unreadByAccount).reduce((a, b) => a + b, 0) > 0 && <span className="mail-badge">{Object.values(unreadByAccount).reduce((a, b) => a + b, 0)}</span>}
            </button>
            {visibleMetas.map(a => (
              <button key={a.id} className={`mail-chip ${accountFilter === a.id ? 'active' : ''}`} onClick={() => setAccountFilter(a.id)} title={a.email}>
                <span className="mail-chip-platform">{mailPlatform(a.platformId).name}</span> {a.email}
                {(unreadByAccount[a.id] ?? 0) > 0 && <span className="mail-badge">{unreadByAccount[a.id]}</span>}
                {syncMap[a.id]?.state === 'error' && <span className="mail-chip-err" title={syncMap[a.id]?.message}>同步失败</span>}
              </button>
            ))}
          </div>

          {/* v0.1.445：同步失败原因常驻显示（不只藏在 chip 的 tooltip 里），含卡住的步骤 */}
          {visibleMetas.filter(a => syncMap[a.id]?.state === 'error').map(a => (
            <div key={a.id} className="mail-error-box"><AlertTriangle size={15} /> 「{a.email}」同步失败：{displayMailError(syncMap[a.id]?.message ?? '')}</div>
          ))}

          {!metas.length ? (
            <div className="mail-empty">
              <Mail size={34} />
              <h4>还没有邮箱账户</h4>
              <p>把 Gmail、Outlook、QQ、163、126、iCloud、新浪、阿里邮箱都加进来，一个收件箱看全部邮件。</p>
              <button className="btn primary" onClick={() => setView('add')}><Plus size={15} /> 添加第一个邮箱账户</button>
            </div>
          ) : (
            <>
              <div className="mail-cat-tabs">
                <button className={category === 'all' ? 'active' : ''} onClick={() => setCategory('all')}>全部 <span>{categoryCounts.all ?? 0}</span></button>
                {MAIL_CATEGORIES.map(c => (
                  <button key={c} className={category === c ? 'active' : ''} onClick={() => setCategory(c)}>
                    {MAIL_CATEGORY_LABELS[c]} <span>{categoryCounts[c] ?? 0}</span>
                  </button>
                ))}
              </div>
              <div className="mail-toolbar">
                <label className="mail-search"><Search size={14} /><input placeholder="搜索主题、发件人、正文…" value={query} onChange={e => setQuery(e.target.value)} /></label>
                {([['all', '全部'], ['unread', '未读'], ['starred', '星标'], ['attach', '附件']] as [QuickFilter, string][]).map(([k, label]) => (
                  <button key={k} className={`mail-filter-chip ${quick === k ? 'active' : ''}`} onClick={() => setQuick(k)}>{label}</button>
                ))}
              </div>
              {selected.size > 0 && (
                <div className="mail-batch-bar">
                  <span>已选 {selected.size} 封</span>
                  <button className="btn sm" onClick={() => void batchMarkRead()}>标记已读</button>
                  <button className="btn sm" onClick={() => void deleteMessages(filtered.filter(m => selected.has(m.key)))}>删除</button>
                  <button className="btn sm ghost" onClick={() => setSelected(new Set())}><X size={13} /> 取消选择</button>
                </div>
              )}
              <div className="mail-list">
                {filtered.length === 0 && <div className="mail-list-empty">没有符合条件的邮件，点「刷新」从服务器同步最新邮件。</div>}
                {filtered.map(m => {
                  const unread = !m.flags.includes('\\Seen')
                  const starred = m.flags.includes('\\Flagged')
                  return (
                    <div key={m.key} className={`mail-row ${unread ? 'unread' : ''} ${freshKeys.has(m.key) ? 'fresh' : ''}`}
                      onClick={() => openMessage(m)}>
                      <input type="checkbox" className="mail-row-check" checked={selected.has(m.key)}
                        onClick={e => e.stopPropagation()} onChange={() => toggleSelect(m.key)} aria-label="选择邮件" />
                      <span className="mail-row-dot">{unread && <i />}</span>
                      <div className="mail-row-main">
                        <div className="mail-row-line1">
                          <span className="mail-row-from">{m.from}</span>
                          <span className="mail-row-account">{mailPlatform(metaOf(m.accountId)?.platformId ?? 'custom').name}</span>
                          <span className={`mail-cat-tag cat-${m.category}`}>{MAIL_CATEGORY_LABELS[m.category]}</span>
                          {m.hasAttach && <Paperclip size={12} className="mail-row-clip" />}
                          <span className="mail-row-time">{fmtTime(m.date)}</span>
                        </div>
                        <div className="mail-row-subject">{m.subject}</div>
                        <div className="mail-row-snippet">{m.snippet}</div>
                      </div>
                      <div className="mail-row-actions" onClick={e => e.stopPropagation()}>
                        <button title={starred ? '取消星标' : '星标'} className={starred ? 'on' : ''} onClick={() => void toggleStar(m)}><Star size={15} fill={starred ? 'currentColor' : 'none'} /></button>
                        <button title="归档" onClick={() => void archiveMessage(m)}><Archive size={15} /></button>
                        <button title="删除" onClick={() => void deleteMessages([m])}><Trash2 size={15} /></button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </>
      )}

      {view === 'reader' && current && (
        <MailReader
          msg={current}
          account={metaOf(current.accountId)}
          siblings={filtered}
          accounts={accounts}
          sessionPwd={pwd}
          notify={notify}
          onBack={() => setView('inbox')}
          onNavigate={m => openMessage(m)}
          onToggleStar={() => void toggleStar(current)}
          onDelete={() => { void deleteMessages([current]); setView('inbox') }}
          onCategoryChange={c => { setCategoryOverride(current.key, c); refreshCache() }}
        />
      )}
      {view === 'reader' && !current && (
        <div className="mail-empty"><p>这封邮件已不在列表里。</p><button className="btn" onClick={() => setView('inbox')}>返回收件箱</button></div>
      )}

      {view === 'settings' && (
        <MailSettings
          metas={metas}
          visibility={visibility}
          syncMap={syncMap}
          cache={cache}
          onBack={() => setView('inbox')}
          onVisibility={v => { setVisibility(v); saveMailVisibility(v) }}
          onAdd={() => setView('add')}
          onRemove={async a => { await removeMailAccount(a.id); setMetas(listMailAccounts()); refreshCache(); notify(`已删除账户 ${a.email}（含本机凭据）`) }}
          onDeleteAll={() => setDeleteAllOpen(true)}
        />
      )}

      {view === 'add' && (
        <MailAddAccount
          pwd={pwd}
          notify={notify}
          onBack={() => setView('inbox')}
          onAdded={() => { setMetas(listMailAccounts()); setView('inbox') }}
        />
      )}

      {deleteAllOpen && (
        <DeleteAllModal
          metas={metas}
          pwd={pwd}
          notify={notify}
          onClose={() => setDeleteAllOpen(false)}
          onDone={() => { refreshCache(); setSelected(new Set()) }}
        />
      )}
    </div>
  )
}

// ---------------- 阅读页 ----------------

function MailReader({ msg, account, siblings, accounts, sessionPwd, notify, onBack, onNavigate, onToggleStar, onDelete, onCategoryChange }: {
  msg: MailMessage
  account?: MailAccountMeta
  siblings: MailMessage[]
  accounts: Account[]
  sessionPwd: string
  notify: (msg: string) => void
  onBack: () => void
  onNavigate: (m: MailMessage) => void
  onToggleStar: () => void
  onDelete: () => void
  onCategoryChange: (c: MailCategory) => void
}) {
  const [body, setBody] = useState<(MailBodyContent & { code: string | null }) | null>(null)
  const [bodyError, setBodyError] = useState('')
  const [routeData, setRouteData] = useState<WorkshopRouteData | null>(null)
  const [routeKey, setRouteKey] = useState('')
  const [summary, setSummary] = useState('')
  const [summaryBusy, setSummaryBusy] = useState(false)
  const [summaryNote, setSummaryNote] = useState('')
  const idx = siblings.findIndex(m => m.key === msg.key)
  const prev = idx > 0 ? siblings[idx - 1] : null
  const next = idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1] : null
  const starred = msg.flags.includes('\\Flagged')

  useEffect(() => {
    let dead = false
    setBody(null)
    setBodyError('')
    setSummary('')
    if (!account) { setBodyError('账户已被删除'); return }
    void (async () => {
      try {
        await mailEnsureConnected(account, sessionPwd)
        const content = await mailFetchBody(account, msg)
        if (!dead) setBody(content)
      } catch (e) {
        if (!dead) setBodyError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { dead = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msg.key])

  useEffect(() => {
    let dead = false
    void loadWorkshopRoutes(accounts).then(d => {
      if (dead) return
      setRouteData(d)
      setRouteKey(prevKey => (d.routes.some(r => r.key === prevKey) ? prevKey : d.routes[0]?.key ?? ''))
    })
    return () => { dead = true }
  }, [accounts])

  const route: WorkshopRoute | null = routeData?.routes.find(r => r.key === routeKey) ?? null

  const runSummary = async () => {
    if (!route || !routeData || !body) return
    setSummaryBusy(true)
    setSummary('')
    setSummaryNote('')
    try {
      const text = (body.text || '').slice(0, 6000)
      const out = await runWorkshopChat({
        route, freeOptions: routeData.freeOptions, accounts, sessionPwd,
        system: '你是邮件摘要助手。用简体中文在 120 字内概括这封邮件的核心内容、需要收件人做什么（如有）、关键时间与金额（如有）。只输出摘要正文。',
        user: `主题：${msg.subject}\n发件人：${msg.from} <${msg.fromAddr}>\n\n${text}`,
        onChainNote: note => setSummaryNote(note),
      })
      setSummary(out.trim())
    } catch (e) {
      notify(`AI 摘要失败：${e instanceof Error ? e.message : String(e)}`)
    } finally { setSummaryBusy(false) }
  }

  const copyCode = async (code: string) => {
    try { await navigator.clipboard.writeText(code); notify(`验证码 ${code} 已复制`) } catch { notify('复制失败，请手动复制') }
  }

  return (
    <div className="mail-reader">
      <div className="mail-reader-top">
        <button className="btn sm ghost" onClick={onBack}><ChevronLeft size={14} /> 返回</button>
        <span className="mail-reader-nav">
          <button className="btn sm ghost" disabled={!prev} onClick={() => prev && onNavigate(prev)}><ChevronLeft size={14} /> 上一封</button>
          <button className="btn sm ghost" disabled={!next} onClick={() => next && onNavigate(next)}>下一封 <ChevronRight size={14} /></button>
        </span>
        <span className="mail-topbar-spacer" />
        <label className="mail-cat-select">分类
          <select value={msg.category} onChange={e => onCategoryChange(e.target.value as MailCategory)}>
            {MAIL_CATEGORIES.map(c => <option key={c} value={c}>{MAIL_CATEGORY_LABELS[c]}</option>)}
          </select>
        </label>
        <button className="btn sm ghost" onClick={onToggleStar}><Star size={14} fill={starred ? 'currentColor' : 'none'} /> {starred ? '取消星标' : '星标'}</button>
        <button className="btn sm danger-ghost" onClick={onDelete}><Trash2 size={14} /> 删除</button>
      </div>
      <h3 className="mail-reader-subject">{msg.subject}</h3>
      <div className="mail-reader-meta">
        <span className="mail-reader-from">{msg.from}</span>
        <span className="mail-reader-addr">&lt;{msg.fromAddr}&gt;</span>
        <span className="mail-reader-account">{account ? `${mailPlatform(account.platformId).name} · ${account.email}` : ''}</span>
        <span className="mail-reader-time">{msg.date ? new Date(msg.date).toLocaleString() : ''}</span>
      </div>

      {body?.code && (
        <div className="mail-code-card">
          <div>
            <div className="mail-code-label">验证码</div>
            <div className="mail-code-value">{body.code}</div>
          </div>
          <button className="btn primary" onClick={() => void copyCode(body.code!)}><Copy size={15} /> 复制验证码</button>
        </div>
      )}

      <div className="mail-summary-box">
        <div className="mail-summary-head">
          <Sparkles size={14} /> AI 摘要
          <select className="mail-route-select" value={routeKey} onChange={e => setRouteKey(e.target.value)} disabled={!routeData?.routes.length}>
            {(routeData?.routes ?? []).map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
          <button className="btn sm primary" disabled={!route || !body || summaryBusy} onClick={() => void runSummary()}>
            {summaryBusy ? <Loader2 size={13} className="spin" /> : null} {summary ? '重新摘要' : '生成摘要'}
          </button>
        </div>
        {summaryNote && <div className="mail-summary-note">{summaryNote}</div>}
        {summary && <p className="mail-summary-text">{summary}</p>}
        {!summary && !summaryBusy && <p className="mail-summary-hint">用你已配置的模型路线（免费模型 / 自有账户）概括这封邮件，不新增服务。</p>}
      </div>

      {bodyError && <div className="mail-error-box"><AlertTriangle size={15} /> 正文加载失败：{bodyError}</div>}
      {!body && !bodyError && <div className="mail-loading"><Loader2 size={16} className="spin" /> 正在从服务器取正文…</div>}
      {body && (
        <>
          {body.html
            ? <div className="mail-body-html" dangerouslySetInnerHTML={{ __html: sanitizeMailHtml(body.html) }} />
            : <div className="mail-body-text">{body.text}</div>}
          {body.attachments.length > 0 && (
            <div className="mail-attachments">
              <div className="mail-attachments-title"><Paperclip size={14} /> 附件（{body.attachments.length}）</div>
              {body.attachments.map((a, i) => (
                <div key={i} className="mail-attachment-row">
                  <span className="mail-attachment-name">{a.filename}</span>
                  <span className="mail-attachment-size">{a.contentType} · {(a.size / 1024).toFixed(1)} KB</span>
                  <button className="btn sm" onClick={() => void mailSaveAttachment(a.filename, a.base64).then(p => notify(`已保存到 ${p}`)).catch(e => notify(`保存失败：${e instanceof Error ? e.message : String(e)}`))}>保存</button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ---------------- 设置页（管账户：平台总开关 / 账户副开关） ----------------

function MailSettings({ metas, visibility, syncMap, cache, onBack, onVisibility, onAdd, onRemove, onDeleteAll }: {
  metas: MailAccountMeta[]
  visibility: ReturnType<typeof loadMailVisibility>
  syncMap: Record<string, AccountSync>
  cache: ReturnType<typeof loadMailCache>
  onBack: () => void
  onVisibility: (v: ReturnType<typeof loadMailVisibility>) => void
  onAdd: () => void
  onRemove: (a: MailAccountMeta) => Promise<void>
  onDeleteAll: () => void
}) {
  const [confirmRemoveId, setConfirmRemoveId] = useState('')
  const platformsWithAccounts = MAIL_PLATFORMS.filter(p => metas.some(a => a.platformId === p.id))
  const setPlatform = (pid: string, on: boolean) => onVisibility({ ...visibility, platforms: { ...visibility.platforms, [pid]: on } })
  const setAccount = (id: string, on: boolean) => onVisibility({ ...visibility, accounts: { ...visibility.accounts, [id]: on } })

  return (
    <div className="mail-settings">
      <div className="mail-reader-top">
        <button className="btn sm ghost" onClick={onBack}><ChevronLeft size={14} /> 返回收件箱</button>
        <span className="mail-topbar-spacer" />
        <button className="btn sm primary" onClick={onAdd}><Plus size={14} /> 添加邮箱账户</button>
      </div>
      <p className="mail-settings-note">
        <ShieldCheck size={14} /> 凭据（授权码 / OAuth 令牌）用保险箱主密码加密，只存本机、不同步。
        关掉平台或账户开关后，它在主页收件箱里隐匿（不删数据），打开即恢复。
      </p>
      {platformsWithAccounts.length === 0 && <div className="mail-list-empty">还没有账户，点右上角添加。</div>}
      {platformsWithAccounts.map(p => {
        const platformOn = visibility.platforms[p.id] !== false
        const list = metas.filter(a => a.platformId === p.id)
        return (
          <div key={p.id} className="mail-settings-platform">
            <div className="mail-settings-platform-head">
              <span className="mail-settings-platform-name">{p.name}</span>
              <span className="mail-settings-platform-count">{list.length} 个账户</span>
              <span className="mail-topbar-spacer" />
              <span className="mail-settings-switch-label">{platformOn ? '显示中' : '已隐匿'}</span>
              <JellyToggle checked={platformOn} onChange={v => setPlatform(p.id, v)} label={`${p.name} 平台总开关`} />
            </div>
            {list.map(a => {
              const accountOn = visibility.accounts[a.id] !== false
              const effective = platformOn && accountOn
              const unread = (cache[a.id]?.messages ?? []).filter(m => !m.flags.includes('\\Seen')).length
              const sync = syncMap[a.id]
              return (
                <div key={a.id} className={`mail-settings-account ${effective ? '' : 'hidden-account'}`}>
                  <div className="mail-settings-account-main">
                    <span className="mail-settings-email">{a.email}</span>
                    <span className="mail-settings-sub">
                      未读 {unread} · {sync?.state === 'error' ? `同步失败：${sync.message ?? ''}` : sync?.state === 'live' ? '实时推送中' : sync?.state === 'poll' ? '轮询同步' : '已缓存'}
                      {!effective && ' · 主页已隐匿'}
                    </span>
                  </div>
                  <span className="mail-topbar-spacer" />
                  {confirmRemoveId === a.id ? (
                    <>
                      <span className="mail-remove-confirm">删除账户与本机凭据？</span>
                      <button className="btn sm danger" onClick={() => void onRemove(a)}>确认删除</button>
                      <button className="btn sm ghost" onClick={() => setConfirmRemoveId('')}>取消</button>
                    </>
                  ) : (
                    <button className="btn sm ghost" onClick={() => setConfirmRemoveId(a.id)}><Trash2 size={13} /> 删除账户</button>
                  )}
                  <JellyToggle checked={accountOn} onChange={v => setAccount(a.id, v)} label={`${a.email} 账户开关`} />
                </div>
              )
            })}
          </div>
        )
      })}
      <div className="mail-danger-zone">
        <div>
          <div className="mail-danger-title">一键删除全部邮件</div>
          <div className="mail-danger-desc">删除全部平台、全部账户里的全部邮件（账户与凭据保留）。有垃圾箱的先移入垃圾箱，垃圾箱内彻底删除。</div>
        </div>
        <button className="btn danger" disabled={!metas.length} onClick={onDeleteAll}><Trash2 size={15} /> 删除全部邮件</button>
      </div>
    </div>
  )
}

// ---------------- 添加账户 ----------------

function MailAddAccount({ pwd, notify, onBack, onAdded }: {
  pwd: string
  notify: (msg: string) => void
  onBack: () => void
  onAdded: () => void
}) {
  const [platformId, setPlatformId] = useState<MailPlatformId>('qq')
  const preset = mailPlatform(platformId)
  const [email, setEmail] = useState('')
  const [secretInput, setSecretInput] = useState('')
  const [customHost, setCustomHost] = useState('')
  const [customPort, setCustomPort] = useState('993')
  const [authMethod, setAuthMethod] = useState<'oauth' | 'code'>('oauth')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  // v0.1.445：验证流程代号 + 在途账户 id，支撑「取消验证」真正中断并让迟到的结果作废
  const flowRef = useRef(0)
  const activeAccountRef = useRef('')

  const cancelVerify = async () => {
    flowRef.current += 1
    const id = activeAccountRef.current
    activeAccountRef.current = ''
    setBusy('')
    setError(id
      ? '已取消验证。账户已保存，可在收件箱点「刷新」重新连接。'
      : '已取消验证。')
    if (id) await mailCancelConnect(id)
  }

  const finishWithSyncTest = async (metaNoId: Omit<MailAccountMeta, 'id'>, secret: MailSecret) => {
    const flow = flowRef.current
    const meta = await addMailAccount(metaNoId, secret, pwd)
    activeAccountRef.current = meta.id
    if (flow !== flowRef.current) return // 保存期间已被取消：不再发起连接
    const outcome = await mailSyncAccount(meta, pwd)
    if (flow !== flowRef.current) return // 已取消：迟到的结果不再改界面
    activeAccountRef.current = ''
    if (outcome.ok) {
      notify(`「${meta.email}」连接成功，已同步 ${(loadMailCache()[meta.id]?.messages ?? []).length} 封邮件`)
      onAdded()
    } else {
      // v0.1.447：「请检查服务器/授权码」只对服务器/凭据类错误拼；
      // panic 等内部错误拼这句只会误导（与授权码无关）。
      setError(shouldSuggestCredentialCheck(outcome.error ?? '')
        ? `账户已保存，但连接失败：${outcome.error}。请检查服务器/授权码后，在收件箱点「刷新」重试。`
        : `账户已保存，但连接失败：${outcome.error}。可在收件箱点「刷新」重试。`)
      setBusy('')
    }
  }

  const saveWithCode = async () => {
    if (!email.includes('@')) { setError('请填写完整的邮箱地址'); return }
    if (!secretInput) { setError(`请填写${preset.secretLabel}`); return }
    if (platformId === 'custom' && !customHost) { setError('请填写 IMAP 服务器地址'); return }
    setBusy('正在连接服务器验证…')
    setError('')
    const flow = flowRef.current
    try {
      await finishWithSyncTest(
        {
          platformId, email: email.trim(),
          label: email.trim(),
          host: platformId === 'custom' ? customHost.trim() : preset.imapHost,
          port: platformId === 'custom' ? parseInt(customPort, 10) || 993 : preset.imapPort,
        },
        { kind: 'code', secret: secretInput },
      )
    } catch (e) {
      if (flow !== flowRef.current) return // 已取消，界面已由 cancelVerify 复位
      setError(e instanceof Error ? e.message : String(e))
      setBusy('')
    }
  }

  const saveWithOAuth = async () => {
    if (!email.includes('@')) { setError('请填写完整的邮箱地址'); return }
    if (!clientId) { setError('请先填 OAuth Client ID（见下方说明）'); return }
    if (!preset.oauthProvider) { setError('该平台不支持 OAuth'); return }
    setBusy('已打开浏览器，请在浏览器里完成授权…（最长等 3 分钟）')
    setError('')
    const flow = flowRef.current
    try {
      const port = await mailOAuthListenStart()
      await openExternal(buildOAuthUrl(preset.oauthProvider, clientId.trim(), port))
      const deadline = Date.now() + 180_000
      let code = ''
      while (Date.now() < deadline) {
        if (flow !== flowRef.current) return // 已取消验证
        await new Promise(r => setTimeout(r, 800))
        const res = await mailOAuthListenResult()
        if (res?.error) throw new Error(`授权被拒绝：${res.error}`)
        if (res?.code) { code = res.code; break }
      }
      if (!code) throw new Error('等待授权超时，请重试')
      setBusy('授权成功，正在换取令牌并连接…')
      const secret = await mailOAuthExchange(preset.oauthProvider, code, clientId.trim(), clientSecret.trim(), port)
      await finishWithSyncTest(
        { platformId, email: email.trim(), label: email.trim(), host: preset.imapHost, port: preset.imapPort },
        secret,
      )
    } catch (e) {
      if (flow !== flowRef.current) return // 已取消，界面已由 cancelVerify 复位
      setError(e instanceof Error ? e.message : String(e))
      setBusy('')
    }
  }

  const useOAuth = preset.auth === 'oauth' && authMethod === 'oauth'

  return (
    <div className="mail-add">
      <div className="mail-reader-top">
        <button className="btn sm ghost" onClick={() => { if (busy) void cancelVerify(); onBack() }}><ChevronLeft size={14} /> 返回</button>
        <h4 className="mail-add-title">添加邮箱账户</h4>
      </div>
      <div className="mail-platform-grid">
        {MAIL_PLATFORMS.map(p => (
          <button key={p.id} className={`mail-platform-card ${platformId === p.id ? 'active' : ''}`} onClick={() => { setPlatformId(p.id); setError('') }}>
            <span className="mail-platform-name">{p.name}</span>
            <span className="mail-platform-auth">{p.auth === 'oauth' ? 'OAuth / 应用密码' : p.secretLabel}</span>
          </button>
        ))}
      </div>
      <div className="mail-guide">
        {preset.guide.map((g, i) => <div key={i} className="mail-guide-line">{i + 1}. {g}</div>)}
      </div>
      <div className="mail-form">
        <label>邮箱地址<input className="input" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} /></label>
        {platformId === 'custom' && (
          <>
            <label>IMAP 服务器<input className="input" placeholder="imap.example.com" value={customHost} onChange={e => setCustomHost(e.target.value)} /></label>
            <label>端口<input className="input" value={customPort} onChange={e => setCustomPort(e.target.value)} /></label>
          </>
        )}
        {preset.auth === 'oauth' && (
          <div className="mail-auth-method">
            <button className={authMethod === 'oauth' ? 'active' : ''} onClick={() => setAuthMethod('oauth')}>OAuth 授权（推荐）</button>
            <button className={authMethod === 'code' ? 'active' : ''} onClick={() => setAuthMethod('code')}>{preset.secretLabel}</button>
          </div>
        )}
        {useOAuth ? (
          <>
            <label>OAuth Client ID<input className="input" placeholder="你自己的 OAuth 客户端 ID" value={clientId} onChange={e => setClientId(e.target.value)} /></label>
            {preset.oauthProvider === 'google' && (
              <label>OAuth Client Secret<input className="input" placeholder="Google 桌面客户端的 Secret" value={clientSecret} onChange={e => setClientSecret(e.target.value)} /></label>
            )}
            <p className="mail-form-hint">授权在本机浏览器完成，回调只走 127.0.0.1；令牌加密存本机保险箱，不上传。</p>
          </>
        ) : (
          <label>{preset.secretLabel}<input className="input" placeholder={`不是登录密码，是${preset.secretLabel}`} value={secretInput} onChange={e => setSecretInput(e.target.value)} /></label>
        )}
        {error && <div className="mail-error-box"><AlertTriangle size={15} /> {displayMailError(error)}</div>}
        <div className="mail-form-actions">
          <button className="btn ghost" onClick={() => { if (busy) void cancelVerify(); onBack() }}>取消</button>
          {busy && (
            <button className="btn" onClick={() => void cancelVerify()}>取消验证</button>
          )}
          <button className="btn primary" disabled={!!busy} onClick={() => void (useOAuth ? saveWithOAuth() : saveWithCode())}>
            {busy ? <Loader2 size={14} className="spin" /> : <FolderInput size={14} />} {busy || '连接并保存'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------- 一键删除全部邮件（两次确认） ----------------

function DeleteAllModal({ metas, pwd, notify, onClose, onDone }: {
  metas: MailAccountMeta[]
  pwd: string
  notify: (msg: string) => void
  onClose: () => void
  onDone: () => void
}) {
  const [stage, setStage] = useState<'loading' | 'preview' | 'confirm' | 'running' | 'done'>('loading')
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof mailDeleteAllPreview>> | null>(null)
  const [reports, setReports] = useState<MailDeleteAllReport[]>([])
  const [progress, setProgress] = useState('')

  useEffect(() => {
    let dead = false
    void mailDeleteAllPreview(metas, pwd).then(p => {
      if (dead) return
      setPreview(p)
      setStage('preview')
    })
    return () => { dead = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const modeText = (mode: 'trash' | 'permanent' | 'mixed') =>
    mode === 'trash' ? '移入垃圾箱' : mode === 'mixed' ? '先移入垃圾箱，垃圾箱内彻底删除' : '彻底删除（无垃圾箱或已在垃圾箱）'

  const runDelete = async () => {
    setStage('running')
    const result = await mailDeleteAll(metas, pwd, (email, n) => setProgress(`正在删除「${email}」…已删 ${n} 封`))
    setReports(result)
    setStage('done')
    onDone()
    const failed = result.filter(r => r.error)
    if (failed.length) notify(`删除完成，但 ${failed.length} 个账户有失败：${failed[0].error}`)
    else notify(`已删除全部邮件，共 ${result.reduce((a, r) => a + r.deleted, 0)} 封`)
  }

  return (
    <div className="mail-modal-backdrop" onClick={stage === 'running' ? undefined : onClose}>
      <div className="mail-modal" onClick={e => e.stopPropagation()}>
        <div className="mail-modal-head">
          <AlertTriangle size={18} className="mail-modal-warn" />
          <h4>一键删除全部邮件</h4>
          <span className="mail-topbar-spacer" />
          {stage !== 'running' && <button className="btn sm ghost" onClick={onClose}><X size={14} /></button>}
        </div>
        {stage === 'loading' && <div className="mail-loading"><Loader2 size={16} className="spin" /> 正在连接各账户统计邮件数…</div>}
        {(stage === 'preview' || stage === 'confirm') && preview && (
          <>
            <p className="mail-modal-desc">
              将删除 <b>{preview.perAccount.length} 个账户</b>、共 <b>{preview.total} 封</b>邮件（含收件箱、已发送、草稿、垃圾箱等全部文件夹）。
              账户与凭据保留，不删账户。删除方式按各平台实际支持：
            </p>
            <div className="mail-modal-list">
              {preview.perAccount.map(({ account, total, mode, error }) => (
                <div key={account.id} className="mail-modal-row">
                  <span className="mail-modal-email">{mailPlatform(account.platformId).name} · {account.email}</span>
                  {error
                    ? <span className="mail-modal-err">连接失败：{displayMailError(error)}</span>
                    : <span className="mail-modal-count">{total} 封 · {modeText(mode)}</span>}
                </div>
              ))}
            </div>
            {stage === 'preview' && (
              <div className="mail-modal-actions">
                <button className="btn ghost" onClick={onClose}>取消</button>
                <button className="btn danger" disabled={preview.total === 0} onClick={() => setStage('confirm')}>继续删除</button>
              </div>
            )}
            {stage === 'confirm' && (
              <>
                <div className="mail-error-box"><AlertTriangle size={15} /> 最后确认：这一步执行后，被彻底删除的邮件无法恢复；移入垃圾箱的邮件可在邮箱网页版的垃圾箱里找回（自动清空前）。</div>
                <div className="mail-modal-actions">
                  <button className="btn ghost" onClick={() => setStage('preview')}>返回</button>
                  <button className="btn danger" onClick={() => void runDelete()}>确认删除全部 {preview.total} 封</button>
                </div>
              </>
            )}
          </>
        )}
        {stage === 'running' && <div className="mail-loading"><Loader2 size={16} className="spin" /> {progress || '正在删除…'}</div>}
        {stage === 'done' && (
          <>
            <div className="mail-modal-list">
              {reports.map(r => (
                <div key={r.accountId} className="mail-modal-row">
                  <span className="mail-modal-email">{r.email}</span>
                  {r.error
                    ? <span className="mail-modal-err">失败：{r.error}</span>
                    : <span className="mail-modal-count"><CheckCircle2 size={13} /> 已删 {r.deleted} 封（{modeText(r.mode)}）</span>}
                </div>
              ))}
            </div>
            <div className="mail-modal-actions">
              <button className="btn primary" onClick={onClose}>完成</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
