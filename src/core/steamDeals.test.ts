import { describe, it, expect, beforeEach } from 'vitest'
import {
  parseSteamSearchHtml, sortSteamDeals, buildSteamSearchUrl, storeUrlOf, storeSubUrlOf,
  loadSteamCache, saveSteamCache, isSteamCacheFresh,
  STEAM_DEALS_CACHE_KEY, STEAM_DEALS_CACHE_TTL_MS,
  shouldEntryRefreshSteam, STEAM_ENTRY_REFRESH_SKIP_MS,
  toSteamFetchError, formatSteamCents, dealKey, onlyGameDeals,
  type SteamDeal,
} from './steamDeals'

// node 环境没有 localStorage：与 watch.test.ts 同款 mock
if (!(globalThis as unknown as Record<string, unknown>).localStorage) {
  const store = new Map<string, string>()
  ;(globalThis as unknown as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
  }
}
const ls = () => (globalThis as unknown as { localStorage: { getItem(k: string): string | null; setItem(k: string, v: string): void; clear(): void } }).localStorage

beforeEach(() => { ls().clear() })

// fixture：按 2026-11-24 实测的 Steam 搜索 results_html 行结构裁剪
// （第一行是真实返回的「双人成行」行，属性已精简；后两行是手工变体）
const SEARCH_HTML = `
<a href="https://store.steampowered.com/app/1426210/It_Takes_Two/?snr=1_7_7_2300_150_1"
 data-ds-appid="1426210" data-ds-itemkey="App_1426210" class="search_result_row ds_collapse_flag ">
  <div class="search_capsule"><img src="https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1426210/capsule_231x87.jpg?t=1777395376" ></div>
  <div class="responsive_search_name_combined">
    <div class="search_name ellipsis"><span class="title">双人成行</span></div>
    <div class="search_released responsive_secondrow">2021 年 3 月 25 日</div>
    <div class="search_reviewscore responsive_secondrow">
      <span class="search_review_summary positive" data-tooltip-html="好评如潮&lt;br&gt;此游戏的 126,948 篇用户评测中有 95% 为好评。&lt;br&gt;&lt;br&gt;此产品的总体评价是基于您的偏好用以您语言撰写的评测计算得出的。"></span>
    </div>
    <div class="search_price_discount_combined responsive_secondrow" data-price-final="3960">
      <div class="search_discount_and_price responsive_secondrow">
        <div class="discount_block search_discount_block" data-price-final="3960" data-bundlediscount="0" data-discount="80"><div class="discount_pct" aria-hidden="true" data-tooltip-text="正常价格基础上提供的限时折扣">-80%</div><div class="discount_prices" aria-hidden="true"><div class="discount_original_price">¥198.00</div><div class="discount_final_price">¥39.60</div></div></div>
      </div>
    </div>
  </div>
</a>
<a href="https://store.steampowered.com/app/9999999/Some_Game/?snr=1_7_7_2300_150_2"
 data-ds-appid="9999999" data-ds-itemkey="App_9999999" class="search_result_row ds_collapse_flag ">
  <div class="search_capsule"><img src="https://example.com/capsule.jpg" ></div>
  <div class="responsive_search_name_combined">
    <div class="search_name ellipsis"><span class="title">无评价小游戏</span></div>
    <div class="search_released responsive_secondrow">2024 年 1 月 1 日</div>
    <div class="search_reviewscore responsive_secondrow"></div>
    <div class="search_price_discount_combined responsive_secondrow" data-price-final="900">
      <div class="search_discount_and_price responsive_secondrow">
        <div class="discount_block search_discount_block" data-price-final="900" data-bundlediscount="0" data-discount="90"><div class="discount_pct" aria-hidden="true">-90%</div><div class="discount_prices" aria-hidden="true"><div class="discount_original_price">¥90.00</div><div class="discount_final_price">¥9.00</div></div></div>
      </div>
    </div>
  </div>
</a>
<a href="https://store.steampowered.com/app/8888888/Full_Price/?snr=1_7_7_2300_150_3"
 data-ds-appid="8888888" data-ds-itemkey="App_8888888" class="search_result_row ds_collapse_flag ">
  <div class="responsive_search_name_combined">
    <div class="search_name ellipsis"><span class="title">不打折的游戏</span></div>
    <div class="search_price_discount_combined responsive_secondrow" data-price-final="6000">
      <div class="search_discount_and_price responsive_secondrow">
        <div class="discount_block search_discount_block" data-price-final="6000" data-bundlediscount="0" data-discount="0"><div class="discount_pct" aria-hidden="true">-0%</div><div class="discount_prices" aria-hidden="true"><div class="discount_original_price">¥60.00</div><div class="discount_final_price">¥60.00</div></div></div>
      </div>
    </div>
  </div>
</a>
`

const deal = (over: Partial<SteamDeal> & { appid: string; title: string }): SteamDeal => ({
  kind: 'game', url: storeUrlOf(over.appid), imageUrl: '', discountPct: 50, originalPrice: '¥100.00',
  finalPrice: '¥50.00', finalPriceCents: 5000, ...over,
})

// fixture：按 2026-11-24 实测的 Steam 搜索 results_html 合集包行裁剪
// （DARK SOULS III Deluxe Edition，sub 94174，第一页真实返回，属性已精简）
const PACKAGE_ROW_HTML = `
<a href="https://store.steampowered.com/sub/94174/?snr=1_7_7_2300_150_33"
 data-ds-packageid="94174" data-ds-appid="374320,442010" data-ds-itemkey="Sub_94174" class="search_result_row ds_collapse_flag ">
  <div class="search_capsule"><img src="https://shared.fastly.steamstatic.com/store_item_assets/steam/subs/94174/capsule_231x87.jpg?t=1726526238" ></div>
  <div class="responsive_search_name_combined">
    <div class="search_name ellipsis"><span class="title">DARK SOULS III Deluxe Edition</span></div>
    <div class="search_released responsive_secondrow">2016 年 4 月 11 日</div>
    <div class="search_reviewscore responsive_secondrow">
      <span class="search_review_summary positive" data-tooltip-html="特别好评&lt;br&gt;此捆绑包中游戏的 282,277 篇用户评测中有 94% 为好评。"></span>
    </div>
    <div class="search_price_discount_combined responsive_secondrow" data-price-final="19900">
      <div class="search_discount_and_price responsive_secondrow">
        <div class="discount_block search_discount_block" data-price-final="19900" data-bundlediscount="0" data-discount="50"><div class="discount_pct" aria-hidden="true">-50%</div><div class="discount_prices" aria-hidden="true"><div class="discount_original_price">¥398.00</div><div class="discount_final_price">¥199.00</div></div></div>
      </div>
    </div>
  </div>
</a>
`

describe('parseSteamSearchHtml', () => {
  it('解析出打折行：折扣、原价、现价、好评率、评测数、档位词、发售日', () => {
    const items = parseSteamSearchHtml(SEARCH_HTML)
    expect(items).toHaveLength(2)
    const itTakesTwo = items.find(d => d.appid === '1426210')
    expect(itTakesTwo).toBeDefined()
    expect(itTakesTwo!.title).toBe('双人成行')
    expect(itTakesTwo!.discountPct).toBe(80)
    expect(itTakesTwo!.originalPrice).toBe('¥198.00')
    expect(itTakesTwo!.finalPrice).toBe('¥39.60')
    expect(itTakesTwo!.finalPriceCents).toBe(3960)
    expect(itTakesTwo!.reviewPct).toBe(95)
    expect(itTakesTwo!.reviewCount).toBe(126948)
    expect(itTakesTwo!.reviewLabel).toBe('好评如潮')
    expect(itTakesTwo!.released).toBe('2021 年 3 月 25 日')
    expect(itTakesTwo!.url).toBe('https://store.steampowered.com/app/1426210/')
    expect(itTakesTwo!.imageUrl).toContain('capsule_231x87.jpg')
  })

  it('无评价的行好评字段为空，但仍保留（折扣在）', () => {
    const items = parseSteamSearchHtml(SEARCH_HTML)
    const noReview = items.find(d => d.appid === '9999999')
    expect(noReview).toBeDefined()
    expect(noReview!.discountPct).toBe(90)
    expect(noReview!.reviewPct).toBeUndefined()
    expect(noReview!.reviewCount).toBeUndefined()
  })

  it('折扣为 0 的行不进列表（specials=1 不应出现，出现也过滤）', () => {
    const items = parseSteamSearchHtml(SEARCH_HTML)
    expect(items.some(d => d.appid === '8888888')).toBe(false)
  })

  it('空 HTML / 无行时返回空数组（由 fetch 层按 total 判错）', () => {
    expect(parseSteamSearchHtml('')).toEqual([])
    expect(parseSteamSearchHtml('<div>no rows</div>')).toEqual([])
  })

  it('合集包行解析为 kind=package：sub 链接、折扣、原价现价、捆绑包好评', () => {
    const items = parseSteamSearchHtml(PACKAGE_ROW_HTML)
    expect(items).toHaveLength(1)
    const pkg = items[0]
    expect(pkg.kind).toBe('package')
    expect(pkg.appid).toBe('94174')
    expect(pkg.title).toBe('DARK SOULS III Deluxe Edition')
    expect(pkg.url).toBe('https://store.steampowered.com/sub/94174/')
    expect(pkg.discountPct).toBe(50)
    expect(pkg.originalPrice).toBe('¥398.00')
    expect(pkg.finalPrice).toBe('¥199.00')
    expect(pkg.finalPriceCents).toBe(19900)
    expect(pkg.reviewPct).toBe(94)
    expect(pkg.reviewCount).toBe(282277)
    expect(pkg.reviewLabel).toBe('特别好评')
    expect(pkg.released).toBe('2016 年 4 月 11 日')
    expect(pkg.imageUrl).toContain('/subs/94174/capsule_231x87.jpg')
  })

  it('游戏行与合集包行混在一起都能解析，kind 各自正确', () => {
    const items = parseSteamSearchHtml(SEARCH_HTML + PACKAGE_ROW_HTML)
    expect(items).toHaveLength(3)
    expect(items.filter(d => d.kind === 'game')).toHaveLength(2)
    expect(items.filter(d => d.kind === 'package')).toHaveLength(1)
  })

  it('非搜索结果行的 <a> 不解析（无 search_result_row class）', () => {
    const html = `<a href="https://store.steampowered.com/sub/94174/" data-ds-packageid="94174"><span class="title">冒牌行</span></a>`
    expect(parseSteamSearchHtml(html)).toEqual([])
  })
})

describe('onlyGameDeals（v0.1.505：列表只留本体）', () => {
  it('合集包行过滤掉，本体保留，顺序不变', () => {
    const g = deal({ appid: '1', title: 'G' })
    const p = deal({ appid: '94174', title: 'P', kind: 'package', url: storeSubUrlOf('94174') })
    const g2 = deal({ appid: '2', title: 'G2' })
    expect(onlyGameDeals([g, p, g2]).map(d => d.appid)).toEqual(['1', '2'])
    expect(onlyGameDeals([])).toEqual([])
  })
})

describe('formatSteamCents / dealKey / storeSubUrlOf', () => {
  it('分转人民币文本', () => {
    expect(formatSteamCents(22800, 'CNY')).toBe('¥228.00')
    expect(formatSteamCents(1140, 'CNY')).toBe('¥11.40')
    expect(formatSteamCents(0, 'CNY')).toBe('¥0.00')
  })
  it('合集包链接为 sub 页', () => {
    expect(storeSubUrlOf('505826')).toBe('https://store.steampowered.com/sub/505826/')
  })
  it('game 与 package 同数字 id 的 key 不同（命名空间分开）', () => {
    const g = deal({ appid: '94174', title: 'G' })
    const p = deal({ appid: '94174', title: 'P', kind: 'package', url: storeSubUrlOf('94174') })
    expect(dealKey(g)).not.toBe(dealKey(p))
    expect(dealKey(g)).toBe('game:94174')
    expect(dealKey(p)).toBe('package:94174')
  })
})
describe('sortSteamDeals', () => {
  const a = deal({ appid: '1', title: 'A', discountPct: 80, reviewPct: 95, finalPriceCents: 3960 })
  const b = deal({ appid: '2', title: 'B', discountPct: 90, finalPriceCents: 900 })
  const c = deal({ appid: '3', title: 'C', discountPct: 80, reviewPct: 88, finalPriceCents: 1000 })
  it('默认按折扣从高到低；同折扣好评率高的在前', () => {
    expect(sortSteamDeals([a, b, c], 'discount').map(d => d.appid)).toEqual(['2', '1', '3'])
  })
  it('按好评率排：无评价的沉底', () => {
    expect(sortSteamDeals([a, b, c], 'review').map(d => d.appid)).toEqual(['1', '3', '2'])
  })
  it('按价格排：现价从低到高', () => {
    expect(sortSteamDeals([a, b, c], 'price').map(d => d.appid)).toEqual(['2', '3', '1'])
  })
})

describe('buildSteamSearchUrl / storeUrlOf', () => {
  it('打折筛选 + 国区人民币 + 中文', () => {
    const u = new URL(buildSteamSearchUrl(100, 50))
    expect(u.hostname).toBe('store.steampowered.com')
    expect(u.searchParams.get('specials')).toBe('1')
    expect(u.searchParams.get('cc')).toBe('CN')
    expect(u.searchParams.get('l')).toBe('schinese')
    expect(u.searchParams.get('start')).toBe('100')
    expect(u.searchParams.get('count')).toBe('50')
  })
  it('商店链接为 app 详情页', () => {
    expect(storeUrlOf('1426210')).toBe('https://store.steampowered.com/app/1426210/')
  })
})

describe('steam cache', () => {
  it('写缓存后读回；1 小时内新鲜、过期后不新鲜', () => {
    const fresh = { at: Date.now(), total: 21379, items: [deal({ appid: '1', title: 'A' })], searchFetched: 1 }
    saveSteamCache(fresh)
    expect(loadSteamCache()).toEqual(fresh)
    expect(isSteamCacheFresh(loadSteamCache())).toBe(true)
    saveSteamCache({ ...fresh, at: Date.now() - STEAM_DEALS_CACHE_TTL_MS - 1000 })
    expect(isSteamCacheFresh(loadSteamCache())).toBe(false)
    expect(isSteamCacheFresh(null)).toBe(false)
  })
  it('缓存损坏时返回 null，不抛错', () => {
    ls().setItem(STEAM_DEALS_CACHE_KEY, '{not json')
    expect(loadSteamCache()).toBeNull()
  })
})

describe('toSteamFetchError', () => {
  it('Load failed 换成中文并点名 Steam', () => {
    expect(toSteamFetchError(new TypeError('Load failed')).message).toContain('Steam 降价加载失败')
    expect(toSteamFetchError(new TypeError('Load failed')).message).toContain('请换个节点再试')
  })
  it('其他错误原样透传', () => {
    expect(toSteamFetchError(new Error('HTTP 429')).message).toBe('HTTP 429')
  })
})

describe('进页自动刷新决策 (v0.1.470)', () => {
  it('5 分钟内跳过、超过 5 分钟刷新；1 小时缓存 TTL 保持不变', () => {
    const now = 1_700_000_000_000
    expect(shouldEntryRefreshSteam(now - 60_000, now)).toBe(false)
    expect(shouldEntryRefreshSteam(now - STEAM_ENTRY_REFRESH_SKIP_MS + 1, now)).toBe(false)
    expect(shouldEntryRefreshSteam(now - STEAM_ENTRY_REFRESH_SKIP_MS, now)).toBe(true)
    expect(shouldEntryRefreshSteam(now - 30 * 60_000, now)).toBe(true)
    expect(STEAM_DEALS_CACHE_TTL_MS).toBe(60 * 60_000)
  })
})
