import { describe, it, expect } from 'vitest'
import {
  keyNameFromCode, acceleratorFromEvent, isValidAccelerator, humanizeShortcutError,
} from './hotkey'

describe('keyNameFromCode（物理键位映射）', () => {
  it('字母键', () => {
    expect(keyNameFromCode('KeyA')).toBe('A')
    expect(keyNameFromCode('KeyE')).toBe('E')
    expect(keyNameFromCode('KeyZ')).toBe('Z')
  })
  it('数字键', () => {
    expect(keyNameFromCode('Digit0')).toBe('0')
    expect(keyNameFromCode('Digit3')).toBe('3')
    expect(keyNameFromCode('Digit9')).toBe('9')
  })
  it('功能键与常用键', () => {
    expect(keyNameFromCode('F1')).toBe('F1')
    expect(keyNameFromCode('F12')).toBe('F12')
    expect(keyNameFromCode('Space')).toBe('Space')
    expect(keyNameFromCode('Enter')).toBe('Enter')
    expect(keyNameFromCode('Tab')).toBe('Tab')
    expect(keyNameFromCode('Backspace')).toBe('Backspace')
    expect(keyNameFromCode('Delete')).toBe('Delete')
  })
  it('方向键映射成 Up/Down/Left/Right', () => {
    expect(keyNameFromCode('ArrowUp')).toBe('Up')
    expect(keyNameFromCode('ArrowDown')).toBe('Down')
    expect(keyNameFromCode('ArrowLeft')).toBe('Left')
    expect(keyNameFromCode('ArrowRight')).toBe('Right')
  })
  it('标点键', () => {
    expect(keyNameFromCode('Minus')).toBe('Minus')
    expect(keyNameFromCode('Slash')).toBe('Slash')
    expect(keyNameFromCode('Comma')).toBe('Comma')
  })
  it('无法映射的 code 返回 null', () => {
    expect(keyNameFromCode('IntlRo')).toBeNull()
    expect(keyNameFromCode('ShiftLeft')).toBeNull()
    expect(keyNameFromCode('Escape')).toBeNull()
    expect(keyNameFromCode('')).toBeNull()
  })
})

describe('acceleratorFromEvent', () => {
  it('回归 440 实机：Option+E 在 macOS 上 e.key 是 Œ，但按 code 必须录出 Alt+E', () => {
    // 440 的 bug 现场：{ key: 'Œ', code: 'KeyE', altKey: true } 曾被存成「Alt+Œ」
    const r = acceleratorFromEvent({ code: 'KeyE', altKey: true })
    expect(r).toEqual({ ok: true, accel: 'Alt+E' })
  })
  it('Cmd+Shift+D 的修饰键顺序稳定', () => {
    const r = acceleratorFromEvent({ code: 'KeyD', metaKey: true, shiftKey: true })
    expect(r).toEqual({ ok: true, accel: 'CommandOrControl+Shift+D' })
  })
  it('Ctrl+Alt+数字', () => {
    const r = acceleratorFromEvent({ code: 'Digit3', ctrlKey: true, altKey: true })
    expect(r).toEqual({ ok: true, accel: 'CommandOrControl+Alt+3' })
  })
  it('只按修饰键 → modifier-only（继续等主键，不落盘）', () => {
    expect(acceleratorFromEvent({ code: 'ShiftLeft', shiftKey: true }).ok).toBe(false)
    expect(acceleratorFromEvent({ code: 'AltLeft', altKey: true })).toMatchObject({ ok: false, reason: 'modifier-only' })
    expect(acceleratorFromEvent({ code: 'MetaLeft', metaKey: true })).toMatchObject({ ok: false, reason: 'modifier-only' })
  })
  it('无修饰键 → no-modifier', () => {
    expect(acceleratorFromEvent({ code: 'KeyA' })).toMatchObject({ ok: false, reason: 'no-modifier' })
  })
  it('无法映射的主键 → unsupported', () => {
    expect(acceleratorFromEvent({ code: 'IntlYen', altKey: true })).toMatchObject({ ok: false, reason: 'unsupported' })
  })
  it('Alt+方向键与 Alt+Space 可录', () => {
    expect(acceleratorFromEvent({ code: 'ArrowUp', altKey: true })).toEqual({ ok: true, accel: 'Alt+Up' })
    expect(acceleratorFromEvent({ code: 'Space', altKey: true })).toEqual({ ok: true, accel: 'Alt+Space' })
  })
})

describe('isValidAccelerator（已存值校验）', () => {
  it('合法组合', () => {
    expect(isValidAccelerator('Alt+D')).toBe(true)
    expect(isValidAccelerator('Alt+E')).toBe(true)
    expect(isValidAccelerator('CommandOrControl+Shift+A')).toBe(true)
    expect(isValidAccelerator('Alt+F5')).toBe(true)
    expect(isValidAccelerator('Alt+Up')).toBe(true)
    expect(isValidAccelerator('Ctrl+Space')).toBe(true)
  })
  it('440 存下的坏值 Alt+Œ 判无效', () => {
    expect(isValidAccelerator('Alt+Œ')).toBe(false)
  })
  it('缺修饰键/空串/残缺判无效', () => {
    expect(isValidAccelerator('E')).toBe(false)
    expect(isValidAccelerator('')).toBe(false)
    expect(isValidAccelerator('Alt+')).toBe(false)
    expect(isValidAccelerator('Alt')).toBe(false)
    expect(isValidAccelerator('Foo+Bar')).toBe(false)
  })
})

describe('humanizeShortcutError', () => {
  it('上游 muda 英文原文（含仓库链接）不透出', () => {
    const raw = '快捷键格式无效（Alt+Œ）：Couldn\'t recognize "Œ" as a valid key for hotkey, if you feel like it should be, please report this to https://github.com/tauri-apps/muda'
    const out = humanizeShortcutError(raw)
    expect(out).not.toMatch(/muda|github|Couldn't|Œ/)
    expect(out).toMatch(/[一-鿿]/)
  })
  it('Rust 侧定版中文文案原样保留', () => {
    const raw = '快捷键「Alt+D」注册失败，可能已被其他应用占用'
    expect(humanizeShortcutError(raw)).toBe(raw)
  })
  it('纯英文兜底成中文', () => {
    expect(humanizeShortcutError('some random failure')).toMatch(/[一-鿿]/)
  })
})
