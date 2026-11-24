// 工坊 · 看剧（v0.1.386）：AI 找剧 + 热门推荐（TMDB）+ 短剧专区 + 直播 + 追剧日历 + 片单。
// 直播只用合法公开源：iptv-org（公开免费频道目录）与 Free-TV；绝不内置
// vbskycn/lilei6900s/fanmingming/Guovin 等聚合央视/卫视的第三方转播源。
// 自定义源由用户自己粘贴 m3u 订阅链接（像 VLC 里粘地址），输入框留空不预填。
// 分组口径（Ethan 定）：外国只按国家 + 内容两维；中国按央视/卫视/其他 + 内容
// 两维；General/Undefined 统一归“其他”。全部数据只存本机，不进云同步/备份。
// 来源标注（v0.1.387，Ethan 2026-11-24 拍板：保持现状、界面标注）：实测
// iptv-org/Free-TV 的中国切片并不干净——央视流大量指向第三方转播服务器
// （裸 IP 直连，如 74.91.26.218）。这些流不拦截、不过滤，只打「未授权转播」
// 标记：频道卡片角标 + 播放器内提示 + 直播分区顶部说明。

import { encryptSecret, decryptSecret } from './crypto'

export interface LiveChannel {
  /** 归一化台名（去分辨率后缀、小写） */
  key: string
  name: string
  logo?: string
  /** 内容分类键（news/movies/sports/kids/music/documentary/…/other） */
  content: string
  /** 所属国家码：CN/US/GB/JP/KR… */
  country: string
  /** 多套源的播放地址（按优先级：自定义源 > iptv-org > Free-TV） */
  urls: string[]
  /** 出现过的源集合 id */
  sourceIds: string[]
  /** 主源（urls[0]）是否为第三方转播（未授权）：解析时按 URL 打标记 */
  unofficial?: boolean
}

// ---------------- 来源标记：第三方转播（未授权） ----------------
// 实测坐实（v0.1.386）：iptv-org cn.m3u 与 Free-TV 中国组里央视流大量指向
// 裸 IP 直连的第三方转播服务器，与被拒仓库同一批源。正版来源（如 CCTV+
// 走 cctvplus.com、省台官方 CDN）是域名，不标记。判断只看 URL 本身，与
// 内置源/自定义源无关——用户自己粘的源同样按此规则打标记。

/** 实测见过的第三方转播 host（均为裸 IP；通用 IPv4 规则已覆盖，此处留作显式记录、可扩展域名） */
export const UNOFFICIAL_STREAM_HOSTS = new Set([
  '74.91.26.218',
  '69.30.245.50',
  '38.75.136.137',
])

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

/** 某条流地址是否为第三方转播（未授权）：host 是裸 IP 字面量（v4/v6，含端口）或已知转播 host */
export function isUnofficialStreamUrl(url: string): boolean {
  let host = ''
  try { host = new URL(url).hostname } catch { return false }
  if (!host) return false
  if (UNOFFICIAL_STREAM_HOSTS.has(host)) return true
  if (IPV4_RE.test(host)) return true
  if (host.includes(':')) return true // IPv6 字面量（new URL 去掉方括号后含冒号）
  return false
}

/** 某频道当前主源（urls[0]）是否为第三方转播；旧缓存缺 unofficial 字段时同样适用 */
export function isChannelUnofficial(ch: LiveChannel): boolean {
  if (ch.unofficial === true) return true
  return ch.urls.length > 0 && isUnofficialStreamUrl(ch.urls[0])
}

export interface SourceSetResult {
  setId: string
  label: string
  ok: boolean
  count: number
  error?: string
  /** 本次结果是否来自 24 小时缓存（是则不发请求） */
  cached?: boolean
  cachedAt?: number
}

export interface SourceSet {
  id: string
  label: string
  url: string
  /** 该套源归属的国家；Free-TV 为 world（按条目 tvg-country/group-title 再分） */
  country: string
}

export const IPTV_ORG_BASE = 'https://iptv-org.github.io/iptv'
export const FREE_TV_URL = 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8'

/** 内置源集合（只含 iptv-org 与 Free-TV；绝不含第三方转播源） */
export const BUILTIN_SETS: SourceSet[] = [
  { id: 'iptv-cn', label: 'iptv-org · 中国', url: `${IPTV_ORG_BASE}/countries/cn.m3u`, country: 'CN' },
  { id: 'iptv-us', label: 'iptv-org · 美国', url: `${IPTV_ORG_BASE}/countries/us.m3u`, country: 'US' },
  { id: 'iptv-uk', label: 'iptv-org · 英国', url: `${IPTV_ORG_BASE}/countries/uk.m3u`, country: 'GB' },
  { id: 'iptv-jp', label: 'iptv-org · 日本', url: `${IPTV_ORG_BASE}/countries/jp.m3u`, country: 'JP' },
  { id: 'iptv-kr', label: 'iptv-org · 韩国', url: `${IPTV_ORG_BASE}/countries/kr.m3u`, country: 'KR' },
  { id: 'freetv', label: 'Free-TV', url: FREE_TV_URL, country: 'WORLD' },
]
// 注意：分类切片（如 categories/news.m3u）不单独拉——内容分组直接用各条目
// 的 group-title 元数据；index.m3u 总表（2.6MB、11,505 台）绝不拉。

export const COUNTRIES: { code: string; label: string; setId: string }[] = [
  { code: 'CN', label: '中国', setId: 'iptv-cn' },
  { code: 'US', label: '美国', setId: 'iptv-us' },
  { code: 'GB', label: '英国', setId: 'iptv-uk' },
  { code: 'JP', label: '日本', setId: 'iptv-jp' },
  { code: 'KR', label: '韩国', setId: 'iptv-kr' },
]

/** 内容分类：group-title 英文 → 中文标签（未列出的与 General/Undefined 归“其他”） */
export const CONTENT_LABELS: Record<string, string> = {
  news: '新闻', movies: '电影', sports: '体育', kids: '少儿', music: '音乐',
  documentary: '纪录片', entertainment: '娱乐', series: '剧集', lifestyle: '生活',
  education: '教育', business: '财经', religious: '宗教', culture: '文化',
  weather: '天气', travel: '旅游', science: '科教', legislative: '时政',
  shop: '购物', classic: '经典', comedy: '喜剧', animation: '动画', other: '其他',
}
export const CONTENT_ORDER = ['news', 'movies', 'sports', 'kids', 'music', 'documentary', 'entertainment', 'series', 'lifestyle', 'education', 'business', 'culture', 'other']

/** Free-TV 的 group-title 是国家名：映射到国家码（未列出的归 WORLD） */
const FREE_TV_COUNTRY_MAP: Record<string, string> = {
  China: 'CN', 'United States': 'US', USA: 'US', US: 'US',
  'United Kingdom': 'GB', UK: 'GB', Japan: 'JP', 'South Korea': 'KR', Korea: 'KR',
}

/** 省级卫视英文名（iptv-org 的中国区多用英文台名，如 Anhui TV） */
const PROVINCIAL_TV_EN = [
  'Hunan', 'Zhejiang', 'Jiangsu', 'Anhui', 'Beijing', 'Dragon', 'Guangdong',
  'Shandong', 'Sichuan', 'Hubei', 'Henan', 'Fujian', 'Liaoning', 'Jilin',
  'Heilongjiang', 'Hebei', 'Shanxi', 'Shaanxi', 'Yunnan', 'Guizhou', 'Guangxi',
  'Jiangxi', 'Tianjin', 'Chongqing', 'Shenzhen', 'Hainan', 'Ningxia', 'Qinghai',
  'Gansu', 'Inner Mongolia', 'Xizang', 'Xinjiang',
]

export type StationOrigin = 'cctv' | 'satellite' | 'other'

/** 台属：中国才分——央视（CCTV 开头）/ 卫视（以“卫视”结尾或省级卫视英文名）/ 其他 */
export function stationOrigin(name: string): StationOrigin {
  const n = name.trim()
  if (/^cctv/i.test(n)) return 'cctv'
  if (/卫视$/.test(n)) return 'satellite'
  const lower = n.toLowerCase()
  if (/ tv$/.test(lower) && PROVINCIAL_TV_EN.some(p => lower.startsWith(p.toLowerCase() + ' '))) return 'satellite'
  return 'other'
}

export const ORIGIN_LABELS: Record<StationOrigin, string> = { cctv: '央视', satellite: '卫视', other: '其他' }

/** 内容归一化：取 group-title 首个分段；General/Undefined/未知 → other */
export function contentKeyOf(groupTitle: string): string {
  const first = (groupTitle || '').split(/[;,/]/)[0]?.trim().toLowerCase() ?? ''
  if (!first || first === 'general' || first === 'undefined') return 'other'
  const key = first.replace(/[^a-z]/g, '')
  return CONTENT_LABELS[key] ? key : 'other'
}

/** 台名归一化：去分辨率后缀、去多余空格，供跨源去重 */
export function normalizeChannelName(name: string): string {
  return name
    .replace(/\s*\((?:720p|1080p|4k|2160p|sd|hd|fhd|uhd)\)\s*/gi, '')
    .replace(/\s+(720p|1080p|4k|2160p|sd|hd|fhd|uhd)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

interface M3uEntry {
  name: string
  logo?: string
  groupTitle: string
  tvgCountry?: string
  url: string
}

/** 解析 m3u/m3u8 文本：#EXTINF 行 + 下一行地址 */
export function parseM3u(text: string): M3uEntry[] {
  const lines = text.split(/\r?\n/)
  const out: M3uEntry[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line.startsWith('#EXTINF')) continue
    const attr = (key: string): string => {
      const m = new RegExp(`${key}="([^"]*)"`).exec(line)
      return m?.[1] ?? ''
    }
    const name = line.slice(line.lastIndexOf(',') + 1).trim()
    let url = ''
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j].trim()
      if (!next) continue
      if (next.startsWith('#')) continue
      url = next
      break
    }
    if (!name || !url || !/^https?:\/\//.test(url)) continue
    out.push({
      name,
      logo: attr('tvg-logo') || undefined,
      groupTitle: attr('group-title'),
      tvgCountry: attr('tvg-country') || undefined,
      url,
    })
  }
  return out
}

/** 分片解析 m3u：每 500 行让出一次主线程，大列表解析不卡界面 */
export async function parseM3uAsync(text: string): Promise<M3uEntry[]> {
  const lines = text.split(/\r?\n/)
  const out: M3uEntry[] = []
  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && i % 500 === 0) await new Promise(r => globalThis.setTimeout(r, 0))
    const line = lines[i].trim()
    if (!line.startsWith('#EXTINF')) continue
    const attr = (key: string): string => {
      const m = new RegExp(`${key}="([^"]*)"`).exec(line)
      return m?.[1] ?? ''
    }
    const name = line.slice(line.lastIndexOf(',') + 1).trim()
    let url = ''
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j].trim()
      if (!next) continue
      if (next.startsWith('#')) continue
      url = next
      break
    }
    if (!name || !url || !/^https?:\/\//.test(url)) continue
    out.push({
      name,
      logo: attr('tvg-logo') || undefined,
      groupTitle: attr('group-title'),
      tvgCountry: attr('tvg-country') || undefined,
      url,
    })
  }
  return out
}

function countryOfEntry(e: M3uEntry, setCountry: string): string {
  if (e.tvgCountry) return e.tvgCountry.toUpperCase()
  if (setCountry !== 'WORLD') return setCountry
  return FREE_TV_COUNTRY_MAP[e.groupTitle] ?? 'WORLD'
}

function entriesToChannels(entries: M3uEntry[], setCountry: string, setId: string): LiveChannel[] {
  return entries.map(e => {
    // 保留原始显示名（仅去掉分辨率后缀）
    const display = e.name.replace(/\s*\((?:720p|1080p|4k|2160p|sd|hd|fhd|uhd)\)\s*/gi, '').replace(/\s+/g, ' ').trim()
    return {
      key: normalizeChannelName(e.name),
      name: display,
      logo: e.logo,
      content: contentKeyOf(e.groupTitle),
      country: countryOfEntry(e, setCountry),
      urls: [e.url],
      sourceIds: [setId],
      unofficial: isUnofficialStreamUrl(e.url),
    }
  })
}

/** 合并多套源的频道：同名（归一化后）合并播放地址，自定义源优先 */
export function mergeChannels(lists: LiveChannel[][]): LiveChannel[] {
  const map = new Map<string, LiveChannel>()
  for (const list of lists) {
    for (const ch of list) {
      const prev = map.get(ch.key)
      if (!prev) { map.set(ch.key, { ...ch, urls: [...ch.urls], sourceIds: [...ch.sourceIds] }); continue }
      for (const u of ch.urls) if (!prev.urls.includes(u)) prev.urls.push(u)
      for (const s of ch.sourceIds) if (!prev.sourceIds.includes(s)) prev.sourceIds.push(s)
      if (!prev.logo && ch.logo) prev.logo = ch.logo
      if (prev.content === 'other' && ch.content !== 'other') prev.content = ch.content
    }
  }
  // 合并后主源可能变化：按合并后的 urls[0] 重新打标记
  for (const ch of map.values()) ch.unofficial = isUnofficialStreamUrl(ch.urls[0] ?? '')
  return [...map.values()]
}

async function fetchTextWithTimeout(url: string, timeoutMs: number): Promise<string> {
  const ctrl = new AbortController()
  const t = globalThis.setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: '*/*' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } finally {
    globalThis.clearTimeout(t)
  }
}

// ---------------- 播放列表缓存（性能，v0.1.386 追加） ----------------
// 直播源禁止全量加载：默认只拉国家切片（中国 cn.m3u 156 台），绝不拉
// index.m3u 总表（2.6MB、11,505 台）；外国按国家切片按需拉（点哪个国家
// 再拉哪个）；分类切片不单独拉（内容分组直接用 group-title 元数据）。
// 解析结果按源缓存本机 24 小时：24 小时内直接读缓存，不重新拉、不重新解析。
export const PLAYLIST_CACHE_KEY = 'acm.watch.playlistCache.v1'
export const PLAYLIST_CACHE_TTL_MS = 24 * 3600_000

interface PlaylistCacheEntry { url: string; at: number; channels: LiveChannel[] }
type PlaylistCache = Record<string, PlaylistCacheEntry>

function loadPlaylistCache(): PlaylistCache {
  try {
    const v = JSON.parse(localStorage.getItem(PLAYLIST_CACHE_KEY) ?? '{}') as PlaylistCache
    return v && typeof v === 'object' ? v : {}
  } catch { return {} }
}

function savePlaylistCache(cache: PlaylistCache): void {
  try {
    // 每套源最多存 2000 条，防 localStorage 爆掉
    for (const k of Object.keys(cache)) cache[k].channels = cache[k].channels.slice(0, 2000)
    localStorage.setItem(PLAYLIST_CACHE_KEY, JSON.stringify(cache))
  } catch { /* 忽略（存不下时下次重新拉） */ }
}

/** 缓存键：国家切片按源 id；Free-TV 按国家过滤后分开存；自定义源按 id */
function playlistCacheKey(set: SourceSet, countryFilter?: string): string {
  return countryFilter ? `${set.id}:${countryFilter}` : set.id
}

export function clearPlaylistCache(): void {
  try { localStorage.removeItem(PLAYLIST_CACHE_KEY) } catch { /* 忽略 */ }
}

export interface FetchSourceSetOptions { force?: boolean; countryFilter?: string }

/**
 * 拉一套源：先读 24 小时缓存（force 时跳过），缓存失效才拉取并分片解析；
 * 失败返回 error（中文），不抛错，供多套自动切换。
 */
export async function fetchSourceSet(set: SourceSet, opts: FetchSourceSetOptions = {}): Promise<{ channels: LiveChannel[]; result: SourceSetResult }> {
  const cacheKey = playlistCacheKey(set, opts.countryFilter)
  if (!opts.force) {
    const hit = loadPlaylistCache()[cacheKey]
    if (hit && hit.url === set.url && Date.now() - hit.at < PLAYLIST_CACHE_TTL_MS && Array.isArray(hit.channels)) {
      return { channels: hit.channels, result: { setId: set.id, label: set.label, ok: true, count: hit.channels.length, cached: true, cachedAt: hit.at } }
    }
  }
  try {
    const text = await fetchTextWithTimeout(set.url, 20000)
    const entries = await parseM3uAsync(text)
    let channels = entriesToChannels(entries, set.country, set.id)
    if (opts.countryFilter) channels = channels.filter(c => c.country === opts.countryFilter)
    const cache = loadPlaylistCache()
    cache[cacheKey] = { url: set.url, at: Date.now(), channels }
    savePlaylistCache(cache)
    return { channels, result: { setId: set.id, label: set.label, ok: true, count: channels.length } }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const reason = /abort|timeout|timed out/i.test(msg)
      ? '拉取超时（20 秒无响应）'
      : /load failed|failed to fetch|networkerror/i.test(msg)
        ? '网络请求失败，可能被代理/网络拦截，请换个节点再试'
        : `拉取失败（${msg.slice(0, 60)}）`
    return { channels: [], result: { setId: set.id, label: set.label, ok: false, count: 0, error: reason } }
  }
}

// ---------------- 自定义源（用户自己粘贴 m3u 订阅链接） ----------------

export interface CustomSource { id: string; label: string; url: string; addedAt: number }
export const CUSTOM_SOURCES_KEY = 'acm.watch.customSources.v1'

export function loadCustomSources(): CustomSource[] {
  try {
    const v = JSON.parse(localStorage.getItem(CUSTOM_SOURCES_KEY) ?? '[]')
    return Array.isArray(v) ? (v as CustomSource[]).filter(s => s?.url) : []
  } catch { return [] }
}

export function saveCustomSources(list: CustomSource[]): void {
  try { localStorage.setItem(CUSTOM_SOURCES_KEY, JSON.stringify(list)) } catch { /* 忽略 */ }
}

function customSourcesAsSets(): SourceSet[] {
  return loadCustomSources().map(s => ({ id: `custom-${s.id}`, label: `自定义 · ${s.label}`, url: s.url, country: 'WORLD' }))
}

/**
 * 拉取某国家（或 WORLD 全部）的频道：多套源并行拉，单套失败自动由其他套顶上；
 * 同名频道合并播放地址（一个播不了播另一个）。返回频道与每套源的状态。
 * 性能：默认只拉该国家切片 + Free-TV（按国家过滤后缓存），绝不拉总表；
 * 24 小时内读缓存不重新拉；force=true 时强制重新拉（「重新加载」按钮）。
 */
export async function loadCountryChannels(country: string, opts: { force?: boolean } = {}): Promise<{ channels: LiveChannel[]; sets: SourceSetResult[] }> {
  const sets: SourceSet[] = []
  const countrySet = BUILTIN_SETS.find(s => s.country === country && s.id.startsWith('iptv-'))
  if (countrySet) sets.push(countrySet)
  // Free-TV 按条目国家过滤后参与合并（backup），只存本国条目
  sets.push(BUILTIN_SETS.find(s => s.id === 'freetv')!)
  sets.push(...customSourcesAsSets())
  const settled = await Promise.all(sets.map(async s => {
    const countryFilter = s.id === 'freetv' && country !== 'WORLD' ? country : undefined
    const r = await fetchSourceSet(s, { force: opts.force, countryFilter })
    return { channels: r.channels, result: r.result }
  }))
  const lists = settled.map(s => s.channels)
  const channels = mergeChannels(lists)
    // 未标国家的自定义源条目（country WORLD）归入当前国家（用户自己粘的源，没写 tvg-country 也要能看）
    .filter(c => country === 'WORLD' || c.country === country || (c.country === 'WORLD' && c.sourceIds.some(id => id.startsWith('custom-'))))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  return { channels, sets: settled.map(s => s.result) }
}

// ---------------- 分组 ----------------

export interface LiveGroups {
  /** 中国：央视 / 卫视 / 其他；外国：按内容直接分组 */
  origins: { key: StationOrigin; label: string; channels: LiveChannel[] }[]
  /** 该国家/地区下出现过的内容分类（按 CONTENT_ORDER 排序） */
  contents: string[]
}

export function groupChannels(channels: LiveChannel[], country: string): LiveGroups {
  const contents = [...new Set(channels.map(c => c.content))]
    .sort((a, b) => (CONTENT_ORDER.indexOf(a) === -1 ? 99 : CONTENT_ORDER.indexOf(a)) - (CONTENT_ORDER.indexOf(b) === -1 ? 99 : CONTENT_ORDER.indexOf(b)))
  if (country === 'CN') {
    const byOrigin = (key: StationOrigin) => channels.filter(c => stationOrigin(c.name) === key)
    return {
      origins: (['cctv', 'satellite', 'other'] as StationOrigin[])
        .map(key => ({ key, label: ORIGIN_LABELS[key], channels: byOrigin(key) }))
        .filter(g => g.channels.length > 0),
      contents,
    }
  }
  return { origins: [{ key: 'other', label: '全部', channels }], contents }
}

// ---------------- 本机存储：片单 / 继续观看 / 分组折叠 ----------------

export type WatchType = 'tv' | 'movie' | 'short'
export interface WatchItem {
  id: string
  title: string
  type: WatchType
  platform: string
  platformUrl?: string
  poster?: string
  overview?: string
  /** 当前看到第几集（短剧/剧集） */
  episode?: number
  totalEpisodes?: number
  /** 下次更新/提醒日期 YYYY-MM-DD */
  nextDate?: string
  status: 'todo' | 'watching' | 'done'
  addedAt: number
}

export interface ContinueItem {
  id: string
  title: string
  platform: string
  kind: 'hls' | 'iframe'
  url: string
  episode?: string
  /** 0–1 播放进度（HLS 才有；iframe 记 0） */
  progress: number
  updatedAt: number
}

export const WATCHLIST_KEY = 'acm.watch.watchlist.v1'
export const CONTINUE_KEY = 'acm.watch.continue.v1'
export const GROUPS_KEY = 'acm.watch.groups.v1'
export const TMDB_KEY = 'acm.watch.tmdb.v1'

export function loadWatchlist(): WatchItem[] {
  try {
    const v = JSON.parse(localStorage.getItem(WATCHLIST_KEY) ?? '[]')
    return Array.isArray(v) ? (v as WatchItem[]) : []
  } catch { return [] }
}

export function saveWatchlist(list: WatchItem[]): void {
  try { localStorage.setItem(WATCHLIST_KEY, JSON.stringify(list.slice(0, 500))) } catch { /* 忽略 */ }
}

export function loadContinue(): ContinueItem[] {
  try {
    const v = JSON.parse(localStorage.getItem(CONTINUE_KEY) ?? '[]')
    return Array.isArray(v) ? (v as ContinueItem[]) : []
  } catch { return [] }
}

export function saveContinue(list: ContinueItem[]): void {
  try { localStorage.setItem(CONTINUE_KEY, JSON.stringify(list.slice(0, 100))) } catch { /* 忽略 */ }
}

export function upsertContinue(item: ContinueItem): ContinueItem[] {
  const list = loadContinue().filter(x => x.id !== item.id)
  const next = [item, ...list].slice(0, 100)
  saveContinue(next)
  return next
}

export function loadClosedGroups(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(GROUPS_KEY) ?? '[]')
    return Array.isArray(v) ? (v as string[]) : []
  } catch { return [] }
}

export function saveClosedGroups(ids: string[]): void {
  try { localStorage.setItem(GROUPS_KEY, JSON.stringify(ids)) } catch { /* 忽略 */ }
}

// ---------------- TMDB（热门推荐）：Key 免费注册，加密存本机 ----------------

export async function saveTmdbKey(key: string, pwd: string): Promise<void> {
  const clean = key.trim()
  if (!clean) throw new Error('请先粘贴 TMDB API Key')
  if (!pwd) throw new Error('请先解锁保险箱，Key 要加密保存')
  const cipher = await encryptSecret(clean, pwd)
  try { localStorage.setItem(TMDB_KEY, JSON.stringify({ cipher })) } catch { /* 忽略 */ }
}

export function hasTmdbKey(): boolean {
  try { return !!JSON.parse(localStorage.getItem(TMDB_KEY) ?? 'null')?.cipher } catch { return false }
}

export async function loadTmdbKey(pwd: string): Promise<string | null> {
  try {
    const raw = JSON.parse(localStorage.getItem(TMDB_KEY) ?? 'null') as { cipher?: string } | null
    if (!raw?.cipher || !pwd) return null
    return await decryptSecret(raw.cipher, pwd)
  } catch { return null }
}

export function clearTmdbKey(): void {
  try { localStorage.removeItem(TMDB_KEY) } catch { /* 忽略 */ }
}

export interface TmdbTitle {
  id: number
  mediaType: 'tv' | 'movie'
  title: string
  originalTitle: string
  overview: string
  poster?: string
  firstDate?: string
  vote?: number
}

const TMDB_IMG = 'https://image.tmdb.org/t/p/w500'

interface TmdbApiItem {
  id?: number
  media_type?: string
  title?: string
  name?: string
  original_title?: string
  original_name?: string
  overview?: string
  poster_path?: string | null
  first_air_date?: string
  release_date?: string
  vote_average?: number
}

function toTmdbTitle(item: TmdbApiItem, fallbackType: 'tv' | 'movie'): TmdbTitle | null {
  if (!item?.id) return null
  const mediaType = item.media_type === 'movie' ? 'movie' : item.media_type === 'tv' ? 'tv' : fallbackType
  const title = item.title ?? item.name ?? ''
  if (!title) return null
  return {
    id: item.id,
    mediaType,
    title,
    originalTitle: item.original_title ?? item.original_name ?? '',
    overview: item.overview ?? '',
    poster: item.poster_path ? `${TMDB_IMG}${item.poster_path}` : undefined,
    firstDate: item.first_air_date ?? item.release_date ?? undefined,
    vote: typeof item.vote_average === 'number' ? Math.round(item.vote_average * 10) / 10 : undefined,
  }
}

async function tmdbGet(key: string, path: string): Promise<unknown> {
  const sep = path.includes('?') ? '&' : '?'
  const res = await fetch(`https://api.themoviedb.org/3${path}${sep}api_key=${encodeURIComponent(key)}&language=zh-CN`)
  if (!res.ok) throw new Error(`TMDB 接口返回 ${res.status}（Key 无效或被限流时会出现）`)
  return res.json()
}

/** 本周热门：剧集 + 电影各 20 条（需 Key；无 Key 时调用方直接不请求） */
export async function fetchTmdbTrending(key: string): Promise<TmdbTitle[]> {
  const [tv, movie] = await Promise.all([
    tmdbGet(key, '/trending/tv/week'),
    tmdbGet(key, '/trending/movie/week'),
  ])
  const items = [
    ...(((tv as { results?: TmdbApiItem[] }).results ?? []).map(i => toTmdbTitle(i, 'tv'))),
    ...(((movie as { results?: TmdbApiItem[] }).results ?? []).map(i => toTmdbTitle(i, 'movie'))),
  ]
  return items.filter((x): x is TmdbTitle => !!x).slice(0, 40)
}

/** 某部剧/电影在中国区的正版播出平台（TMDB watch/providers） */
export async function fetchTmdbProviders(key: string, mediaType: 'tv' | 'movie', id: number): Promise<{ name: string; link: string }[]> {
  const data = await tmdbGet(key, `/${mediaType}/${id}/watch/providers`)
  const cn = (data as { results?: Record<string, { link?: string; flatrate?: { provider_name?: string }[]; rent?: { provider_name?: string }[]; buy?: { provider_name?: string }[] }> }).results?.CN
  if (!cn) return []
  const names = [...(cn.flatrate ?? []), ...(cn.rent ?? []), ...(cn.buy ?? [])]
    .map(p => p.provider_name ?? '')
    .filter(Boolean)
  return [...new Set(names)].map(name => ({ name, link: cn.link ?? `https://www.themoviedb.org/${mediaType}/${id}/watch?locale=CN` }))
}
