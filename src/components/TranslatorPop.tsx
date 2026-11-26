import { useEffect, useState } from 'react'
import { Copy, Replace, Volume2, X, Check, AlertTriangle } from 'lucide-react'
import { speakLangOf, type OpsDisplay } from '../core/translator'

interface PopPayload {
  source: string
  translated: string
  targetLang: string
  error: string | null
  ops: OpsDisplay
}

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
function inv(): InvokeFn | null {
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke?: InvokeFn } }
  return w.__TAURI_INTERNALS__?.invoke ?? null
}

/** 划词/截图译文小窗（独立窗口 #/translator-pop）：只做展示与操作，不抢原文上下文 */
export function TranslatorPop() {
  const [payload, setPayload] = useState<PopPayload | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    document.body.style.background = 'transparent'
    let unlisten: (() => void) | undefined
    void (async () => {
      try {
        const p = await inv()?.('translator_pop_payload')
        if (p) setPayload(p as PopPayload)
      } catch { /* 忽略 */ }
      try {
        const { listen } = await import('@tauri-apps/api/event')
        unlisten = await listen<PopPayload>('translator-pop-data', e => setPayload(e.payload))
      } catch { /* 忽略 */ }
    })()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') void close() }
    window.addEventListener('keydown', onKey)
    return () => { unlisten?.(); window.removeEventListener('keydown', onKey) }
  }, [])

  const close = async () => { try { await inv()?.('translator_hide_pop') } catch { /* 忽略 */ } }
  const copy = async () => {
    if (!payload) return
    try { await inv()?.('translator_clipboard_write', { text: payload.translated }) } catch { /* 忽略 */ }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }
  const replace = async () => {
    if (!payload) return
    try { await inv()?.('translator_paste_text', { text: payload.translated }) } catch { /* 忽略 */ }
  }
  const speak = () => {
    if (!payload) return
    try {
      const u = new SpeechSynthesisUtterance(payload.translated)
      u.lang = speakLangOf(payload.targetLang || '简体中文')
      window.speechSynthesis?.cancel()
      window.speechSynthesis?.speak(u)
    } catch { /* 忽略 */ }
  }

  const ops = payload?.ops ?? 'both'
  const showIcon = ops !== 'text'
  const showText = ops !== 'icon'
  return (
    <div className="trs-pop">
      <button className="trs-pop-x" onClick={() => void close()} title="关闭（Esc）"><X size={13} /></button>
      {!payload && <div className="trs-pop-loading">翻译中…</div>}
      {payload?.error && (
        <div className="trs-pop-error"><AlertTriangle size={15} /> <span>{payload.error}</span></div>
      )}
      {payload && !payload.error && (
        <>
          {payload.source && <div className="trs-pop-src">{payload.source}</div>}
          <div className="trs-pop-dst">{payload.translated}</div>
          <div className="trs-pop-bar">
            <button onClick={() => void copy()}>
              {showIcon && (copied ? <Check size={14} /> : <Copy size={14} />)}{showText && <span>{copied ? '已复制' : '复制'}</span>}
            </button>
            <button onClick={() => void replace()}>
              {showIcon && <Replace size={14} />}{showText && <span>替换</span>}
            </button>
            <button onClick={speak}>
              {showIcon && <Volume2 size={14} />}{showText && <span>朗读</span>}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
