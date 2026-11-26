import { describe, it, expect, beforeEach } from 'vitest'

// 内存版 localStorage polyfill（node 环境，与其他 core 测试同款）
class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}
;(globalThis as any).localStorage = new MemStorage()
;(globalThis as any).window = globalThis

import {
  detectSourceLang, pickTargetLang, preprocessText, removeSmartNewlines, sourceLangLabel,
  loadTranslatorSettings, saveTranslatorSettings, DEFAULT_TRANSLATOR_SETTINGS,
  getInvalidTranslatorShortcutFields, TRANSLATOR_SETTINGS_KEY,
} from './translator'

beforeEach(() => { ;(localStorage as any).clear() })

describe('detectSourceLang', () => {
  it('中文判 zh', () => expect(detectSourceLang('你好世界，这是一段中文')).toBe('zh'))
  it('带假名的日文判 ja（优先于汉字）', () => expect(detectSourceLang('これはテストです')).toBe('ja'))
  it('韩文判 ko', () => expect(detectSourceLang('안녕하세요 세계')).toBe('ko'))
  it('英文判 en', () => expect(detectSourceLang('Hello world, this is English text.')).toBe('en'))
  it('俄文判 ru', () => expect(detectSourceLang('Привет мир')).toBe('ru'))
  it('空文本判 other', () => expect(detectSourceLang('12345 !!!')).toBe('other'))
})

describe('pickTargetLang', () => {
  const s = { ...DEFAULT_TRANSLATOR_SETTINGS, targetLang: '简体中文', fallbackLang: '英语' }
  it('英文翻成默认目标简体中文', () => expect(pickTargetLang('Hello world', s)).toBe('简体中文'))
  it('中文撞默认目标时改用备用英语', () => expect(pickTargetLang('你好世界', s)).toBe('英语'))
  it('目标是英语时英文改用备用', () => {
    const s2 = { ...s, targetLang: '英语', fallbackLang: '简体中文' }
    expect(pickTargetLang('Hello world', s2)).toBe('简体中文')
  })
  it('无法识别语种时用默认目标', () => expect(pickTargetLang('12345', s)).toBe('简体中文'))
})

describe('preprocessText', () => {
  it('关闭时原样返回', () => {
    const t = 'fooBar_baz\nnext line'
    expect(preprocessText(t, false)).toBe(t)
  })
  it('拆分驼峰与下划线与连字符命名', () => {
    expect(preprocessText('getUserName', true)).toBe('get User Name')
    expect(preprocessText('user_name', true)).toBe('user name')
    expect(preprocessText('my-component', true)).toBe('my component')
    expect(preprocessText('HTTPServerError', true)).toBe('HTTP Server Error')
  })
  it('英文单换行拼接补空格', () => {
    expect(preprocessText('hello\nworld', true)).toBe('hello world')
  })
  it('中文单换行直接相连不补空格', () => {
    expect(preprocessText('你好\n世界', true)).toBe('你好世界')
  })
  it('空行段落保留', () => {
    expect(preprocessText('第一段\n\n第二段', true)).toBe('第一段\n\n第二段')
  })
})

describe('settings 存取', () => {
  it('无存储时给默认值', () => {
    localStorage.removeItem('acm.translator.settings.v1')
    expect(loadTranslatorSettings()).toEqual(DEFAULT_TRANSLATOR_SETTINGS)
  })
  it('保存后能读回且与默认值合并', () => {
    saveTranslatorSettings({ ...DEFAULT_TRANSLATOR_SETTINGS, targetLang: '日语', doubleClick: true })
    const s = loadTranslatorSettings()
    expect(s.targetLang).toBe('日语')
    expect(s.doubleClick).toBe(true)
    expect(s.shortcutSelection).toBe(DEFAULT_TRANSLATOR_SETTINGS.shortcutSelection)
  })
  it('坏 JSON 时回退默认值', () => {
    localStorage.setItem('acm.translator.settings.v1', '{oops')
    expect(loadTranslatorSettings()).toEqual(DEFAULT_TRANSLATOR_SETTINGS)
  })
})

describe('v0.1.451 坏快捷键值识别', () => {
  it('440 存下的 Alt+Œ 读出为空（按未注册处理）并记下字段名', () => {
    localStorage.setItem(TRANSLATOR_SETTINGS_KEY, JSON.stringify({ shortcutScreenshot: 'Alt+Œ' }))
    const s = loadTranslatorSettings()
    expect(s.shortcutScreenshot).toBe('')
    expect(getInvalidTranslatorShortcutFields()).toContain('shortcutScreenshot')
  })
  it('合法值原样保留、不记无效', () => {
    localStorage.setItem(TRANSLATOR_SETTINGS_KEY, JSON.stringify({ shortcutSelection: 'Ctrl+Shift+D' }))
    const s = loadTranslatorSettings()
    expect(s.shortcutSelection).toBe('Ctrl+Shift+D')
    expect(getInvalidTranslatorShortcutFields()).not.toContain('shortcutSelection')
  })
  it('三个字段各自独立判定', () => {
    localStorage.setItem(TRANSLATOR_SETTINGS_KEY, JSON.stringify({
      shortcutSelection: 'Alt+Œ', shortcutScreenshot: 'Alt+S', shortcutInput: 'garbage',
    }))
    const s = loadTranslatorSettings()
    expect(s.shortcutSelection).toBe('')
    expect(s.shortcutScreenshot).toBe('Alt+S')
    expect(s.shortcutInput).toBe('')
    const bad = getInvalidTranslatorShortcutFields()
    expect(bad).toContain('shortcutSelection')
    expect(bad).toContain('shortcutInput')
    expect(bad).not.toContain('shortcutScreenshot')
  })
})

describe('removeSmartNewlines / sourceLangLabel', () => {
  it('英文断行拼接补空格、段落保留', () => {
    expect(removeSmartNewlines('hello\nworld')).toBe('hello world')
    expect(removeSmartNewlines('第一段\n\n第二段')).toBe('第一段\n\n第二段')
  })
  it('源语言标签', () => {
    expect(sourceLangLabel('Hello world, this is a test')).toBe('英语')
    expect(sourceLangLabel('你好世界')).toBe('中文')
    expect(sourceLangLabel('12345')).toBe('自动检测')
  })
})
