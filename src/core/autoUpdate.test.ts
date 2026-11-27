import { describe, it, expect, beforeEach, vi } from 'vitest'

// v0.1.503 更新安装触发链回归（真机「已下载好点现在更新没反应」）：
// - 「现在更新」在有忙碌任务时也必须立即安装（定案：忙碌等待只留自动/闸门路径）
// - 自动路径等忙碌时状态必须明示在等什么，且忙碌解除后自动续装
// - 连点只触发一次安装，其余点击记 install-blocked
// - 待安装记录丢失时不许静默：记 diag + 提示 + 对已知版本重新下载
// updater 层整体 mock（记录 diag 与安装调用），appBusy 用真实模块控制忙碌。
const h = vi.hoisted(() => ({
  pending: null as null | Record<string, unknown>,
  enabled: true,
  installResult: true,
  installDelayMs: 0,
  installCalls: [] as Array<Record<string, unknown>>,
  downloadCalls: [] as string[],
  diag: [] as string[],
  notifies: [] as string[],
}))

vi.mock('./updater', () => ({
  checkDesktopUpdate: async () => ({ version: '', currentVersion: '0.1.503', upToDate: true }),
  loadAutoUpdateEnabled: () => h.enabled,
  loadPendingUpdate: () => h.pending,
  savePendingUpdate: (p: Record<string, unknown>) => { h.pending = p; return true },
  downloadUpdateInBackground: async () => {
    h.downloadCalls.push('dl')
    return { pending: null, error: 'mock 下载失败' }
  },
  installPendingUpdate: async (p: Record<string, unknown>) => {
    h.installCalls.push(p)
    if (h.installDelayMs) await new Promise(r => setTimeout(r, h.installDelayMs))
    return h.installResult
  },
  consumeJustUpdated: () => null,
  onSilentUpdatePrefChange: () => () => {},
  updateDiag: (ev: string, detail = '') => { h.diag.push(`${ev}|${detail}`) },
  getLastInstallError: () => '',
}))

vi.stubGlobal('window', {
  __TAURI_INTERNALS__: {},
  setInterval: (...a: Parameters<typeof setInterval>) => setInterval(...a),
  setTimeout: (...a: Parameters<typeof setTimeout>) => setTimeout(...a),
  addEventListener: () => {},
  removeEventListener: () => {},
})

const PENDING = {
  version: '9.9.9', via: 'mirror', filePath: '/tmp/fake.app.tar.gz',
  fileName: 'fake.app.tar.gz', downloadedAt: 1, deferred: false,
}

async function freshModules() {
  vi.resetModules()
  const au = await import('./autoUpdate')
  const ab = await import('./appBusy')
  return { au, ab }
}

async function waitFor(cond: () => boolean, timeoutMs = 8000, stepMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return true
    await new Promise(r => setTimeout(r, stepMs))
  }
  return cond()
}

beforeEach(() => {
  h.pending = null
  h.enabled = true
  h.installResult = true
  h.installDelayMs = 0
  h.installCalls = []
  h.downloadCalls = []
  h.diag = []
  h.notifies = []
})

describe('更新安装触发链（v0.1.503）', () => {
  it('「现在更新」：有忙碌任务也立即安装，不等忙碌结束', async () => {
    const { au, ab } = await freshModules()
    h.pending = { ...PENDING }
    ab.setAppBusy('mail-sync', true)
    au.initAutoUpdate({ notify: m => h.notifies.push(m) })
    expect(au.getAutoUpdateUiState().kind).toBe('ready')
    await au.installDownloadedNow()
    expect(h.installCalls).toHaveLength(1)
    expect(h.installCalls[0].version).toBe('9.9.9')
    expect(h.diag.some(d => d.startsWith('install-requested|') && d.includes('source=modal-now'))).toBe(true)
    ab.setAppBusy('mail-sync', false)
  })

  it('自动路径：忙碌时进入等待态并明示在等什么，解除后自动续装', async () => {
    const { au, ab } = await freshModules()
    h.pending = { ...PENDING }
    ab.setAppBusy('mail-sync', true)
    au.initAutoUpdate({ notify: m => h.notifies.push(m) })
    // 静默自动安装在就绪后约 3 秒触发：应进入 installing+waitingBusy 且写明等待对象
    const waiting = await waitFor(() => {
      const s = au.getAutoUpdateUiState()
      return s.kind === 'installing' && s.waitingBusy
    }, 9000)
    expect(waiting).toBe(true)
    const s = au.getAutoUpdateUiState()
    expect(s.kind === 'installing' && s.waitingFor).toContain('邮件同步')
    expect(h.installCalls).toHaveLength(0)
    // 忙碌解除 → 等待循环下一轮（1.5 秒）即续装
    ab.setAppBusy('mail-sync', false)
    const installed = await waitFor(() => h.installCalls.length === 1, 6000)
    expect(installed).toBe(true)
    expect(h.diag.some(d => d.startsWith('install-requested|') && d.includes('source=auto-idle'))).toBe(true)
  })

  it('连点「现在更新」只触发一次安装，其余记 install-blocked', async () => {
    const { au } = await freshModules()
    h.pending = { ...PENDING }
    h.installDelayMs = 600
    au.initAutoUpdate({ notify: m => h.notifies.push(m) })
    void au.installDownloadedNow()
    void au.installDownloadedNow()
    void au.installDownloadedNow()
    await new Promise(r => setTimeout(r, 150))
    expect(h.installCalls).toHaveLength(1)
    expect(h.diag.some(d => d.startsWith('install-blocked|') && d.includes('already-installing'))).toBe(true)
    await new Promise(r => setTimeout(r, 700))
  })

  it('待安装记录丢失：不静默——记 diag、给提示、对已知版本重新下载', async () => {
    const { au } = await freshModules()
    h.enabled = false // 走手动发现路径把状态推到 available（手里有版本号但无待安装记录）
    au.initAutoUpdate({ notify: m => h.notifies.push(m) })
    au.takeoverUpdateDiscovery('9.9.9')
    expect(au.getAutoUpdateUiState().kind).toBe('available')
    await au.installDownloadedNow()
    expect(h.diag.some(d => d.startsWith('install-blocked|') && d.includes('pending-missing'))).toBe(true)
    expect(h.notifies.some(m => m.includes('重新下载'))).toBe(true)
    expect(h.downloadCalls).toHaveLength(1)
    expect(h.installCalls).toHaveLength(0)
  })
})
