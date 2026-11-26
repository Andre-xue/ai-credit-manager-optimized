import { describe, it, expect, beforeEach } from 'vitest'

// 内存版 localStorage polyfill（node 环境，与其他 core 测试同款）
class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}
;(globalThis as any).localStorage = new MemStorage()
;(globalThis as any).window = globalThis

import type { Account } from './types'
import type { WorkshopRouteData } from './workshopChat'
import {
  buildProviderInfos, pickTranslatorEngine, enabledProviderSummaries,
  formatDurationMs, loadProviderPrefs, saveProviderPref,
  loadTranslatorEngineKey, saveTranslatorEngineKey,
  TRANSLATOR_PROVIDERS_KEY, TRANSLATOR_ENGINE_KEY,
} from './translatorProviders'

function acct(id: string, providerId: string, label: string): Account {
  return { id, providerId, label, mode: 'api', createdAt: '2026-01-01', updatedAt: '2026-01-01' } as Account
}

function fixture(): { data: WorkshopRouteData; accounts: Account[] } {
  const accounts = [acct('a1', 'deepseek', 'DeepSeek 官方'), acct('a2', 'moma', 'MoMA')]
  const data: WorkshopRouteData = {
    freeOptions: [
      { key: 'cloud:m1', label: 'CloudMock', group: '云端免费', source: 'cloud', modelId: 'm1' },
      { key: 'zen:m2', label: 'ZenMock', group: 'Zen 免费通道', source: 'zen' as never, modelId: 'm2' },
    ],
    routes: [
      { kind: 'free', key: 'free:cloud:m1', label: '免费 · CloudMock' },
      { kind: 'free', key: 'free:zen:m2', label: '免费 · ZenMock' },
      { kind: 'account', key: 'acct:a1', label: 'DeepSeek 官方', accountId: 'a1', engine: 'deepseek-flash' },
      { kind: 'account', key: 'acct:a2', label: 'MoMA（MoMA 待实测，未启用）', accountId: 'a2', engine: 'jiutian-35b', disabledReason: 'MoMA 待实测' },
      { kind: 'wbpool', key: 'wbpool', label: 'WorkBuddy 账号池' },
    ],
  }
  return { data, accounts }
}

describe('v0.1.477 buildProviderInfos', () => {
  it('全部来源列全：免费路线逐条、自有账户、账号池；默认全启用', () => {
    const { data, accounts } = fixture()
    const infos = buildProviderInfos(data, accounts, {})
    expect(infos.map(i => i.key)).toEqual(['free:cloud:m1', 'free:zen:m2', 'acct:a1', 'acct:a2', 'wbpool'])
    expect(infos.every(i => i.enabled)).toBe(true)
  })

  it('自有账户模型选项来自引擎目录，偏好 modelId 写入执行路线', () => {
    const { data, accounts } = fixture()
    const infos = buildProviderInfos(data, accounts, { 'acct:a1': { modelId: 'deepseek-v4-pro' } })
    const ds = infos.find(i => i.key === 'acct:a1')!
    expect(ds.modelOptions.length).toBeGreaterThan(1)
    expect(ds.modelOptions).toContain('deepseek-v4-pro')
    expect(ds.modelId).toBe('deepseek-v4-pro')
    expect(ds.route.kind === 'account' && ds.route.modelId).toBe('deepseek-v4-pro')
  })

  it('偏好 modelId 不在目录里时回落到默认模型，不硬塞', () => {
    const { data, accounts } = fixture()
    const infos = buildProviderInfos(data, accounts, { 'acct:a1': { modelId: 'no-such-model' } })
    const ds = infos.find(i => i.key === 'acct:a1')!
    expect(ds.modelId).not.toBe('no-such-model')
    expect(ds.modelOptions).toContain(ds.modelId)
  })

  it('无目录平台（MoMA）模型单项固定，门槛原因如实带出，标签用账户名不带后缀', () => {
    const { data, accounts } = fixture()
    const infos = buildProviderInfos(data, accounts, {})
    const moma = infos.find(i => i.key === 'acct:a2')!
    expect(moma.modelOptions).toEqual(['jiutian-35b'])
    expect(moma.disabledReason).toBe('MoMA 待实测')
    expect(moma.label).toBe('MoMA')
  })

  it('启用开关与测速耗时从偏好回填', () => {
    const { data, accounts } = fixture()
    const infos = buildProviderInfos(data, accounts, {
      'free:zen:m2': { enabled: false },
      'acct:a1': { ms: 900 },
    })
    expect(infos.find(i => i.key === 'free:zen:m2')!.enabled).toBe(false)
    expect(infos.find(i => i.key === 'acct:a1')!.ms).toBe(900)
  })
})

describe('v0.1.477 pickTranslatorEngine', () => {
  it('用户选中的已启用服务商优先（哪怕不是最快）', () => {
    const { data, accounts } = fixture()
    const infos = buildProviderInfos(data, accounts, { 'free:cloud:m1': { ms: 300 }, 'acct:a1': { ms: 5000 } })
    expect(pickTranslatorEngine(infos, 'acct:a1')!.key).toBe('acct:a1')
  })

  it('选中项被关掉时回落到已启用里实测最快者', () => {
    const { data, accounts } = fixture()
    const infos = buildProviderInfos(data, accounts, {
      'acct:a1': { enabled: false, ms: 100 },
      'free:cloud:m1': { ms: 2400 },
      'free:zen:m2': { ms: 800 },
    })
    expect(pickTranslatorEngine(infos, 'acct:a1')!.key).toBe('free:zen:m2')
  })

  it('没有任何测速数据时取第一个已启用', () => {
    const { data, accounts } = fixture()
    const infos = buildProviderInfos(data, accounts, { 'free:cloud:m1': { enabled: false } })
    expect(pickTranslatorEngine(infos, '')!.key).toBe('free:zen:m2')
  })

  it('一个都没启用返回 null（调用方如实提示，不偷换）', () => {
    const { data, accounts } = fixture()
    const prefs = Object.fromEntries(infos0Keys().map(k => [k, { enabled: false }]))
    const infos = buildProviderInfos(data, accounts, prefs)
    expect(pickTranslatorEngine(infos, '')).toBeNull()
    function infos0Keys() { return data.routes.map(r => r.key) }
  })
})

describe('v0.1.477 enabledProviderSummaries（小窗下拉过滤）', () => {
  it('关掉的服务商不出现在摘要里，耗时带出', () => {
    const { data, accounts } = fixture()
    const infos = buildProviderInfos(data, accounts, {
      'free:zen:m2': { enabled: false },
      'acct:a1': { ms: 900 },
    })
    const sums = enabledProviderSummaries(infos)
    expect(sums.map(s => s.key)).toEqual(['free:cloud:m1', 'acct:a1', 'acct:a2', 'wbpool'])
    expect(sums.find(s => s.key === 'acct:a1')!.ms).toBe(900)
    expect(sums.find(s => s.key === 'free:cloud:m1')!.ms).toBeUndefined()
  })
})

describe('v0.1.477 偏好存取与耗时格式', () => {
  beforeEach(() => { localStorage.clear() })

  it('saveProviderPref 合并写入、loadProviderPrefs 读回', () => {
    saveProviderPref('acct:a1', { enabled: false })
    saveProviderPref('acct:a1', { ms: 1234 })
    expect(loadProviderPrefs()['acct:a1']).toEqual({ enabled: false, ms: 1234 })
    expect(JSON.parse(localStorage.getItem(TRANSLATOR_PROVIDERS_KEY)!)).toHaveProperty('acct:a1')
  })

  it('引擎选择键存取', () => {
    expect(loadTranslatorEngineKey()).toBe('')
    saveTranslatorEngineKey('free:zen:m2')
    expect(loadTranslatorEngineKey()).toBe('free:zen:m2')
    expect(localStorage.getItem(TRANSLATOR_ENGINE_KEY)).toBe('free:zen:m2')
  })

  it('formatDurationMs：亚秒给毫秒、秒级一位小数', () => {
    expect(formatDurationMs(240)).toBe('240ms')
    expect(formatDurationMs(900)).toBe('900ms')
    expect(formatDurationMs(1000)).toBe('1.0s')
    expect(formatDurationMs(25426)).toBe('25.4s')
  })
})
