import { describe, it, expect } from 'vitest'
import {
  selectPruneVictims, vaultTotals, formatBytes, mergeVaultUsage,
  shouldAttemptClone, apfsCopyOutcome, type VaultEntry, type VaultBaselineInfo,
} from './agentVault'

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

describe('每任务占用汇总（二期）', () => {
  const B = (taskId: string, baselineBytes: number): VaultBaselineInfo => ({
    taskId, taskTitle: `任务-${taskId}`, agentName: 'Pi', createdAt: 0, baselineBytes,
  })
  it('基线 + 版本条目按任务合并，按总占用降序', () => {
    const usage = mergeVaultUsage(
      [{ ...E('e1', 0, 100), taskId: 't1' }, { ...E('e2', 0, 50), taskId: 't1' }, { ...E('e3', 0, 30), taskId: 't2' }],
      [B('t1', 1000), B('t2', 200)],
    )
    expect(usage[0]).toMatchObject({ taskId: 't1', baselineBytes: 1000, entriesBytes: 150, entryCount: 2, totalBytes: 1150 })
    expect(usage[1]).toMatchObject({ taskId: 't2', baselineBytes: 200, entriesBytes: 30, entryCount: 1, totalBytes: 230 })
  })
  it('只有条目没有基线（基线已清理）也成行', () => {
    const usage = mergeVaultUsage([{ ...E('e1', 0, 10), taskId: 'tx' }], [])
    expect(usage).toHaveLength(1)
    expect(usage[0].baselineBytes).toBe(0)
  })
  it('空输入 → 空汇总', () => {
    expect(mergeVaultUsage([], [])).toEqual([])
  })
})

describe('APFS 克隆复制回落判定（与 Rust vault_copy_file 同口径）', () => {
  it('只有 macOS 尝试克隆', () => {
    expect(shouldAttemptClone(true)).toBe(true)
    expect(shouldAttemptClone(false)).toBe(false)
  })
  it('真值表：mac + 克隆成功 → cloned；其余一律 copied（回落普通复制）', () => {
    expect(apfsCopyOutcome(true, true)).toBe('cloned')
    expect(apfsCopyOutcome(true, false)).toBe('copied')
    expect(apfsCopyOutcome(false, true)).toBe('copied')
    expect(apfsCopyOutcome(false, false)).toBe('copied')
  })
})
