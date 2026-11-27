// 工坊 · Steam 迷你商城（v0.1.487）：分类/平台筛选、商店全目录搜索所需的
// appdetails 元数据补齐与 storesearch。数据全部来自 Steam 官方接口，价格/分类
// 以 Steam 返回为准，不编造。
// 分类口径（如实）：除「恐怖」外都来自 appdetails 的官方 genres（用类型 id
// 判定，与语言无关）；Steam 没有「恐怖」类型（它只是个标签 1667），恐怖走
// 商店搜索的标签筛选；「3A 大作」Steam 没有官方分类，用圈选口径（见 isTripleA）。
import { epicRequest } from './freeGames'
import {
  parseSteamSearchHtml, toSteamFetchError, formatSteamCents, storeUrlOf,
  type SteamDeal,
} from './steamDeals'

// ---------------- 分类与平台 ----------------

export type SteamCategoryKey = 'action' | 'rpg' | 'strategy' | 'simulation' | 'racing' | 'sports' | 'indie' | 'horror' | 'casual' | 'aaa'
export type SteamPlatformKey = 'windows' | 'mac' | 'linux'

export interface SteamCategoryDef {
  key: SteamCategoryKey
  label: string
  /** appdetails genres 的类型 id；horror（标签）与 aaa（圈选）为 null */
  genreId: number | null
}

export const STEAM_CATEGORIES: SteamCategoryDef[] = [
  { key: 'action', label: '动作', genreId: 1 },
  { key: 'rpg', label: '角色扮演', genreId: 3 },
  { key: 'strategy', label: '策略', genreId: 2 },
  { key: 'simulation', label: '模拟', genreId: 28 },
  { key: 'racing', label: '赛车', genreId: 9 },
  { key: 'sports', label: '体育', genreId: 18 },
  { key: 'indie', label: '独立', genreId: 23 },
  { key: 'horror', label: '恐怖', genreId: null },
  { key: 'casual', label: '休闲', genreId: 4 },
  { key: 'aaa', label: '3A 大作', genreId: null },
]

export const STEAM_PLATFORMS: { key: SteamPlatformKey; label: string }[] = [
  { key: 'windows', label: 'Windows' },
  { key: 'mac', label: 'Mac' },
  { key: 'linux', label: 'Linux' },
]

/** Steam「恐怖」标签 id（genres 里没有恐怖，商店搜索按标签筛） */
export const STEAM_HORROR_TAG_ID = 1667

export const AAA_NOTE = '「3A 大作」不是 Steam 官方分类：按圈选口径筛——大厂出品（发行/开发商在知名大厂名单内）、评测量高（≥5 万）、且不带「独立」类型。'
export const HORROR_NOTE = '「恐怖」在 Steam 里是标签不是类型，按 Steam 恐怖标签筛特惠；其余分类按官方类型（genres）。'

// ---------------- appdetails 元数据（genres / platforms / 发行商） ----------------

export interface SteamAppMeta {
  appid: string
  /** genres 类型 id 列表 */
  genres: number[]
  platforms: { windows: boolean; mac: boolean; linux: boolean }
  publishers: string[]
  developers: string[]
  /** appdetails 的 recommendations.total（总评测数）；无则 undefined */
  recommendations?: number
  /** appdetails 的 type（game/dlc/...）；查不到时为 'unknown' */
  type: string
  at: number
}

export const STEAM_META_CACHE_KEY = 'acm.steam.meta.v1'

export function loadSteamMetaCache(): Record<string, SteamAppMeta> {
  try {
    const raw = localStorage.getItem(STEAM_META_CACHE_KEY)
    if (!raw) return {}
    const data = JSON.parse(raw) as Record<string, SteamAppMeta>
    return data && typeof data === 'object' ? data : {}
  } catch { return {} }
}

export function saveSteamMetaCache(map: Record<string, SteamAppMeta>): void {
  try { localStorage.setItem(STEAM_META_CACHE_KEY, JSON.stringify(map)) } catch { /* 忽略 */ }
}

/** 解析 appdetails 单款响应 → 元数据。success=false / 无 data 返回 null。 */
export function parseAppDetailsMeta(appid: string, entry: unknown): SteamAppMeta | null {
  const e = (entry ?? {}) as { success?: unknown; data?: unknown }
  if (e.success !== true || !e.data || typeof e.data !== 'object') return null
  const d = e.data as {
    genres?: unknown; platforms?: unknown; publishers?: unknown; developers?: unknown
    recommendations?: unknown; type?: unknown
  }
  const genres: number[] = []
  if (Array.isArray(d.genres)) {
    for (const g of d.genres) {
      const id = parseInt(String((g as { id?: unknown })?.id ?? ''), 10)
      if (Number.isFinite(id)) genres.push(id)
    }
  }
  const pf = (d.platforms ?? {}) as { windows?: unknown; mac?: unknown; linux?: unknown }
  const strList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim().length > 0) : []
  const rec = (d.recommendations as { total?: unknown } | undefined)?.total
  return {
    appid,
    genres,
    platforms: { windows: pf.windows === true, mac: pf.mac === true, linux: pf.linux === true },
    publishers: strList(d.publishers),
    developers: strList(d.developers),
    recommendations: typeof rec === 'number' ? rec : undefined,
    type: typeof d.type === 'string' ? d.type : 'unknown',
    at: Date.now(),
  }
}

function buildAppMetaUrl(appid: string): string {
  const q = new URLSearchParams({ appids: appid, cc: 'CN', l: 'schinese' })
  return `https://store.steampowered.com/api/appdetails?${q.toString()}`
}

/** 查一款的元数据；接口失败抛错，查不到（下架等）返回 null。 */
export async function fetchSteamAppMeta(appid: string): Promise<SteamAppMeta | null> {
  let res: { ok: boolean; status: number; text: string }
  try {
    res = await epicRequest(buildAppMetaUrl(appid), 'GET', { Accept: 'application/json' })
  } catch (e) {
    throw toSteamFetchError(e)
  }
  if (!res.ok) throw new Error(`Steam 商城加载失败：Steam 商店返回 HTTP ${res.status}`)
  let data: Record<string, unknown>
  try {
    data = JSON.parse(res.text) as Record<string, unknown>
  } catch {
    throw new Error('Steam 商城加载失败：Steam 返回的数据不是有效 JSON')
  }
  return parseAppDetailsMeta(appid, data?.[appid])
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (it: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let idx = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return out
}

const META_ENRICH_CONCURRENCY = 4

/**
 * 批量补齐元数据：只查缓存里没有的 appid（不全量重拉），逐款落盘缓存，
 * 查不到的写墓碑条目（空类型）避免反复查同一款。onProgress 回报 (done, total)。
 * 返回最新完整缓存。单个失败只跳过该款（不写墓碑，下次可再试）。
 */
export async function enrichSteamMetas(
  appids: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<Record<string, SteamAppMeta>> {
  const map = loadSteamMetaCache()
  const missing = [...new Set(appids)].filter(id => !map[id])
  if (missing.length === 0) { onProgress?.(0, 0); return map }
  let done = 0
  await mapWithConcurrency(missing, META_ENRICH_CONCURRENCY, async (appid) => {
    try {
      const meta = await fetchSteamAppMeta(appid)
      map[appid] = meta ?? {
        appid, genres: [], platforms: { windows: false, mac: false, linux: false },
        publishers: [], developers: [], type: 'unknown', at: Date.now(),
      }
      saveSteamMetaCache(map)
    } catch { /* 跳过：不写缓存，下轮可再补 */ }
    done++
    onProgress?.(done, missing.length)
  })
  return map
}

// ---------------- 3A 圈选口径 ----------------

/** 知名大厂名单（小写子串匹配发行商/开发商名）。圈选口径，页面上如实标注。 */
export const AAA_MAJOR_TOKENS = [
  'valve', 'rockstar', 'cd projekt', 'electronic arts', 'ubisoft', 'activision',
  'bethesda', 'square enix', 'capcom', 'bandai namco', 'sega', '2k',
  'warner bros', 'xbox game studios', 'playstation', 'sony interactive',
  'fromsoftware', 'nintendo', 'take-two', 'take two', 'naughty dog',
  'santa monica', 'insomniac', 'guerrilla', 'sucker punch', 'bend studio',
]

export const AAA_MIN_REVIEWS = 50_000
const INDIE_GENRE_ID = 23

/**
 * 3A 圈选：大厂出品（发行商或开发商命中名单）+ 评测量高 + 不带「独立」类型。
 * 评测量优先用 appdetails 的 recommendations.total，没有时用搜索行的评测数。
 */
export function isTripleA(meta: SteamAppMeta | undefined, reviewCount?: number): boolean {
  if (!meta) return false
  if (meta.genres.includes(INDIE_GENRE_ID)) return false
  const volume = meta.recommendations ?? reviewCount ?? 0
  if (volume < AAA_MIN_REVIEWS) return false
  const names = [...meta.publishers, ...meta.developers].map(s => s.toLowerCase())
  return names.some(n => AAA_MAJOR_TOKENS.some(tok => n.includes(tok)))
}

// ---------------- 筛选（纯函数） ----------------

export interface SteamMallFilters {
  category: SteamCategoryKey | null
  platform: SteamPlatformKey | null
  discountOnly: boolean
}

/**
 * 按分类/平台/仅打折筛。列表只展示游戏本体（v0.1.505 起）：合集包恒不进
 * 列表（旧缓存里混进来的也在这里剔掉），合集包只出现在详情页的
 * 「版本与合集包」区。分类与平台只认有元数据的本体；还没有元数据的
 * 本体先不显示（界面会后台补齐，补齐后自动出现）。
 * 'horror' 在这一层不筛（恐怖的列表来源本身就是标签筛选结果）。
 */
export function filterSteamDeals(
  deals: SteamDeal[],
  metaByAppid: Record<string, SteamAppMeta>,
  f: SteamMallFilters,
): SteamDeal[] {
  return deals.filter(d => {
    if (d.kind !== 'game') return false
    if (f.discountOnly && d.discountPct <= 0) return false
    const needMeta = (f.category !== null && f.category !== 'horror') || f.platform !== null
    if (!needMeta) return true
    if (d.kind !== 'game') return false
    const meta = metaByAppid[d.appid]
    if (!meta) return false
    if (f.platform && !meta.platforms[f.platform]) return false
    if (f.category && f.category !== 'horror') {
      if (f.category === 'aaa') {
        if (!isTripleA(meta, d.reviewCount)) return false
      } else {
        const def = STEAM_CATEGORIES.find(c => c.key === f.category)
        if (!def || def.genreId === null || !meta.genres.includes(def.genreId)) return false
      }
    }
    return true
  })
}

/** 已选摘要（如「赛车 · Mac · 仅打折」），折叠时显示在筛选标题栏上。 */
export function buildFilterSummary(f: Pick<SteamMallFilters, 'category' | 'platform' | 'discountOnly'>): string {
  const parts: string[] = []
  if (f.category) parts.push(STEAM_CATEGORIES.find(c => c.key === f.category)?.label ?? '')
  if (f.platform) parts.push(f.platform === 'mac' ? 'Mac' : f.platform === 'windows' ? 'Windows' : 'Linux')
  if (f.discountOnly) parts.push('仅打折')
  return parts.filter(Boolean).join(' · ')
}

// ---------------- 商店全目录搜索（storesearch） ----------------

export function buildStoreSearchUrl(term: string): string {
  const q = new URLSearchParams({ term, l: 'schinese', cc: 'CN' })
  return `https://store.steampowered.com/api/storesearch/?${q.toString()}`
}

/**
 * 解析 storesearch 响应 → SteamDeal[]（含不打折的：搜全目录不限特惠）。
 * 只保留游戏本体（v0.1.505）：items 带 type 字段，'sub' 是合集包，跳过；
 * 无 type 字段的按本体处理（旧数据/夹具兼容）。
 */
export function parseStoreSearchResults(json: unknown): SteamDeal[] {
  const items = (json as { items?: unknown })?.items
  if (!Array.isArray(items)) return []
  const out: SteamDeal[] = []
  for (const it of items) {
    const r = (it ?? {}) as {
      id?: unknown; name?: unknown; tiny_image?: unknown; type?: unknown
      price?: { currency?: unknown; initial?: unknown; final?: unknown; discount_percent?: unknown } | null
    }
    if (r.type === 'sub') continue
    const id = typeof r.id === 'number' ? String(r.id) : typeof r.id === 'string' ? r.id : ''
    const name = typeof r.name === 'string' ? r.name.trim() : ''
    if (!id || !name) continue
    const price = r.price && typeof r.price === 'object' ? r.price : null
    const currency = typeof price?.currency === 'string' ? price.currency : 'CNY'
    const initial = typeof price?.initial === 'number' ? price.initial : 0
    const final = typeof price?.final === 'number' ? price.final : 0
    const discount = typeof price?.discount_percent === 'number' ? price.discount_percent : 0
    out.push({
      appid: id,
      kind: 'game',
      title: name,
      url: storeUrlOf(id),
      imageUrl: typeof r.tiny_image === 'string' ? r.tiny_image : '',
      discountPct: discount,
      originalPrice: price && initial > 0 ? formatSteamCents(initial, currency) : '',
      finalPrice: price ? formatSteamCents(final, currency) : '',
      finalPriceCents: price ? final : 0,
    })
  }
  return out
}

/** 商店全目录搜索；失败抛人话错误（调用方如实显示，不静默吞）。 */
export async function searchSteamStore(term: string): Promise<SteamDeal[]> {
  let res: { ok: boolean; status: number; text: string }
  try {
    res = await epicRequest(buildStoreSearchUrl(term), 'GET', { Accept: 'application/json' })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/load failed|failed to fetch|networkerror|network request failed/i.test(msg)) {
      throw new Error('Steam 商店搜索失败：网络请求失败，Steam 接口可能被代理/网络拦截，请换个节点再试')
    }
    throw e instanceof Error ? e : new Error(msg)
  }
  if (!res.ok) throw new Error(`Steam 商店搜索失败：Steam 商店返回 HTTP ${res.status}`)
  try {
    return parseStoreSearchResults(JSON.parse(res.text))
  } catch {
    throw new Error('Steam 商店搜索失败：Steam 返回的数据不是有效 JSON')
  }
}

// ---------------- 恐怖（标签筛选的特惠列表） ----------------

export function buildSteamTagSearchUrl(tagId: number, start: number, count = 100): string {
  const q = new URLSearchParams({
    query: '', start: String(start), count: String(count), dynamic_data: '',
    sort_by: '_ASC', specials: '1', infinite: '1', cc: 'CN', l: 'schinese',
    tags: String(tagId),
  })
  return `https://store.steampowered.com/search/results/?${q.toString()}`
}

/** 按标签拉一页特惠（恐怖用）；解析与主特惠列表同一套。 */
export async function fetchSteamTagDeals(tagId: number, start = 0, count = 100): Promise<{ total: number; items: SteamDeal[] }> {
  let res: { ok: boolean; status: number; text: string }
  try {
    res = await epicRequest(buildSteamTagSearchUrl(tagId, start, count), 'GET', { Accept: 'application/json' })
  } catch (e) {
    throw toSteamFetchError(e)
  }
  if (!res.ok) throw new Error(`Steam 商城加载失败：Steam 商店返回 HTTP ${res.status}`)
  let data: { total_count?: number; results_html?: string }
  try {
    data = JSON.parse(res.text) as { total_count?: number; results_html?: string }
  } catch {
    throw new Error('Steam 商城加载失败：Steam 返回的数据不是有效 JSON')
  }
  if (typeof data?.results_html !== 'string') {
    throw new Error('Steam 商城加载失败：Steam 返回的数据结构变了（无 results_html）')
  }
  return { total: data.total_count ?? 0, items: parseSteamSearchHtml(data.results_html) }
}

// ---------------- 筛选区折叠偏好（仅本机） ----------------

export const STEAM_FILTERS_OPEN_KEY = 'acm.steam.filtersOpen.v1'

export function loadFiltersOpen(): boolean {
  try { return localStorage.getItem(STEAM_FILTERS_OPEN_KEY) !== '0' } catch { return true }
}

export function saveFiltersOpen(open: boolean): void {
  try { localStorage.setItem(STEAM_FILTERS_OPEN_KEY, open ? '1' : '0') } catch { /* 忽略 */ }
}
