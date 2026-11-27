import { describe, expect, it } from 'vitest'
import {
  StallMonitor, UpdateStallError, withStallWatchdog, shouldPeriodicRecheck,
  STALL_MS, RECHECK_INTERVAL_MS,
} from './updateStall'

describe('StallMonitor 卡死判定（v0.1.498）', () => {
  it('无任何字节：满 20 秒判定卡死，未满不判', () => {
    const m = new StallMonitor(1_000_000)
    expect(m.stalled(1_000_000 + STALL_MS - 1)).toBe(false)
    expect(m.stalled(1_000_000 + STALL_MS)).toBe(true)
  })

  it('字节有进展则重新计时；同字节反复上报不算进展', () => {
    const m = new StallMonitor(0)
    m.progress(1024, 15_000)
    expect(m.stalled(15_000 + STALL_MS - 1)).toBe(false)
    m.progress(1024, 30_000) // 同字节，不刷新
    expect(m.stalled(15_000 + STALL_MS)).toBe(true)
  })

  it('缓慢但持续有进展（每 10 秒来一点）永不判卡死', () => {
    const m = new StallMonitor(0)
    let bytes = 0
    for (let t = 10_000; t <= 600_000; t += 10_000) {
      bytes += 4096
      m.progress(bytes, t)
      expect(m.stalled(t)).toBe(false)
    }
  })

  it('注入停滞字节流：先来一口然后停住，20 秒后判卡死', () => {
    const m = new StallMonitor(100)
    m.progress(6 * 1024 * 1024, 400) // 下到一半
    expect(m.stalled(400 + 19_999)).toBe(false)
    expect(m.stalled(400 + 20_000)).toBe(true)
    expect(m.elapsedMs(400 + 20_000)).toBe(20_300)
  })
})

describe('withStallWatchdog', () => {
  it('持续有进展时正常完成', async () => {
    const v = await withStallWatchdog(async note => {
      for (let i = 1; i <= 5; i++) {
        await new Promise(r => setTimeout(r, 15))
        note(i * 100)
      }
      return 'done'
    }, { stallMs: 120, tickMs: 10 })
    expect(v).toBe('done')
  })

  it('停滞字节流触发 UpdateStallError（换通道的触发点）', async () => {
    await expect(withStallWatchdog(async note => {
      note(500)
      await new Promise(r => setTimeout(r, 500)) // 停住不来字节
      return 'late'
    }, { stallMs: 80, tickMs: 10 })).rejects.toBeInstanceOf(UpdateStallError)
  })

  it('底层先报错时原样透传，不被看门狗吞掉', async () => {
    await expect(withStallWatchdog(async () => {
      throw new Error('HTTP 404')
    }, { stallMs: 80, tickMs: 10 })).rejects.toThrow('HTTP 404')
  })
})

describe('shouldPeriodicRecheck 运行期复查决策', () => {
  const base = { enabled: true, stateKind: 'idle', hasPending: false, now: 10 * RECHECK_INTERVAL_MS, lastCheckAt: 0 }
  it('四条件全满足才查', () => {
    expect(shouldPeriodicRecheck(base)).toBe(true)
  })
  it('静默关不查', () => {
    expect(shouldPeriodicRecheck({ ...base, enabled: false })).toBe(false)
  })
  it('状态机非空闲（下载中/待安装/安装中）不查', () => {
    for (const k of ['downloading', 'ready', 'installing', 'available', 'dlError']) {
      expect(shouldPeriodicRecheck({ ...base, stateKind: k })).toBe(false)
    }
  })
  it('已有待安装不查', () => {
    expect(shouldPeriodicRecheck({ ...base, hasPending: true })).toBe(false)
  })
  it('距上次检查不足 2 小时不查', () => {
    expect(shouldPeriodicRecheck({ ...base, now: RECHECK_INTERVAL_MS - 1 })).toBe(false)
    expect(shouldPeriodicRecheck({ ...base, now: RECHECK_INTERVAL_MS })).toBe(true)
  })
})
