import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import {
  parseM3u, parseM3uAsync, normalizeChannelName, contentKeyOf, stationOrigin,
  mergeChannels, groupChannels, fetchSourceSet, loadCountryChannels,
  isUnofficialStreamUrl, isChannelUnofficial,
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
