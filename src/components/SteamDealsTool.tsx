// 工坊 · Steam 迷你商城（v0.1.487，原 Steam 降价）：深色 Steam 商店风专属页。
// 商城：特惠列表（免 Key 公开接口）+ 商店全目录搜索 + 分类/平台筛选（appdetails
// 元数据补齐缓存）+ 分页九宫格；我的库：绑定自备 Steam Web API Key 拉全库。
// 价格/分类以 Steam 返回为准，不编造；拉不到时明确显示原因，不静默兜底。
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft, ChevronDown, ChevronRight, Clock, ExternalLink, Gamepad2, Loader2, RefreshCw,
  Search, SlidersHorizontal, TriangleAlert, Unlink, X,
} from 'lucide-react'
import { ToolShell } from './WorkshopView'
import { Pager } from './Pager'
import {
  loadSteamCache, loadSteamDeals, loadMoreSteamDeals,
  shouldEntryRefreshSteam,
  sortSteamDeals, dealKey, storeUrlOf,
  type SteamDeal, type SteamDealsCache, type SteamSort,
} from '../core/steamDeals'
import {
  fetchSteamGameDetail,
  type SteamGameDetail, type SteamPackageOption,
} from '../core/steamDetail'
import {
  STEAM_CATEGORIES, STEAM_PLATFORMS, AAA_NOTE, HORROR_NOTE,
  STEAM_HORROR_TAG_ID, filterSteamDeals, buildFilterSummary,
  searchSteamStore, fetchSteamTagDeals, enrichSteamMetas,
  loadSteamMetaCache, loadFiltersOpen, saveFiltersOpen,
  type SteamAppMeta, type SteamCategoryKey, type SteamPlatformKey,
} from '../core/steamMall'
import {
  STEAM_PRIVACY_NOTE, STEAM_API_KEY_HELP, STEAM_ID_INPUT_HELP,
  loadSteamProfileFast, loadSteamBinding, loadSteamLibraryCache,
  fetchSteamLibrary, bindSteamAccount, clearSteamBinding, buildBindFeedback,
  sortLibraryGames, summarizeLibrary, ownedAppidSet, humanizeSteamApiError,
  type SteamProfile, type SteamLibraryGame, type LibrarySort,
} from '../core/steamAccount'
import { openExternal, isDesktopApp } from '../core/openExternal'
import { steamClientUrlOfDeal, steamClientUrlOfApp, openViaClient } from '../core/clientLinks'

const PAGE_SIZE = 9

const SORTS: { key: SteamSort; label: string }[] = [
  { key: 'discount', label: '折扣最高' },
  { key: 'review', label: '好评最高' },
  { key: 'price', label: '价格最低' },
]

const LIB_SORTS: { key: LibrarySort; label: string }[] = [
  { key: 'playtime', label: '总时长' },
  { key: 'recent', label: '最近玩过' },
  { key: 'name', label: '名称' },
]

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function fmtPlaytime(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`
  const h = minutes / 60
  return `${Number.isInteger(h) ? h : h.toFixed(1)} 小时`
}

function fmtDate(sec: number): string {
  return new Date(sec * 1000).toLocaleDateString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' })
}

function DealCard({ deal, owned, onOpen, onDetail }: {
  deal: SteamDeal; owned: boolean
  /** 「直达 Steam 商店」小链接：直达客户端/浏览器，不进详情 */
  onOpen: (d: SteamDeal) => void
  /** 整卡点击：进 App 内详情页 */
  onDetail: (d: SteamDeal) => void
}) {
  const [imgOk, setImgOk] = useState(true)
  return (
    <div className="sm-card" role="button" tabIndex={0} title="点击查看游戏详情"
      onClick={() => onDetail(deal)}
      onKeyDown={e => { if (e.key === 'Enter') onDetail(deal) }}>
      <div className="sm-cover">
        {deal.imageUrl && imgOk
          ? <img src={deal.imageUrl} alt={deal.title} loading="lazy" onError={() => setImgOk(false)} />
          : <span className="sm-cover-fallback"><Gamepad2 size={26} /></span>}
        {deal.discountPct > 0 && <span className="sm-badge-discount">-{deal.discountPct}%</span>}
        {owned && <span className="sm-badge-owned">已入库</span>}
      </div>
      <div className="sm-card-body">
        <div className="sm-card-title">{deal.title}</div>
        <div className="sm-card-meta">
          {deal.finalPrice
            ? <>{deal.originalPrice && deal.discountPct > 0 && <s>{deal.originalPrice}</s>} <b className="sm-price">{deal.finalPrice}</b></>
            : <span>价格见商店页</span>}
        </div>
        <div className="sm-card-meta">
          {deal.reviewPct !== undefined
            ? <span>好评率 {deal.reviewPct}%{deal.reviewLabel ? ` · ${deal.reviewLabel}` : ''}{deal.reviewCount !== undefined ? `（${deal.reviewCount.toLocaleString('zh-CN')} 篇评测）` : ''}</span>
            : <span>{deal.released ? '' : '暂无评价'}</span>}
          {deal.released && <span>{deal.reviewPct !== undefined ? ' · ' : ''}{deal.released} 发售</span>}
        </div>
        <div className="sm-card-foot">
          <button className="sm-open" title="在 Steam 客户端打开商店页（没装客户端时走浏览器）"
            onClick={e => { e.stopPropagation(); onOpen(deal) }}>
            <ExternalLink size={12} /> 直达 Steam 商店
          </button>
        </div>
      </div>
    </div>
  )
}

function LibCard({ game, onOpen }: { game: SteamLibraryGame; onOpen: (g: SteamLibraryGame) => void }) {
  const [imgOk, setImgOk] = useState(true)
  return (
    <div className="sm-card" role="button" tabIndex={0} title="点击在 Steam 客户端打开商店页（没装客户端时走浏览器）"
      onClick={() => onOpen(game)}
      onKeyDown={e => { if (e.key === 'Enter') onOpen(game) }}>
      <div className="sm-cover">
        {imgOk
          ? <img src={game.coverUrl} alt={game.name} loading="lazy" onError={() => setImgOk(false)} />
          : <span className="sm-cover-fallback"><Gamepad2 size={26} /></span>}
      </div>
      <div className="sm-card-body">
        <div className="sm-card-title">{game.name}</div>
        <div className="sm-card-meta"><Clock size={12} /> 总时长 {fmtPlaytime(game.playtimeForever)}
          {game.playtime2Weeks !== undefined && game.playtime2Weeks > 0 && <span> · 近两周 {fmtPlaytime(game.playtime2Weeks)}</span>}
        </div>
        <div className="sm-card-meta">{game.lastPlayed ? `最近玩过：${fmtDate(game.lastPlayed)}` : '暂无游玩记录'}</div>
      </div>
    </div>
  )
}

export function SteamDealsTool({ notify, onBack }: {
  notify: (m: string, kind?: 'ok' | 'err') => void
  onBack: () => void
}) {
  const [tab, setTab] = useState<'mall' | 'library'>('mall')
  const [cache, setCache] = useState<SteamDealsCache | null>(() => loadSteamCache())
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sort, setSort] = useState<SteamSort>('discount')
  const [page, setPage] = useState(1)
  // 详情页（v0.1.505）：点卡片进详情；列表的筛选/排序/页码都是本组件 state，
  // 进出详情不卸载列表，返回时天然保留；滚动位置单独存取（见 openDetail/closeDetail）
  const [detailDeal, setDetailDeal] = useState<SteamDeal | null>(null)
  const listScrollTop = useRef(0)

  // 搜索（已拉数据先筛 + storesearch 全目录）
  const [queryInput, setQueryInput] = useState('')
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SteamDeal[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)

  // 分类/平台筛选与元数据补齐
  const [category, setCategory] = useState<SteamCategoryKey | null>(null)
  const [platform, setPlatform] = useState<SteamPlatformKey | null>(null)
  const [discountOnly, setDiscountOnly] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState<boolean>(() => loadFiltersOpen())
  const [metaMap, setMetaMap] = useState<Record<string, SteamAppMeta>>(() => loadSteamMetaCache())
  const [metaProgress, setMetaProgress] = useState<{ done: number; total: number } | null>(null)
  const metaRunning = useRef(false)
  const [horror, setHorror] = useState<{ total: number; items: SteamDeal[] } | null>(null)
  const [horrorLoading, setHorrorLoading] = useState(false)
  const [horrorError, setHorrorError] = useState<string | null>(null)

  // Steam 账户与游戏库
  const [profile, setProfile] = useState<SteamProfile | null>(() => loadSteamProfileFast())
  const [library, setLibrary] = useState<SteamLibraryGame[]>(() => loadSteamLibraryCache()?.games ?? [])
  const [libAt, setLibAt] = useState<number | null>(() => loadSteamLibraryCache()?.at ?? null)
  const [libLoading, setLibLoading] = useState(false)
  const [libError, setLibError] = useState<string | null>(null)
  const [libQuery, setLibQuery] = useState('')
  const [libSort, setLibSort] = useState<LibrarySort>('playtime')
  const [bindOpen, setBindOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const ownedSet = useMemo(() => ownedAppidSet(library), [library])

  const openDeal = async (deal: SteamDeal) => {
    const clientUrl = steamClientUrlOfDeal(deal)
    if (!clientUrl) { void openExternal(deal.url); return }
    const res = await openViaClient(clientUrl, deal.url)
    if (res.via === 'web' && isDesktopApp()) {
      notify(res.browserOpened === false
        ? `Steam 客户端直达失败（${res.reason}），浏览器也没打开，请手动打开 Steam 商店`
        : `Steam 客户端直达失败（${res.reason}），已在浏览器打开商店页`, 'err')
    }
  }

  // 进详情前记下列表滚动位置（滚动容器是外层 .main），返回时恢复
  const openDetail = (deal: SteamDeal) => {
    const scroller = document.querySelector('.main')
    listScrollTop.current = scroller?.scrollTop ?? 0
    setDetailDeal(deal)
    if (scroller) scroller.scrollTop = 0
  }

  const closeDetail = () => {
    setDetailDeal(null)
    requestAnimationFrame(() => {
      const scroller = document.querySelector('.main')
      if (scroller) scroller.scrollTop = listScrollTop.current
    })
  }

  /** 详情页里打开某个版本/合集包：客户端直达 sub 页，失败回落浏览器（口径同卡片直达） */
  const openPackage = async (pkg: SteamPackageOption) => {
    const clientUrl = steamClientUrlOfDeal({ kind: 'package', appid: pkg.packageId, url: pkg.url })
    if (!clientUrl) { void openExternal(pkg.url); return }
    const res = await openViaClient(clientUrl, pkg.url)
    if (res.via === 'web' && isDesktopApp()) {
      notify(res.browserOpened === false
        ? `Steam 客户端直达失败（${res.reason}），浏览器也没打开，请手动打开 Steam 商店`
        : `Steam 客户端直达失败（${res.reason}），已在浏览器打开商店页`, 'err')
    }
  }

  const openLibGame = async (game: SteamLibraryGame) => {
    const clientUrl = steamClientUrlOfApp(game.appid)
    const url = storeUrlOf(game.appid)
    if (!clientUrl) { void openExternal(url); return }
    const res = await openViaClient(clientUrl, url)
    if (res.via === 'web' && isDesktopApp()) {
      notify(`Steam 客户端直达失败（${res.reason}），已在浏览器打开商店页`, 'err')
    }
  }

  const refresh = async (force = false) => {
    setLoading(true)
    setError(null)
    try {
      const c = await loadSteamDeals(force)
      setCache(c)
      setPage(1)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      notify(msg, 'err')
    } finally {
      setLoading(false)
    }
  }

  // 首屏（v0.1.470）：进页自动刷新一次——无缓存走完整刷新；有缓存但距上次
  // 拉取已超过 5 分钟则静默刷新；5 分钟内直接用缓存。1 小时缓存仍作兜底。
  useEffect(() => {
    const cached = loadSteamCache()
    if (!cached) { void refresh(false); return }
    if (!shouldEntryRefreshSteam(cached.at)) return
    let dead = false
    void (async () => {
      try {
        const c = await loadSteamDeals(true)
        if (!dead) { setCache(c); setPage(1) }
      } catch { /* 静默：已有缓存可看，手动刷新会报真实原因 */ }
    })()
    return () => { dead = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 恐怖分类：切到恐怖时按标签拉特惠（Steam 无恐怖类型，标签 1667）
  useEffect(() => {
    if (category !== 'horror' || horror || horrorLoading) return
    let dead = false
    setHorrorLoading(true)
    setHorrorError(null)
    void (async () => {
      try {
        const r = await fetchSteamTagDeals(STEAM_HORROR_TAG_ID, 0)
        if (!dead) { setHorror(r); setPage(1) }
      } catch (e) {
        if (!dead) setHorrorError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!dead) setHorrorLoading(false)
      }
    })()
    return () => { dead = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, horror])

  const submitSearch = async () => {
    const q = queryInput.trim()
    setQuery(q)
    setPage(1)
    if (!q) { setSearchResults(null); setSearchError(null); return }
    setSearching(true)
    setSearchError(null)
    try {
      setSearchResults(await searchSteamStore(q))
    } catch (e) {
      setSearchResults(null)
      setSearchError(e instanceof Error ? e.message : String(e))
    } finally {
      setSearching(false)
    }
  }

  const clearSearch = () => {
    setQueryInput('')
    setQuery('')
    setSearchResults(null)
    setSearchError(null)
    setPage(1)
  }

  // 当前基础列表：搜索态 = 已拉数据匹配 + 商店全目录结果（去重）；恐怖 = 标签特惠；否则特惠缓存
  const baseList = useMemo<SteamDeal[]>(() => {
    if (query) {
      const q = query.toLowerCase()
      const local = (cache?.items ?? []).filter(d => d.title.toLowerCase().includes(q))
      const seen = new Set(local.map(dealKey))
      const remote = (searchResults ?? []).filter(d => !seen.has(dealKey(d)))
      return [...local, ...remote]
    }
    if (category === 'horror') return horror?.items ?? []
    return cache?.items ?? []
  }, [query, cache, searchResults, category, horror])

  // 启用分类/平台筛选时，后台补齐基础列表里缺失的元数据（缓存命中不重拉）
  const baseGameIdsKey = useMemo(
    () => baseList.filter(d => d.kind === 'game').map(d => d.appid).join(','),
    [baseList],
  )
  useEffect(() => {
    const needMeta = (category !== null && category !== 'horror') || platform !== null
    if (!needMeta || metaRunning.current) return
    const ids = baseGameIdsKey ? baseGameIdsKey.split(',').filter(id => !metaMap[id]) : []
    if (ids.length === 0) return
    metaRunning.current = true
    setMetaProgress({ done: 0, total: ids.length })
    void enrichSteamMetas(ids, (done, total) => setMetaProgress({ done, total }))
      .then(map => setMetaMap(map))
      .catch(() => { /* 失败的没写缓存，切换筛选时可再补 */ })
      .finally(() => { metaRunning.current = false; setMetaProgress(null) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, platform, baseGameIdsKey])

  const filtered = useMemo(
    () => filterSteamDeals(baseList, metaMap, { category, platform, discountOnly }),
    [baseList, metaMap, category, platform, discountOnly],
  )
  const sorted = useMemo(() => sortSteamDeals(filtered, sort), [filtered, sort])
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount)
  const pageItems = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)
  const searchFetched = cache?.searchFetched ?? cache?.items.length ?? 0
  const hasMore = !!cache && !query && category !== 'horror' && searchFetched < cache.total
  const summary = buildFilterSummary({ category, platform, discountOnly })
  const metaPending = useMemo(
    () => baseList.filter(d => d.kind === 'game' && !metaMap[d.appid]).length,
    [baseList, metaMap],
  )

  const loadMore = async () => {
    setLoadingMore(true)
    try {
      const c = await loadMoreSteamDeals()
      setCache(c)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      notify(msg, 'err')
    } finally {
      setLoadingMore(false)
    }
  }

  const toggleFilters = () => {
    setFiltersOpen(o => {
      saveFiltersOpen(!o)
      return !o
    })
  }

  const pickCategory = (key: SteamCategoryKey) => {
    setCategory(c => (c === key ? null : key))
    setPage(1)
  }
  const pickPlatform = (key: SteamPlatformKey) => {
    setPlatform(p => (p === key ? null : key))
    setPage(1)
  }

  // ---------------- 账户与库 ----------------

  const refreshLibrary = async () => {
    let loaded: Awaited<ReturnType<typeof loadSteamBinding>> = null
    try { loaded = await loadSteamBinding() } catch { loaded = null }
    if (!loaded) { setLibError('绑定信息读取失败（本地凭据损坏），请解绑后重新绑定。'); return }
    setLibLoading(true)
    setLibError(null)
    try {
      const games = await fetchSteamLibrary(loaded.apiKey, loaded.binding.profile.steamid)
      setLibrary(games)
      setLibAt(Date.now())
      notify(`游戏库已刷新：共 ${games.length} 款`)
    } catch (e) {
      setLibError(humanizeSteamApiError(e))
    } finally {
      setLibLoading(false)
    }
  }

  const unbind = () => {
    clearSteamBinding()
    setProfile(null)
    setLibrary([])
    setLibAt(null)
    setLibError(null)
    setMenuOpen(false)
    notify('已解绑 Steam 账户（本地凭据与库缓存已清除）')
  }

  const libSummary = useMemo(() => summarizeLibrary(library), [library])
  const libFiltered = useMemo(() => {
    const q = libQuery.trim().toLowerCase()
    const list = q ? library.filter(g => g.name.toLowerCase().includes(q)) : library
    return sortLibraryGames(list, libSort)
  }, [library, libQuery, libSort])

  return (
    <ToolShell wide title="Steam 迷你商城" desc="Steam 商店特惠与全目录搜索：折扣、现价、原价、好评率，可按分类/平台筛选；绑定你的 Steam 账户后还能看「我的库」，商城里已拥有的游戏会标「已入库」。" onBack={onBack}>
      <div className="sm-root">
        <div className="sm-head">
          <div className="sm-tabs" role="tablist" aria-label="Steam 商城页签">
            <button className={`sm-tab ${tab === 'mall' ? 'on' : ''}`} onClick={() => setTab('mall')}>商城</button>
            <button className={`sm-tab ${tab === 'library' ? 'on' : ''}`} onClick={() => setTab('library')}>我的库</button>
          </div>
          <div className="sm-account">
            {profile ? (
              <>
                <button className="sm-account-btn" onClick={() => setMenuOpen(o => !o)}>
                  {profile.avatarUrl
                    ? <img src={profile.avatarUrl} alt="" className="sm-avatar" />
                    : <span className="sm-avatar sm-avatar-fallback"><Gamepad2 size={14} /></span>}
                  <span className="sm-account-meta">
                    <span className="sm-account-name">{profile.personaName}</span>
                    <span className="sm-account-id">SteamID {profile.steamid}</span>
                  </span>
                  <ChevronDown size={14} />
                </button>
                {menuOpen && (
                  <>
                    <div className="sm-menu-backdrop" onClick={() => setMenuOpen(false)} />
                    <div className="sm-menu">
                      <div className="sm-menu-id">SteamID {profile.steamid}</div>
                      <button onClick={() => { setTab('library'); setMenuOpen(false) }}>查看我的库</button>
                      <button onClick={() => { setMenuOpen(false); void refreshLibrary() }}>刷新游戏库</button>
                      <button className="danger" onClick={unbind}><Unlink size={13} /> 解绑</button>
                    </div>
                  </>
                )}
              </>
            ) : (
              <button className="sm-bind-btn" onClick={() => setBindOpen(true)}>绑定 Steam 账户</button>
            )}
          </div>
        </div>

        {tab === 'mall' && detailDeal && (
          <SteamDetailView
            deal={detailDeal}
            owned={ownedSet.has(detailDeal.appid)}
            onBack={closeDetail}
            onOpenApp={openDeal}
            onOpenPackage={openPackage}
          />
        )}

        {tab === 'mall' && !detailDeal && (
          <>
            <div className="sm-searchbar">
              <div className="sm-searchbox">
                <Search size={15} />
                <input value={queryInput} placeholder="搜游戏名：先筛已拉到的特惠，再搜 Steam 商店全目录…"
                  onChange={e => setQueryInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') void submitSearch() }} />
                {queryInput && (
                  <button className="sm-search-clear" title="清空搜索" onClick={clearSearch}><X size={14} /></button>
                )}
              </div>
              <button className="sm-search-btn" disabled={searching} onClick={() => void submitSearch()}>
                {searching ? <Loader2 size={14} className="spin" /> : <Search size={14} />} 搜索
              </button>
              <button className="sm-refresh-btn" disabled={loading} onClick={() => void refresh(true)} title="刷新特惠列表">
                {loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} 刷新
              </button>
            </div>
            {query && (
              <div className="sm-search-note">
                搜索「{query}」：已拉特惠里匹配 + Steam 商店全目录结果
                {searching && ' · 正在搜商店全目录…'}
                {searchResults !== null && ` · 商店返回 ${searchResults.length} 款`}
                <button className="sm-link" onClick={clearSearch}>清空搜索</button>
              </div>
            )}
            {searchError && (
              <div className="sm-alert"><TriangleAlert size={14} /><span>{searchError}（下面是已拉特惠里匹配的结果）</span></div>
            )}

            <div className="sm-filters">
              <button className="sm-filters-head" onClick={toggleFilters} aria-expanded={filtersOpen}>
                <span className="sm-filters-head-left"><SlidersHorizontal size={14} /> 筛选
                  {summary && <span className="sm-filters-summary">{summary}</span>}
                </span>
                <ChevronDown size={15} className={filtersOpen ? 'rot' : ''} />
              </button>
              {filtersOpen && (
                <div className="sm-filters-body">
                  <div className="sm-frow">
                    <span className="sm-flabel">排序</span>
                    <div className="sm-chips">
                      {SORTS.map(s => (
                        <button key={s.key} className={`sm-chip ${sort === s.key ? 'on' : ''}`}
                          onClick={() => { setSort(s.key); setPage(1) }}>{s.label}</button>
                      ))}
                    </div>
                  </div>
                  <div className="sm-frow">
                    <span className="sm-flabel">分类</span>
                    <div className="sm-chips">
                      {STEAM_CATEGORIES.map(c => (
                        <button key={c.key} className={`sm-chip ${category === c.key ? 'on' : ''}`}
                          onClick={() => pickCategory(c.key)}>{c.label}</button>
                      ))}
                    </div>
                  </div>
                  <div className="sm-frow">
                    <span className="sm-flabel">平台</span>
                    <div className="sm-chips">
                      {STEAM_PLATFORMS.map(p => (
                        <button key={p.key} className={`sm-chip ${platform === p.key ? 'on' : ''}`}
                          onClick={() => pickPlatform(p.key)}>{p.label}</button>
                      ))}
                      <button className={`sm-chip ${discountOnly ? 'on' : ''}`}
                        onClick={() => { setDiscountOnly(o => !o); setPage(1) }}>仅打折</button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {cache && !query && category !== 'horror' && (
              <div className="sm-source">
                Steam 商店公开接口 · 更新于 {fmtTime(cache.at)}
                · 共 {cache.total.toLocaleString('zh-CN')} 款打折中，已拉 {searchFetched.toLocaleString('zh-CN')} 款（列表只显示游戏本体，合集包在各游戏详情页里看）
              </div>
            )}
            {category === 'horror' && (
              <div className="sm-source">{HORROR_NOTE}{horror && ` · 恐怖特惠共 ${horror.total.toLocaleString('zh-CN')} 款，已拉 ${horror.items.length} 款`}</div>
            )}
            {category === 'aaa' && <div className="sm-source">{AAA_NOTE}</div>}
            {(category !== null && category !== 'horror') || platform !== null ? (
              <div className="sm-source">
                {metaProgress
                  ? `正在补齐分类信息… ${metaProgress.done}/${metaProgress.total}（补齐一款显示一款，补过的会缓存）`
                  : metaPending > 0
                    ? `还有 ${metaPending} 款的分类信息没补齐，稍后自动继续`
                    : '分类信息已补齐'}
              </div>
            ) : null}

            {loading && !cache && (
              <div className="sm-empty"><Loader2 size={14} className="spin" /> 正在拉 Steam 打折列表…</div>
            )}
            {horrorLoading && (
              <div className="sm-empty"><Loader2 size={14} className="spin" /> 正在拉恐怖特惠…</div>
            )}
            {horrorError && category === 'horror' && (
              <div className="sm-alert"><TriangleAlert size={14} /><span>恐怖特惠加载失败：{horrorError}</span></div>
            )}
            {error && !cache && (
              <div className="sm-alert big">
                <TriangleAlert size={14} />
                <span>{error}</span>
                <button className="sm-search-btn" disabled={loading} onClick={() => void refresh(true)}>重试</button>
              </div>
            )}
            {error && cache && (
              <div className="sm-alert"><TriangleAlert size={14} /><span>刷新失败，显示的是上次拉到的数据：{error}</span></div>
            )}

            {pageItems.length > 0 && (
              <div className="sm-grid">
                {pageItems.map(d => (
                  <DealCard key={dealKey(d)} deal={d} owned={ownedSet.has(d.appid)} onOpen={openDeal} onDetail={openDetail} />
                ))}
              </div>
            )}
            {cache && pageItems.length === 0 && !loading && !horrorLoading && (
              <div className="sm-empty">
                {query
                  ? '没有匹配的游戏：换个关键词，或清掉分类/平台筛选再看。'
                  : (category !== null && category !== 'horror') || platform !== null
                    ? (metaProgress ? '正在补齐分类信息，补齐后会自动出现…' : '当前已拉到的列表里没有符合这个分类/平台的游戏，点「加载更多」拉更多再看。')
                    : 'Steam 当前没有打折游戏（或返回为空），过会儿再刷新看看。'}
              </div>
            )}

            {hasMore && (
              <div className="sm-loadmore">
                <button className="sm-more-btn" disabled={loadingMore} onClick={() => void loadMore()}>
                  {loadingMore ? <Loader2 size={14} className="spin" /> : null} 加载更多（已拉 {searchFetched.toLocaleString('zh-CN')} / {cache.total.toLocaleString('zh-CN')} 款）
                </button>
              </div>
            )}
            {sorted.length > PAGE_SIZE && (
              <div className="sm-pagerbar">
                <Pager page={safePage} pageCount={pageCount} total={sorted.length} unit="款" onPage={setPage} />
              </div>
            )}
          </>
        )}

        {tab === 'library' && (
          <>
            {!profile ? (
              <div className="sm-empty big">
                <p>还没绑定 Steam 账户。绑定后这里会列出你库里的全部游戏（封面、总时长、最近玩过），商城里已拥有的游戏也会标「已入库」，避免重复买。</p>
                <p className="sm-note">{STEAM_PRIVACY_NOTE}</p>
                <button className="sm-bind-btn" onClick={() => setBindOpen(true)}>绑定 Steam 账户</button>
              </div>
            ) : (
              <>
                <div className="sm-lib-summary">
                  <span><b>{libSummary.total}</b> 款游戏</span>
                  <span>总时长 <b>{libSummary.totalHours.toLocaleString('zh-CN')} 小时</b></span>
                  <span>近 30 天玩过 <b>{libSummary.recent30}</b> 款</span>
                  {libAt && <span className="sm-lib-at">更新于 {fmtTime(libAt)}</span>}
                  <button className="sm-refresh-btn" disabled={libLoading} onClick={() => void refreshLibrary()}>
                    {libLoading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} 刷新游戏库
                  </button>
                </div>
                <div className="sm-searchbar">
                  <div className="sm-searchbox">
                    <Search size={15} />
                    <input value={libQuery} placeholder="在我的库里搜游戏名…"
                      onChange={e => setLibQuery(e.target.value)} />
                    {libQuery && (
                      <button className="sm-search-clear" title="清空" onClick={() => setLibQuery('')}><X size={14} /></button>
                    )}
                  </div>
                  <div className="sm-chips">
                    {LIB_SORTS.map(s => (
                      <button key={s.key} className={`sm-chip ${libSort === s.key ? 'on' : ''}`}
                        onClick={() => setLibSort(s.key)}>{s.label}</button>
                    ))}
                  </div>
                </div>
                {libError && (
                  <div className="sm-alert">
                    <TriangleAlert size={14} />
                    <span>{library.length > 0 ? `刷新失败，显示的是上次拉到的库：${libError}` : libError}</span>
                  </div>
                )}
                {libLoading && library.length === 0 && (
                  <div className="sm-empty"><Loader2 size={14} className="spin" /> 正在拉你的游戏库…</div>
                )}
                {!libLoading && library.length === 0 && !libError && (
                  <div className="sm-empty">游戏库还没拉过，点「刷新游戏库」拉一次。</div>
                )}
                {libFiltered.length > 0 && (
                  <div className="sm-grid">
                    {libFiltered.map(g => <LibCard key={g.appid} game={g} onOpen={openLibGame} />)}
                  </div>
                )}
                {library.length > 0 && libFiltered.length === 0 && (
                  <div className="sm-empty">库里没有名字带「{libQuery}」的游戏。</div>
                )}
              </>
            )}
          </>
        )}
      </div>

      {bindOpen && (
        <BindModal
          onClose={() => setBindOpen(false)}
          onBound={(prof, lib, libErr) => {
            setProfile(prof)
            setBindOpen(false)
            if (lib) { setLibrary(lib); setLibAt(Date.now()); setLibError(null) }
            else if (libErr) { setLibError(libErr) }
            const fb = buildBindFeedback(prof, libErr)
            notify(fb.message, fb.ok ? 'ok' : 'err')
          }}
        />
      )}
    </ToolShell>
  )
}

/**
 * 游戏详情页（v0.1.505，商城内部视图）：数据进页才拉（appdetails + appreviews +
 * packagedetails，带 1 小时本机缓存）。缺字段就不显示那一行；拉失败显示
 * 人话原因 + 重试，不白屏。购买仍在 Steam 客户端/浏览器完成，App 内只看不下单。
 */
function SteamDetailView({ deal, owned, onBack, onOpenApp, onOpenPackage }: {
  deal: SteamDeal
  owned: boolean
  onBack: () => void
  onOpenApp: (d: SteamDeal) => void
  onOpenPackage: (p: SteamPackageOption) => void
}) {
  const [detail, setDetail] = useState<SteamGameDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retryTick, setRetryTick] = useState(0)
  const [shotIdx, setShotIdx] = useState(0)
  const [imgOk, setImgOk] = useState(true)

  useEffect(() => {
    let dead = false
    setLoading(true)
    setError(null)
    setDetail(null)
    setShotIdx(0)
    setImgOk(true)
    void (async () => {
      try {
        const d = await fetchSteamGameDetail(deal.appid, retryTick > 0)
        if (!dead) setDetail(d)
      } catch (e) {
        if (!dead) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!dead) setLoading(false)
      }
    })()
    return () => { dead = true }
  }, [deal.appid, retryTick])

  const shots = useMemo(() => {
    if (!detail) return [] as { thumb: string; full: string }[]
    const head = detail.headerImage ? [{ thumb: detail.headerImage, full: detail.headerImage }] : []
    return [...head, ...detail.screenshots]
  }, [detail])
  const activeShot = shots[Math.min(shotIdx, Math.max(0, shots.length - 1))]

  // 价格：详情接口的总览价优先；接口没给时回落列表行自带价格（同为 Steam 返回，不编造）
  const price = detail?.price ?? (deal.finalPrice
    ? { discountPct: deal.discountPct, originalPrice: deal.originalPrice, finalPrice: deal.finalPrice, finalPriceCents: deal.finalPriceCents }
    : undefined)
  const reviewPct = detail?.reviewPct ?? deal.reviewPct
  const reviewCount = detail?.reviewCount ?? deal.reviewCount

  return (
    <div className="sm-detail">
      <div className="sm-detail-topbar">
        <button className="sm-back-btn" onClick={onBack}><ArrowLeft size={15} /> 返回商城</button>
        <div className="sm-crumb">
          <button className="sm-crumb-link" onClick={onBack}>商城</button>
          <ChevronRight size={13} />
          <span className="sm-crumb-here">{detail?.name ?? deal.title}</span>
        </div>
      </div>

      {loading && (
        <div className="sm-empty"><Loader2 size={14} className="spin" /> 正在加载游戏详情…</div>
      )}
      {error && !loading && (
        <div className="sm-alert big">
          <TriangleAlert size={14} />
          <span>{error}</span>
          <button className="sm-search-btn" onClick={() => setRetryTick(t => t + 1)}>重试</button>
        </div>
      )}

      {detail && !loading && (
        <>
          <div className="sm-detail-main">
            <div className="sm-detail-left">
              <div className="sm-detail-hero">
                {activeShot && imgOk
                  ? <img src={activeShot.full} alt={detail.name} onError={() => setImgOk(false)} />
                  : <span className="sm-cover-fallback"><Gamepad2 size={34} /></span>}
              </div>
              {shots.length > 1 && (
                <div className="sm-detail-thumbs">
                  {shots.map((s, i) => (
                    <button key={`${s.full}-${i}`} className={`sm-thumb ${i === shotIdx ? 'on' : ''}`}
                      onClick={() => { setShotIdx(i); setImgOk(true) }} title={`截图 ${i + 1}`}>
                      <img src={s.thumb} alt="" loading="lazy" />
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="sm-detail-right">
              <h2 className="sm-detail-title">{detail.name}</h2>
              {detail.shortDescription && <p className="sm-detail-short">{detail.shortDescription}</p>}
              <div className="sm-detail-facts">
                {reviewPct !== undefined && (
                  <div className="sm-fact"><span>好评率</span><b>{reviewPct}%{reviewCount !== undefined ? `（${reviewCount.toLocaleString('zh-CN')} 篇评测）` : ''}</b></div>
                )}
                {detail.releaseDate && <div className="sm-fact"><span>发售日</span><b>{detail.releaseDate}</b></div>}
                {detail.developers.length > 0 && <div className="sm-fact"><span>开发商</span><b>{detail.developers.join('、')}</b></div>}
                {detail.publishers.length > 0 && <div className="sm-fact"><span>发行商</span><b>{detail.publishers.join('、')}</b></div>}
              </div>
              {detail.genres.length > 0 && (
                <div className="sm-detail-genres">
                  {detail.genres.map(g => <span key={g} className="sm-genre-chip">{g}</span>)}
                </div>
              )}
              {owned && <div className="sm-owned-bar">已入库 · 这款游戏已经在你的游戏库里</div>}
              <div className="sm-detail-pricebox">
                {detail.isFree
                  ? <span className="sm-detail-free">免费游玩</span>
                  : price
                    ? <>
                        {price.discountPct > 0 && <span className="sm-badge-discount inline">-{price.discountPct}%</span>}
                        {price.originalPrice && price.discountPct > 0 && <s className="sm-detail-orig">{price.originalPrice}</s>}
                        <span className="sm-detail-final">{price.finalPrice}</span>
                      </>
                    : <span className="sm-detail-noprice">价格见商店页</span>}
              </div>
              <div className="sm-detail-actions">
                <button className="sm-client-btn" onClick={() => onOpenApp(deal)}>在 Steam 客户端打开</button>
                <button className="sm-browser-btn" onClick={() => void openExternal(storeUrlOf(deal.appid))}>浏览器打开</button>
              </div>
            </div>
          </div>

          {detail.packages.length > 1 && (
            <div className="sm-pkg-section">
              <h3 className="sm-detail-h">版本与合集包</h3>
              <div className="sm-pkg-list">
                {detail.packages.map(pkg => (
                  <div key={pkg.packageId} className={`sm-pkg-row ${pkg.isBase ? 'base' : ''}`}>
                    <div className="sm-pkg-main">
                      <div className="sm-pkg-name">
                        {pkg.name || `合集包 ${pkg.packageId}`}
                        {pkg.isBase && <span className="sm-pkg-base-badge">当前展示价</span>}
                      </div>
                      {pkg.description && <div className="sm-pkg-desc">{pkg.description}</div>}
                    </div>
                    <div className="sm-pkg-price">
                      {pkg.discountPct > 0 && <span className="sm-badge-discount inline">-{pkg.discountPct}%</span>}
                      {pkg.originalPrice && pkg.discountPct > 0 && <s>{pkg.originalPrice}</s>}
                      {pkg.finalPrice
                        ? <b>{pkg.finalPrice}</b>
                        : <span className="sm-pkg-noprice">价格见商店页</span>}
                    </div>
                    <button className="sm-pkg-open" onClick={() => onOpenPackage(pkg)}>在 Steam 打开</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {detail.aboutText && (
            <div className="sm-detail-about-wrap">
              <h3 className="sm-detail-h">关于这款游戏</h3>
              <div className="sm-detail-about">{detail.aboutText}</div>
            </div>
          )}

          {detail.requirements && (detail.requirements.minimum || detail.requirements.recommended) && (
            <div className="sm-detail-req-wrap">
              <h3 className="sm-detail-h">系统配置</h3>
              <div className="sm-detail-reqs">
                {detail.requirements.minimum && (
                  <div className="sm-req">
                    <div className="sm-req-title">最低配置</div>
                    <div className="sm-req-body">{detail.requirements.minimum}</div>
                  </div>
                )}
                {detail.requirements.recommended && (
                  <div className="sm-req">
                    <div className="sm-req-title">推荐配置</div>
                    <div className="sm-req-body">{detail.requirements.recommended}</div>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function BindModal({ onClose, onBound }: {
  onClose: () => void
  onBound: (profile: SteamProfile, library: SteamLibraryGame[] | null, libraryError: string | null) => void
}) {
  const [apiKey, setApiKey] = useState('')
  const [idInput, setIdInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setErr(null)
    try {
      const r = await bindSteamAccount(apiKey, idInput)
      onBound(r.binding.profile, r.library, r.libraryError)
    } catch (e) {
      setErr(humanizeSteamApiError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal sm-bind-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h3>绑定 Steam 账户</h3>
          <button className="btn sm ghost" onClick={onClose}><X size={15} /></button>
        </div>
        <div className="modal-body">
          <label className="sm-field">
            <span>Steam Web API Key</span>
            <input type="password" value={apiKey} placeholder="在 steamcommunity.com/dev/apikey 免费申请"
              onChange={e => setApiKey(e.target.value)} autoComplete="off" />
          </label>
          <p className="sm-note">{STEAM_API_KEY_HELP}
            <button className="sm-link" onClick={() => void openExternal('https://steamcommunity.com/dev/apikey')}>打开申请页</button>
          </p>
          <label className="sm-field">
            <span>SteamID 或个人资料链接</span>
            <input value={idInput} placeholder="粘贴个人资料链接，或填 17 位 SteamID64"
              onChange={e => setIdInput(e.target.value)} autoComplete="off" />
          </label>
          <p className="sm-note">{STEAM_ID_INPUT_HELP}</p>
          <p className="sm-note">{STEAM_PRIVACY_NOTE}</p>
          {err && <div className="sm-alert"><TriangleAlert size={14} /><span>{err}</span></div>}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={busy || !apiKey.trim() || !idInput.trim()} onClick={() => void submit()}>
            {busy ? <Loader2 size={14} className="spin" /> : null} 绑定并拉取游戏库
          </button>
        </div>
      </div>
    </div>
  )
}
