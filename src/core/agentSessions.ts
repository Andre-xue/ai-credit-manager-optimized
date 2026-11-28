// 导入会话（v0.1.512 ①）纯逻辑：会话清单的 HOME 拼装与展示文案。
// 存档的实际读取/解析在 Rust（agent_list_sessions），这里只做拼装与呈现口径，不碰 IO。
import type { AgentDef, AgentAccountEntry } from './agents'
import type { AgentAccountStatus, AgentSessionHomeIn, AgentSessionItem } from './agentBridge'
import { readLocalStore, writeLocalStore } from './localStore'

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

// ---------------- 从列表移除（v0.1.519 ④，隐藏名单、不要真删） ----------------
// Ethan 2026-11-28 20:24 改定：移除只是把会话在魔方列表里隐藏，本机存档文件
// 一个不动、DSH/Codex 里照常能续。名单按 (agentId, entryId, sessionId) 记，
// 存文件存储（agents-hidden-sessions），扫描结果在前端按名单过滤。

export interface HiddenSessionKey {
  agentId: string
  entryId: string
  sessionId: string
}

export function hiddenSessionKeyOf(k: HiddenSessionKey): string {
  return `${k.agentId}::${k.entryId}::${k.sessionId}`
}

export function loadHiddenSessions(): HiddenSessionKey[] {
  try {
    const raw = readLocalStore('agents-hidden-sessions')
    if (!raw) return []
    const p = JSON.parse(raw) as unknown
    if (!Array.isArray(p)) return []
    return p.filter((x): x is HiddenSessionKey => !!x && typeof x === 'object'
      && typeof (x as HiddenSessionKey).agentId === 'string'
      && typeof (x as HiddenSessionKey).entryId === 'string'
      && typeof (x as HiddenSessionKey).sessionId === 'string')
  } catch { return [] }
}

export function saveHiddenSessions(list: readonly HiddenSessionKey[]): void {
  writeLocalStore('agents-hidden-sessions', JSON.stringify(list))
}

/** 按隐藏名单过滤某平台的扫描结果（名单里别家的记录不影响本家） */
export function filterVisibleSessions(
  agentId: string,
  sessions: readonly AgentSessionItem[],
  hidden: readonly HiddenSessionKey[],
): AgentSessionItem[] {
  const keys = new Set(hidden.filter(h => h.agentId === agentId).map(hiddenSessionKeyOf))
  return sessions.filter(s => !keys.has(hiddenSessionKeyOf({ agentId, entryId: s.entryId, sessionId: s.sessionId })))
}

export function countHiddenForAgent(hidden: readonly HiddenSessionKey[], agentId: string): number {
  return hidden.filter(h => h.agentId === agentId).length
}

/** 恢复某平台的全部隐藏（其余平台的隐藏记录保留） */
export function restoreHiddenForAgent(hidden: readonly HiddenSessionKey[], agentId: string): HiddenSessionKey[] {
  return hidden.filter(h => h.agentId !== agentId)
}

/** 追加隐藏（去重）：单条移除与一键移除全部共用 */
export function addHiddenSessions(
  hidden: readonly HiddenSessionKey[],
  add: readonly HiddenSessionKey[],
): HiddenSessionKey[] {
  const keys = new Set(hidden.map(hiddenSessionKeyOf))
  const out = [...hidden]
  for (const k of add) {
    const key = hiddenSessionKeyOf(k)
    if (!keys.has(key)) { keys.add(key); out.push(k) }
  }
  return out
}
