import { describe, it, expect } from 'vitest'
import { defaultReasoningLevel, globalReasoningEffort, toReasoningEffort, isChatProbeCandidate } from './engines'

describe('聊天探测候选判定（v0.1.464）', () => {
  it('非对话模型不作探测候选（语音/生图/视频/向量/重排/安全分类）', () => {
    for (const id of ['CosyVoice', 'SenseVoice', 'Flux.1-dev', 'qwen-image', 'bge-m3', 'bge-reranker-v2-m3', 'text-embedding-v4', 'doubao-seedance-2.5', 'Qwen3Guard-Gen-8B', 'some-asr-model', 'some-tts-model']) {
      expect(isChatProbeCandidate(id), id).toBe(false)
    }
  })
  it('对话模型（含视觉/多模态）保留为候选', () => {
    for (const id of ['deepseek-v3', 'gpt-5', 'qwen3-vl-32b-instruct', 'qwen3-omni-flash', 'kimi-k3.1-pro']) {
      expect(isChatProbeCandidate(id), id).toBe(true)
    }
  })
})

describe('AI 思考模式全局映射', () => {
  it('开启思考模式时默认深度推理 High / medium', () => {
    expect(defaultReasoningLevel(true)).toBe('High')
    expect(globalReasoningEffort(true)).toBe('medium')
  })
  it('关闭思考模式时默认 Off / 无 effort', () => {
    expect(defaultReasoningLevel(false)).toBe('Off')
    expect(globalReasoningEffort(false)).toBeUndefined()
    expect(defaultReasoningLevel(undefined)).toBe('Off')
    expect(globalReasoningEffort(undefined)).toBeUndefined()
  })
  it('推理等级到 effort 映射保持不变', () => {
    expect(toReasoningEffort('Off')).toBeUndefined()
    expect(toReasoningEffort('Low')).toBe('minimal')
    expect(toReasoningEffort('High')).toBe('medium')
    expect(toReasoningEffort('Max')).toBe('high')
  })
})
