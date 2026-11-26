// v0.1.479：Key 管理页筛选纯逻辑——类型/分组/平台三路筛选、平台只列有账户的、
// 额度下拉的分组统计与按钮文案数据。
import { describe, it, expect } from 'vitest'
import {
  KEY_FILTER_ALL, KEY_FILTER_NONE,
  keyCategories, keyGroups, keyPlatforms, filterKeyAccounts,
  currencyRemaining, keyQuotaStats, quotaSelectionDisplay,
} from './keyFilters'
import type { Account, QuotaSnapshot } from './types'

const ACC = (id: string, providerId: string, note?: string, group?: string): Account => ({
  id, providerId, label: id, mode: 'api', encryptedKey: 'enc', note, group,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
})
const Q = (accountId: string, used: number, total: number, unit: QuotaSnapshot['unit'], capturedAt = '2026-01-02T00:00:00Z'): QuotaSnapshot => ({
  id: `q-${accountId}-${capturedAt}`, accountId, used, total, unit, capturedAt, source: 'api',
})

const accounts: Account[] = [
  ACC('a1', 'deepseek', '[对话型] 日常', 'AI助手'),
  ACC('a2', 'kim', '[对话型] 长文', 'AI助手'),
  ACC('a3', 'siliconflow', '[图像生成] 出图', '图像生成'),
  ACC('a4', 'openrouter', '[对话型] 备用'),
  ACC('a5', 'openai', '[语音] 合成', 'AI助手'),
  ACC('a6', 'deepseek', '[对话型] 备用二'),
]
const quotas: QuotaSnapshot[] = [
  Q('a1', 16.8, 50, 'currency'),
  Q('a2', 20, 20, 'currency'),
  Q('a3', 4, 10, 'currency'),
  Q('a5', 5, 100, 'request'),
  Q('a6', 1, 5, 'currency'),
]
const sel = (category = KEY_FILTER_ALL, group = KEY_FILTER_ALL, platform = KEY_FILTER_ALL) => ({ category, group, platform })
const ids = (list: Account[]) => list.map(a => a.id)

describe('keyFilters 列表', () => {
  it('类型 = 备注分类去重排序', () => {
    expect(keyCategories(accounts)).toEqual(['图像生成', '对话型', '语音'])
  })
  it('分组 = 已有分组名去重排序，不含未分组', () => {
    expect(keyGroups(accounts)).toEqual(['AI助手', '图像生成'])
  })
  it('平台只列有账户的平台并带计数（计数降序稳定排序）', () => {
    expect(keyPlatforms(accounts)).toEqual([
      { id: 'deepseek', count: 2 },
      { id: 'kim', count: 1 },
      { id: 'openai', count: 1 },
      { id: 'openrouter', count: 1 },
      { id: 'siliconflow', count: 1 },
    ])
    // 没账户的平台绝不出现
    expect(keyPlatforms(accounts).some(p => p.id === 'anthropic')).toBe(false)
    expect(keyPlatforms([])).toEqual([])
  })
})

describe('filterKeyAccounts 三路筛选', () => {
  it('全不过滤返回全部', () => {
    expect(ids(filterKeyAccounts(accounts, sel()))).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6'])
  })
  it('按类型筛选', () => {
    expect(ids(filterKeyAccounts(accounts, sel('图像生成')))).toEqual(['a3'])
    expect(ids(filterKeyAccounts(accounts, sel('对话型')))).toEqual(['a1', 'a2', 'a4', 'a6'])
  })
  it('按分组筛选，__none__ = 未分组', () => {
    expect(ids(filterKeyAccounts(accounts, sel(KEY_FILTER_ALL, 'AI助手')))).toEqual(['a1', 'a2', 'a5'])
    expect(ids(filterKeyAccounts(accounts, sel(KEY_FILTER_ALL, KEY_FILTER_NONE)))).toEqual(['a4', 'a6'])
  })
  it('按平台筛选（新增维度）', () => {
    expect(ids(filterKeyAccounts(accounts, sel(KEY_FILTER_ALL, KEY_FILTER_ALL, 'deepseek')))).toEqual(['a1', 'a6'])
    expect(ids(filterKeyAccounts(accounts, sel(KEY_FILTER_ALL, KEY_FILTER_ALL, 'openrouter')))).toEqual(['a4'])
  })
  it('三路叠加取交集', () => {
    expect(ids(filterKeyAccounts(accounts, sel('对话型', KEY_FILTER_NONE, 'deepseek')))).toEqual(['a6'])
    expect(ids(filterKeyAccounts(accounts, sel('语音', 'AI助手', 'deepseek')))).toEqual([])
  })
})

describe('额度统计（额度下拉数据）', () => {
  it('currencyRemaining 只计 currency 最新快照、负数按 0', () => {
    expect(currencyRemaining(accounts, quotas)).toBeCloseTo(43.2)
    // request 单位不计入 ¥
    expect(currencyRemaining([accounts[4]], quotas)).toBe(0)
    // 超用（used>total）按 0 不倒扣
    expect(currencyRemaining([ACC('x', 'deepseek')], [Q('x', 30, 20, 'currency')])).toBe(0)
    // 同账户多快照取最新 capturedAt
    const multi = [Q('a1', 50, 50, 'currency', '2026-01-01T00:00:00Z'), Q('a1', 10, 50, 'currency', '2026-01-03T00:00:00Z')]
    expect(currencyRemaining([accounts[0]], multi)).toBe(40)
  })
  it('keyQuotaStats：全部/各分组/未分组的计数与剩余', () => {
    const stats = keyQuotaStats(accounts, accounts, quotas, keyGroups(accounts))
    expect(stats.all).toEqual({ count: 6, remain: expect.closeTo(43.2) })
    expect(stats.byGroup).toEqual([
      { group: 'AI助手', count: 3, remain: expect.closeTo(33.2) },
      { group: '图像生成', count: 1, remain: expect.closeTo(6) },
    ])
    expect(stats.none).toEqual({ count: 2, remain: expect.closeTo(4) })
  })
  it('keyQuotaStats：分组计数/剩余按全部账户成员集（旧胶囊口径，含无 Key 的账户）', () => {
    const manual = ACC('m1', 'deepseek', undefined, 'AI助手')
    delete manual.encryptedKey
    const all = [...accounts, manual]
    const qs = [...quotas, Q('m1', 2, 10, 'currency')]
    const stats = keyQuotaStats(accounts, all, qs, keyGroups(all))
    // AI助手：计数含无 Key 的手动账户（4）、剩余含其 ¥8
    expect(stats.byGroup[0]).toEqual({ group: 'AI助手', count: 4, remain: expect.closeTo(41.2) })
    // 全部计数仍是 keyAccounts 数（6），剩余 = 分组剩余之和
    expect(stats.all.count).toBe(6)
    expect(stats.all.remain).toBeCloseTo(stats.byGroup.reduce((s, g) => s + g.remain, 0) + stats.none.remain)
  })
  it('quotaSelectionDisplay：按钮文案随选中项更新（名称 + ¥1 位小数）', () => {
    const stats = keyQuotaStats(accounts, accounts, quotas, keyGroups(accounts))
    const labels = { all: '全部', none: '未分组' }
    expect(quotaSelectionDisplay(KEY_FILTER_ALL, stats, labels)).toEqual({ name: '全部', remain: '43.2' })
    expect(quotaSelectionDisplay('图像生成', stats, labels)).toEqual({ name: '图像生成', remain: '6.0' })
    expect(quotaSelectionDisplay(KEY_FILTER_NONE, stats, labels)).toEqual({ name: '未分组', remain: '4.0' })
    // 选中了已不存在的分组：名称照显、剩余 0.0，不崩
    expect(quotaSelectionDisplay('已删分组', stats, labels)).toEqual({ name: '已删分组', remain: '0.0' })
  })
})
