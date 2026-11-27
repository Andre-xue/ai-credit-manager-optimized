import { describe, it, expect, beforeEach } from 'vitest'
import {
  parseAppDetailsMeta, isTripleA, filterSteamDeals, buildFilterSummary,
  parseStoreSearchResults, buildStoreSearchUrl, buildSteamTagSearchUrl,
  loadSteamMetaCache, saveSteamMetaCache, STEAM_CATEGORIES,
  type SteamAppMeta, type SteamMallFilters,
} from './steamMall'
import { storeUrlOf, type SteamDeal } from './steamDeals'

if (!(globalThis as unknown as Record<string, unknown>).localStorage) {
  const store = new Map<string, string>()
  ;(globalThis as unknown as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
  }
}
const ls = () => (globalThis as unknown as { localStorage: { clear(): void } }).localStorage
beforeEach(() => { ls().clear() })

const meta = (over: Partial<SteamAppMeta> & { appid: string }): SteamAppMeta => ({
  genres: [], platforms: { windows: true, mac: false, linux: false },
  publishers: [], developers: [], type: 'game', at: 1, ...over,
})

const deal = (over: Partial<SteamDeal> & { appid: string; title: string }): SteamDeal => ({
  kind: 'game', url: storeUrlOf(over.appid), imageUrl: '', discountPct: 50,
  originalPrice: '¥100.00', finalPrice: '¥50.00', finalPriceCents: 5000, ...over,
})

// fixture：appdetails 单款响应结构（genres 带 id+description、platforms、recommendations）
const APPDETAILS_ENTRY = {
  success: true,
  data: {
    type: 'game',
    genres: [{ id: '1', description: '动作' }, { id: '25', description: '冒险' }],
    platforms: { windows: true, mac: true, linux: false },
    publishers: ['Valve'],
    developers: ['Valve'],
    recommendations: { total: 123456 },
  },
}

describe('parseAppDetailsMeta', () => {
  it('解析 genres id / platforms / 发行商 / 评测总数', () => {
    const m = parseAppDetailsMeta('730', APPDETAILS_ENTRY)
    expect(m).not.toBeNull()
    expect(m!.genres).toEqual([1, 25])
    expect(m!.platforms).toEqual({ windows: true, mac: true, linux: false })
    expect(m!.publishers).toEqual(['Valve'])
    expect(m!.developers).toEqual(['Valve'])
    expect(m!.recommendations).toBe(123456)
    expect(m!.type).toBe('game')
  })
  it('success=false / 无 data 返回 null', () => {
    expect(parseAppDetailsMeta('1', { success: false })).toBeNull()
    expect(parseAppDetailsMeta('1', null)).toBeNull()
    expect(parseAppDetailsMeta('1', { success: true })).toBeNull()
  })
  it('元数据缓存写读一致', () => {
    const m = meta({ appid: '730', genres: [1] })
    saveSteamMetaCache({ '730': m })
    expect(loadSteamMetaCache()).toEqual({ '730': m })
  })
})

describe('isTripleA（圈选口径）', () => {
  it('大厂 + 评测量高 + 非独立 → true', () => {
    expect(isTripleA(meta({ appid: '1', publishers: ['Rockstar Games'], recommendations: 900000, genres: [1] }))).toBe(true)
    expect(isTripleA(meta({ appid: '1', developers: ['CD PROJEKT RED'], recommendations: 60000, genres: [3] }))).toBe(true)
  })
  it('带独立类型 → false（哪怕大厂高量）', () => {
    expect(isTripleA(meta({ appid: '1', publishers: ['Valve'], recommendations: 900000, genres: [1, 23] }))).toBe(false)
  })
  it('评测量不足 → false；无 recommendations 时用搜索行评测数兜底', () => {
    expect(isTripleA(meta({ appid: '1', publishers: ['Valve'], recommendations: 49999 }))).toBe(false)
    expect(isTripleA(meta({ appid: '1', publishers: ['Valve'] }), 80000)).toBe(true)
    expect(isTripleA(meta({ appid: '1', publishers: ['Valve'] }), 100)).toBe(false)
  })
  it('非大厂 → false；无元数据 → false', () => {
    expect(isTripleA(meta({ appid: '1', publishers: ['某独立工作室'], recommendations: 900000 }))).toBe(false)
    expect(isTripleA(undefined, 900000)).toBe(false)
  })
})

describe('filterSteamDeals', () => {
  const racing = deal({ appid: '10', title: '赛车游戏', reviewCount: 100 })
  const macGame = deal({ appid: '11', title: 'Mac 动作', reviewCount: 100 })
  const pkg = deal({ appid: '12', title: '合集包', kind: 'package' })
  const noMeta = deal({ appid: '13', title: '没补元数据' })
  const metas: Record<string, SteamAppMeta> = {
    '10': meta({ appid: '10', genres: [9], platforms: { windows: true, mac: false, linux: false } }),
    '11': meta({ appid: '11', genres: [1], platforms: { windows: true, mac: true, linux: false } }),
  }
  const all = [racing, macGame, pkg, noMeta]
  const base: SteamMallFilters = { category: null, platform: null, discountOnly: false, kind: 'all' }

  it('无筛选时全保留（含合集包与未补元数据）', () => {
    expect(filterSteamDeals(all, metas, base)).toHaveLength(4)
  })
  it('分类筛选：只留 genres 命中的本体，合集包与未补元数据的排除', () => {
    expect(filterSteamDeals(all, metas, { ...base, category: 'racing' }).map(d => d.appid)).toEqual(['10'])
    expect(filterSteamDeals(all, metas, { ...base, category: 'action' }).map(d => d.appid)).toEqual(['11'])
  })
  it('平台筛选：Mac 只留支持 Mac 的', () => {
    expect(filterSteamDeals(all, metas, { ...base, platform: 'mac' }).map(d => d.appid)).toEqual(['11'])
    expect(filterSteamDeals(all, metas, { ...base, platform: 'linux' })).toEqual([])
  })
  it('分类+平台叠加', () => {
    expect(filterSteamDeals(all, metas, { ...base, category: 'action', platform: 'mac' }).map(d => d.appid)).toEqual(['11'])
    expect(filterSteamDeals(all, metas, { ...base, category: 'racing', platform: 'mac' })).toEqual([])
  })
  it('仅打折：折扣为 0 的剔除（搜索全目录结果用）', () => {
    const free = deal({ appid: '14', title: '不打折', discountPct: 0 })
    expect(filterSteamDeals([racing, free], metas, { ...base, discountOnly: true }).map(d => d.appid)).toEqual(['10'])
  })
  it('类型筛选与既有口径一致', () => {
    expect(filterSteamDeals(all, metas, { ...base, kind: 'package' }).map(d => d.appid)).toEqual(['12'])
  })
  it('恐怖分类在过滤层不筛（来源即标签结果）', () => {
    expect(filterSteamDeals(all, metas, { ...base, category: 'horror' })).toHaveLength(4)
  })
  it('3A 分类走圈选口径', () => {
    const aaaMeta = { ...metas, '10': meta({ appid: '10', genres: [9], publishers: ['Electronic Arts'], recommendations: 200000 }) }
    expect(filterSteamDeals([racing], aaaMeta, { ...base, category: 'aaa' }).map(d => d.appid)).toEqual(['10'])
    expect(filterSteamDeals([racing], metas, { ...base, category: 'aaa' })).toEqual([])
  })
})

describe('buildFilterSummary', () => {
  it('拼已选摘要', () => {
    expect(buildFilterSummary({ category: 'racing', platform: 'mac', discountOnly: true })).toBe('赛车 · Mac · 仅打折')
    expect(buildFilterSummary({ category: null, platform: null, discountOnly: false })).toBe('')
    expect(buildFilterSummary({ category: 'aaa', platform: 'windows', discountOnly: false })).toBe('3A 大作 · Windows')
  })
  it('分类表与规格一致：10 类，恐怖与 3A 无 genreId', () => {
    expect(STEAM_CATEGORIES.map(c => c.label)).toEqual(['动作', '角色扮演', '策略', '模拟', '赛车', '体育', '独立', '恐怖', '休闲', '3A 大作'])
    expect(STEAM_CATEGORIES.find(c => c.key === 'horror')!.genreId).toBeNull()
    expect(STEAM_CATEGORIES.find(c => c.key === 'aaa')!.genreId).toBeNull()
  })
})

describe('parseStoreSearchResults / buildStoreSearchUrl', () => {
  it('解析带价/不带价/打折三种行', () => {
    const json = {
      total: 3,
      items: [
        { id: 730, name: 'Counter-Strike 2', tiny_image: 'https://x/capsule.jpg', price: { currency: 'CNY', initial: 10000, final: 5000, discount_percent: 50 } },
        { id: 570, name: 'Dota 2', tiny_image: 'https://x/dota.jpg' },
        { id: 440, name: 'Team Fortress 2', tiny_image: '', price: { currency: 'CNY', initial: 0, final: 0, discount_percent: 0 } },
      ],
    }
    const out = parseStoreSearchResults(json)
    expect(out).toHaveLength(3)
    expect(out[0].discountPct).toBe(50)
    expect(out[0].originalPrice).toBe('¥100.00')
    expect(out[0].finalPrice).toBe('¥50.00')
    expect(out[0].finalPriceCents).toBe(5000)
    expect(out[0].url).toBe('https://store.steampowered.com/app/730/')
    expect(out[1].discountPct).toBe(0)
    expect(out[1].finalPrice).toBe('')
    expect(out[2].finalPriceCents).toBe(0)
  })
  it('坏数据返回空数组', () => {
    expect(parseStoreSearchResults(null)).toEqual([])
    expect(parseStoreSearchResults({})).toEqual([])
    expect(parseStoreSearchResults({ items: [{ name: '无 id' }] })).toEqual([])
  })
  it('搜索地址带 term/cc/l', () => {
    const u = new URL(buildStoreSearchUrl('巫师 3'))
    expect(u.pathname).toContain('/api/storesearch/')
    expect(u.searchParams.get('term')).toBe('巫师 3')
    expect(u.searchParams.get('cc')).toBe('CN')
  })
  it('标签搜索地址带 tags 与 specials', () => {
    const u = new URL(buildSteamTagSearchUrl(1667, 0))
    expect(u.searchParams.get('tags')).toBe('1667')
    expect(u.searchParams.get('specials')).toBe('1')
  })
})
