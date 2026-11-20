import { describe, expect, it } from 'vitest'
import {
  formatUsageBalance,
  getAdapter,
  parseDeepseekBalance,
  parseGlmBalance,
  parseMoonshotBalance,
  parseOpenrouterKeyInfo,
  parseSiliconflowUserInfo,
} from './adapters'

describe('余额接口解析', () => {
  it('DeepSeek：取 total_balance 并拆出充值/赠金明细', () => {
    const r = parseDeepseekBalance({
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }],
    })
    expect(r.remaining).toBe(110)
    expect(r.total).toBe(110)
    expect(r.used).toBe(0)
    expect(r.symbol).toBe('¥')
    expect(r.detail).toBe('充值 ¥100 · 赠金 ¥10')
  })

  it('DeepSeek：美元账户用 $ 且无赠金时不带明细', () => {
    const r = parseDeepseekBalance({
      balance_infos: [{ currency: 'USD', total_balance: '5.5', granted_balance: '0.00', topped_up_balance: '5.5' }],
    })
    expect(r.symbol).toBe('$')
    expect(r.detail).toBe('充值 $5.5')
  })

  it('DeepSeek：结构不对时抛可读错误', () => {
    expect(() => parseDeepseekBalance({})).toThrow(/无法识别/)
  })

  it('Kimi：取 available_balance，代金券进明细', () => {
    const r = parseMoonshotBalance({ code: 0, data: { available_balance: 42.5, voucher_balance: 10, cash_balance: 32.5 }, status: true })
    expect(r.remaining).toBe(42.5)
    expect(r.detail).toBe('含代金券 ¥10')
  })

  it('Kimi：无代金券时无明细', () => {
    const r = parseMoonshotBalance({ code: 0, data: { available_balance: 3, voucher_balance: 0, cash_balance: 3 } })
    expect(r.remaining).toBe(3)
    expect(r.detail).toBeUndefined()
  })

  it('GLM：防御式提取 data.balance', () => {
    expect(parseGlmBalance({ code: 200, data: { balance: 88 } }).remaining).toBe(88)
    expect(parseGlmBalance({ data: { available_balance: '12.5' } }).remaining).toBe(12.5)
  })

  it('GLM：未知结构抛带原文的错误', () => {
    expect(() => parseGlmBalance({ code: 200, data: { foo: 1 } })).toThrow(/无法识别/)
  })

  it('硅基流动：取 data.balance 字符串', () => {
    const r = parseSiliconflowUserInfo({ code: 20000, data: { balance: '25.60', chargeBalance: '100', totalBalance: '125.60' } })
    expect(r.remaining).toBeCloseTo(25.6)
    expect(r.symbol).toBe('¥')
  })

  it('OpenRouter：有限额度算剩余', () => {
    const r = parseOpenrouterKeyInfo({ data: { usage: 12.5, limit: 50, limit_remaining: 37.5 } })
    expect(r.remaining).toBe(37.5)
    expect(r.used).toBe(12.5)
    expect(r.total).toBe(50)
    expect(r.detail).toBe('总额度 $50')
  })

  it('OpenRouter：无上限走 label', () => {
    const r = parseOpenrouterKeyInfo({ data: { usage: 3, limit: null } })
    expect(r.label).toContain('无额度上限')
    expect(r.remaining).toBeUndefined()
  })
})

describe('getAdapter.supported（余额可用性只看端点，不看目录 modes）', () => {
  it('已接端点的平台均可用（目录里 modes 为 manual 也不影响）', () => {
    for (const id of ['deepseek', 'kim', 'glm', 'siliconflow', 'openrouter']) {
      expect(getAdapter(id).supported, id).toBe(true)
    }
  })
  it('无端点的平台不可用', () => {
    expect(getAdapter('doubao').supported).toBe(false)
  })
})

describe('formatUsageBalance', () => {
  it('余额型：符号+金额+明细', () => {
    expect(formatUsageBalance({ used: 0, total: 110, unit: 'currency', remaining: 110, symbol: '¥', detail: '充值 ¥100 · 赠金 ¥10' }))
      .toBe('剩余 ¥110 · 充值 ¥100 · 赠金 ¥10')
  })
  it('label 优先', () => {
    expect(formatUsageBalance({ used: 3, unit: 'currency', label: '已用 $3 · 该 Key 无额度上限' })).toBe('已用 $3 · 该 Key 无额度上限')
  })
  it('用量型：回落到 total-used', () => {
    expect(formatUsageBalance({ used: 40, total: 100, unit: 'token' })).toBe('剩余 60 token')
  })
})
