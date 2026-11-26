import { describe, it, expect, beforeEach } from 'vitest'
import { setAppBusy, isAppBusy, appBusyKeys, waitForAppIdle, onAppBusyChange } from './appBusy'

// 应用忙碌登记（v0.1.474）：自动更新在关窗/手动安装前等这些任务结束，不硬打断
describe('应用忙碌登记（v0.1.474）', () => {
  beforeEach(() => { setAppBusy('mail-sync', false); setAppBusy('mail-delete', false) })

  it('登记与释放', () => {
    expect(isAppBusy()).toBe(false)
    setAppBusy('mail-delete', true)
    expect(isAppBusy()).toBe(true)
    expect(appBusyKeys()).toEqual(['mail-delete'])
    setAppBusy('mail-delete', false)
    expect(isAppBusy()).toBe(false)
  })

  it('多个来源独立：任一忙碌即忙，全部释放才空闲', () => {
    setAppBusy('mail-sync', true)
    setAppBusy('mail-delete', true)
    setAppBusy('mail-sync', false)
    expect(isAppBusy()).toBe(true)
    setAppBusy('mail-delete', false)
    expect(isAppBusy()).toBe(false)
  })

  it('waitForAppIdle：空闲立即返回 true；一直忙到超时返回 false', async () => {
    await expect(waitForAppIdle(500, 10)).resolves.toBe(true)
    setAppBusy('mail-sync', true)
    await expect(waitForAppIdle(60, 10)).resolves.toBe(false)
  })

  it('waitForAppIdle：忙碌中途释放则返回 true', async () => {
    setAppBusy('mail-delete', true)
    setTimeout(() => setAppBusy('mail-delete', false), 50)
    await expect(waitForAppIdle(2_000, 10)).resolves.toBe(true)
  })

  it('onAppBusyChange：状态变化时通知，退订后不再通知', () => {
    let calls = 0
    const off = onAppBusyChange(() => { calls++ })
    setAppBusy('mail-sync', true)
    setAppBusy('mail-sync', true) // 无变化不重复通知
    expect(calls).toBe(1)
    off()
    setAppBusy('mail-sync', false)
    expect(calls).toBe(1)
  })
})
