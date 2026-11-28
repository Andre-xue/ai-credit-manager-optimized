import { describe, it, expect } from 'vitest'
import {
  buildSessionHomes, sessionDisplayTitle, sessionTitleSourceNote,
  filterVisibleSessions, countHiddenForAgent, restoreHiddenForAgent,
  addHiddenSessions, loadHiddenSessions, saveHiddenSessions,
} from './agentSessions'
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

describe('v0.1.519（④）：从列表移除（隐藏名单，不要真删）', () => {
  const s = (sessionId: string, entryId = 'native-dsh'): AgentSessionItem => item({ sessionId, entryId })
  const hidden = [
    { agentId: 'dsh', entryId: 'native-dsh', sessionId: 's1' },
    { agentId: 'codex-desktop', entryId: 'native-codex-desktop', sessionId: 's1' },
  ]
  it('过滤：只滤本平台命中的，别家同名 sessionId 不误伤', () => {
    const list = [s('s1'), s('s2'), s('s1', 'e2')]
    const vis = filterVisibleSessions('dsh', list, hidden)
    expect(vis.map(x => `${x.entryId}:${x.sessionId}`)).toEqual(['native-dsh:s2', 'e2:s1'])
  })
  it('计数与恢复：按平台计数；恢复只放回本平台、别家的隐藏保留', () => {
    expect(countHiddenForAgent(hidden, 'dsh')).toBe(1)
    expect(countHiddenForAgent(hidden, 'codex-desktop')).toBe(1)
    const restored = restoreHiddenForAgent(hidden, 'dsh')
    expect(restored).toEqual([{ agentId: 'codex-desktop', entryId: 'native-codex-desktop', sessionId: 's1' }])
    // 恢复后过滤不再命中
    expect(filterVisibleSessions('dsh', [s('s1')], restored)).toHaveLength(1)
  })
  it('追加隐藏去重：一键移除全部重复执行不膨胀名单', () => {
    const once = addHiddenSessions([], [
      { agentId: 'dsh', entryId: 'native-dsh', sessionId: 's1' },
      { agentId: 'dsh', entryId: 'native-dsh', sessionId: 's2' },
    ])
    const twice = addHiddenSessions(once, [
      { agentId: 'dsh', entryId: 'native-dsh', sessionId: 's1' },
      { agentId: 'dsh', entryId: 'native-dsh', sessionId: 's2' },
    ])
    expect(twice).toHaveLength(2)
  })
  it('存/读往返一致（文件层缓存面）', () => {
    saveHiddenSessions(hidden)
    expect(loadHiddenSessions()).toEqual(hidden)
    saveHiddenSessions([])
    expect(loadHiddenSessions()).toEqual([])
  })
})
