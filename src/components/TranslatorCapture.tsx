import { useEffect, useRef, useState } from 'react'

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
function inv(): InvokeFn | null {
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke?: InvokeFn } }
  return w.__TAURI_INTERNALS__?.invoke ?? null
}

interface Rect { x: number; y: number; w: number; h: number }

/** 截图框选层（独立窗口 #/translator-capture）：全屏透明层，拖出选区后交给 Rust 截图+OCR。
 * v0.1.451：窗口真透明（main.tsx 已在渲染前清 html/body 底色，这里再兜底清一次），
 * 底下内容清晰可见，只叠一层轻微变暗 + 跟随鼠标的十字参考线（对齐 Manggo 效果）。
 * v0.1.465：窗口跨会话复用、组件不卸载——旧版 doneRef 在首会话结束后永不
 * 复位，第二次起 Esc 与松手 finish 全被早退吞掉、框选层关不掉只能杀进程。
 * 现在 Rust 每会话发 translator-capture-begin，前端据此复位全部会话状态；
 * Esc 在活跃会话里无条件可取消（取消命令本身幂等）；每会话另设 90 秒兜底
 * 自关，任何状态残留下都不许再卡死在框选层。 */
export function TranslatorCapture() {
  const [start, setStart] = useState<{ x: number; y: number } | null>(null)
  const [rect, setRect] = useState<Rect | null>(null)
  const [mouse, setMouse] = useState<{ x: number; y: number } | null>(null)
  const doneRef = useRef(false)
  // 首会话的 begin 事件可能早于监听注册到达，初始即按活跃处理（Esc 先保底可用）
  const activeRef = useRef(true)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    const clearTimer = () => {
      if (timerRef.current !== null) { window.clearTimeout(timerRef.current); timerRef.current = null }
    }
    const cancelNow = () => {
      doneRef.current = true
      activeRef.current = false
      clearTimer()
      void inv()?.('translator_capture_cancel').catch(() => {})
    }
    const armTimer = () => {
      clearTimer()
      // 兜底自关：会话开启 90 秒仍未结束就自动取消——Esc/焦点全失效时也不卡死
      timerRef.current = window.setTimeout(() => { if (activeRef.current && !doneRef.current) cancelNow() }, 90_000)
    }
    armTimer()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !activeRef.current) return
      // 活跃会话里 Esc 必达：不看 doneRef（它只防 finish 重入）——取消命令
      // 幂等，Rust 侧只是 hide 窗口，多发无害
      cancelNow()
    }
    window.addEventListener('keydown', onKey)
    let unlisten: (() => void) | undefined
    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        unlisten = await listen<{ session: number }>('translator-capture-begin', () => {
          // 新会话：复位全部会话状态（第二次起 Esc/finish 失效的根因修复点）
          doneRef.current = false
          activeRef.current = true
          setStart(null)
          setRect(null)
          setMouse(null)
          armTimer()
        })
      } catch { /* 非 Tauri 环境忽略 */ }
    })()
    return () => { window.removeEventListener('keydown', onKey); unlisten?.(); clearTimer() }
  }, [])

  const finish = (r: Rect | null) => {
    if (doneRef.current) return
    doneRef.current = true
    activeRef.current = false
    if (timerRef.current !== null) { window.clearTimeout(timerRef.current); timerRef.current = null }
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
