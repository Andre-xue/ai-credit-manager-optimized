import { describe, it, expect } from 'vitest'
import {
  isQwenVoiceId, newQwenVoiceId, QWENTTS_PORT, QWENTTS_URL, QWENTTS_MODEL_ID, QWEN_VOICE_PREFIX,
} from './qwenTts'

describe('Qwen3-TTS 本地服务常量（v0.1.400）', () => {
  it('端口与模型 ID 与 Rust 端一致（专属端口，不与 Ollama/ComfyUI/LM Studio 撞）', () => {
    expect(QWENTTS_PORT).toBe(18123)
    expect(QWENTTS_URL).toBe('http://127.0.0.1:18123')
    // 官方 mlx-tts-server 支持表内 0.6B 克隆档（4-bit 量化，权重约 1GB）
    expect(QWENTTS_MODEL_ID).toBe('mlx-community/Qwen3-TTS-12Hz-0.6B-Base-4bit')
  })
  it('Qwen 音色 ID 前缀判定', () => {
    expect(isQwenVoiceId('qwen-local:qw_abc123')).toBe(true)
    expect(isQwenVoiceId('cosyvoice-v2-xxx')).toBe(false)
    expect(isQwenVoiceId('')).toBe(false)
    expect(isQwenVoiceId(null)).toBe(false)
    expect(isQwenVoiceId(undefined)).toBe(false)
  })
  it('新音色 ID 带前缀且每次不同', () => {
    const a = newQwenVoiceId()
    const b = newQwenVoiceId()
    expect(a.startsWith(QWEN_VOICE_PREFIX)).toBe(true)
    expect(a).not.toBe(b)
    expect(isQwenVoiceId(a)).toBe(true)
  })
})
