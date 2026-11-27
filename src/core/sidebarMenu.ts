// 桌面侧边栏底部弹出菜单（v0.1.493，MangoDisk 式布局）：底部状态卡点开向上弹菜单，
// 收纳设置 / 操作历史 / 帮助与反馈 / 检查更新 / 关于 / 收起展开侧边栏；菜单顶部另有
// 账户项（未登录=登录云同步，已登录=账户名与同步状态）。本模块只管菜单结构与
// 更新状态的呈现判定（红点/忙碌），文案与点击行为在 App.tsx 侧边栏组件里。
import type { AutoUpdateUiState } from './autoUpdate'
import type { SettingsCategory } from './settingsTabs'

export type SidebarMenuItemId = 'settings' | 'audit' | 'help' | 'update' | 'about' | 'collapse'

export interface SidebarMenuItem {
  id: SidebarMenuItemId
  /** 带红点（如检查更新在有新版待处理时） */
  dot?: boolean
  /** 图标转圈（更新下载/安装中） */
  busy?: boolean
}

/** 有新版可达/已下载待装/已推迟到关窗安装：菜单项与底部卡都带红点（沿用 474 口径） */
export function sidebarUpdateHasDot(autoUpd: AutoUpdateUiState): boolean {
  return autoUpd.kind === 'available' || autoUpd.kind === 'ready' || autoUpd.kind === 'deferred'
}

/** 更新进行中（下载/安装）：图标转圈、底部卡不带红点 */
export function sidebarUpdateBusy(autoUpd: AutoUpdateUiState): boolean {
  return autoUpd.kind === 'downloading' || autoUpd.kind === 'installing'
}

/** 菜单项顺序（账户项在组件里单独渲染于菜单顶部，不在此列）：
 *  设置 → 操作历史 → 帮助与反馈 → 检查更新（仅桌面端）→ 关于 → 收起/展开侧边栏 */
export function sidebarMenuItems(autoUpd: AutoUpdateUiState, opts: { isDesktop: boolean }): SidebarMenuItem[] {
  const items: SidebarMenuItem[] = [{ id: 'settings' }, { id: 'audit' }, { id: 'help' }]
  if (opts.isDesktop) {
    items.push({ id: 'update', dot: sidebarUpdateHasDot(autoUpd), busy: sidebarUpdateBusy(autoUpd) })
  }
  items.push({ id: 'about' }, { id: 'collapse' })
  return items
}

/** 设置弹窗深链目标：操作历史 = 安全隐私大类 + 审计日志页签（478 页签体系） */
export interface SettingsNavTarget { cat: SettingsCategory; sub?: string }
export const SETTINGS_AUDIT_TARGET: SettingsNavTarget = { cat: 'security', sub: 'audit' }
/** 底部卡账户项（已登录）点击目标：设置 → 账户与数据 */
export const SETTINGS_ACCOUNT_TARGET: SettingsNavTarget = { cat: 'data' }

/** 帮助与反馈的真实去处：本仓库 GitHub issues 页（经 openExternal 系统浏览器打开） */
export const HELP_FEEDBACK_URL = 'https://github.com/Andre-xue/ai-credit-manager-optimized/issues'
