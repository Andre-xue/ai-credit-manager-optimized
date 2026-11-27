// 工坊 · Steam 游戏详情（v0.1.505）：点卡片进 App 内详情页，数据走 Steam 商店
// appdetails 按需拉取（进详情才拉，带本机缓存，避免反复进出重复请求）。
// 「版本与合集包」与本体价同源：appdetails 的 package_groups 列购买选项，
// packagedetails 逐个补结构化价格与包含内容。字段以接口实际返回为准，
// 缺字段就不显示那一行，不编造；失败给人话错误，不白屏。
import { epicRequest } from './freeGames'
import { formatSteamCents, storeSubUrlOf, toSteamFetchError } from './steamDeals'

export interface SteamPackageOption {
  packageId: string
  name: string
  /** 内容说明：package_groups 的 option_description 优先，其次 packagedetails 的包含名单；都没有则不显示 */
  description?: string
  /** 折扣百分比；接口没给/不打折为 0 */
  discountPct: number
  /** 原价文本；接口没给原价时为空串（界面只显示现价） */
  originalPrice: string
  finalPrice: string
  finalPriceCents: number
  /** 是否为列表当前展示的本体价那一行（高亮 + 「当前展示价」徽标） */
  isBase: boolean
  /** 合集包商店页（sub 页） */
  url: string
}

export interface SteamGameDetail {
  appid: string
  name: string
  shortDescription: string
  /** 「关于这款游戏」纯文本（接口返回的是 HTML，转纯文本展示） */
  aboutText: string
  headerImage: string
  screenshots: { thumb: string; full: string }[]
  releaseDate?: string
  developers: string[]
  publishers: string[]
  genres: string[]
  isFree: boolean
  /** price_overview；免费/无价时为 undefined */
  price?: { discountPct: number; originalPrice: string; finalPrice: string; finalPriceCents: number }
  /** appreviews 汇总算出的好评率/评测数；接口没给时为 undefined（界面回落列表行数据） */
  reviewPct?: number
  reviewCount?: number
  requirements?: { minimum?: string; recommended?: string }
  /** 全部购买选项（版本与合集包）；只有 1 个时界面整区不渲染 */
  packages: SteamPackageOption[]
  at: number
}

// ---------------- 工具 ----------------

function decodeEntities(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()
}

/** appdetails 的 about_the_game / pc_requirements 是 HTML：转成可读纯文本。 */
export function steamHtmlToText(html: string): string {
  if (!html) return ''
  const text = decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n· ')
      .replace(/<\/(p|li|h\d|div|ul|ol)>/gi, '\n')
      .replace(/<[^>]*>/g, ''),
  )
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map(s => s.trim()) : []

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

// ---------------- package_groups 解析（购买选项骨架） ----------------

export interface RawPackageSub {
  packageId: string
  name: string
  description?: string
  /** package_groups 自带的折后价（分）；packagedetails 补不到价时兜底 */
  priceCentsWithDiscount?: number
}

/** 展开 appdetails 的 package_groups → 购买选项列表（保持商店顺序，按 packageid 去重）。 */
export function parsePackageGroups(data: unknown): RawPackageSub[] {
  const groups = (data as { package_groups?: unknown })?.package_groups
  if (!Array.isArray(groups)) return []
  const out: RawPackageSub[] = []
  const seen = new Set<string>()
  for (const g of groups) {
    const subs = (g as { subs?: unknown })?.subs
    if (!Array.isArray(subs)) continue
    for (const s of subs) {
      const sub = (s ?? {}) as { packageid?: unknown; option_text?: unknown; option_description?: unknown; price_in_cents_with_discount?: unknown }
      const id = typeof sub.packageid === 'number' ? String(sub.packageid) : typeof sub.packageid === 'string' ? sub.packageid : ''
      if (!id || seen.has(id)) continue
      seen.add(id)
      const name = typeof sub.option_text === 'string' ? stripTags(sub.option_text) : ''
      const desc = typeof sub.option_description === 'string' ? stripTags(sub.option_description) : ''
      out.push({
        packageId: id,
        name,
        description: desc || undefined,
        priceCentsWithDiscount: typeof sub.price_in_cents_with_discount === 'number' ? sub.price_in_cents_with_discount : undefined,
      })
    }
  }
  return out
}

// ---------------- packagedetails 解析（单个购买选项的价格/内容） ----------------

export interface PackageDetailsInfo {
  name: string
  apps: string[]
  price?: { discountPct: number; originalPrice: string; finalPrice: string; finalPriceCents: number }
}

/**
 * packagedetails 单个响应 → 名称/包含名单/价格。与列表时代的口径不同：
 * 详情页要列全部购买选项，不打折的也要（价格真实存在即可），只有完全
 * 没有价格时 price 为 undefined（界面只显示名称，不编造价格）。
 */
export function parsePackageDetailsInfo(data: unknown): PackageDetailsInfo | null {
  const d = (data ?? {}) as { name?: unknown; apps?: unknown; price?: unknown }
  const name = typeof d.name === 'string' ? d.name.trim() : ''
  if (!name) return null
  const apps = Array.isArray(d.apps)
    ? d.apps.map(a => (a as { name?: unknown }).name).filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
    : []
  const p = (d.price ?? {}) as { currency?: unknown; initial?: unknown; final?: unknown; discount_percent?: unknown }
  const initial = typeof p.initial === 'number' ? p.initial : -1
  const final = typeof p.final === 'number' ? p.final : -1
  const currency = typeof p.currency === 'string' ? p.currency : 'CNY'
  const price = final >= 0
    ? {
        discountPct: typeof p.discount_percent === 'number' ? p.discount_percent : 0,
        originalPrice: initial > final ? formatSteamCents(initial, currency) : '',
        finalPrice: formatSteamCents(final, currency),
        finalPriceCents: final,
      }
    : undefined
  return { name, apps, price }
}

// ---------------- appdetails 详情解析 ----------------

/** 解析 appdetails 单款响应 → 详情（购买选项先用 package_groups 骨架，价格随后由 packagedetails 合并）。success=false / 无 data 返回 null。 */
export function parseAppDetailsDetail(appid: string, entry: unknown, now = Date.now()): SteamGameDetail | null {
  const e = (entry ?? {}) as { success?: unknown; data?: unknown }
  if (e.success !== true || !e.data || typeof e.data !== 'object') return null
  const d = e.data as Record<string, unknown>
  const name = typeof d.name === 'string' ? d.name.trim() : ''
  if (!name) return null
  const shots: { thumb: string; full: string }[] = []
  if (Array.isArray(d.screenshots)) {
    for (const s of d.screenshots) {
      const it = (s ?? {}) as { path_thumbnail?: unknown; path_full?: unknown }
      const full = typeof it.path_full === 'string' ? it.path_full : ''
      const thumb = typeof it.path_thumbnail === 'string' ? it.path_thumbnail : full
      if (full) shots.push({ thumb, full })
    }
  }
  const genres: string[] = []
  if (Array.isArray(d.genres)) {
    for (const g of d.genres) {
      const desc = (g as { description?: unknown })?.description
      if (typeof desc === 'string' && desc.trim()) genres.push(desc.trim())
    }
  }
  const po = (d.price_overview ?? {}) as {
    currency?: unknown; initial?: unknown; final?: unknown; discount_percent?: unknown
    initial_formatted?: unknown; final_formatted?: unknown
  }
  const poFinal = typeof po.final === 'number' ? po.final : -1
  const poInitial = typeof po.initial === 'number' ? po.initial : -1
  const poCurrency = typeof po.currency === 'string' ? po.currency : 'CNY'
  const price = poFinal >= 0
    ? {
        discountPct: typeof po.discount_percent === 'number' ? po.discount_percent : 0,
        originalPrice: poInitial > poFinal
          ? (typeof po.initial_formatted === 'string' && po.initial_formatted ? po.initial_formatted : formatSteamCents(poInitial, poCurrency))
          : '',
        finalPrice: typeof po.final_formatted === 'string' && po.final_formatted ? po.final_formatted : formatSteamCents(poFinal, poCurrency),
        finalPriceCents: poFinal,
      }
    : undefined
  const req = (d.pc_requirements ?? {}) as { minimum?: unknown; recommended?: unknown }
  const reqMin = typeof req.minimum === 'string' ? steamHtmlToText(req.minimum) : ''
  const reqRec = typeof req.recommended === 'string' ? steamHtmlToText(req.recommended) : ''
  const rel = (d.release_date ?? {}) as { date?: unknown }
  const subs = parsePackageGroups(d)
  return {
    appid,
    name,
    shortDescription: typeof d.short_description === 'string' ? stripTags(d.short_description) : '',
    aboutText: typeof d.about_the_game === 'string' ? steamHtmlToText(d.about_the_game) : '',
    headerImage: typeof d.header_image === 'string' ? d.header_image : '',
    screenshots: shots,
    releaseDate: typeof rel.date === 'string' && rel.date.trim() ? rel.date.trim() : undefined,
    developers: strList(d.developers),
    publishers: strList(d.publishers),
    genres,
    isFree: d.is_free === true,
    price,
    requirements: reqMin || reqRec ? { minimum: reqMin || undefined, recommended: reqRec || undefined } : undefined,
    packages: subs.map(s => ({
      packageId: s.packageId,
      name: s.name,
      description: s.description,
      discountPct: 0,
      originalPrice: '',
      finalPrice: s.priceCentsWithDiscount !== undefined ? formatSteamCents(s.priceCentsWithDiscount, poCurrency) : '',
      finalPriceCents: s.priceCentsWithDiscount ?? -1,
      isBase: false,
      url: storeSubUrlOf(s.packageId),
    })),
    at: now,
  }
}

/**
 * 把 packagedetails 的信息合并进购买选项，并标出本体价那一行：
 * 现价与 price_overview 现价一致的第一行即本体（列表展示的就是这个价）；
 * 没有价格总览（免费游戏等）时第一行即本体。
 */
export function mergePackageInfos(
  detail: SteamGameDetail,
  infos: Map<string, PackageDetailsInfo | null>,
): SteamGameDetail {
  const packages = detail.packages.map(pkg => {
    const info = infos.get(pkg.packageId)
    if (!info) return pkg
    return {
      ...pkg,
      name: pkg.name || info.name,
      description: pkg.description ?? (info.apps.length > 0 ? `包含：${info.apps.join('、')}` : undefined),
      discountPct: info.price?.discountPct ?? pkg.discountPct,
      originalPrice: info.price?.originalPrice ?? pkg.originalPrice,
      finalPrice: info.price?.finalPrice ?? pkg.finalPrice,
      finalPriceCents: info.price?.finalPriceCents ?? pkg.finalPriceCents,
    }
  })
  let baseIdx = detail.price
    ? packages.findIndex(p => p.finalPriceCents >= 0 && p.finalPriceCents === detail.price!.finalPriceCents)
    : -1
  if (baseIdx < 0 && packages.length > 0) baseIdx = 0
  return { ...detail, packages: packages.map((p, i) => ({ ...p, isBase: i === baseIdx })) }
}

/** appreviews 汇总 → 好评率/评测数（total 为 0 或结构不对返回 null）。 */
export function parseReviewSummary(json: unknown): { pct: number; count: number } | null {
  const q = (json as { query_summary?: { total_positive?: unknown; total_reviews?: unknown } })?.query_summary
  const total = typeof q?.total_reviews === 'number' ? q.total_reviews : 0
  const positive = typeof q?.total_positive === 'number' ? q.total_positive : 0
  if (total <= 0) return null
  return { pct: Math.round((positive / total) * 100), count: total }
}

// ---------------- 详情缓存（仅本机，1 小时） ----------------

export const STEAM_DETAIL_CACHE_KEY = 'acm.steam.detail.v1'
export const STEAM_DETAIL_CACHE_TTL_MS = 60 * 60_000

export function loadSteamDetailCache(): Record<string, SteamGameDetail> {
  try {
    const raw = localStorage.getItem(STEAM_DETAIL_CACHE_KEY)
    if (!raw) return {}
    const data = JSON.parse(raw) as Record<string, SteamGameDetail>
    return data && typeof data === 'object' ? data : {}
  } catch { return {} }
}

export function saveSteamDetailCache(map: Record<string, SteamGameDetail>): void {
  try { localStorage.setItem(STEAM_DETAIL_CACHE_KEY, JSON.stringify(map)) } catch { /* 忽略 */ }
}

export function getCachedSteamDetail(appid: string, now = Date.now()): SteamGameDetail | null {
  const d = loadSteamDetailCache()[appid]
  if (!d || typeof d.at !== 'number' || now - d.at >= STEAM_DETAIL_CACHE_TTL_MS) return null
  return d
}

// ---------------- 网络拉取 ----------------

function buildAppDetailsUrl(appid: string): string {
  const q = new URLSearchParams({ appids: appid, cc: 'CN', l: 'schinese' })
  return `https://store.steampowered.com/api/appdetails?${q.toString()}`
}

function buildPackageDetailsUrl(packageId: string): string {
  const q = new URLSearchParams({ packageids: packageId, cc: 'CN', l: 'schinese' })
  return `https://store.steampowered.com/api/packagedetails?${q.toString()}`
}

function buildAppReviewsUrl(appid: string): string {
  const q = new URLSearchParams({ json: '1', language: 'all', purchase_type: 'all', num_per_page: '0' })
  return `https://store.steampowered.com/appreviews/${appid}?${q.toString()}`
}

async function fetchJson(url: string, step: string): Promise<unknown> {
  let res: { ok: boolean; status: number; text: string }
  try {
    res = await epicRequest(url, 'GET', { Accept: 'application/json' })
  } catch (e) {
    throw toSteamFetchError(e)
  }
  if (!res.ok) throw new Error(`Steam 详情加载失败：Steam 商店返回 HTTP ${res.status}（${step}）`)
  try {
    return JSON.parse(res.text) as unknown
  } catch {
    throw new Error(`Steam 详情加载失败：Steam 返回的数据不是有效 JSON（${step}）`)
  }
}

/** 单个 packagedetails；失败/查不到返回 null（该行退回 package_groups 的价格，不中断整页）。 */
async function fetchPackageInfo(packageId: string): Promise<PackageDetailsInfo | null> {
  try {
    const data = await fetchJson(buildPackageDetailsUrl(packageId), '合集包价格') as Record<string, { success?: boolean; data?: unknown }>
    const entry = data?.[packageId]
    if (!entry?.success) return null
    return parsePackageDetailsInfo(entry.data)
  } catch {
    return null
  }
}

const PACKAGE_FETCH_CONCURRENCY = 4

/**
 * 拉一款游戏的完整详情：appdetails（主体+购买选项骨架）→ appreviews 好评
 * （尽力而为，失败不挡详情）→ packagedetails 逐个补价格/内容（单 id 调用：
 * Steam 多 id 批量会返回 null，412 时代实测口径）。结果写本机缓存（1 小时）。
 */
export async function fetchSteamGameDetail(appid: string, force = false): Promise<SteamGameDetail> {
  if (!force) {
    const cached = getCachedSteamDetail(appid)
    if (cached) return cached
  }
  const data = await fetchJson(buildAppDetailsUrl(appid), '游戏详情') as Record<string, unknown>
  let detail = parseAppDetailsDetail(appid, data?.[appid])
  if (!detail) {
    throw new Error('Steam 详情加载失败：这款游戏暂时查不到详情（可能已下架或不在当前区域销售）')
  }
  try {
    const review = parseReviewSummary(await fetchJson(buildAppReviewsUrl(appid), '评测汇总'))
    if (review) detail = { ...detail, reviewPct: review.pct, reviewCount: review.count }
  } catch { /* 好评拿不到不挡详情：界面回落列表行自带的好评数据 */ }
  if (detail.packages.length > 0) {
    const infos = new Map<string, PackageDetailsInfo | null>()
    await mapWithConcurrency(detail.packages, PACKAGE_FETCH_CONCURRENCY, async (pkg) => {
      infos.set(pkg.packageId, await fetchPackageInfo(pkg.packageId))
    })
    detail = mergePackageInfos(detail, infos)
  }
  const map = loadSteamDetailCache()
  map[appid] = detail
  saveSteamDetailCache(map)
  return detail
}
