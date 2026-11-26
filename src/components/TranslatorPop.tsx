import { useEffect, useRef, useState } from 'react'
import {
  Copy, Replace, Volume2, X, Check, AlertTriangle, Pin, PinOff,
  ClipboardPaste, WrapText, Languages, ArrowLeftRight, Loader2,
} from 'lucide-react'
import {
  speakLangOf, sourceLangLabel, removeSmartNewlines, readClipboard, setPopAlwaysOnTop,
  TRANSLATOR_LANGS, type OpsDisplay,
} from '../core/translator'

interface PopPayload {
  source: string
  translated: string
  targetLang: string
  sourceLang?: string
  error: string | null
  ops: OpsDisplay
}

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
function inv(): InvokeFn | null {
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke?: InvokeFn } }
  return w.__TAURI_INTERNALS__?.invoke ?? null
}

/**
 * 划词/截图译文小窗（独立窗口 #/translator-pop），结构对齐 Manggo 小窗模式（v0.1.451）：
 * 原文区（可编辑）+ 操作行（复制原文/粘贴并翻译/智能删换行/朗读原文）
 * → 语言行（源语言自动检测/可选 ⇄ 目标语言可选，改了即重译）
 * → 译文区（朗读/复制/替换）+ 置顶/关闭。
 * 重译请求经 translator-retranslate 事件发给主窗口宿主（账户/路线都在那边），
 * 结果仍走 translator_show_pop / translator-pop-data 回来。
 */
export function TranslatorPop() {
  const [payload, setPayload] = useState<PopPayload | null>(null)
  const [draft, setDraft] = useState('')
  const [targetSel, setTargetSel] = useState('简体中文')
  const [sourceSel, setSourceSel] = useState('') // '' = 自动检测
  const [busy, setBusy] = useState(false)
  const [pinned, setPinned] = useState(true)
  const [copied, setCopied] = useState<'src' | 'dst' | null>(null)
  const stateRef = useRef({ draft: '', targetSel: '简体中文', sourceSel: '' })
  stateRef.current = { draft, targetSel, sourceSel }

  useEffect(() => {
    // 窗口底色由 main.tsx 的 trs-popwin 标记 + styles.css 统一管（不透明）；
    // 这里不再内联清底色——451 时清过头是小窗透明的原因之一（v0.1.453）。
    let unlisten: (() => void) | undefined
    const apply = (p: PopPayload) => {
      setPayload(p)
      setDraft(p.source ?? '')
      if (p.targetLang) setTargetSel(p.targetLang)
      setSourceSel('')
      setBusy(false)
    }
    void (async () => {
      try {
        const p = await inv()?.('translator_pop_payload')
        if (p) apply(p as PopPayload)
      } catch { /* 忽略 */ }
      try {
        const { listen } = await import('@tauri-apps/api/event')
        unlisten = await listen<PopPayload>('translator-pop-data', e => apply(e.payload))
      } catch { /* 忽略 */ }
    })()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') void close() }
    window.addEventListener('keydown', onKey)
    return () => { unlisten?.(); window.removeEventListener('keydown', onKey) }
  }, [])

  const close = async () => { try { await inv()?.('translator_hide_pop') } catch { /* 忽略 */ } }

  const retranslate = async (next?: { source?: string; targetLang?: string; sourceSel?: string }) => {
    const cur = stateRef.current
    const source = next?.source ?? cur.draft
    const targetLang = next?.targetLang ?? cur.targetSel
    const srcSel = next?.sourceSel ?? cur.sourceSel
    if (!source.trim()) return
    setBusy(true)
    try {
      const { emit } = await import('@tauri-apps/api/event')
      await emit('translator-retranslate', {
        source,
        targetLang,
        sourceLang: srcSel || sourceLangLabel(source),
      })
    } catch { setBusy(false) }
    // 兜底：宿主没响应（主窗口不在）时别永远转圈
    window.setTimeout(() => setBusy(false), 20000)
  }

  const copyText = async (text: string, which: 'src' | 'dst') => {
    try { await inv()?.('translator_clipboard_write', { text }) } catch { /* 忽略 */ }
    setCopied(which)
    window.setTimeout(() => setCopied(null), 1200)
  }
  const pasteAndTranslate = async () => {
    const text = await readClipboard()
    if (!text.trim()) return
    setDraft(text)
    await retranslate({ source: text })
  }
  const smartNewlines = async () => {
    const cleaned = removeSmartNewlines(stateRef.current.draft)
    setDraft(cleaned)
    await retranslate({ source: cleaned })
  }
  const replace = async () => {
    if (!payload) return
    try { await inv()?.('translator_paste_text', { text: payload.translated }) } catch { /* 忽略 */ }
  }
  const speak = (text: string, langName: string) => {
    try {
      const u = new SpeechSynthesisUtterance(text)
      u.lang = speakLangOf(langName)
      window.speechSynthesis?.cancel()
      window.speechSynthesis?.speak(u)
    } catch { /* 忽略 */ }
  }
  const togglePin = async () => {
    const next = !pinned
    setPinned(next)
    await setPopAlwaysOnTop(next)
  }

  const ops = payload?.ops ?? 'both'
  const showIcon = ops !== 'text'
  const showText = ops !== 'icon'
  const detected = payload?.sourceLang || (draft ? sourceLangLabel(draft) : '自动检测')
  const dirty = payload && draft.trim() !== (payload.source ?? '').trim()

  return (
    <div className="trs-pop">
      <div className="trs-pop-head" data-tauri-drag-region>
        <span className="trs-pop-title"><Languages size={13} /> 翻译</span>
        <span className="trs-pop-head-btns">
          <button className="trs-pop-x static" onClick={() => void togglePin()} title={pinned ? '取消置顶' : '置顶'}>
            {pinned ? <Pin size={13} /> : <PinOff size={13} />}
          </button>
          <button className="trs-pop-x static" onClick={() => void close()} title="关闭（Esc）"><X size={13} /></button>
        </span>
      </div>

      {!payload && <div className="trs-pop-loading">翻译中…</div>}
      {payload?.error && (
        <div className="trs-pop-error"><AlertTriangle size={15} /> <span>{payload.error}</span></div>
      )}
      {payload && !payload.error && (
        <>
          <textarea
            className="trs-pop-src-edit"
            value={draft}
            rows={4}
            placeholder="原文"
            onChange={e => setDraft(e.target.value)}
          />
          <div className="trs-pop-opsrow">
            <button onClick={() => void copyText(draft, 'src')} title="复制原文">
              {showIcon && (copied === 'src' ? <Check size={13} /> : <Copy size={13} />)}{showText && <span>{copied === 'src' ? '已复制' : '复制原文'}</span>}
            </button>
            <button onClick={() => void pasteAndTranslate()} title="粘贴剪贴板内容并翻译">
              {showIcon && <ClipboardPaste size={13} />}{showText && <span>粘贴并翻译</span>}
            </button>
            <button onClick={() => void smartNewlines()} title="智能删除换行">
              {showIcon && <WrapText size={13} />}{showText && <span>智能删换行</span>}
            </button>
            <button onClick={() => speak(draft, sourceSel || detected)} title="朗读原文">
              {showIcon && <Volume2 size={13} />}{showText && <span>朗读</span>}
            </button>
            <span className="trs-pop-detected">{sourceSel || detected}</span>
          </div>

          <div className="trs-pop-langrow">
            <select className="trs-pop-langsel" value={sourceSel}
              onChange={e => { setSourceSel(e.target.value); void retranslate({ sourceSel: e.target.value }) }}>
              <option value="">自动检测</option>
              {TRANSLATOR_LANGS.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
            <ArrowLeftRight size={13} className="trs-pop-swap" />
            <select className="trs-pop-langsel" value={targetSel}
              onChange={e => { setTargetSel(e.target.value); void retranslate({ targetLang: e.target.value }) }}>
              {TRANSLATOR_LANGS.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
            {dirty && (
              <button className="trs-pop-retranslate" onClick={() => void retranslate()} title="按当前原文重新翻译">
                <Languages size={13} /> 翻译
              </button>
            )}
          </div>

          <div className="trs-pop-dst">
            {busy ? <span className="trs-pop-loading"><Loader2 size={14} className="spin" /> 翻译中…</span> : payload.translated}
          </div>
          <div className="trs-pop-bar">
            <button onClick={() => speak(payload.translated, targetSel)}>
              {showIcon && <Volume2 size={14} />}{showText && <span>朗读</span>}
            </button>
            <button onClick={() => void copyText(payload.translated, 'dst')}>
              {showIcon && (copied === 'dst' ? <Check size={14} /> : <Copy size={14} />)}{showText && <span>{copied === 'dst' ? '已复制' : '复制译文'}</span>}
            </button>
            <button onClick={() => void replace()}>
              {showIcon && <Replace size={14} />}{showText && <span>替换</span>}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
