/**
 * AI 工坊主页横向分类页签的纯逻辑（v0.1.438，按预览 ai-gong-fang-zhu-ye-heng-xiang-ye-qian-yu-lan 定案）：
 * - 搜索按卡片名称 + 描述 + 标签做包含匹配（不搜分类名）
 * - 页签徽标计数 = 该分类命中数（无关键词时即分类总数）
 * - 收藏只在所属分类内置顶（稳定排序，不跨分类），状态存本机 localStorage
 */
export interface WorkshopCardLike {
  id: string
  name: string
  desc: string
  tag: string
}

export const WORKSHOP_FAVS_KEY = 'acm.workshop.favs.v1'

/** 关键词匹配：名称 + 描述 + 标签拼接后小写包含；空关键词全命中 */
export function matchWorkshopCard(card: WorkshopCardLike, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return `${card.name} ${card.desc} ${card.tag}`.toLowerCase().includes(q)
}

/** 某分类在当前关键词下的命中数（页签徽标） */
export function countWorkshopMatches<T extends WorkshopCardLike>(cards: readonly T[], query: string): number {
  return cards.filter(c => matchWorkshopCard(c, query)).length
}

/** 当前分类要显示的卡片：先按关键词过滤，再把收藏的稳定置顶（组内相对顺序不变） */
export function visibleWorkshopCards<T extends WorkshopCardLike>(cards: readonly T[], query: string, favs: readonly string[]): T[] {
  const favSet = new Set(favs)
  return cards
    .filter(c => matchWorkshopCard(c, query))
    .sort((a, b) => (favSet.has(b.id) ? 1 : 0) - (favSet.has(a.id) ? 1 : 0))
}

export function loadWorkshopFavs(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(WORKSHOP_FAVS_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch { return [] }
}

export function saveWorkshopFavs(favs: readonly string[]): void {
  try { localStorage.setItem(WORKSHOP_FAVS_KEY, JSON.stringify([...favs])) } catch { /* 忽略 */ }
}

/** 切换一张卡的收藏状态，返回新列表 */
export function toggleWorkshopFav(favs: readonly string[], id: string): string[] {
  return favs.includes(id) ? favs.filter(x => x !== id) : [...favs, id]
}
