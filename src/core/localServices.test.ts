import { describe, it, expect, beforeEach } from 'vitest'
import { comfyScanDesktopEnabled, setComfyScanDesktop } from './localServices'

class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.get(k) ?? null }
  setItem(k: string, v: string) { this.m.set(k, v) }
  removeItem(k: string) { this.m.delete(k) }
}

describe('ComfyUI 模型扫描覆盖开关（本机偏好）', () => {
  beforeEach(() => {
    ;(globalThis as any).localStorage = new MemStorage()
  })
  it('默认关闭', () => {
    expect(comfyScanDesktopEnabled()).toBe(false)
  })
  it('开/关往返', () => {
    setComfyScanDesktop(true)
    expect(comfyScanDesktopEnabled()).toBe(true)
    setComfyScanDesktop(false)
    expect(comfyScanDesktopEnabled()).toBe(false)
  })
})
