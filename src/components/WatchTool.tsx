// 工坊 · 看剧（v0.1.386）：AI 找剧 + 热门推荐（TMDB）+ 短剧专区 + 直播 + 追剧日历 + 片单。
// 播放：App 内嵌播放器（官方播放页 iframe；直播走 HLS/m3u8，hls.js 兜底）。
// 直播只用 iptv-org 与 Free-TV 内置源 + 用户自定义源；绝不内置第三方转播源。
// 来源标注（v0.1.387）：内置源中国切片里混有第三方转播流（裸 IP），不拦截、
// 不过滤，只在卡片、播放器、分区顶部三处标注「未授权转播」。
// 各分区可展开折叠（本机记忆）、列表每页 8 条；片单与排期只存本机。
import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft, ChevronDown, CircleAlert, Clapperboard, ExternalLink,
  Film, Loader2, Lock, Play, Plus, RefreshCw, Search, Trash2, Tv, X,
  CalendarDays, BookmarkPlus, Minus, Check,
} from 'lucide-react'
import Hls from 'hls.js'
import { useRouteData, RouteSelect } from './WorkshopView'
import { runWorkshopChat } from '../core/workshopChat'
import { Pager } from './Pager'
import { openExternal } from '../core/openExternal'
import { getBiometricPassword } from '../core/crypto'
import {
  COUNTRIES, CONTENT_LABELS, ORIGIN_LABELS,
  loadCountryChannels, groupChannels,
  isUnofficialStreamUrl, isChannelUnofficial,
  loadWatchlist, saveWatchlist, loadContinue, upsertContinue, saveContinue,
  loadClosedGroups, saveClosedGroups,
  loadCustomSources, saveCustomSources, fetchSourceSet,
  hasTmdbKey, loadTmdbKey, saveTmdbKey, clearTmdbKey,
  fetchTmdbTrending, fetchTmdbProviders,
  type LiveChannel, type WatchItem, type WatchType, type ContinueItem,
  type CustomSource, type SourceSetResult, type TmdbTitle, type StationOrigin,
} from '../core/watch'
import { pageSlice, pageCount } from '../core/freeGames'
import type { Account } from '../core/types'

/** 缓存时间文案：刚刚 / N 小时前 */
function cacheAgeText(at?: number): string {
  if (!at) return ''
  const h = Math.floor((Date.now() - at) / 3600000)
  return h < 1 ? '刚刚' : `${h} 小时前`
}

// ---------------- 播放器 ----------------

type PlayerState =
  | { kind: 'hls'; title: string; channelKey: string; urls: string[] }
  | { kind: 'iframe'; title: string; url: string }
  | { kind: 'blocked'; title: string; url: string; reason: string }
  | null

/** 明确拦内嵌播放的平台（点开直接给提示，不假装能播） */
const BLOCKED_HOSTS = ['iqiyi.com', 'mgtv.com']

export function isBlockedEmbed(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return BLOCKED_HOSTS.some(h => host === h || host.endsWith(`.${h}`))
  } catch { return false }
}

function HlsPlayer({ title, urls, onOpened }: {
  title: string
  urls: string[]
  /** 关闭时回传播放进度（0–1）；内部只调一次，避免重复写继续观看 */
  onOpened: (progress: number) => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [idx, setIdx] = useState(0)
  const [failed, setFailed] = useState(false)
  const [needTap, setNeedTap] = useState(false)
  const playedRef = useRef(false)
  const idxRef = useRef(0)
  idxRef.current = idx

  const advance = () => {
    if (idxRef.current + 1 >= urls.length) { setFailed(true); return }
    setIdx(i => i + 1)
  }

  useEffect(() => {
    const video = videoRef.current
    if (!video || failed) return
    const url = urls[idx]
    if (!url) { setFailed(true); return }
    playedRef.current = false
    setNeedTap(false)
    let hls: Hls | null = null
    let dead = false
    const onPlaying = () => { playedRef.current = true }
    const onVideoError = () => { if (!dead) advance() }
    video.addEventListener('playing', onPlaying)
    video.addEventListener('error', onVideoError)
    // 15 秒还没出声出画面，判定该源不可用，自动换下一个
    const stallTimer = window.setTimeout(() => { if (!dead && !playedRef.current) advance() }, 15000)
    if (Hls.isSupported()) {
      hls = new Hls({ maxBufferLength: 30 })
      hls.loadSource(url)
      hls.attachMedia(video)
      hls.on(Hls.Events.ERROR, (_e, data) => { if (!dead && data.fatal) advance() })
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => { if (!dead) setNeedTap(true) })
      })
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url
      video.play().catch(() => { if (!dead) setNeedTap(true) })
    } else {
      setFailed(true)
    }
    return () => {
      dead = true
      window.clearTimeout(stallTimer)
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('error', onVideoError)
      // 切台/切源/关闭时先停掉上一个播放器的加载，避免多路流同时占带宽
      hls?.destroy()
      video.pause()
      video.removeAttribute('src')
      video.load()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, urls.join('|'), failed])

  const close = () => {
    const v = videoRef.current
    if (v && Number.isFinite(v.duration) && v.duration > 0) onOpened(v.currentTime / v.duration)
    else onOpened(0)
  }

  // 当前正在播的源是第三方转播（未授权）时提示；自动换到官方源后提示消失
  const curUnofficial = isUnofficialStreamUrl(urls[idx] ?? '')

  return (
    <div className="wt-player">
      <div className="wt-player-head">
        <span className="wt-player-title"><Tv size={15} /> {title}</span>
        <span className="fg-muted">正在用第 {Math.min(idx + 1, urls.length)} / {urls.length} 个源{urls.length > 1 ? '（播不了自动换）' : ''}</span>
        <button className="btn sm ghost" onClick={close}><X size={14} /> 关闭</button>
      </div>
      {failed ? (
        <div className="wt-player-fail">
          <CircleAlert size={18} />
          <div>这个台试了 {urls.length} 个源都播不了：源可能已失效，或被网络拦截。</div>
          <div className="fg-muted">可以换个台试试，或换个网络节点后点台名重播。</div>
          <button className="btn sm" onClick={() => { setFailed(false); setIdx(0) }}>再试一次</button>
        </div>
      ) : (
        <div className="wt-video-wrap">
          <video ref={videoRef} className="wt-video" controls playsInline />
          {needTap && (
            <button className="wt-bigplay" onClick={() => { videoRef.current?.play().catch(() => {}); setNeedTap(false) }}>
              <Play size={26} /> 点一下开始播放
            </button>
          )}
        </div>
      )}
      {curUnofficial && (
        <div className="wt-unofficial-note"><CircleAlert size={13} /> 当前源为第三方转播 · 未经授权，可能随时失效</div>
      )}
    </div>
  )
}

function IframePlayer({ title, url, onClose }: { title: string; url: string; onClose: () => void }) {
  const [loaded, setLoaded] = useState(false)
  return (
    <div className="wt-player">
      <div className="wt-player-head">
        <span className="wt-player-title"><Clapperboard size={15} /> {title}</span>
        <span className="fg-muted">官方播放页嵌进 App 里播</span>
        <button className="btn sm ghost" onClick={onClose}><X size={14} /> 关闭</button>
      </div>
      <div className="wt-iframe-wrap">
        {!loaded && <div className="wt-iframe-loading"><Loader2 size={16} className="spin" /> 正在打开官方播放页…</div>}
        <iframe className="wt-iframe" title={title} src={url} allow="autoplay; fullscreen" allowFullScreen
          onLoad={() => setLoaded(true)} />
      </div>
      <div className="wt-player-foot">
        <span className="fg-muted">部分平台会拦内嵌播放：如果一直黑屏或打不开，点下面用浏览器打开。</span>
        <button className="btn sm" onClick={() => void openExternal(url)}><ExternalLink size={13} /> 在浏览器打开</button>
      </div>
    </div>
  )
}

function BlockedPlayer({ title, url, reason, onClose, onAddCalendar }: {
  title: string; url: string; reason: string; onClose: () => void; onAddCalendar: () => void
}) {
  return (
    <div className="wt-player">
      <div className="wt-player-head">
        <span className="wt-player-title"><Clapperboard size={15} /> {title}</span>
        <button className="btn sm ghost" onClick={onClose}><X size={14} /> 关闭</button>
      </div>
      <div className="wt-player-fail">
        <CircleAlert size={18} />
        <div>{reason}</div>
        <div className="fg-muted">该平台不支持内嵌播放，请在官方 App 观看。</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn sm primary" onClick={() => void openExternal(url)}><ExternalLink size={13} /> 打开官方 App / 网页</button>
          <button className="btn sm" onClick={onAddCalendar}><CalendarDays size={13} /> 加入追剧日历</button>
        </div>
      </div>
    </div>
  )
}

// ---------------- AI 找剧 ----------------

interface AiRec { title: string; platform: string; type: string; reason: string }

function parseAiRecs(text: string): { intro: string; items: AiRec[] } | null {
  const m = /```json\s*([\s\S]*?)```/.exec(text) ?? /(\[[\s\S]*\])/.exec(text)
  if (!m) return null
  try {
    const arr = JSON.parse(m[1]) as unknown
    if (!Array.isArray(arr)) return null
    const items = arr
      .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
      .map(x => ({
        title: String(x.title ?? '').trim(),
        platform: String(x.platform ?? '未注明').trim(),
        type: String(x.type ?? '剧集').trim(),
        reason: String(x.reason ?? '').trim(),
      }))
      .filter(x => x.title)
      .slice(0, 8)
    if (!items.length) return null
    const intro = text.slice(0, m.index).trim()
    return { intro, items }
  } catch { return null }
}

const MOODS = ['想放松', '想哭一场', '烧脑悬疑', '轻松下饭', '热血燃', '睡前看点短的']
const GENRES = ['悬疑', '爱情', '喜剧', '古装', '科幻', '纪录片', '短剧']

export function WatchTool({ accounts, sessionPwd, onUnlock, notify, onBack }: {
  accounts: Account[]
  sessionPwd: string
  onUnlock: (pwd: string) => void
  notify: (m: string, kind?: 'ok' | 'err') => void
  onBack: () => void
}) {
  const { data, route, routeKey, setRouteKey } = useRouteData(accounts)
  const [closedGroups, setClosedGroups] = useState<string[]>(loadClosedGroups)
  const [pwdInput, setPwdInput] = useState('')
  const [player, setPlayer] = useState<PlayerState>(null)
  const [playerKey, setPlayerKey] = useState(0)

  const toggleGroup = (id: string) => setClosedGroups(prev => {
    const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    saveClosedGroups(next)
    return next
  })

  const [watchlist, setWatchlist] = useState<WatchItem[]>(loadWatchlist)
  const [continueList, setContinueList] = useState<ContinueItem[]>(loadContinue)

  const updateWatchlist = (next: WatchItem[]) => { setWatchlist(next); saveWatchlist(next) }
  const addToWatchlist = (item: Omit<WatchItem, 'id' | 'addedAt' | 'status'> & { status?: WatchItem['status'] }) => {
    if (watchlist.some(w => w.title === item.title)) { notify(`「${item.title}」已在片单里`); return }
    const full: WatchItem = { ...item, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, status: item.status ?? 'todo', addedAt: Date.now() }
    updateWatchlist([full, ...watchlist])
    notify(`已加入片单：「${item.title}」`)
  }
  const removeFromWatchlist = (id: string) => updateWatchlist(watchlist.filter(w => w.id !== id))
  const bumpEpisode = (id: string, delta: number) => updateWatchlist(watchlist.map(w =>
    w.id === id ? { ...w, episode: Math.max(0, (w.episode ?? 0) + delta), status: 'watching' as const } : w))
  const cycleStatus = (id: string) => updateWatchlist(watchlist.map(w =>
    w.id === id ? { ...w, status: w.status === 'todo' ? 'watching' : w.status === 'watching' ? 'done' : 'todo' } : w))

  const openHls = (ch: LiveChannel) => {
    setPlayer({ kind: 'hls', title: ch.name, channelKey: ch.key, urls: ch.urls })
    setPlayerKey(k => k + 1)
  }
  const recordContinue = (id: string, title: string, platform: string, kind: 'hls' | 'iframe', url: string, progress: number) => {
    setContinueList(upsertContinue({ id, title, platform, kind, url, progress, updatedAt: Date.now() }))
  }
  const openIframe = (title: string, url: string) => {
    if (isBlockedEmbed(url)) {
      setPlayer({ kind: 'blocked', title, url, reason: '该平台不支持内嵌播放' })
    } else {
      setPlayer({ kind: 'iframe', title, url })
      try { recordContinue(`iframe:${url}`, title, new URL(url).hostname, 'iframe', url, 0) } catch { /* 忽略 */ }
    }
    setPlayerKey(k => k + 1)
  }

  const closePlayer = (progress = 0) => {
    if (player?.kind === 'hls') {
      recordContinue(`live:${player.channelKey}`, player.title, '直播', 'hls', player.urls[0], progress)
    }
    setPlayer(null)
  }

  // ---- AI 找剧 ----
  const [aiQuery, setAiQuery] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [aiIntro, setAiIntro] = useState('')
  const [aiRecs, setAiRecs] = useState<AiRec[]>([])
  const [aiRaw, setAiRaw] = useState('')

  const runAi = async (query: string, scope?: string) => {
    if (!route) { notify('先选一个可用模型'); return }
    const q = query.trim()
    if (!q) { notify('先说一句想看什么'); return }
    setAiBusy(true); setAiRecs([]); setAiIntro(''); setAiRaw('')
    try {
      const out = await runWorkshopChat({
        route, freeOptions: data?.freeOptions ?? [], accounts, sessionPwd,
        system: `你是追剧推荐助手。只推荐真实存在、能在正版平台看的剧/电影/短剧（爱奇艺、腾讯视频、优酷、芒果TV、哔哩哔哩、红果短剧、抖音、快手、Netflix、Disney+ 等）；每部写清在哪个平台播、一句话推荐理由；不要编造不存在的剧名、评分与简介，不确定的写“需核实”。输出格式：先写一句简短导语，然后只输出一个 \`\`\`json 代码块，内容是数组，每项 {"title":"剧名","platform":"平台","type":"剧集/电影/短剧","reason":"一句话理由"}，最多 6 部。${scope ? `本次范围：${scope}。` : ''}`,
        user: `我想看：${q}`,
      })
      setAiRaw(out)
      const parsed = parseAiRecs(out)
      if (parsed) { setAiIntro(parsed.intro); setAiRecs(parsed.items) }
    } catch (e) { notify(e instanceof Error ? e.message : '推荐失败', 'err') } finally { setAiBusy(false) }
  }

  // ---- 热门推荐（TMDB） ----
  const [tmdbKeySet, setTmdbKeySet] = useState(hasTmdbKey)
  const [tmdbInput, setTmdbInput] = useState('')
  const [tmdbBusy, setTmdbBusy] = useState(false)
  const [tmdbSaving, setTmdbSaving] = useState(false)
  const [trending, setTrending] = useState<TmdbTitle[]>([])
  const [trendingTab, setTrendingTab] = useState<'all' | 'tv' | 'movie'>('all')
  const [trendPage, setTrendPage] = useState(1)
  const [detailId, setDetailId] = useState<number | null>(null)
  const [providers, setProviders] = useState<{ name: string; link: string }[]>([])
  const [providersBusy, setProvidersBusy] = useState(false)

  const saveTmdb = async () => {
    const pwd = sessionPwd || getBiometricPassword() || ''
    if (!pwd) { notify('请先解锁保险箱，Key 要加密保存'); return }
    setTmdbSaving(true)
    try {
      await saveTmdbKey(tmdbInput, pwd)
      setTmdbKeySet(true); setTmdbInput('')
      notify('TMDB Key 已保存（加密存本机）')
    } catch (e) { notify(e instanceof Error ? e.message : '保存失败', 'err') } finally { setTmdbSaving(false) }
  }

  const loadTrending = async () => {
    const pwd = sessionPwd || getBiometricPassword() || ''
    if (!pwd) { notify('请先解锁保险箱，才能读取已保存的 TMDB Key'); return }
    setTmdbBusy(true)
    try {
      const key = await loadTmdbKey(pwd)
      if (!key) { notify('还没保存 TMDB Key', 'err'); return }
      const list = await fetchTmdbTrending(key)
      setTrending(list); setTrendPage(1)
      notify(`已加载本周热门 ${list.length} 部`)
    } catch (e) { notify(e instanceof Error ? e.message : '加载失败', 'err') } finally { setTmdbBusy(false) }
  }

  const showProviders = async (t: TmdbTitle) => {
    if (detailId === t.id) { setDetailId(null); return }
    setDetailId(t.id); setProviders([]); setProvidersBusy(true)
    try {
      const pwd = sessionPwd || getBiometricPassword() || ''
      const key = pwd ? await loadTmdbKey(pwd) : null
      if (!key) { notify('请先解锁保险箱，才能读取 TMDB Key'); return }
      setProviders(await fetchTmdbProviders(key, t.mediaType, t.id))
    } catch (e) { notify(e instanceof Error ? e.message : '加载播出平台失败', 'err') } finally { setProvidersBusy(false) }
  }

  const trendingFiltered = trending.filter(t => trendingTab === 'all' || t.mediaType === trendingTab)

  // ---- 短剧专区（官方页；已验证地址） ----
  const SHORT_PLATFORMS = [
    { name: '红果短剧', url: 'https://hongguoduanju.com/', desc: '免费短剧' },
    { name: '腾讯视频 · 微剧场', url: 'https://v.qq.com/microsite/wetheater/index.html', desc: '微短剧' },
    { name: '爱奇艺 · 短剧', url: 'https://www.iqiyi.com/minidrama/', desc: '该平台不支持内嵌播放' },
    { name: '芒果TV · 短剧', url: 'https://www.mgtv.com/', desc: '该平台不支持内嵌播放' },
    { name: '抖音', url: 'https://www.douyin.com/', desc: '短视频 / 短剧' },
    { name: '快手', url: 'https://www.kuaishou.com/', desc: '短视频 / 短剧' },
    { name: '优酷', url: 'https://www.youku.com/', desc: '短剧 / 剧集' },
  ]

  // ---- 直播 ----
  const [liveCountry, setLiveCountry] = useState('CN')
  const [liveLoading, setLiveLoading] = useState(false)
  const [liveChannels, setLiveChannels] = useState<LiveChannel[]>([])
  const [liveSets, setLiveSets] = useState<SourceSetResult[]>([])
  const [liveLoaded, setLiveLoaded] = useState(false)
  const [contentFilter, setContentFilter] = useState('all')
  const [livePages, setLivePages] = useState<Record<string, number>>({})
  const [customLabel, setCustomLabel] = useState('')
  const [customUrl, setCustomUrl] = useState('')
  const [customSources, setCustomSources] = useState<CustomSource[]>(loadCustomSources)
  const [customTesting, setCustomTesting] = useState<string | null>(null)
  const [customTestResult, setCustomTestResult] = useState('')

  const loadLive = async (country: string, force = false) => {
    setLiveLoading(true); setLiveLoaded(false)
    try {
      const { channels, sets } = await loadCountryChannels(country, { force })
      setLiveChannels(channels); setLiveSets(sets); setLiveLoaded(true)
      setContentFilter('all')
      if (!channels.length) notify('该国家/地区的源都没拉到，请检查网络后重试', 'err')
      else notify(`已加载 ${channels.length} 个台`)
    } catch (e) { notify(e instanceof Error ? e.message : '加载失败', 'err') } finally { setLiveLoading(false) }
  }

  useEffect(() => { void loadLive(liveCountry) }, [liveCountry])
  const liveGroups = groupChannels(liveChannels, liveCountry)
  const liveContents = ['all', ...liveGroups.contents]

  const addCustomSource = async () => {
    const url = customUrl.trim()
    if (!/^https?:\/\//.test(url)) { notify('请输入 http(s) 开头的 m3u 订阅链接', 'err'); return }
    const src: CustomSource = { id: `${Date.now()}`, label: customLabel.trim() || '自定义源', url, addedAt: Date.now() }
    const next = [...customSources, src]
    setCustomSources(next); saveCustomSources(next)
    setCustomLabel(''); setCustomUrl('')
    setCustomTesting(src.id)
    try {
      const { result } = await fetchSourceSet({ id: `custom-${src.id}`, label: src.label, url, country: 'WORLD' })
      if (result.ok) {
        setCustomTestResult(`「${src.label}」拉到 ${result.count} 个台，已并入直播列表`)
        void loadLive(liveCountry)
      } else {
        setCustomTestResult(`「${src.label}」拉取失败：${result.error ?? '未知错误'}`)
      }
    } catch (e) {
      setCustomTestResult(`「${src.label}」拉取失败：${e instanceof Error ? e.message : '未知错误'}`)
    } finally { setCustomTesting(null) }
  }
  const removeCustomSource = (id: string) => {
    const next = customSources.filter(s => s.id !== id)
    setCustomSources(next); saveCustomSources(next)
    notify('已删除自定义源')
  }

  // ---- 追剧日历（由片单的 nextDate 派生） ----
  const [remindTitle, setRemindTitle] = useState('')
  const [remindDate, setRemindDate] = useState('')
  const [wlTitle, setWlTitle] = useState('')
  const [wlType, setWlType] = useState<WatchType>('tv')
  const [wlPlatform, setWlPlatform] = useState('')
  const [wlDate, setWlDate] = useState('')
  const dated = watchlist.filter(w => w.nextDate).sort((a, b) => (a.nextDate! < b.nextDate! ? -1 : 1))
  const calendarMap = new Map<string, WatchItem[]>()
  for (const w of dated) {
    const arr = calendarMap.get(w.nextDate!) ?? []
    arr.push(w)
    calendarMap.set(w.nextDate!, arr)
  }
  const todayStr = new Date().toISOString().slice(0, 10)

  // ---- 分区折叠 ----
  const Section = ({ id, title, sub, count, children }: {
    id: string; title: string; sub?: string; count?: string; children: React.ReactNode
  }) => {
    const closed = closedGroups.includes(id)
    return (
      <div className="fg-group">
        <div className="fg-group-head" role="button" tabIndex={0} style={{ cursor: 'pointer', userSelect: 'none' }}
          onClick={() => toggleGroup(id)} title={closed ? '展开分区' : '收起分区'}>
          <ChevronDown size={15} style={{ transform: closed ? 'rotate(-90deg)' : undefined, transition: 'transform .2s' }} />
          <span>{title}</span>
          {sub && <small>{sub}</small>}
          {count && <span className="fg-group-count">{count}</span>}
        </div>
        {!closed && <div className="wt-section-body">{children}</div>}
      </div>
    )
  }

  // 直播频道列表（内容筛选 + 分页，每页 8 条）
  const ChannelList = ({ channels, pageKey }: { channels: LiveChannel[]; pageKey: string }) => {
    const filtered = contentFilter === 'all' ? channels : channels.filter(c => c.content === contentFilter)
    const page = Math.min(livePages[pageKey] ?? 1, pageCount(filtered.length))
    const total = pageCount(filtered.length)
    if (!filtered.length) return <div className="fg-empty">这个分类下暂时没有台，换个分类或国家试试。</div>
    return (
      <>
        <div className="wt-channels">
          {pageSlice(filtered, page).map(ch => (
            <button key={ch.key} className="wt-channel" onClick={() => openHls(ch)} title={`${ch.name} · 点一下开始播放`}>
              {ch.logo && <img className="wt-channel-logo" src={ch.logo} alt="" onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />}
              <span className="wt-channel-name">{ch.name}</span>
              {isChannelUnofficial(ch) && <span className="wt-unofficial-badge">未授权转播</span>}
              <span className="wt-channel-meta">{CONTENT_LABELS[ch.content] ?? '其他'}{ch.urls.length > 1 ? ` · ${ch.urls.length} 个源` : ''}</span>
            </button>
          ))}
        </div>
        <Pager page={page} pageCount={total} total={filtered.length} unit="个台"
          onPage={n => setLivePages(prev => ({ ...prev, [pageKey]: n }))} />
      </>
    )
  }

  const [continuePage, setContinuePage] = useState(1)

  return (
    <div className="ws-tool fg-tool">
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <button className="btn sm ghost" onClick={onBack}><ArrowLeft size={14} /> 返回工坊</button>
      </div>
      <h3 className="ws-tool-title">看剧</h3>
      <p className="ws-tool-desc">AI 找剧、热门推荐、短剧、直播、追剧日历与片单；播放都在 App 内嵌播放器里，不跳浏览器。片单与排期只存本机。</p>

      {!sessionPwd && (
        <div className="fg-unlock">
          <Lock size={14} /> 保险箱未解锁：AI 找剧用已保存的免费模型没问题；保存 TMDB Key 需要主密码。
          <input className="input" type="password" placeholder="保险箱主密码" value={pwdInput}
            onChange={e => setPwdInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') onUnlock(pwdInput) }} />
          <button className="btn sm primary" onClick={() => onUnlock(pwdInput)}>解锁</button>
        </div>
      )}

      {player?.kind === 'hls' && (
        <HlsPlayer key={playerKey} title={player.title} urls={player.urls}
          onOpened={p => closePlayer(p)} />
      )}
      {player?.kind === 'iframe' && (
        <IframePlayer key={playerKey} title={player.title} url={player.url} onClose={() => setPlayer(null)} />
      )}
      {player?.kind === 'blocked' && (
        <BlockedPlayer key={playerKey} title={player.title} url={player.url} reason={player.reason}
          onClose={() => setPlayer(null)}
          onAddCalendar={() => { addToWatchlist({ title: player.title, type: 'tv', platform: '官方 App', platformUrl: player.url }); setPlayer(null) }} />
      )}

      {/* AI 找剧 */}
      <Section id="ai" title="AI 找剧" sub="免费模型推荐 · 只推正版平台" count={aiRecs.length ? `${aiRecs.length} 部` : undefined}>
        <div className="wt-ai-row">
          <input className="input" placeholder="一句话说说想看什么，如：最近有什么好看的悬疑剧"
            value={aiQuery} onChange={e => setAiQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void runAi(aiQuery) }} />
          <button className="btn sm primary" disabled={aiBusy} onClick={() => void runAi(aiQuery)}>
            {aiBusy ? <Loader2 size={13} className="spin" /> : <Search size={13} />} 找剧
          </button>
        </div>
        <div className="wt-chips">
          <span className="fg-muted">心情：</span>
          {MOODS.map(m => <button key={m} className="wt-chip" onClick={() => { setAiQuery(m); void runAi(m) }}>{m}</button>)}
        </div>
        <div className="wt-chips">
          <span className="fg-muted">类型：</span>
          {GENRES.map(g => <button key={g} className="wt-chip" onClick={() => { setAiQuery(g); void runAi(g) }}>{g}</button>)}
        </div>
        <div className="wt-route"><RouteSelect data={data} routeKey={routeKey} setRouteKey={setRouteKey} /></div>
        {aiIntro && <div className="wt-ai-intro">{aiIntro}</div>}
        {aiRecs.length > 0 && (
          <div className="fg-grid">
            {aiRecs.map(r => (
              <div key={r.title} className="fg-card wt-rec-card">
                <div className="fg-card-title">{r.title}</div>
                <div className="fg-muted">{r.type} · {r.platform}</div>
                <div className="wt-rec-reason">{r.reason}</div>
                <button className="btn sm" onClick={() => addToWatchlist({ title: r.title, type: r.type === '电影' ? 'movie' : r.type === '短剧' ? 'short' : 'tv', platform: r.platform })}>
                  <BookmarkPlus size={13} /> 加入片单
                </button>
              </div>
            ))}
          </div>
        )}
        {!aiRecs.length && aiRaw && (
          <div className="wt-ai-raw">{aiRaw}</div>
        )}
        {aiBusy && <div className="fg-muted"><Loader2 size={13} className="spin" /> 正在想推荐…</div>}
      </Section>

      {/* 热门推荐 */}
      <Section id="trending" title="热门推荐" sub="TMDB 本周热门 · 需填 Key 才显示海报" count={trending.length ? `${trending.length} 部` : undefined}>
        {!tmdbKeySet ? (
          <div className="fg-empty">
            <div>还没填 TMDB API Key：热门榜单需要 Key 才能调用（TMDB 免费注册）。不填也可以用 AI 找剧与直播。</div>
            <input className="input" type="password" placeholder="粘贴 TMDB API Key（v3 auth 密钥）" value={tmdbInput}
              onChange={e => setTmdbInput(e.target.value)} />
            <button className="btn sm primary" disabled={tmdbSaving || !tmdbInput.trim()} onClick={() => void saveTmdb()}>
              {tmdbSaving ? <Loader2 size={13} className="spin" /> : <Lock size={13} />} 保存 Key（加密存本机）
            </button>
          </div>
        ) : trending.length === 0 ? (
          <div className="fg-empty">
            <div>已保存 TMDB Key。点下面加载本周热门（剧集 + 电影）。</div>
            <button className="btn sm primary" disabled={tmdbBusy} onClick={() => void loadTrending()}>
              {tmdbBusy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} 加载热门榜单
            </button>
            <button className="btn sm ghost" onClick={() => { clearTmdbKey(); setTmdbKeySet(false); setTrending([]) }}>清除 Key</button>
          </div>
        ) : (
          <>
            <div className="wt-chips">
              {(['all', 'tv', 'movie'] as const).map(t => (
                <button key={t} className={`wt-chip${trendingTab === t ? ' on' : ''}`}
                  onClick={() => { setTrendingTab(t); setTrendPage(1) }}>
                  {t === 'all' ? '全部' : t === 'tv' ? '剧集' : '电影'}
                </button>
              ))}
              <button className="btn sm ghost" onClick={() => void loadTrending()}><RefreshCw size={13} /> 刷新</button>
            </div>
            <div className="fg-grid">
              {pageSlice(trendingFiltered, trendPage).map(t => (
                <div key={`${t.mediaType}-${t.id}`} className="fg-card wt-trend-card">
                  {t.poster
                    ? <img className="wt-poster" src={t.poster} alt={t.title} loading="lazy" onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                    : <div className="wt-poster-ph"><Film size={20} /></div>}
                  <div className="fg-card-title">{t.title}</div>
                  <div className="fg-muted">{t.mediaType === 'tv' ? '剧集' : '电影'}{t.firstDate ? ` · ${t.firstDate}` : ''}{typeof t.vote === 'number' ? ` · ${t.vote} 分` : ''}</div>
                  {t.overview && <div className="wt-rec-reason">{t.overview}</div>}
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button className="btn sm" onClick={() => void showProviders(t)}>
                      {detailId === t.id ? '收起' : '在哪看'}
                    </button>
                    <button className="btn sm" onClick={() => addToWatchlist({ title: t.title, type: t.mediaType === 'movie' ? 'movie' : 'tv', platform: 'TMDB 热门', poster: t.poster, overview: t.overview })}>
                      <BookmarkPlus size={13} /> 加入片单
                    </button>
                  </div>
                  {detailId === t.id && (
                    <div className="wt-providers">
                      {providersBusy ? <span className="fg-muted"><Loader2 size={13} className="spin" /> 正在查播出平台…</span>
                        : providers.length ? providers.map(p => (
                          <button key={p.name} className="wt-chip" onClick={() => void openExternal(p.link)}>{p.name} <ExternalLink size={11} /></button>
                        )) : <span className="fg-muted">中国区暂无正版播出信息（以 TMDB 数据为准）。</span>}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <Pager page={trendPage} pageCount={pageCount(trendingFiltered.length)} total={trendingFiltered.length} unit="部"
              onPage={setTrendPage} />
          </>
        )}
      </Section>

      {/* 继续观看 */}
      <Section id="continue" title="继续观看" sub="上次看到一半的" count={continueList.length ? `${continueList.length} 条` : undefined}>
        {continueList.length === 0 ? (
          <div className="fg-empty">还没看过：直播台或短剧点开后，这里会出现继续观看的入口（带进度）。</div>
        ) : (
          <>
            <div className="fg-grid">
              {pageSlice(continueList, continuePage).map(c => (
                <div key={c.id} className="fg-card">
                  <div className="fg-card-title">{c.title}</div>
                  <div className="fg-muted">{c.platform} · {new Date(c.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
                  {c.progress > 0 && (
                    <div className="wt-progress"><div className="wt-progress-fill" style={{ width: `${Math.round(c.progress * 100)}%` }} /></div>
                  )}
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn sm primary" onClick={() => {
                      if (c.kind === 'hls') setPlayer({ kind: 'hls', title: c.title, channelKey: c.id.replace(/^live:/, ''), urls: [c.url] })
                      else openIframe(c.title, c.url)
                    }}><Play size={13} /> 继续看</button>
                    <button className="btn sm ghost" onClick={() => { const next = continueList.filter(x => x.id !== c.id); setContinueList(next); saveContinue(next) }}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <Pager page={continuePage} pageCount={pageCount(continueList.length)} total={continueList.length} unit="条"
              onPage={setContinuePage} />
          </>
        )}
      </Section>

      {/* 短剧专区 */}
      <Section id="shorts" title="短剧专区" sub="官方页内嵌播放" count={`${SHORT_PLATFORMS.length} 个平台`}>
        <div className="fg-grid">
          {SHORT_PLATFORMS.map(p => (
            <button key={p.name} className="fg-card wt-plat-card" onClick={() => openIframe(p.name, p.url)}>
              <div className="fg-card-title"><Clapperboard size={15} /> {p.name}</div>
              <div className="fg-muted">{p.desc}</div>
              <span className="fg-muted">点开即播 <ExternalLink size={11} /></span>
            </button>
          ))}
        </div>
        <div className="wt-chips">
          <span className="fg-muted">想找短剧？</span>
          <button className="wt-chip" onClick={() => { setAiQuery('好看的短剧'); void runAi('好看的短剧', '只推荐短剧') }}>AI 找短剧</button>
        </div>
      </Section>

      {/* 直播 */}
      <Section id="live" title="直播" sub="iptv-org + Free-TV 内置源 · 一个播不了自动换下一个" count={liveLoaded ? `${liveChannels.length} 个台` : undefined}>
        <div className="wt-chips">
          {COUNTRIES.map(c => (
            <button key={c.code} className={`wt-chip${liveCountry === c.code ? ' on' : ''}`}
              onClick={() => setLiveCountry(c.code)}>{c.label}</button>
          ))}
          <button className="btn sm ghost" disabled={liveLoading} onClick={() => void loadLive(liveCountry, true)}>
            <RefreshCw size={13} /> {liveLoading ? '加载中…' : '重新加载'}
          </button>
          <button className="btn sm ghost" onClick={() => openIframe('央视官网直播间', 'https://tv.cctv.com/live/')}>
            <ExternalLink size={13} /> 央视官网直播间
          </button>
        </div>
        <div className="wt-unofficial-note"><CircleAlert size={13} /> 部分频道为第三方转播、未经授权，随时可能失效；带「未授权转播」角标的即是，官方源不受影响。</div>
        {liveLoaded && (
          <div className="wt-set-status">
            {liveSets.map(s => (
              <span key={s.setId} className="fg-muted">
                {s.label}：{s.ok ? `${s.count} 个台${s.cached ? `（缓存${cacheAgeText(s.cachedAt)}，24 小时内不重新拉）` : ''}` : `失败：${s.error ?? '未知错误'}`}
              </span>
            ))}
            <span className="fg-muted">自定义源优先于内置源；同名台自动合并多条地址。</span>
          </div>
        )}
        {!liveLoaded && liveLoading && <div className="fg-muted"><Loader2 size={13} className="spin" /> 正在拉取频道列表…</div>}
        {liveLoaded && (
          <>
            <div className="wt-chips">
              <span className="fg-muted">内容：</span>
              {liveContents.map(c => (
                <button key={c} className={`wt-chip${contentFilter === c ? ' on' : ''}`}
                  onClick={() => setContentFilter(c)}>
                  {c === 'all' ? '全部' : CONTENT_LABELS[c] ?? c}
                </button>
              ))}
            </div>
            {liveCountry === 'CN' ? (
              liveGroups.origins.map(g => {
                const gid = `live-cn-${g.key}`
                const closed = closedGroups.includes(gid)
                return (
                  <div key={g.key} className="wt-origin">
                    <div className="fg-group-head" role="button" tabIndex={0} style={{ cursor: 'pointer', userSelect: 'none' }}
                      onClick={() => toggleGroup(gid)}>
                      <ChevronDown size={14} style={{ transform: closed ? 'rotate(-90deg)' : undefined, transition: 'transform .2s' }} />
                      <span>{ORIGIN_LABELS[g.key as StationOrigin]}</span>
                      <span className="fg-group-count">{g.channels.length} 个台</span>
                    </div>
                    {!closed && <ChannelList channels={g.channels} pageKey={`cn-${g.key}-${contentFilter}`} />}
                  </div>
                )
              })
            ) : (
              <ChannelList channels={liveChannels} pageKey={`${liveCountry}-${contentFilter}`} />
            )}
          </>
        )}
      </Section>

      {/* 追剧日历 */}
      <Section id="calendar" title="追剧日历" sub="由片单的下次更新日期派生" count={dated.length ? `${dated.length} 条` : undefined}>
        {calendarMap.size === 0 ? (
          <div className="fg-empty">还没有排期：片单里给一部剧填上「下次更新」日期，这里就会按日期列出来。</div>
        ) : (
          [...calendarMap.entries()].map(([date, items]) => (
            <div key={date} className="wt-cal-day">
              <div className="wt-cal-date">
                <CalendarDays size={14} /> {date}
                {date === todayStr && <span className="wt-today">今天</span>}
              </div>
              {items.map(w => (
                <div key={w.id} className="wt-cal-item">
                  <span>{w.title}</span>
                  <span className="fg-muted">{w.platform}{w.episode ? ` · 已看到第 ${w.episode} 集` : ''}</span>
                </div>
              ))}
            </div>
          ))
        )}
        <div className="wt-ai-row">
          <input className="input" placeholder="提醒标题，如：XX 剧更新" value={remindTitle} onChange={e => setRemindTitle(e.target.value)} />
          <input className="input" type="date" value={remindDate} onChange={e => setRemindDate(e.target.value)} />
          <button className="btn sm" disabled={!remindTitle.trim() || !remindDate} onClick={() => {
            addToWatchlist({ title: remindTitle.trim(), type: 'tv', platform: '手动提醒', nextDate: remindDate })
            setRemindTitle(''); setRemindDate('')
          }}><Plus size={13} /> 添加提醒</button>
        </div>
      </Section>

      {/* 我的片单 */}
      <Section id="watchlist" title="我的片单" sub="只存本机，不云同步" count={`${watchlist.length} 部`}>
        <div className="wt-ai-row">
          <input className="input" placeholder="剧名" value={wlTitle} onChange={e => setWlTitle(e.target.value)} />
          <select className="input" value={wlType} onChange={e => setWlType(e.target.value as WatchType)} style={{ maxWidth: 110 }}>
            <option value="tv">剧集</option>
            <option value="movie">电影</option>
            <option value="short">短剧</option>
          </select>
          <input className="input" placeholder="平台（可选）" value={wlPlatform} onChange={e => setWlPlatform(e.target.value)} />
          <input className="input" type="date" value={wlDate} onChange={e => setWlDate(e.target.value)} />
          <button className="btn sm primary" disabled={!wlTitle.trim()} onClick={() => {
            addToWatchlist({ title: wlTitle.trim(), type: wlType, platform: wlPlatform.trim() || '未注明', nextDate: wlDate || undefined })
            setWlTitle(''); setWlPlatform(''); setWlDate('')
          }}><Plus size={13} /> 加入片单</button>
        </div>
        {watchlist.length === 0 ? (
          <div className="fg-empty">片单是空的：AI 找剧、热门推荐里点「加入片单」，或上面手动加一部。</div>
        ) : (
          <div className="wt-watchlist">
            {watchlist.map(w => (
              <div key={w.id} className="wt-wl-row">
                {w.poster && <img className="wt-wl-poster" src={w.poster} alt="" loading="lazy" />}
                <div className="wt-wl-main">
                  <div className="fg-card-title">{w.title}</div>
                  <div className="fg-muted">{w.type === 'tv' ? '剧集' : w.type === 'movie' ? '电影' : '短剧'} · {w.platform}</div>
                  {w.overview && <div className="wt-rec-reason">{w.overview}</div>}
                  <div className="wt-wl-actions">
                    <button className="btn sm ghost" onClick={() => bumpEpisode(w.id, -1)} title="集数 -1"><Minus size={13} /></button>
                    <span className="fg-muted">第 {w.episode ?? 0} 集</span>
                    <button className="btn sm ghost" onClick={() => bumpEpisode(w.id, 1)} title="集数 +1"><Plus size={13} /></button>
                    <button className="btn sm" onClick={() => cycleStatus(w.id)}>
                      {w.status === 'todo' ? '待看' : w.status === 'watching' ? '在看' : '看完'}
                    </button>
                    <input className="input" type="date" value={w.nextDate ?? ''} title="下次更新日期"
                      onChange={e => updateWatchlist(watchlist.map(x => x.id === w.id ? { ...x, nextDate: e.target.value || undefined } : x))} />
                    <button className="btn sm ghost" onClick={() => removeFromWatchlist(w.id)} title="移出片单"><Trash2 size={13} /></button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* 设置：TMDB Key 与自定义源 */}
      <Section id="settings" title="设置" sub="TMDB Key · 自定义直播源">
        <div className="wt-set-row">
          <span>TMDB API Key</span>
          {tmdbKeySet
            ? <><span className="fg-muted"><Check size={13} /> 已保存（加密存本机）</span>
              <button className="btn sm ghost" onClick={() => { clearTmdbKey(); setTmdbKeySet(false); setTrending([]) }}>清除</button></>
            : <span className="fg-muted">未设置：热门推荐无海报、纯文字展示（见上方热门推荐区）。</span>}
        </div>
        <div className="wt-set-row">
          <span>自定义直播源（m3u 订阅链接）</span>
          <span className="fg-muted">自己粘贴，像 VLC 里粘地址；留空不预填任何地址。自定义源优先于内置源。</span>
        </div>
        <div className="wt-ai-row">
          <input className="input" placeholder="名称，如：我的收藏" value={customLabel} onChange={e => setCustomLabel(e.target.value)} />
          <input className="input" placeholder="粘贴 m3u 订阅链接（http(s)://…）" value={customUrl} onChange={e => setCustomUrl(e.target.value)} />
          <button className="btn sm primary" disabled={customTesting !== null || !customUrl.trim()} onClick={() => void addCustomSource()}>
            {customTesting ? <Loader2 size={13} className="spin" /> : <Plus size={13} />} 添加并拉取
          </button>
        </div>
        {customTestResult && <div className="fg-muted">{customTestResult}</div>}
        {customSources.length > 0 && (
          <div className="wt-watchlist">
            {customSources.map(s => (
              <div key={s.id} className="wt-wl-row">
                <div className="wt-wl-main">
                  <div className="fg-card-title">{s.label}</div>
                  <div className="fg-muted">{s.url}</div>
                </div>
                <button className="btn sm ghost" onClick={() => removeCustomSource(s.id)} title="删除"><Trash2 size={13} /></button>
              </div>
            ))}
          </div>
        )}
        <div className="fg-muted">内置源：iptv-org（公开免费频道目录）与 Free-TV。直播源本身可能失效：一个台播不了会自动换下一个源，全部失败会写清已试过几套。</div>
      </Section>
    </div>
  )
}
