// APIsFreeLLM 兜底通道（v0.1.433）：域名/模型常量、响应头解析、状态机与测活门槛。
// 真实端点对沙箱出口 IP 回 403 拒绝（2026-11-26 实测），故默认未启用；
// 这里用 mock fetch 验证解析与状态机，真可用性以 Ethan 在自己网络下点「测活」为准。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  APISFREE_BASE, APISFREE_MODEL, parseRateLimitHeaders, apisFreeRateText,
  loadApisFreeState, saveApisFreeState, apisFreeReady, chatApisFree, testApisFree,
} from './apisFree'

class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}
;(globalThis as any).localStorage = new MemStorage()

beforeEach(() => { (localStorage as any).clear() })
afterEach(() => vi.unstubAllGlobals())

describe('官方端点常量（防形近域名接错）', () => {
  it('Base URL 与模型与官方文档一致', () => {
    expect(APISFREE_BASE).toBe('https://api.apisfreellm.com/v1')
    expect(APISFREE_MODEL).toBe('free-ai')
  })
})

describe('parseRateLimitHeaders', () => {
  it('解析官方 X-RateLimit-* 头（大小写不敏感）', () => {
    const r = parseRateLimitHeaders({
      'X-RateLimit-Limit-Requests': '10000', 'x-ratelimit-remaining-requests': '9876',
      'X-RateLimit-Limit-Tokens': '10000000', 'X-RateLimit-Remaining-Tokens': '9990000',
    })
    expect(r?.limitRequests).toBe(10000)
    expect(r?.remainingRequests).toBe(9876)
    expect(r?.limitTokens).toBe(10000000)
    expect(r?.remainingTokens).toBe(9990000)
    expect(apisFreeRateText(r!)).toContain('9,876')
  })
  it('无有效字段返回 null，文案显示未知不编造', () => {
    expect(parseRateLimitHeaders({})).toBeNull()
    expect(parseRateLimitHeaders({ 'x-ratelimit-limit-requests': 'abc' })).toBeNull()
    expect(apisFreeRateText(undefined)).toContain('未知')
  })
})

describe('状态机与启用门槛', () => {
  it('默认未开启未验证，不可进链', () => {
    const s = loadApisFreeState()
    expect(s.enabled).toBe(false)
    expect(s.verifiedAt).toBe(0)
    expect(apisFreeReady(s)).toBe(false)
  })
  it('只开开关没测通仍不可进链；测通后才可', () => {
    saveApisFreeState({ enabled: true })
    expect(apisFreeReady()).toBe(false)
    saveApisFreeState({ verifiedAt: Date.now() })
    expect(apisFreeReady()).toBe(true)
    saveApisFreeState({ enabled: false })
    expect(apisFreeReady()).toBe(false)
  })
})

const fetchWithHeaders = (status: number, body: unknown, headers: Record<string, string> = {}) => vi.fn().mockResolvedValue({
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  headers: { forEach: (cb: (v: string, k: string) => void) => Object.entries(headers).forEach(([k, v]) => cb(v, k)) },
})

describe('chatApisFree / testApisFree（mock 上游）', () => {
  it('成功返回正文并把剩余量存进状态', async () => {
    vi.stubGlobal('fetch', fetchWithHeaders(200,
      { choices: [{ message: { content: '可用' } }] },
      { 'X-RateLimit-Remaining-Requests': '9999', 'X-RateLimit-Limit-Requests': '10000' }))
    const text = await chatApisFree([{ role: 'user', content: 'hi' }])
    expect(text).toBe('可用')
    expect(loadApisFreeState().rate?.remainingRequests).toBe(9999)
  })
  it('403 拒绝抛带状态码与原文的错误（不吞）', async () => {
    vi.stubGlobal('fetch', fetchWithHeaders(403, { error: { message: 'Request refused: policy' } }))
    await expect(chatApisFree([{ role: 'user', content: 'hi' }])).rejects.toThrow('403')
    await expect(chatApisFree([{ role: 'user', content: 'hi' }])).rejects.toThrow('Request refused')
  })
  it('测活成功 → verifiedAt 落库可进链；失败 → 清零并保存真实错误', async () => {
    vi.stubGlobal('fetch', fetchWithHeaders(200, { choices: [{ message: { content: '可用' } }] }))
    const ok = await testApisFree()
    expect(ok.ok).toBe(true)
    expect(loadApisFreeState().verifiedAt).toBeGreaterThan(0)
    vi.stubGlobal('fetch', fetchWithHeaders(403, { error: { message: 'Request refused: policy' } }))
    const bad = await testApisFree()
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain('403')
    const s = loadApisFreeState()
    expect(s.verifiedAt).toBe(0)
    expect(s.lastError).toContain('Request refused')
  })
})
