// Edge 免费音色：微软 Edge「大声朗读」的云端神经网络音色（非官方接口，无需 Key、不花钱）。
// WebView 内直接走 WSS，桌面/手机通用。微软若调整校验（Sec-MS-GEC 版本号），需跟着更新 GEC_VERSION。
const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const GEC_VERSION = '1-143.0.3650.75'
const EDGE_VOICE_KEY = 'acm.tts.edgeVoice'
const SPEAK_PREF_KEY = 'acm.tts.speakPref'

export interface EdgeVoice { id: string; name: string; desc: string }
export const EDGE_VOICES: EdgeVoice[] = [
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓', desc: '女声 · 温暖自然' },
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊', desc: '女声 · 活泼明亮' },
  { id: 'zh-CN-XiaohanNeural', name: '晓涵', desc: '女声 · 温柔舒缓' },
  { id: 'zh-CN-YunjianNeural', name: '云健', desc: '男声 · 沉稳有力' },
  { id: 'zh-CN-YunyangNeural', name: '云扬', desc: '男声 · 新闻播报' },
  { id: 'zh-CN-YunxiaNeural', name: '云夏', desc: '男声 · 少年清朗' },
]

export function getEdgeVoiceId(): string {
  try { return localStorage.getItem(EDGE_VOICE_KEY) || EDGE_VOICES[0].id } catch { return EDGE_VOICES[0].id }
}
export function setEdgeVoiceId(id: string): void {
  try { localStorage.setItem(EDGE_VOICE_KEY, id) } catch { /* ignore */ }
}
/** 朗读音色来源偏好：'edge' 时全局走 Edge 免费音色；选克隆/系统音色时清掉 */
export function getSpeakPref(): string {
  try { return localStorage.getItem(SPEAK_PREF_KEY) ?? '' } catch { return '' }
}
export function setSpeakPref(v: string): void {
  try { if (v) localStorage.setItem(SPEAK_PREF_KEY, v); else localStorage.removeItem(SPEAK_PREF_KEY) } catch { /* ignore */ }
}

async function secMsGec(): Promise<string> {
  let ticks = Math.floor(Date.now() / 1000) + 11644473600
  ticks -= ticks % 300
  const str = `${BigInt(ticks) * 10000000n}${TOKEN}`
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase()
}

function edgeTimestamp(): string {
  const d = new Date()
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const p = (n: number) => String(n).padStart(2, '0')
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${p(d.getUTCDate())} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/** 用指定 Edge 音色合成一句话，返回 mp3 的 ArrayBuffer */
export async function synthesizeEdgeMp3(text: string, voice: string): Promise<ArrayBuffer> {
  const gec = await secMsGec()
  const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TOKEN}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${GEC_VERSION}`
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    const chunks: Uint8Array[] = []
    const timer = setTimeout(() => { try { ws.close() } catch { /* ignore */ } reject(new Error('Edge 音色合成超时')) }, 30000)
    const reqId = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('')
    ws.onopen = () => {
      const ts = edgeTimestamp()
      ws.send(`X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`)
      ws.send(`X-RequestId:${reqId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}\r\nPath:ssml\r\n\r\n<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN"><voice name="${voice}"><prosody pitch="+0Hz" rate="+0%" volume="+0%">${xmlEscape(text)}</prosody></voice></speak>`)
    }
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        if (ev.data.includes('Path:turn.end')) {
          clearTimeout(timer)
          try { ws.close() } catch { /* ignore */ }
          const total = chunks.reduce((n, c) => n + c.length, 0)
          if (!total) { reject(new Error('Edge 未返回音频')); return }
          const out = new Uint8Array(total)
          let off = 0
          for (const c of chunks) { out.set(c, off); off += c.length }
          resolve(out.buffer)
        }
        return
      }
      const buf = new Uint8Array(ev.data as ArrayBuffer)
      if (buf.length < 2) return
      const headerLen = (buf[0] << 8) | buf[1]
      const header = new TextDecoder().decode(buf.slice(2, 2 + headerLen))
      if (header.includes('Path:audio')) chunks.push(buf.slice(2 + headerLen))
    }
    ws.onerror = () => { clearTimeout(timer); reject(new Error('Edge 音色连接失败（网络不通或微软接口变更）')) }
  })
}
