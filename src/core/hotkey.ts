// 全局快捷键录入与校验（v0.1.451）：翻译助手与 App 壳（AI/迷你窗）共用。
//
// 教训（440 实机）：录入若用 KeyboardEvent.key，macOS 上按住 Option 再按 E，
// key 会被系统改成特殊字符「Œ」，存下「Alt+Œ」这种 Tauri/muda 根本解析不了的
// 组合，注册必失败。这里一律按物理键位 KeyboardEvent.code 映射标准键名，
// 与键盘布局、修饰键改字完全无关；校验也只认这张映射表的值域，坏值在
// 落盘/下发注册之前就被拦下。

/** KeyboardEvent.code → accelerator 主键名（Tauri/muda 可解析的标准名） */
export const CODE_TO_KEY: Record<string, string> = (() => {
  const m: Record<string, string> = {}
  for (let i = 0; i < 26; i++) {
    const ch = String.fromCharCode(65 + i)
    m[`Key${ch}`] = ch
  }
  for (let i = 0; i <= 9; i++) m[`Digit${i}`] = String(i)
  for (let i = 1; i <= 24; i++) m[`F${i}`] = `F${i}`
  Object.assign(m, {
    Space: 'Space',
    Enter: 'Enter',
    NumpadEnter: 'Enter',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Insert: 'Insert',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Minus: 'Minus',
    Equal: 'Equal',
    Comma: 'Comma',
    Period: 'Period',
    Slash: 'Slash',
    Backslash: 'Backslash',
    Semicolon: 'Semicolon',
    Quote: 'Quote',
    BracketLeft: 'BracketLeft',
    BracketRight: 'BracketRight',
    Backquote: 'Backquote',
    Numpad0: '0', Numpad1: '1', Numpad2: '2', Numpad3: '3', Numpad4: '4',
    Numpad5: '5', Numpad6: '6', Numpad7: '7', Numpad8: '8', Numpad9: '9',
    NumpadAdd: 'Plus',
    NumpadSubtract: 'Minus',
    NumpadDecimal: 'Period',
  })
  return m
})()

/** 合法主键名集合（isValidAccelerator 的值域，与 CODE_TO_KEY 保持一致） */
export const VALID_KEY_NAMES: ReadonlySet<string> = new Set([...Object.values(CODE_TO_KEY), 'Plus'])

const MODIFIER_CODES: ReadonlySet<string> = new Set([
  'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight',
  'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
])

const VALID_MODIFIERS: ReadonlySet<string> = new Set([
  'CommandOrControl', 'Command', 'Control', 'Ctrl', 'Alt', 'Shift', 'Meta', 'Super',
])

export function keyNameFromCode(code: string): string | null {
  return CODE_TO_KEY[code] ?? null
}

export function isModifierCode(code: string): boolean {
  return MODIFIER_CODES.has(code)
}

export interface HotkeyEventLike {
  code: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

export type AccelResult =
  | { ok: true; accel: string }
  | { ok: false; reason: 'modifier-only' | 'no-modifier' | 'unsupported'; code: string }

/**
 * 把一次 keydown 折算成 accelerator 串。只看 code 与修饰键状态，绝不看 e.key
 * （Option 组合下 e.key 是被系统改过的字符，正是 440 存出「Œ」的根源）。
 */
export function acceleratorFromEvent(e: HotkeyEventLike): AccelResult {
  if (isModifierCode(e.code)) return { ok: false, reason: 'modifier-only', code: e.code }
  const key = keyNameFromCode(e.code)
  if (!key) return { ok: false, reason: 'unsupported', code: e.code }
  const mods: string[] = []
  if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (mods.length === 0) return { ok: false, reason: 'no-modifier', code: e.code }
  return { ok: true, accel: [...mods, key].join('+') }
}

/**
 * 校验一个已存的 accelerator 是否合法（可被 Tauri 解析）：
 * 至少一个修饰键 + 最后一个主键在映射表值域内。旧版本存下的坏值
 * （如「Alt+Œ」）在这里判无效，调用方据此提示重新录入、不再下发注册。
 */
export function isValidAccelerator(v: string): boolean {
  if (!v || v.trim() !== v) return false
  const parts = v.split('+')
  if (parts.length < 2) return false
  const key = parts[parts.length - 1]
  if (!VALID_KEY_NAMES.has(key)) return false
  const mods = parts.slice(0, -1)
  return mods.length >= 1 && mods.every(m => VALID_MODIFIERS.has(m))
}

/** 注册失败原因转人话：绝不把上游英文原文/仓库链接透给用户 */
export function humanizeShortcutError(raw: string): string {
  const s = String(raw ?? '')
  if (/Couldn't|muda|github\.com|recognize/i.test(s)) {
    return '这个组合系统无法注册（按键不被支持），请换一个组合重新录入'
  }
  if (/占用|already|in use|register/i.test(s) && !/注册失败/.test(s)) {
    return '注册失败，可能已被其他应用占用，换个组合试试'
  }
  // 已经是中文人话的（Rust 侧定版文案）原样保留；其余英文兜底成通用中文
  if (/[一-鿿]/.test(s) && !/https?:\/\//.test(s)) return s.replace(/https?:\/\/\S+/g, '').trim()
  return '注册失败，请换个组合试试'
}
