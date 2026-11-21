import { describe, it, expect } from 'vitest'
import { buildFreeAiOptions, isTranslatableFreeModel } from './freeAi'
import type { AiModel } from './ai'
import type { UpstreamModel } from './upstreamFree'

describe('免费 AI 模型（翻译可用性过滤）', () => {
  it('嵌入/语音类不能翻译被剔除，对话与视觉语言保留', () => {
    expect(isTranslatableFreeModel('text-embedding-3-small')).toBe(false)
    expect(isTranslatableFreeModel('nomic-embed-text')).toBe(false)
    expect(isTranslatableFreeModel('whisper-large-v3')).toBe(false)
    expect(isTranslatableFreeModel('glm-4.6')).toBe(true)
    expect(isTranslatableFreeModel('nemotron-3.5-super-vl-free')).toBe(true) // VL 可文本对话
    expect(isTranslatableFreeModel('openrouter/free')).toBe(true)
  })

  it('三路来源合并分组，禁用与不可翻译的被过滤', () => {
    const cloud: AiModel[] = [
      { id: 'glm-4.6', name: 'GLM-4.6' },
      { id: 'some-embed', name: 'Embed', disabled: false },
      { id: 'off-model', name: 'Off', disabled: true },
    ]
    const upstream: UpstreamModel[] = [
      { source: 'zen', id: 'deepseek-v4.1-flash-free', name: 'DeepSeek V4.1 Flash' },
      { source: 'kilo', id: 'openrouter/free', name: 'OpenRouter Free' },
    ]
    const opts = buildFreeAiOptions(cloud, upstream)
    expect(opts.map(o => o.key)).toEqual([
      'cloud:glm-4.6',
      'up:zen:deepseek-v4.1-flash-free',
      'up:kilo:openrouter/free',
    ])
    expect(opts[0].group).toBe('云端免费')
    expect(opts[1].group).toBe('Zen 免费通道')
    expect(opts[1].label).toContain('Zen')
    expect(opts[2].group).toBe('Kilo 免费通道')
  })
})
