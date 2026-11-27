// 全局「忙碌任务」登记表（v0.1.474）：长任务（邮件删除/同步、签到执行、
// 图库索引等）在进行中登记自己，更新安装等需要「等任务结束再动手」的
// 流程据此等待，避免重启把进行中的任务硬打断。各模块只管登记/注销，
// 登记表本身不依赖任何 UI。键名约定：'mail-delete' | 'mail-sync' |
// 'checkin' | 'gallery-index' | 'translate' 等，同一键重复登记幂等。
// v0.1.503 防泄漏：登记带起始时刻；重复登记同一键视为心跳（刷新时刻、
// 不重复通知）——进行中的任务靠状态变化持续心跳，真正泄漏的登记（组
// 件异常、状态卡死）无人心跳，超过 BUSY_TTL_MS 被 pruneStaleBusy 回收
// 并由调用方记入更新诊断日志，不再无限期挡住自动安装。

const busySince = new Map<string, number>()
const listeners = new Set<() => void>()

/** 登记最长有效期：超过此时长无心跳刷新的登记视为泄漏，可被回收 */
export const BUSY_TTL_MS = 30 * 60_000

function notify(): void {
  for (const fn of [...listeners]) { try { fn() } catch { /* 监听者自理 */ } }
}

export function setAppBusy(key: string, on: boolean, now: number = Date.now()): void {
  if (on) {
    if (busySince.has(key)) { busySince.set(key, now); return } // 心跳：只刷新时刻
    busySince.set(key, now)
    notify()
    return
  }
  if (busySince.delete(key)) notify()
}

export function isAppBusy(): boolean {
  return busySince.size > 0
}

export function appBusyKeys(): string[] {
  return [...busySince.keys()]
}

/** 当前登记明细（键 + 登记/最近心跳时刻），供等待方展示「在等什么」 */
export function appBusyEntries(): Array<{ key: string; since: number }> {
  return [...busySince.entries()].map(([key, since]) => ({ key, since }))
}

/** 回收超过 TTL 无心跳的泄漏登记；返回被回收的键名（有回收时通知监听者） */
export function pruneStaleBusy(now: number = Date.now(), ttlMs: number = BUSY_TTL_MS): string[] {
  const stale = [...busySince.entries()].filter(([, since]) => now - since > ttlMs).map(([key]) => key)
  if (!stale.length) return stale
  for (const key of stale) busySince.delete(key)
  notify()
  return stale
}

/** 忙碌键的人话名（等待提示用）：已知键给中文名，未知键原样返回 */
export function busyKeyLabel(key: string): string {
  if (key === 'mail-sync') return '邮件同步'
  if (key === 'mail-delete') return '邮件删除'
  if (key === 'gallery-index') return '图库索引'
  if (key === 'translate') return '翻译任务'
  if (key.startsWith('checkin')) return '签到任务'
  return key
}

/** 等到不忙为止：每 intervalMs 轮询一次；超过 timeoutMs 仍忙则返回 false（等不到） */
export async function waitForAppIdle(timeoutMs = 10 * 60_000, intervalMs = 1500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (isAppBusy()) {
    pruneStaleBusy()
    if (Date.now() >= deadline) return false
    await new Promise(r => setTimeout(r, intervalMs))
  }
  return true
}

export function onAppBusyChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
