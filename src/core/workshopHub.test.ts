// 工坊主页横向页签逻辑（v0.1.438）：搜索匹配字段、页签计数、收藏置顶（分类内、稳定）、收藏本机记忆。
import { describe, it, expect, beforeEach } from 'vitest'

// 内存版 localStorage polyfill（node 环境，同 agentCatalog.test 做法）
class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}
;(globalThis as unknown as { localStorage: unknown }).localStorage = new MemStorage()

import {
  matchWorkshopCard, countWorkshopMatches, visibleWorkshopCards,
  loadWorkshopFavs, saveWorkshopFavs, toggleWorkshopFav, WORKSHOP_FAVS_KEY,
} from './workshopHub'

const CARDS = [
  { id: 'files', name: '文件管家', desc: '访达式浏览你的文件夹', tag: '本地索引' },
  { id: 'summary', name: '文档总结', desc: '丢进 PDF 一键出摘要', tag: '文档解析' },
  { id: 'docqa', name: '文档问答', desc: '导入文档建本地知识库', tag: '本地知识库' },
  { id: 'translate', name: 'AI 翻译', desc: '整篇文档或粘贴文本翻译', tag: '整页翻译' },
]

describe('matchWorkshopCard', () => {
  it('空关键词全命中（含纯空白）', () => {
    expect(matchWorkshopCard(CARDS[0], '')).toBe(true)
    expect(matchWorkshopCard(CARDS[0], '   ')).toBe(true)
  })
  it('按名称匹配', () => {
    expect(matchWorkshopCard(CARDS[3], '翻译')).toBe(true)
    expect(matchWorkshopCard(CARDS[0], '翻译')).toBe(false)
  })
  it('按描述匹配', () => {
    expect(matchWorkshopCard(CARDS[1], '摘要')).toBe(true)
  })
  it('按标签匹配', () => {
    expect(matchWorkshopCard(CARDS[0], '本地索引')).toBe(true)
    expect(matchWorkshopCard(CARDS[2], '本地')).toBe(true)
  })
  it('英文大小写不敏感', () => {
    expect(matchWorkshopCard(CARDS[1], 'pdf')).toBe(true)
    expect(matchWorkshopCard(CARDS[1], 'PDF')).toBe(true)
  })
})

describe('countWorkshopMatches / visibleWorkshopCards', () => {
  it('无关键词计数 = 分类总数', () => {
    expect(countWorkshopMatches(CARDS, '')).toBe(4)
  })
  it('有关键词计数 = 命中数', () => {
    expect(countWorkshopMatches(CARDS, '文档')).toBe(3)
    expect(countWorkshopMatches(CARDS, '不存在的词')).toBe(0)
  })
  it('收藏置顶且保持组内相对顺序（稳定）', () => {
    const out = visibleWorkshopCards(CARDS, '', ['translate'])
    expect(out.map(c => c.id)).toEqual(['translate', 'files', 'summary', 'docqa'])
    const out2 = visibleWorkshopCards(CARDS, '', ['docqa', 'summary'])
    expect(out2.map(c => c.id)).toEqual(['summary', 'docqa', 'files', 'translate'])
  })
  it('搜索与收藏叠加：先过滤再置顶', () => {
    const out = visibleWorkshopCards(CARDS, '文档', ['translate'])
    expect(out.map(c => c.id)).toEqual(['translate', 'summary', 'docqa'])
  })
  it('不改动原数组顺序', () => {
    const copy = [...CARDS]
    visibleWorkshopCards(CARDS, '', ['translate'])
    expect(CARDS.map(c => c.id)).toEqual(copy.map(c => c.id))
  })
})

describe('收藏本机记忆', () => {
  beforeEach(() => { (localStorage as unknown as MemStorage).clear() })
  it('存取往返一致', () => {
    saveWorkshopFavs(['watch', 'files'])
    expect(loadWorkshopFavs()).toEqual(['watch', 'files'])
    expect(localStorage.getItem(WORKSHOP_FAVS_KEY)).toBe(JSON.stringify(['watch', 'files']))
  })
  it('无记录 / 坏数据回空数组', () => {
    expect(loadWorkshopFavs()).toEqual([])
    localStorage.setItem(WORKSHOP_FAVS_KEY, '{bad json')
    expect(loadWorkshopFavs()).toEqual([])
    localStorage.setItem(WORKSHOP_FAVS_KEY, JSON.stringify([1, 'ok', null]))
    expect(loadWorkshopFavs()).toEqual(['ok'])
  })
  it('toggle 收藏与取消', () => {
    expect(toggleWorkshopFav([], 'mail')).toEqual(['mail'])
    expect(toggleWorkshopFav(['mail'], 'mail')).toEqual([])
    expect(toggleWorkshopFav(['mail'], 'watch')).toEqual(['mail', 'watch'])
  })
})
