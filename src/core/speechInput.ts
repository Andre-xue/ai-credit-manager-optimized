import { isDesktopApp, isNativeApp } from './openExternal'

/**
 * 语音输入（听写）：把说的话实时转成文字填进输入框。
 * 引擎与「AI 语音通话」同款：安卓原生用 Capacitor 语音识别插件，
 * 桌面/Web 用浏览器 SpeechRecognition（系统语音识别服务，不需要额外模型）。
 */

export interface SpeechInputHandlers {
  /** 识别过程中的全文（临时结果会不断更新，停说后定稿） */
  onText: (text: string) => void
  /** 致命错误（权限/环境），会话随之结束 */
  onError: (message: string) => void
  /** 会话结束（手动停止或引擎自行结束） */
  onEnd: () => void
}

export interface SpeechInputSession {
  stop: () => void
}

interface RecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((e: any) => void) | null
  onerror: ((e: any) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
}

function webCtor(): (new () => RecognitionLike) | null {
  const w = window as unknown as { SpeechRecognition?: new () => RecognitionLike; webkitSpeechRecognition?: new () => RecognitionLike }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export function speechInputAvailable(): boolean {
  return isNativeApp() || !!webCtor()
}

function webErrorMessage(code: string): string {
  if (code === 'not-allowed' || code === 'service-not-allowed') {
    return isDesktopApp()
      ? (code === 'service-not-allowed'
        ? '语音识别服务被系统拒绝：请在「系统设置 → 隐私与安全性 → 语音识别」中允许本应用（麦克风之外还需这一项）'
        : '麦克风权限被拒绝：请在「系统设置 → 隐私与安全性 → 麦克风」中允许本应用')
      : '语音识别/麦克风权限被拒绝，请在系统设置中允许后再试'
  }
  if (code === 'network') return '语音识别需要联网，当前网络不可用'
  return '语音识别在当前环境不可用'
}

async function startNative(h: SpeechInputHandlers): Promise<SpeechInputSession | null> {
  try {
    const { SpeechRecognition } = await import('@capacitor-community/speech-recognition')
    const availRes = (await SpeechRecognition.available()) as { available: boolean } | boolean
    const isAvail = typeof availRes === 'boolean' ? availRes : availRes?.available
    if (!isAvail) return null
    const perm = await SpeechRecognition.checkPermissions()
    if (perm.speechRecognition !== 'granted') {
      const asked = await SpeechRecognition.requestPermissions()
      if (asked.speechRecognition !== 'granted') {
        h.onError('语音识别权限被拒绝，请在系统设置中允许后再试')
        return null
      }
    }
    let stopped = false
    const listener = await SpeechRecognition.addListener('partialResults', (data: { matches: string[] }) => {
      const text = data.matches?.[0] ?? ''
      if (text) h.onText(text)
    })
    await SpeechRecognition.start({ language: 'zh-CN', partialResults: true, popup: false })
    return {
      stop: () => {
        if (stopped) return
        stopped = true
        void listener.remove().catch(() => {})
        void SpeechRecognition.stop().catch(() => {})
        h.onEnd()
      },
    }
  } catch {
    return null
  }
}

function startWeb(h: SpeechInputHandlers): SpeechInputSession | null {
  const Ctor = webCtor()
  if (!Ctor) return null
  const r = new Ctor()
  r.lang = 'zh-CN'
  r.continuous = true
  r.interimResults = true
  let committed = ''
  let stopped = false
  let failed = false
  r.onresult = (e: any) => {
    let interim = ''
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i]
      if (res.isFinal) committed += res[0]?.transcript ?? ''
      else interim += res[0]?.transcript ?? ''
    }
    h.onText(committed + interim)
  }
  r.onerror = (e: any) => {
    const code = e?.error ?? 'unknown'
    if (code === 'no-speech' || code === 'aborted') return // 引擎会自行 onend，必要时自动续听
    failed = true
    h.onError(webErrorMessage(code))
  }
  r.onend = () => {
    if (stopped || failed) { h.onEnd(); return }
    // 引擎因静默自行结束：听写未被手动停止时自动续听，保持按钮状态一致
    try { r.start() } catch { h.onEnd() }
  }
  try { r.start() } catch { return null }
  return {
    stop: () => {
      if (stopped) return
      stopped = true
      try { r.stop() } catch { /* ignore */ }
      h.onEnd()
    },
  }
}

/** 开始一次听写会话；引擎不可用时回调 onError 并返回 null */
export async function startSpeechInput(h: SpeechInputHandlers): Promise<SpeechInputSession | null> {
  if (isNativeApp()) {
    const s = await startNative(h)
    if (s) return s
  }
  const s = startWeb(h)
  if (s) return s
  h.onError('当前环境不支持语音输入（需要系统语音识别服务）')
  return null
}
