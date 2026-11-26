import { useEffect, useRef } from 'react'
import type { Account } from '../core/types'
import { isDesktopApp } from '../core/openExternal'
import {
  loadTranslatorSettings, applyTranslatorShortcuts, getSelectedText, showTranslatorPop,
  preprocessText, translateWithRoutes, translateToTarget, sourceLangLabel, writeClipboard,
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

    // 小窗最近一次弹出位置：小窗里切换语言重译时原地刷新，不跳位
    const lastPos = { x: 120, y: 120 }
    const showError = (message: string, x: number, y: number) => {
      const s = loadTranslatorSettings()
      lastPos.x = x + s.offsetX; lastPos.y = y + s.offsetY
      void showTranslatorPop({
        source: '', translated: '', targetLang: s.targetLang, error: message,
        ops: s.opsDisplay, x: lastPos.x, y: lastPos.y,
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
          lastPos.x = x + s.offsetX; lastPos.y = y + s.offsetY
          await showTranslatorPop({
            source: text, translated: out.translated, targetLang: out.targetLang,
            sourceLang: sourceLangLabel(text), error: null,
            ops: s.opsDisplay, x: lastPos.x, y: lastPos.y,
          })
        } else {
          await writeClipboard(out.translated)
          nf('译文已复制到剪贴板')
        }
      } catch (e) {
        showError(e instanceof Error ? e.message : '翻译失败', x, y)
      }
    }

    // 小窗内重译（切换目标/源语言、粘贴并翻译、智能删换行、改原文后手动翻译）
    const doRetranslate = async (p: { source: string; targetLang: string; sourceLang?: string }) => {
      const { accounts: acc, sessionPwd: pwd, notify: nf } = ctxRef.current
      const s = loadTranslatorSettings()
      const text = (p.source ?? '').slice(0, 8000)
      if (!text.trim()) return
      try {
        const out = await translateToTarget({
          accounts: acc, sessionPwd: pwd, text,
          targetLang: p.targetLang || s.targetLang,
          sourceLangName: p.sourceLang,
          onChainNote: msg => nf(msg),
        })
        await showTranslatorPop({
          source: text, translated: out.translated, targetLang: out.targetLang,
          sourceLang: p.sourceLang || sourceLangLabel(text), error: null,
          ops: s.opsDisplay, x: lastPos.x, y: lastPos.y,
        })
      } catch (e) {
        showError(e instanceof Error ? e.message : '翻译失败', lastPos.x - s.offsetX, lastPos.y - s.offsetY)
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
        unlistens.push(await listen<{ source: string; targetLang: string; sourceLang?: string }>('translator-retranslate', e => {
          void doRetranslate(e.payload)
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
