import { describe, it, expect, beforeEach } from 'vitest'
import { loadPatrolHours, savePatrolHours, patrolDue, DEFAULT_PATROL_HOURS } from './balancePatrol'

class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}
;(globalThis as any).localStorage = new MemStorage()

beforeEach(() => { (globalThis as any).localStorage.clear() })

describe('balancePatrol', () => {
  it('默认 6 小时；非法值回退默认', () => {
    expect(loadPatrolHours()).toBe(DEFAULT_PATROL_HOURS)
    savePatrolHours(99)
    expect(loadPatrolHours()).toBe(DEFAULT_PATROL_HOURS)
  })
  it('合法选项可存取，含关闭（0）', () => {
    savePatrolHours(1)
    expect(loadPatrolHours()).toBe(1)
    savePatrolHours(0)
    expect(loadPatrolHours()).toBe(0)
  })
  it('patrolDue：关闭恒 false；未到期 false；到期 true', () => {
    const now = 100 * 3600 * 1000
    expect(patrolDue(now, 0, 0)).toBe(false)
    expect(patrolDue(now, 6, now - 5 * 3600 * 1000)).toBe(false)
    expect(patrolDue(now, 6, now - 6 * 3600 * 1000)).toBe(true)
    expect(patrolDue(now, 1, 0)).toBe(true)
  })
})
