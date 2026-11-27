import { describe, it, expect } from 'vitest'
import {
  sidebarMenuItems, sidebarUpdateHasDot, sidebarUpdateBusy,
  SETTINGS_AUDIT_TARGET, SETTINGS_ACCOUNT_TARGET, HELP_FEEDBACK_URL,
} from './sidebarMenu'
import type { AutoUpdateUiState } from './autoUpdate'

const idle: AutoUpdateUiState = { kind: 'idle' }

describe('sidebarMenu（v0.1.493 侧边栏底部弹出菜单）', () => {
  it('桌面端菜单六项顺序固定：设置/操作历史/帮助/检查更新/关于/折叠', () => {
    const items = sidebarMenuItems(idle, { isDesktop: true })
    expect(items.map(i => i.id)).toEqual(['settings', 'audit', 'help', 'update', 'about', 'collapse'])
  })

  it('非桌面端没有检查更新项（更新机制仅桌面）', () => {
    const items = sidebarMenuItems(idle, { isDesktop: false })
    expect(items.map(i => i.id)).toEqual(['settings', 'audit', 'help', 'about', 'collapse'])
  })

  it('更新红点：available/ready/deferred 带红点，idle/downloading/installing 不带', () => {
    expect(sidebarUpdateHasDot({ kind: 'available', version: '0.1.494' })).toBe(true)
    expect(sidebarUpdateHasDot({ kind: 'ready', version: '0.1.494', promptOpen: false })).toBe(true)
    expect(sidebarUpdateHasDot({ kind: 'deferred', version: '0.1.494' })).toBe(true)
    expect(sidebarUpdateHasDot(idle)).toBe(false)
    expect(sidebarUpdateHasDot({ kind: 'downloading', version: '0.1.494', downloaded: 1 })).toBe(false)
    expect(sidebarUpdateHasDot({ kind: 'installing', version: '0.1.494', waitingBusy: false })).toBe(false)
  })

  it('更新忙碌：downloading/installing 转圈，其余不转', () => {
    expect(sidebarUpdateBusy({ kind: 'downloading', version: '0.1.494', downloaded: 1 })).toBe(true)
    expect(sidebarUpdateBusy({ kind: 'installing', version: '0.1.494', waitingBusy: true })).toBe(true)
    expect(sidebarUpdateBusy(idle)).toBe(false)
    expect(sidebarUpdateBusy({ kind: 'ready', version: '0.1.494', promptOpen: true })).toBe(false)
  })

  it('菜单里的更新项随状态带 dot/busy 标记', () => {
    const ready = sidebarMenuItems({ kind: 'ready', version: '0.1.494', promptOpen: false }, { isDesktop: true })
    expect(ready.find(i => i.id === 'update')).toEqual({ id: 'update', dot: true, busy: false })
    const dl = sidebarMenuItems({ kind: 'downloading', version: '0.1.494', downloaded: 5, total: 10 }, { isDesktop: true })
    expect(dl.find(i => i.id === 'update')).toEqual({ id: 'update', dot: false, busy: true })
    const plain = sidebarMenuItems(idle, { isDesktop: true })
    expect(plain.find(i => i.id === 'update')).toEqual({ id: 'update', dot: false, busy: false })
  })

  it('深链目标：操作历史=security/audit、账户项=data', () => {
    expect(SETTINGS_AUDIT_TARGET).toEqual({ cat: 'security', sub: 'audit' })
    expect(SETTINGS_ACCOUNT_TARGET).toEqual({ cat: 'data' })
  })

  it('帮助与反馈指向本仓库 issues 页', () => {
    expect(HELP_FEEDBACK_URL).toBe('https://github.com/Andre-xue/ai-credit-manager-optimized/issues')
  })
})
