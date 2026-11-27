import { describe, it, expect, beforeEach } from 'vitest'
import {
  steamHtmlToText, parsePackageGroups, parsePackageDetailsInfo,
  parseAppDetailsDetail, mergePackageInfos, parseReviewSummary,
  loadSteamDetailCache, saveSteamDetailCache, getCachedSteamDetail,
  STEAM_DETAIL_CACHE_TTL_MS,
  type SteamGameDetail,
} from './steamDetail'

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

// fixture：按 appdetails 真实结构裁剪（战地风云 1：标准版 + Revolution 两购买选项）
const APPDETAILS_ENTRY = {
  success: true,
  data: {
    type: 'game',
    name: 'Battlefield™ 1',
    short_description: '在一战的战场上体验黎明般的战斗。',
    about_the_game: '<p>第一段介绍。</p><p>第二段<br>带换行。</p>',
    header_image: 'https://x/header.jpg',
    screenshots: [
      { id: 0, path_thumbnail: 'https://x/s1.thumb.jpg', path_full: 'https://x/s1.full.jpg' },
      { id: 1, path_thumbnail: 'https://x/s2.thumb.jpg', path_full: 'https://x/s2.full.jpg' },
    ],
    release_date: { coming_soon: false, date: '2016 年 10 月 20 日' },
    developers: ['DICE'],
    publishers: ['Electronic Arts'],
    genres: [{ id: '1', description: '动作' }, { id: '25', description: '冒险' }],
    is_free: false,
    price_overview: {
      currency: 'CNY', initial: 19800, final: 990, discount_percent: 95,
      initial_formatted: '¥198.00', final_formatted: '¥9.90',
    },
    pc_requirements: {
      minimum: '<strong>最低配置:</strong><br>需要 64 位处理器和操作系统',
      recommended: '<strong>推荐配置:</strong><br>需要 64 位处理器和操作系统',
    },
    packages: [111, 222],
    package_groups: [
      {
        name: 'default', title: '购买 Battlefield™ 1',
        subs: [
          { packageid: 111, option_text: 'Battlefield™ 1', option_description: '', price_in_cents_with_discount: 990 },
          { packageid: 222, option_text: 'Battlefield™ 1 Revolution', option_description: '', price_in_cents_with_discount: 1980 },
        ],
      },
    ],
  },
}

describe('steamHtmlToText', () => {
  it('去标签、br/p 转行、解实体', () => {
    expect(steamHtmlToText('<p>甲</p><p>乙<br>丙 &amp; 丁</p>')).toBe('甲\n乙\n丙 & 丁')
    expect(steamHtmlToText('')).toBe('')
    expect(steamHtmlToText('<ul><li>一</li><li>二</li></ul>')).toContain('· 一')
  })
})

describe('parsePackageGroups', () => {
  it('展开多组 subs 并按 packageid 去重，保持顺序', () => {
    const subs = parsePackageGroups(APPDETAILS_ENTRY.data)
    expect(subs.map(s => s.packageId)).toEqual(['111', '222'])
    expect(subs[0].name).toBe('Battlefield™ 1')
    expect(subs[1].priceCentsWithDiscount).toBe(1980)
    const dup = parsePackageGroups({ package_groups: [{ subs: [{ packageid: 1, option_text: 'A' }, { packageid: 1, option_text: 'A2' }] }] })
    expect(dup).toHaveLength(1)
  })
  it('无 package_groups 返回空数组', () => {
    expect(parsePackageGroups({})).toEqual([])
    expect(parsePackageGroups(null)).toEqual([])
  })
})

describe('parsePackageDetailsInfo', () => {
  it('打折包：名称/包含名单/原价现价折扣齐全', () => {
    const info = parsePackageDetailsInfo({
      name: 'Battlefield™ 1 Revolution',
      apps: [{ id: 123, name: 'Battlefield™ 1' }, { id: 456, name: 'Battlefield™ 1 Premium Pass' }],
      price: { currency: 'CNY', initial: 29800, final: 1980, discount_percent: 93 },
    })
    expect(info).not.toBeNull()
    expect(info!.apps).toEqual(['Battlefield™ 1', 'Battlefield™ 1 Premium Pass'])
    expect(info!.price).toEqual({ discountPct: 93, originalPrice: '¥298.00', finalPrice: '¥19.80', finalPriceCents: 1980 })
  })
  it('不打折的包也保留价格（详情页列全部购买选项，不按折扣过滤）', () => {
    const info = parsePackageDetailsInfo({
      name: '原价包', apps: [], price: { currency: 'CNY', initial: 10000, final: 10000, discount_percent: 0 },
    })
    expect(info!.price!.finalPrice).toBe('¥100.00')
    expect(info!.price!.originalPrice).toBe('')
    expect(info!.price!.discountPct).toBe(0)
  })
  it('无 price 字段：info 在、price 为 undefined（不编造）', () => {
    const info = parsePackageDetailsInfo({ name: '无价包', apps: [{ id: 1, name: '甲' }] })
    expect(info).not.toBeNull()
    expect(info!.price).toBeUndefined()
  })
  it('无名返回 null', () => {
    expect(parsePackageDetailsInfo({})).toBeNull()
    expect(parsePackageDetailsInfo(null)).toBeNull()
  })
})

describe('parseAppDetailsDetail', () => {
  it('主体字段/价格/截图/配置/购买选项骨架齐全', () => {
    const d = parseAppDetailsDetail('1238810', APPDETAILS_ENTRY, 1000)
    expect(d).not.toBeNull()
    expect(d!.name).toBe('Battlefield™ 1')
    expect(d!.shortDescription).toContain('一战')
    expect(d!.aboutText).toBe('第一段介绍。\n第二段\n带换行。')
    expect(d!.headerImage).toBe('https://x/header.jpg')
    expect(d!.screenshots).toEqual([
      { thumb: 'https://x/s1.thumb.jpg', full: 'https://x/s1.full.jpg' },
      { thumb: 'https://x/s2.thumb.jpg', full: 'https://x/s2.full.jpg' },
    ])
    expect(d!.releaseDate).toBe('2016 年 10 月 20 日')
    expect(d!.developers).toEqual(['DICE'])
    expect(d!.publishers).toEqual(['Electronic Arts'])
    expect(d!.genres).toEqual(['动作', '冒险'])
    expect(d!.price).toEqual({ discountPct: 95, originalPrice: '¥198.00', finalPrice: '¥9.90', finalPriceCents: 990 })
    expect(d!.requirements!.minimum).toContain('最低配置:')
    expect(d!.packages.map(p => p.packageId)).toEqual(['111', '222'])
    expect(d!.packages[0].finalPrice).toBe('¥9.90')
    expect(d!.at).toBe(1000)
  })
  it('success=false / 无 data / 无名返回 null', () => {
    expect(parseAppDetailsDetail('1', { success: false })).toBeNull()
    expect(parseAppDetailsDetail('1', null)).toBeNull()
    expect(parseAppDetailsDetail('1', { success: true, data: {} })).toBeNull()
  })
  it('缺字段不编造：无 price_overview/截图/配置时对应字段为空', () => {
    const d = parseAppDetailsDetail('9', { success: true, data: { name: '极简游戏', is_free: true } })
    expect(d!.price).toBeUndefined()
    expect(d!.isFree).toBe(true)
    expect(d!.screenshots).toEqual([])
    expect(d!.requirements).toBeUndefined()
    expect(d!.packages).toEqual([])
    expect(d!.releaseDate).toBeUndefined()
  })
})

describe('mergePackageInfos', () => {
  it('合并 packagedetails 价格/内容，现价与总览价一致的行标 isBase', () => {
    const d = parseAppDetailsDetail('1238810', APPDETAILS_ENTRY, 1000) as SteamGameDetail
    const merged = mergePackageInfos(d, new Map([
      ['111', { name: 'Battlefield™ 1', apps: ['Battlefield™ 1'], price: { discountPct: 95, originalPrice: '¥198.00', finalPrice: '¥9.90', finalPriceCents: 990 } }],
      ['222', { name: 'Battlefield™ 1 Revolution', apps: ['Battlefield™ 1', 'Battlefield™ 1 Premium Pass'], price: { discountPct: 93, originalPrice: '¥298.00', finalPrice: '¥19.80', finalPriceCents: 1980 } }],
    ]))
    expect(merged.packages[0].isBase).toBe(true)
    expect(merged.packages[0].discountPct).toBe(95)
    expect(merged.packages[1].isBase).toBe(false)
    expect(merged.packages[1].originalPrice).toBe('¥298.00')
    expect(merged.packages[1].description).toBe('包含：Battlefield™ 1、Battlefield™ 1 Premium Pass')
  })
  it('packagedetails 全失败时保留骨架价，第一行兜底为本体行', () => {
    const d = parseAppDetailsDetail('1238810', APPDETAILS_ENTRY, 1000) as SteamGameDetail
    const merged = mergePackageInfos(d, new Map([['111', null], ['222', null]]))
    expect(merged.packages[0].isBase).toBe(true)
    expect(merged.packages[0].finalPrice).toBe('¥9.90')
    expect(merged.packages[1].finalPrice).toBe('¥19.80')
  })
})

describe('parseReviewSummary', () => {
  it('由 total_positive/total_reviews 算好评率', () => {
    expect(parseReviewSummary({ query_summary: { total_positive: 950, total_reviews: 1000 } })).toEqual({ pct: 95, count: 1000 })
  })
  it('无评测/坏结构返回 null', () => {
    expect(parseReviewSummary({ query_summary: { total_positive: 0, total_reviews: 0 } })).toBeNull()
    expect(parseReviewSummary({})).toBeNull()
    expect(parseReviewSummary(null)).toBeNull()
  })
})

describe('详情缓存', () => {
  it('写读一致；TTL 内命中、过期不命中', () => {
    const d = parseAppDetailsDetail('1238810', APPDETAILS_ENTRY, 5000) as SteamGameDetail
    saveSteamDetailCache({ '1238810': d })
    expect(loadSteamDetailCache()['1238810'].name).toBe('Battlefield™ 1')
    expect(getCachedSteamDetail('1238810', 5000 + STEAM_DETAIL_CACHE_TTL_MS - 1)).not.toBeNull()
    expect(getCachedSteamDetail('1238810', 5000 + STEAM_DETAIL_CACHE_TTL_MS)).toBeNull()
    expect(getCachedSteamDetail('404')).toBeNull()
  })
})
