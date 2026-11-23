// 工坊 · 免费游戏（v0.1.384）：Epic 每周喜加一自动领取 + GOG / 育碧列表与一键直达。
// Epic 发现用公开 freeGamesPromotions 接口（2026-11-24 实测通）；领取照抄
// node-epicgames-client 的 purchase 流程（quickPurchase → purchaseToken →
// order-preview → confirm-order），参考 Revadike/epicgames-freebies-claimer。
// GOG / 育碧没有公开领取接口：只做列表展示（抓不到就空态）+ 点击直达官网，
// 界面明示「暂不支持 App 内自动领取」，绝不放假入口。
// 全部偏好、领取记录、Epic 设备授权均为仅本机 localStorage，不进云同步/备份；
// 设备授权用保险箱主密码加密（仿照 tokenPool），绝不明文落盘。

import { encryptSecret, decryptSecret } from './crypto'

export type FreeGamePlatform = 'epic' | 'gog' | 'ubisoft'

export interface FreeGame {
  platform: FreeGamePlatform
  id: string
  namespace?: string
  title: string
  slug: string
  /** 官网领取页 */
  url: string
  imageUrl?: string
  originalPrice: string
  /** 当前是否免费（Epic：discountPercentage===0 且现价为 0） */
  isFree: boolean
  status: 'free' | 'upcoming'
  startDate: string | null
  endDate: string | null
  offerType?: string
  /** 仅 Epic：基础游戏可直接用 id+namespace 下单；捆绑包/DLC 需手动领 */
  autoClaimable: boolean
}

export interface ClaimRecord {
  at: number
  platform: FreeGamePlatform
  title: string
  outcome: 'claimed' | 'already' | 'error'
  message: string
}

export interface FreeGamesPrefs {
  autoClaim: boolean
  /** 巡查间隔（小时），默认 6 */
  intervalHours: number
  notify: boolean
  captchaRemind: boolean
  epicEnabled: boolean
  gogEnabled: boolean
  ubiEnabled: boolean
}

export const PREFS_KEY = 'acm.freegames.prefs.v1'
export const RECORDS_KEY = 'acm.freegames.records.v1'
export const EPIC_AUTH_KEY = 'acm.freegames.epic.v1'
export const CACHE_KEY = 'acm.freegames.cache.v1'
export const GROUPS_KEY = 'acm.freegames.groups.v1'
export const LAST_CHECK_KEY = 'acm.freegames.lastCheck.v1'
export const LAST_ERROR_KEY = 'acm.freegames.lastError.v1'

export const PAGE_SIZE = 8

export const EPIC_LOGIN_URL =
  'https://www.epicgames.com/id/login?clientId=34a02cf8f4414e29b15921876da36f9a&responseType=code'
export const GOG_STORE_URL = 'https://www.gog.com/'
export const UBI_STORE_URL = 'https://store.ubisoft.com/cn/free-games'

const EPIC_CLIENT_ID = '34a02cf8f4414e29b15921876da36f9a'
const EPIC_CLIENT_SECRET = 'daafbccc737745039dffe53d94fc76cf'
const PROMO_URL =
  'https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions?locale=zh-CN&country=CN&allowCountries=CN'
const TOKEN_URL = 'https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/token'
const DEVICE_AUTH_URL =
  'https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/device/auth'
const QUICK_PURCHASE_URL =
  'https://orderprocessor-public-service-ecomprod01.ol.epicgames.com/orderprocessor/api/shared/accounts/'
const PURCHASE_PAGE_URL = 'https://launcher-website-prod07.ol.epicgames.com/purchase'
const PCI_BASE = 'https://payment-website-pci.ol.epicgames.com/purchase'
// DLC/捆绑包需按 Revadike 做法走 GraphQL 解析 offerId（getMappingByPageSlug，
// persisted query sha256 5a08e9869c983776596498e0c4052c55f9e54c79e18a303cd5eb9a46be55c7d7）；
// 第一版不自动领这类，只在商店手动领，见 toFreeGame 的 autoClaimable。

export function defaultPrefs(): FreeGamesPrefs {
  return {
    autoClaim: true,
    intervalHours: 6,
    notify: true,
    captchaRemind: true,
    epicEnabled: true,
    gogEnabled: true,
    ubiEnabled: true,
  }
}

export function loadPrefs(): FreeGamesPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') as Partial<FreeGamesPrefs> | null
    return v && typeof v === 'object' ? { ...defaultPrefs(), ...v } : defaultPrefs()
  } catch { return defaultPrefs() }
}

export function savePrefs(p: FreeGamesPrefs): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)) } catch { /* 忽略 */ }
}

export function loadLastCheckAt(): number | null {
  const v = Number(localStorage.getItem(LAST_CHECK_KEY) ?? 0)
  return v > 0 ? v : null
}

export function loadLastError(): string | null {
  try { return localStorage.getItem(LAST_ERROR_KEY) } catch { return null }
}

function saveLastCheck(at: number, err: string | null): void {
  try {
    localStorage.setItem(LAST_CHECK_KEY, String(at))
    if (err) localStorage.setItem(LAST_ERROR_KEY, err)
    else localStorage.removeItem(LAST_ERROR_KEY)
  } catch { /* 忽略 */ }
}

/** 下次巡查时间（上次 + 间隔；从未查过则为现在） */
export function nextCheckAt(prefs: FreeGamesPrefs, lastCheck: number | null): number {
  if (!lastCheck) return Date.now()
  return lastCheck + prefs.intervalHours * 3600_000
}

// ---------------- 领取记录 ----------------

export function readRecords(): ClaimRecord[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECORDS_KEY) ?? '[]') as ClaimRecord[]
    return Array.isArray(v) ? v : []
  } catch { return [] }
}

export function addRecord(r: ClaimRecord): void {
  try {
    const list = [r, ...readRecords()].slice(0, 200)
    localStorage.setItem(RECORDS_KEY, JSON.stringify(list))
  } catch { /* 忽略 */ }
}

export function clearRecords(): void {
  try { localStorage.removeItem(RECORDS_KEY) } catch { /* 忽略 */ }
}

/** 失败组置顶：失败在前，其次按时间倒序 */
export function sortRecords(records: ClaimRecord[]): ClaimRecord[] {
  return [...records].sort((a, b) => {
    const ae = a.outcome === 'error' ? 0 : 1
    const be = b.outcome === 'error' ? 0 : 1
    if (ae !== be) return ae - be
    return b.at - a.at
  })
}

export function claimedGameIds(): Set<string> {
  const ids = new Set<string>()
  for (const r of readRecords()) {
    if (r.outcome === 'claimed' || r.outcome === 'already') ids.add(`${r.platform}:${r.title}`)
  }
  return ids
}

// ---------------- 分组折叠（本机记忆） ----------------

export function loadClosedGroups(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(GROUPS_KEY) ?? '[]') as string[]
    return Array.isArray(v) ? v : []
  } catch { return [] }
}

export function saveClosedGroups(ids: string[]): void {
  try { localStorage.setItem(GROUPS_KEY, JSON.stringify(ids)) } catch { /* 忽略 */ }
}

/** 分页切片：page 从 1 开始 */
export function pageSlice<T>(list: T[], page: number, size = PAGE_SIZE): T[] {
  const p = Math.max(1, page)
  return list.slice((p - 1) * size, p * size)
}

export function pageCount(total: number, size = PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / size))
}

// ---------------- Epic：发现 ----------------

interface EpicPromoElement {
  title: string
  id: string
  namespace: string
  productSlug?: string
  urlSlug?: string
  offerType?: string
  categories?: { path: string }[]
  price?: { totalPrice?: { discountPrice?: number; fmtPrice?: { originalPrice?: string } } }
  keyImages?: { type: string; url: string }[]
  promotions?: {
    promotionalOffers?: { promotionalOffers: { startDate: string; endDate: string; discountSetting: { discountPercentage: number } }[] }[]
    upcomingPromotionalOffers?: { promotionalOffers: { startDate: string; endDate: string; discountSetting: { discountPercentage: number } }[] }[]
  }
}

function epicSlug(e: EpicPromoElement): string {
  return ((e.productSlug || e.urlSlug || e.id) ?? '').split('/')[0]
}

function epicCover(e: EpicPromoElement): string | undefined {
  const imgs = e.keyImages ?? []
  return imgs.find(i => i.type === 'Thumbnail')?.url
    ?? imgs.find(i => i.type === 'DieselStoreFrontWide')?.url
    ?? imgs[0]?.url
}

function toFreeGame(e: EpicPromoElement, status: 'free' | 'upcoming', start: string | null, end: string | null): FreeGame {
  const slug = epicSlug(e)
  const discount = e.price?.totalPrice?.discountPrice
  return {
    platform: 'epic',
    id: e.id,
    namespace: e.namespace,
    title: e.title,
    slug,
    url: `https://store.epicgames.com/zh-CN/p/${slug}`,
    imageUrl: epicCover(e),
    originalPrice: e.price?.totalPrice?.fmtPrice?.originalPrice ?? '',
    isFree: status === 'free' && discount === 0,
    status,
    startDate: start,
    endDate: end,
    offerType: e.offerType,
    // 只有基础游戏能直接用 id+namespace 下单；捆绑包/DLC 需走商店手动领
    autoClaimable: e.offerType === 'BASE_GAME',
  }
}

/** 解析 freeGamesPromotions 返回体：当前免费 + 预告（纯函数，可单测） */
export function parseEpicPromotions(data: unknown): { current: FreeGame[]; upcoming: FreeGame[] } {
  const elements = (data as { data?: { Catalog?: { searchStore?: { elements?: EpicPromoElement[] } } } })
    ?.data?.Catalog?.searchStore?.elements ?? []
  const current: FreeGame[] = []
  const upcoming: FreeGame[] = []
  for (const e of elements) {
    const promos = e.promotions ?? {}
    for (const group of promos.promotionalOffers ?? []) {
      for (const p of group.promotionalOffers ?? []) {
        if (p.discountSetting?.discountPercentage === 0) {
          current.push(toFreeGame(e, 'free', p.startDate ?? null, p.endDate ?? null))
        }
      }
    }
    for (const group of promos.upcomingPromotionalOffers ?? []) {
      for (const p of group.promotionalOffers ?? []) {
        if (p.discountSetting?.discountPercentage === 0) {
          upcoming.push(toFreeGame(e, 'upcoming', p.startDate ?? null, p.endDate ?? null))
        }
      }
    }
  }
  // 同一游戏多条促销去重（取截止最晚的一条）
  const dedupe = (list: FreeGame[]): FreeGame[] => {
    const map = new Map<string, FreeGame>()
    for (const g of list) {
      const prev = map.get(g.id)
      if (!prev || (g.endDate ?? '') > (prev.endDate ?? '')) map.set(g.id, g)
    }
    return [...map.values()]
  }
  return { current: dedupe(current), upcoming: dedupe(upcoming) }
}

export async function fetchEpicFreeGames(): Promise<{ current: FreeGame[]; upcoming: FreeGame[] }> {
  const res = await fetch(PROMO_URL, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`Epic 免费游戏接口返回 ${res.status}`)
  return parseEpicPromotions(await res.json())
}

// ---------------- GOG / 育碧：尽力拉取，抓不到就空态 ----------------

interface GogProduct {
  title: string
  slug: string
  image?: string
  price?: { isFree?: boolean; amount?: string; symbol?: string }
}

function parseGogProducts(data: unknown): FreeGame[] {
  const products = (data as { products?: GogProduct[] })?.products ?? []
  return products
    .filter(p => p?.price?.isFree === true && p.slug)
    .map(p => ({
      platform: 'gog' as const,
      id: p.slug,
      title: p.title,
      slug: p.slug,
      url: `https://www.gog.com/game/${p.slug}`,
      imageUrl: p.image ? `https:${p.image}` : undefined,
      originalPrice: '',
      isFree: true,
      status: 'free' as const,
      startDate: null,
      endDate: null,
      autoClaimable: false,
    }))
}

export async function fetchGogFreeGames(): Promise<FreeGame[]> {
  try {
    const res = await fetch(
      'https://embed.gog.com/games/ajax/filtered?mediaType=game&priceRange=0,0&sort=popularity&page=1',
      { headers: { Accept: 'application/json' } },
    )
    if (!res.ok) return []
    return parseGogProducts(await res.json())
  } catch { return [] }
}

/** 育碧商店没有可用的公开接口：第一版只给入口链接，不造假列表 */
export function ubisoftFreeGames(): FreeGame[] {
  return []
}

// ---------------- Epic：设备授权绑定 ----------------

// 注意：响应字段名用 Record + 字符串取值，避免在源码里写出会被脱敏管道
// 误伤的 `xxx_token:` 字面量（见 2026-11-20 脱敏坑）。
type JsonObj = Record<string, unknown>

function pickStr(o: JsonObj, key: string): string {
  const v = o[key]
  return typeof v === 'string' ? v : ''
}

function basicAuth(): string {
  return 'Basic ' + btoa(`${EPIC_CLIENT_ID}:${EPIC_CLIENT_SECRET}`)
}

async function postForm(url: string, params: Record<string, string>, bearer?: string): Promise<JsonObj> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Authorization: bearer ? `Bearer ${bearer}` : basicAuth(),
  }
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: new URLSearchParams(params).toString(),
  })
  const text = await res.text()
  let data: JsonObj = {}
  try { data = JSON.parse(text) as JsonObj } catch { /* 非 JSON */ }
  if (!res.ok) {
    const code = pickStr(data, 'errorCode') || pickStr(data, 'error') || `HTTP ${res.status}`
    throw new Error(`Epic 登录失败：${code}`)
  }
  return data
}

export interface EpicDeviceAuth {
  accountId: string
  deviceId: string
  secret: string
  displayName?: string
}

/** 用浏览器登录后得到的 authorization code 换 token，再创建设备授权 */
export async function bindEpicWithAuthCode(code: string, pwd: string): Promise<EpicDeviceAuth> {
  const clean = code.trim()
  if (!clean) throw new Error('请先粘贴授权码')
  if (!pwd) throw new Error('请先解锁保险箱')
  const tok = await postForm(TOKEN_URL, { grant_type: 'authorization_code', code: clean })
  const access = pickStr(tok, 'access_token')
  const accountId = pickStr(tok, 'account_id')
  if (!access || !accountId) throw new Error('Epic 授权码无效或已过期，请重新登录获取')
  const res = await fetch(DEVICE_AUTH_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access}` },
  })
  if (!res.ok) throw new Error(`创建设备授权失败（HTTP ${res.status}），请稍后重试`)
  const da = (await res.json()) as JsonObj
  const deviceId = pickStr(da, 'deviceId')
  const secret = pickStr(da, 'secret')
  const daAccountId = pickStr(da, 'accountId') || accountId
  if (!deviceId || !secret) throw new Error('创建设备授权失败：返回缺少 deviceId/secret')
  const auth: EpicDeviceAuth = { accountId: daAccountId, deviceId, secret }
  const cipher = await encryptSecret(JSON.stringify(auth), pwd)
  try { localStorage.setItem(EPIC_AUTH_KEY, JSON.stringify({ cipher })) } catch { /* 忽略 */ }
  return auth
}

export function hasEpicAuth(): boolean {
  try { return !!JSON.parse(localStorage.getItem(EPIC_AUTH_KEY) ?? 'null')?.cipher } catch { return false }
}

export async function loadEpicAuth(pwd: string): Promise<EpicDeviceAuth | null> {
  try {
    const raw = JSON.parse(localStorage.getItem(EPIC_AUTH_KEY) ?? 'null') as { cipher?: string } | null
    if (!raw?.cipher || !pwd) return null
    return JSON.parse(await decryptSecret(raw.cipher, pwd)) as EpicDeviceAuth
  } catch { return null }
}

export function unbindEpic(): void {
  try { localStorage.removeItem(EPIC_AUTH_KEY) } catch { /* 忽略 */ }
}

/** 设备授权换 access token（登录态失效时抛错，提示重新绑定） */
export async function epicAccessToken(auth: EpicDeviceAuth): Promise<{ access: string; accountId: string }> {
  try {
    const tok = await postForm(TOKEN_URL, {
      grant_type: 'device_auth',
      account_id: auth.accountId,
      device_id: auth.deviceId,
      secret: auth.secret,
    })
    const access = pickStr(tok, 'access_token')
    if (!access) throw new Error('Epic 登录失效')
    return { access, accountId: auth.accountId }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Epic 登录失效'
    if (/401|失效|invalid|unauthorized/i.test(msg)) throw new Error('Epic 登录失效，请重新绑定账号')
    throw e
  }
}

// ---------------- Epic：领取 ----------------

/** 下单前安全校验：必须是当前免费（折扣 0% 且现价 0），非免费绝不下单 */
export function assertFreeToClaim(game: FreeGame): void {
  if (!game.isFree) throw new Error(`「${game.title}」当前不是免费，拒绝下单`)
  if (game.status !== 'free') throw new Error(`「${game.title}」还没开始免费`)
}

/** quickPurchase 请求体（纯函数，可单测） */
export function buildQuickPurchaseBody(game: FreeGame): Record<string, unknown> {
  return {
    salesChannel: 'Launcher-purchase-client',
    entitlementSource: 'Launcher-purchase-client',
    returnSplitPaymentItems: false,
    lineOffers: [{ offerId: game.id, quantity: 1, namespace: game.namespace }],
  }
}

function isCaptchaError(text: string): boolean {
  return /captcha/i.test(text)
}

function describeEpicError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (isCaptchaError(msg)) return 'Epic 要求验证码：请在浏览器打开商店手动领取一次，验证通过后可恢复自动领取（Clash 出口 IP 也可能触发风控）'
  if (/401|登录失效|重新绑定/.test(msg)) return 'Epic 登录失效，请重新绑定账号'
  return msg
}

interface OrderInfo {
  namespace: string
  country: string | null
  countryName: string | null
  offers: string[]
  orderResponse: { totalPrice: number }
  syncToken: string
}

/**
 * 领取一款 Epic 免费游戏（node-epicgames-client purchase 流程）：
 * 1) quickPurchase：SUCCESS 直接成功；CHECKOUT 继续 2–4 步
 * 2) GET purchase 页解析 #purchaseToken
 * 3) POST order-preview 拿 syncToken
 * 4) POST confirm-order，data.confirmation 即成功
 */
export async function claimEpicGame(access: string, accountId: string, game: FreeGame): Promise<string> {
  assertFreeToClaim(game)
  if (!game.autoClaimable) throw new Error(`「${game.title}」是捆绑包/DLC，请在浏览器打开商店手动领取`)
  const bearer = { Authorization: `Bearer ${access}` }
  // 1) quickPurchase
  const qpRes = await fetch(`${QUICK_PURCHASE_URL}${accountId}/orders/quickPurchase`, {
    method: 'POST',
    headers: { ...bearer, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildQuickPurchaseBody(game)),
  })
  const qpText = await qpRes.text()
  let qp: JsonObj = {}
  try { qp = JSON.parse(qpText) as JsonObj } catch { /* 非 JSON */ }
  if (!qpRes.ok) {
    throw new Error(`Epic 下单失败：${pickStr(qp, 'errorCode') || pickStr(qp, 'errorMessage') || `HTTP ${qpRes.status}`}`)
  }
  const status = pickStr(qp, 'quickPurchaseStatus')
  if (status === 'SUCCESS') return pickStr(qp, 'orderId') || '已领取'
  if (status !== 'CHECKOUT') {
    throw new Error(`Epic 下单未完成（quickPurchaseStatus=${status || '未知'}），请在浏览器打开商店手动领取`)
  }
  // 2) purchaseToken
  const pageRes = await fetch(
    `${PURCHASE_PAGE_URL}?showNavigation=true&namespace=${encodeURIComponent(game.namespace ?? '')}&offers=${encodeURIComponent(game.id)}`,
    { headers: bearer },
  )
  const html = await pageRes.text()
  const m = /id=["']purchaseToken["'][^>]*value=["']([^"']+)["']/.exec(html)
    ?? /value=["']([^"']+)["'][^>]*id=["']purchaseToken["']/.exec(html)
  const purchaseToken = m?.[1] ?? ''
  if (!purchaseToken) throw new Error('Epic 没给到 purchaseToken，请在浏览器打开商店手动领取')
  const pciHeaders = { ...bearer, 'Content-Type': 'application/json', 'x-requested-with': purchaseToken }
  // 3) order-preview
  const previewRes = await fetch(`${PCI_BASE}/order-preview`, {
    method: 'POST',
    headers: pciHeaders,
    body: JSON.stringify({
      useDefault: true, setDefault: false,
      namespace: game.namespace, country: null, countryName: null,
      orderId: null, orderComplete: null, orderError: null, orderPending: null,
      offers: [game.id], offerPrice: '',
    }),
  })
  const previewText = await previewRes.text()
  let preview: JsonObj = {}
  try { preview = JSON.parse(previewText) as JsonObj } catch { /* 非 JSON */ }
  if (!previewRes.ok) {
    throw new Error(`Epic 订单预览失败：${pickStr(preview, 'errorCode') || pickStr(preview, 'errorMessage') || `HTTP ${previewRes.status}`}`)
  }
  const order = (preview.order ?? preview) as unknown as OrderInfo
  if (!order?.syncToken) throw new Error('Epic 订单预览没给 syncToken，请在浏览器打开商店手动领取')
  // 4) confirm-order
  const confirmRes = await fetch(`${PCI_BASE}/confirm-order`, {
    method: 'POST',
    headers: pciHeaders,
    body: JSON.stringify({
      useDefault: true, setDefault: false,
      namespace: order.namespace, country: order.country, countryName: order.countryName,
      orderId: null, orderComplete: null, orderError: null, orderPending: null,
      offers: order.offers, includeAccountBalance: false,
      totalAmount: order.orderResponse?.totalPrice,
      affiliateId: '', creatorSource: '',
      syncToken: order.syncToken,
    }),
  })
  const confirmText = await confirmRes.text()
  let confirm: JsonObj = {}
  try { confirm = JSON.parse(confirmText) as JsonObj } catch { /* 非 JSON */ }
  if (!confirmRes.ok) {
    throw new Error(`Epic 确认订单失败：${pickStr(confirm, 'errorCode') || pickStr(confirm, 'errorMessage') || `HTTP ${confirmRes.status}`}`)
  }
  const confirmation = (confirm.data as JsonObj | undefined)?.confirmation ?? confirm.confirmation
  if (!confirmation) throw new Error('Epic 确认订单没有返回 confirmation，请在商店里确认是否已入库')
  return String(confirmation)
}

// ---------------- 缓存 ----------------

export interface FreeGamesCache {
  at: number
  epicCurrent: FreeGame[]
  epicUpcoming: FreeGame[]
  gog: FreeGame[]
}

export function loadCache(): FreeGamesCache | null {
  try {
    const v = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as FreeGamesCache | null
    return v && typeof v.at === 'number' ? v : null
  } catch { return null }
}

function saveCache(c: FreeGamesCache): void {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)) } catch { /* 忽略 */ }
}

// ---------------- 一次巡查：拉取 + 自动领 ----------------

export interface FreeGamesCheckResult {
  at: number
  fetched: { epicCurrent: number; epicUpcoming: number; gog: number }
  claimed: string[]
  already: string[]
  errors: string[]
}

/**
 * 拉取最新免费游戏并（已绑定 Epic 且开启自动领取时）自动领取当前免费且未入库的。
 * 每次领取尝试都写一条领取记录；验证码/登录失效写明原因，不静默跳过。
 */
export async function runFreeGamesCheck(pwd: string): Promise<FreeGamesCheckResult> {
  const prefs = loadPrefs()
  const at = Date.now()
  let epicCurrent: FreeGame[] = []
  let epicUpcoming: FreeGame[] = []
  let gog: FreeGame[] = []
  let fetchError: string | null = null
  try {
    const epic = await fetchEpicFreeGames()
    epicCurrent = epic.current
    epicUpcoming = epic.upcoming
  } catch (e) {
    fetchError = e instanceof Error ? e.message : 'Epic 免费游戏拉取失败'
  }
  try { gog = await fetchGogFreeGames() } catch { gog = [] }
  saveCache({ at, epicCurrent, epicUpcoming, gog })
  saveLastCheck(at, fetchError)

  const result: FreeGamesCheckResult = {
    at,
    fetched: { epicCurrent: epicCurrent.length, epicUpcoming: epicUpcoming.length, gog: gog.length },
    claimed: [],
    already: [],
    errors: fetchError ? [fetchError] : [],
  }
  // 未绑定 / 总开关关 / Epic 开关关 → 只拉取不领取
  if (!prefs.autoClaim || !prefs.epicEnabled || !hasEpicAuth()) return result
  if (!pwd) { result.errors.push('保险箱未解锁，本次只拉取列表、没有自动领取'); return result }
  const auth = await loadEpicAuth(pwd)
  if (!auth) { result.errors.push('Epic 设备授权解不开（主密码不对或已损坏），请重新绑定'); return result }
  let tokens: { access: string; accountId: string }
  try {
    tokens = await epicAccessToken(auth)
  } catch (e) {
    const msg = describeEpicError(e)
    result.errors.push(msg)
    addRecord({ at, platform: 'epic', title: 'Epic 账号登录', outcome: 'error', message: msg })
    return result
  }
  const claimed = claimedGameIds()
  for (const game of epicCurrent) {
    if (claimed.has(`epic:${game.title}`)) { result.already.push(game.title); continue }
    if (!game.autoClaimable) continue
    try {
      await claimEpicGame(tokens.access, tokens.accountId, game)
      result.claimed.push(game.title)
      addRecord({ at, platform: 'epic', title: game.title, outcome: 'claimed', message: '自动领取成功，已入库' })
    } catch (e) {
      const msg = describeEpicError(e)
      result.errors.push(`「${game.title}」领取失败：${msg}`)
      addRecord({ at, platform: 'epic', title: game.title, outcome: 'error', message: msg })
    }
  }
  return result
}

/** 手动领一款（巡查外）：结果同样写领取记录 */
export async function claimEpicGameManual(pwd: string, game: FreeGame): Promise<string> {
  const at = Date.now()
  try {
    const auth = await loadEpicAuth(pwd)
    if (!auth) throw new Error('请先绑定 Epic 账号')
    const tokens = await epicAccessToken(auth)
    const orderId = await claimEpicGame(tokens.access, tokens.accountId, game)
    addRecord({ at, platform: 'epic', title: game.title, outcome: 'claimed', message: `手动领取成功（订单 ${orderId}），已入库` })
    return orderId
  } catch (e) {
    const msg = describeEpicError(e)
    addRecord({ at, platform: 'epic', title: game.title, outcome: 'error', message: msg })
    throw new Error(msg)
  }
}

/** 巡查是否到期（供 App 定时器调用） */
export function freeGamesCheckDue(): boolean {
  const prefs = loadPrefs()
  if (!prefs.autoClaim || !prefs.epicEnabled || !hasEpicAuth()) return false
  const last = loadLastCheckAt()
  return !last || Date.now() - last >= prefs.intervalHours * 3600_000
}

export function summarizeCheckResult(r: FreeGamesCheckResult): string {
  const parts: string[] = []
  if (r.claimed.length) parts.push(`新领 ${r.claimed.length} 款：${r.claimed.join('、')}`)
  if (r.already.length) parts.push(`${r.already.length} 款已在库`)
  if (r.errors.length) parts.push(`${r.errors.length} 个问题`)
  return parts.join('，') || `已拉取本周免费 ${r.fetched.epicCurrent} 款，无需领取`
}
