// 主设置页右侧横向页签（v0.1.478）：设置弹窗左侧大类（偏好设置 / 账户与数据 /
// 安全隐私）不变，每个大类内部把现有分段归入横向页签，点哪个页签只显示哪一组，
// 替代原来的纵向折叠卡片堆叠。只改组织方式：各分段的功能、存储键、行为一律不动。
// 页签选择仅本机记忆（localStorage），不进云同步/备份，与界面语言同等待遇
// （先例：acm.set.sections 分段折叠记忆、acm.translator.settingsTab.v1）。

export type SettingsCategory = 'general' | 'data' | 'security'

export interface SettingsSubTabDef {
  id: string
  label: string
  /** 该页签包含的设置分段标题，与 App.tsx 中 SettingsSection 的 title 一一对应 */
  sections: string[]
  /** 分段只在特定壳层出现（本地模型服务 = 非手机壳、本地统一网关 = 桌面端）：
   * 整个页签仅在 hasLocal 时可见，手机壳下不出现空页签 */
  localOnly?: boolean
}

export const SETTINGS_SUBTABS: Record<SettingsCategory, SettingsSubTabDef[]> = {
  general: [
    { id: 'appearance', label: '外观设计', sections: ['外观设计'] },
    { id: 'ai', label: 'AI 行为', sections: ['AI 行为', 'AI 助手工具栏'] },
    { id: 'local', label: '本地服务', localOnly: true, sections: ['本地模型服务', '本地统一网关'] },
    { id: 'misc', label: '通用', sections: ['通用', '阅览方式', '提醒通知', '桌面端'] },
  ],
  data: [
    { id: 'sync', label: '同步与备份', sections: ['云同步', 'WebDAV 同步', 'iCloud Drive 同步', '云端自动备份', '数据备份'] },
    { id: 'update', label: '应用更新', sections: ['应用更新'] },
    { id: 'account', label: '账号管理', sections: ['账号管理'] },
    { id: 'datamgmt', label: '数据管理', sections: ['数据管理', '照片图库授权', '数据存储', '数据概览', '关于'] },
  ],
  security: [
    { id: 'vault', label: '保险箱', sections: ['密钥保险箱'] },
    { id: 'audit', label: '审计日志', sections: ['操作审计日志'] },
  ],
}

export interface SettingsShellCtx {
  /** 当前壳层是否存在本地服务相关分段（非手机壳 || 桌面端） */
  hasLocal: boolean
}

/** 当前壳层下某大类可见的页签（定义顺序） */
export function visibleSettingsSubTabs(cat: SettingsCategory, ctx: SettingsShellCtx): SettingsSubTabDef[] {
  return SETTINGS_SUBTABS[cat].filter(d => !d.localOnly || ctx.hasLocal)
}

/** 某大类全部分段标题（定义顺序、去重后）——设置项无丢失对照用 */
export function allSettingsSections(cat: SettingsCategory): string[] {
  const out: string[] = []
  for (const d of SETTINGS_SUBTABS[cat]) for (const s of d.sections) if (!out.includes(s)) out.push(s)
  return out
}

export const SETTINGS_SUBTAB_KEY = 'acm.settings.subTabs.v1'

type SavedSubTabs = Partial<Record<SettingsCategory, string>>

export function readSavedSettingsSubTabs(): SavedSubTabs {
  try {
    const raw = localStorage.getItem(SETTINGS_SUBTAB_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const out: SavedSubTabs = {}
    for (const cat of Object.keys(SETTINGS_SUBTABS) as SettingsCategory[]) {
      const v = (parsed as Record<string, unknown>)[cat]
      if (typeof v === 'string') out[cat] = v
    }
    return out
  } catch { return {} }
}

export function saveSettingsSubTab(cat: SettingsCategory, id: string): void {
  try {
    const cur = readSavedSettingsSubTabs()
    cur[cat] = id
    localStorage.setItem(SETTINGS_SUBTAB_KEY, JSON.stringify(cur))
  } catch { /* 忽略：记忆失败不影响设置本身 */ }
}

/** 生效页签：本机记住的选择若在当前壳层可见就用它，否则回落到第一个可见页签
 * （如手机壳下「本地服务」页签不存在时不许停在空页签上） */
export function resolveSettingsSubTab(cat: SettingsCategory, saved: string | undefined, ctx: SettingsShellCtx): string {
  const vis = visibleSettingsSubTabs(cat, ctx)
  if (saved && vis.some(d => d.id === saved)) return saved
  return vis[0]?.id ?? SETTINGS_SUBTABS[cat][0].id
}
