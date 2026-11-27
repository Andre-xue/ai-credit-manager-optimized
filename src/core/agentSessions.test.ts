import { describe, it, expect } from 'vitest'
import { buildSessionHomes, sessionDisplayTitle, sessionTitleSourceNote } from './agentSessions'
import { agentDef, type AgentAccountEntry } from './agents'
import type { AgentAccountStatus, AgentSessionItem } from './agentBridge'

const item = (patch: Partial<AgentSessionItem>): AgentSessionItem => ({
  entryId: 'native-dsh', entryLabel: '原生登录', sessionId: 's1',
  title: '', titleSource: 'none', cwd: '', createdAt: 0, updatedAt: 0, ...patch,
})

const status = (dirPath: string): AgentAccountStatus => ({ entryId: 'x', dirPath, dirExists: true, login: 'unknown' })

describe('v0.1.512（①）：导入会话', () => {
  it('buildSessionHomes：按条目拼 HOME，目录还没探测到的跳过、别家的条目不混入', () => {
    const dsh = agentDef('dsh')!
    const entries: AgentAccountEntry[] = [
      { id: 'native-dsh', agentId: 'dsh', label: '原生登录', credDir: 'native', enabled: true, createdAt: 1 },
      { id: 'e2', agentId: 'dsh', label: '副号', credDir: 'isolated', enabled: true, createdAt: 2 },
      { id: 'e3', agentId: 'dsh', label: '未探测', credDir: 'isolated', enabled: true, createdAt: 3 },
      { id: 'e9', agentId: 'codex-desktop', label: '别家', credDir: 'isolated', enabled: true, createdAt: 4 },
    ]
    const homes = buildSessionHomes(dsh, entries, {
      'native-dsh': status('/home/u/.dsh'),
      e2: status('/x/creds/dsh/e2'),
      e9: status('/x/creds/codex/e9'),
    })
    expect(homes).toEqual([
      { entryId: 'native-dsh', entryLabel: '原生登录', homePath: '/home/u/.dsh' },
      { entryId: 'e2', entryLabel: '副号', homePath: '/x/creds/dsh/e2' },
    ])
  })
  it('标题：存档自带优先；没有标题显占位；首条输入截断注明来源', () => {
    expect(sessionDisplayTitle(item({ title: '修登录 bug', titleSource: 'archive' }))).toBe('修登录 bug')
    expect(sessionDisplayTitle(item({ title: '', titleSource: 'none' }))).toBe('（无标题存档）')
    expect(sessionTitleSourceNote(item({ title: '帮我写个脚本', titleSource: 'first-input' }))).toBe('标题取自首条输入')
    expect(sessionTitleSourceNote(item({ title: '修登录 bug', titleSource: 'archive' }))).toBe('')
    expect(sessionTitleSourceNote(item({ title: '', titleSource: 'none' }))).toBe('存档里没有标题')
  })
})
