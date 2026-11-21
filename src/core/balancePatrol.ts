// 余额自动巡检间隔（v0.1.299）：设置 → 通用 →「余额自动刷新间隔」。
// 设备级偏好，只存本机 localStorage（与巡检时间戳同一待遇，不云同步）。
// 0 = 关闭自动刷新；其余为间隔小时数，默认 6。

export const PATROL_HOURS_KEY = 'acm.balance.patrolHours'
export const PATROL_AT_KEY = 'acm_balance_patrol_at'
export const PATROL_HOUR_OPTIONS = [0, 1, 3, 6, 12, 24] as const
export const DEFAULT_PATROL_HOURS = 6

export function loadPatrolHours(): number {
  try {
    const raw = localStorage.getItem(PATROL_HOURS_KEY)
    if (raw === null || raw === '') return DEFAULT_PATROL_HOURS // 未设置过（Number(null) 会误读成 0=关闭）
    const v = Number(raw)
    return (PATROL_HOUR_OPTIONS as readonly number[]).includes(v) ? v : DEFAULT_PATROL_HOURS
  } catch {
    return DEFAULT_PATROL_HOURS
  }
}

export function savePatrolHours(hours: number): void {
  try { localStorage.setItem(PATROL_HOURS_KEY, String(hours)) } catch { /* ignore */ }
}

/** 距上次巡检是否已达到间隔（关闭时恒 false） */
export function patrolDue(now: number, hours: number, lastAt: number): boolean {
  if (hours <= 0) return false
  return now - lastAt >= hours * 3600 * 1000
}
