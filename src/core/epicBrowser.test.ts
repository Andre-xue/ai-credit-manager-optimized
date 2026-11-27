// v0.1.397 内嵌浏览器自动领：hash 结果解析、文案、记录回落的单测。
// 注意：Rust 注入脚本（lib.rs 的 AUTO_CLAIM_JS）本身无法在 vitest 里跑，
// 它的行为由无头验证 verify397.mjs 对着模拟 Epic 结账页实测；这里只覆盖
// TS 侧的纯逻辑 + 记录回落（396 手动兜底不断是底线）。
import { describe, it, expect, beforeEach } from 'vitest'
import {
  parseEpicBrowserOutcome,
  epicBrowserOutcomeText,
  recordEpicBrowserOutcome,
  isEpicBrowserSupported,
  claimFailureFallback,
  EPIC_BROWSER_STATUS_KEY,
  loadEpicBrowserStatus,
  saveEpicBrowserStatus,
  clearEpicBrowserStatus,
  epicBrowserStatusVisible,
  EPIC_BROWSER_STATUS_TTL_MS,
} from './epicBrowser'
import { readRecords, clearRecords, addRecord, RECORDS_KEY } from './freeGames'

function ensureLocalStorage(): Map<string, string> {
  const g = globalThis as unknown as Record<string, unknown>
  if (!g.localStorage) {
    const m = new Map<string, string>()
    g.localStorage = {
      getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
      setItem: (k: string, v: string) => { m.set(k, v) },
      removeItem: (k: string) => { m.delete(k) },
      clear: () => m.clear(),
    }
    return m
  }
  const ls = g.localStorage as { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void; removeItem: (k: string) => void }
  ls.removeItem(RECORDS_KEY)
  ls.removeItem(EPIC_BROWSER_STATUS_KEY)
  return new Map()
}

describe('parseEpicBrowserOutcome', () => {
  it('从完整结账 URL 的 hash 里解析结果', () => {
    expect(parseEpicBrowserOutcome('https://www.epicgames.com/store/purchase?offers=1-ns-x#epic-claim=claimed')).toBe('claimed')
    expect(parseEpicBrowserOutcome('https://www.epicgames.com/store/purchase#epic-claim=challenge')).toBe('challenge')
    expect(parseEpicBrowserOutcome('#epic-claim=clicked')).toBe('clicked')
    expect(parseEpicBrowserOutcome('#epic-claim=needs-manual')).toBe('needs-manual')
    expect(parseEpicBrowserOutcome('#epic-claim=login')).toBe('login')
    expect(parseEpicBrowserOutcome('#epic-claim=timeout')).toBe('timeout')
  })
  it('没有标记或不认识的值返回 null', () => {
    expect(parseEpicBrowserOutcome('https://www.epicgames.com/store/purchase?offers=1-ns-x')).toBeNull()
    expect(parseEpicBrowserOutcome('#epic-claim=bogus')).toBeNull()
    expect(parseEpicBrowserOutcome('')).toBeNull()
    expect(parseEpicBrowserOutcome(null)).toBeNull()
    expect(parseEpicBrowserOutcome(undefined)).toBeNull()
  })
})

describe('epicBrowserOutcomeText', () => {
  it('每个结果都有中文文案，未知结果给默认文案', () => {
    for (const o of ['clicked', 'claimed', 'needs-manual', 'challenge', 'login', 'timeout']) {
      const t = epicBrowserOutcomeText(o)
      expect(t.length).toBeGreaterThan(5)
      expect(t).toMatch(/内嵌浏览器/)
    }
    expect(epicBrowserOutcomeText('bogus')).toContain('内嵌浏览器')
  })
})

describe('recordEpicBrowserOutcome', () => {
  beforeEach(() => { ensureLocalStorage(); clearRecords() })

  it('claimed 写领取成功记录', () => {
    expect(recordEpicBrowserOutcome('claimed', 'Mark of the Deep')).toBe(true)
    const rs = readRecords()
    expect(rs).toHaveLength(1)
    expect(rs[0].outcome).toBe('claimed')
    expect(rs[0].title).toBe('Mark of the Deep')
  })

  it('clicked 是中间态，不写记录', () => {
    expect(recordEpicBrowserOutcome('clicked', 'Mark of the Deep')).toBe(false)
    expect(readRecords()).toHaveLength(0)
  })

  it('失败结果写 error 记录并保留 checkoutUrl（396 手动兜底不断）', () => {
    const url = 'https://www.epicgames.com/store/purchase?highlightColor=0078f2&offers=1-ns-x&orderId&purchaseToken&showNavigation=true'
    // 每种失败结果单独写时：都是 error 记录、带 checkoutUrl、文案点名各自原因
    const cases: Array<[string, string]> = [
      ['needs-manual', '没找到领取按钮'],
      ['challenge', '人机验证'],
      ['login', '没登录'],
      ['timeout', '没等到领取结果'],
    ]
    for (const [o, frag] of cases) {
      clearRecords()
      expect(recordEpicBrowserOutcome(o, 'Mark of the Deep', url)).toBe(true)
      const rs = readRecords()
      expect(rs).toHaveLength(1)
      expect(rs[0].outcome).toBe('error')
      expect(rs[0].checkoutUrl).toBe(url)
      expect(rs[0].message).toContain('去浏览器领')
      expect(rs[0].message).toContain(frag)
    }
    // v0.1.502 去重：同一游戏连续多次失败只保留最新一条（不再堆 4 条同类报错）
    clearRecords()
    for (const o of ['needs-manual', 'challenge', 'login', 'timeout']) {
      expect(recordEpicBrowserOutcome(o, 'Mark of the Deep', url)).toBe(true)
    }
    const rs = readRecords()
    expect(rs).toHaveLength(1)
    expect(rs[0].outcome).toBe('error')
    expect(rs[0].checkoutUrl).toBe(url)
    expect(rs[0].message).toContain('没等到领取结果')
  })

  it('失败记录没带 checkoutUrl 时不写 checkoutUrl 字段', () => {
    recordEpicBrowserOutcome('challenge', 'Mark of the Deep')
    expect(readRecords()[0].checkoutUrl).toBeUndefined()
  })
})

describe('epicBrowserStatus 持久化', () => {
  it('保存后能读回', () => {
    ensureLocalStorage()
    saveEpicBrowserStatus('内嵌浏览器遇到人机验证，请在窗口内完成验证后再手动点领取')
    expect(loadEpicBrowserStatus()).toContain('人机验证')
  })
})

describe('isEpicBrowserSupported', () => {
  it('非桌面环境（vitest node）返回 false', () => {
    expect(isEpicBrowserSupported()).toBe(false)
  })
})

describe('claimFailureFallback（v0.1.404）', () => {
  it('非桌面（无 Tauri）直接走系统浏览器', () => {
    expect(claimFailureFallback()).toBe('external')
  })
  it('桌面（有 __TAURI_INTERNALS__）先走 App 内嵌浏览器', () => {
    const g = globalThis as unknown as Record<string, unknown>
    const prev = g.window
    g.window = { __TAURI_INTERNALS__: {} }
    try {
      expect(claimFailureFallback()).toBe('in-app')
    } finally {
      if (prev === undefined) delete g.window
      else g.window = prev
    }
  })
})

describe('epicBrowserStatus 生命周期（v0.1.502）', () => {
  function storage() {
    return (globalThis as unknown as { localStorage: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } }).localStorage
  }

  it('旧版纯文本残留（无时间戳）：读回为空且存储被清掉', () => {
    ensureLocalStorage()
    storage().setItem(EPIC_BROWSER_STATUS_KEY, '内嵌浏览器里没等到领取结果，请在窗口内看一眼是否已领取')
    expect(loadEpicBrowserStatus()).toBeNull()
    expect(storage().getItem(EPIC_BROWSER_STATUS_KEY)).toBeNull()
  })

  it('超过 24 小时的状态：自动撤下', () => {
    ensureLocalStorage()
    storage().setItem(EPIC_BROWSER_STATUS_KEY, JSON.stringify({
      text: '内嵌浏览器遇到人机验证，请在窗口内完成验证后再手动点领取',
      at: Date.now() - EPIC_BROWSER_STATUS_TTL_MS - 1,
    }))
    expect(loadEpicBrowserStatus()).toBeNull()
    expect(storage().getItem(EPIC_BROWSER_STATUS_KEY)).toBeNull()
  })

  it('对应游戏已被确认领取：自动撤下', () => {
    ensureLocalStorage()
    clearRecords()
    addRecord({ at: Date.now(), platform: 'epic', title: 'Bread and Fred', outcome: 'claimed', message: '领到了' })
    saveEpicBrowserStatus('内嵌浏览器里没等到领取结果，请在窗口内看一眼是否已领取', 'Bread and Fred')
    expect(loadEpicBrowserStatus()).toBeNull()
  })

  it('未过期且游戏未领取：正常读回；clearEpicBrowserStatus 可手动清', () => {
    ensureLocalStorage()
    clearRecords()
    saveEpicBrowserStatus('内嵌浏览器遇到人机验证，请在窗口内完成验证后再手动点领取', 'Bread and Fred')
    expect(loadEpicBrowserStatus()).toContain('人机验证')
    clearEpicBrowserStatus()
    expect(loadEpicBrowserStatus()).toBeNull()
  })

  it('epicBrowserStatusVisible 纯判定：空文案/过期/已领取都不显示', () => {
    const now = Date.now()
    const none = new Set<string>()
    expect(epicBrowserStatusVisible({ text: '', at: now }, now, none)).toBe(false)
    expect(epicBrowserStatusVisible({ text: 'x', at: now - EPIC_BROWSER_STATUS_TTL_MS }, now, none)).toBe(false)
    expect(epicBrowserStatusVisible({ text: 'x', at: now, title: 'G' }, now, new Set(['epic:G']))).toBe(false)
    expect(epicBrowserStatusVisible({ text: 'x', at: now, title: 'G' }, now, none)).toBe(true)
    expect(epicBrowserStatusVisible({ text: 'x', at: now }, now, none)).toBe(true)
  })
})
