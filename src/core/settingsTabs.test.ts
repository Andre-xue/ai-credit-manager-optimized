import { describe, it, expect, beforeEach } from 'vitest'
import {
  SETTINGS_SUBTABS, SETTINGS_SUBTAB_KEY, visibleSettingsSubTabs, allSettingsSections,
  readSavedSettingsSubTabs, saveSettingsSubTab, resolveSettingsSubTab,
} from './settingsTabs'

// node 环境无 localStorage：内存版 polyfill（同 checkinTabs.test.ts 的做法）
class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}
;(globalThis as any).localStorage = new MemStorage()

// 改前基线（v0.1.477 无头复现 verify478-repro 实测）：设置中心三组分段全量堆叠，
// 页签化后一个都不许丢、不许重复。
const BASELINE: Record<string, string[]> = {
  general: ['外观设计', 'AI 行为', 'AI 助手工具栏', '本地模型服务', '通用', '阅览方式', '提醒通知', '桌面端', '本地统一网关'],
  data: ['云同步', 'WebDAV 同步', 'iCloud Drive 同步', '云端自动备份', '账号管理', '应用更新', '数据管理', '数据备份', '照片图库授权', '数据存储', '数据概览', '关于'],
  security: ['操作审计日志', '密钥保险箱'],
}

describe('settingsTabs（v0.1.478 主设置页右侧横向页签）', () => {
  beforeEach(() => { localStorage.clear() })

  it('设置项无丢失对照：每组页签分段并集与改前基线完全一致', () => {
    for (const cat of ['general', 'data', 'security'] as const) {
      expect([...allSettingsSections(cat)].sort()).toEqual([...BASELINE[cat]].sort())
    }
  })

  it('分段不重复归属：任一分段只出现在一个页签里', () => {
    for (const cat of ['general', 'data', 'security'] as const) {
      const flat = SETTINGS_SUBTABS[cat].flatMap(d => d.sections)
      expect(new Set(flat).size).toBe(flat.length)
    }
  })

  it('页签构成与预览定案一致', () => {
    expect(SETTINGS_SUBTABS.general.map(d => d.label)).toEqual(['外观设计', 'AI 行为', '本地服务', '通用'])
    expect(SETTINGS_SUBTABS.data.map(d => d.label)).toEqual(['同步与备份', '应用更新', '账号管理', '数据管理'])
    expect(SETTINGS_SUBTABS.security.map(d => d.label)).toEqual(['保险箱', '审计日志'])
    // 474 的应用更新（含自动更新开关）独立成页签
    expect(SETTINGS_SUBTABS.data.find(d => d.id === 'update')?.sections).toEqual(['应用更新'])
    // 同步与备份收齐云同步/WebDAV/iCloud/云端自动备份/数据备份
    expect(SETTINGS_SUBTABS.data.find(d => d.id === 'sync')?.sections)
      .toEqual(['云同步', 'WebDAV 同步', 'iCloud Drive 同步', '云端自动备份', '数据备份'])
  })

  it('本地服务页签只在 hasLocal 时可见（平台隔离：手机壳不出现空页签）', () => {
    expect(visibleSettingsSubTabs('general', { hasLocal: true }).map(d => d.id))
      .toEqual(['appearance', 'ai', 'local', 'misc'])
    expect(visibleSettingsSubTabs('general', { hasLocal: false }).map(d => d.id))
      .toEqual(['appearance', 'ai', 'misc'])
    // 其余大类不受壳层影响
    expect(visibleSettingsSubTabs('data', { hasLocal: false })).toHaveLength(4)
    expect(visibleSettingsSubTabs('security', { hasLocal: false })).toHaveLength(2)
  })

  it('resolve：记住的选择可见时用它，不可见/未存时回落第一个可见页签', () => {
    expect(resolveSettingsSubTab('general', 'misc', { hasLocal: true })).toBe('misc')
    expect(resolveSettingsSubTab('general', 'local', { hasLocal: false })).toBe('appearance')
    expect(resolveSettingsSubTab('general', undefined, { hasLocal: true })).toBe('appearance')
    expect(resolveSettingsSubTab('data', 'bogus', { hasLocal: true })).toBe('sync')
    expect(resolveSettingsSubTab('security', undefined, { hasLocal: false })).toBe('vault')
  })

  it('页签记忆仅本机 localStorage 往返，坏数据不抛错', () => {
    saveSettingsSubTab('data', 'update')
    saveSettingsSubTab('general', 'ai')
    expect(readSavedSettingsSubTabs()).toEqual({ data: 'update', general: 'ai' })
    expect(localStorage.getItem(SETTINGS_SUBTAB_KEY)).toContain('update')
    localStorage.setItem(SETTINGS_SUBTAB_KEY, '{broken')
    expect(readSavedSettingsSubTabs()).toEqual({})
    localStorage.setItem(SETTINGS_SUBTAB_KEY, JSON.stringify({ general: 42, data: 'sync' }))
    expect(readSavedSettingsSubTabs()).toEqual({ data: 'sync' })
  })
})
