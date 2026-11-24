import { describe, it, expect } from 'vitest'
import {
  parseEpicPromotions, assertFreeToClaim, buildQuickPurchaseBody,
  sortRecords, pageSlice, pageCount, defaultPrefs, nextCheckAt,
  EPIC_LOGIN_URL, fetchEpicFreeGames,
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

describe('freeGames EPIC_LOGIN_URL', () => {
  it('必须是 OAuth 授权地址（带 redirectUrl 到 id/api/redirect），不是 /id/login/welcome', () => {
    // 2026-11-24 实机：旧地址缺 redirectUrl，Epic 把登录跳到 /id/login/welcome
    // 并直接报「无法完成登陆」，连账号密码都没法输（v0.1.385 修）
    expect(EPIC_LOGIN_URL).not.toContain('/id/login/welcome')
    expect(EPIC_LOGIN_URL).toContain('www.epicgames.com/id/login?redirectUrl=')
    const u = new URL(EPIC_LOGIN_URL)
    const redirect = u.searchParams.get('redirectUrl') ?? ''
    expect(redirect).toContain('www.epicgames.com/id/api/redirect')
    expect(redirect).toContain('clientId=34a02cf8f4414e29b15921876da36f9a')
    expect(redirect).toContain('responseType=code')
  })
})

describe('freeGames bindEpicWithAuthCode', () => {
  it('换 token 时 form 体带 token_type=eg1（legendary 做法；缺了 Epic 会拒）', async () => {
    const { webcrypto } = await import('node:crypto')
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true })
    if (!(globalThis as unknown as Record<string, unknown>).localStorage) {
      const m = new Map<string, string>()
      ;(globalThis as unknown as Record<string, unknown>).localStorage = {
        getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
        setItem: (k: string, v: string) => { m.set(k, v) },
        removeItem: (k: string) => { m.delete(k) },
        clear: () => m.clear(),
      }
    }
    const calls: Array<{ url: string; body: string }> = []
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
      const u = String(url)
      calls.push({ url: u, body: String(init?.body ?? '') })
      if (u.includes('/oauth/token')) {
        return { ok: true, text: async () => JSON.stringify({ access_token: 'AT', account_id: 'ACC' }), json: async () => ({}) }
      }
      return { ok: true, text: async () => '{}', json: async () => ({ deviceId: 'D', secret: 'S', accountId: 'ACC' }) }
    }) as typeof fetch
    try {
      const { initVault } = await import('./crypto')
      await initVault('testpwd8')
      const { bindEpicWithAuthCode } = await import('./freeGames')
      const auth = await bindEpicWithAuthCode('CODE123', 'testpwd8')
      expect(auth.accountId).toBe('ACC')
      expect(auth.deviceId).toBe('D')
      const tokCall = calls.find(c => c.url.includes('/oauth/token'))
      expect(tokCall).toBeDefined()
      const params = new URLSearchParams(tokCall!.body)
      expect(params.get('grant_type')).toBe('authorization_code')
      expect(params.get('code')).toBe('CODE123')
      expect(params.get('token_type')).toBe('eg1')
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

describe('freeGames fetchEpicFreeGames 报错文案', () => {
  it('网络失败（WKWebView 只抛英文 Load failed）要换成中文并提示换节点', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => { throw new TypeError('Load failed') }) as typeof fetch
    try {
      await expect(fetchEpicFreeGames()).rejects.toThrow(/免费游戏列表加载失败/)
      await expect(fetchEpicFreeGames()).rejects.toThrow(/换个节点/)
    } finally {
      globalThis.fetch = origFetch
    }
  })
  it('接口非 200 要写清状态码', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => ({ ok: false, status: 403, json: async () => ({}) })) as unknown as typeof fetch
    try {
      await expect(fetchEpicFreeGames()).rejects.toThrow(/免费游戏列表加载失败：Epic 接口返回 403/)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})
