import { describe, it, expect } from 'vitest'
import {
  parseEpicPromotions, assertFreeToClaim, buildQuickPurchaseBody,
  sortRecords, pageSlice, pageCount, defaultPrefs, nextCheckAt,
  type FreeGame, type ClaimRecord,
} from './freeGames'

// fixture：按 2026-11-24 晚实测的 freeGamesPromotions 返回结构裁剪
// （注意：TerraScape 当时并不在免费列表里——早先脚本把未过滤的促销都标成
// 免费是误读；以 discountPercentage===0 为准，当时仅 Mark of the Deep 免费）
const EPIC_FIXTURE = {
  data: {
    Catalog: {
      searchStore: {
        elements: [
          {
            title: 'Mark of the Deep', id: '1f9a12b06b4f437790b6913ad136a08c',
            namespace: '3d6441ab9d4246208bc97d7babf664b5', productSlug: null,
            urlSlug: '2fd257a6cd80405a833f9004ff07993a',
            offerType: 'BASE_GAME', categories: [{ path: 'games' }],
            price: { totalPrice: { discountPrice: 0, fmtPrice: { originalPrice: '¥55.00' } } },
            keyImages: [{ type: 'Thumbnail', url: 'https://cdn.example.com/mark.jpg' }],
            promotions: {
              promotionalOffers: [{ promotionalOffers: [{ startDate: '2026-11-19T16:00:00.000Z', endDate: '2026-11-26T16:00:00.000Z', discountSetting: { discountPercentage: 0 } }] }],
              upcomingPromotionalOffers: [],
            },
          },
          {
            title: '火之石', id: 'stone-of-fire-id', namespace: 'stone-ns',
            productSlug: 'fire-stone/home', offerType: 'BASE_GAME', categories: [{ path: 'games' }],
            price: { totalPrice: { discountPrice: 3000, fmtPrice: { originalPrice: '¥30.00' } } },
            keyImages: [],
            promotions: {
              promotionalOffers: [],
              upcomingPromotionalOffers: [{ promotionalOffers: [{ startDate: '2026-11-26T16:00:00.000Z', endDate: '2026-12-03T16:00:00.000Z', discountSetting: { discountPercentage: 0 } }] }],
            },
          },
          {
            title: '某打折游戏', id: 'sale-id', namespace: 'sale-ns',
            productSlug: 'sale-game', offerType: 'BASE_GAME', categories: [{ path: 'games' }],
            price: { totalPrice: { discountPrice: 5000, fmtPrice: { originalPrice: '¥100.00' } } },
            keyImages: [],
            promotions: {
              promotionalOffers: [{ promotionalOffers: [{ startDate: '2026-11-20T16:00:00.000Z', endDate: '2026-11-26T16:00:00.000Z', discountSetting: { discountPercentage: 50 } }] }],
              upcomingPromotionalOffers: [],
            },
          },
        ],
      },
    },
  },
}

function fakeGame(over: Partial<FreeGame> = {}): FreeGame {
  return {
    platform: 'epic', id: 'x1', namespace: 'ns1', title: '测试游戏', slug: 'test-game',
    url: 'https://store.epicgames.com/zh-CN/p/test-game', originalPrice: '¥55.00',
    isFree: true, status: 'free', startDate: null, endDate: '2026-11-26T16:00:00.000Z',
    offerType: 'BASE_GAME', autoClaimable: true, ...over,
  }
}

describe('freeGames.parseEpicPromotions', () => {
  it('当前免费只收 discountPercentage===0 且现价为 0 的（实测仅一款）', () => {
    const { current } = parseEpicPromotions(EPIC_FIXTURE)
    expect(current.map(g => g.title)).toEqual(['Mark of the Deep'])
    expect(current[0].isFree).toBe(true)
    // 真实数据里 productSlug 为空、urlSlug 是 UUID：直达链接用 urlSlug
    expect(current[0].url).toBe('https://store.epicgames.com/zh-CN/p/2fd257a6cd80405a833f9004ff07993a')
    expect(current[0].originalPrice).toBe('¥55.00')
    expect(current[0].endDate).toBe('2026-11-26T16:00:00.000Z')
    expect(current[0].imageUrl).toBe('https://cdn.example.com/mark.jpg')
    // 50% 打折的不算免费
    expect(current.some(g => g.title === '某打折游戏')).toBe(false)
  })
  it('预告进 upcoming，slug 取 productSlug 首段', () => {
    const { upcoming } = parseEpicPromotions(EPIC_FIXTURE)
    expect(upcoming.map(g => g.title)).toEqual(['火之石'])
    expect(upcoming[0].status).toBe('upcoming')
    expect(upcoming[0].isFree).toBe(false)
    expect(upcoming[0].slug).toBe('fire-stone')
    expect(upcoming[0].url).toBe('https://store.epicgames.com/zh-CN/p/fire-stone')
  })
  it('空体/缺字段不抛错', () => {
    expect(parseEpicPromotions(null)).toEqual({ current: [], upcoming: [] })
    expect(parseEpicPromotions({})).toEqual({ current: [], upcoming: [] })
  })
})

describe('freeGames.assertFreeToClaim', () => {
  it('免费基础游戏放行', () => {
    expect(() => assertFreeToClaim(fakeGame())).not.toThrow()
  })
  it('非免费拒绝下单', () => {
    expect(() => assertFreeToClaim(fakeGame({ isFree: false }))).toThrow(/不是免费/)
  })
  it('未开始的预告拒绝下单', () => {
    expect(() => assertFreeToClaim(fakeGame({ status: 'upcoming', isFree: false }))).toThrow()
  })
})

describe('freeGames.buildQuickPurchaseBody', () => {
  it('按 node-epicgames-client 的 quickPurchase 结构出 body', () => {
    const body = buildQuickPurchaseBody(fakeGame({ id: 'abc', namespace: 'ns9' }))
    expect(body).toEqual({
      salesChannel: 'Launcher-purchase-client',
      entitlementSource: 'Launcher-purchase-client',
      returnSplitPaymentItems: false,
      lineOffers: [{ offerId: 'abc', quantity: 1, namespace: 'ns9' }],
    })
  })
})

describe('freeGames.sortRecords', () => {
  it('失败组置顶，其余按时间倒序', () => {
    const recs: ClaimRecord[] = [
      { at: 100, platform: 'epic', title: 'A', outcome: 'claimed', message: 'ok' },
      { at: 300, platform: 'epic', title: 'B', outcome: 'error', message: '验证码' },
      { at: 200, platform: 'epic', title: 'C', outcome: 'claimed', message: 'ok' },
      { at: 400, platform: 'epic', title: 'D', outcome: 'error', message: '登录失效' },
    ]
    expect(sortRecords(recs).map(r => r.title)).toEqual(['D', 'B', 'C', 'A'])
  })
})

describe('freeGames pagination', () => {
  it('每页 8 条切片与页数', () => {
    const list = Array.from({ length: 20 }, (_, i) => i)
    expect(pageSlice(list, 1)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(pageSlice(list, 3)).toEqual([16, 17, 18, 19])
    expect(pageCount(20)).toBe(3)
    expect(pageCount(0)).toBe(1)
    expect(pageCount(8)).toBe(1)
    expect(pageCount(9)).toBe(2)
  })
})

describe('freeGames prefs', () => {
  it('默认每 6 小时巡查、自动领取开启', () => {
    const p = defaultPrefs()
    expect(p.autoClaim).toBe(true)
    expect(p.intervalHours).toBe(6)
    expect(p.epicEnabled).toBe(true)
  })
  it('下次检查 = 上次 + 间隔；从未查过则为现在', () => {
    const p = defaultPrefs()
    expect(nextCheckAt(p, 1_000_000)).toBe(1_000_000 + 6 * 3600_000)
    expect(nextCheckAt(p, null)).toBeLessThanOrEqual(Date.now())
  })
})
