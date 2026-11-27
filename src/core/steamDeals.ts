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
  /** 游戏本体的 appid；合集包时为 sub（package）id */
  appid: string
  /** 'game' 游戏本体 / 'package' 合集包（v0.1.412：搜索结果里的 sub 行 + 本体反查补齐） */
  kind: 'game' | 'package'
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
  /** 合集包包含的游戏名（packagedetails 的 apps）；本体无此字段 */
  contents?: string[]
}

export type SteamSort = 'discount' | 'review' | 'price'

export const STEAM_DEALS_CACHE_KEY = 'acm.steam.deals.v1'
export const STEAM_DEALS_CACHE_TTL_MS = 60 * 60_000
export const STEAM_DEALS_PAGE_SIZE = 100

export interface SteamDealsCache {
  at: number
  /** Steam 返回的打折总数（当前约两万款，大促期间更多） */
  total: number
  /** 只存游戏本体（v0.1.505 起：合集包不再进列表，合集包只在详情页的「版本与合集包」区出现） */
  items: SteamDeal[]
  /** 已从搜索接口拉到的原始行数（本体+合集包行都算；与 items.length 区分：过滤掉的合集包行也占搜索偏移） */
  searchFetched: number
}

/** 去重/列表 key：appid 与 sub id 是两个命名空间，数字可能撞号，必须带 kind */
export function dealKey(d: SteamDeal): string {
  return `${d.kind}:${d.appid}`
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

/** 合集包商店链接（sub 页，不是 app 页） */
export function storeSubUrlOf(packageId: string): string {
  return `https://store.steampowered.com/sub/${packageId}/`
}

/** packagedetails 的 price（单位：分）→ 显示文本，如 22800 CNY → ¥228.00 */
export function formatSteamCents(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('zh-CN', { style: 'currency', currency }).format(cents / 100)
  } catch {
    return `¥${(cents / 100).toFixed(2)}`
  }
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
 * 合集包行（v0.1.412）：带 data-ds-packageid（data-ds-appid 是逗号分隔的多个 appid，
 * 无单值可取），链接到 /sub/<id>/，价格/好评/发售日结构与游戏行完全相同，照常解析，
 * kind 记为 'package'，与本体区分开。
 */
export function parseSteamSearchHtml(html: string): SteamDeal[] {
  const out: SteamDeal[] = []
  const rowRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/g
  let row: RegExpExecArray | null
  while ((row = rowRe.exec(html)) !== null) {
    const attrs = row[1]
    if (!/search_result_row/.test(attrs)) continue
    const body = row[2]
    const packageM = attrs.match(/data-ds-packageid="(\d+)"/)
    const appM = attrs.match(/data-ds-appid="(\d+)"/)
    const kind: SteamDeal['kind'] = packageM ? 'package' : 'game'
    const id = packageM ? packageM[1] : appM ? appM[1] : ''
    if (!id) continue
    const titleM = body.match(/<span class="title">([^<]*)<\/span>/)
    const title = titleM ? titleM[1].trim() : ''
    const imgM = body.match(/<div class="search_capsule"><img src="([^"]+)"/)
    const discountM = body.match(/<div class="discount_pct"[^>]*>(-?\d+)%<\/div>/)
    const discountPct = discountM ? Math.abs(parseInt(discountM[1], 10)) : 0
    if (!title || discountPct <= 0) continue
    const origM = body.match(/<div class="discount_original_price">([^<]*)<\/div>/)
    const finalM = body.match(/<div class="discount_final_price">([^<]*)<\/div>/)
    const centsM = body.match(/data-price-final="(\d+)"/)
    const reviewM = body.match(/<span class="search_review_summary[^>]*data-tooltip-html="([^"]*)"/)
    const review = reviewM ? parseReview(reviewM[1]) : undefined
    const releasedM = body.match(/<div class="search_released[^"]*">\s*([^<]*?)\s*<\/div>/)
    out.push({
      appid: id,
      kind,
      title,
      url: kind === 'package' ? storeSubUrlOf(id) : storeUrlOf(id),
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

/**
 * 进页自动刷新（v0.1.470）：1 小时缓存仍是兜底（拉不到时继续用旧缓存），
 * 但进页时若距上次拉取已超过这个时长就后台刷一次；不足则跳过防狂刷。
 */
export const STEAM_ENTRY_REFRESH_SKIP_MS = 5 * 60_000

/** 纯决策：给定缓存时间戳，进页时该不该自动刷新一次（无缓存 = 该刷） */
export function shouldEntryRefreshSteam(at: number | null | undefined, now: number = Date.now()): boolean {
  return !at || now - at >= STEAM_ENTRY_REFRESH_SKIP_MS
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

/** 列表只保留游戏本体（v0.1.505）：搜索结果里的合集包行（sub）过滤掉，不进缓存。 */
export function onlyGameDeals(items: SteamDeal[]): SteamDeal[] {
  return items.filter(d => d.kind === 'game')
}

/** 首屏加载：缓存新鲜（1 小时内）直接用，否则拉第一页并写缓存（只存本体）。 */
export async function loadSteamDeals(force = false): Promise<SteamDealsCache> {
  const cached = loadSteamCache()
  if (!force && isSteamCacheFresh(cached)) {
    // 旧缓存（505 之前）可能混有合集包条目：读时顺手剔掉，保证列表只有本体
    const c = cached as SteamDealsCache
    return c.items.some(d => d.kind !== 'game') ? { ...c, items: onlyGameDeals(c.items) } : c
  }
  const { total, items } = await fetchSteamDealsPage(0)
  const next: SteamDealsCache = { at: Date.now(), total, items: sortSteamDeals(onlyGameDeals(items), 'discount'), searchFetched: items.length }
  saveSteamCache(next)
  return next
}

/** 加载更多：拉下一页并入缓存（按 kind:id 去重，只留本体，重新按折扣排）。 */
export async function loadMoreSteamDeals(): Promise<SteamDealsCache> {
  const cached = loadSteamCache()
  const start = cached?.searchFetched ?? cached?.items.length ?? 0
  const { total, items } = await fetchSteamDealsPage(start)
  const seen = new Set((cached?.items ?? []).map(dealKey))
  const merged = [...onlyGameDeals(cached?.items ?? []), ...onlyGameDeals(items).filter(d => !seen.has(dealKey(d)))]
  const next: SteamDealsCache = {
    at: Date.now(), total,
    items: sortSteamDeals(merged, 'discount'),
    searchFetched: start + items.length,
  }
  saveSteamCache(next)
  return next
}
