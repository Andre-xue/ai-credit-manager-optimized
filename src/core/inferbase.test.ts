// Inferbase 接入（v0.1.432）：平台预设、余额/用量解析、健康状态机与启用门槛。
// 沙箱无 Ethan 的真实 Key：/credits、/usage、聊天冒烟用 mock 验证解析与状态机；
// 真实 Key 的余额/聊天冒烟待 Ethan 在 App 里加 Key 后实测（健康检查即冒烟入口）。
import { describe, it, expect, beforeEach } from 'vitest'
import { PROVIDER_MAP } from '../data/providers'
import { getAdapter, parseInferbaseBalance } from './adapters'
import {
  parseInferbaseModels, parseInferbaseCredits, parseInferbaseUsage, parseInferbaseTransactions,
  buildInferbaseAccountData, classifyInferbaseHttp, inferbaseStateFromError, InferbaseApiError,
  inferbaseGate, recordInferbaseVerification, INFERBASE_FREE_LIMITS,
} from './inferbase'

class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}
;(globalThis as any).localStorage = new MemStorage()

describe('Inferbase 平台预设', () => {
  it('目录里有 inferbase，Base URL 与官方一致', () => {
    const p = PROVIDER_MAP['inferbase']
    expect(p).toBeTruthy()
    expect(p.apiBaseUrl).toBe('https://api.inferbase.ai/v1')
  })
  it('余额适配器已支持（第五家自动查余额）', () => {
    expect(getAdapter('inferbase').supported).toBe(true)
  })
  it('免费档限额常量与官方一致', () => {
    expect(INFERBASE_FREE_LIMITS.monthlyRequests).toBe(5000)
    expect(INFERBASE_FREE_LIMITS.dailyManagedRequests).toBe(100)
    expect(INFERBASE_FREE_LIMITS.dailyManagedCreditUsd).toBe(0.5)
    expect(INFERBASE_FREE_LIMITS.keyRpm).toBe(60)
    expect(INFERBASE_FREE_LIMITS.managedOrgRpm).toBe(10)
  })
})

describe('Inferbase 解析（mock 官方返回）', () => {
  it('模型列表：取 data[].id/name，auto 在首位', () => {
    const models = parseInferbaseModels({
      object: 'list',
      data: [
        { id: 'auto', name: 'Inferbase Auto - Smart Routing', object: 'model' },
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', object: 'model' },
      ],
    })
    expect(models.map(m => m.id)).toEqual(['auto', 'deepseek-v4-flash'])
    expect(models[0].name).toContain('Auto')
  })
  it('余额：取美元余额并拆赠送/充值', () => {
    const c = parseInferbaseCredits({ balance_usd: 12.34, granted_usd: 10, purchased_usd: 2.34 })
    expect(c.balanceUsd).toBe(12.34)
    expect(c.grantedUsd).toBe(10)
    expect(c.purchasedUsd).toBe(2.34)
  })
  it('余额：结构对不上时抛可读错误（不编造）', () => {
    expect(() => parseInferbaseCredits({ hello: 'world' })).toThrow(/无法识别/)
  })
  // Ethan 2026-11-26 05:08 实机冒烟截图里的真实返回（截图在 "reques 处截断，
  // 本样本保留全部完整可见字段）：credits 是 *_micros 微美元体系，432 报「无法识别」卡死冒烟。
  const ETHAN_CREDITS_437 = {
    available_formatted: '$0.00', available_micros: 0,
    balance_formatted: '$0.00', balance_micros: 0,
    held_micros: 0, included_expires_at: null, included_micros: 0,
    purchased_available_micros: 0,
  }
  it('余额（437 回归）：真实 micros 结构解析出 $0.00，不再报无法识别', () => {
    const c = parseInferbaseCredits(ETHAN_CREDITS_437)
    expect(c.balanceUsd).toBe(0)
    expect(c.availableUsd).toBe(0)
    expect(c.heldUsd).toBe(0)
    expect(c.includedUsd).toBe(0)
    expect(c.purchasedUsd).toBe(0)
  })
  it('余额（437 回归）：micros 按 1e6 换算，included 进赠送、purchased_available 进充值', () => {
    const c = parseInferbaseCredits({
      balance_micros: 3_250_000, available_micros: 3_000_000, held_micros: 100_000,
      included_micros: 500_000, purchased_available_micros: 2_500_000,
      balance_formatted: '$3.25', available_formatted: '$3.00',
    })
    expect(c.balanceUsd).toBe(3.25)
    expect(c.availableUsd).toBe(3)
    expect(c.heldUsd).toBe(0.1)
    expect(c.includedUsd).toBe(0.5)
    expect(c.grantedUsd).toBe(0.5)
    expect(c.purchasedUsd).toBe(2.5)
  })
  it('余额（437 回归）：只有 formatted 字符串时也能兜底解析', () => {
    expect(parseInferbaseCredits({ balance_formatted: '$12.34' }).balanceUsd).toBe(12.34)
  })
  it('组合（437 回归）：真实 credits + 用量失败标记 → 余额成立、失败只降级明细', () => {
    const data = buildInferbaseAccountData({
      credits: ETHAN_CREDITS_437,
      usage: { __error: 'usage boom', status: 500 },
      transactions: { data: [] },
    })
    expect(data.credits.balanceUsd).toBe(0)
    expect(data.partialErrors.join(' ')).toContain('用量同步失败')
    const r = parseInferbaseBalance(data)
    expect(r.remaining).toBe(0)
    expect(r.total).toBe(0)
  })
  it('用量：按时间戳聚合本月与近 24h、tokens 与花费（cost_micros 换算）', () => {
    const now = Date.parse('2026-11-26T12:00:00Z')
    const agg = parseInferbaseUsage({
      data: [
        { model: 'auto', input_tokens: 100, output_tokens: 50, cost_usd: 0.01, status: 'success', created_at: '2026-11-26T10:00:00Z' },
        { model: 'auto', total_tokens: 200, cost_micros: 5000, status: 'error', created_at: '2026-11-25T13:00:00Z' },
        { model: 'auto', total_tokens: 300, cost_usd: 0.02, status: 'success', created_at: '2026-10-01T00:00:00Z' },
      ],
    }, now)
    expect(agg.rowsReturned).toBe(3)
    expect(agg.totalTokens).toBe(650)
    expect(agg.totalCostUsd).toBeCloseTo(0.035)
    expect(agg.monthRequests).toBe(2)
    expect(agg.last24hRequests).toBe(2)
    expect(agg.failedRequests).toBe(1)
  })
  it('用量：无时间戳时不编造月度数字', () => {
    const agg = parseInferbaseUsage({ data: [{ model: 'auto', total_tokens: 10, cost_usd: 0 }] })
    expect(agg.monthRequests).toBeUndefined()
    expect(agg.last24hRequests).toBeUndefined()
  })
  it('交易：计数并给出最近一条', () => {
    const tx = parseInferbaseTransactions({ data: [{ type: 'usage_deduction', amount_usd: -0.01 }, { type: 'topup', amount_usd: 5 }] })
    expect(tx.count).toBe(2)
    expect(tx.latestText).toContain('usage_deduction')
  })
  it('组合 → 额度看板：余额 $0 也成立（免费新账户），明细含限额对照与部分失败原因', () => {
    const now = Date.now()
    const data = buildInferbaseAccountData({
      credits: { balance_usd: 0 },
      usage: { data: [{ model: 'auto', total_tokens: 10, cost_usd: 0.001, status: 'success', created_at: new Date(now).toISOString() }] },
      transactions: { __error: 'boom', status: 500 },
    })
    const r = parseInferbaseBalance(data)
    expect(r.remaining).toBe(0)
    expect(r.total).toBe(0)
    expect(r.detail).toContain('本月请求 1 / 5,000 次')
    expect(r.detail).toContain('近 24h 请求 1 次（托管上限 100/天）')
    expect(r.detail).toContain('交易记录同步失败')
    expect(r.detail).toContain('boom')
  })
})

describe('Inferbase 状态机（供 433 自动切换链消费）', () => {
  it('HTTP 状态归类：401 密钥失效 / 402 额度不足 / 429 限流（带 Retry-After）', () => {
    expect(classifyInferbaseHttp(401, 'Invalid API key.').state).toBe('auth_invalid')
    expect(classifyInferbaseHttp(402, 'plan_limit').state).toBe('quota_exceeded')
    const r = classifyInferbaseHttp(429, 'Too Many Requests', 30)
    expect(r.state).toBe('rate_limited')
    expect(r.retryAfterSec).toBe(30)
  })
  it('文本错误归类：模型不存在 / 网络 / CORS', () => {
    expect(inferbaseStateFromError(new Error("Model 'x' does not exist"))).toBe('model_unavailable')
    // v0.1.464：400 model_not_found（官方措辞 code + "is not available"）如实归类
    expect(classifyInferbaseHttp(400, 'The requested model is not available on this endpoint.').state).toBe('model_unavailable')
    expect(inferbaseStateFromError(new Error('接口返回 400：{"error":{"code":"model_not_found","message":"The requested model is not available on this endpoint."}}'))).toBe('model_unavailable')
    expect(inferbaseStateFromError(new TypeError('Failed to fetch'))).toBe('network_error')
    expect(inferbaseStateFromError(new InferbaseApiError('x', 'quota_exceeded', 402))).toBe('quota_exceeded')
  })
})

describe('Inferbase 启用门槛（冒烟未通过不得启用）', () => {
  const acct = { id: 'ib1', providerId: 'inferbase', keyFingerprint: 'fp-1' }
  beforeEach(() => { ;(localStorage as any).clear() })
  it('无验证记录 → 待实测未启用', () => {
    const g = inferbaseGate(acct)
    expect(g.enabled).toBe(false)
    expect(g.state).toBe('pending_verification')
    expect(g.message).toContain('健康检查')
  })
  it('冒烟通过（同指纹）→ 启用', () => {
    recordInferbaseVerification(acct, 'verified', 'available', '冒烟通过')
    const g = inferbaseGate(acct)
    expect(g.enabled).toBe(true)
    expect(g.state).toBe('available')
  })
  it('冒烟失败 → 保持未启用并带真实状态', () => {
    recordInferbaseVerification(acct, 'failed', 'quota_exceeded', 'Inferbase 接口返回 402：plan_limit')
    const g = inferbaseGate(acct)
    expect(g.enabled).toBe(false)
    expect(g.state).toBe('quota_exceeded')
    expect(g.message).toContain('402')
  })
  it('换 Key（指纹变了）→ 自动回到待实测', () => {
    recordInferbaseVerification(acct, 'verified', 'available', '冒烟通过')
    const g = inferbaseGate({ ...acct, keyFingerprint: 'fp-2' })
    expect(g.enabled).toBe(false)
    expect(g.state).toBe('pending_verification')
  })
  it('非 Inferbase 账户不受门槛影响', () => {
    expect(inferbaseGate({ id: 'x', providerId: 'deepseek' }).enabled).toBe(true)
  })
})
