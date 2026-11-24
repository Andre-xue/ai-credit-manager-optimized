// 工坊 · 看剧（v0.1.386）：AI 找剧 + 热门推荐（TMDB）+ 直播 + 点播 + 追剧日历 + 片单。
// 播放：App 内嵌播放器（官方播放页 iframe；直播走 HLS/m3u8，hls.js 兜底；点播走 <video>，mp4 直出、点播 m3u8 用 hls.js；
// .flv 流用 flv.js，浏览器 <video> 与 hls.js 都播不了 FLV）。
// 直播只用 iptv-org 与 Free-TV 内置源 + 用户自定义源；绝不内置第三方转播源。
// 点播（v0.1.390）：m3u 里的点播条目（电影/剧集文件）单独成区，同名剧集多条合并带选集，看到一半记进度可续播。
// 来源标注（v0.1.387）：内置源中国切片里混有第三方转播流（裸 IP），不拦截、
// 不过滤，只在卡片、播放器、分区顶部三处标注「未授权转播」；点播条目同样打标记。
// 源体检（v0.1.391）：直播页手动「开始体检」，逐台测连通性（通/不通、耗时），
// 死台标出、可过滤，快的排前面；结果缓存 30 分钟，后台跑不堵列表。
// 点播体检（v0.1.407）：与直播体检同款探针，逐部测点播线路通不通、快不快。
// 播放器失败态（v0.1.407）：流死了也不只剩一条黑条——16:9 视频区始终保留，
// 失败时区内显示原因 + 再试一次；加载中显示“正在加载…”；打开播放器时滚到视野内。
// 各分区可展开折叠（本机记忆）、列表每页 8 条；片单与排期只存本机。
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft, ChevronDown, CircleAlert, Clapperboard, ExternalLink,
  Film, Loader2, Lock, Play, Plus, RefreshCw, Search, Trash2, Tv, X,
  CalendarDays, BookmarkPlus, Minus, Check, Activity,
} from 'lucide-react'
import Hls from 'hls.js'
import FlvJs from 'flv.js'
import { useRouteData, RouteSelect } from './WorkshopView'
import { runWorkshopChat } from '../core/workshopChat'
import { Pager } from './Pager'
import { openExternal } from '../core/openExternal'
import { getBiometricPassword } from '../core/crypto'
import {
  COUNTRIES, CONTENT_LABELS, ORIGIN_LABELS,
  loadCountryChannels, groupChannels,
  isUnofficialStreamUrl, isChannelUnofficial,
  channelsToVod, vodContinueId, parseVodContinueId,
  loadWatchlist, saveWatchlist, loadContinue, upsertContinue, saveContinue,
  loadClosedGroups, saveClosedGroups,
  loadCustomSources, saveCustomSources, fetchSourceSet,
  hasTmdbKey, loadTmdbKey, saveTmdbKey, clearTmdbKey,
  fetchTmdbTrending, fetchTmdbProviders, loadRecPrefs, saveRecPrefs,
  searchTmdbTitle, fetchTmdbGenres, fetchTmdbDetails,
  normalizeTitleKey, buildVodWallItems, filterVodWall, sortVodWall, vodWallBadge,
  WALL_GENRES, WALL_YEARS, WALL_REGIONS, WALL_STATUS_FILTERS,
  loadHealthCache, saveHealthCache, probeChannels, healthOf, healthCounts, applyHealthView,
  probeVodTitles, vodHealthOf, vodHealthCounts, applyVodHealthView,
  loadShowDead, saveShowDead,
  isFlvUrl,
  type HealthMap,
  type LiveChannel, type VodTitle, type VodEpisode, type WatchItem, type WatchType, type ContinueItem,
  type CustomSource, type SourceSetResult, type TmdbTitle, type StationOrigin, type TrendRange, type RecPrefs,
  type TmdbGenreMap, type VodEnrichEntry, type VodWallItem, type VodWallSort, type VodWallStatusFilter,
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
  | { kind: 'vod'; title: string; vodKey: string; episodes: VodEpisode[]; episodeIndex: number; startAt?: number; startUrlIdx?: number }
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
  const [started, setStarted] = useState(false)
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
    setStarted(false)
    let hls: Hls | null = null
    let flvPlayer: FlvJs.Player | null = null
    let dead = false
    const onPlaying = () => { playedRef.current = true; setStarted(true) }
    const onVideoError = () => { if (!dead) advance() }
    video.addEventListener('playing', onPlaying)
    video.addEventListener('error', onVideoError)
    // 15 秒还没出声出画面，判定该源不可用，自动换下一个
    const stallTimer = window.setTimeout(() => { if (!dead && !playedRef.current) advance() }, 15000)
    if (isFlvUrl(url) && FlvJs.isSupported()) {
      // .flv 流：浏览器 <video> 与 hls.js 都播不了，走 flv.js（MSE）
      flvPlayer = FlvJs.createPlayer({ type: 'flv', url, isLive: true })
      flvPlayer.attachMediaElement(video)
      flvPlayer.load()
      flvPlayer.on(FlvJs.Events.ERROR, () => { if (!dead) advance() })
      video.play().catch(() => { if (!dead) setNeedTap(true) })
    } else if (Hls.isSupported()) {
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
      flvPlayer?.destroy()
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
      {/* v0.1.407：视频区永远保留 16:9（CSS 定高），加载中与失败都是区内覆盖层，
          失败时不再塌成一条黑条 */}
      <div className="wt-video-wrap">
        <video ref={videoRef} className="wt-video" controls playsInline />
        {!started && !failed && !needTap && (
          <div className="wt-vload"><Loader2 size={16} className="spin" /> 正在加载…</div>
        )}
        {needTap && !failed && (
          <button className="wt-bigplay" onClick={() => { videoRef.current?.play().catch(() => {}); setNeedTap(false) }}>
            <Play size={26} /> 点一下开始播放
          </button>
        )}
        {failed && (
          <div className="wt-vfail">
            <CircleAlert size={18} />
            <div>这个台试了 {urls.length} 个源都播不了：源可能已失效，或被网络拦截。</div>
            <div className="wt-vfail-sub">可以换个台试试，或换个网络节点后点台名重播。</div>
            <button className="btn sm" onClick={() => { setFailed(false); setIdx(0) }}>再试一次</button>
          </div>
        )}
      </div>
      {curUnofficial && (
        <div className="wt-unofficial-note"><CircleAlert size={13} /> 当前源为第三方转播 · 未经授权，可能随时失效</div>
      )}
    </div>
  )
}

function VodPlayer({ title, episodes, episodeIndex, startAt, startUrlIdx, onLeave, onClose }: {
  title: string
  episodes: VodEpisode[]
  episodeIndex: number
  /** 续播起点（0–1 进度），只对打开时那集有效 */
  startAt?: number
  /** 详情页选中的线路下标（默认 0）；切集后回到第 1 条线路 */
  startUrlIdx?: number
  /** 离开某集时回传（关闭 / 切集时都调）：父组件据此写继续观看 */
  onLeave: (episodeIndex: number, progress: number) => void
  onClose: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [epIdx, setEpIdx] = useState(episodeIndex)
  const [urlIdx, setUrlIdx] = useState(startUrlIdx ?? 0)
  const [failed, setFailed] = useState(false)
  const [needTap, setNeedTap] = useState(false)
  const [started, setStarted] = useState(false)
  const playedRef = useRef(false)
  const soughtRef = useRef(false)
  const ep = episodes[epIdx] ?? episodes[0]
  const url = ep?.urls[urlIdx]
  const isHlsUrl = !!url && /\.m3u8(\?.*)?$/i.test(url.split('?')[0])

  const progressNow = () => {
    const v = videoRef.current
    if (v && Number.isFinite(v.duration) && v.duration > 0) return Math.min(1, v.currentTime / v.duration)
    return 0
  }

  const switchEpisode = (i: number) => {
    if (i === epIdx || !episodes[i]) return
    onLeave(epIdx, progressNow())
    setEpIdx(i); setUrlIdx(0); setFailed(false)
  }

  const advanceUrl = () => {
    if (!ep) { setFailed(true); return }
    if (urlIdx + 1 >= ep.urls.length) { setFailed(true); return }
    setUrlIdx(i => i + 1)
  }

  useEffect(() => {
    const video = videoRef.current
    if (!video || failed || !url) { if (!url) setFailed(true); return }
    playedRef.current = false
    setNeedTap(false)
    setStarted(false)
    let hls: Hls | null = null
    let flvPlayer: FlvJs.Player | null = null
    let dead = false
    const onPlaying = () => { playedRef.current = true; setStarted(true) }
    const onVideoError = () => { if (!dead) advanceUrl() }
    const onMeta = () => {
      // 续播：只对打开时那集、只 seek 一次
      if (!soughtRef.current && epIdx === episodeIndex && startAt && startAt > 0 && startAt < 0.98
        && Number.isFinite(video.duration) && video.duration > 0) {
        soughtRef.current = true
        video.currentTime = startAt * video.duration
      }
    }
    video.addEventListener('playing', onPlaying)
    video.addEventListener('error', onVideoError)
    video.addEventListener('loadedmetadata', onMeta)
    // 15 秒还没出声出画面，判定该源不可用，自动换同一集的下一个源
    const stallTimer = window.setTimeout(() => { if (!dead && !playedRef.current) advanceUrl() }, 15000)
    if (isFlvUrl(url) && FlvJs.isSupported()) {
      // .flv 点播：浏览器 <video> 播不了，走 flv.js（MSE，点播 isLive: false）
      flvPlayer = FlvJs.createPlayer({ type: 'flv', url, isLive: false })
      flvPlayer.attachMediaElement(video)
      flvPlayer.load()
      flvPlayer.on(FlvJs.Events.ERROR, () => { if (!dead) advanceUrl() })
      video.play().catch(() => { if (!dead) setNeedTap(true) })
    } else if (isHlsUrl && Hls.isSupported()) {
      hls = new Hls({ maxBufferLength: 30 })
      hls.loadSource(url)
      hls.attachMedia(video)
      hls.on(Hls.Events.ERROR, (_e, data) => { if (!dead && data.fatal) advanceUrl() })
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => { if (!dead) setNeedTap(true) })
      })
    } else if (isHlsUrl && video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url
      video.play().catch(() => { if (!dead) setNeedTap(true) })
    } else if (!isHlsUrl) {
      // mp4/mkv 直链：原生播放
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
      video.removeEventListener('loadedmetadata', onMeta)
      flvPlayer?.destroy()
      hls?.destroy()
      video.pause()
      video.removeAttribute('src')
      video.load()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epIdx, urlIdx, failed])

  const close = () => { onLeave(epIdx, progressNow()); onClose() }
  const curUnofficial = ep?.unofficial ?? false

  return (
    <div className="wt-player">
      <div className="wt-player-head">
        <span className="wt-player-title"><Film size={15} /> {title}{episodes.length > 1 && ep ? ` · ${ep.label}` : ''}</span>
        {ep && ep.urls.length > 1 && <span className="fg-muted">正在用第 {Math.min(urlIdx + 1, ep.urls.length)} / {ep.urls.length} 个源{ep.urls.length > 1 ? '（播不了自动换）' : ''}</span>}
        <button className="btn sm ghost" onClick={close}><X size={14} /> 关闭</button>
      </div>
      {/* v0.1.407：视频区永远保留 16:9（CSS 定高），加载中与失败都是区内覆盖层 */}
      <div className="wt-video-wrap">
        <video ref={videoRef} className="wt-video" controls playsInline />
        {!started && !failed && !needTap && (
          <div className="wt-vload"><Loader2 size={16} className="spin" /> 正在加载…</div>
        )}
        {needTap && !failed && (
          <button className="wt-bigplay" onClick={() => { videoRef.current?.play().catch(() => {}); setNeedTap(false) }}>
            <Play size={26} /> 点一下开始播放
          </button>
        )}
        {failed && (
          <div className="wt-vfail">
            <CircleAlert size={18} />
            <div>这集试了 {ep?.urls.length ?? 0} 个源都播不了：源可能已失效，或被网络拦截。</div>
            <div className="wt-vfail-sub">可以换一集试试，或换个网络节点后重播。</div>
            <button className="btn sm" onClick={() => { setFailed(false); setUrlIdx(0) }}>再试一次</button>
          </div>
        )}
      </div>
      {episodes.length > 1 && (
        <div className="wt-chips">
          <span className="fg-muted">选集：</span>
          {episodes.map((e, i) => (
            <button key={i} className={`wt-chip${i === epIdx ? ' on' : ''}`} onClick={() => switchEpisode(i)}>{e.label}</button>
          ))}
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
  // v0.1.394：横向页签导航（默认热门推荐）+ AI 找剧收进标题栏右端搜索图标
  type WatchTab = 'trending' | 'continue' | 'live' | 'vod' | 'calendar' | 'watchlist' | 'settings'
  const [activeTab, setActiveTab] = useState<WatchTab>('trending')
  const [aiSearchOpen, setAiSearchOpen] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!aiSearchOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setAiSearchOpen(false) }
    window.addEventListener('keydown', onKey)
    searchInputRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [aiSearchOpen])
  const [closedGroups, setClosedGroups] = useState<string[]>(loadClosedGroups)
  const [pwdInput, setPwdInput] = useState('')
  const [player, setPlayer] = useState<PlayerState>(null)
  const [playerKey, setPlayerKey] = useState(0)
  const playerWrapRef = useRef<HTMLDivElement>(null)
  // v0.1.407：打开播放器时滚到视野内——播放器挂在页签上方，从列表/墙下方点开时不滚就看不到
  useEffect(() => {
    if (player) playerWrapRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerKey])

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
  const recordContinue = (id: string, title: string, platform: string, kind: 'hls' | 'iframe' | 'vod', url: string, progress: number, episode?: string) => {
    setContinueList(upsertContinue({ id, title, platform, kind, url, progress, episode, updatedAt: Date.now() }))
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

  // ---- 点播 ----
  const openVod = (v: VodTitle, episodeIndex = 0, startAt = 0, startUrlIdx = 0) => {
    setPlayer({ kind: 'vod', title: v.title, vodKey: v.key, episodes: v.episodes, episodeIndex: Math.min(episodeIndex, v.episodes.length - 1), startAt, startUrlIdx: Math.min(startUrlIdx, (v.episodes[Math.min(episodeIndex, v.episodes.length - 1)]?.urls.length ?? 1) - 1) })
    setPlayerKey(k => k + 1)
  }
  const recordVodLeave = (episodeIndex: number, progress: number) => {
    if (player?.kind !== 'vod') return
    const ep = player.episodes[episodeIndex]
    if (!ep) return
    const id = vodContinueId(player.vodKey, episodeIndex)
    // 没播出进度（刚打开就切集/关闭，或流还没加载出来）时不覆盖已存的续播点，
    // 否则打开一次就把上次看到一半的进度抹成 0
    if (progress <= 0 && continueList.some(c => c.id === id && c.progress > 0)) return
    const isSeries = player.episodes.length > 1
    recordContinue(
      id,
      isSeries ? `${player.title} ${ep.label}` : player.title,
      '点播', 'vod', ep.urls[0], progress, ep.label,
    )
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
  // v0.1.394：推荐偏好（热门范围 + 推荐类型）仅本机，设置页签与热门页签共用同一份
  const [recPrefs, setRecPrefs] = useState<RecPrefs>(() => loadRecPrefs())
  const [trendingTab, setTrendingTab] = useState<'all' | 'tv' | 'movie'>(recPrefs.type)
  const [trendRange, setTrendRange] = useState<TrendRange>(recPrefs.range)
  const updateRecPrefs = (patch: Partial<RecPrefs>) => {
    setRecPrefs(prev => { const next = { ...prev, ...patch }; saveRecPrefs(next); return next })
  }
  const setTrendType = (t: 'all' | 'tv' | 'movie') => { setTrendingTab(t); setTrendPage(1); updateRecPrefs({ type: t }) }
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

  const loadTrending = async (range: TrendRange = trendRange) => {
    const pwd = sessionPwd || getBiometricPassword() || ''
    if (!pwd) { notify('请先解锁保险箱，才能读取已保存的 TMDB Key'); return }
    setTmdbBusy(true)
    try {
      const key = await loadTmdbKey(pwd)
      if (!key) { notify('还没保存 TMDB Key', 'err'); return }
      const list = await fetchTmdbTrending(key, range)
      setTrending(list); setTrendPage(1)
      notify(`已加载${range === 'day' ? '今日热门' : range === 'top' ? '高分精选' : '本周热门'} ${list.length} 部`)
    } catch (e) { notify(e instanceof Error ? e.message : '加载失败', 'err') } finally { setTmdbBusy(false) }
  }

  // v0.1.394：设置页签改热门范围时，已有 Key 就直接按新范围重拉
  const setTrendRangeAndLoad = (r: TrendRange) => {
    setTrendRange(r); updateRecPrefs({ range: r })
    if (tmdbKeySet) void loadTrending(r)
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

  // ---- 直播 ----
  const [liveCountry, setLiveCountry] = useState('CN')
  const [liveLoading, setLiveLoading] = useState(false)
  const [liveChannels, setLiveChannels] = useState<LiveChannel[]>([])
  const [liveSets, setLiveSets] = useState<SourceSetResult[]>([])
  const [liveLoaded, setLiveLoaded] = useState(false)
  const [contentFilter, setContentFilter] = useState('all')
  const [livePages, setLivePages] = useState<Record<string, number>>({})
  // ---- 点播海报墙（v0.1.395：点播区改片库式海报墙） ----
  // 墙 = 点播源里的片名（有源可播）+ TMDB 热门里没匹配上片源的影片（仅展示）；
  // 海报/评分/简介走 TMDB，播放永远走自己的点播源。TMDB 元数据按片名搜 +
  // 详情接口后台补全（都带缓存，重复打开不重复请求）。
  const [vodTitles, setVodTitles] = useState<VodTitle[]>([])
  const [vodPage, setVodPage] = useState(1)
  const [vodGenre, setVodGenre] = useState('全部')
  const [vodYear, setVodYear] = useState('全部')
  const [vodRegion, setVodRegion] = useState('全部')
  const [vodStatus, setVodStatus] = useState<VodWallStatusFilter>('all')
  const [vodSort, setVodSort] = useState<VodWallSort>('updated')
  const [vodGenreMap, setVodGenreMap] = useState<TmdbGenreMap | null>(null)
  const [vodEnrich, setVodEnrich] = useState<Record<string, VodEnrichEntry>>({})
  const vodEnrichRef = useRef(vodEnrich)
  const vodEnrichRunRef = useRef(false)
  const mergeEnrich = (key: string, patch: Partial<VodEnrichEntry>) => {
    vodEnrichRef.current = { ...vodEnrichRef.current, [key]: { ...vodEnrichRef.current[key], ...patch } }
    setVodEnrich(vodEnrichRef.current)
  }
  const [vodDetail, setVodDetail] = useState<VodWallItem | null>(null)
  const [vodDetailEp, setVodDetailEp] = useState(0)
  const [vodDetailLine, setVodDetailLine] = useState(0)

  const wallItems = useMemo(
    () => buildVodWallItems(vodTitles, trending, vodEnrich, vodGenreMap),
    [vodTitles, trending, vodEnrich, vodGenreMap],
  )
  const wallFiltered = useMemo(
    () => sortVodWall(filterVodWall(wallItems, { genre: vodGenre, year: vodYear, region: vodRegion, status: vodStatus }), vodSort),
    [wallItems, vodGenre, vodYear, vodRegion, vodStatus, vodSort],
  )
  // v0.1.407：点播体检筛选（只看能播的 + 快的排前面）；体检运行态与墙视图在下面直播体检块旁
  const [vodHealthOnly, setVodHealthOnly] = useState(false)
  const [vodHealthSort, setVodHealthSort] = useState(false)
  // 还在补全信息的影片数（有 TMDB 但没拉过详情，或点播标题还没搜过 TMDB；
  // 搜不到/拉失败的也算完成，不常驻提示）
  const wallEnrichPending = wallItems.filter(i => i.tmdb && !i.details && !vodEnrichRef.current[normalizeTitleKey(i.title)]?.detailsTried).length
    + vodTitles.filter(v => !vodEnrichRef.current[normalizeTitleKey(v.title)]?.searched).length

  // 打开点播页签且有 Key 时，后台补全：先按片名搜 TMDB，再拉详情（4 路并行、带节流）
  useEffect(() => {
    if (activeTab !== 'vod' || !tmdbKeySet) return
    if (vodEnrichRunRef.current) return
    const needSearch = vodTitles.filter(v => !vodEnrichRef.current[normalizeTitleKey(v.title)]?.searched)
    const needDetails = wallItems.filter(i => i.tmdb && !i.details && !vodEnrichRef.current[normalizeTitleKey(i.title)]?.detailsTried)
    if (!needSearch.length && !needDetails.length) return
    let dead = false
    vodEnrichRunRef.current = true
    const run = async () => {
      try {
        const pwd = sessionPwd || getBiometricPassword() || ''
        if (!pwd) return
        const key = await loadTmdbKey(pwd)
        if (!key || dead) return
        if (!vodGenreMap) {
          const gm = await fetchTmdbGenres(key).catch(() => null)
          if (dead) return
          if (gm) setVodGenreMap(gm)
        }
        for (const v of needSearch) {
          if (dead) return
          const found = await searchTmdbTitle(key, v.title).catch(() => null)
          if (dead) return
          mergeEnrich(normalizeTitleKey(v.title), { tmdb: found ?? undefined, searched: true })
        }
        // 详情按当前墙重新算（搜索刚补上的也算上），4 路并行、每路起步间隔 200ms
        const queue = buildVodWallItems(vodTitles, trending, vodEnrichRef.current, vodGenreMap)
          .filter(i => i.tmdb && !i.details)
          .slice(0, 60)
        let idx = 0
        const workers = Array.from({ length: 4 }, async (_, w) => {
          if (w > 0) await new Promise(r => globalThis.setTimeout(r, w * 200))
          while (!dead && idx < queue.length) {
            const it = queue[idx++]
            if (!it.tmdb) continue
            const d = await fetchTmdbDetails(key, it.tmdb.mediaType, it.tmdb.id).catch(() => null)
            if (dead) return
            mergeEnrich(normalizeTitleKey(it.title), { details: d ?? undefined, detailsTried: true })
          }
        })
        await Promise.all(workers)
      } finally {
        vodEnrichRunRef.current = false
      }
    }
    void run()
    return () => { dead = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, tmdbKeySet, vodTitles, trending, wallItems.length])

  // ---- 点播详情弹层（海报墙点卡片进详情：选集/选线路/加入片单/播放） ----
  const openVodDetail = (item: VodWallItem) => {
    const prev = item.vod
      ? continueList.find(c => c.kind === 'vod' && parseVodContinueId(c.id)?.vodKey === item.vod!.key)
      : undefined
    const parsed = prev ? parseVodContinueId(prev.id) : null
    setVodDetail(item)
    setVodDetailEp(parsed?.episodeIndex ?? 0)
    setVodDetailLine(0)
  }
  useEffect(() => {
    if (!vodDetail) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setVodDetail(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [vodDetail])
  const wallByKey = useMemo(() => new Map(wallItems.map(i => [normalizeTitleKey(i.title), i])), [wallItems])
  /** 继续观看某条的海报：点播按 vodKey 找墙里的片，直播/iframe 按标题找，
   * 标题带“第 N 集”后缀时先去掉后缀再找；找不到就没海报，只显示文字卡片。 */
  const posterForContinue = (c: ContinueItem): string | undefined => {
    if (c.kind === 'vod') {
      const parsed = parseVodContinueId(c.id)
      const v = parsed ? vodTitles.find(t => t.key === parsed.vodKey) : undefined
      if (v) return wallByKey.get(normalizeTitleKey(v.title))?.poster
    }
    const hit = wallByKey.get(normalizeTitleKey(c.title))?.poster
    if (hit) return hit
    const stripped = c.title.replace(/第\s*\d+\s*集$/, '').trim()
    return stripped ? wallByKey.get(normalizeTitleKey(stripped))?.poster : undefined
  }
  // v0.1.394：设置页签分开填直播源 / 点播源；底层仍是同一份自定义源列表
  // （一个 m3u 里既可含直播台也可含点播条目，拉取后自动拆到两个区）
  const [liveLabel, setLiveLabel] = useState('')
  const [liveUrl, setLiveUrl] = useState('')
  const [vodLabel, setVodLabel] = useState('')
  const [vodUrl, setVodUrl] = useState('')
  const [customSources, setCustomSources] = useState<CustomSource[]>(loadCustomSources)
  const [customTesting, setCustomTesting] = useState<string | null>(null)
  const [customTestResult, setCustomTestResult] = useState('')

  const loadLive = async (country: string, force = false) => {
    setLiveLoading(true); setLiveLoaded(false)
    try {
      const { channels, vod, sets } = await loadCountryChannels(country, { force })
      setLiveChannels(channels); setVodTitles(vod); setLiveSets(sets); setLiveLoaded(true)
      setContentFilter('all'); setVodGenre('全部'); setVodYear('全部'); setVodRegion('全部'); setVodStatus('all'); setVodPage(1)
      if (!channels.length && !vod.length) notify('该国家/地区的源都没拉到，请检查网络后重试', 'err')
      else notify(`已加载 ${channels.length} 个台${vod.length ? `、${vod.length} 部点播` : ''}`)
    } catch (e) { notify(e instanceof Error ? e.message : '加载失败', 'err') } finally { setLiveLoading(false) }
  }

  useEffect(() => { void loadLive(liveCountry) }, [liveCountry])

  // ---- 源体检（v0.1.391）：手动入口，后台逐台测连通性；结果缓存 30 分钟 ----
  const [health, setHealth] = useState<HealthMap>(() => loadHealthCache())
  const [healthRunning, setHealthRunning] = useState(false)
  const [healthProgress, setHealthProgress] = useState<{ done: number; total: number } | null>(null)
  // v0.1.407：体检后已测不通的台默认隐藏（只隐藏已测不通的，未测的不受影响）；
  // 「只看已测通的」chip 已并入这个默认行为（删掉：它还会藏起未测的台，与
  // “未测不受影响”打架）。设置页签「显示已测不通的台」开关可恢复显示，状态只存本机。
  const [showDead, setShowDead] = useState(() => loadShowDead())
  const toggleShowDead = () => {
    setShowDead(v => { const next = !v; saveShowDead(next); return next })
  }
  const [healthSort, setHealthSort] = useState(false)
  const healthCtrlRef = useRef<AbortController | null>(null)
  const healthCountsNow = useMemo(() => healthCounts(liveChannels, health), [liveChannels, health])
  const healthAt = useMemo(() => {
    let at = 0
    for (const ch of liveChannels) {
      const h = healthOf(health, ch)
      if (h && h.at > at) at = h.at
    }
    return at || null
  }, [liveChannels, health])
  const healthAgeText = healthAt
    ? (() => { const m = Math.floor((Date.now() - healthAt) / 60000); return m < 1 ? '刚刚' : `${m} 分钟前` })()
    : ''
  const startHealth = async () => {
    if (healthRunning || !liveChannels.length) return
    const ctrl = new AbortController()
    healthCtrlRef.current = ctrl
    setHealthRunning(true)
    setHealthProgress({ done: 0, total: liveChannels.length })
    try {
      const fresh = await probeChannels(liveChannels, {
        signal: ctrl.signal,
        onProgress: (done, total, key, result) => {
          setHealth(prev => { const next = { ...prev, [key]: result }; saveHealthCache(next); return next })
          setHealthProgress({ done, total })
        },
      })
      setHealth(prev => { const next = { ...prev, ...fresh }; saveHealthCache(next); return next })
    } finally {
      healthCtrlRef.current = null
      setHealthRunning(false)
      setHealthProgress(null)
    }
  }
  const stopHealth = () => { healthCtrlRef.current?.abort() }
  // ---- 点播体检（v0.1.407）：与直播体检同款探针；结果进同一缓存，键加 vod: 前缀 ----
  const [vodHealthRunning, setVodHealthRunning] = useState(false)
  const [vodHealthProgress, setVodHealthProgress] = useState<{ done: number; total: number } | null>(null)
  const vodHealthCtrlRef = useRef<AbortController | null>(null)
  const vodHealthCountsNow = useMemo(() => vodHealthCounts(vodTitles, health), [vodTitles, health])
  const vodHealthAt = useMemo(() => {
    let at = 0
    for (const v of vodTitles) {
      const h = vodHealthOf(health, v)
      if (h && h.at > at) at = h.at
    }
    return at || null
  }, [vodTitles, health])
  const vodHealthAgeText = vodHealthAt
    ? (() => { const m = Math.floor((Date.now() - vodHealthAt) / 60000); return m < 1 ? '刚刚' : `${m} 分钟前` })()
    : ''
  const startVodHealth = async () => {
    if (vodHealthRunning || !vodTitles.length) return
    const ctrl = new AbortController()
    vodHealthCtrlRef.current = ctrl
    setVodHealthRunning(true)
    setVodHealthProgress({ done: 0, total: vodTitles.length })
    try {
      const fresh = await probeVodTitles(vodTitles, {
        signal: ctrl.signal,
        onProgress: (done, total, key, result) => {
          setHealth(prev => { const next = { ...prev, [key]: result }; saveHealthCache(next); return next })
          setVodHealthProgress({ done, total })
        },
      })
      setHealth(prev => { const next = { ...prev, ...fresh }; saveHealthCache(next); return next })
    } finally {
      vodHealthCtrlRef.current = null
      setVodHealthRunning(false)
      setVodHealthProgress(null)
    }
  }
  const stopVodHealth = () => { vodHealthCtrlRef.current?.abort() }
  // 点播体检视图作用在筛选排序后的墙上、再分页（与直播体检同款；放体检块后声明，health 在此已定义）
  const wallShown = useMemo(
    () => applyVodHealthView(wallFiltered, health, { onlyHealthy: vodHealthOnly, sortBySpeed: vodHealthSort }),
    [wallFiltered, health, vodHealthOnly, vodHealthSort],
  )
  const wallShownPlayCount = wallShown.filter(i => i.playable).length
  // 体检视图：已测不通的默认隐藏 + 快的排前面（只作用于当前直播列表）
  const liveDisplay = useMemo(
    () => applyHealthView(liveChannels, health, { hideDead: !showDead, sortBySpeed: healthSort }),
    [liveChannels, health, showDead, healthSort],
  )
  const liveGroups = groupChannels(liveDisplay, liveCountry)
  const liveContents = ['all', ...liveGroups.contents]

  const addCustomSource = async (label: string, urlRaw: string, which: 'live' | 'vod') => {
    const url = urlRaw.trim()
    if (!/^https?:\/\//.test(url)) { notify('请输入 http(s) 开头的 m3u 订阅链接', 'err'); return }
    const src: CustomSource = { id: `${Date.now()}`, label: label.trim() || '自定义源', url, addedAt: Date.now() }
    const next = [...customSources, src]
    setCustomSources(next); saveCustomSources(next)
    if (which === 'live') { setLiveLabel(''); setLiveUrl('') } else { setVodLabel(''); setVodUrl('') }
    setCustomTesting(src.id)
    try {
      const { channels, result } = await fetchSourceSet({ id: `custom-${src.id}`, label: src.label, url, country: 'WORLD' })
      if (result.ok) {
        const vodCount = channelsToVod(channels).length
        setCustomTestResult(`「${src.label}」拉到 ${result.count} 个台${vodCount ? `、${vodCount} 部点播` : ''}，已并入列表`)
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

  // 直播频道列表（内容筛选 + 分页，每页 8 条）
  const ChannelList = ({ channels, pageKey }: { channels: LiveChannel[]; pageKey: string }) => {
    const filtered = contentFilter === 'all' ? channels : channels.filter(c => c.content === contentFilter)
    const page = Math.min(livePages[pageKey] ?? 1, pageCount(filtered.length))
    const total = pageCount(filtered.length)
    if (!filtered.length) return <div className="fg-empty">这个分类下暂时没有台，换个分类或国家试试。</div>
    return (
      <>
        <div className="wt-channels">
          {pageSlice(filtered, page).map(ch => {
            const h = healthOf(health, ch)
            return (
            <button key={ch.key} className={`wt-channel${h && !h.ok ? ' wt-channel-dead' : ''}`} onClick={() => openHls(ch)} title={`${ch.name} · 点一下开始播放`}>
              {ch.logo && <img className="wt-channel-logo" src={ch.logo} alt="" onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />}
              <span className="wt-channel-name">{ch.name}</span>
              {h && (h.ok
                ? <span className="wt-health-ok">✓ {h.ms}ms</span>
                : <span className="wt-health-bad">✗ 不通</span>)}
              {isChannelUnofficial(ch) && <span className="wt-unofficial-badge">未授权转播</span>}
              <span className="wt-channel-meta">{CONTENT_LABELS[ch.content] ?? '其他'}{ch.urls.length > 1 ? ` · ${ch.urls.length} 个源` : ''}</span>
            </button>
            )
          })}
        </div>
        <Pager page={page} pageCount={total} total={filtered.length} unit="个台"
          onPage={n => setLivePages(prev => ({ ...prev, [pageKey]: n }))} />
      </>
    )
  }

  const [continuePage, setContinuePage] = useState(1)

  // 点播详情弹层（海报墙点卡片进详情：大海报、评分、导演主演、简介、选集、线路）
  const VodDetailSheet = ({ item }: { item: VodWallItem }) => {
    const v = item.vod
    const ep = v?.episodes[vodDetailEp] ?? v?.episodes[0]
    const badge = vodWallBadge(item)
    const inWatchlist = watchlist.some(w => w.title === item.title)
    const watchedEp = (i: number) => {
      if (!v) return false
      const c = continueList.find(x => x.id === vodContinueId(v.key, i))
      return !!c && c.progress >= 0.95
    }
    const toggleWatchlist = () => {
      const found = watchlist.find(w => w.title === item.title)
      if (found) removeFromWatchlist(found.id)
      else addToWatchlist({ title: item.title, type: item.kind === 'movie' ? 'movie' : 'tv', platform: v ? '点播' : 'TMDB 热门', poster: item.poster, overview: item.overview })
    }
    const playLabel = !v ? '暂无片源 · 仅展示' : item.kind === 'movie' ? '▶ 播放正片' : `▶ 播放${ep?.label ?? ''}`
    return (
      <div className="wt-sheet-backdrop" onClick={e => { if (e.target === e.currentTarget) setVodDetail(null) }}>
        <section className="wt-sheet" role="dialog" aria-modal="true" aria-label={`${item.title} 详情`}>
          <button className="wt-sheet-close" aria-label="关闭详情" onClick={() => setVodDetail(null)}><X size={16} /></button>
          <div className="wt-detail-top">
            <div className="wt-detail-poster">
              {item.poster
                ? <img src={item.poster} alt={`${item.title} 海报`} onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                : <div className="wt-poster-ph"><Film size={24} /></div>}
            </div>
            <div className="wt-detail-info">
              <h2>{item.title}</h2>
              {item.tmdb?.originalTitle && item.tmdb.originalTitle !== item.title && <div className="wt-detail-en">{item.tmdb.originalTitle}</div>}
              <div className="wt-detail-meta">
                {typeof item.vote === 'number' && <span className="wt-meta-rate">★ TMDB {item.vote.toFixed(1)}</span>}
                {item.year && <span>{item.year}</span>}
                {item.region && <span>{item.region}</span>}
                {item.genres.map(g => <span key={g}>{g}</span>)}
                {badge && <span className={`wt-meta-status st-${badge.cls}`}>{badge.text}</span>}
              </div>
              {item.details?.director && <p className="wt-detail-kv">导演：<b>{item.details.director}</b></p>}
              {item.details?.cast && <p className="wt-detail-kv">主演：<b>{item.details.cast}</b></p>}
              {item.overview && <p className="wt-detail-syn">{item.overview}</p>}
              {v?.unofficial && <div className="wt-unofficial-note"><CircleAlert size={13} /> 当前源为第三方转播 · 未经授权，可能随时失效</div>}
            </div>
          </div>
          {v && item.kind === 'series' && v.episodes.length > 1 && (
            <div className="wt-detail-sec">
              <h4>选集 <small>共 {v.episodes.length} 集</small></h4>
              <div className="wt-eps">
                {v.episodes.map((e, i) => (
                  <button key={i} type="button" data-ep={i + 1} aria-pressed={i === vodDetailEp}
                    className={watchedEp(i) ? 'watched' : ''}
                    onClick={() => { setVodDetailEp(i); setVodDetailLine(0) }}>{e.label.replace(/^第\s*/, '').replace(/\s*集$/, '')}</button>
                ))}
              </div>
            </div>
          )}
          <div className="wt-detail-sec">
            <h4>片源 {v && <small>来自你的点播源 · 按片名自动匹配</small>}</h4>
            {v && ep ? (
              <div className="wt-src-chips">
                {ep.urls.map((_u, i) => (
                  <button key={i} type="button" className="wt-src-chip" data-src={i + 1} aria-pressed={i === vodDetailLine}
                    onClick={() => setVodDetailLine(i)}>线路 {i + 1}{ep.urls.length > 1 ? '' : ' · 可播'}</button>
                ))}
              </div>
            ) : (
              <div className="wt-nosrc-box">这部还没匹配到你点播源里的条目，只能看海报和简介。在「设置」里换一个点播源，匹配上之后这里就会出现线路和播放按钮。</div>
            )}
          </div>
          <div className="wt-playbar">
            <button className="wt-fav-btn" type="button" aria-pressed={inWatchlist} onClick={toggleWatchlist}>
              {inWatchlist ? '✓ 已在片单' : '＋ 加入片单'}
            </button>
            <button className="wt-play-btn" type="button" disabled={!v}
              onClick={() => { if (v) { openVod(v, vodDetailEp, 0, vodDetailLine); setVodDetail(null) } }}>
              {playLabel}
            </button>
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="ws-tool fg-tool">
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <button className="btn sm ghost" onClick={onBack}><ArrowLeft size={14} /> 返回工坊</button>
      </div>
      <h3 className="ws-tool-title">看剧</h3>
      <p className="ws-tool-desc">AI 找剧、热门推荐、直播、点播、追剧日历与片单；直播与点播都在 App 内播放器里播，不跳浏览器。片单与排期只存本机。</p>

      {!sessionPwd && (
        <div className="fg-unlock">
          <Lock size={14} /> 保险箱未解锁：AI 找剧用已保存的免费模型没问题；保存 TMDB Key 需要主密码。
          <input className="input" type="password" placeholder="保险箱主密码" value={pwdInput}
            onChange={e => setPwdInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') onUnlock(pwdInput) }} />
          <button className="btn sm primary" onClick={() => onUnlock(pwdInput)}>解锁</button>
        </div>
      )}

      <div ref={playerWrapRef}>
      {player?.kind === 'hls' && (
        <HlsPlayer key={playerKey} title={player.title} urls={player.urls}
          onOpened={p => closePlayer(p)} />
      )}
      {player?.kind === 'vod' && (
        <VodPlayer key={playerKey} title={player.title} episodes={player.episodes}
          episodeIndex={player.episodeIndex} startAt={player.startAt} startUrlIdx={player.startUrlIdx}
          onLeave={(i, p) => recordVodLeave(i, p)} onClose={() => setPlayer(null)} />
      )}
      {player?.kind === 'iframe' && (
        <IframePlayer key={playerKey} title={player.title} url={player.url} onClose={() => setPlayer(null)} />
      )}
      {player?.kind === 'blocked' && (
        <BlockedPlayer key={playerKey} title={player.title} url={player.url} reason={player.reason}
          onClose={() => setPlayer(null)}
          onAddCalendar={() => { addToWatchlist({ title: player.title, type: 'tv', platform: '官方 App', platformUrl: player.url }); setPlayer(null) }} />
      )}
      </div>

      {/* v0.1.394：横向页签（吸顶）+ AI 找剧收进标题栏右端搜索图标 */}
      <div className="wt-tabs" role="tablist">
        <button role="tab" aria-selected={activeTab === 'trending'} className={`wt-tab${activeTab === 'trending' ? ' on' : ''}`} onClick={() => setActiveTab('trending')}>热门推荐{trending.length ? <span className="wt-tab-count">{trending.length} 部</span> : null}</button>
        <button role="tab" aria-selected={activeTab === 'continue'} className={`wt-tab${activeTab === 'continue' ? ' on' : ''}`} onClick={() => setActiveTab('continue')}>继续观看{continueList.length ? <span className="wt-tab-count">{continueList.length} 条</span> : null}</button>
        <button role="tab" aria-selected={activeTab === 'live'} className={`wt-tab${activeTab === 'live' ? ' on' : ''}`} onClick={() => setActiveTab('live')}>直播{liveLoaded ? <span className="wt-tab-count">{liveChannels.length} 个台</span> : null}</button>
        <button role="tab" aria-selected={activeTab === 'vod'} className={`wt-tab${activeTab === 'vod' ? ' on' : ''}`} onClick={() => setActiveTab('vod')}>点播{vodTitles.length ? <span className="wt-tab-count">{vodTitles.length} 部</span> : null}</button>
        <button role="tab" aria-selected={activeTab === 'calendar'} className={`wt-tab${activeTab === 'calendar' ? ' on' : ''}`} onClick={() => setActiveTab('calendar')}>追剧日历{dated.length ? <span className="wt-tab-count">{dated.length} 条</span> : null}</button>
        <button role="tab" aria-selected={activeTab === 'watchlist'} className={`wt-tab${activeTab === 'watchlist' ? ' on' : ''}`} onClick={() => setActiveTab('watchlist')}>我的片单<span className="wt-tab-count">{watchlist.length} 部</span></button>
        <button role="tab" aria-selected={activeTab === 'settings'} className={`wt-tab${activeTab === 'settings' ? ' on' : ''}`} onClick={() => setActiveTab('settings')}>设置</button>
        <button className={`wt-tab-search${aiSearchOpen ? ' on' : ''}`} title="AI 找剧" aria-label="AI 找剧" aria-expanded={aiSearchOpen} onClick={() => setAiSearchOpen(v => !v)}><Search size={16} /></button>
      </div>

      {/* AI 找剧（搜索图标展开的面板，Esc / ✕ / 再点图标收起） */}
      {aiSearchOpen && (
        <div className="wt-ai-panel">
          <div className="wt-ai-panel-head">
            <span className="wt-ai-panel-title">AI 找剧</span>
            <span className="fg-muted">免费模型推荐 · 只推正版平台</span>
            <button className="btn sm ghost" aria-label="收起 AI 找剧" onClick={() => setAiSearchOpen(false)}><X size={14} /></button>
          </div>
        <div className="wt-ai-row">
          <input className="input" ref={searchInputRef} placeholder="一句话说说想看什么，如：最近有什么好看的悬疑剧"
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
        </div>
      )}

      {/* 热门推荐 */}
      {activeTab === 'trending' && (
        <div className="wt-tab-body">
          <div className="wt-tab-sub">TMDB {trendRange === 'day' ? '今日热门' : trendRange === 'top' ? '高分精选' : '本周热门'} · 海报 · 评分 · 上映日期</div>
        {!tmdbKeySet ? (
          <div className="fg-empty">
            <div>还没填 TMDB API Key：热门榜单需要 Key 才能调用（TMDB 免费注册）。不填也可以用 AI 找剧与直播。</div>
            <button className="btn sm primary" onClick={() => setActiveTab('settings')}>去「设置」页签填 Key</button>
          </div>
        ) : trending.length === 0 ? (
          <div className="fg-empty">
            <div>已保存 TMDB Key。点下面加载{trendRange === 'day' ? '今日热门' : trendRange === 'top' ? '高分精选' : '本周热门'}（剧集 + 电影）。</div>
            <button className="btn sm primary" disabled={tmdbBusy} onClick={() => void loadTrending()}>
              {tmdbBusy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} 加载热门榜单
            </button>
          </div>
        ) : (
          <>
            <div className="wt-chips">
              {(['all', 'tv', 'movie'] as const).map(t => (
                <button key={t} className={`wt-chip${trendingTab === t ? ' on' : ''}`}
                  onClick={() => setTrendType(t)}>
                  {t === 'all' ? '全部' : t === 'tv' ? '剧集' : '电影'}
                </button>
              ))}
              <button className="btn sm ghost" onClick={() => void loadTrending()}><RefreshCw size={13} /> 刷新</button>
            </div>
            <div className="fg-grid">
              {pageSlice(trendingFiltered, trendPage).map((t, i) => (
                <div key={`${t.mediaType}-${t.id}`} className="fg-card wt-trend-card">
                  <div className="wt-poster-wrap">
                    {t.poster
                      ? <img className="wt-poster" src={t.poster} alt={t.title} loading="lazy" onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                      : <div className="wt-poster-ph"><Film size={20} /></div>}
                    <span className="wt-rank">{(trendPage - 1) * 8 + i + 1}</span>
                  </div>
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
        </div>
      )}

      {/* 继续观看 */}
      {activeTab === 'continue' && (
        <div className="wt-tab-body">
          <div className="wt-tab-sub">上次看到一半的</div>
        {continueList.length === 0 ? (
          <div className="fg-empty">还没看过：直播台或点播看过后，这里会出现继续观看的入口（带进度）。</div>
        ) : (
          <>
            <div className="fg-grid">
              {pageSlice(continueList, continuePage).map(c => {
                const poster = posterForContinue(c)
                return (
                <div key={c.id} className="fg-card wt-cont-card">
                  {poster && <img className="wt-cont-thumb" src={poster} alt="" loading="lazy" onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />}
                  <div className="wt-cont-main">
                  <div className="fg-card-title">{c.title}</div>
                  <div className="fg-muted">{c.platform} · {new Date(c.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
                  {c.progress > 0 && (
                    <div className="wt-progress"><div className="wt-progress-fill" style={{ width: `${Math.round(c.progress * 100)}%` }} /></div>
                  )}
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn sm primary" onClick={() => {
                      if (c.kind === 'hls') setPlayer({ kind: 'hls', title: c.title, channelKey: c.id.replace(/^live:/, ''), urls: [c.url] })
                      else if (c.kind === 'vod') {
                        const parsed = parseVodContinueId(c.id)
                        const v = parsed ? vodTitles.find(t => t.key === parsed.vodKey) : undefined
                        if (v) openVod(v, parsed!.episodeIndex, c.progress)
                        else {
                          setPlayer({
                            kind: 'vod', title: c.title, vodKey: parsed?.vodKey ?? c.id,
                            episodes: [{ label: c.episode ?? '正片', urls: [c.url], episodeNo: 1, unofficial: isUnofficialStreamUrl(c.url) }],
                            episodeIndex: 0, startAt: c.progress,
                          })
                          setPlayerKey(k => k + 1)
                        }
                      }
                      else openIframe(c.title, c.url)
                    }}><Play size={13} /> 继续看</button>
                    <button className="btn sm ghost" onClick={() => { const next = continueList.filter(x => x.id !== c.id); setContinueList(next); saveContinue(next) }}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                  </div>
                </div>
                )
              })}
            </div>
            <Pager page={continuePage} pageCount={pageCount(continueList.length)} total={continueList.length} unit="条"
              onPage={setContinuePage} />
          </>
        )}
        </div>
      )}

      {/* 直播 */}
      {activeTab === 'live' && (
        <div className="wt-tab-body">
          <div className="wt-tab-sub">iptv-org + Free-TV 内置源 · 一个播不了自动换下一个</div>
        <div className="wt-chips">
          {COUNTRIES.map(c => (
            <button key={c.code} className={`wt-chip${liveCountry === c.code ? ' on' : ''}`}
              onClick={() => setLiveCountry(c.code)}>{c.label}</button>
          ))}
          <button className="btn sm ghost" disabled={liveLoading} onClick={() => void loadLive(liveCountry, true)}>
            <RefreshCw size={13} /> {liveLoading ? '加载中…' : '重新加载'}
          </button>
          <button className="btn sm ghost" disabled={liveLoading || healthRunning || !liveLoaded || !liveChannels.length} onClick={() => void startHealth()} title="逐个测每个台的服务器通不通、快不快（后台进行，不堵列表）">
            <Activity size={13} /> {healthRunning ? '体检中…' : '开始体检'}
          </button>
          {healthRunning && (
            <button className="btn sm ghost" onClick={stopHealth}>停止</button>
          )}
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
        {liveLoaded && (
          <div className="wt-health-bar">
            {healthRunning && healthProgress ? (
              <span className="fg-muted"><Loader2 size={13} className="spin" /> 体检中 {healthProgress.done}/{healthProgress.total} 个台…（后台进行，不影响看列表；可点「停止」）</span>
            ) : healthCountsNow.tested > 0 ? (
              <>
                <span className="fg-muted">上次体检{healthAgeText}：{healthCountsNow.tested} 个台已测 · {healthCountsNow.ok} 通 · {healthCountsNow.bad} 不通（结果保留 30 分钟；测的是服务器是否能连通，不是完整播流）{healthCountsNow.bad > 0 && !showDead ? ' · 不通的台已默认隐藏（设置里可打开显示）' : ''}</span>
                <button className="btn sm ghost" disabled={healthRunning} onClick={() => void startHealth()}>
                  <RefreshCw size={13} /> 重新体检
                </button>
              </>
            ) : (
              <span className="fg-muted">还没体检过：点「开始体检」逐个测每个台通不通、快不快，死的标出来、快的排前面。</span>
            )}
          </div>
        )}
        <div className="fg-muted">自定义直播源不在这里填了，去「设置」页签粘贴 m3u 地址，保存后频道会合并进来。 <button className="btn sm ghost" onClick={() => setActiveTab('settings')}>去设置</button></div>
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
            {healthCountsNow.tested > 0 && (
              <div className="wt-chips">
                <span className="fg-muted">体检：</span>
                <button className={`wt-chip${healthSort ? ' on' : ''}`} aria-pressed={healthSort}
                  onClick={() => { setHealthSort(v => !v); setLivePages({}) }}>快的排前面</button>
              </div>
            )}
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
              <ChannelList channels={liveDisplay} pageKey={`${liveCountry}-${contentFilter}`} />
            )}
          </>
        )}
        </div>
      )}

      {/* 点播海报墙（v0.1.395）：类型/年份/地区/状态四排筛选 + 12 部一页 + 详情选集选线 */}
      {activeTab === 'vod' && (
        <div className="wt-tab-body">
          <div className="wt-tab-sub">电影 / 剧集 · 海报墙 · 有源可播，没源的只展示</div>
          {vodTitles.length === 0 && (
            <div className="fg-muted">在「设置」页签的「自定义点播源」里粘含 mp4 / mkv 条目的 m3u，电影和剧集会自动认出来放到这里；同一个地址里的直播流仍留在直播区。 <button className="btn sm ghost" onClick={() => setActiveTab('settings')}>去设置</button></div>
          )}
          {!tmdbKeySet && wallItems.length > 0 && (
            <div className="fg-muted">没填 TMDB Key：只有片名列表，没有海报、评分与类型/年份/地区筛选；去「设置」页签填 Key 后再看。 <button className="btn sm ghost" onClick={() => setActiveTab('settings')}>去设置</button></div>
          )}
          {vodTitles.length > 0 && (
            <>
              <div className="wt-chips">
                <button className="btn sm ghost" disabled={vodHealthRunning || !vodTitles.length} onClick={() => void startVodHealth()} title="逐部测点播线路通不通、快不快（后台进行，不堵墙）">
                  <Activity size={13} /> {vodHealthRunning ? '体检中…' : '开始体检'}
                </button>
                {vodHealthRunning && (
                  <button className="btn sm ghost" onClick={stopVodHealth}>停止</button>
                )}
              </div>
              <div className="wt-health-bar">
                {vodHealthRunning && vodHealthProgress ? (
                  <span className="fg-muted"><Loader2 size={13} className="spin" /> 体检中 {vodHealthProgress.done}/{vodHealthProgress.total} 部…（后台进行，不影响看墙；可点「停止」）</span>
                ) : vodHealthCountsNow.tested > 0 ? (
                  <>
                    <span className="fg-muted">上次体检{vodHealthAgeText}：{vodHealthCountsNow.tested} 部已测 · {vodHealthCountsNow.ok} 通 · {vodHealthCountsNow.bad} 不通（结果保留 30 分钟；测的是服务器是否能连通，不是完整播流）</span>
                    <button className="btn sm ghost" disabled={vodHealthRunning} onClick={() => void startVodHealth()}>
                      <RefreshCw size={13} /> 重新体检
                    </button>
                  </>
                ) : (
                  <span className="fg-muted">还没体检过：点「开始体检」逐部测线路通不通、快不快，死的标出来、快的排前面。</span>
                )}
              </div>
              {vodHealthCountsNow.tested > 0 && (
                <div className="wt-chips">
                  <span className="fg-muted">体检：</span>
                  <button className={`wt-chip${vodHealthOnly ? ' on' : ''}`} aria-pressed={vodHealthOnly}
                    onClick={() => { setVodHealthOnly(v => !v); setVodPage(1) }}>只看能播的</button>
                  <button className={`wt-chip${vodHealthSort ? ' on' : ''}`} aria-pressed={vodHealthSort}
                    onClick={() => { setVodHealthSort(v => !v); setVodPage(1) }}>快的排前面</button>
                </div>
              )}
            </>
          )}
        {!liveLoaded && liveLoading ? (
          <div className="fg-muted"><Loader2 size={13} className="spin" /> 正在拉取…</div>
        ) : wallItems.length === 0 ? (
          <div className="fg-empty">当前源里没有点播条目：自定义源粘一个含 mp4 电影或剧集的 m3u，点播会自动出现在这里（直播台不受影响）。</div>
        ) : (
          <>
            {tmdbKeySet && (
              <div className="wt-wall-filters">
                <div className="wt-frow">
                  <span className="wt-flab">类型</span>
                  <div className="wt-fchips">
                    {WALL_GENRES.map(g => (
                      <button key={g} type="button" className={`wt-chip${vodGenre === g ? ' on' : ''}`} aria-pressed={vodGenre === g}
                        onClick={() => { setVodGenre(g); setVodPage(1) }}>{g}</button>
                    ))}
                  </div>
                </div>
                <div className="wt-frow">
                  <span className="wt-flab">年份</span>
                  <div className="wt-fchips">
                    {WALL_YEARS.map(y => (
                      <button key={y} type="button" className={`wt-chip${vodYear === y ? ' on' : ''}`} aria-pressed={vodYear === y}
                        onClick={() => { setVodYear(y); setVodPage(1) }}>{y}</button>
                    ))}
                  </div>
                </div>
                <div className="wt-frow">
                  <span className="wt-flab">地区</span>
                  <div className="wt-fchips">
                    {WALL_REGIONS.map(r => (
                      <button key={r} type="button" className={`wt-chip${vodRegion === r ? ' on' : ''}`} aria-pressed={vodRegion === r}
                        onClick={() => { setVodRegion(r); setVodPage(1) }}>{r}</button>
                    ))}
                  </div>
                </div>
                <div className="wt-frow">
                  <span className="wt-flab">状态</span>
                  <div className="wt-fchips">
                    {WALL_STATUS_FILTERS.map(s => (
                      <button key={s.k} type="button" className={`wt-chip${vodStatus === s.k ? ' on' : ''}`} aria-pressed={vodStatus === s.k}
                        onClick={() => { setVodStatus(s.k); setVodPage(1) }}>{s.t}</button>
                    ))}
                  </div>
                </div>
              </div>
            )}
            <div className="wt-countbar">
              <span className="wt-count-text">共 <b>{wallShown.length}</b> 部 · 其中 <span className="wt-ok">{wallShownPlayCount} 部有源可播</span>，{wallShown.length - wallShownPlayCount} 部仅展示</span>
              {tmdbKeySet && wallEnrichPending > 0 && <span className="fg-muted">正在补全海报与信息（还剩 {wallEnrichPending} 部）…</span>}
              <div className="wt-sortbox" role="group" aria-label="排序">
                {([['updated', '最近更新'], ['rating', '评分最高'], ['year', '年份最新']] as const).map(([s, label]) => (
                  <button key={s} type="button" aria-pressed={vodSort === s} onClick={() => { setVodSort(s); setVodPage(1) }}>{label}</button>
                ))}
              </div>
            </div>
            {wallShown.length === 0 ? (
              <div className="fg-empty">
                <div>这个筛选下没有影片</div>
                <div className="fg-muted">换个类型、年份或地区试试；没匹配到 TMDB 的影片没有类型、年份信息，筛选时只按「全部」显示。</div>
              </div>
            ) : (
              <div className="wt-wall">
                {pageSlice(wallShown, vodPage, 12).map(item => {
                  const badge = vodWallBadge(item)
                  const prev = item.vod ? continueList.find(c => c.kind === 'vod' && parseVodContinueId(c.id)?.vodKey === item.vod!.key) : undefined
                  const vh = item.vod ? vodHealthOf(health, item.vod) : undefined
                  return (
                    <button key={item.id} type="button" className={`wt-wall-card${vh && !vh.ok ? ' wt-wall-card-dead' : ''}`} onClick={() => openVodDetail(item)} aria-label={`查看《${item.title}》详情`}>
                      <span className="wt-wall-poster">
                        {item.poster
                          ? <img src={item.poster} alt={`${item.title} 海报`} loading="lazy" onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                          : <span className="wt-wall-ph"><Film size={22} /></span>}
                        {badge && <span className={`wt-wall-badge ${badge.cls}`}>{badge.text}</span>}
                        {typeof item.vote === 'number' && <span className="wt-wall-rate">★ {item.vote.toFixed(1)}</span>}
                        {!item.playable && <span className="wt-wall-veil">暂无片源 · 仅展示</span>}
                      </span>
                      <span className="wt-wall-title">{item.title}</span>
                      <span className="wt-wall-meta">
                        {[item.year, item.region, item.genres.join('/')].filter(Boolean).join(' · ') || (item.kind === 'movie' ? '电影' : `剧集 · ${item.vod?.episodes.length ?? ''} 集`)}
                      </span>
                      {item.playable
                        ? <span className="wt-wall-src play"><span className="dot" />有源 · {item.sourceCount} 条线路可播{prev?.episode ? ` · 看到${prev.episode}` : ''}{vh ? (vh.ok ? <span className="wt-health-ok"> ✓ {vh.ms}ms</span> : <span className="wt-health-bad"> ✗ 不通</span>) : null}</span>
                        : <span className="wt-wall-src none"><span className="dot" />仅展示 · 未匹配到片源</span>}
                      {item.vod?.unofficial && <span className="wt-unofficial-badge">未授权转播</span>}
                    </button>
                  )
                })}
              </div>
            )}
            <Pager page={vodPage} pageCount={pageCount(wallShown.length, 12)}
              total={wallShown.length} unit="部"
              onPage={setVodPage} />
          </>
        )}
        {vodDetail && <VodDetailSheet item={vodDetail} />}
        </div>
      )}

      {/* 追剧日历 */}
      {activeTab === 'calendar' && (
        <div className="wt-tab-body">
          <div className="wt-tab-sub">由片单的下次更新日期派生</div>
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
        </div>
      )}

      {/* 我的片单 */}
      {activeTab === 'watchlist' && (
        <div className="wt-tab-body">
          <div className="wt-tab-sub">只存本机，不云同步</div>
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
        </div>
      )}

      {/* 设置：源、Key 与推荐都集中在这里，只存本机 */}
      {activeTab === 'settings' && (
        <div className="wt-tab-body">
          <div className="wt-tab-sub">源、Key 与推荐都集中在这里，只存本机</div>
          <div className="wt-set-block">
            <h4>自定义直播源</h4>
            <div className="wt-set-note">粘贴一个 m3u 直播源地址，保存后里面的频道会合并到「直播」页签；留空不填就是只用内置源（iptv-org + Free-TV）。</div>
            <div className="wt-ai-row">
              <input className="input" placeholder="名称，如：我的直播源" value={liveLabel} onChange={e => setLiveLabel(e.target.value)} />
              <input className="input" placeholder="粘贴 m3u 直播源地址（http(s)://…）" value={liveUrl} onChange={e => setLiveUrl(e.target.value)} />
              <button className="btn sm primary" disabled={customTesting !== null || !liveUrl.trim()} onClick={() => void addCustomSource(liveLabel, liveUrl, 'live')}>
                {customTesting ? <Loader2 size={13} className="spin" /> : <Plus size={13} />} 保存
              </button>
            </div>
          </div>
          <div className="wt-set-block">
            <h4>自定义点播源</h4>
            <div className="wt-set-note">粘贴含电影、剧集条目（mp4 / mkv / 点播 m3u8）的 m3u 地址，保存后会自动认出电影和剧集，放进「点播」页签；同一个地址里的直播流仍进直播区。</div>
            <div className="wt-ai-row">
              <input className="input" placeholder="名称，如：我的点播源" value={vodLabel} onChange={e => setVodLabel(e.target.value)} />
              <input className="input" placeholder="粘贴 m3u 点播源地址（http(s)://…）" value={vodUrl} onChange={e => setVodUrl(e.target.value)} />
              <button className="btn sm primary" disabled={customTesting !== null || !vodUrl.trim()} onClick={() => void addCustomSource(vodLabel, vodUrl, 'vod')}>
                {customTesting ? <Loader2 size={13} className="spin" /> : <Plus size={13} />} 保存
              </button>
            </div>
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
          <div className="wt-set-block">
            <h4>TMDB API Key</h4>
            <div className="wt-set-note">热门推荐的榜单、海报和评分来自 TMDB，需要 Key 才能调用（TMDB 官网免费注册申请）。Key 加密存本机，不上传；不填不影响 AI 找剧和直播。</div>
            {tmdbKeySet ? (
              <div className="wt-set-row">
                <span className="fg-muted"><Check size={13} /> 已保存（加密存本机）</span>
                <button className="btn sm ghost" onClick={() => { clearTmdbKey(); setTmdbKeySet(false); setTrending([]) }}>清除</button>
              </div>
            ) : (
              <div className="wt-ai-row">
                <input className="input" type="password" placeholder="粘贴 TMDB API Key（v3 auth 密钥）" value={tmdbInput}
                  onChange={e => setTmdbInput(e.target.value)} />
                <button className="btn sm primary" disabled={tmdbSaving || !tmdbInput.trim()} onClick={() => void saveTmdb()}>
                  {tmdbSaving ? <Loader2 size={13} className="spin" /> : <Lock size={13} />} 保存 Key（加密存本机）
                </button>
              </div>
            )}
          </div>
          <div className="wt-set-block">
            <h4>推荐设置</h4>
            <div className="wt-set-note">管热门推荐榜单和 AI 找剧的推荐口径。</div>
            <div className="wt-set-row">
              <span>热门范围</span>
              <div className="wt-chips">
                {(['week', 'day', 'top'] as const).map(r => (
                  <button key={r} className={`wt-chip${trendRange === r ? ' on' : ''}`} onClick={() => setTrendRangeAndLoad(r)}>
                    {r === 'week' ? '本周热门' : r === 'day' ? '今日热门' : '高分精选'}
                  </button>
                ))}
              </div>
            </div>
            <div className="wt-set-row">
              <span>推荐类型</span>
              <div className="wt-chips">
                {(['all', 'tv', 'movie'] as const).map(t => (
                  <button key={t} className={`wt-chip${trendingTab === t ? ' on' : ''}`} onClick={() => setTrendType(t)}>
                    {t === 'all' ? '剧集 + 电影' : t === 'tv' ? '只看剧集' : '只看电影'}
                  </button>
                ))}
              </div>
            </div>
            <div className="wt-set-row">
              <span>找剧模型</span>
              <div className="wt-route"><RouteSelect data={data} routeKey={routeKey} setRouteKey={setRouteKey} /></div>
            </div>
            <div className="wt-set-note">推荐口径：AI 找剧只推正版平台（爱奇艺 / 腾讯视频 / 优酷 / 芒果 TV 等），不推盗版站。</div>
          </div>
          <div className="wt-set-block">
            <h4>直播体检</h4>
            <div className="wt-set-note">体检后不通的台默认从直播列表隐藏；打开后恢复显示（仍带 ✗ 不通角标）。未测的台一直显示。</div>
            <label className="wt-set-row" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={showDead} onChange={toggleShowDead} />
              <span>显示已测不通的台</span>
            </label>
          </div>
          <div className="fg-muted">内置源：iptv-org（公开免费频道目录）与 Free-TV。直播源本身可能失效：一个台播不了会自动换下一个源，全部失败会写清已试过几套。</div>
        </div>
      )}
    </div>
  )
}
