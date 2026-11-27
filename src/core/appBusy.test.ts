import { describe, it, expect, beforeEach } from 'vitest'
import {
  setAppBusy, isAppBusy, appBusyKeys, appBusyEntries, pruneStaleBusy,
  busyKeyLabel, BUSY_TTL_MS, waitForAppIdle, onAppBusyChange,
} from './appBusy'

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

  it('心跳：重复登记刷新时刻但不重复通知（v0.1.503）', () => {
    let calls = 0
    const off = onAppBusyChange(() => { calls++ })
    setAppBusy('gallery-index', true, 1_000)
    setAppBusy('gallery-index', true, 5_000) // 心跳
    expect(calls).toBe(1)
    expect(appBusyEntries()).toEqual([{ key: 'gallery-index', since: 5_000 }])
    off()
    setAppBusy('gallery-index', false)
  })

  it('pruneStaleBusy：超 TTL 无心跳的登记被回收，未超的不动（v0.1.503）', () => {
    const t0 = 1_000_000
    setAppBusy('mail-sync', true, t0)
    setAppBusy('checkin:a', true, t0)
    // mail-sync 在 TTL 内有心跳 → 保鲜；checkin:a 一直无心跳 → 过期
    setAppBusy('mail-sync', true, t0 + BUSY_TTL_MS - 1_000)
    const pruned = pruneStaleBusy(t0 + BUSY_TTL_MS + 1)
    expect(pruned).toEqual(['checkin:a'])
    expect(appBusyKeys()).toEqual(['mail-sync'])
    expect(isAppBusy()).toBe(true)
    setAppBusy('mail-sync', false)
    expect(isAppBusy()).toBe(false)
  })

  it('pruneStaleBusy：无过期登记时返回空且不通知', () => {
    let calls = 0
    const off = onAppBusyChange(() => { calls++ })
    setAppBusy('mail-delete', true, 100)
    expect(pruneStaleBusy(200)).toEqual([])
    expect(calls).toBe(1) // 只有登记那一次通知
    off()
    setAppBusy('mail-delete', false)
  })

  it('busyKeyLabel：已知键给人话名，未知键原样', () => {
    expect(busyKeyLabel('mail-sync')).toBe('邮件同步')
    expect(busyKeyLabel('mail-delete')).toBe('邮件删除')
    expect(busyKeyLabel('gallery-index')).toBe('图库索引')
    expect(busyKeyLabel('checkin:wb-1')).toBe('签到任务')
    expect(busyKeyLabel('something-else')).toBe('something-else')
  })
})
