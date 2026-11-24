// Qwen3-TTS 本地克隆音色（MLX 后端，仅桌面端 Apple 芯片 Mac）：
// 服务由 App 以本地服务开关管理（端口 18123，模型 mlx-community/Qwen3-TTS-12Hz-0.6B-Base-4bit，
// 4-bit 量化权重约 1GB），合成走 Rust 后端调本机 /v1/audio/clone。
// 服务端无音色注册表：每次合成都要带参考音频，因此已保存的 Qwen 音色把参考音频存在本机 IndexedDB。
// 注意：PyTorch/MPS 路线在 8GB 机器上内存占用约 10GB 会狂换页，故默认走 MLX 路线；
// 首次安装需下载约 1GB 模型，服务启动后模型加载约 5~30 秒，均由 Rust 端明确报错、不静默兜底。

import { isDesktopApp } from './openExternal'
import { uid } from './store'
import { addClonedVoice, type ClonedVoice } from './voiceClone'

export const QWENTTS_PORT = 18123
export const QWENTTS_URL = 'http://127.0.0.1:18123'
/** MLX 量化版 Base 模型（官方 mlx-tts-server 支持表内 0.6B 克隆档；权重约 1GB） */
export const QWENTTS_MODEL_ID = 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-4bit'
/** Qwen 官方原版权重（与 MLX 版同源，供界面说明） */
export const QWENTTS_OFFICIAL_MODEL_ID = 'Qwen/Qwen3-TTS-12Hz-0.6B-Base'
export const QWEN_VOICE_PREFIX = 'qwen-local:'

export interface QwenTtsStatus {
  installed: boolean
  /** 找到的 Python 版本（如 '3.13.1'），未找到为空串 */
  python: string
  pythonOk: boolean
  modelCached: boolean
  running: boolean
  url: string | null
  /** 服务日志尾部（服务起不来时看原因），无日志为空串 */
  lastLog: string
}

const EMPTY_STATUS: QwenTtsStatus = {
  installed: false, python: '', pythonOk: false, modelCached: false, running: false, url: null, lastLog: '',
}

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>

function getInvoke(): Invoke | null {
  if (!isDesktopApp()) return null
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke?: Invoke } }
  return w.__TAURI_INTERNALS__?.invoke ?? null
}

/** 是否为本机 Qwen 克隆音色（voiceId 前缀判定） */
export function isQwenVoiceId(voiceId: string | null | undefined): boolean {
  return typeof voiceId === 'string' && voiceId.startsWith(QWEN_VOICE_PREFIX)
}

export function newQwenVoiceId(): string {
  return `${QWEN_VOICE_PREFIX}${uid('qw')}`
}

/** 安装/运行状态（未安装、Python 版本、模型是否已下载、服务是否在跑） */
export async function qwenTtsStatus(): Promise<QwenTtsStatus> {
  const invoke = getInvoke()
  if (!invoke) return { ...EMPTY_STATUS, lastLog: '仅桌面端支持 Qwen3-TTS 本地服务' }
  try {
    const raw = (await invoke('qwentts_status')) as string
    const j = JSON.parse(raw) as Partial<QwenTtsStatus>
    return { ...EMPTY_STATUS, ...j }
  } catch (e) {
    return { ...EMPTY_STATUS, lastLog: `状态查询失败：${(e as Error)?.message ?? String(e)}` }
  }
}

/**
 * 首次安装准备（同步长任务，几分钟）：建 venv → pip 安装 mlx-tts-server → 预下载约 1GB 模型。
 * 失败时返回 Rust 端带出的真实原因（Python 版本、网络、磁盘等），不静默。
 */
export async function qwenTtsSetup(): Promise<{ ok: boolean; message: string }> {
  const invoke = getInvoke()
  if (!invoke) return { ok: false, message: '仅桌面端支持 Qwen3-TTS 本地服务' }
  try {
    const message = (await invoke('qwentts_setup')) as string
    return { ok: true, message }
  } catch (e) {
    return { ok: false, message: (e as Error)?.message ?? String(e) }
  }
}

/** 测试本机服务连接（GET /health） */
export async function qwenTtsTest(): Promise<{ ok: boolean; message: string }> {
  const invoke = getInvoke()
  if (!invoke) return { ok: false, message: '仅桌面端支持 Qwen3-TTS 本地服务' }
  try {
    const message = (await invoke('qwentts_test')) as string
    return { ok: true, message }
  } catch (e) {
    return { ok: false, message: (e as Error)?.message ?? String(e) }
  }
}

/**
 * 用参考音频克隆合成一段语音（走本机 /v1/audio/clone，language=auto 由服务端按文本自动识别）。
 * 返回音频 data URI（wav）。服务未运行、参考音频无效、合成失败时抛错，调用方显示原因。
 */
export async function qwenTtsSynthesize(refAudioDataUrl: string, refText: string, text: string): Promise<string> {
  const invoke = getInvoke()
  if (!invoke) throw new Error('仅桌面端支持 Qwen3-TTS 本地服务')
  return (await invoke('qwentts_synthesize', {
    audioDataUrl: refAudioDataUrl,
    refText: refText ?? '',
    text,
  })) as string
}

// ==================== 已保存 Qwen 音色的参考音频（本机 IndexedDB） ====================

const DB_NAME = 'acm-qwen-tts-db'
const STORE = 'refs'

export interface QwenVoiceRef {
  voiceId: string
  name: string
  /** 参考音频 data URI（与克隆样本一致） */
  dataUrl: string
  /** 参考音频的原文（可为空；写上合成效果更好） */
  refText: string
  createdAt: number
}

let dbPromise: Promise<IDBDatabase> | null = null
function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'voiceId' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

/** 保存一个 Qwen 克隆音色：建 voiceId、存参考音频、写入克隆音色列表 */
export async function saveQwenVoice(name: string, dataUrl: string, refText: string, sampleName?: string): Promise<ClonedVoice> {
  const voiceId = newQwenVoiceId()
  const ref: QwenVoiceRef = { voiceId, name, dataUrl, refText: refText ?? '', createdAt: Date.now() }
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(ref)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  return addClonedVoice(name, voiceId, sampleName)
}

/** 取出某 Qwen 音色的参考音频；不存在返回 null */
export async function loadQwenVoiceRef(voiceId: string): Promise<QwenVoiceRef | null> {
  try {
    const db = await openDb()
    return await new Promise<QwenVoiceRef | null>((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(voiceId)
      req.onsuccess = () => resolve((req.result as QwenVoiceRef | undefined) ?? null)
      req.onerror = () => reject(req.error)
    })
  } catch {
    return null
  }
}

/** 删除某 Qwen 音色的参考音频（删除音色记录时调用） */
export async function deleteQwenVoiceRef(voiceId: string): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(voiceId)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch { /* 忽略 */ }
}
