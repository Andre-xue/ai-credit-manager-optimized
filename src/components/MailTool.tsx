// 邮箱工具（v0.1.436，一期，仅桌面端）：统一收件箱 / 全宽阅读 / 账户设置。
// 大厂风格：中性灰阶 + 单一品牌色、扁平卡片、线性图标；交互照预览定案：
// 新邮件滑入高亮、悬停快捷操作、多选批量条、未读徽标、果冻开关。
// 同步方式如实标注：IDLE 实时推送 / 服务器不支持 IDLE 时轮询 / 失败显示服务器原文。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Mail, RefreshCw, Settings, Plus, Trash2, Star, Archive, Search, Lock, X, ChevronLeft, ChevronRight, ChevronDown,
  Paperclip, Copy, Sparkles, AlertTriangle, CheckCircle2, Loader2, FolderInput, ShieldCheck, Globe, KeyRound, ImageOff,
} from 'lucide-react'
import type { Account } from '../core/types'
import {
  MAIL_PLATFORMS, MAIL_CATEGORIES, MAIL_CATEGORY_LABELS, mailPlatform,
  listMailAccounts, addMailAccount, removeMailAccount,
  loadMailVisibility, saveMailVisibility, isAccountVisible,
  loadMailCache, applyCategoryOverrides, setCategoryOverride,
  mailSyncAccount, mailSetFlag, mailMoveMessages, mailDeleteMessages, mailFetchBody, mailSaveAttachment,
  mailDeleteAllPreview, mailDeleteAll, mailDeleteAllSnapshot,
  mailEnsureConnected, mailCancelConnect, prepareMailHtml, htmlHasVisibleText, MAIL_IMG_PLACEHOLDER,
  mailVerifyAccount, MAIL_CONNECT_STEP_LABELS, loadCachedBody, mailFetchAttachment,
  OAUTH_REGISTER_GUIDES, loadOAuthClientCreds, saveOAuthClientCreds, clearOAuthClientCreds,
  loadMailReauthFlags, clearMailReauthFlag, mailOAuthAuthorize, OAUTH_CANCELLED,
  saveMailSecret, loadMailSecret, mailForgetSession,
  displayMailError, shouldSuggestCredentialCheck,
  loadMailAutoRefresh, saveMailAutoRefresh, MAIL_AUTO_REFRESH_INTERVALS,
  loadMailListPrefs, saveMailListPrefs, MAIL_PAGE_SIZES, mailPageWindow,
  type MailAccountMeta, type MailMessage, type MailCategory, type MailPlatformId, type MailSecret,
  type MailAutoRefresh, type MailDensity,
  type MailBodyContent, type MailDeleteAllReport, type MailDeleteAllPreviewEntry, type MailDeleteCancelToken,
} from '../core/mail'
import { loadWorkshopRoutes, runWorkshopChat, type WorkshopRoute, type WorkshopRouteData } from '../core/workshopChat'
import { getBiometricPassword } from '../core/crypto'

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

/** v0.1.467：自动刷新间隔文案（60 秒及以下按秒、以上按分钟，与定案状态行一致） */
function intervalLabel(sec: number): string {
  return sec <= 60 ? `${sec} 秒` : `${sec / 60} 分钟`
}

/** v0.1.467：账户栏平台圆点色（平台固有识别色，未知平台用中性灰） */
const PLATFORM_DOT_COLORS: Record<string, string> = {
  gmail: '#d93025', outlook: '#0072c6', qq: '#2b7de9', icloud: '#6e6e73',
  net163: '#d71918', net126: '#2e9e4f', sina: '#e6162d', aliyun: '#ff6a00', custom: '#8a8f98',
}
const platformDot = (platformId: string) => PLATFORM_DOT_COLORS[platformId] ?? '#8a8f98'

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
  // v0.1.446：OAuth 令牌失效（invalid_grant）的账户标记 + 重新授权弹窗目标
  const [reauthFlags, setReauthFlags] = useState<Record<string, string>>(() => loadMailReauthFlags())
  const [reauthTarget, setReauthTarget] = useState<MailAccountMeta | null>(null)
  const [accountFilter, setAccountFilter] = useState<string>('all')
  const [category, setCategory] = useState<'all' | MailCategory>('all')
  const [quick, setQuick] = useState<QuickFilter>('all')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [freshKeys, setFreshKeys] = useState<Set<string>>(new Set())
  const [currentKey, setCurrentKey] = useState<string | null>(null)
  const [pwdInput, setPwdInput] = useState('')
  const [deleteAllOpen, setDeleteAllOpen] = useState(false)
  const [deleteOneTarget, setDeleteOneTarget] = useState<MailAccountMeta | null>(null)
  const [batchBusy, setBatchBusy] = useState('')
  const syncingRef = useRef<Set<string>>(new Set())
  // v0.1.467：自动刷新偏好（仅本机）+ 上次刷新时间 + 账户栏综合方案状态 + 分页/密度
  const [autoRefresh, setAutoRefreshState] = useState<MailAutoRefresh>(() => loadMailAutoRefresh())
  const [listPrefs, setListPrefsState] = useState(() => loadMailListPrefs())
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null)
  const [barOpen, setBarOpen] = useState(false)
  const [barTab, setBarTab] = useState<string>('all')
  const [page, setPage] = useState(1)
  const [endHint, setEndHint] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)
  const setAutoRefresh = useCallback((v: MailAutoRefresh) => { setAutoRefreshState(v); saveMailAutoRefresh(v) }, [])
  const setListPrefs = useCallback((v: { density: MailDensity; pageSize: number }) => { setListPrefsState(v); saveMailListPrefs(v) }, [])
  // v0.1.450：与其它工具一致——有指纹密码副本就直接进，不单独弹解锁页；
  // 两个都没有才显示解锁页（onUnlock 仍回写全局 sessionPwd）。子组件（MailReader/
  // MailAddAccount/MailSettings）都从这个 pwd 派生，不再有来源分叉。
  const pwd = getBiometricPassword() || sessionPwd

  // v0.1.461：账户在、凭据读不到的存量账户（保存曾被竞态/配额打断）——探针检出后
  // 在设置行/错误条给「重新授权」补凭据入口，不逼用户删账户重加
  const [missingSecrets, setMissingSecrets] = useState<ReadonlySet<string>>(new Set())
  const probeMissingSecrets = useCallback(async () => {
    if (!pwd) { setMissingSecrets(new Set()); return }
    const missing = new Set<string>()
    for (const a of listMailAccounts()) {
      if (!(await loadMailSecret(a.id, pwd))) missing.add(a.id)
    }
    setMissingSecrets(missing)
  }, [pwd])
  useEffect(() => { void probeMissingSecrets() }, [probeMissingSecrets, metas, view])

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

  // v0.1.467：分页（filtered 已按日期倒序，最新永远在最前）
  const pageSize = listPrefs.pageSize
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePage = Math.min(page, pageCount)
  const pageItems = useMemo(
    () => filtered.slice((safePage - 1) * pageSize, safePage * pageSize),
    [filtered, safePage, pageSize],
  )
  const totalUnread = useMemo(
    () => Object.values(unreadByAccount).reduce((a, b) => a + b, 0),
    [unreadByAccount],
  )
  // 切换账户/分类/快捷筛选/搜索 → 回第 1 页；数据刷新（同步/自动刷新）不重置页码
  useEffect(() => { setPage(1) }, [accountFilter, category, quick, query])
  useEffect(() => { if (page > pageCount) setPage(pageCount) }, [page, pageCount])
  // 翻页后列表滚回顶部（自动刷新不改页码，不会触发）
  const prevPageRef = useRef(1)
  useEffect(() => {
    if (prevPageRef.current !== safePage) {
      prevPageRef.current = safePage
      setEndHint(false)
      if (listRef.current) listRef.current.scrollTop = 0
    }
  }, [safePage])
  useEffect(() => {
    if (!endHint) return
    const t = window.setTimeout(() => setEndHint(false), 2200)
    return () => window.clearTimeout(t)
  }, [endHint])
  // 在当前页滚到底 → 自动进下一页；已是最后一页 → 轻提示后停住。
  // 页切后 400ms 内的残留 scroll 事件忽略，防止连跳两页。
  const lastAdvanceRef = useRef(0)
  const onListScroll = useCallback(() => {
    const el = listRef.current
    if (!el) return
    if (el.scrollTop + el.clientHeight < el.scrollHeight - 4) return
    if (Date.now() - lastAdvanceRef.current < 400) return
    if (safePage < pageCount) {
      lastAdvanceRef.current = Date.now()
      setPage(safePage + 1)
    } else if (filtered.length > 0) setEndHint(true)
  }, [safePage, pageCount, filtered.length])

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
    setReauthFlags(loadMailReauthFlags())
    refreshCache()
  }, [pwd, notify, refreshCache])

  const syncAll = useCallback((silent = false) => {
    for (const a of visibleMetas) void syncOne(a, silent)
  }, [visibleMetas, syncOne])

  // v0.1.467：带时间戳的同步入口（手动刷新/初次进入/自动刷新共用，状态行显示上次刷新时间）
  const syncAllStamped = useCallback((silent = false) => {
    syncAll(silent)
    setLastRefreshAt(Date.now())
  }, [syncAll])

  // 进入工具/解锁后：同步全部可见账户
  useEffect(() => {
    if (pwd && visibleMetas.length) syncAllStamped(true)
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

  // v0.1.467：自动刷新（统一兜底）——邮箱页打开且开关开启时，按间隔走与手动刷新
  // 同一入口全账户同步；有同步在途则跳过本轮。IDLE 实时推送与上面的 poll 轮询
  // 通道保持不动。刷新只换数据与未读计数：不重置页码、不动列表滚动位置、
  // 不关正在读的邮件（用户在第 1 页时新邮件自然置顶）。
  useEffect(() => {
    if (!pwd || !autoRefresh.enabled) return
    const t = window.setInterval(() => {
      if (syncingRef.current.size > 0) return
      syncAllStamped(true)
    }, autoRefresh.intervalSec * 1000)
    return () => window.clearInterval(t)
  }, [pwd, autoRefresh, syncAllStamped])

  // v0.1.467：账户栏展开面板的平台分组（按平台预设顺序，只列有账户的平台）
  const platformGroups = useMemo(() => {
    const groups: { platformId: string; name: string; accounts: MailAccountMeta[] }[] = []
    for (const p of MAIL_PLATFORMS) {
      const list = visibleMetas.filter(a => a.platformId === p.id)
      if (list.length) groups.push({ platformId: p.id, name: p.name, accounts: list })
    }
    return groups
  }, [visibleMetas])

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
    if (batchBusy) return
    const byAccount = new Map<string, MailMessage[]>()
    for (const m of msgs) byAccount.set(m.accountId, [...(byAccount.get(m.accountId) ?? []), m])
    const groups = [...byAccount.entries()]
    let idx = 0
    for (const [accountId, list] of groups) {
      idx += 1
      const account = metaOf(accountId)
      if (!account) continue
      // v0.1.466：批量删（尤其全选整账户）可能几百封，执行中给出当前账户/进度，不再干等
      setBatchBusy(`正在删除「${account.email}」的 ${list.length} 封…（第 ${idx}/${groups.length} 个账户）`)
      try {
        const mode = await mailDeleteMessages(account, list)
        notify(mode === 'trash' ? `已移入垃圾箱（${list.length} 封）` : `已彻底删除（${list.length} 封）`)
      } catch (e) { notify(`删除失败：${e instanceof Error ? e.message : String(e)}`) }
    }
    setBatchBusy('')
    setSelected(new Set())
    refreshCache()
  }

  /** v0.1.466：全选本账户全部已同步邮件（不止当前筛选下看得见的那些） */
  const selectAllOfAccount = (accountId: string) => {
    setSelected(new Set(allMessages.filter(m => m.accountId === accountId).map(m => m.key)))
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
    <div className={`mail-tool ${view === 'inbox' ? 'mail-tool-inbox' : ''}`}>
      {view === 'inbox' && (
        <>
          <div className="mail-topbar">
            <span className={`mail-sync-dot ${aggregate.cls}`} />
            <span className="mail-sync-text">{aggregate.text}</span>
            {lastRefreshAt && (
              <span className="mail-refresh-note">
                上次刷新 {new Date(lastRefreshAt).toTimeString().slice(0, 5)}
                {autoRefresh.enabled ? ` · 每 ${intervalLabel(autoRefresh.intervalSec)}自动刷新` : ''}
              </span>
            )}
            <span className="mail-topbar-spacer" />
            <button className="btn sm ghost" onClick={() => syncAllStamped()} title="刷新全部账户"><RefreshCw size={14} /> 刷新</button>
            <button className="btn sm ghost" onClick={() => setView('add')}><Plus size={14} /> 添加账户</button>
            <button className="btn sm ghost" onClick={() => setView('settings')}><Settings size={14} /> 账户设置</button>
            <button className="btn sm danger-ghost" disabled={!metas.length} onClick={() => setDeleteAllOpen(true)}><Trash2 size={14} /> 一键删除全部邮件</button>
          </div>

          {/* v0.1.467：账户栏综合方案——默认收起一行紧凑条（平台圆点+当前选中项+其未读徽标，
              右侧总未读+展开按钮）；展开滑出面板：平台页签 + 等宽网格卡，点卡选中并自动收起，
              再次展开停留在上次页签。466 的单账户两按钮（全选/删除本账户）留在紧凑条右侧。 */}
          <div className="mail-acctbar">
            <div className="mail-acctbar-row">
              {(() => {
                const cur = accountFilter !== 'all' ? visibleMetas.find(a => a.id === accountFilter) : undefined
                return cur ? (
                  <span className="mail-acct-current" title={cur.email}>
                    <span className="mail-acct-dot" style={{ background: platformDot(cur.platformId) }} />
                    <span className="mail-acct-current-name">{cur.email}</span>
                    {(unreadByAccount[cur.id] ?? 0) > 0 && <span className="mail-badge">{unreadByAccount[cur.id]}</span>}
                    {syncMap[cur.id]?.state === 'error' && <span className="mail-chip-err">同步失败</span>}
                  </span>
                ) : (
                  <span className="mail-acct-current">
                    <span className="mail-acct-dot all" />
                    <span className="mail-acct-current-name">全部账户</span>
                    {totalUnread > 0 && <span className="mail-badge">{totalUnread}</span>}
                  </span>
                )
              })()}
              {accountFilter !== 'all' && (() => {
                const target = visibleMetas.find(a => a.id === accountFilter)
                if (!target) return null
                return (
                  <>
                    <button className="btn sm ghost" onClick={() => selectAllOfAccount(target.id)}>全选本账户邮件</button>
                    <button className="btn sm danger-ghost" onClick={() => setDeleteOneTarget(target)}><Trash2 size={14} /> 删除本账户全部邮件</button>
                  </>
                )
              })()}
              <span className="mail-topbar-spacer" />
              <span className="mail-acct-total">总未读 {totalUnread}</span>
              <button className="btn sm ghost" onClick={() => setBarOpen(o => !o)} aria-expanded={barOpen}>
                {barOpen ? '收起账户' : '展开账户'}
                <ChevronDown size={14} style={{ transform: barOpen ? 'rotate(180deg)' : undefined, transition: 'transform .2s' }} />
              </button>
            </div>
            {barOpen && (
              <div className="mail-acct-panel">
                <div className="mail-acct-tabs">
                  <button className={barTab === 'all' ? 'active' : ''} onClick={() => setBarTab('all')}>全部账户 {visibleMetas.length}</button>
                  {platformGroups.map(g => (
                    <button key={g.platformId} className={barTab === g.platformId ? 'active' : ''} onClick={() => setBarTab(g.platformId)}>
                      {g.name} {g.accounts.length}
                    </button>
                  ))}
                </div>
                <div className="mail-acct-grid">
                  {barTab === 'all' && (
                    <button className={`mail-acct-card ${accountFilter === 'all' ? 'active' : ''}`} onClick={() => { setAccountFilter('all'); setBarOpen(false) }}>
                      <span className="mail-acct-card-name"><span className="mail-acct-dot all" />全部账户</span>
                      <span className="mail-acct-card-sub">{visibleMetas.length} 个账户合计</span>
                      {totalUnread > 0 && <span className="mail-badge">{totalUnread}</span>}
                    </button>
                  )}
                  {(barTab === 'all' ? visibleMetas : platformGroups.find(g => g.platformId === barTab)?.accounts ?? []).map(a => (
                    <button key={a.id} className={`mail-acct-card ${accountFilter === a.id ? 'active' : ''}`} title={a.email}
                      onClick={() => { setAccountFilter(a.id); setBarOpen(false) }}>
                      <span className="mail-acct-card-name"><span className="mail-acct-dot" style={{ background: platformDot(a.platformId) }} />{mailPlatform(a.platformId).name}</span>
                      <span className="mail-acct-card-sub">{a.email}</span>
                      {syncMap[a.id]?.state === 'error' && <span className="mail-chip-err">同步失败</span>}
                      {(unreadByAccount[a.id] ?? 0) > 0 && <span className="mail-badge">{unreadByAccount[a.id]}</span>}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* v0.1.445：同步失败原因常驻显示（不只藏在 chip 的 tooltip 里），含卡住的步骤 */}
          {visibleMetas.filter(a => syncMap[a.id]?.state === 'error').map(a => (
            <div key={a.id} className="mail-error-box"><AlertTriangle size={15} /> 「{a.email}」同步失败：{displayMailError(syncMap[a.id]?.message ?? '')}
              {(reauthFlags[a.id] || (missingSecrets.has(a.id) && mailPlatform(a.platformId).oauthProvider)) && <button className="btn sm mail-error-action" onClick={() => setReauthTarget(a)}>重新授权</button>}
            </div>
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
                <span className="mail-topbar-spacer" />
                {/* v0.1.467：密度切换（仅本机偏好） */}
                <div className="mail-density" role="group" aria-label="列表密度">
                  <button className={listPrefs.density === 'comfortable' ? 'active' : ''} onClick={() => setListPrefs({ ...listPrefs, density: 'comfortable' })}>舒适</button>
                  <button className={listPrefs.density === 'compact' ? 'active' : ''} onClick={() => setListPrefs({ ...listPrefs, density: 'compact' })}>紧凑</button>
                </div>
              </div>
              {selected.size > 0 && (
                <div className="mail-batch-bar">
                  <span>已选 {selected.size} 封</span>
                  {batchBusy
                    ? <span><Loader2 size={13} className="spin" /> {batchBusy}</span>
                    : (
                      <>
                        <button className="btn sm" onClick={() => void batchMarkRead()}>标记已读</button>
                        <button className="btn sm" onClick={() => void deleteMessages(allMessages.filter(m => selected.has(m.key)))}>删除</button>
                        <button className="btn sm ghost" onClick={() => setSelected(new Set())}><X size={13} /> 取消选择</button>
                      </>
                    )}
                </div>
              )}
              <div className="mail-list" ref={listRef} onScroll={onListScroll}>
                {filtered.length === 0 && <div className="mail-list-empty">没有符合条件的邮件，点「刷新」从服务器同步最新邮件。</div>}
                {pageItems.map(m => {
                  const unread = !m.flags.includes('\\Seen')
                  const starred = m.flags.includes('\\Flagged')
                  const compact = listPrefs.density === 'compact'
                  return (
                    <div key={m.key} className={`mail-row ${compact ? 'compact' : ''} ${unread ? 'unread' : ''} ${freshKeys.has(m.key) ? 'fresh' : ''}`}
                      onClick={() => openMessage(m)}>
                      <input type="checkbox" className="mail-row-check" checked={selected.has(m.key)}
                        onClick={e => e.stopPropagation()} onChange={() => toggleSelect(m.key)} aria-label="选择邮件" />
                      <span className="mail-row-dot">{unread && <i />}</span>
                      <div className="mail-row-main">
                        {compact ? (
                          <div className="mail-row-compactline">
                            <span className="mail-row-from">{m.from}</span>
                            <span className="mail-row-subject-inline">{m.subject}</span>
                            <span className={`mail-cat-tag cat-${m.category}`}>{MAIL_CATEGORY_LABELS[m.category]}</span>
                            {m.hasAttach && <Paperclip size={12} className="mail-row-clip" />}
                            <span className="mail-row-time">{fmtTime(m.date)}</span>
                          </div>
                        ) : (
                          <>
                            <div className="mail-row-line1">
                              <span className="mail-row-from">{m.from}</span>
                              <span className="mail-row-account">{mailPlatform(metaOf(m.accountId)?.platformId ?? 'custom').name}</span>
                              <span className={`mail-cat-tag cat-${m.category}`}>{MAIL_CATEGORY_LABELS[m.category]}</span>
                              {m.hasAttach && <Paperclip size={12} className="mail-row-clip" />}
                              <span className="mail-row-time">{fmtTime(m.date)}</span>
                            </div>
                            <div className="mail-row-subject">{m.subject}</div>
                            <div className="mail-row-snippet">{m.snippet}</div>
                          </>
                        )}
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
              {/* v0.1.467：分页条（钉在列表下方不滚） */}
              {filtered.length > 0 && (
                <div className="mail-pager">
                  <button className="btn sm ghost" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}><ChevronLeft size={13} /> 上一页</button>
                  {mailPageWindow(safePage, pageCount).map((p, i) => p === -1
                    ? <span key={`gap-${i}`} className="mail-pager-gap">…</span>
                    : <button key={p} className={`mail-pager-num ${p === safePage ? 'active' : ''}`} onClick={() => setPage(p)}>{p}</button>)}
                  <button className="btn sm ghost" disabled={safePage >= pageCount} onClick={() => setPage(safePage + 1)}>下一页 <ChevronRight size={13} /></button>
                  <span className="mail-pager-info">共 {filtered.length} 封 · 第 {safePage}/{pageCount} 页</span>
                  {endHint && <span className="mail-pager-end">已是最后一页</span>}
                  <span className="mail-topbar-spacer" />
                  <label className="mail-pager-size">每页
                    <select value={pageSize} onChange={e => setListPrefs({ ...listPrefs, pageSize: Number(e.target.value) })}>
                      {MAIL_PAGE_SIZES.map(s => <option key={s} value={s}>{s} 封</option>)}
                    </select>
                  </label>
                </div>
              )}
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
          reauthFlags={reauthFlags}
          missingSecrets={missingSecrets}
          onReauth={a => setReauthTarget(a)}
          onBack={() => setView('inbox')}
          onVisibility={v => { setVisibility(v); saveMailVisibility(v) }}
          onAdd={() => setView('add')}
          onRemove={async a => { await removeMailAccount(a.id); setMetas(listMailAccounts()); refreshCache(); notify(`已删除账户 ${a.email}（含本机凭据）`) }}
          onDeleteAll={() => setDeleteAllOpen(true)}
          autoRefresh={autoRefresh}
          onAutoRefresh={setAutoRefresh}
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

      {reauthTarget && (
        <MailReauthModal
          account={reauthTarget}
          reason={reauthFlags[reauthTarget.id]}
          pwd={pwd}
          notify={notify}
          onClose={() => setReauthTarget(null)}
          onDone={() => { const a = reauthTarget; setReauthTarget(null); setReauthFlags(loadMailReauthFlags()); void probeMissingSecrets(); void syncOne(a) }}
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

      {deleteOneTarget && (
        <DeleteAllModal
          metas={[deleteOneTarget]}
          singleAccount={deleteOneTarget}
          pwd={pwd}
          notify={notify}
          onClose={() => setDeleteOneTarget(null)}
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
  // v0.1.450：加载阶段文案（连接/取正文）+ 命中缓存时的后台校验提示 + 附件按需拉取状态
  const [loadStage, setLoadStage] = useState<'connecting' | 'fetching'>('connecting')
  const [cacheChecking, setCacheChecking] = useState(false)
  const [savingAtt, setSavingAtt] = useState(-1)
  const [showImages, setShowImages] = useState(false)
  const bodyRef = useRef<HTMLDivElement | null>(null)
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
    setShowImages(false)
    setSummary('')
    setLoadStage('connecting')
    setCacheChecking(false)
    if (!account) { setBodyError('账户已被删除'); return }
    // v0.1.450：先查本机正文缓存——命中就秒显，后台再取一次校验更新；
    // 未命中才走网络，加载文案分「正在连接邮箱服务器 / 正在从服务器取正文」两段。
    const cached = loadCachedBody(msg.key)
    if (cached) {
      setBody(cached)
      setCacheChecking(true)
      void (async () => {
        try {
          await mailEnsureConnected(account, sessionPwd)
          const fresh = await mailFetchBody(account, msg)
          if (!dead) setBody(fresh)
        } catch { /* 校验失败不影响已显示的缓存正文 */ }
        if (!dead) setCacheChecking(false)
      })()
      return () => { dead = true }
    }
    void (async () => {
      try {
        await mailEnsureConnected(account, sessionPwd)
        if (!dead) setLoadStage('fetching')
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

  // 正文呈现（v0.1.449）：HTML 预处理（cid 内嵌图换 data:、远程图默认占位）；
  // HTML 没有可见文字时回落纯文本全文，不许出现大空框（都没有正文时才勉强渲染 HTML）。
  const prepared = useMemo(
    () => (body?.html ? prepareMailHtml(body.html, body.inlineImages, showImages) : null),
    [body, showImages],
  )
  const renderHtml = !!body && !!prepared && (htmlHasVisibleText(body.html) || !(body.text ?? '').trim())

  // 远程图放行后仍加载失败（防盗链/404）：捕获 error 事件换回占位图，不露原生破图图标；
  // 监听挂载前就已失败的图一并扫掉。
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const swap = (img: HTMLImageElement) => {
      if (!img.src.startsWith('data:image/svg')) {
        img.dataset.failed = '1'
        img.src = MAIL_IMG_PLACEHOLDER
      }
    }
    const onErr = (e: Event) => { const t = e.target; if (t instanceof HTMLImageElement) swap(t) }
    el.addEventListener('error', onErr, true)
    el.querySelectorAll('img').forEach(img => {
      if (img.complete && img.naturalWidth === 0 && !img.src.startsWith('data:')) swap(img)
    })
    return () => el.removeEventListener('error', onErr, true)
  }, [prepared?.html, showImages])

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
      {!body && !bodyError && <div className="mail-loading"><Loader2 size={16} className="spin" /> {loadStage === 'fetching' ? '正在从服务器取正文…' : '正在连接邮箱服务器…'}</div>}
      {body && cacheChecking && <div className="mail-cache-note">已显示本机缓存，正在后台校验最新内容…</div>}
      {body && (
        <>
          {renderHtml
            ? (
              <>
                {prepared!.remoteCount > 0 && !showImages && (
                  <div className="mail-images-bar">
                    <ImageOff size={14} />
                    <span>这封邮件有 {prepared!.remoteCount} 张远程图片，默认不加载（防追踪、防裂图）。</span>
                    <button className="btn sm" onClick={() => setShowImages(true)}>显示图片</button>
                  </div>
                )}
                <div className="mail-body-html" ref={bodyRef} dangerouslySetInnerHTML={{ __html: prepared!.html }} />
              </>
            )
            : <div className="mail-body-text">{body.text || '（这封邮件没有正文内容）'}</div>}
          {body.attachments.length > 0 && (
            <div className="mail-attachments">
              <div className="mail-attachments-title"><Paperclip size={14} /> 附件（{body.attachments.length}）</div>
              {body.attachments.map((a, i) => (
                <div key={i} className="mail-attachment-row">
                  <span className="mail-attachment-name">{a.filename}</span>
                  <span className="mail-attachment-size">{a.contentType} · {(a.size / 1024).toFixed(1)} KB</span>
                  <button className="btn sm" disabled={savingAtt === i} onClick={() => {
                    // v0.1.450：附件数据不在正文里，点保存时才按段现拉（a.base64 有值说明已随正文拿到）
                    void (async () => {
                      try {
                        let b64 = a.base64
                        if (!b64) {
                          if (!account) throw new Error('账户已被删除')
                          setSavingAtt(i)
                          b64 = await mailFetchAttachment(account, msg, a)
                        }
                        const p = await mailSaveAttachment(a.filename, b64)
                        notify(`已保存到 ${p}`)
                      } catch (e) { notify(`保存失败：${e instanceof Error ? e.message : String(e)}`) }
                      setSavingAtt(-1)
                    })()
                  }}>{savingAtt === i ? '正在取附件…' : '保存'}</button>
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

function MailSettings({ metas, visibility, syncMap, cache, reauthFlags, missingSecrets, onReauth, onBack, onVisibility, onAdd, onRemove, onDeleteAll, autoRefresh, onAutoRefresh }: {
  metas: MailAccountMeta[]
  visibility: ReturnType<typeof loadMailVisibility>
  syncMap: Record<string, AccountSync>
  cache: ReturnType<typeof loadMailCache>
  reauthFlags: Record<string, string>
  /** v0.1.461：账户在、凭据读不到的账户 id 集合（设置行给补凭据入口） */
  missingSecrets: ReadonlySet<string>
  onReauth: (a: MailAccountMeta) => void
  onBack: () => void
  onVisibility: (v: ReturnType<typeof loadMailVisibility>) => void
  onAdd: () => void
  onRemove: (a: MailAccountMeta) => Promise<void>
  onDeleteAll: () => void
  /** v0.1.467：自动刷新偏好（仅本机） */
  autoRefresh: MailAutoRefresh
  onAutoRefresh: (v: MailAutoRefresh) => void
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
      {/* v0.1.467：自动刷新（仅本机偏好） */}
      <div className="mail-settings-platform">
        <div className="mail-settings-platform-head">
          <span className="mail-settings-platform-name">自动刷新</span>
          <span className="mail-settings-platform-count">邮箱页打开时按间隔自动同步全部账户</span>
          <span className="mail-topbar-spacer" />
          <span className="mail-settings-switch-label">{autoRefresh.enabled ? '已开启' : '已关闭'}</span>
          <JellyToggle checked={autoRefresh.enabled} onChange={v => onAutoRefresh({ ...autoRefresh, enabled: v })} label="自动刷新开关" />
        </div>
        {autoRefresh.enabled && (
          <div className="mail-autorefresh-row">
            <span>刷新间隔</span>
            <select value={autoRefresh.intervalSec} onChange={e => onAutoRefresh({ ...autoRefresh, intervalSec: Number(e.target.value) })}>
              {MAIL_AUTO_REFRESH_INTERVALS.map(s => <option key={s} value={s}>{intervalLabel(s)}</option>)}
            </select>
            <span className="mail-settings-sub">支持实时推送（IDLE）的账户仍是来信即达，此刷新是统一兜底；刷新不会打断正在读的邮件。</span>
          </div>
        )}
      </div>
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
                    {reauthFlags[a.id] && (
                      <span className="mail-settings-sub mail-reauth-note">授权已失效，需要重新授权（{reauthFlags[a.id]}）</span>
                    )}
                    {missingSecrets.has(a.id) && !reauthFlags[a.id] && (
                      <span className="mail-settings-sub mail-reauth-note">
                        {mailPlatform(a.platformId).oauthProvider
                          ? '凭据缺失（保险箱里读不到这个账户的凭据），点「重新授权」补回，不用删除账户'
                          : '凭据缺失（保险箱里读不到这个账户的凭据），请删除后用授权码重新添加'}
                      </span>
                    )}
                  </div>
                  <span className="mail-topbar-spacer" />
                  {(reauthFlags[a.id] || (missingSecrets.has(a.id) && mailPlatform(a.platformId).oauthProvider)) && (
                    <button className="btn sm" onClick={() => onReauth(a)}><RefreshCw size={13} /> 重新授权</button>
                  )}
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

// ---------------- OAuth 客户端凭据（添加账户 / 重新授权共用，v0.1.446） ----------------

/** 按平台加载已保存的客户端凭据：有则预填并收起表单，没有则展开步骤卡+表单 */
function useOAuthClientCreds(provider: 'google' | 'microsoft' | undefined, pwd: string) {
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [hasSaved, setHasSaved] = useState(false)
  const [editing, setEditing] = useState(true)
  useEffect(() => {
    let dead = false
    setClientId(''); setClientSecret(''); setHasSaved(false); setEditing(true)
    if (!provider || !pwd) return
    void loadOAuthClientCreds(provider, pwd).then(c => {
      if (dead) return
      if (c) { setClientId(c.clientId); setClientSecret(c.clientSecret); setHasSaved(true); setEditing(false) }
    })
    return () => { dead = true }
  }, [provider, pwd])
  const persist = useCallback(async () => {
    if (!provider) return
    await saveOAuthClientCreds(provider, { clientId: clientId.trim(), clientSecret: clientSecret.trim() }, pwd)
    setHasSaved(true)
    setEditing(false)
  }, [provider, clientId, clientSecret, pwd])
  const clearSaved = useCallback(() => {
    if (!provider) return
    clearOAuthClientCreds(provider)
    setHasSaved(false); setEditing(true); setClientId(''); setClientSecret('')
  }, [provider])
  return { clientId, setClientId, clientSecret, setClientSecret, hasSaved, editing, setEditing, persist, clearSaved }
}

function OAuthGuideCard({ provider }: { provider: 'google' | 'microsoft' }) {
  const guide = OAUTH_REGISTER_GUIDES[provider]
  const [open, setOpen] = useState(true)
  return (
    <div className="mail-oauth-guide">
      <button type="button" className="mail-oauth-guide-head" onClick={() => setOpen(o => !o)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        还没有自己的 OAuth 客户端？按这几步免费注册（约 5 分钟）
      </button>
      {open && (
        <>
          <ol className="mail-oauth-steps">
            {guide.steps.map((s, i) => <li key={i}>{s}</li>)}
          </ol>
          <p className="mail-oauth-note">{guide.callbackNote}</p>
        </>
      )}
    </div>
  )
}

function OAuthClientSection({ provider, creds }: {
  provider: 'google' | 'microsoft'
  creds: ReturnType<typeof useOAuthClientCreds>
}) {
  const guide = OAUTH_REGISTER_GUIDES[provider]
  if (creds.hasSaved && !creds.editing) {
    return (
      <div className="mail-oauth-saved">
        <ShieldCheck size={14} />
        <span>已保存该平台的 OAuth 客户端凭据（Client ID：{creds.clientId.slice(0, 10)}…，保险箱加密、只存本机）。直接点下方「连接并授权」即可。</span>
        <span className="mail-topbar-spacer" />
        <button type="button" className="btn sm ghost" onClick={() => creds.setEditing(true)}>更换</button>
        <button type="button" className="btn sm ghost" onClick={() => creds.clearSaved()}>清除</button>
      </div>
    )
  }
  return (
    <>
      <OAuthGuideCard provider={provider} />
      <label>OAuth Client ID<input className="input" placeholder={provider === 'google' ? 'Google Cloud 里创建的「桌面应用」客户端 ID' : 'Azure 应用注册「概述」页的应用程序(客户端) ID'} value={creds.clientId} onChange={e => creds.setClientId(e.target.value)} /></label>
      {guide.needsSecret && (
        <label>OAuth Client Secret<input className="input" placeholder="与 Client ID 同时生成的那串 Secret" value={creds.clientSecret} onChange={e => creds.setClientSecret(e.target.value)} /></label>
      )}
      <p className="mail-form-hint">授权成功后，这组客户端凭据会加密保存在本机（与邮箱令牌同等待遇、不同步），下次添加同平台账户免填；授权令牌也只存本机。</p>
    </>
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
  const creds = useOAuthClientCreds(preset.oauthProvider, pwd)
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

  // v0.1.450：验证只做连通+登录+能力快速校验（分步文案由连接进度事件驱动），
  // 文件夹枚举与拉取留给回到收件箱后的首次同步，不再全压在验证按钮上。
  const finishWithVerify = async (metaNoId: Omit<MailAccountMeta, 'id'>, secret: MailSecret) => {
    const flow = flowRef.current
    // v0.1.461：凭据保存失败必须当场失败并报真实原因，不许留下一个没凭据的账户
    // 再到连接阶段才暴露（旧行为是保存被竞态/配额静默打断、账户成幻影）。
    let meta: MailAccountMeta
    try {
      meta = await addMailAccount(metaNoId, secret, pwd)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw new Error(secret.kind === 'oauth' ? `授权成功，但凭据保存失败：${msg}` : `凭据保存失败：${msg}`)
    }
    activeAccountRef.current = meta.id
    if (flow !== flowRef.current) return // 保存期间已被取消：不再发起连接
    try {
      await mailVerifyAccount(meta, pwd, step => {
        if (flow === flowRef.current) setBusy(MAIL_CONNECT_STEP_LABELS[step])
      })
    } catch (e) {
      if (flow !== flowRef.current) return // 已取消：迟到的结果不再改界面
      activeAccountRef.current = ''
      const msg = displayMailError(e instanceof Error ? e.message : String(e))
      // v0.1.447：「请检查服务器/授权码」只对服务器/凭据类错误拼；
      // panic 等内部错误拼这句只会误导（与授权码无关）。
      // v0.1.458：OAuth 账户根本没有授权码，这句后缀对它不适用——改给重新授权类指引；
      // 若错误本身已带「重新授权」指引（458 令牌声明校验 / 令牌失效 / not connected 映射），不再叠加。
      setError(secret.kind === 'oauth'
        ? `账户已保存，但连接失败：${msg}${/重新授权/.test(msg) ? '' : '。请在收件箱点「刷新」重试；若仍失败，在设置页对该账户点「重新授权」补回凭据。'}`
        : shouldSuggestCredentialCheck(msg)
          ? `账户已保存，但连接失败：${msg}。请检查服务器/授权码后，在收件箱点「刷新」重试。`
          : `账户已保存，但连接失败：${msg}。可在收件箱点「刷新」重试。`)
      setBusy('')
      return
    }
    if (flow !== flowRef.current) return // 已取消：迟到的结果不再改界面
    activeAccountRef.current = ''
    notify(`「${meta.email}」连接成功，邮件会在收件箱后台同步`)
    onAdded()
  }

  const saveWithCode = async () => {
    if (!email.includes('@')) { setError('请填写完整的邮箱地址'); return }
    if (!secretInput) { setError(`请填写${preset.secretLabel}`); return }
    if (platformId === 'custom' && !customHost) { setError('请填写 IMAP 服务器地址'); return }
    setBusy('正在连接服务器…')
    setError('')
    const flow = flowRef.current
    try {
      await finishWithVerify(
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
    if (!preset.oauthProvider) { setError('该平台不支持 OAuth'); return }
    if (!creds.clientId.trim()) { setError('请先填 OAuth Client ID（没有的话，按上方步骤卡免费注册一个）'); return }
    if (OAUTH_REGISTER_GUIDES[preset.oauthProvider].needsSecret && !creds.clientSecret.trim()) {
      setError('请填 OAuth Client Secret（与 Client ID 同时生成，见步骤卡第 4 步）'); return
    }
    setBusy('正在打开浏览器…')
    setError('')
    const flow = flowRef.current
    try {
      const secret = await mailOAuthAuthorize(preset.oauthProvider, creds.clientId.trim(), creds.clientSecret.trim(), {
        onStatus: s => { if (flow === flowRef.current) setBusy(s) },
        isCancelled: () => flow !== flowRef.current,
      })
      if (flow !== flowRef.current) return // 授权期间已被取消
      await creds.persist() // 客户端凭据加密存本机，下次同平台免填
      setBusy('授权成功，正在连接邮箱…')
      await finishWithVerify(
        { platformId, email: email.trim(), label: email.trim(), host: preset.imapHost, port: preset.imapPort },
        secret,
      )
    } catch (e) {
      if (flow !== flowRef.current) return // 已取消，界面已由 cancelVerify 复位
      if (e instanceof Error && e.message === OAUTH_CANCELLED) { setBusy(''); return }
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
          <div className="mail-method-cards" role="radiogroup" aria-label="添加方式">
            <button type="button" className={`mail-method-card ${authMethod === 'oauth' ? 'active' : ''}`} onClick={() => setAuthMethod('oauth')}>
              <span className="mail-method-head"><Globe size={15} /> 浏览器授权登录 <span className="mail-method-badge">推荐</span></span>
              <span className="mail-method-desc">不用把密码或专用密码交给 App：点按钮后在浏览器里打开 {preset.name} 官方页面，登录并点「允许」即可。令牌只加密存本机，你随时能在账户后台单独撤销这份授权。需要一个你自己的 OAuth 客户端（免费注册，下方有步骤卡）。</span>
            </button>
            <button type="button" className={`mail-method-card ${authMethod === 'code' ? 'active' : ''}`} onClick={() => setAuthMethod('code')}>
              <span className="mail-method-head"><KeyRound size={15} /> {preset.secretLabel}</span>
              <span className="mail-method-desc">去 {preset.name} 账户后台生成一个{preset.secretLabel}填进来，不用注册开发者应用；但它相当于一把钥匙，要像密码一样保管，泄露了要去后台作废重发。</span>
            </button>
          </div>
        )}
        {useOAuth && preset.oauthProvider ? (
          <OAuthClientSection provider={preset.oauthProvider} creds={creds} />
        ) : (
          <label>{preset.secretLabel}<input className="input" placeholder={`不是登录密码，是${preset.secretLabel}`} value={secretInput} onChange={e => setSecretInput(e.target.value)} /></label>
        )}
        {error && <div className="mail-error-box"><AlertTriangle size={15} /> {displayMailError(error)}</div>}
        <div className="mail-form-actions">
          <button className="btn ghost" onClick={() => { if (busy) void cancelVerify(); onBack() }}>取消</button>
          {busy && (
            <button className="btn" onClick={() => void cancelVerify()}>{useOAuth ? '取消授权' : '取消验证'}</button>
          )}
          <button className="btn primary" disabled={!!busy} onClick={() => void (useOAuth ? saveWithOAuth() : saveWithCode())}>
            {busy ? <Loader2 size={14} className="spin" /> : <FolderInput size={14} />} {busy || (useOAuth ? '连接并授权' : '连接并保存')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------- 重新授权（OAuth 令牌失效时，v0.1.446） ----------------

function MailReauthModal({ account, reason, pwd, notify, onClose, onDone }: {
  account: MailAccountMeta
  /** v0.1.459：重新授权标记里记的具体原因（如 Graph 通道迁移），有就如实展示 */
  reason?: string
  pwd: string
  notify: (msg: string) => void
  onClose: () => void
  onDone: () => void
}) {
  const preset = mailPlatform(account.platformId)
  const provider = preset.oauthProvider
  const creds = useOAuthClientCreds(provider, pwd)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const flowRef = useRef(0)

  const cancel = () => {
    flowRef.current += 1
    setBusy('')
    setError('已取消授权。')
  }

  const run = async () => {
    if (!provider) { setError('该平台不支持 OAuth 授权'); return }
    if (!creds.clientId.trim()) { setError('请先填 OAuth Client ID（没有的话，按上方步骤卡免费注册一个）'); return }
    if (OAUTH_REGISTER_GUIDES[provider].needsSecret && !creds.clientSecret.trim()) {
      setError('请填 OAuth Client Secret（与 Client ID 同时生成，见步骤卡第 4 步）'); return
    }
    setBusy('正在打开浏览器…')
    setError('')
    const flow = flowRef.current
    try {
      const secret = await mailOAuthAuthorize(provider, creds.clientId.trim(), creds.clientSecret.trim(), {
        onStatus: s => { if (flow === flowRef.current) setBusy(s) },
        isCancelled: () => flow !== flowRef.current,
      })
      if (flow !== flowRef.current) return // 已取消
      // v0.1.461：保存结果必须核对——没存上就不许报成功、不清标记、不关弹窗
      const saved = await saveMailSecret(account.id, secret, pwd)
      if (!saved) {
        setError('授权成功，但凭据保存失败：没找到这个账户的记录（可能已被删除）。请关闭弹窗后重新添加该账户。')
        setBusy('')
        return
      }
      await creds.persist()
      clearMailReauthFlag(account.id)
      mailForgetSession(account.id) // 丢掉用旧令牌建的会话，下次同步用新令牌重连
      notify(`「${account.email}」已重新授权，正在重新同步`)
      onDone()
    } catch (e) {
      if (flow !== flowRef.current) return // 已取消，界面已由 cancel 复位
      if (e instanceof Error && e.message === OAUTH_CANCELLED) { setBusy(''); return }
      setError(e instanceof Error ? e.message : String(e))
      setBusy('')
    }
  }

  return (
    <div className="mail-modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="mail-modal" onClick={e => e.stopPropagation()}>
        <div className="mail-modal-head">
          <KeyRound size={18} />
          <h4>重新授权</h4>
          <span className="mail-topbar-spacer" />
          {!busy && <button className="btn sm ghost" onClick={onClose}><X size={14} /></button>}
        </div>
        <p className="mail-modal-desc">
          {reason
            ? <>「{account.email}」需要重新授权：{reason}。重新走一遍浏览器授权就能恢复，不用删账户，邮件与本机缓存都在。</>
            : <>「{account.email}」的授权令牌已失效（常见原因：你在 {preset.name} 后台撤销过授权、改过密码，或刷新令牌到期）。
              重新走一遍浏览器授权就能恢复，不用删账户，邮件与本机缓存都在。</>}
        </p>
        <div className="mail-form">
          {provider
            ? <OAuthClientSection provider={provider} creds={creds} />
            : <div className="mail-error-box"><AlertTriangle size={15} /> 该平台不支持 OAuth，请删除账户后用授权码方式重新添加。</div>}
          {error && <div className="mail-error-box"><AlertTriangle size={15} /> {displayMailError(error)}</div>}
          <div className="mail-form-actions">
            <button className="btn ghost" onClick={busy ? cancel : onClose}>{busy ? '取消授权' : '取消'}</button>
            <button className="btn primary" disabled={!!busy || !provider} onClick={() => void run()}>
              {busy ? <Loader2 size={14} className="spin" /> : <Globe size={14} />} {busy || '连接并授权'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------- 一键删除全部邮件（两次确认） ----------------
// v0.1.466：弹窗打开即用本地同步快照渲染（不再等连服务器统计才出现内容），服务器
// 核对并发进行、逐行替换并标注；执行阶段是逐账户状态列表 + 总进度 + 当前步骤，
// 带「取消删除」（当前批次后停住，已删/未删如实汇报）。两次确认结构不变：删除只在
// 第二次确认点击后才启动，关弹窗不触发删除。

type DeleteRunStatus = 'waiting' | 'deleting' | 'done' | 'failed' | 'cancelled' | 'not-started'

interface DeleteRunRow {
  status: DeleteRunStatus
  deleted: number
  target: number
  step: string
  folderLabel?: string
  error?: string
}

function DeleteAllModal({ metas, pwd, notify, onClose, onDone, singleAccount }: {
  metas: MailAccountMeta[]
  pwd: string
  notify: (msg: string) => void
  onClose: () => void
  onDone: () => void
  /** v0.1.466：单账户模式（metas 只含这一个账户）——标题/文案写明「本账户」，流程与全局完全共用 */
  singleAccount?: MailAccountMeta
}) {
  const [stage, setStage] = useState<'preview' | 'confirm' | 'running' | 'done'>('preview')
  const [entries, setEntries] = useState<MailDeleteAllPreviewEntry[]>(() => mailDeleteAllSnapshot(metas))
  const [verifying, setVerifying] = useState(true)
  const [reports, setReports] = useState<MailDeleteAllReport[]>([])
  const [runRows, setRunRows] = useState<Record<string, DeleteRunRow>>({})
  const [cancelling, setCancelling] = useState(false)
  const cancelTokenRef = useRef<MailDeleteCancelToken>({ cancelled: false })

  useEffect(() => {
    let dead = false
    mailDeleteAllPreview(metas, pwd, entry => {
      if (dead) return
      setEntries(prev => prev.map(e => (e.account.id === entry.account.id ? entry : e)))
    }).then(p => {
      if (dead) return
      setEntries(p.perAccount)
      setVerifying(false)
    }).catch(() => { if (!dead) setVerifying(false) })
    return () => { dead = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const total = entries.reduce((a, e) => a + (e.error ? 0 : e.total), 0)

  const modeText = (mode: 'trash' | 'permanent' | 'mixed') =>
    mode === 'trash' ? '移入垃圾箱' : mode === 'mixed' ? '先移入垃圾箱，垃圾箱内彻底删除' : '彻底删除（无垃圾箱或已在垃圾箱）'

  const runDelete = async () => {
    const rows: Record<string, DeleteRunRow> = {}
    for (const m of metas) {
      const e = entries.find(x => x.account.id === m.id)
      rows[m.id] = { status: 'waiting', deleted: 0, target: e && !e.error ? e.total : 0, step: '等待开始' }
    }
    setRunRows(rows)
    cancelTokenRef.current = { cancelled: false }
    setCancelling(false)
    setStage('running')
    const result = await mailDeleteAll(metas, pwd, {
      cancelToken: cancelTokenRef.current,
      onEvent: ev => {
        setRunRows(prev => {
          const row = prev[ev.accountId]
          if (!row) return prev
          const next = { ...row }
          switch (ev.type) {
            case 'account-start': next.status = 'deleting'; next.step = '正在连接服务器…'; break
            case 'folder-start': next.folderLabel = ev.folderLabel; next.step = `正在删除「${ev.folderLabel}」…`; break
            case 'batch': next.deleted = ev.deletedInAccount; next.step = `正在删除「${next.folderLabel ?? ev.folder}」第 ${ev.batchIndex}/${ev.batchCount} 批`; break
            case 'account-done': next.status = 'done'; next.deleted = ev.deleted; next.step = '已完成'; break
            case 'account-error': next.status = 'failed'; next.deleted = ev.deleted; next.error = ev.error; next.step = '失败'; break
            case 'account-cancelled': next.status = 'cancelled'; next.deleted = ev.deleted; next.step = '已停止'; break
          }
          return { ...prev, [ev.accountId]: next }
        })
      },
    })
    // 未开始的账户（取消时还没轮到）事件里不会出现，按报告补齐行状态
    setRunRows(prev => {
      const nextRows = { ...prev }
      for (const r of result) {
        if (r.notStarted && nextRows[r.accountId]) nextRows[r.accountId] = { ...nextRows[r.accountId], status: 'not-started', step: '未开始' }
      }
      return nextRows
    })
    setReports(result)
    setStage('done')
    onDone()
    const deletedSum = result.reduce((a, r) => a + r.deleted, 0)
    const wasCancelled = result.some(r => r.cancelled || r.notStarted)
    const failed = result.filter(r => r.error)
    if (wasCancelled) notify(`已取消删除：共删 ${deletedSum} 封，其余邮件未动`)
    else if (failed.length) notify(`删除完成，但 ${failed.length} 个账户有失败：${failed[0].error}`)
    else notify(`已删除全部邮件，共 ${deletedSum} 封`)
  }

  const runDeleted = Object.values(runRows).reduce((a, r) => a + r.deleted, 0)
  const runTarget = Object.values(runRows).reduce((a, r) => a + r.target, 0)
  const runPercent = runTarget > 0 ? Math.min(100, Math.round((runDeleted / runTarget) * 100)) : 0
  const anyCancelled = reports.some(r => r.cancelled || r.notStarted)

  const runStatusText = (row: DeleteRunRow) => {
    switch (row.status) {
      case 'waiting': return <span className="mail-modal-count">等待开始</span>
      case 'deleting': return <span className="mail-modal-count"><Loader2 size={13} className="spin" /> {row.step} · 已删 {row.deleted}{row.target > 0 ? ` / ${row.target}` : ''} 封</span>
      case 'done': return <span className="mail-modal-count"><CheckCircle2 size={13} /> 已删 {row.deleted} 封</span>
      case 'failed': return <span className="mail-modal-err">失败：{row.error}（已删 {row.deleted} 封）</span>
      case 'cancelled': return <span className="mail-modal-count">已停止 · 已删 {row.deleted} 封</span>
      case 'not-started': return <span className="mail-modal-count">未开始</span>
    }
  }

  return (
    <div className="mail-modal-backdrop" onClick={stage === 'running' ? undefined : onClose}>
      <div className="mail-modal" onClick={e => e.stopPropagation()}>
        <div className="mail-modal-head">
          <AlertTriangle size={18} className="mail-modal-warn" />
          <h4>{singleAccount ? '删除本账户全部邮件' : '一键删除全部邮件'}</h4>
          <span className="mail-topbar-spacer" />
          {stage !== 'running' && <button className="btn sm ghost" onClick={onClose}><X size={14} /></button>}
        </div>
        {(stage === 'preview' || stage === 'confirm') && (
          <>
            <p className="mail-modal-desc">
              {singleAccount
                ? <>将删除「{mailPlatform(singleAccount.platformId).name} · {singleAccount.email}」<b>这一个账户的全部邮件</b>，共 <b>{total} 封</b>（含收件箱、已发送、草稿、垃圾箱等全部文件夹）。只删邮件，账户与凭据保留、不删账户。删除方式按平台实际支持：</>
                : <>将删除 <b>{entries.length} 个账户</b>、共 <b>{total} 封</b>邮件（含收件箱、已发送、草稿、垃圾箱等全部文件夹）。账户与凭据保留，不删账户。删除方式按各平台实际支持：</>}
              {verifying && <><br />封数正在与服务器核对（逐行更新中），不必等核对完——删除会覆盖全部邮件，计数只作知情。</>}
            </p>
            <div className="mail-modal-list">
              {entries.map(e => (
                <div key={e.account.id} className="mail-modal-row">
                  <span className="mail-modal-email">{mailPlatform(e.account.platformId).name} · {e.account.email}</span>
                  {e.error
                    ? <span className="mail-modal-err">连接失败：{e.error}</span>
                    : <span className="mail-modal-count">{e.total} 封 · {modeText(e.mode)} · {e.source === 'verified' ? '已核对' : '本地同步快照'}</span>}
                </div>
              ))}
            </div>
            {stage === 'preview' && (
              <div className="mail-modal-actions">
                <button className="btn ghost" onClick={onClose}>取消</button>
                <button className="btn danger" disabled={total === 0} onClick={() => setStage('confirm')}>继续删除</button>
              </div>
            )}
            {stage === 'confirm' && (
              <>
                <div className="mail-error-box"><AlertTriangle size={15} /> 最后确认：这一步执行后，被彻底删除的邮件无法恢复；移入垃圾箱的邮件可在邮箱网页版的垃圾箱里找回（自动清空前）。{verifying && <>（封数仍在核对中，当前 {total} 封；删除将覆盖全部邮件。）</>}</div>
                <div className="mail-modal-actions">
                  <button className="btn ghost" onClick={() => setStage('preview')}>返回</button>
                  <button className="btn danger" onClick={() => void runDelete()}>{singleAccount ? `确认删除本账户全部 ${total} 封` : `确认删除全部 ${total} 封`}</button>
                </div>
              </>
            )}
          </>
        )}
        {stage === 'running' && (
          <>
            <div className="mail-delete-progress">
              <div className="mail-delete-progress-head">
                <span>已删 {runDeleted} / 共 {runTarget} 封（{runPercent}%）</span>
                {cancelling && <span>正在停止…（当前批次完成后停住）</span>}
              </div>
              <div className="mail-delete-progress-bar"><div style={{ width: `${runPercent}%` }} /></div>
            </div>
            <div className="mail-modal-list">
              {metas.map(m => {
                const row = runRows[m.id]
                return (
                  <div key={m.id} className="mail-modal-row">
                    <span className="mail-modal-email">{mailPlatform(m.platformId).name} · {m.email}</span>
                    {row ? runStatusText(row) : <span className="mail-modal-count">等待开始</span>}
                  </div>
                )
              })}
            </div>
            <div className="mail-modal-actions">
              <button className="btn danger" disabled={cancelling} onClick={() => { cancelTokenRef.current.cancelled = true; setCancelling(true) }}>取消删除</button>
            </div>
          </>
        )}
        {stage === 'done' && (
          <>
            {anyCancelled && <p className="mail-modal-desc">已取消删除：共删 {reports.reduce((a, r) => a + r.deleted, 0)} 封，其余邮件未动。明细如下：</p>}
            <div className="mail-modal-list">
              {reports.map(r => (
                <div key={r.accountId} className="mail-modal-row">
                  <span className="mail-modal-email">{r.email}</span>
                  {r.error
                    ? <span className="mail-modal-err">失败：{r.error}{r.deleted > 0 ? `（已删 ${r.deleted} 封）` : ''}</span>
                    : r.notStarted
                      ? <span className="mail-modal-count">未开始（已取消）</span>
                      : r.cancelled
                        ? <span className="mail-modal-count">已停止 · 已删 {r.deleted} 封</span>
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
