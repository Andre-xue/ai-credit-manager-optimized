// 导入会话（v0.1.512 ①）纯逻辑：会话清单的 HOME 拼装与展示文案。
// 存档的实际读取/解析在 Rust（agent_list_sessions），这里只做拼装与呈现口径，不碰 IO。
import type { AgentDef, AgentAccountEntry } from './agents'
import type { AgentAccountStatus, AgentSessionHomeIn, AgentSessionItem } from './agentBridge'

/** 拼某 Agent 各条目的存档 HOME：原生条目 = 原生凭据目录（DSH_HOME / CODEX_HOME 本尊），
 *  隔离条目 = 隔离凭据目录。dirPath 还没探测到（空）的条目跳过，Rust 侧也会再验目录在不在。 */
export function buildSessionHomes(
  def: AgentDef,
  entries: readonly AgentAccountEntry[],
  statusMap: Record<string, AgentAccountStatus>,
): AgentSessionHomeIn[] {
  const out: AgentSessionHomeIn[] = []
  for (const e of entries) {
    if (e.agentId !== def.id) continue
    const dirPath = statusMap[e.id]?.dirPath ?? ''
    if (!dirPath) continue
    out.push({ entryId: e.id, entryLabel: e.label, homePath: dirPath })
  }
  return out
}

/** 会话标题展示：存档没标题就如实写「无标题存档」；取首条输入的注明来源，不冒充存档标题 */
export function sessionDisplayTitle(s: Pick<AgentSessionItem, 'title' | 'titleSource'>): string {
  if (s.title) return s.title
  return '（无标题存档）'
}

export function sessionTitleSourceNote(s: Pick<AgentSessionItem, 'title' | 'titleSource'>): string {
  if (s.title && s.titleSource === 'first-input') return '标题取自首条输入'
  if (!s.title) return '存档里没有标题'
  return ''
}
