import { describe, it, expect } from 'vitest'
import { selectPruneVictims, vaultTotals, formatBytes, type VaultEntry } from './agentVault'

const E = (id: string, createdAt: number, size: number): VaultEntry => ({
  id, taskId: 't', agentId: 'pi', agentName: 'Pi', taskTitle: '任务',
  originalPath: `/work/${id}.txt`, storedRel: `entries/${id}/f.txt`, size, createdAt, kind: 'prev-version',
})

const DAY = 86_400_000

describe('保险箱清理选择（与 Rust prune 同口径）', () => {
  it('过期条目先被选（30 天保留）', () => {
    const now = 100 * DAY
    const entries = [E('old', now - 31 * DAY, 10), E('fresh', now - 1 * DAY, 10)]
    expect(selectPruneVictims(entries, now, 30, 1024)).toEqual(['old'])
  })
  it('未过期但超容量：从最旧开始选到达标', () => {
    const now = 100 * DAY
    const entries = [E('a', now - 3 * DAY, 100), E('b', now - 2 * DAY, 100), E('c', now - 1 * DAY, 100)]
    // 上限 150：总 300 → 选 a（剩 200 仍超）→ 再选 b（剩 100 达标）
    expect(selectPruneVictims(entries, now, 30, 150)).toEqual(['a', 'b'])
  })
  it('过期 + 超容量叠加', () => {
    const now = 100 * DAY
    const entries = [E('old', now - 40 * DAY, 100), E('a', now - 3 * DAY, 100), E('b', now - 1 * DAY, 100)]
    expect(selectPruneVictims(entries, now, 30, 150)).toEqual(['old', 'a'])
  })
  it('都在限内 → 不选', () => {
    const now = 100 * DAY
    expect(selectPruneVictims([E('a', now - DAY, 10)], now, 30, 1024)).toEqual([])
  })
  it('统计与格式化', () => {
    expect(vaultTotals([E('a', 0, 100), E('b', 0, 200)])).toEqual({ count: 2, bytes: 300 })
    expect(formatBytes(500)).toBe('500 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})
