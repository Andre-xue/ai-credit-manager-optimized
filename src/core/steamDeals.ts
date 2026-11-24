// 工坊 · Steam 降价（v0.1.399）：Steam 商店公开接口（免 Key）列当前打折游戏。
// 数据源：store.steampowered.com/search/results/?...&specials=1（打折筛选），
// 返回 JSON { success, total_count, results_html }；results_html 是商店列表 HTML，
// 每行自带折扣、原价/现价、好评率 tooltip。价格以 Steam 返回的文本为准，不编造。
// CORS：Steam 接口不返回 Access-Control-Allow-Origin，桌面 WKWebView 前端 fetch
// 会被拦——走 freeGames 的 epicRequest 原生通道（桌面 plugin_http / 安卓
// CapacitorHttp / 网页 fetch），与 Epic 同一套出口。网页版无原生通道时走 fetch，
// 仍会被 CORS 拦，失败原因会明确显示，不静默兜底。
import { epicRequest } from './freeGames'

export interface SteamDeal {
  appid: string
  title: string
  url: string
  imageUrl: string
  /** 折扣百分比，如 80 表示 -80% */
  discountPct: number
  /** 原价文本（Steam 返回，如 ¥198.00），无则为空串 */
  originalPrice: string
  /** 现价文本（Steam 返回，如 ¥39.60） */
  finalPrice: string
  /** 现价（分），用于排序 */
  finalPriceCents: number
  /** 好评率，如 95；无评价时为 undefined */
  reviewPct?: number
  /** 评测篇数，如 126948；无评价时为 undefined */
  reviewCount?: number
  /** 评价档位词，如 好评如潮；无评价时为 undefined */
  reviewLabel?: string
  /** 发售日期文本（Steam 返回），如 2021 年 3 月 25 日 */
  released?: string
}

export type SteamSort = 'discount' | 'review' | 'price'

export const STEAM_DEALS_CACHE_KEY = 'acm.steam.deals.v1'
export const STEAM_DEALS_CACHE_TTL_MS = 60 * 60_000
export const STEAM_DEALS_PAGE_SIZE = 100

export interface SteamDealsCache {
  at: number
  /** Steam 返回的打折总数（当前约两万款，大促期间更多） */
  total: number
  items: SteamDeal[]
}

export function buildSteamSearchUrl(start: number, count = STEAM_DEALS_PAGE_SIZE): string {
  const q = new URLSearchParams({
    query: '',
    start: String(start),
    count: String(count),
    dynamic_data: '',
    sort_by: '_ASC',
    specials: '1',
    infinite: '1',
    cc: 'CN',
    l: 'schinese',
  })
  return `https://store.steampowered.com/search/results/?${q.toString()}`
}

export function storeUrlOf(appid: string): string {
  return `https://store.steampowered.com/app/${appid}/`
}

/** 解析 data-tooltip-html 里的好评信息（属性值是实体转义过的，先解码）。 */
function decodeEntities(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
}

function parseReview(tooltipRaw: string): { pct: number; count: number; label: string } | undefined {
  const text = decodeEntities(tooltipRaw)
  const m = text.match(/([\d,]+)\s*篇用户评测中有\s*(\d+)%\s*为好评/)
  if (!m) return undefined
  const label = text.split('<br>')[0].replace(/<[^>]*>/g, '').trim()
  return { pct: parseInt(m[2], 10), count: parseInt(m[1].replace(/,/g, ''), 10), label }
}

/**
 * 解析 Steam 搜索返回的 results_html：每行一个游戏（.search_result_row）。
 * 定向正则解析（无 DOMParser 依赖：单测跑在 node 环境，且不引入 jsdom）。
 * 拿不到关键字段（appid/标题/折扣）的行直接丢弃；整页一行都解析不出时由调用方报错。
 */
export function parseSteamSearchHtml(html: string): SteamDeal[] {
  const out: SteamDeal[] = []
  const rowRe = /<a\b[^>]*data-ds-appid="(\d+)"[^>]*>([\s\S]*?)<\/a>/g
  let row: RegExpExecArray | null
  while ((row = rowRe.exec(html)) !== null) {
    const appid = row[1]
    const body = row[2]
    const titleM = body.match(/<span class="title">([^<]*)<\/span>/)
    const title = titleM ? titleM[1].trim() : ''
    const imgM = body.match(/<div class="search_capsule"><img src="([^"]+)"/)
    const discountM = body.match(/<div class="discount_pct"[^>]*>(-?\d+)%<\/div>/)
    const discountPct = discountM ? Math.abs(parseInt(discountM[1], 10)) : 0
    if (!appid || !title || discountPct <= 0) continue
    const origM = body.match(/<div class="discount_original_price">([^<]*)<\/div>/)
    const finalM = body.match(/<div class="discount_final_price">([^<]*)<\/div>/)
    const centsM = body.match(/data-price-final="(\d+)"/)
    const reviewM = body.match(/<span class="search_review_summary[^>]*data-tooltip-html="([^"]*)"/)
    const review = reviewM ? parseReview(reviewM[1]) : undefined
    const releasedM = body.match(/<div class="search_released[^"]*">\s*([^<]*?)\s*<\/div>/)
    out.push({
      appid,
      title,
      url: storeUrlOf(appid),
      imageUrl: imgM ? imgM[1] : '',
      discountPct,
      originalPrice: origM ? origM[1].trim() : '',
      finalPrice: finalM ? finalM[1].trim() : '',
      finalPriceCents: centsM ? parseInt(centsM[1], 10) : 0,
      reviewPct: review?.pct,
      reviewCount: review?.count,
      reviewLabel: review?.label,
      released: releasedM ? releasedM[1].trim() : undefined,
    })
  }
  return out
}

/** 排序：默认折扣从高到低；同折扣好评率高的在前，再同则现价低的在前。 */
export function sortSteamDeals(deals: SteamDeal[], sort: SteamSort): SteamDeal[] {
  const list = [...deals]
  const reviewOf = (d: SteamDeal) => (d.reviewPct ?? -1)
  if (sort === 'review') {
    list.sort((a, b) => reviewOf(b) - reviewOf(a) || b.discountPct - a.discountPct || a.finalPriceCents - b.finalPriceCents)
  } else if (sort === 'price') {
    list.sort((a, b) => a.finalPriceCents - b.finalPriceCents || b.discountPct - a.discountPct || reviewOf(b) - reviewOf(a))
  } else {
    list.sort((a, b) => b.discountPct - a.discountPct || reviewOf(b) - reviewOf(a) || a.finalPriceCents - b.finalPriceCents)
  }
  return list
}

export function loadSteamCache(): SteamDealsCache | null {
  try {
    const raw = localStorage.getItem(STEAM_DEALS_CACHE_KEY)
    if (!raw) return null
    const data = JSON.parse(raw) as SteamDealsCache
    if (!data || typeof data.at !== 'number' || !Array.isArray(data.items)) return null
    return data
  } catch { return null }
}

export function saveSteamCache(cache: SteamDealsCache): void {
  try { localStorage.setItem(STEAM_DEALS_CACHE_KEY, JSON.stringify(cache)) } catch { /* 忽略 */ }
}

export function isSteamCacheFresh(cache: SteamDealsCache | null): boolean {
  return !!cache && Date.now() - cache.at < STEAM_DEALS_CACHE_TTL_MS
}

/** 网络失败换成中文并点名步骤（与 freeGames 的 toChineseFetchError 同款，Steam 版）。 */
export function toSteamFetchError(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e)
  if (/load failed|failed to fetch|networkerror|network request failed/i.test(msg)) {
    return new Error('Steam 降价加载失败：网络请求失败，Steam 商店接口可能被代理/网络拦截，请换个节点再试')
  }
  return e instanceof Error ? e : new Error(msg)
}

/** 拉一页打折列表（start 偏移，count 每页条数）。 */
export async function fetchSteamDealsPage(start: number, count = STEAM_DEALS_PAGE_SIZE): Promise<{ total: number; items: SteamDeal[] }> {
  let res: { ok: boolean; status: number; text: string }
  try {
    res = await epicRequest(buildSteamSearchUrl(start, count), 'GET', { Accept: 'application/json' })
  } catch (e) {
    throw toSteamFetchError(e)
  }
  if (!res.ok) throw new Error(`Steam 降价加载失败：Steam 商店返回 HTTP ${res.status}`)
  let data: { success?: boolean; total_count?: number; results_html?: string }
  try {
    data = JSON.parse(res.text) as { success?: boolean; total_count?: number; results_html?: string }
  } catch {
    throw new Error('Steam 降价加载失败：Steam 返回的数据不是有效 JSON')
  }
  if (!data || typeof data.results_html !== 'string') {
    throw new Error('Steam 降价加载失败：Steam 返回的数据结构变了（无 results_html）')
  }
  const items = parseSteamSearchHtml(data.results_html)
  const total = data.total_count ?? items.length
  if (items.length === 0 && total > 0) {
    throw new Error('Steam 降价加载失败：拉到了数据但解析不到任何打折游戏（Steam 页面结构可能变了）')
  }
  return { total, items }
}

/** 首屏加载：缓存新鲜（1 小时内）直接用，否则拉第一页并写缓存。 */
export async function loadSteamDeals(force = false): Promise<SteamDealsCache> {
  const cached = loadSteamCache()
  if (!force && isSteamCacheFresh(cached)) return cached as SteamDealsCache
  const { total, items } = await fetchSteamDealsPage(0)
  const next: SteamDealsCache = { at: Date.now(), total, items: sortSteamDeals(items, 'discount') }
  saveSteamCache(next)
  return next
}

/** 加载更多：拉下一页并入缓存（按 appid 去重，重新按折扣排）。 */
export async function loadMoreSteamDeals(): Promise<SteamDealsCache> {
  const cached = loadSteamCache()
  const start = cached?.items.length ?? 0
  const { total, items } = await fetchSteamDealsPage(start)
  const seen = new Set((cached?.items ?? []).map(d => d.appid))
  const merged = [...(cached?.items ?? []), ...items.filter(d => !seen.has(d.appid))]
  const next: SteamDealsCache = { at: Date.now(), total, items: sortSteamDeals(merged, 'discount') }
  saveSteamCache(next)
  return next
}
