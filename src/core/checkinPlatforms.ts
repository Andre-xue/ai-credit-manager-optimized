// 签到平台注册表：按「国内/国外 × 功能」分类；每平台一个自动签到开关（仅本机保存）。
// 关掉某平台后，批量签到（自动签到、菜单栏一键签到）会跳过它；逐个账号的手动签到不受影响。
// 新平台接入时在这里登记一行，签到页分组与自动签到过滤会自动跟上。

export type CheckinPlatformId = 'workbuddy' | 'minimax'

export interface CheckinPlatformMeta {
  id: CheckinPlatformId
  name: string
  regionLabel: '国内' | '国外'
  category: string
  /** 每日签到收益的单位文案 */
  unit: string
}

export const CHECKIN_PLATFORMS: CheckinPlatformMeta[] = [
  { id: 'workbuddy', name: 'WorkBuddy', regionLabel: '国内', category: 'AI 编程工具', unit: '积分' },
  { id: 'minimax', name: 'MiniMax', regionLabel: '国内', category: '大模型平台', unit: '积分' },
]

export function platformMeta(id: CheckinPlatformId): CheckinPlatformMeta {
  return CHECKIN_PLATFORMS.find(p => p.id === id) ?? CHECKIN_PLATFORMS[0]
}

const KEY = 'acm.checkin.platforms.v1'

function readPrefs(): Partial<Record<CheckinPlatformId, boolean>> {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<Record<CheckinPlatformId, boolean>>
    return j && typeof j === 'object' ? j : {}
  } catch { return {} }
}

/** 平台是否参与批量签到（默认开） */
export function getPlatformEnabled(id: CheckinPlatformId): boolean {
  return readPrefs()[id] !== false
}

export function setPlatformEnabled(id: CheckinPlatformId, on: boolean): void {
  try {
    const prefs = readPrefs()
    prefs[id] = on
    localStorage.setItem(KEY, JSON.stringify(prefs))
  } catch { /* 忽略 */ }
}
