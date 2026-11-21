// AI 助手会话存储的跨组件通道：会话数据存 localStorage（acm_ai_sessions_v1，AIView 拥有完整读写），
// 左侧边栏的历史列表通过本模块读元信息、发打开/新建/改名/删除请求，AIView 监听事件同步。

export const SESSIONS_KEY = 'acm_ai_sessions_v1'
export const SESSIONS_EVENT = 'acm-sessions-changed'
export const OPEN_SESSION_EVENT = 'acm-open-session'
export const NEW_SESSION_EVENT = 'acm-new-session'
export const TOGGLE_HISTORY_EVENT = 'acm-toggle-history'

const PENDING_OPEN_KEY = 'acm_ai_open_session_pending'
const PENDING_NEW_KEY = 'acm_ai_new_session_pending'

export interface SessionMeta {
  id: string
  title: string
  updatedAt: number
  count: number
}

interface StoredSession {
  id: string
  title: string
  messages: unknown[]
  updatedAt: number
}

interface RawStore {
  sessions: StoredSession[]
  activeId: string
}

export function readRawStore(): RawStore | null {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as RawStore
    if (!Array.isArray(parsed.sessions)) return null
    return parsed
  } catch { return null }
}

function writeRawStore(store: RawStore): void {
  try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(store)) } catch { /* 忽略 */ }
  window.dispatchEvent(new Event(SESSIONS_EVENT))
}

/** 边栏用：只读会话元信息（标题/时间/条数），按最近更新倒序 */
export function loadSessionList(): { sessions: SessionMeta[]; activeId: string } {
  const store = readRawStore()
  if (!store) return { sessions: [], activeId: '' }
  const sessions = store.sessions
    .map(s => ({ id: s.id, title: s.title || '新对话', updatedAt: s.updatedAt || 0, count: Array.isArray(s.messages) ? s.messages.length : 0 }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  return { sessions, activeId: store.activeId }
}

export function updateSessionTitle(id: string, title: string): void {
  const store = readRawStore()
  if (!store) return
  writeRawStore({ ...store, sessions: store.sessions.map(s => s.id === id ? { ...s, title } : s) })
}

/** 删除会话：删的是当前会话则切到剩余第一个；全删光则补一个空会话（与 AIView 内删除语义一致） */
export function deleteStoredSession(id: string): void {
  const store = readRawStore()
  if (!store) return
  const rest = store.sessions.filter(s => s.id !== id)
  if (!rest.length) {
    const fresh: StoredSession = { id: `sess-${Date.now()}`, title: '新对话', messages: [], updatedAt: Date.now() }
    writeRawStore({ sessions: [fresh], activeId: fresh.id })
    return
  }
  writeRawStore({ sessions: rest, activeId: store.activeId === id ? rest[0].id : store.activeId })
}

/** 请求打开某会话：写 pending（AIView 未挂载时挂载后消费）+ 发事件（已挂载时立即响应） */
export function requestOpenSession(id: string): void {
  try { localStorage.setItem(PENDING_OPEN_KEY, id) } catch { /* 忽略 */ }
  window.dispatchEvent(new Event(OPEN_SESSION_EVENT))
}

export function requestNewSession(): void {
  try { localStorage.setItem(PENDING_NEW_KEY, '1') } catch { /* 忽略 */ }
  window.dispatchEvent(new Event(NEW_SESSION_EVENT))
}

export function requestToggleHistory(): void {
  window.dispatchEvent(new Event(TOGGLE_HISTORY_EVENT))
}

/** AIView 消费 pending 请求，返回需要执行的动作（消费后即清除） */
export function consumePendingSessionActions(): { openId?: string; wantNew?: boolean } {
  const out: { openId?: string; wantNew?: boolean } = {}
  try {
    const openId = localStorage.getItem(PENDING_OPEN_KEY)
    if (openId) { out.openId = openId; localStorage.removeItem(PENDING_OPEN_KEY) }
    if (localStorage.getItem(PENDING_NEW_KEY)) { out.wantNew = true; localStorage.removeItem(PENDING_NEW_KEY) }
  } catch { /* 忽略 */ }
  return out
}
