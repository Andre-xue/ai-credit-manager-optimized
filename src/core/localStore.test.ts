import { describe, it, expect, vi, beforeEach } from 'vitest'

// v0.1.510 本机关键数据文件层：复现的失败 = 更新换包后 localStorage 被重置、
// Agent 开关全关。单测锁定口径：文件为事实源、localStorage 为镜像；
// 文件有则文件赢，文件无则旧值一次性迁移，文件坏/读失败回落镜像不丢数据。

class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}

const mem = new MemStorage()
vi.stubGlobal('localStorage', mem)

interface InvokeCall { cmd: string; args: Record<string, unknown> }

function stubDesktop(files: Record<string, string | null>, opts: { failReadFor?: string[] } = {}) {
  const calls: InvokeCall[] = []
  const store: Record<string, string | null> = { ...files }
  ;(globalThis as any).window = {
    __TAURI_INTERNALS__: {
      invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
        calls.push({ cmd, args })
        if (cmd === 'local_store_read') {
          if (opts.failReadFor?.includes(args.name as string)) throw new Error('read boom')
          return store[args.name as string] ?? null
        }
        if (cmd === 'local_store_write') { store[args.name as string] = args.content as string; return null }
        return null
      }),
    },
  }
  return { calls, store }
}

function stubWeb() {
  ;(globalThis as any).window = {}
  return { calls: [] as InvokeCall[], store: {} as Record<string, string | null> }
}

async function freshLocalStore() {
  vi.resetModules()
  return import('./localStore')
}

const SETTINGS_OLD = JSON.stringify({ enabled: { dsh: true } })
const SETTINGS_FILE = JSON.stringify({ enabled: { dsh: true, pi: true } })

beforeEach(() => { mem.clear() })

describe('localStore 非桌面端（无文件层，行为不变）', () => {
  it('writeLocalStore 写镜像、readLocalStore 读回', async () => {
    stubWeb()
    const ls = await freshLocalStore()
    ls.writeLocalStore('agents-settings', SETTINGS_OLD)
    expect(mem.getItem('acm.agents.settings.v1')).toBe(SETTINGS_OLD)
    expect(ls.readLocalStore('agents-settings')).toBe(SETTINGS_OLD)
    await ls.hydrateLocalStore()
    expect(ls.readLocalStore('agents-settings')).toBe(SETTINGS_OLD)
  })
})

describe('localStore 桌面端迁移与对账', () => {
  it('文件不存在 + localStorage 有旧值 → 一次性迁移落盘', async () => {
    const { store } = stubDesktop({})
    mem.setItem('acm.agents.settings.v1', SETTINGS_OLD)
    const ls = await freshLocalStore()
    await ls.hydrateLocalStore()
    expect(store['agents-settings']).toBe(SETTINGS_OLD)
    expect(ls.readLocalStore('agents-settings')).toBe(SETTINGS_OLD)
  })

  it('文件有值 → 文件赢，覆盖 localStorage 镜像（更新重置后恢复的核心路径）', async () => {
    stubDesktop({ 'agents-settings': SETTINGS_FILE })
    mem.setItem('acm.agents.settings.v1', SETTINGS_OLD) // 镜像是旧的/被重置后重写的
    const ls = await freshLocalStore()
    await ls.hydrateLocalStore()
    expect(ls.readLocalStore('agents-settings')).toBe(SETTINGS_FILE)
    expect(mem.getItem('acm.agents.settings.v1')).toBe(SETTINGS_FILE)
  })

  it('localStorage 被清空（模拟更新重置）+ 文件在 → 数据原样恢复', async () => {
    stubDesktop({ 'agents-settings': SETTINGS_FILE, 'agents-tasks': '[{"id":"t1"}]' })
    const ls = await freshLocalStore()
    await ls.hydrateLocalStore()
    expect(ls.readLocalStore('agents-settings')).toBe(SETTINGS_FILE)
    expect(ls.readLocalStore('agents-tasks')).toBe('[{"id":"t1"}]')
  })

  it('某份文件读失败 → 只回落该份的镜像，其余照常，不抛', async () => {
    stubDesktop({ 'agents-settings': SETTINGS_FILE }, { failReadFor: ['agents-tasks'] })
    mem.setItem('acm.agents.tasks.v1', '[{"id":"mirror"}]')
    const ls = await freshLocalStore()
    await expect(ls.hydrateLocalStore()).resolves.toBeUndefined()
    expect(ls.readLocalStore('agents-tasks')).toBe('[{"id":"mirror"}]')
    expect(ls.readLocalStore('agents-settings')).toBe(SETTINGS_FILE)
  })

  it('hydrate 完成前的写入不落文件（防首屏旧镜像覆盖文件新数据），hydrate 时随迁移落盘', async () => {
    const { calls, store } = stubDesktop({})
    const ls = await freshLocalStore()
    ls.writeLocalStore('agents-ledger', '[{"id":"e1"}]')
    expect(calls.filter(c => c.cmd === 'local_store_write')).toHaveLength(0)
    await ls.hydrateLocalStore()
    expect(store['agents-ledger']).toBe('[{"id":"e1"}]')
  })

  it('hydrate 后写入直达文件', async () => {
    const { store } = stubDesktop({})
    const ls = await freshLocalStore()
    await ls.hydrateLocalStore()
    ls.writeLocalStore('agents-tasks', '[{"id":"t9"}]')
    expect(store['agents-tasks']).toBe('[{"id":"t9"}]')
    expect(mem.getItem('acm.agents.tasks.v1')).toBe('[{"id":"t9"}]')
  })
})

describe('localStore prefs', () => {
  it('prefs 文件有值 → 覆盖镜像；writePref 只收白名单键', async () => {
    const { store } = stubDesktop({ prefs: JSON.stringify({ 'acm.update.autoEnabled.v1': '0' }) })
    mem.setItem('acm.update.autoEnabled.v1', '1')
    const ls = await freshLocalStore()
    await ls.hydrateLocalStore()
    expect(ls.readPref('acm.update.autoEnabled.v1')).toBe('0')
    expect(mem.getItem('acm.update.autoEnabled.v1')).toBe('0')
    ls.writePref('acm.update.autoEnabled.v1', '1')
    expect(JSON.parse(store['prefs']!)['acm.update.autoEnabled.v1']).toBe('1')
    ls.writePref('acm.不在清单里的键', '1')
    expect(mem.getItem('acm.不在清单里的键')).toBeNull()
    expect(JSON.parse(store['prefs']!)['acm.不在清单里的键']).toBeUndefined()
  })

  it('prefs 文件损坏（非法 JSON）→ 回落镜像不崩', async () => {
    stubDesktop({ prefs: '{bad json' })
    mem.setItem('acm.update.autoEnabled.v1', '0')
    const ls = await freshLocalStore()
    await expect(ls.hydrateLocalStore()).resolves.toBeUndefined()
    expect(ls.readPref('acm.update.autoEnabled.v1')).toBe('0')
  })

  it('prefs 文件不存在 → 现有 localStorage 偏好整表迁移', async () => {
    const { store } = stubDesktop({})
    mem.setItem('acm.checkin.auto.v1', '1')
    mem.setItem('acm.lang', 'en')
    const ls = await freshLocalStore()
    await ls.hydrateLocalStore()
    const obj = JSON.parse(store['prefs']!)
    expect(obj['acm.checkin.auto.v1']).toBe('1')
    expect(obj['acm.lang']).toBe('en')
  })

  it('writePref(null) 删除键并同步文件', async () => {
    const { store } = stubDesktop({ prefs: JSON.stringify({ 'acm.update.justUpdated.v1': '0.1.510' }) })
    const ls = await freshLocalStore()
    await ls.hydrateLocalStore()
    ls.writePref('acm.update.justUpdated.v1', null)
    expect(mem.getItem('acm.update.justUpdated.v1')).toBeNull()
    expect(JSON.parse(store['prefs']!)['acm.update.justUpdated.v1']).toBeUndefined()
  })
})

describe('与 updater / agents 的集成（用户视角：开关与待安装状态）', () => {
  it('静默更新开关关过一次 → 文件记住，localStorage 清空后仍是关', async () => {
    stubDesktop({ prefs: JSON.stringify({ 'acm.update.autoEnabled.v1': '0' }) })
    const ls = await freshLocalStore()
    await ls.hydrateLocalStore()
    vi.resetModules()
    const updater = await import('./updater')
    expect(updater.loadAutoUpdateEnabled()).toBe(false)
    updater.saveAutoUpdateEnabled(true)
    expect(updater.loadAutoUpdateEnabled()).toBe(true)
  })

  it('待安装更新往返：save → load 读回同一条', async () => {
    stubDesktop({})
    const ls = await freshLocalStore()
    await ls.hydrateLocalStore()
    vi.resetModules()
    const updater = await import('./updater')
    const p = { version: '99.0.0', via: 'mirror' as const, filePath: '/tmp/x.dmg', fileName: 'x.dmg', downloadedAt: 1, deferred: true }
    expect(updater.savePendingUpdate(p)).toBe(true)
    expect(updater.loadPendingUpdate()?.version).toBe('99.0.0')
    updater.clearPendingUpdate()
    expect(updater.loadPendingUpdate()).toBeNull()
  })

  it('Agent 设置：文件里的启用开关经 loadAgentSettings 读出（更新后开关还在）', async () => {
    stubDesktop({ 'agents-settings': SETTINGS_FILE })
    const ls = await freshLocalStore()
    await ls.hydrateLocalStore()
    vi.resetModules()
    const agents = await import('./agents')
    const s = agents.loadAgentSettings()
    expect(s.enabled.dsh).toBe(true)
    expect(s.enabled.pi).toBe(true)
  })
})
