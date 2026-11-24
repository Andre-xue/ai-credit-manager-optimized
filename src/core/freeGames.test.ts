import { describe, it, expect } from 'vitest'
import {
  parseEpicPromotions, assertFreeToClaim, buildQuickPurchaseBody,
  sortRecords, pageSlice, pageCount, defaultPrefs, nextCheckAt,
  EPIC_LOGIN_URL, fetchEpicFreeGames,
  toChineseFetchError, sanitizeLoadFailedMessage,
  bindEpicWithAuthCode, claimEpicGame,
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
      return { ok: true, text: async () => JSON.stringify({ deviceId: 'D', secret: 'S', accountId: 'ACC' }), json: async () => ({ deviceId: 'D', secret: 'S', accountId: 'ACC' }) }
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
    globalThis.fetch = (async () => ({ ok: false, status: 403, text: async () => '{}', json: async () => ({}) })) as unknown as typeof fetch
    try {
      await expect(fetchEpicFreeGames()).rejects.toThrow(/免费游戏列表加载失败：Epic 接口返回 403/)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

// v0.1.386：385 只包了列表请求，绑定/领取 6 处 fetch 漏包，Ethan 实机点
// 「确认绑定」仍弹英文 "Load failed"。共用 helper + notify 兜底，一处都不能漏。
describe('freeGames toChineseFetchError', () => {
  it('Load failed 换成中文并点名步骤', () => {
    const e = toChineseFetchError(new TypeError('Load failed'), 'Epic 绑定失败')
    expect(e.message).toContain('Epic 绑定失败')
    expect(e.message).toContain('换个节点')
    expect(e.message).not.toContain('Load failed')
  })
  it('Failed to fetch 同样换中文', () => {
    expect(toChineseFetchError(new TypeError('Failed to fetch'), 'Epic 下单失败').message).toContain('换个节点')
  })
  it('非网络错误原样透传（不乱改业务报错）', () => {
    expect(toChineseFetchError(new Error('Epic 授权码无效或已过期'), 'Epic 绑定失败').message)
      .toBe('Epic 授权码无效或已过期')
  })
})

describe('freeGames sanitizeLoadFailedMessage', () => {
  it('残留的 Load failed 只替换该片段，步骤名保留', () => {
    const out = sanitizeLoadFailedMessage('Epic 确认订单失败：Load failed')
    expect(out).toContain('Epic 确认订单失败')
    expect(out).toContain('换个节点')
    expect(out).not.toContain('Load failed')
  })
  it('干净文案原样不动', () => {
    expect(sanitizeLoadFailedMessage('Epic 已绑定，自动领取已就绪')).toBe('Epic 已绑定，自动领取已就绪')
  })
})

describe('freeGames bindEpicWithAuthCode 网络失败', () => {
  it('换 token 请求被拦（Load failed）要报中文绑定失败，不含英文', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => { throw new TypeError('Load failed') }) as typeof fetch
    try {
      await expect(bindEpicWithAuthCode('CODE123', 'testpwd8')).rejects.toThrow(/Epic 绑定失败/)
      await expect(bindEpicWithAuthCode('CODE123', 'testpwd8')).rejects.toThrow(/换个节点/)
      await expect(bindEpicWithAuthCode('CODE123', 'testpwd8')).rejects.not.toThrow(/Load failed/)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

describe('freeGames bindEpicWithAuthCode 授权码失效映射（v0.1.387）', () => {
  it('authorization_code_not_found / invalid_grant 映射成中文，不吐错误码原文；其他错误码保持原样', async () => {
    const origFetch = globalThis.fetch
    const stubToken400 = (code: string) => {
      globalThis.fetch = (async () => ({
        ok: false, status: 400,
        text: async () => JSON.stringify({ errorCode: code }),
        json: async () => ({ errorCode: code }),
      })) as unknown as typeof fetch
    }
    try {
      stubToken400('errors.com.epicgames.account.oauth.authorization_code_not_found')
      await expect(bindEpicWithAuthCode('OLDCODE', 'testpwd8')).rejects.toThrow(/授权码已失效或已被使用/)
      await expect(bindEpicWithAuthCode('OLDCODE', 'testpwd8')).rejects.toThrow(/重新登录获取新码再绑定/)
      await expect(bindEpicWithAuthCode('OLDCODE', 'testpwd8')).rejects.not.toThrow(/authorization_code_not_found/)
      stubToken400('invalid_grant')
      await expect(bindEpicWithAuthCode('OLDCODE', 'testpwd8')).rejects.toThrow(/授权码已失效或已被使用/)
      stubToken400('errors.com.epicgames.account.invalid_client')
      await expect(bindEpicWithAuthCode('OLDCODE', 'testpwd8')).rejects.toThrow(/Epic 登录失败：errors\.com\.epicgames\.account\.invalid_client/)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

describe('freeGames claimEpicGame 网络失败', () => {
  it('quickPurchase 请求被拦（Load failed）要报中文下单失败，不含英文', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => { throw new TypeError('Load failed') }) as typeof fetch
    try {
      await expect(claimEpicGame('AT', 'ACC', fakeGame())).rejects.toThrow(/Epic 下单失败/)
      await expect(claimEpicGame('AT', 'ACC', fakeGame())).rejects.toThrow(/换个节点/)
      await expect(claimEpicGame('AT', 'ACC', fakeGame())).rejects.not.toThrow(/Load failed/)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

// v0.1.386：Epic 不返回 ACAO，桌面 WKWebView 里前端 fetch 被 CORS 直接拦掉
// （换节点修不好）。全部 Epic 请求改走原生通道：桌面 plugin_http / 安卓 CapacitorHttp。
// 以下单测用假的 window.__TAURI_INTERNALS__.invoke 断言调用参数与旧 fetch 一致，
// 并确认桌面通道下 fetch 根本不会被调用。真机上原生通道本身仍待 Ethan 实机验。
function stubTauriInvoke(fn: (cmd: string, args: Record<string, unknown>) => Promise<string>) {
  const calls: Array<{ cmd: string; args: Record<string, unknown> }> = []
  const invoke = async (cmd: string, args: Record<string, unknown>) => {
    calls.push({ cmd, args })
    return fn(cmd, args)
  }
  ;(globalThis as unknown as Record<string, unknown>).window = { __TAURI_INTERNALS__: { invoke } }
  return calls
}
function unStubWindow() {
  delete (globalThis as unknown as Record<string, unknown>).window
}
function pluginEnvelope(status: number, body: string): string {
  return JSON.stringify({ status, body, headers: {} })
}

describe('freeGames epicRequest 桌面通道', () => {
  it('列表请求走 plugin_http（URL/方法/头与旧 fetch 一致），fetch 不被调用', async () => {
    const calls = stubTauriInvoke(async () => pluginEnvelope(200, JSON.stringify(EPIC_FIXTURE)))
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => { throw new Error('桌面通道下不应走 fetch') }) as typeof fetch
    try {
      const res = await fetchEpicFreeGames()
      expect(res.current.map(g => g.title)).toContain('Mark of the Deep')
      expect(calls).toHaveLength(1)
      expect(calls[0].cmd).toBe('plugin_http')
      expect(String(calls[0].args.url)).toContain('freeGamesPromotions')
      expect(calls[0].args.method).toBe('GET')
      expect(JSON.parse(String(calls[0].args.headersJson))).toEqual({ Accept: 'application/json' })
      expect(calls[0].args.body).toBeNull()
    } finally {
      globalThis.fetch = origFetch
      unStubWindow()
    }
  })
  it('plugin_http 返回非 200 时状态码原样透传', async () => {
    stubTauriInvoke(async () => pluginEnvelope(403, '{}'))
    try {
      await expect(fetchEpicFreeGames()).rejects.toThrow(/免费游戏列表加载失败：Epic 接口返回 403/)
    } finally {
      unStubWindow()
    }
  })
})

describe('freeGames bindEpicWithAuthCode 桌面通道', () => {
  it('换 token 与创建设备授权都走 plugin_http，form 体与头与旧 fetch 一致', async () => {
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
    const calls = stubTauriInvoke(async (_cmd, args) => {
      const u = String(args.url)
      if (u.includes('/oauth/token')) return pluginEnvelope(200, JSON.stringify({ access_token: 'AT', account_id: 'ACC' }))
      return pluginEnvelope(200, JSON.stringify({ deviceId: 'D', secret: 'S', accountId: 'ACC' }))
    })
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => { throw new Error('桌面通道下不应走 fetch') }) as typeof fetch
    try {
      const { initVault } = await import('./crypto')
      await initVault('testpwd8')
      const auth = await bindEpicWithAuthCode('CODE123', 'testpwd8')
      expect(auth.accountId).toBe('ACC')
      expect(auth.deviceId).toBe('D')
      expect(calls).toHaveLength(2)
      const tokCall = calls[0]
      expect(String(tokCall.args.url)).toContain('/oauth/token')
      expect(tokCall.args.method).toBe('POST')
      expect(JSON.parse(String(tokCall.args.headersJson))['Content-Type']).toBe('application/x-www-form-urlencoded')
      expect(JSON.parse(String(tokCall.args.headersJson)).Authorization).toMatch(/^Basic /)
      const params = new URLSearchParams(String(tokCall.args.body))
      expect(params.get('grant_type')).toBe('authorization_code')
      expect(params.get('code')).toBe('CODE123')
      expect(params.get('token_type')).toBe('eg1')
      const daCall = calls[1]
      expect(String(daCall.args.url)).toContain('device/auth')
      expect(JSON.parse(String(daCall.args.headersJson)).Authorization).toBe('Bearer AT')
    } finally {
      globalThis.fetch = origFetch
      unStubWindow()
    }
  })
})

describe('freeGames claimEpicGame 桌面通道', () => {
  it('quickPurchase 走 plugin_http，Bearer 头与下单体与旧 fetch 一致', async () => {
    const calls = stubTauriInvoke(async (_cmd, args) => {
      if (String(args.url).includes('quickPurchase')) {
        return pluginEnvelope(200, JSON.stringify({ quickPurchaseStatus: 'SUCCESS', orderId: 'OID-1' }))
      }
      return pluginEnvelope(200, '{}')
    })
    try {
      const orderId = await claimEpicGame('AT', 'ACC', fakeGame())
      expect(orderId).toBe('OID-1')
      expect(calls).toHaveLength(1)
      expect(String(calls[0].args.url)).toContain('quickPurchase')
      expect(calls[0].args.method).toBe('POST')
      expect(JSON.parse(String(calls[0].args.headersJson)).Authorization).toBe('Bearer AT')
      const body = JSON.parse(String(calls[0].args.body))
      expect(body.lineOffers[0].offerId).toBe('x1')
      expect(body.lineOffers[0].namespace).toBe('ns1')
    } finally {
      unStubWindow()
    }
  })
})
