// API Key 管理页筛选纯逻辑（v0.1.479 抽出，便于单测）：
// 类型（备注分类）/ 分组 / 平台三路筛选 + 分组额度统计。
// 哨兵值与旧版一致：'__all__' = 全部，'__none__' = 未分组（仅分组维度）。
import { noteCategory } from './io'
import { latestQuota } from './store'
import type { Account, QuotaSnapshot } from './types'

export const KEY_FILTER_ALL = '__all__'
export const KEY_FILTER_NONE = '__none__'

export interface KeyFilterSelection {
  category: string
  group: string
  platform: string
}

/** 类型列表：备注分类去重排序（与旧版 categories 同口径） */
export function keyCategories(accounts: Account[]): string[] {
  return Array.from(new Set(accounts.map(a => noteCategory(a.note)))).sort()
}

/** 分组列表：已有分组名去重排序（与旧版 groups 同口径） */
export function keyGroups(accounts: Account[]): string[] {
  return Array.from(new Set(accounts.map(a => a.group).filter((g): g is string => !!g))).sort()
}

/** 平台列表：只列有账户的平台，带计数；按计数降序、同数按 providerId 升序，结果稳定 */
export function keyPlatforms(accounts: Account[]): { id: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const a of accounts) counts.set(a.providerId, (counts.get(a.providerId) ?? 0) + 1)
  return Array.from(counts, ([id, count]) => ({ id, count }))
    .sort((x, y) => y.count - x.count || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
}

/** 三路筛选（与旧版 filtered 同口径，新增平台维度） */
export function filterKeyAccounts(accounts: Account[], sel: KeyFilterSelection): Account[] {
  return accounts.filter(a =>
    (sel.category === KEY_FILTER_ALL || noteCategory(a.note) === sel.category) &&
    (sel.group === KEY_FILTER_ALL || (sel.group === KEY_FILTER_NONE ? !a.group : a.group === sel.group)) &&
    (sel.platform === KEY_FILTER_ALL || a.providerId === sel.platform))
}

/** 一组账户的货币剩余额度合计：只计 unit=currency 的最新快照，负数按 0（与旧版胶囊同口径） */
export function currencyRemaining(accounts: Account[], quotas: QuotaSnapshot[]): number {
  return accounts.reduce((sum, a) => {
    const q = latestQuota(quotas, a.id)
    return q && q.unit === 'currency' ? sum + Math.max(0, q.total - q.used) : sum
  }, 0)
}

export interface KeyQuotaStat { count: number; remain: number }
export interface KeyQuotaStats {
  all: KeyQuotaStat
  byGroup: { group: string; count: number; remain: number }[]
  none: KeyQuotaStat
}

/**
 * 「额度」下拉的数据：全部 / 各分组 / 未分组的账户数与剩余 ¥。
 * 口径与旧版分组额度胶囊逐项对齐：各分组的计数与剩余按 allAccounts 的成员集
 * （旧胶囊用的就是 state.accounts.filter(group)）；全部计数 = keyAccounts 数
 * （旧「全部分组」下拉口径）；未分组计数 = keyAccounts 中无分组数（旧未分组胶囊口径），
 * 未分组剩余与全部剩余为新增展示，按 allAccounts 成员集计算，保证分组剩余之和 = 全部剩余。
 */
export function keyQuotaStats(keyAccounts: Account[], allAccounts: Account[], quotas: QuotaSnapshot[], groups: string[]): KeyQuotaStats {
  return {
    all: { count: keyAccounts.length, remain: currencyRemaining(allAccounts, quotas) },
    byGroup: groups.map(group => {
      const members = allAccounts.filter(a => a.group === group)
      return { group, count: members.length, remain: currencyRemaining(members, quotas) }
    }),
    none: {
      count: keyAccounts.filter(a => !a.group).length,
      remain: currencyRemaining(allAccounts.filter(a => !a.group), quotas),
    },
  }
}

/** 「额度」下拉按钮上当前选中项的 名称 + 剩余（remain 保留 1 位小数，与旧版胶囊同格式） */
export function quotaSelectionDisplay(sel: string, stats: KeyQuotaStats, labels: { all: string; none: string }): { name: string; remain: string } {
  if (sel === KEY_FILTER_ALL) return { name: labels.all, remain: stats.all.remain.toFixed(1) }
  if (sel === KEY_FILTER_NONE) return { name: labels.none, remain: stats.none.remain.toFixed(1) }
  const g = stats.byGroup.find(x => x.group === sel)
  return { name: sel, remain: (g?.remain ?? 0).toFixed(1) }
}
