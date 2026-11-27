// 更新下载卡死检测与定时复查决策（v0.1.498，纯逻辑、可单测）。
// 背景：495 的下载链在真机上「只有系统菊花一直转」——镜像通道经本机代理
// 中途掐流时连接不断、字节不再来，旧实现没有任何「无进展」判定，进度停在
// 原地无限等。本模块给两条下载通道（Rust 镜像 invoke / 官方 updater 事件）
// 套统一口径：连续 STALL_MS 无字节进展 = 卡死，由调用方换通道或报错。

/** 连续无字节进展多久判定卡死 */
export const STALL_MS = 20_000

export class UpdateStallError extends Error {
  constructor() { super('stall: 20s no progress'); this.name = 'UpdateStallError' }
}

/**
 * 卡死监测器：只认「字节数变化」为进展（同一字节数反复上报不算）。
 * now 由调用方传入（毫秒），便于单测注入假时钟。
 */
export class StallMonitor {
  private lastProgressAt: number
  private lastBytes = -1
  readonly startedAt: number

  constructor(now: number) {
    this.startedAt = now
    this.lastProgressAt = now
  }

  progress(bytes: number, now: number): void {
    if (bytes !== this.lastBytes) {
      this.lastBytes = bytes
      this.lastProgressAt = now
    }
  }

  /** 距上次字节进展的毫秒数 */
  idleMs(now: number): number {
    return now - this.lastProgressAt
  }

  stalled(now: number, stallMs: number = STALL_MS): boolean {
    return this.idleMs(now) >= stallMs
  }

  elapsedMs(now: number): number {
    return now - this.startedAt
  }
}

/**
 * 给一个「带进度回调的下载过程」套卡死看门狗：run 内部通过 note(bytes)
 * 上报已下载字节；连续 stallMs 无进展则以 UpdateStallError 拒绝（底层过程
 * 可能仍在后台跑，其迟到结果被 settled 守卫丢弃，不会重复落状态）。
 */
export function withStallWatchdog<T>(
  run: (note: (bytes: number) => void) => Promise<T>,
  opts?: { stallMs?: number; tickMs?: number },
): Promise<T> {
  const stallMs = opts?.stallMs ?? STALL_MS
  const tickMs = opts?.tickMs ?? 1000
  return new Promise<T>((resolve, reject) => {
    const monitor = new StallMonitor(Date.now())
    let settled = false
    const timer = setInterval(() => {
      if (settled) return
      if (monitor.stalled(Date.now(), stallMs)) {
        settled = true
        clearInterval(timer)
        reject(new UpdateStallError())
      }
    }, tickMs)
    const done = (fn: () => void) => { if (!settled) { settled = true; clearInterval(timer); fn() } }
    run(bytes => monitor.progress(bytes, Date.now())).then(
      v => done(() => resolve(v)),
      e => done(() => reject(e)),
    )
  })
}

/** 静默更新运行期定时复查间隔：2 小时 */
export const RECHECK_INTERVAL_MS = 2 * 60 * 60_000

/**
 * 是否该跑一次运行期静默复查（纯决策）：静默开、状态机空闲、无待安装、
 * 距上次检查已满间隔，四条全满足才查。复查本身不弹窗不打扰。
 */
export function shouldPeriodicRecheck(input: {
  enabled: boolean
  stateKind: string
  hasPending: boolean
  now: number
  lastCheckAt: number
  intervalMs?: number
}): boolean {
  if (!input.enabled) return false
  if (input.stateKind !== 'idle') return false
  if (input.hasPending) return false
  return input.now - input.lastCheckAt >= (input.intervalMs ?? RECHECK_INTERVAL_MS)
}
