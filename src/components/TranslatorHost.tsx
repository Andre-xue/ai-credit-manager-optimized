import { useEffect, useRef } from 'react'
import type { Account } from '../core/types'
import { isDesktopApp } from '../core/openExternal'
import {
  loadTranslatorSettings, applyTranslatorShortcuts, getSelectedText, showTranslatorPop,
  preprocessText, translateWithRoutes, writeClipboard,
  TRANSLATOR_SETTINGS_EVENT, setPendingTranslatorTab,
} from '../core/translator'

/**
 * 翻译助手主窗口宿主（v0.1.440）：常驻主窗口，负责——
 * ① 启动与设置变化时把快捷键配置下发 Rust 注册；
 * ② 接 Rust 发来的全局事件（快捷键触发 / 截图 OCR 文本 / 原生错误），
 *    在主窗口上下文里跑翻译（账户与保险箱密码都在这里），再让 Rust 弹小窗。
 */
export function TranslatorHost({ accounts, sessionPwd, notify, onOpenInput }: {
  accounts: Account[]
  sessionPwd: string
  notify: (m: string) => void
  onOpenInput: () => void
}) {
  const ctxRef = useRef({ accounts, sessionPwd, notify, onOpenInput })
  ctxRef.current = { accounts, sessionPwd, notify, onOpenInput }

  useEffect(() => {
    if (!isDesktopApp()) return
    let dead = false
    const unlistens: (() => void)[] = []

    const applyShortcuts = () => { void applyTranslatorShortcuts(loadTranslatorSettings()) }
    applyShortcuts()
    const onSettings = () => applyShortcuts()
    window.addEventListener(TRANSLATOR_SETTINGS_EVENT, onSettings)

    const showError = (message: string, x: number, y: number) => {
      const s = loadTranslatorSettings()
      void showTranslatorPop({
        source: '', translated: '', targetLang: s.targetLang, error: message,
        ops: s.opsDisplay, x: x + s.offsetX, y: y + s.offsetY,
      }).catch(() => {})
    }

    const translateAndShow = async (rawText: string, x: number, y: number) => {
      const { accounts: acc, sessionPwd: pwd, notify: nf } = ctxRef.current
      const s = loadTranslatorSettings()
      const text = preprocessText(rawText, s.preprocess)
      if (!text.trim()) { showError('没有可翻译的文本', x, y); return }
      try {
        const out = await translateWithRoutes({
          accounts: acc, sessionPwd: pwd, text, settings: s,
          onChainNote: msg => nf(msg),
        })
        if (s.popEnabled) {
          await showTranslatorPop({
            source: text, translated: out.translated, targetLang: out.targetLang, error: null,
            ops: s.opsDisplay, x: x + s.offsetX, y: y + s.offsetY,
          })
        } else {
          await writeClipboard(out.translated)
          nf('译文已复制到剪贴板')
        }
      } catch (e) {
        showError(e instanceof Error ? e.message : '翻译失败', x, y)
      }
    }

    const doSelection = async () => {
      const s = loadTranslatorSettings()
      if (!s.selectionEnabled) return
      const outcome = await getSelectedText()
      if (outcome.error || !outcome.text) {
        // 取词失败明确报错（弹到鼠标旁），不假装成功
        showError(outcome.error ?? '没有取到选中文本：先在其他应用里选中文字再按快捷键', outcome.x, outcome.y)
        return
      }
      await translateAndShow(outcome.text, outcome.x, outcome.y)
    }

    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        if (dead) return
        unlistens.push(await listen<{ action: string }>('translator-hotkey', e => {
          if (e.payload.action === 'selection') void doSelection()
          else if (e.payload.action === 'input') { setPendingTranslatorTab('input'); ctxRef.current.onOpenInput() }
        }))
        unlistens.push(await listen<{ text: string; x: number; y: number }>('translator-shot-text', e => {
          void translateAndShow(e.payload.text, e.payload.x, e.payload.y)
        }))
        unlistens.push(await listen<{ message: string; x?: number; y?: number }>('translator-error', e => {
          if (typeof e.payload.x === 'number' && typeof e.payload.y === 'number') showError(e.payload.message, e.payload.x, e.payload.y)
          else ctxRef.current.notify(e.payload.message)
        }))
      } catch { /* 非 Tauri 环境忽略 */ }
    })()

    return () => {
      dead = true
      window.removeEventListener(TRANSLATOR_SETTINGS_EVENT, onSettings)
      unlistens.forEach(u => u())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return null
}
