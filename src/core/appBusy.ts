// 全局「忙碌任务」登记表（v0.1.474）：长任务（邮件删除/同步、签到执行、
// 图库索引等）在进行中登记自己，更新安装等需要「等任务结束再动手」的
// 流程据此等待，避免重启把进行中的任务硬打断。各模块只管登记/注销，
// 登记表本身不依赖任何 UI。键名约定：'mail-delete' | 'mail-sync' |
// 'checkin' | 'gallery-index' | 'translate' 等，同一键重复登记幂等。

const busyKeys = new Set<string>()
const listeners = new Set<() => void>()

export function setAppBusy(key: string, on: boolean): void {
  if (busyKeys.has(key) === on) return // 无变化不重复通知
  if (on) busyKeys.add(key)
  else busyKeys.delete(key)
  for (const fn of [...listeners]) { try { fn() } catch { /* 监听者自理 */ } }
}

export function isAppBusy(): boolean {
  return busyKeys.size > 0
}

export function appBusyKeys(): string[] {
  return [...busyKeys]
}

/** 等到不忙为止：每 intervalMs 轮询一次；超过 timeoutMs 仍忙则返回 false（等不到） */
export async function waitForAppIdle(timeoutMs = 10 * 60_000, intervalMs = 1500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (isAppBusy()) {
    if (Date.now() >= deadline) return false
    await new Promise(r => setTimeout(r, intervalMs))
  }
  return true
}

export function onAppBusyChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
