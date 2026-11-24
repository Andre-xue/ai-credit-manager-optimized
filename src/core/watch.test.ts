import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import {
  parseM3u, parseM3uAsync, normalizeChannelName, contentKeyOf, stationOrigin,
  mergeChannels, groupChannels, fetchSourceSet, loadCountryChannels,
  isUnofficialStreamUrl, isChannelUnofficial,
  splitEpisode, channelsToVod, vodContinueId, parseVodContinueId,
  fetchTmdbTrending, loadRecPrefs, saveRecPrefs, REC_PREFS_KEY,
  probeStreamUrl, probeChannel, probeChannels, loadHealthCache, saveHealthCache,
  healthOf, healthCounts, applyHealthView,
  type HealthMap,
  normalizeTitleKey, regionLabelOfCountry, mapGenreNames,
  fetchTmdbGenres, searchTmdbTitle, fetchTmdbDetails,
  buildVodWallItems, filterVodWall, sortVodWall, vodWallBadge,
  type VodTitle, type TmdbTitle,
  PLAYLIST_CACHE_KEY, CUSTOM_SOURCES_KEY,
  type LiveChannel, type SourceSet,
} from './watch'

// node 环境没有 localStorage：watch.ts 的缓存/自定义源读写需要它（与 freeGames 测试同款 mock）
if (!(globalThis as unknown as Record<string, unknown>).localStorage) {
  const m = new Map<string, string>()
  ;(globalThis as unknown as Record<string, unknown>).localStorage = {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, v) },
    removeItem: (k: string) => { m.delete(k) },
    clear: () => m.clear(),
  }
}
const ls = () => (globalThis as unknown as { localStorage: { getItem(k: string): string | null; setItem(k: string, v: string): void; clear(): void } }).localStorage

beforeEach(() => { ls().clear() })

const CN_FIXTURE = `#EXTM3U
#EXTINF:-1 tvg-id="CCTV1.cn" tvg-logo="https://x/logo.png" group-title="General",CCTV-1 (720p)
http://example.com/cctv1.m3u8
#EXTINF:-1 tvg-id="HunanTV.cn" group-title="Entertainment",湖南卫视
http://example.com/hunan.m3u8
#EXTINF:-1 tvg-id="News1" group-title="News",Test News
http://example.com/news.m3u8
#EXTINF:-1 tvg-id="Bad" group-title="News",坏台
not-a-url
`

const FREETV_FIXTURE = `#EXTM3U
#EXTINF:-1 tvg-name="CCTV-1" tvg-country="CN" group-title="China",CCTV-1
http://example.com/cctv1-alt.m3u8
#EXTINF:-1 tvg-name="BBC One" tvg-country="GB" group-title="UK",BBC One
http://example.com/bbc1.m3u8
`

afterEach(() => { vi.unstubAllGlobals() })

describe('watch.parseM3u', () => {
  it('解析条目、去掉坏地址行', () => {
    const entries = parseM3u(CN_FIXTURE)
    expect(entries).toHaveLength(3)
    expect(entries[0].name).toBe('CCTV-1 (720p)')
    expect(entries[0].logo).toBe('https://x/logo.png')
    expect(entries[0].groupTitle).toBe('General')
    expect(entries[0].url).toBe('http://example.com/cctv1.m3u8')
  })
  it('parseM3uAsync（分片解析）与同步版结果一致', async () => {
    expect(await parseM3uAsync(CN_FIXTURE)).toEqual(parseM3u(CN_FIXTURE))
  })
})

describe('watch.normalizeChannelName', () => {
  it('去分辨率后缀、统一小写', () => {
    expect(normalizeChannelName('CCTV-1 (720p)')).toBe('cctv-1')
    expect(normalizeChannelName('BBC One HD')).toBe('bbc one')
    expect(normalizeChannelName('湖南卫视')).toBe('湖南卫视')
  })
})

describe('watch.contentKeyOf', () => {
  it('News→news；General/Undefined/未知→other；多值取首个', () => {
    expect(contentKeyOf('News')).toBe('news')
    expect(contentKeyOf('General')).toBe('other')
    expect(contentKeyOf('Undefined')).toBe('other')
    expect(contentKeyOf('')).toBe('other')
    expect(contentKeyOf('Animation;Kids')).toBe('animation')
    expect(contentKeyOf('Movies')).toBe('movies')
    expect(contentKeyOf('WhateverWeird')).toBe('other')
  })
})

describe('watch.isUnofficialStreamUrl（v0.1.387 来源标注）', () => {
  it('裸 IP 直连（http/https、带端口）→ 未授权转播', () => {
    expect(isUnofficialStreamUrl('http://74.91.26.218:82/live/cctv1hd.m3u8')).toBe(true)
    expect(isUnofficialStreamUrl('https://69.30.245.50/live/x.m3u8')).toBe(true)
    expect(isUnofficialStreamUrl('http://38.75.136.137:98/live/cctv.m3u8')).toBe(true)
    expect(isUnofficialStreamUrl('http://1.2.3.4/a.m3u8')).toBe(true)
  })
  it('官方域名 → 不是未授权转播', () => {
    expect(isUnofficialStreamUrl('https://cd-live-stream.news.cctvplus.com/live/cctv.m3u8')).toBe(false)
    expect(isUnofficialStreamUrl('http://example.com/cctv1.m3u8')).toBe(false)
    expect(isUnofficialStreamUrl('https://live.jxgdw.com/hd.m3u8')).toBe(false)
  })
  it('IPv6 字面量 → 未授权转播；非法地址/空串 → false', () => {
    expect(isUnofficialStreamUrl('https://[2001:db8::1]/x.m3u8')).toBe(true)
    expect(isUnofficialStreamUrl('not-a-url')).toBe(false)
    expect(isUnofficialStreamUrl('')).toBe(false)
  })
})

describe('watch 来源标记：解析与合并时按主源打标记', () => {
  const IP_FIXTURE = `#EXTM3U
#EXTINF:-1 tvg-id="CCTV1" group-title="General",CCTV-1
http://74.91.26.218:82/live/cctv1hd.m3u8
#EXTINF:-1 tvg-id="CCTVPlus" group-title="News",CCTV+
https://cd-live-stream.news.cctvplus.com/live/cctvplus.m3u8
`
  it('解析时：IP 流打标记，官方域名不打', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, text: async () => IP_FIXTURE }))
    const set: SourceSet = { id: 'iptv-cn', label: 'iptv-org · 中国', url: 'https://example.com/cn.m3u', country: 'CN' }
    const { channels } = await fetchSourceSet(set)
    const cctv1 = channels.find(c => c.key === 'cctv-1')
    const plus = channels.find(c => c.key === 'cctv+')
    expect(cctv1?.unofficial).toBe(true)
    expect(plus?.unofficial).toBe(false)
  })
  it('合并后：标记跟合并后的主源走；自定义源同样按规则打标记', async () => {
    ls().setItem(CUSTOM_SOURCES_KEY, JSON.stringify([{ id: 'my1', label: '我的源', url: 'https://example.com/my.m3u', addedAt: 1 }]))
    vi.stubGlobal('fetch', async (url: unknown) => {
      const u = String(url)
      if (u.includes('countries/cn.m3u')) return { ok: true, text: async () => IP_FIXTURE }
      if (u.includes('Free-TV')) return { ok: true, text: async () => FREETV_FIXTURE }
      if (u.includes('my.m3u')) return { ok: true, text: async () => '#EXTM3U\n#EXTINF:-1 group-title="News",我的收藏台\nhttp://69.30.245.50/live/my.m3u8\n' }
      return { ok: false, status: 404, text: async () => '' }
    })
    const { channels } = await loadCountryChannels('CN')
    // CCTV-1：iptv-org 给 IP 地址、Free-TV 给域名——主源是 iptv-org 的 IP，仍标记
    expect(channels.find(c => c.key === 'cctv-1')?.unofficial).toBe(true)
    expect(isChannelUnofficial(channels.find(c => c.key === 'cctv-1')!)).toBe(true)
    // 自定义源粘的 IP 流同样标记
    const mine = channels.find(c => c.name === '我的收藏台')
    expect(mine?.unofficial).toBe(true)
    // 旧缓存缺 unofficial 字段时按 urls[0] 兜底判定
    expect(isChannelUnofficial({ key: 'x', name: 'X', content: 'other', country: 'CN', urls: ['http://74.91.26.218:82/live/x.m3u8'], sourceIds: ['iptv-cn'] })).toBe(true)
    expect(isChannelUnofficial({ key: 'y', name: 'Y', content: 'other', country: 'CN', urls: ['https://cd-live-stream.news.cctvplus.com/live/y.m3u8'], sourceIds: ['iptv-cn'] })).toBe(false)
  })
})

describe('watch.stationOrigin', () => {
  it('CCTV 开头→央视；卫视结尾或省级英文名→卫视；其余→其他', () => {
    expect(stationOrigin('CCTV-1')).toBe('cctv')
    expect(stationOrigin('cctv-5+')).toBe('cctv')
    expect(stationOrigin('湖南卫视')).toBe('satellite')
    expect(stationOrigin('Hunan TV')).toBe('satellite')
    expect(stationOrigin('Anhui TV')).toBe('satellite')
    expect(stationOrigin('Dragon TV')).toBe('satellite')
    expect(stationOrigin('BBC One')).toBe('other')
    expect(stationOrigin('ABN China')).toBe('other')
  })
})

describe('watch.mergeChannels', () => {
  it('同名合并播放地址并去重', () => {
    const a: LiveChannel = { key: 'cctv-1', name: 'CCTV-1', content: 'other', country: 'CN', urls: ['http://a/1.m3u8'], sourceIds: ['iptv-cn'] }
    const b: LiveChannel = { key: 'cctv-1', name: 'CCTV-1', content: 'news', country: 'CN', urls: ['http://b/1.m3u8', 'http://a/1.m3u8'], sourceIds: ['freetv'] }
    const merged = mergeChannels([[a], [b]])
    expect(merged).toHaveLength(1)
    expect(merged[0].urls).toEqual(['http://a/1.m3u8', 'http://b/1.m3u8'])
    expect(merged[0].sourceIds).toEqual(['iptv-cn', 'freetv'])
    expect(merged[0].content).toBe('news')
  })
})

describe('watch.groupChannels', () => {
  it('中国按央视/卫视/其他分；外国只有“全部”一组', () => {
    const channels: LiveChannel[] = [
      { key: 'cctv-1', name: 'CCTV-1', content: 'news', country: 'CN', urls: ['http://a'], sourceIds: ['iptv-cn'] },
      { key: '湖南卫视', name: '湖南卫视', content: 'entertainment', country: 'CN', urls: ['http://b'], sourceIds: ['iptv-cn'] },
      { key: 'test', name: 'Test News', content: 'news', country: 'CN', urls: ['http://c'], sourceIds: ['iptv-cn'] },
    ]
    const cn = groupChannels(channels, 'CN')
    expect(cn.origins.map(g => g.key)).toEqual(['cctv', 'satellite', 'other'])
    expect(cn.origins[0].channels).toHaveLength(1)
    expect(cn.contents).toContain('news')
    const us = groupChannels(channels, 'US')
    expect(us.origins).toHaveLength(1)
    expect(us.origins[0].key).toBe('other')
  })
})

describe('watch.fetchSourceSet', () => {
  it('网络失败返回 ok:false 与中文原因，不抛错、不含 Load failed', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('Load failed') })
    const set: SourceSet = { id: 'iptv-cn', label: 'iptv-org · 中国', url: 'https://example.com/cn.m3u', country: 'CN' }
    const { channels, result } = await fetchSourceSet(set)
    expect(channels).toEqual([])
    expect(result.ok).toBe(false)
    expect(result.error ?? '').toContain('换个节点')
    expect(result.error ?? '').not.toContain('Load failed')
  })
  it('非 200 返回中文原因', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 403, text: async () => '' }))
    const set: SourceSet = { id: 'iptv-cn', label: 'iptv-org · 中国', url: 'https://example.com/cn.m3u', country: 'CN' }
    const { result } = await fetchSourceSet(set)
    expect(result.ok).toBe(false)
    expect(result.error ?? '').toContain('403')
  })
})

describe('watch.loadCountryChannels', () => {
  it('多套源并行拉取：同名频道合并地址，失败的套不阻塞其他套', async () => {
    vi.stubGlobal('fetch', async (url: unknown) => {
      const u = String(url)
      if (u.includes('countries/cn.m3u')) return { ok: true, text: async () => CN_FIXTURE }
      if (u.includes('Free-TV')) return { ok: true, text: async () => FREETV_FIXTURE }
      return { ok: false, status: 404, text: async () => '' }
    })
    const { channels, sets } = await loadCountryChannels('CN')
    const cctv = channels.find(c => c.key === 'cctv-1')
    expect(cctv).toBeDefined()
    // iptv-org 与 Free-TV 两套都给了 CCTV-1：自动合并成 2 个备用地址
    expect(cctv!.urls).toHaveLength(2)
    expect(cctv!.urls).toContain('http://example.com/cctv1.m3u8')
    expect(cctv!.urls).toContain('http://example.com/cctv1-alt.m3u8')
    // Free-TV 的 BBC One 不属于中国组，不应混进来
    expect(channels.find(c => c.key === 'bbc one')).toBeUndefined()
    // 湖南卫视在列
    expect(channels.find(c => c.name === '湖南卫视')).toBeDefined()
    expect(sets.find(s => s.setId === 'iptv-cn')?.ok).toBe(true)
    expect(sets.find(s => s.setId === 'freetv')?.ok).toBe(true)
  })
  it('自定义源里没写 tvg-country 的台也归入当前国家', async () => {
    ls().setItem(CUSTOM_SOURCES_KEY, JSON.stringify([{ id: 'my1', label: '我的源', url: 'https://example.com/my.m3u', addedAt: 1 }]))
    vi.stubGlobal('fetch', async (url: unknown) => {
      const u = String(url)
      if (u.includes('countries/cn.m3u')) return { ok: true, text: async () => CN_FIXTURE }
      if (u.includes('Free-TV')) return { ok: true, text: async () => FREETV_FIXTURE }
      if (u.includes('my.m3u')) return { ok: true, text: async () => '#EXTM3U\n#EXTINF:-1 group-title="News",我的收藏台\nhttp://example.com/my1.m3u8\n' }
      return { ok: false, status: 404, text: async () => '' }
    })
    const { channels } = await loadCountryChannels('CN')
    expect(channels.find(c => c.name === '我的收藏台')).toBeDefined()
  })
})

// 性能（v0.1.386 追加）：播放列表缓存 24 小时，24 小时内不重新拉
describe('watch.fetchSourceSet 缓存', () => {
  const SET: SourceSet = { id: 'iptv-cn', label: 'iptv-org · 中国', url: 'https://example.com/cn.m3u', country: 'CN' }
  it('24 小时内第二次直接读缓存，不再发请求', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => { calls++; return { ok: true, text: async () => CN_FIXTURE } })
    const first = await fetchSourceSet(SET)
    expect(first.result.ok).toBe(true)
    expect(calls).toBe(1)
    const second = await fetchSourceSet(SET)
    expect(calls).toBe(1)
    expect(second.result.cached).toBe(true)
    expect(second.channels).toHaveLength(3)
  })
  it('缓存超过 24 小时重新拉；force 同样重新拉', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => { calls++; return { ok: true, text: async () => CN_FIXTURE } })
    await fetchSourceSet(SET)
    const raw = JSON.parse(ls().getItem(PLAYLIST_CACHE_KEY)!) as Record<string, { at: number }>
    raw['iptv-cn'].at = Date.now() - 25 * 3600_000
    ls().setItem(PLAYLIST_CACHE_KEY, JSON.stringify(raw))
    await fetchSourceSet(SET)
    expect(calls).toBe(2)
    await fetchSourceSet(SET, { force: true })
    expect(calls).toBe(3)
  })
})

// 视频点播（v0.1.390）：m3u 点播条目单独成区，同名剧集多条合并带选集，看到一半记进度续播
describe('watch.splitEpisode', () => {
  it('第N集 / S01E03 / 末尾 E05 都能拆出集号与干净标题', () => {
    expect(splitEpisode('庆余年 第01集')).toEqual({ title: '庆余年', episodeNo: 1 })
    expect(splitEpisode('庆余年 第12集 (1080p)')).toEqual({ title: '庆余年', episodeNo: 12 })
    expect(splitEpisode('庆余年 S01E03')).toEqual({ title: '庆余年', episodeNo: 3 })
    expect(splitEpisode('Show Name E05')).toEqual({ title: 'Show Name', episodeNo: 5 })
  })
  it('无集号标记 → episodeNo null；末尾孤数字不认（“流浪地球 2”是电影不是第 2 集）', () => {
    expect(splitEpisode('流浪地球2')).toEqual({ title: '流浪地球2', episodeNo: null })
    expect(splitEpisode('流浪地球 2')).toEqual({ title: '流浪地球 2', episodeNo: null })
    expect(splitEpisode('速度与激情 9')).toEqual({ title: '速度与激情 9', episodeNo: null })
  })
})

const VOD_FIXTURE = `#EXTM3U
#EXTINF:-1 group-title="Movies",流浪地球2
https://cdn.example.com/movies/liulang2.mp4
#EXTINF:-1 group-title="Series",庆余年 第01集
https://cdn.example.com/series/qyn01.mp4
#EXTINF:-1 group-title="Series",庆余年 第02集
https://cdn.example.com/series/qyn02.mp4
#EXTINF:-1 group-title="Series",庆余年 S01E03
https://cdn.example.com/series/qyn03.mkv
#EXTINF:-1 group-title="Movies",CCTV-6 电影
http://example.com/cctv6.m3u8
#EXTINF:-1 group-title="Movies",盗版电影
http://74.91.26.218:82/vod/pirate.mp4
#EXTINF:-1 group-title="News",新闻台
http://example.com/news.m3u8
`

describe('watch.channelsToVod（v0.1.390 点播识别/选集）', () => {
  it('mp4/mkv 按点播算；同名剧集多条合并、集号排序；单条无集号为电影', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, text: async () => VOD_FIXTURE }))
    const set: SourceSet = { id: 'custom-vod', label: '测试点播源', url: 'https://example.com/vod.m3u', country: 'WORLD' }
    const { channels } = await fetchSourceSet(set)
    const vod = channelsToVod(channels)
    expect(vod.map(v => v.title)).toEqual(['盗版电影', '流浪地球2', '庆余年'])
    const qyn = vod.find(v => v.title === '庆余年')!
    expect(qyn.kind).toBe('series')
    expect(qyn.episodes.map(e => e.label)).toEqual(['第 1 集', '第 2 集', '第 3 集'])
    expect(qyn.episodes.map(e => e.episodeNo)).toEqual([1, 2, 3])
    const movie = vod.find(v => v.title === '流浪地球2')!
    expect(movie.kind).toBe('movie')
    expect(movie.episodes).toHaveLength(1)
    expect(movie.episodes[0].label).toBe('正片')
  })
  it('m3u8 永远算直播：CCTV-6 电影（group-title Movies + m3u8）不进点播；新闻台不进点播', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, text: async () => VOD_FIXTURE }))
    const set: SourceSet = { id: 'custom-vod', label: '测试点播源', url: 'https://example.com/vod.m3u', country: 'WORLD' }
    const { channels } = await fetchSourceSet(set)
    const vod = channelsToVod(channels)
    expect(vod.find(v => v.title.includes('CCTV-6'))).toBeUndefined()
    expect(vod.find(v => v.title === '新闻台')).toBeUndefined()
  })
  it('点播同样打「未授权转播」标记：裸 IP 的 mp4 标 unofficial，域名不标', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, text: async () => VOD_FIXTURE }))
    const set: SourceSet = { id: 'custom-vod', label: '测试点播源', url: 'https://example.com/vod.m3u', country: 'WORLD' }
    const { channels } = await fetchSourceSet(set)
    const vod = channelsToVod(channels)
    expect(vod.find(v => v.title === '盗版电影')?.unofficial).toBe(true)
    expect(vod.find(v => v.title === '流浪地球2')?.unofficial).toBe(false)
  })
})

describe('watch.loadCountryChannels 点播与直播拆分', () => {
  it('自定义源里的点播进 vod、直播列表里不再出现；内置直播台不受影响', async () => {
    ls().setItem(CUSTOM_SOURCES_KEY, JSON.stringify([{ id: 'vod1', label: '测试点播源', url: 'https://example.com/vod.m3u', addedAt: 1 }]))
    vi.stubGlobal('fetch', async (url: unknown) => {
      const u = String(url)
      if (u.includes('countries/cn.m3u')) return { ok: true, text: async () => CN_FIXTURE }
      if (u.includes('Free-TV')) return { ok: true, text: async () => FREETV_FIXTURE }
      if (u.includes('vod.m3u')) return { ok: true, text: async () => VOD_FIXTURE }
      return { ok: false, status: 404, text: async () => '' }
    })
    const { channels, vod } = await loadCountryChannels('CN')
    expect(vod.map(v => v.title)).toEqual(['盗版电影', '流浪地球2', '庆余年'])
    // 点播条目不留在直播列表里（否则直播播放器播 mp4 会失败）
    expect(channels.find(c => c.name === '流浪地球2')).toBeUndefined()
    expect(channels.find(c => c.name.startsWith('庆余年'))).toBeUndefined()
    // CCTV-6 电影是 m3u8 直播，留在直播列表
    expect(channels.find(c => c.name === 'CCTV-6 电影')).toBeDefined()
    // 内置直播台照常
    expect(channels.find(c => c.key === 'cctv-1')).toBeDefined()
  })
  it('无点播源时 vod 为空数组', async () => {
    vi.stubGlobal('fetch', async (url: unknown) => {
      const u = String(url)
      if (u.includes('countries/cn.m3u')) return { ok: true, text: async () => CN_FIXTURE }
      if (u.includes('Free-TV')) return { ok: true, text: async () => FREETV_FIXTURE }
      return { ok: false, status: 404, text: async () => '' }
    })
    const { vod } = await loadCountryChannels('CN')
    expect(vod).toEqual([])
  })
})

describe('watch 点播续播 id（v0.1.390）', () => {
  it('vodContinueId / parseVodContinueId 往返；标题 key 含冒号时按最后一个冒号切', () => {
    expect(vodContinueId('庆余年', 1)).toBe('vod:庆余年:1')
    expect(parseVodContinueId('vod:庆余年:1')).toEqual({ vodKey: '庆余年', episodeIndex: 1 })
    expect(parseVodContinueId('vod:star wars: episode i:0')).toEqual({ vodKey: 'star wars: episode i', episodeIndex: 0 })
    expect(parseVodContinueId('live:cctv-1')).toBeNull()
    expect(parseVodContinueId('vod:bad')).toBeNull()
  })
})

describe('watch 短剧专区已移除（v0.1.390）', () => {
  it('WatchTool.tsx 里不再有 SHORT_PLATFORMS 与“短剧专区”', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../components/WatchTool.tsx', import.meta.url), 'utf8')
    expect(src).not.toContain('SHORT_PLATFORMS')
    expect(src).not.toContain('短剧专区')
    expect(src).not.toContain('hongguoduanju.com')
    expect(src).not.toContain('microsite/wetheater')
    // 删的是专区不是全部短剧：AI 找剧仍可搜短剧、片单仍有短剧类型、央视 iframe 入口还在
    expect(src).toContain('tv.cctv.com/live/')
    expect(src).toContain("option value=\"short\"")
  })
})

// 横向标题（v0.1.394）：TMDB 热门范围 + 推荐偏好存取；内容页签不再放设置输入框
describe('watch.fetchTmdbTrending 范围（v0.1.394）', () => {
  const tmdbPage = (items: unknown[]) => ({ ok: true, json: async () => ({ results: items }) })
  const tvItem = { id: 1, media_type: 'tv', name: '示例剧集', overview: '', vote_average: 8.4 }
  const movieItem = { id: 2, media_type: 'movie', title: '示例电影', overview: '', vote_average: 8.1 }
  it('默认走 trending/week（老行为不变）', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (u: unknown) => { urls.push(String(u)); return tmdbPage([tvItem, movieItem]) })
    const list = await fetchTmdbTrending('KEY')
    expect(list).toHaveLength(4)
    expect(urls.some(u => u.includes('/trending/tv/week'))).toBe(true)
    expect(urls.some(u => u.includes('/trending/movie/week'))).toBe(true)
  })
  it("'day' 走 trending/day", async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (u: unknown) => { urls.push(String(u)); return tmdbPage([tvItem]) })
    await fetchTmdbTrending('KEY', 'day')
    expect(urls.some(u => u.includes('/trending/tv/day'))).toBe(true)
    expect(urls.some(u => u.includes('/trending/movie/day'))).toBe(true)
  })
  it("'top' 走 discover 按评分倒序（vote_count ≥ 300），无 media_type 时按端点补类型", async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (u: unknown) => {
      urls.push(String(u))
      return tmdbPage([{ id: 3, title: '高分片', overview: '', vote_average: 9.2 }])
    })
    const list = await fetchTmdbTrending('KEY', 'top')
    expect(urls.some(u => u.includes('/discover/tv?sort_by=vote_average.desc&vote_count.gte=300'))).toBe(true)
    expect(urls.some(u => u.includes('/discover/movie?sort_by=vote_average.desc&vote_count.gte=300'))).toBe(true)
    expect(list[0].mediaType).toBe('tv')
    expect(list[1].mediaType).toBe('movie')
    expect(list[0].vote).toBe(9.2)
  })
  it('非 200 抛中文错', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 401, json: async () => ({}) }))
    await expect(fetchTmdbTrending('BAD')).rejects.toThrow('401')
  })
})

describe('watch 推荐偏好（v0.1.394）', () => {
  it('默认 本周热门 + 剧集电影；非法值回落默认', () => {
    expect(loadRecPrefs()).toEqual({ range: 'week', type: 'all' })
    ls().setItem(REC_PREFS_KEY, JSON.stringify({ range: 'nope', type: 'short' }))
    expect(loadRecPrefs()).toEqual({ range: 'week', type: 'all' })
  })
  it('保存后读回一致', () => {
    saveRecPrefs({ range: 'top', type: 'tv' })
    expect(loadRecPrefs()).toEqual({ range: 'top', type: 'tv' })
    saveRecPrefs({ range: 'day', type: 'movie' })
    expect(loadRecPrefs()).toEqual({ range: 'day', type: 'movie' })
  })
})

describe('watch 看剧横向标题（v0.1.394）', () => {
  it('WatchTool.tsx：七个页签在、AI 找剧收进搜索图标、设置输入框只在设置页签', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../components/WatchTool.tsx', import.meta.url), 'utf8')
    // 页签：七个标题 + 切换入口都在
    const tabs: [string, string][] = [
      ['trending', '热门推荐'], ['continue', '继续观看'], ['live', '直播'],
      ['vod', '点播'], ['calendar', '追剧日历'], ['watchlist', '我的片单'], ['settings', '设置'],
    ]
    for (const [id, title] of tabs) {
      expect(src).toContain(`setActiveTab('${id}')`)
      expect(src).toContain(`>${title}`)
    }
    expect(src).toContain("activeTab === 'settings'")
    // AI 找剧不再是分区标题：无 Section id="ai"，搜索图标 + 面板 + Esc 收起
    expect(src).not.toContain('id="ai"')
    expect(src).toContain("title=\"AI 找剧\"")
    expect(src).toContain("key === 'Escape'")
    // 热门页签不再放 TMDB Key 输入框，只有去设置页签的链接按钮
    expect(src).toContain('去「设置」页签填 Key')
    // 设置页签四段齐全
    for (const s of ['自定义直播源', '自定义点播源', 'TMDB API Key', '推荐设置']) {
      expect(src).toContain(s)
    }
    // 推荐设置三组控件齐全
    for (const s of ['本周热门', '今日热门', '高分精选', '剧集 + 电影', '只看剧集', '只看电影', '找剧模型']) {
      expect(src).toContain(s)
    }
  })
  it('styles.css：--accent 已定义（否则 .wt-chip.on 选中态白字透明底、看不见选中项）', async () => {
    const { readFileSync } = await import('node:fs')
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
    expect(css).toMatch(/--accent:\s*#[0-9a-f]{6}/i)
  })
})

describe('watch.normalizeTitleKey（v0.1.395 海报墙片名匹配）', () => {
  it('去空格标点、转小写', () => {
    expect(normalizeTitleKey('庆余年 第 2 集')).toBe('庆余年第2集')
    expect(normalizeTitleKey('Dune: Part Two')).toBe('duneparttwo')
    expect(normalizeTitleKey('流浪地球 2')).toBe('流浪地球2')
  })
})

describe('watch.mapGenreNames（v0.1.395 类型映射到墙上 16 类）', () => {
  it('直接映射 + 家庭/历史归剧情 + 西部归动作', () => {
    expect(mapGenreNames(['科幻', '冒险'])).toEqual(['科幻', '冒险'])
    expect(mapGenreNames(['家庭', '历史', '音乐', '电视电影'])).toEqual(['剧情'])
    expect(mapGenreNames(['西部'])).toEqual(['动作'])
  })
  it('中文原声动作片多一个「武侠」', () => {
    expect(mapGenreNames(['动作'], 'zh')).toContain('武侠')
    expect(mapGenreNames(['动作'], 'en')).not.toContain('武侠')
    expect(mapGenreNames(['剧情'], 'zh')).not.toContain('武侠')
  })
  it('未知类型名直接丢掉，不编造', () => {
    expect(mapGenreNames(['不存在的类型'])).toEqual([])
  })
})

describe('watch.regionLabelOfCountry（v0.1.395 地区）', () => {
  it('CN/HK/TW/US/JP/KR/GB 映射，其余 undefined', () => {
    expect(regionLabelOfCountry('CN')).toBe('大陆')
    expect(regionLabelOfCountry('HK')).toBe('香港')
    expect(regionLabelOfCountry('TW')).toBe('台湾')
    expect(regionLabelOfCountry('US')).toBe('美国')
    expect(regionLabelOfCountry('JP')).toBe('日本')
    expect(regionLabelOfCountry('KR')).toBe('韩国')
    expect(regionLabelOfCountry('GB')).toBe('英国')
    expect(regionLabelOfCountry('FR')).toBeUndefined()
    expect(regionLabelOfCountry(undefined)).toBeUndefined()
  })
})

const VOD_WALL_VOD: VodTitle[] = [
  { key: '流浪地球2', title: '流浪地球2', kind: 'movie', episodes: [{ label: '正片', urls: ['https://x/a.mp4', 'https://x/b.mp4'], episodeNo: 0, unofficial: false }], sourceIds: ['custom-1'], unofficial: false },
  { key: '庆余年', title: '庆余年', kind: 'series', episodes: [
    { label: '第 1 集', urls: ['https://x/q1.mp4'], episodeNo: 1, unofficial: false },
    { label: '第 2 集', urls: ['https://x/q2.mp4'], episodeNo: 2, unofficial: false },
  ], sourceIds: ['custom-1'], unofficial: false },
]
const VOD_WALL_TRENDING: TmdbTitle[] = [
  { id: 1, mediaType: 'movie', title: '流浪地球2', originalTitle: 'The Wandering Earth II', overview: '太阳即将毁灭', poster: 'https://img/w.jpg', firstDate: '2023-01-22', vote: 7.9, genreIds: [878, 12], originalLanguage: 'zh', popularity: 90 },
  { id: 2, mediaType: 'movie', title: '奥本海默', originalTitle: 'Oppenheimer', overview: '原子弹之父', poster: 'https://img/o.jpg', firstDate: '2023-07-21', vote: 8.3, genreIds: [18], originalLanguage: 'en', popularity: 80 },
  { id: 3, mediaType: 'tv', title: '繁花', originalTitle: 'Blossoms Shanghai', overview: '九十年代上海', poster: 'https://img/f.jpg', firstDate: '2023-12-27', vote: 8.7, genreIds: [18], originCountry: ['CN'], originalLanguage: 'zh', popularity: 70 },
]
const VOD_WALL_GENRES = { movie: { 878: '科幻', 12: '冒险', 18: '剧情' }, tv: { 18: '剧情' } }

describe('watch.buildVodWallItems（v0.1.395 拼墙）', () => {
  it('点播全进墙（有源可播），热门里没匹配上的也进墙（仅展示），同名只留一部', () => {
    const items = buildVodWallItems(VOD_WALL_VOD, VOD_WALL_TRENDING, {}, VOD_WALL_GENRES)
    expect(items).toHaveLength(4) // 流浪地球2、庆余年、奥本海默、繁花
    const wle = items.find(i => i.title === '流浪地球2')!
    expect(wle.playable).toBe(true)
    expect(wle.sourceCount).toBe(2)
    expect(wle.tmdb?.vote).toBe(7.9)
    expect(wle.genres).toEqual(['科幻', '冒险'])
    const opp = items.find(i => i.title === '奥本海默')!
    expect(opp.playable).toBe(false)
    expect(opp.sourceCount).toBe(0)
    expect(opp.genres).toEqual(['剧情'])
    const qyn = items.find(i => i.title === '庆余年')!
    expect(qyn.playable).toBe(true)
    expect(qyn.kind).toBe('series')
    expect(qyn.totalEps).toBe(2)
    const fh = items.find(i => i.title === '繁花')!
    expect(fh.region).toBe('大陆')
  })
  it('没 TMDB 元数据的点播只显示片名卡片，不编造海报评分', () => {
    const items = buildVodWallItems(VOD_WALL_VOD, [], {}, null)
    const qyn = items.find(i => i.title === '庆余年')!
    expect(qyn.poster).toBeUndefined()
    expect(qyn.vote).toBeUndefined()
    expect(qyn.genres).toEqual([])
    expect(qyn.status).toBe('unknown')
  })
  it('详情补上状态与集数：更新中给更新至N集，已完结给全N集', () => {
    const enrich = {
      '庆余年': { tmdb: { id: 9, mediaType: 'tv' as const, title: '庆余年', originalTitle: '', overview: '', firstDate: '2024-05-16', vote: 7.6 }, details: { genres: ['剧情'], region: '大陆', status: 'up' as const, episodes: 36, lastDate: '2024-06-03' } },
    }
    const items = buildVodWallItems(VOD_WALL_VOD, [], enrich, VOD_WALL_GENRES)
    const qyn = items.find(i => i.title === '庆余年')!
    expect(qyn.status).toBe('up')
    expect(qyn.curEp).toBe(36)
    expect(qyn.totalEps).toBe(36)
    expect(qyn.region).toBe('大陆')
  })
})

describe('watch.filterVodWall / sortVodWall（v0.1.395 筛选排序）', () => {
  const items = buildVodWallItems(VOD_WALL_VOD, VOD_WALL_TRENDING, {}, VOD_WALL_GENRES)
  it('类型筛：科幻只剩流浪地球2；没元数据的庆余年只在「全部」出现', () => {
    expect(filterVodWall(items, { genre: '科幻', year: '全部', region: '全部', status: 'all' }).map(i => i.title)).toEqual(['流浪地球2'])
    expect(filterVodWall(items, { genre: '剧情', year: '全部', region: '全部', status: 'all' }).map(i => i.title)).toEqual(['奥本海默', '繁花'])
  })
  it('年份筛：2023 只剩有日期的；更早为空', () => {
    expect(filterVodWall(items, { genre: '全部', year: '2023', region: '全部', status: 'all' }).map(i => i.title)).toEqual(['流浪地球2', '奥本海默', '繁花'])
    expect(filterVodWall(items, { genre: '全部', year: '更早', region: '全部', status: 'all' })).toHaveLength(0)
  })
  it('地区筛：大陆只剩繁花（剧集 origin_country），电影没详情时不进地区筛', () => {
    expect(filterVodWall(items, { genre: '全部', year: '全部', region: '大陆', status: 'all' }).map(i => i.title)).toEqual(['繁花'])
  })
  it('状态筛：有源可播 2 部，仅展示 2 部', () => {
    expect(filterVodWall(items, { genre: '全部', year: '全部', region: '全部', status: 'play' })).toHaveLength(2)
    expect(filterVodWall(items, { genre: '全部', year: '全部', region: '全部', status: 'none' })).toHaveLength(2)
    expect(filterVodWall(items, { genre: '全部', year: '全部', region: '全部', status: 'up' })).toHaveLength(0)
  })
  it('排序：评分最高按 vote 倒序（没评分沉底）；年份最新按年倒序', () => {
    expect(sortVodWall(items, 'rating').map(i => i.title)).toEqual(['繁花', '奥本海默', '流浪地球2', '庆余年'])
    expect(sortVodWall(items, 'year')[0].title).toBe('繁花')
    expect(sortVodWall(items, 'updated')[0].title).toBe('繁花')
  })
})

describe('watch.vodWallBadge（v0.1.395 卡片角标）', () => {
  it('电影永远「更新HD」；没状态的剧集只写「共N集」，不谎称完结', () => {
    const items = buildVodWallItems(VOD_WALL_VOD, VOD_WALL_TRENDING, {}, VOD_WALL_GENRES)
    expect(vodWallBadge(items.find(i => i.title === '流浪地球2')!)).toEqual({ cls: 'hd', text: '更新HD' })
    expect(vodWallBadge(items.find(i => i.title === '奥本海默')!)).toEqual({ cls: 'hd', text: '更新HD' })
    expect(vodWallBadge(items.find(i => i.title === '庆余年')!)).toEqual({ cls: 'plain', text: '共2集' })
  })
  it('更新中「更新至N集」，已完结「全N集·完结」', () => {
    const up = buildVodWallItems(VOD_WALL_VOD, [], { '庆余年': { details: { genres: [], status: 'up', episodes: 18 } } }, VOD_WALL_GENRES)
    expect(vodWallBadge(up.find(i => i.title === '庆余年')!)).toEqual({ cls: 'up', text: '更新至18集' })
    const done = buildVodWallItems(VOD_WALL_VOD, [], { '庆余年': { details: { genres: [], status: 'done', episodes: 36 } } }, VOD_WALL_GENRES)
    expect(vodWallBadge(done.find(i => i.title === '庆余年')!)).toEqual({ cls: 'done', text: '全36集 · 完结' })
  })
})

describe('watch.fetchTmdbGenres / searchTmdbTitle / fetchTmdbDetails（v0.1.395 TMDB 补全）', () => {
  it('类型列表拉一次后缓存，第二次不请求', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async (u: unknown) => {
      calls++
      const url = String(u)
      if (url.includes('/genre/movie/list')) return { ok: true, json: async () => ({ genres: [{ id: 28, name: '动作' }] }) }
      if (url.includes('/genre/tv/list')) return { ok: true, json: async () => ({ genres: [{ id: 18, name: '剧情' }] }) }
      throw new Error('unexpected ' + url)
    })
    const first = await fetchTmdbGenres('KEY')
    expect(first.movie[28]).toBe('动作')
    expect(first.tv[18]).toBe('剧情')
    const second = await fetchTmdbGenres('KEY')
    expect(second).toEqual(first)
    expect(calls).toBe(2)
  })
  it('按片名搜：标题完全一致的优先，否则按热度；搜不到缓存 null 不再问', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async (u: unknown) => {
      calls++
      const url = String(u)
      if (url.includes('/search/movie')) return { ok: true, json: async () => ({ results: [
        { id: 11, media_type: 'movie', title: '流浪地球', vote_average: 7.0, popularity: 50, genre_ids: [878], original_language: 'zh', release_date: '2019-02-05' },
        { id: 12, media_type: 'movie', title: '流浪地球2', vote_average: 7.9, popularity: 30, genre_ids: [878], original_language: 'zh', release_date: '2023-01-22' },
      ] }) }
      if (url.includes('/search/tv')) return { ok: true, json: async () => ({ results: [] }) }
      throw new Error('unexpected ' + url)
    })
    const found = await searchTmdbTitle('KEY', '流浪地球2')
    expect(found?.id).toBe(12) // 完全一致优先，哪怕热度更低
    expect(found?.vote).toBe(7.9)
    const again = await searchTmdbTitle('KEY', '流浪地球2')
    expect(again?.id).toBe(12)
    expect(calls).toBe(2) // 第二次走缓存，不请求
  })
  it('详情：电影给地区+导演+主演；剧集给状态+集数；缓存 24 小时', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async (u: unknown) => {
      calls++
      const url = String(u)
      if (url.includes('/movie/123')) return { ok: true, json: async () => ({
        genres: [{ name: '科幻' }], production_countries: [{ iso_3166_1: 'CN' }],
        credits: { crew: [{ job: 'Director', name: '郭帆' }], cast: [{ name: '吴京' }, { name: '刘德华' }, { name: '李雪健' }, { name: '其他' }] },
      }) }
      if (url.includes('/tv/456')) return { ok: true, json: async () => ({
        genres: [{ name: '剧情' }], production_countries: [{ iso_3166_1: 'CN' }], status: 'Returning Series',
        number_of_episodes: 21, last_air_date: '2024-08-30',
        credits: { crew: [], cast: [{ name: '郭麒麟' }, { name: '吴镇宇' }] },
      }) }
      throw new Error('unexpected ' + url)
    })
    const m = await fetchTmdbDetails('KEY', 'movie', 123)
    expect(m.region).toBe('大陆')
    expect(m.director).toBe('郭帆')
    expect(m.cast).toBe('吴京、刘德华、李雪健')
    expect(m.status).toBeUndefined()
    const t = await fetchTmdbDetails('KEY', 'tv', 456)
    expect(t.status).toBe('up')
    expect(t.episodes).toBe(21)
    expect(t.lastDate).toBe('2024-08-30')
    await fetchTmdbDetails('KEY', 'movie', 123)
    expect(calls).toBe(2) // 第三次走缓存
  })
  it('详情接口失败不缓存、不抛错到墙（调用方 catch），401 直接抛', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 401, json: async () => ({}) }))
    await expect(fetchTmdbDetails('BAD', 'movie', 1)).rejects.toThrow('401')
  })
})

describe('watch 海报墙结构（v0.1.395：WatchTool.tsx + styles.css）', () => {
  it('点播页签是海报墙：四排筛选 + 计数行 + 12 部一页 + 详情弹层（选集/线路/加片单/播放）', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../components/WatchTool.tsx', import.meta.url), 'utf8')
    for (const s of ['wt-wall-filters', 'wt-wall', 'wt-countbar', 'wt-sortbox', 'WALL_GENRES', 'WALL_YEARS', 'WALL_REGIONS', 'WALL_STATUS_FILTERS']) {
      expect(src).toContain(s)
    }
    expect(src).toContain('pageSlice(wallFiltered, vodPage, 12)')
    expect(src).toContain('pageCount(wallFiltered.length, 12)')
    for (const s of ['VodDetailSheet', 'wt-sheet-backdrop', 'wt-eps', 'wt-src-chips', 'wt-playbar', '暂无片源 · 仅展示', '＋ 加入片单']) {
      expect(src).toContain(s)
    }
    // 详情里选线路：播放用选中的集与线路
    expect(src).toContain('openVod(v, vodDetailEp, 0, vodDetailLine)')
    // 热门推荐带名次、继续观看带海报
    expect(src).toContain('wt-rank')
    expect(src).toContain('wt-cont-thumb')
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
    for (const s of ['.wt-wall {', '.wt-wall-card', '.wt-wall-poster', '.wt-wall-badge', '.wt-wall-rate', '.wt-wall-veil', '.wt-sheet {', '.wt-play-btn', '.wt-rank']) {
      expect(css).toContain(s)
    }
    expect(css).toMatch(/\.wt-wall \{[^}]*grid-template-columns: repeat\(6, 1fr\)/s)
  })
})

// 源体检（v0.1.391）：逐台测连通性——通/不通、耗时；死台标出、可过滤，快的排前面；结果缓存 30 分钟
describe('watch.probeStreamUrl（v0.1.391 源体检探针）', () => {
  it('fetch  resolve（响应头到了）→ 通，耗时 ≥ 1ms', async () => {
    vi.stubGlobal('fetch', async () => ({}))
    const r = await probeStreamUrl('http://example.com/a.m3u8', 1000)
    expect(r.ok).toBe(true)
    expect(r.ms).toBeGreaterThanOrEqual(1)
  })
  it('fetch 抛错 → 不通；非 http(s) 地址直接不通，不发请求', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => { calls++; throw new TypeError('Load failed') })
    expect((await probeStreamUrl('http://example.com/a.m3u8', 1000)).ok).toBe(false)
    expect((await probeStreamUrl('not-a-url', 1000)).ok).toBe(false)
    expect((await probeStreamUrl('ftp://example.com/a.m3u8', 1000)).ok).toBe(false)
    expect(calls).toBe(1)
  })
  it('超时无响应 → 不通（不等无限久）', async () => {
    // 桩要像真 fetch 一样响应 abort 信号，否则超时后 await 永远不返回
    vi.stubGlobal('fetch', (_u: unknown, init?: { signal?: AbortSignal }) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    const t0 = Date.now()
    const r = await probeStreamUrl('http://example.com/slow.m3u8', 30)
    expect(r.ok).toBe(false)
    expect(Date.now() - t0).toBeLessThan(2000)
  })
  it('已取消的 signal → 直接不通，不发请求', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => { calls++; return {} })
    const ctrl = new AbortController()
    ctrl.abort()
    expect((await probeStreamUrl('http://example.com/a.m3u8', 1000, ctrl.signal)).ok).toBe(false)
    expect(calls).toBe(0)
  })
})

const HEALTH_CH = (key: string, urls: string[]): LiveChannel => ({ key, name: key, content: 'other', country: 'CN', urls, sourceIds: ['iptv-cn'] })

describe('watch.probeChannel / probeChannels（v0.1.391）', () => {
  it('第一条不通自动试下一条：通的那条即算通，记通的地址', async () => {
    vi.stubGlobal('fetch', async (u: unknown) => {
      if (String(u).includes('dead')) throw new TypeError('Load failed')
      return {}
    })
    const r = await probeChannel(HEALTH_CH('备用台', ['http://example.com/dead/a.m3u8', 'http://example.com/fast/b.m3u8']))
    expect(r.ok).toBe(true)
    expect(r.url).toBe('http://example.com/fast/b.m3u8')
    expect(typeof r.ms).toBe('number')
  })
  it('全部地址都不通 → 不通，url 记第一条', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('Load failed') })
    const r = await probeChannel(HEALTH_CH('死台', ['http://example.com/dead/a.m3u8', 'http://example.com/dead/b.m3u8']))
    expect(r.ok).toBe(false)
    expect(r.url).toBe('http://example.com/dead/a.m3u8')
    expect(r.ms).toBeUndefined()
  })
  it('并行跑：onProgress 按完成数递增；并发数不超过上限', async () => {
    let live = 0
    let maxLive = 0
    vi.stubGlobal('fetch', async (u: unknown) => {
      live++; maxLive = Math.max(maxLive, live)
      await new Promise(r => setTimeout(r, 15))
      live--
      if (String(u).includes('dead')) throw new TypeError('Load failed')
      return {}
    })
    const chans = [
      HEALTH_CH('a', ['http://example.com/fast/a.m3u8']),
      HEALTH_CH('b', ['http://example.com/dead/b.m3u8']),
      HEALTH_CH('c', ['http://example.com/fast/c.m3u8']),
      HEALTH_CH('d', ['http://example.com/fast/d.m3u8']),
      HEALTH_CH('e', ['http://example.com/dead/e.m3u8']),
      HEALTH_CH('f', ['http://example.com/fast/f.m3u8']),
    ]
    const seen: number[] = []
    const out = await probeChannels(chans, { concurrency: 2, onProgress: (done) => { seen.push(done) } })
    expect(Object.keys(out)).toHaveLength(6)
    expect(out['a'].ok).toBe(true)
    expect(out['b'].ok).toBe(false)
    expect(seen).toEqual([1, 2, 3, 4, 5, 6])
    expect(maxLive).toBeLessThanOrEqual(2)
  })
  it('取消后停在已测的部分：返回部分结果，不再测剩下的', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => { calls++; await new Promise(r => setTimeout(r, 10)); return {} })
    const ctrl = new AbortController()
    const chans = [1, 2, 3, 4, 5, 6].map(i => HEALTH_CH(`ch${i}`, [`http://example.com/fast/${i}.m3u8`]))
    const out = await probeChannels(chans, {
      concurrency: 1, signal: ctrl.signal,
      onProgress: (done) => { if (done === 2) ctrl.abort() },
    })
    expect(Object.keys(out).length).toBeLessThanOrEqual(2)
    expect(calls).toBeLessThanOrEqual(2)
  })
})

describe('watch 体检缓存（v0.1.391：30 分钟）', () => {
  it('保存后读回一致；超过 30 分钟的条目被丢掉', () => {
    saveHealthCache({
      'cctv-1': { ok: true, ms: 120, at: Date.now(), url: 'http://example.com/cctv1.m3u8' },
      'old-one': { ok: true, ms: 300, at: Date.now() - 31 * 60_000, url: 'http://example.com/old.m3u8' },
    })
    const back = loadHealthCache()
    expect(back['cctv-1']?.ok).toBe(true)
    expect(back['cctv-1']?.ms).toBe(120)
    expect(back['old-one']).toBeUndefined()
  })
  it('healthOf：缓存条目须是当前频道的某条地址，否则不用（防不同国家同名台串结果）', () => {
    const health: HealthMap = {
      'news': { ok: true, ms: 50, at: Date.now(), url: 'http://example.com/cn-news.m3u8' },
    }
    expect(healthOf(health, HEALTH_CH('news', ['http://example.com/cn-news.m3u8']))?.ok).toBe(true)
    expect(healthOf(health, HEALTH_CH('news', ['http://example.com/us-news.m3u8']))).toBeUndefined()
    expect(healthOf(health, HEALTH_CH('other', ['http://example.com/cn-news.m3u8']))).toBeUndefined()
  })
})

describe('watch.applyHealthView / healthCounts（v0.1.391 过滤排序）', () => {
  const chans = [
    HEALTH_CH('fast', ['http://example.com/fast.m3u8']),
    HEALTH_CH('slow', ['http://example.com/slow.m3u8']),
    HEALTH_CH('dead', ['http://example.com/dead.m3u8']),
    HEALTH_CH('untested', ['http://example.com/u.m3u8']),
  ]
  const health: HealthMap = {
    'fast': { ok: true, ms: 80, at: Date.now(), url: 'http://example.com/fast.m3u8' },
    'slow': { ok: true, ms: 900, at: Date.now(), url: 'http://example.com/slow.m3u8' },
    'dead': { ok: false, at: Date.now(), url: 'http://example.com/dead.m3u8' },
  }
  it('healthCounts：已测 3 · 通 2 · 不通 1', () => {
    expect(healthCounts(chans, health)).toEqual({ tested: 3, ok: 2, bad: 1 })
    expect(healthCounts(chans, {})).toEqual({ tested: 0, ok: 0, bad: 0 })
  })
  it('只看已测通的：只剩通的台', () => {
    expect(applyHealthView(chans, health, { onlyHealthy: true }).map(c => c.key)).toEqual(['fast', 'slow'])
  })
  it('快的排前面：通的按耗时升序，未测的居中，死的沉底；原顺序不打乱', () => {
    expect(applyHealthView(chans, health, { sortBySpeed: true }).map(c => c.key))
      .toEqual(['fast', 'slow', 'untested', 'dead'])
    // 列表顺序打乱时仍按耗时排：慢台在前、快台在后 → 快台提到前面
    const shuffled = [chans[1], chans[0], chans[2]]
    expect(applyHealthView(shuffled, health, { sortBySpeed: true }).map(c => c.key))
      .toEqual(['fast', 'slow', 'dead'])
  })
  it('不开启过滤/排序时原样返回', () => {
    expect(applyHealthView(chans, health)).toEqual(chans)
    expect(applyHealthView(chans, {})).toEqual(chans)
  })
})

describe('watch 源体检结构（v0.1.391：WatchTool.tsx + styles.css）', () => {
  it('直播页签有体检入口、状态行、过滤/排序开关；频道卡片按结果打角标', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../components/WatchTool.tsx', import.meta.url), 'utf8')
    for (const s of ['开始体检', '体检中', '停止', '上次体检', '只看已测通的', '快的排前面', '重新体检', '还没体检过', 'startHealth', 'probeChannels', 'applyHealthView', 'healthCounts', 'loadHealthCache', 'wt-health-bar', 'wt-health-ok', 'wt-health-bad', 'wt-channel-dead']) {
      expect(src).toContain(s)
    }
    // 死台变淡、不通角标；通的角标带耗时
    expect(src).toContain('✗ 不通')
    expect(src).toContain('✓ {h.ms}ms')
    // 体检不自动跑：没有在打开直播/切换国家时自动调用 startHealth
    expect(src).not.toMatch(/useEffect\(\(\) => \{[^}]*startHealth/s)
    // 394 横向页签与 395 海报墙未动
    expect(src).toContain("activeTab === 'live'")
    expect(src).toContain('wt-wall')
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
    for (const s of ['.wt-health-ok {', '.wt-health-bad {', '.wt-channel-dead {', '.wt-health-bar {']) {
      expect(css).toContain(s)
    }
  })
})
