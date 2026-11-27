import { describe, it, expect } from 'vitest'
import { groupOptionsByPlatform, platformKeyOf, platformNameOf, modelNameOf, type CascadeOptionLike } from './modelCascade'

type Opt = CascadeOptionLike & { key: string }
const own = (id: string, providerId: string, label: string): Opt => ({
  key: `own:${id}`, label, account: { id, providerId, label },
})
const cloud = (id: string, name: string): Opt => ({ key: id, label: name, account: null })
const up = (source: 'zen' | 'kilo', id: string, name: string): Opt => ({
  key: `up:${source}:${id}`, label: `${name} · ${source === 'zen' ? 'Zen' : 'Kilo'}`, account: null, upstream: source,
})
const apisFree = (): Opt => ({ key: 'apisfree:llama-3.3-70b', label: 'llama-3.3-70b · APIsFreeLLM', account: null, apisFree: true })
const local = (id: string): Opt => ({ key: `local:${id}`, label: id, account: null, localModel: id })

describe('三段选择器级联分组（v0.1.496）', () => {
  it('自有账户各自成平台，平台名取服务商简称', () => {
    const groups = groupOptionsByPlatform([own('a1', 'deepseek', 'DeepSeek 主力'), own('a2', 'moma', 'MoMA')])
    expect(groups.map(g => g.platformName)).toEqual(['DeepSeek', 'MoMA'])
    expect(groups[0].platformKey).toBe('own:a1')
    expect(groups[0].options).toHaveLength(1)
  })

  it('同服务商多账户同名时回退账户备注名消歧', () => {
    const groups = groupOptionsByPlatform([own('a1', 'deepseek', 'DeepSeek 主号'), own('a2', 'deepseek', 'DeepSeek 备用')])
    expect(groups.map(g => g.platformName)).toEqual(['DeepSeek 主号', 'DeepSeek 备用'])
  })

  it('云端免费模型归 WorkBuddy 平台且同组', () => {
    const groups = groupOptionsByPlatform([cloud('m1', 'Auto'), cloud('m2', 'Hy4')])
    expect(groups).toHaveLength(1)
    expect(groups[0].platformKey).toBe('workbuddy')
    expect(groups[0].platformName).toBe('WorkBuddy')
    expect(groups[0].options.map(o => o.key)).toEqual(['m1', 'm2'])
  })

  it('免费分类：Zen / Kilo / APIsFreeLLM 各自成平台，顺序按首次出现', () => {
    const groups = groupOptionsByPlatform([cloud('m1', 'Auto'), up('zen', 'z1', 'MiMo'), apisFree(), up('zen', 'z2', 'GLM'), up('kilo', 'k1', 'Kimi')])
    expect(groups.map(g => g.platformName)).toEqual(['WorkBuddy', 'Zen', 'APIsFreeLLM', 'Kilo'])
    expect(groups[1].options.map(o => o.key)).toEqual(['up:zen:z1', 'up:zen:z2'])
  })

  it('本地模型归 Ollama 平台', () => {
    const groups = groupOptionsByPlatform([local('qwen3:8b'), local('llama3:8b')])
    expect(groups).toHaveLength(1)
    expect(groups[0].platformName).toBe('Ollama')
    expect(platformKeyOf(local('x'))).toBe('ollama')
  })

  it('模型展示名去掉来源后缀，只留模型名', () => {
    expect(modelNameOf(up('zen', 'z1', 'MiMo V2.6'))).toBe('MiMo V2.6')
    expect(modelNameOf(apisFree())).toBe('llama-3.3-70b')
    expect(modelNameOf(cloud('m1', 'Auto'))).toBe('Auto')
    expect(modelNameOf(local('qwen3:8b'))).toBe('qwen3:8b')
  })

  it('平台键与平台名对各类选项稳定', () => {
    expect(platformKeyOf(own('a9', 'inferbase', 'Inferbase'))).toBe('own:a9')
    expect(platformNameOf(own('a9', 'inferbase', 'Inferbase'))).toBe('Inferbase')
    expect(platformNameOf(own('a10', 'oneai', 'One AI'))).toBe('One AI')
    expect(platformNameOf(apisFree())).toBe('APIsFreeLLM')
    expect(platformKeyOf(cloud('m1', 'Auto'))).toBe('workbuddy')
  })

  it('空列表返回空分组', () => {
    expect(groupOptionsByPlatform([])).toEqual([])
  })
})
