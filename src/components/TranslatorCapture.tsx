import { useEffect, useRef, useState } from 'react'

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
function inv(): InvokeFn | null {
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke?: InvokeFn } }
  return w.__TAURI_INTERNALS__?.invoke ?? null
}

interface Rect { x: number; y: number; w: number; h: number }

/** 截图框选层（独立窗口 #/translator-capture）：全屏透明层，拖出选区后交给 Rust 截图+OCR。
 * v0.1.451：窗口真透明（main.tsx 已在渲染前清 html/body 底色，这里再兜底清一次），
 * 底下内容清晰可见，只叠一层轻微变暗 + 跟随鼠标的十字参考线（对齐 Manggo 效果）。 */
export function TranslatorCapture() {
  const [start, setStart] = useState<{ x: number; y: number } | null>(null)
  const [rect, setRect] = useState<Rect | null>(null)
  const [mouse, setMouse] = useState<{ x: number; y: number } | null>(null)
  const doneRef = useRef(false)

  useEffect(() => {
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !doneRef.current) {
        doneRef.current = true
        void inv()?.('translator_capture_cancel').catch(() => {})
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const finish = (r: Rect | null) => {
    if (doneRef.current) return
    doneRef.current = true
    if (r && r.w >= 8 && r.h >= 8) {
      void inv()?.('translator_capture_finish', { x: r.x, y: r.y, w: r.w, h: r.h }).catch(() => {})
    } else {
      void inv()?.('translator_capture_cancel').catch(() => {})
    }
  }

  return (
    <div className="trs-capture"
      onMouseDown={e => { setStart({ x: e.clientX, y: e.clientY }); setRect({ x: e.clientX, y: e.clientY, w: 0, h: 0 }) }}
      onMouseMove={e => {
        setMouse({ x: e.clientX, y: e.clientY })
        if (!start) return
        setRect({
          x: Math.min(start.x, e.clientX), y: Math.min(start.y, e.clientY),
          w: Math.abs(e.clientX - start.x), h: Math.abs(e.clientY - start.y),
        })
      }}
      onMouseUp={() => { finish(rect); setStart(null) }}>
      {mouse && !start && (
        <>
          <div className="trs-capture-cross-v" style={{ left: mouse.x }} />
          <div className="trs-capture-cross-h" style={{ top: mouse.y }} />
        </>
      )}
      <div className="trs-capture-hint">拖动框选要翻译的区域 · Esc 取消</div>
      {rect && (
        <div className="trs-capture-rect" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
          {rect.w > 60 && rect.h > 24 && <span className="trs-capture-size">{Math.round(rect.w)} × {Math.round(rect.h)}</span>}
        </div>
      )}
    </div>
  )
}
