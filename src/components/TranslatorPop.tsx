import { useEffect, useRef, useState } from 'react'
import {
  Copy, Volume2, X, Check, AlertTriangle, Pin, PinOff,
  Languages, ArrowLeftRight, Loader2, Trash2, Moon, Sun, GripHorizontal, Settings2,
} from 'lucide-react'
import {
  speakLangOf, sourceLangLabel, setPopAlwaysOnTop,
  loadTranslatorSettings, loadPopTheme, savePopTheme, openTranslatorSettings,
  TRANSLATOR_LANGS, type OpsDisplay, type PopTheme,
} from '../core/translator'
import {
  formatDurationMs, saveTranslatorEngineKey, loadTranslatorEngineKey,
  type TranslatorProviderSummary,
} from '../core/translatorProviders'

interface PopPayload {
  source: string
  translated: string
  targetLang: string
  sourceLang?: string
  error: string | null
  ops: OpsDisplay
  /** v0.1.473：'input' = 输入翻译模式（Alt+E 呼出）；缺省/result = 译文展示 */
  mode?: string
  /** v0.1.473：译文流式到达中（先行弹窗 + 增量填入） */
  streaming?: boolean
  /** v0.1.477：已启用服务商摘要 JSON（空串=未提供、'[]'=明确零启用） */
  providersJson?: string
  /** v0.1.477：当前翻译引擎 key */
  providerKey?: string
  /** v0.1.477：本次翻译真实耗时（毫秒）与实际服务商名，译完显示在按钮下方 */
  elapsedMs?: number | null
  usedLabel?: string
}

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
function inv(): InvokeFn | null {
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke?: InvokeFn } }
  return w.__TAURI_INTERNALS__?.invoke ?? null
}

function parseProviders(json?: string): TranslatorProviderSummary[] | null {
  if (!json) return null
  try {
    const v = JSON.parse(json) as TranslatorProviderSummary[]
    return Array.isArray(v) ? v : null
  } catch { return null }
}

/**
 * 翻译小窗（独立窗口 #/translator-pop），v0.1.477 定版（Ethan 拍板的效果图）：
 * 极简风 + 左右对照（原文左/译文右、窄窗自动上下排）+ 浅/深双主题一键
 * 丝滑切换；标题栏依次 清空/主题/置顶/关闭；语言行与服务商下拉一行——
 * 服务商只列设置里已启用的、带实测耗时，选中即翻译专用引擎；每栏顶部
 * 复制/朗读只管本栏；底部整宽绿色大圆角「翻译」按钮，耗时显示在按钮
 * 下方右对齐小字。窗口可拖（标题栏）可缩放（边角），几何由 Rust 记忆。
 * 重译/提交经事件发给主窗口宿主执行（账户/服务商都在那边），结果仍走
 * translator_show_pop / translator_update_pop 回来。
 */
export function TranslatorPop() {
  const [payload, setPayload] = useState<PopPayload | null>(null)
  const [draft, setDraft] = useState('')
  const [dst, setDst] = useState('')
  const [targetSel, setTargetSel] = useState('简体中文')
  const [sourceSel, setSourceSel] = useState('') // '' = 自动检测
  const [busy, setBusy] = useState(false)
  const [pinned, setPinned] = useState(true)
  const [copied, setCopied] = useState<'src' | 'dst' | null>(null)
  const [theme, setTheme] = useState<PopTheme>(() => loadPopTheme())
  const [providers, setProviders] = useState<TranslatorProviderSummary[] | null>(null)
  const [providerKey, setProviderKey] = useState('')
  const [elapsed, setElapsed] = useState<{ ms: number; label: string } | null>(null)
  const stateRef = useRef({ draft: '', targetSel: '简体中文', sourceSel: '', providerKey: '' })
  stateRef.current = { draft, targetSel, sourceSel, providerKey }
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  // Rust 程序化定位会触发 onMoved：载荷刚应用 600ms 内的移动不算用户拖动，
  // 不回报几何，免得把鼠标旁定位钉成「记忆位置」
  const applyAtRef = useRef(0)

  // 输入模式（v0.1.473）：窗口显形后把焦点送进输入框，能直接打字
  useEffect(() => {
    if (payload?.mode === 'input') {
      const t = window.setTimeout(() => inputRef.current?.focus(), 60)
      return () => window.clearTimeout(t)
    }
  }, [payload?.mode])

  // 主题：深色时把窗口底衬（卡片外圈）也压暗，整窗一体；选择仅本机记住
  useEffect(() => {
    document.documentElement.classList.toggle('trs-pop-dark', theme === 'dark')
  }, [theme])
  const toggleTheme = () => {
    const next: PopTheme = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    savePopTheme(next)
  }

  // 几何回报（v0.1.477）：拖动/缩放后把逻辑坐标报给 Rust 存本机，
  // 下次打开优先回记忆位置/尺寸；屏幕外纠偏在 Rust 定位时做
  useEffect(() => {
    let unMove: (() => void) | undefined
    let unResize: (() => void) | undefined
    let timer = 0
    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        const win = getCurrentWindow()
        const report = async (moved: boolean) => {
          try {
            const [pos, size, sf] = await Promise.all([win.outerPosition(), win.outerSize(), win.scaleFactor()])
            await inv()?.('translator_pop_geom_save', {
              x: pos.x / sf, y: pos.y / sf, w: size.width / sf, h: size.height / sf, moved,
            })
          } catch { /* 非 Tauri/无头环境忽略 */ }
        }
        const debounced = (moved: boolean) => {
          window.clearTimeout(timer)
          timer = window.setTimeout(() => { void report(moved) }, 350)
        }
        unMove = await win.onMoved(() => { if (Date.now() - applyAtRef.current > 600) debounced(true) })
        unResize = await win.onResized(() => debounced(false))
      } catch { /* 非 Tauri 环境忽略 */ }
    })()
    return () => { unMove?.(); unResize?.(); window.clearTimeout(timer) }
  }, [])

  useEffect(() => {
    // 窗口底色由 main.tsx 的 trs-popwin 标记 + styles.css 统一管（不透明）
    let unlisten: (() => void) | undefined
    const apply = (p: PopPayload) => {
      applyAtRef.current = Date.now()
      setPayload(p)
      const provs = parseProviders(p.providersJson)
      if (provs !== null) setProviders(provs)
      if (p.providerKey) setProviderKey(p.providerKey)
      else if (provs && provs.length) setProviderKey(loadTranslatorEngineKey() || provs[0].key)
      if (p.mode === 'input') {
        // 输入模式：空稿起步，目标语言取设置里的默认目标
        setDraft('')
        setDst('')
        setElapsed(null)
        setTargetSel(loadTranslatorSettings().targetLang)
      } else {
        setDraft(p.source ?? '')
        setDst(p.translated ?? '')
        if (p.targetLang) setTargetSel(p.targetLang)
        if (typeof p.elapsedMs === 'number' && p.translated) {
          setElapsed({ ms: p.elapsedMs, label: p.usedLabel ?? '' })
        } else if (!p.streaming) {
          setElapsed(null)
        }
      }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const close = async () => {
    // v0.1.473 面包屑：输入模式的关闭与 Rust 的 input-show 成对落盘
    if (payload?.mode === 'input') {
      try { await inv()?.('translator_diag_note', { note: 'input-hide' }) } catch { /* 忽略 */ }
    }
    try { await inv()?.('translator_hide_pop') } catch { /* 忽略 */ }
  }

  // 输入模式提交（v0.1.473）：文本发给主窗口宿主翻译（translator-input-submit），
  // 结果以 result 模式载荷回到本窗；宿主无响应时 20 秒兜底解除忙碌（同 retranslate）
  const submitInput = async () => {
    const text = stateRef.current.draft
    if (!text.trim() || busy) return
    setBusy(true)
    try {
      const { emit } = await import('@tauri-apps/api/event')
      await emit('translator-input-submit', {
        text, targetLang: stateRef.current.targetSel,
        providerKey: stateRef.current.providerKey || undefined,
      })
    } catch { setBusy(false) }
    window.setTimeout(() => setBusy(false), 20000)
  }

  const retranslate = async (next?: { source?: string; targetLang?: string; sourceSel?: string }) => {
    const cur = stateRef.current
    const source = next?.source ?? cur.draft
    const targetLang = next?.targetLang ?? cur.targetSel
    const srcSel = next?.sourceSel ?? cur.sourceSel
    if (!source.trim()) return
    setBusy(true)
    setElapsed(null)
    try {
      const { emit } = await import('@tauri-apps/api/event')
      await emit('translator-retranslate', {
        source,
        targetLang,
        sourceLang: srcSel || sourceLangLabel(source),
        providerKey: cur.providerKey || undefined,
      })
    } catch { setBusy(false) }
    // 兜底：宿主没响应（主窗口不在）时别永远转圈
    window.setTimeout(() => setBusy(false), 20000)
  }

  const copyText = async (text: string, which: 'src' | 'dst') => {
    if (!text) return
    try { await inv()?.('translator_clipboard_write', { text }) } catch { /* 忽略 */ }
    setCopied(which)
    window.setTimeout(() => setCopied(null), 1200)
  }
  const speak = (text: string, langName: string) => {
    if (!text.trim()) return
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
  const clearAll = () => {
    setDraft('')
    setDst('')
    setElapsed(null)
  }
  const changeProvider = (key: string) => {
    setProviderKey(key)
    saveTranslatorEngineKey(key)
    // 结果模式下换服务商即按新引擎重译当前原文，所见即所得
    if (payload?.mode !== 'input' && stateRef.current.draft.trim()) {
      stateRef.current.providerKey = key
      void retranslate()
    }
  }
  const swapLangs = () => {
    const cur = stateRef.current
    const detectedName = payload?.sourceLang || sourceLangLabel(cur.draft)
    const fromName = cur.sourceSel || (detectedName === '中文' ? '简体中文' : detectedName)
    if (!(TRANSLATOR_LANGS as readonly string[]).includes(fromName)) return
    setSourceSel(cur.targetSel)
    setTargetSel(fromName)
    if (payload?.mode !== 'input' && cur.draft.trim()) {
      void retranslate({ targetLang: fromName, sourceSel: cur.targetSel })
    }
  }

  const noProviders = providers !== null && providers.length === 0
  const detected = payload?.sourceLang || (draft ? sourceLangLabel(draft) : '自动检测')
  const streaming = !!payload?.streaming
  const showElapsed = !!elapsed && !!dst && !busy && !streaming

  return (
    <div className={`trs-pop ${theme === 'dark' ? 'dark' : ''}`}>
      <div className="trs-pop-head" data-tauri-drag-region>
        <span className="trs-pop-title"><GripHorizontal size={13} className="trs-pop-grip" /><Languages size={13} /> 翻译</span>
        <span className="trs-pop-head-btns">
          <button className="trs-pop-x static" onClick={clearAll} title="清空原文与译文" disabled={!draft && !dst}>
            <Trash2 size={13} />
          </button>
          <button className="trs-pop-x static" onClick={toggleTheme} title={theme === 'dark' ? '切换到浅色' : '切换到深色'}>
            {theme === 'dark' ? <Sun size={13} /> : <Moon size={13} />}
          </button>
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

      {payload && !payload.error && noProviders && (
        <div className="trs-pop-empty">
          <p>还没有启用的翻译服务商</p>
          <p className="trs-pop-empty-sub">先去翻译助手设置里启用至少一家服务商，小窗才能选它来翻译。</p>
          <button className="trs-pop-open-settings" onClick={() => void openTranslatorSettings()}>
            <Settings2 size={14} /> 打开翻译设置
          </button>
        </div>
      )}

      {payload && !payload.error && !noProviders && (
        <>
          <div className="trs-pop-langrow">
            <select className="trs-pop-langsel" value={sourceSel} title="源语言"
              onChange={e => { setSourceSel(e.target.value); if (payload.mode !== 'input') void retranslate({ sourceSel: e.target.value }) }}>
              <option value="">自动检测</option>
              {TRANSLATOR_LANGS.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
            <button className="trs-pop-swapbtn" onClick={swapLangs} title="交换源语言与目标语言">
              <ArrowLeftRight size={13} />
            </button>
            <select className="trs-pop-langsel" value={targetSel} title="目标语言"
              onChange={e => { setTargetSel(e.target.value); if (payload.mode !== 'input') void retranslate({ targetLang: e.target.value }) }}>
              {TRANSLATOR_LANGS.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
            {providers && providers.length > 0 && (
              <select className="trs-pop-provider" value={providerKey} title="翻译服务商"
                onChange={e => changeProvider(e.target.value)}>
                {providers.map(p => (
                  <option key={p.key} value={p.key}>
                    {p.label} · {typeof p.ms === 'number' ? formatDurationMs(p.ms) : '未测速'}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="trs-pop-cols">
            <div className="trs-pop-col">
              <div className="trs-pop-colhead">
                <span>原文{sourceSel || detected ? <span className="trs-pop-colhint"> · {sourceSel || detected}</span> : null}</span>
                <span className="trs-pop-colbtns">
                  <button onClick={() => void copyText(draft, 'src')} title="复制原文">
                    {copied === 'src' ? <Check size={13} /> : <Copy size={13} />}
                  </button>
                  <button onClick={() => speak(draft, sourceSel || detected)} title="朗读原文">
                    <Volume2 size={13} />
                  </button>
                </span>
              </div>
              <textarea
                ref={payload.mode === 'input' ? inputRef : undefined}
                className="trs-pop-src-edit"
                value={draft}
                placeholder={payload.mode === 'input' ? '输入要翻译的文本（⌘/Ctrl + Enter 翻译）' : '原文'}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    if (payload.mode === 'input') void submitInput()
                    else void retranslate()
                  }
                }}
              />
            </div>
            <div className="trs-pop-divider" />
            <div className="trs-pop-col">
              <div className="trs-pop-colhead">
                <span>译文<span className="trs-pop-colhint"> · {targetSel}</span></span>
                <span className="trs-pop-colbtns">
                  <button onClick={() => void copyText(dst, 'dst')} title="复制译文">
                    {copied === 'dst' ? <Check size={13} /> : <Copy size={13} />}
                  </button>
                  <button onClick={() => speak(dst, targetSel)} title="朗读译文">
                    <Volume2 size={13} />
                  </button>
                </span>
              </div>
              <div className="trs-pop-dst">
                {busy || (streaming && !dst)
                  ? <span className="trs-pop-loading"><Loader2 size={14} className="spin" /> 翻译中…</span>
                  : (
                    <>
                      {dst}
                      {streaming && <span className="trs-pop-loading" style={{ marginLeft: 6 }}><Loader2 size={12} className="spin" /></span>}
                      {!dst && !busy && <span className="trs-pop-dst-placeholder">译文会显示在这里</span>}
                    </>
                  )}
              </div>
            </div>
          </div>

          <button
            className="trs-pop-go"
            disabled={busy || !draft.trim()}
            onClick={() => { if (payload.mode === 'input') void submitInput(); else void retranslate() }}
          >
            {busy ? <><Loader2 size={15} className="spin" /> 翻译中…</> : '翻译'}
          </button>
          {showElapsed && (
            <div className="trs-pop-elapsed">耗时 {formatDurationMs(elapsed.ms)}{elapsed.label ? ` · ${elapsed.label}` : ''}</div>
          )}
          {payload.mode === 'input' && (
            <div className="trs-pop-inputhint">在任何应用里按快捷键呼出 · Esc 关闭</div>
          )}
        </>
      )}
    </div>
  )
}
