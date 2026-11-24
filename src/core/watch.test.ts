import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  parseM3u, normalizeChannelName, contentKeyOf, stationOrigin,
  mergeChannels, groupChannels, fetchSourceSet, loadCountryChannels,
  type LiveChannel, type SourceSet,
} from './watch'

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
})
