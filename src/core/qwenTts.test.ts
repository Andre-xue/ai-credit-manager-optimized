import { describe, it, expect } from 'vitest'
import {
  isQwenVoiceId, newQwenVoiceId, QWENTTS_PORT, QWENTTS_URL, QWENTTS_MODEL_ID, QWEN_VOICE_PREFIX,
  friendlyQwenError,
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

describe('Qwen 服务端 ffmpeg 报错翻译（v0.1.414 兜底）', () => {
  it('服务端报 ffmpeg 缺失时换成中文指引', () => {
    const raw = '合成失败（HTTP 400）：{"detail":"ref_audio is not WAV and ffmpeg conversion failed: [Errno 2] No such file or directory: \'ffmpeg\'. Install ffmpeg: brew install ffmpeg"}'
    expect(friendlyQwenError(raw)).toBe('参考音频不是 WAV 且本机未装 ffmpeg，请改用 WAV 音频或安装 ffmpeg（终端运行 brew install ffmpeg）')
  })
  it('只有 ref_audio is not WAV 也翻译', () => {
    expect(friendlyQwenError('ref_audio is not WAV')).toContain('请改用 WAV 音频')
  })
  it('其他错误原样返回', () => {
    expect(friendlyQwenError('合成失败（HTTP 500）：内部错误')).toBe('合成失败（HTTP 500）：内部错误')
    expect(friendlyQwenError('服务未运行')).toBe('服务未运行')
  })
})
