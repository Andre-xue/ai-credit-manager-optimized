// 免费 AI 模型（供 AI 翻译等模块复用 AI 助手的免费来源）：
// 1) 云端免费模型（WorkBuddy 网关 listModels，需登录云账号；未登录时该组为空）；
// 2) 上游免费通道 Zen / Kilo（免 Key 匿名直连，清单缓存 6 小时）。
// 过滤规则：只保留能做文本对话的模型——嵌入（embedding）与语音（audio）类不能翻译，直接剔除；
// 视觉语言（VL）模型保留（文本对话照常可用）。

import { listModels, streamChat, type AiModel } from './ai'
import { fetchUpstreamFreeModels, chatUpstream, UPSTREAM_LABEL, type UpstreamModel, type UpstreamSource } from './upstreamFree'
import { detectModelCapability } from './modelCapability'

export interface FreeAiOption {
  key: string
  label: string
  group: '云端免费' | 'Zen 免费通道' | 'Kilo 免费通道'
  source: 'cloud' | UpstreamSource
  modelId: string
}

/** 该模型能否直接用于翻译（文本对话）：嵌入/语音类不行 */
export function isTranslatableFreeModel(modelId: string): boolean {
  const cap = detectModelCapability(modelId).capability
  return cap !== 'embedding' && cap !== 'audio'
}

/** 合并三路来源为选项列表（纯函数，便于测试） */
export function buildFreeAiOptions(cloud: AiModel[], upstream: UpstreamModel[]): FreeAiOption[] {
  const out: FreeAiOption[] = []
  for (const m of cloud) {
    if (m.disabled || !isTranslatableFreeModel(m.id)) continue
    out.push({ key: `cloud:${m.id}`, label: m.name || m.id, group: '云端免费', source: 'cloud', modelId: m.id })
  }
  for (const m of upstream) {
    if (!isTranslatableFreeModel(m.id)) continue
    out.push({
      key: `up:${m.source}:${m.id}`,
      label: `${m.name} · ${UPSTREAM_LABEL[m.source]}`,
      group: m.source === 'zen' ? 'Zen 免费通道' : 'Kilo 免费通道',
      source: m.source,
      modelId: m.id,
    })
  }
  return out
}

/** 拉取全部免费 AI 模型选项；单路失败不影响其他路（云端未登录时仅剩 Zen/Kilo） */
export async function loadFreeAiOptions(): Promise<FreeAiOption[]> {
  let cloud: AiModel[] = []
  try { cloud = await listModels() } catch { /* 未登录云账号：云端组为空 */ }
  let upstream: UpstreamModel[] = []
  try { upstream = await fetchUpstreamFreeModels() } catch { /* 网络失败：上游组为空 */ }
  return buildFreeAiOptions(cloud, upstream)
}

/** 用所选免费模型完成一次对话（翻译场景：system 提示 + 单条文本） */
export async function freeAiChat(opt: FreeAiOption, system: string, text: string): Promise<string> {
  if (opt.source === 'cloud') {
    // 独立 conversationId，避免与 AI 助手页面的对话流互相冲突被网关拒绝
    const convId = `tr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    return streamChat(opt.modelId, [], text, () => {}, undefined, undefined, undefined, system, convId)
  }
  return chatUpstream(opt.source, opt.modelId, [
    { role: 'system', content: system },
    { role: 'user', content: text },
  ])
}
