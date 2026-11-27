// 工坊 · Steam 账户（v0.1.487）：绑定用户自己的 Steam Web API Key + SteamID，
// 拉「我的库」（GetOwnedGames + GetRecentlyPlayedGames）。
// 凭据口径（470 定案）：API Key 用设备本地密钥加密（deviceKey.ts），只存本机
// localStorage 独立键，不进云同步/备份，不经任何外部服务中转。
// 前提（如实）：个人资料与「游戏详情」隐私须设为公开，否则官方接口读不到库——
// 读不到时按真实原因报错，不许假装空库。
import { epicRequest } from './freeGames'
import { encryptLocalSecret, decryptLocalSecret } from './deviceKey'

export const STEAM_ACCOUNT_KEY = 'acm.steam.account.v1'
export const STEAM_LIBRARY_KEY = 'acm.steam.library.v1'
export const STEAM_PRIVACY_NOTE = '绑定前提：Steam 个人资料与「游戏详情」隐私都要设为公开，否则官方接口读不到你的游戏库。设置路径：Steam 客户端/网页 → 头像 → 查看个人资料 → 编辑个人资料 → 隐私设置 → 「我的个人资料」与「游戏详情」都选公开。绑定后请核对页面右上角的头像、昵称和 SteamID 是不是你本人。'
export const STEAM_ID_INPUT_HELP = '请填个人资料链接（steamcommunity.com/profiles/… 或 /id/…）或 17 位 SteamID64，不要填登录用户名或昵称：只填名字会按自定义网址去解析，可能解析到同名的陌生人、绑错账户。'
export const STEAM_API_KEY_HELP = 'API Key 免费申请：打开 steamcommunity.com/dev/apikey，用你的 Steam 账户登录后随便填一个域名（如 localhost）即可拿到。Key 只加密存在这台设备上，不会上传到任何地方。'

// ---------------- SteamID / 资料链接解析 ----------------

export type SteamIdParse =
  | { kind: 'id'; steamid: string }
  | { kind: 'vanity'; vanity: string }
  | null

/**
 * 解析用户输入：SteamID64（17 位数字）、/profiles/<id> 链接、/id/<vanity>
 * 链接、裸 vanity 名。认不出返回 null。
 */
export function parseSteamIdInput(input: string): SteamIdParse {
  const s = (input ?? '').trim()
  if (!s) return null
  const prof = s.match(/steamcommunity\.com\/profiles\/(\d{17})/)
  if (prof) return { kind: 'id', steamid: prof[1] }
  const vanityUrl = s.match(/steamcommunity\.com\/id\/([A-Za-z0-9_-]{2,64})/)
  if (vanityUrl) return { kind: 'vanity', vanity: vanityUrl[1] }
  if (/^\d{17}$/.test(s)) return { kind: 'id', steamid: s }
  if (/^\d+$/.test(s)) return null // 纯数字又不是 17 位：多半是填错的 SteamID，不当 vanity 猜
  if (/^[A-Za-z0-9_-]{2,64}$/.test(s)) return { kind: 'vanity', vanity: s }
  return null
}

// ---------------- Web API 地址与解析 ----------------

export function buildResolveVanityUrl(apiKey: string, vanity: string): string {
  const q = new URLSearchParams({ key: apiKey, vanityurl: vanity })
  return `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v0001/?${q.toString()}`
}

export function buildPlayerSummariesUrl(apiKey: string, steamid: string): string {
  const q = new URLSearchParams({ key: apiKey, steamids: steamid })
  return `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?${q.toString()}`
}

export function buildOwnedGamesUrl(apiKey: string, steamid: string): string {
  const q = new URLSearchParams({
    key: apiKey, steamid, include_appinfo: 'true', include_played_free_games: 'true', format: 'json',
  })
  return `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?${q.toString()}`
}

export function buildRecentlyPlayedUrl(apiKey: string, steamid: string): string {
  const q = new URLSearchParams({ key: apiKey, steamid, format: 'json' })
  return `https://api.steampowered.com/IPlayerService/GetRecentlyPlayedGames/v0001/?${q.toString()}`
}

/** ResolveVanityURL 响应 → steamid；success=42 是查无此人，返回 null。 */
export function parseResolveVanity(json: unknown): string | null {
  const r = (json as { response?: { success?: unknown; steamid?: unknown } })?.response
  if (r?.success === 1 && typeof r.steamid === 'string' && /^\d{17}$/.test(r.steamid)) return r.steamid
  return null
}

export interface SteamProfile { steamid: string; personaName: string; avatarUrl: string }

/** GetPlayerSummaries 响应 → 资料（昵称/头像）。 */
export function parsePlayerSummary(json: unknown, steamid: string): SteamProfile | null {
  const players = (json as { response?: { players?: unknown } })?.response?.players
  if (!Array.isArray(players) || players.length === 0) return null
  const p = (players[0] ?? {}) as { steamid?: unknown; personaname?: unknown; avatarfull?: unknown; avatarmedium?: unknown }
  return {
    steamid: typeof p.steamid === 'string' ? p.steamid : steamid,
    personaName: typeof p.personaname === 'string' && p.personaname ? p.personaname : 'Steam 用户',
    avatarUrl: typeof p.avatarfull === 'string' ? p.avatarfull : typeof p.avatarmedium === 'string' ? p.avatarmedium : '',
  }
}

// ---------------- 游戏库 ----------------

export interface SteamLibraryGame {
  appid: string
  name: string
  /** 总时长（分钟） */
  playtimeForever: number
  /** 近两周时长（分钟，来自 GetRecentlyPlayedGames）；无则 undefined */
  playtime2Weeks?: number
  /** 上次游玩时间（unix 秒，来自 rtime_last_played）；无则 undefined */
  lastPlayed?: number
  coverUrl: string
  iconUrl: string
}

export function libraryCoverUrl(appid: string): string {
  return `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`
}

export type OwnedGamesParse =
  | { status: 'ok'; games: SteamLibraryGame[] }
  | { status: 'unreadable' }

/**
 * GetOwnedGames 响应解析。隐私未公开/游戏详情不可见（也包括绑错到游戏详情
 * 私密的他人账户）时 Steam 返回空 response（没有 games 字段）→ 'unreadable'，
 * 绝不当成空库。
 */
export function parseOwnedGames(json: unknown): OwnedGamesParse {
  const resp = (json as { response?: { games?: unknown } })?.response
  if (!resp || !Array.isArray(resp.games)) return { status: 'unreadable' }
  const games: SteamLibraryGame[] = []
  for (const g of resp.games) {
    const r = (g ?? {}) as {
      appid?: unknown; name?: unknown; playtime_forever?: unknown
      rtime_last_played?: unknown; img_icon_url?: unknown
    }
    if (typeof r.appid !== 'number') continue
    const appid = String(r.appid)
    games.push({
      appid,
      name: typeof r.name === 'string' && r.name ? r.name : `App ${appid}`,
      playtimeForever: typeof r.playtime_forever === 'number' ? r.playtime_forever : 0,
      lastPlayed: typeof r.rtime_last_played === 'number' && r.rtime_last_played > 0 ? r.rtime_last_played : undefined,
      coverUrl: libraryCoverUrl(appid),
      iconUrl: typeof r.img_icon_url === 'string' && r.img_icon_url
        ? `https://media.steampowered.com/steamcommunity/public/images/apps/${appid}/${r.img_icon_url}.jpg`
        : '',
    })
  }
  return { status: 'ok', games }
}

/** GetRecentlyPlayedGames 响应 → appid → 近两周分钟数。 */
export function parseRecentlyPlayed(json: unknown): Map<string, number> {
  const out = new Map<string, number>()
  const games = (json as { response?: { games?: unknown } })?.response?.games
  if (!Array.isArray(games)) return out
  for (const g of games) {
    const r = (g ?? {}) as { appid?: unknown; playtime_2weeks?: unknown }
    if (typeof r.appid === 'number' && typeof r.playtime_2weeks === 'number') {
      out.set(String(r.appid), r.playtime_2weeks)
    }
  }
  return out
}

/** 把近两周时长并进库列表（纯函数）。 */
export function mergeRecentlyPlayed(games: SteamLibraryGame[], recent: Map<string, number>): SteamLibraryGame[] {
  return games.map(g => {
    const two = recent.get(g.appid)
    return two === undefined ? g : { ...g, playtime2Weeks: two }
  })
}

export type LibrarySort = 'playtime' | 'recent' | 'name'

export function sortLibraryGames(games: SteamLibraryGame[], sort: LibrarySort): SteamLibraryGame[] {
  const list = [...games]
  if (sort === 'playtime') list.sort((a, b) => b.playtimeForever - a.playtimeForever || a.name.localeCompare(b.name))
  else if (sort === 'recent') list.sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0) || b.playtimeForever - a.playtimeForever)
  else list.sort((a, b) => a.name.localeCompare(b.name))
  return list
}

export interface LibrarySummary { total: number; totalHours: number; recent30: number }

/** 顶部汇总：库内总数 · 总时长（小时，1 位小数） · 近 30 天玩过 N 款。 */
export function summarizeLibrary(games: SteamLibraryGame[], now: number = Date.now()): LibrarySummary {
  const totalMinutes = games.reduce((s, g) => s + g.playtimeForever, 0)
  const cutoff = Math.floor(now / 1000) - 30 * 24 * 3600
  return {
    total: games.length,
    totalHours: Math.round((totalMinutes / 60) * 10) / 10,
    recent30: games.filter(g => (g.lastPlayed ?? 0) >= cutoff).length,
  }
}

/** 已拥有 appid 集合（商城「已入库」标对账用）。 */
export function ownedAppidSet(games: SteamLibraryGame[]): Set<string> {
  return new Set(games.map(g => g.appid))
}

// ---------------- 错误人话化 ----------------

export class SteamApiError extends Error {
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

export const STEAM_KEY_INVALID_MSG = 'Steam API Key 无效或已被撤销：请到 steamcommunity.com/dev/apikey 检查 Key 后重新绑定。'
export const STEAM_PRIVACY_MSG = '读不到这个账户的游戏库，常见有两种原因：① 个人资料或「游戏详情」隐私没设为公开——在 Steam 里打开 头像 → 查看个人资料 → 编辑个人资料 → 隐私设置，把「我的个人资料」和「游戏详情」都设为公开，再点「刷新游戏库」；② 绑定的可能不是你自己的账户——请核对页面右上角的头像、昵称和 SteamID 是不是你本人，不是就解绑后用个人资料链接重新绑定。'
export const STEAM_NETWORK_MSG = '连不上 Steam 接口：网络请求失败，可能被代理/网络拦截，请换个节点再试。'

export function humanizeSteamApiError(e: unknown): string {
  if (e instanceof SteamApiError) return e.message
  const msg = e instanceof Error ? e.message : String(e)
  if (/load failed|failed to fetch|networkerror|network request failed/i.test(msg)) return STEAM_NETWORK_MSG
  return msg
}

async function steamApiGet(url: string): Promise<unknown> {
  let res: { ok: boolean; status: number; text: string }
  try {
    res = await epicRequest(url, 'GET', { Accept: 'application/json' })
  } catch (e) {
    throw new SteamApiError(humanizeSteamApiError(e))
  }
  if (res.status === 401 || res.status === 403) throw new SteamApiError(STEAM_KEY_INVALID_MSG, res.status)
  if (!res.ok) throw new SteamApiError(`Steam 接口返回 HTTP ${res.status}，请稍后再试。`, res.status)
  try {
    return JSON.parse(res.text)
  } catch {
    throw new SteamApiError('Steam 接口返回的数据不是有效 JSON，请稍后再试。')
  }
}

// ---------------- 凭据与库缓存存储 ----------------

export interface SteamBinding { profile: SteamProfile; boundAt: number }

interface StoredAccount {
  v: 1
  /** API Key 的设备本地密文（L1. 前缀） */
  keyCipher: string
  profile: SteamProfile
  boundAt: number
}

export async function saveSteamBinding(apiKey: string, profile: SteamProfile): Promise<SteamBinding> {
  const keyCipher = await encryptLocalSecret(apiKey)
  const stored: StoredAccount = { v: 1, keyCipher, profile, boundAt: Date.now() }
  try { localStorage.setItem(STEAM_ACCOUNT_KEY, JSON.stringify(stored)) } catch { /* 存不下也先用 */ }
  return { profile, boundAt: stored.boundAt }
}

/** 读绑定（含解密出的 API Key）；没绑定返回 null，密文损坏抛错由调用方提示。 */
export async function loadSteamBinding(): Promise<{ binding: SteamBinding; apiKey: string } | null> {
  let raw: string | null = null
  try { raw = localStorage.getItem(STEAM_ACCOUNT_KEY) } catch { return null }
  if (!raw) return null
  let stored: StoredAccount
  try {
    stored = JSON.parse(raw) as StoredAccount
  } catch { return null }
  if (!stored || typeof stored.keyCipher !== 'string' || !stored.profile) return null
  const apiKey = await decryptLocalSecret(stored.keyCipher)
  return { binding: { profile: stored.profile, boundAt: stored.boundAt }, apiKey }
}

/** 只读资料（不解密），给页头账户块快速显示。 */
export function loadSteamProfileFast(): SteamProfile | null {
  try {
    const raw = localStorage.getItem(STEAM_ACCOUNT_KEY)
    if (!raw) return null
    const stored = JSON.parse(raw) as StoredAccount
    return stored?.profile ?? null
  } catch { return null }
}

export function clearSteamBinding(): void {
  try {
    localStorage.removeItem(STEAM_ACCOUNT_KEY)
    localStorage.removeItem(STEAM_LIBRARY_KEY)
  } catch { /* 忽略 */ }
}

export interface SteamLibraryCache { at: number; games: SteamLibraryGame[] }

export function loadSteamLibraryCache(): SteamLibraryCache | null {
  try {
    const raw = localStorage.getItem(STEAM_LIBRARY_KEY)
    if (!raw) return null
    const data = JSON.parse(raw) as SteamLibraryCache
    if (!data || typeof data.at !== 'number' || !Array.isArray(data.games)) return null
    return data
  } catch { return null }
}

export function saveSteamLibraryCache(games: SteamLibraryGame[]): SteamLibraryCache {
  const cache: SteamLibraryCache = { at: Date.now(), games }
  try { localStorage.setItem(STEAM_LIBRARY_KEY, JSON.stringify(cache)) } catch { /* 忽略 */ }
  return cache
}

// ---------------- 绑定与拉库（编排） ----------------

/** vanity 名 → SteamID64；查无此人抛人话错误。 */
export async function resolveSteamId(apiKey: string, parsed: Exclude<SteamIdParse, null>): Promise<string> {
  if (parsed.kind === 'id') return parsed.steamid
  const json = await steamApiGet(buildResolveVanityUrl(apiKey, parsed.vanity))
  const steamid = parseResolveVanity(json)
  if (!steamid) {
    throw new SteamApiError(`找不到这个 Steam 个人资料（${parsed.vanity}）：请检查链接是否正确，或直接填 SteamID64。`)
  }
  return steamid
}

/** 拉资料（顺带验证 Key 可用）；Key 无效时 steamApiGet 已抛 STEAM_KEY_INVALID_MSG。 */
export async function fetchSteamProfile(apiKey: string, steamid: string): Promise<SteamProfile> {
  const json = await steamApiGet(buildPlayerSummariesUrl(apiKey, steamid))
  const profile = parsePlayerSummary(json, steamid)
  if (!profile) throw new SteamApiError('Steam 接口没有返回这个账户的资料，请确认 SteamID 正确、个人资料为公开后再试。')
  return profile
}

/**
 * 拉全库：GetOwnedGames 为主（读不到按 STEAM_PRIVACY_MSG 双因报错，不假装空库），
 * GetRecentlyPlayedGames 补近两周时长（失败不挡主库）。
 */
export async function fetchSteamLibrary(apiKey: string, steamid: string): Promise<SteamLibraryGame[]> {
  const ownedJson = await steamApiGet(buildOwnedGamesUrl(apiKey, steamid))
  const owned = parseOwnedGames(ownedJson)
  if (owned.status === 'unreadable') throw new SteamApiError(STEAM_PRIVACY_MSG)
  let games = owned.games
  try {
    const recentJson = await steamApiGet(buildRecentlyPlayedUrl(apiKey, steamid))
    games = mergeRecentlyPlayed(games, parseRecentlyPlayed(recentJson))
  } catch { /* 近期游玩只是补充，失败不挡主库 */ }
  saveSteamLibraryCache(games)
  return games
}

/**
 * 绑定结果反馈文案：带昵称 + SteamID 让用户核对绑的是不是自己；
 * 拉库失败时额外点明先核对页头头像和昵称（绑错账户时库必然读不到，别只往隐私上想）。
 */
export function buildBindFeedback(profile: SteamProfile, libraryError: string | null): { message: string; ok: boolean } {
  const who = `${profile.personaName}（SteamID ${profile.steamid}）`
  if (libraryError) {
    return { message: `已绑定 ${who}，但游戏库没拉到：${libraryError} 请先核对页头头像和昵称是不是你本人。`, ok: false }
  }
  return { message: `Steam 账户已绑定：${who}，游戏库已拉取。请核对页头头像和昵称是不是你本人。`, ok: true }
}

/** 绑定全流程：解析输入 → 解析 vanity → 验证 Key 并拉资料 → 存绑定 → 自动拉一次库。 */
export async function bindSteamAccount(apiKey: string, idInput: string): Promise<{ binding: SteamBinding; library: SteamLibraryGame[] | null; libraryError: string | null }> {
  const key = (apiKey ?? '').trim()
  if (!key) throw new SteamApiError('请先填 Steam Web API Key。')
  const parsed = parseSteamIdInput(idInput)
  if (!parsed) throw new SteamApiError('SteamID 或个人资料链接认不出来：请填 17 位 SteamID64，或 steamcommunity.com/profiles/… 或 /id/… 链接。')
  const steamid = await resolveSteamId(key, parsed)
  const profile = await fetchSteamProfile(key, steamid)
  const binding = await saveSteamBinding(key, profile)
  let library: SteamLibraryGame[] | null = null
  let libraryError: string | null = null
  try {
    library = await fetchSteamLibrary(key, steamid)
  } catch (e) {
    libraryError = humanizeSteamApiError(e)
  }
  return { binding, library, libraryError }
}
