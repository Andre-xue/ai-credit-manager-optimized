// 桌面型 Agent 自动送达（v0.1.509）：等窗口就绪 → 校验前台 → 粘贴（可选自动发送）。
// 状态机是纯逻辑：窗口/剪贴板/按键都经 DeliveryProvider 注入，单测用假提供者覆盖
// 就绪、超时、无权限、前台不符、自动发送开/关全部路径；生产提供者走 Rust 桥
// （agent_app_probe / agent_activate_app / agent_paste_deliver，见 agentBridge.ts）。
// 铁律：任何一步不如预期都如实回落到「任务已复制，手动 ⌘V」，绝不假装送达。
import type { AgentDeliveryState } from './agents'
import { agentAppProbe, agentActivateApp, agentPasteDeliver, agentAxTrusted, type AgentPasteStatus } from './agentBridge'

/** 窗口快照（提供者每次轮询返回一份） */
export interface DeliveryWindowSnapshot {
  /** 目标应用进程在运行 */
  running: boolean
  /** 目标应用有可见的普通窗口（不是只有进程/菜单栏图标） */
  hasWindow: boolean
  /** 目标应用当前就在前台 */
  isFrontmost: boolean
  /** 当前前台应用名（不符时写进中止原因） */
  frontmostName: string
}

export interface DeliveryPasteOutcome {
  status: AgentPasteStatus
  frontmostName?: string
}

/** 可注入的平台提供者：生产 = Rust 桥；测试 = 假实现 */
export interface DeliveryProvider {
  axTrusted(): Promise<boolean>
  snapshot(): Promise<DeliveryWindowSnapshot>
  activate(): Promise<boolean>
  paste(autoSend: boolean): Promise<DeliveryPasteOutcome>
  now(): number
  sleep(ms: number): Promise<void>
}

export type DeliveryResult =
  | { kind: 'pasted' }
  | { kind: 'sent' }
  | { kind: 'no-permission' }
  | { kind: 'timeout' }
  | { kind: 'frontmost-mismatch'; frontmostName?: string }
  | { kind: 'no-input' }
  | { kind: 'failed'; reason: string }

export interface DeliveryOptions {
  autoSend: boolean
  /** 等窗口就绪的上限（毫秒），默认 20 秒——DSH 冷启动加载插件约需 8 秒 */
  timeoutMs?: number
  /** 轮询间隔（毫秒） */
  pollMs?: number
  /** 两次「激活到前台」尝试的最小间隔（毫秒） */
  activateMinIntervalMs?: number
}

/**
 * 送达状态机：
 * 1) 先查辅助功能权限——没有就立刻回落，不白等 20 秒；
 * 2) 轮询窗口快照：进程在 + 有窗口 + 在前台 = 就绪；有窗口但不在前台时节流地
 *    主动激活（open -a 后用户可能又切回了魔方，不能干等）；
 * 3) 就绪后调 paste（Rust 侧在合成 ⌘V 前会再验一次前台 + 做焦点确认：焦点
 *    不在可编辑输入上时定位主输入设焦复核，定位不到回 no-input 不盲粘）；
 * 4) 超时 / 不符 / 失败全部如实返回，由 deliveryPresentation 生成回落文案。
 */
export async function runDelivery(p: DeliveryProvider, opts: DeliveryOptions): Promise<DeliveryResult> {
  const timeoutMs = opts.timeoutMs ?? 20000
  const pollMs = opts.pollMs ?? 500
  const activateMinInterval = opts.activateMinIntervalMs ?? 1000

  let trusted = false
  try { trusted = await p.axTrusted() } catch { trusted = false }
  if (!trusted) return { kind: 'no-permission' }

  const deadline = p.now() + timeoutMs
  let lastActivateAt = Number.NEGATIVE_INFINITY
  for (;;) {
    let snap: DeliveryWindowSnapshot
    try {
      snap = await p.snapshot()
    } catch {
      snap = { running: false, hasWindow: false, isFrontmost: false, frontmostName: '' }
    }
    if (snap.running && snap.hasWindow && snap.isFrontmost) break
    const now = p.now()
    if (now >= deadline) return { kind: 'timeout' }
    if (snap.running && snap.hasWindow && !snap.isFrontmost && now - lastActivateAt >= activateMinInterval) {
      lastActivateAt = now
      try { await p.activate() } catch { /* 激活失败不中断轮询，下一轮再试 */ }
    }
    await p.sleep(Math.min(pollMs, Math.max(0, deadline - now)))
  }

  let out: DeliveryPasteOutcome
  try {
    out = await p.paste(opts.autoSend)
  } catch (e) {
    return { kind: 'failed', reason: e instanceof Error ? e.message : String(e) }
  }
  switch (out.status) {
    case 'pasted': return { kind: 'pasted' }
    case 'sent': return { kind: 'sent' }
    case 'mismatch': return { kind: 'frontmost-mismatch', frontmostName: out.frontmostName }
    case 'no-input': return { kind: 'no-input' }
    case 'no-permission': return { kind: 'no-permission' }
    case 'clipboard-failed': return { kind: 'failed', reason: '写入剪贴板失败' }
    case 'unsupported': return { kind: 'failed', reason: '自动送达目前只支持 macOS' }
    default: return { kind: 'failed', reason: '未知送达结果' }
  }
}

/** 结果 → 任务卡上的送达状态与文案（单测锁定措辞口径） */
export function deliveryPresentation(result: DeliveryResult, agentName: string): { state: AgentDeliveryState['state']; note: string } {
  switch (result.kind) {
    case 'pasted':
      return { state: 'pasted', note: `已送达：任务已粘贴到 ${agentName} 的输入框，去应用里确认后按发送（任务也已复制到剪贴板）` }
    case 'sent':
      return { state: 'sent', note: `已送达并自动发送：任务已粘贴到 ${agentName} 并按回车发出，在应用里看它的回复即可` }
    case 'no-permission':
      return {
        state: 'no-permission',
        note: `没有辅助功能权限，自动粘贴不可用；任务已复制到剪贴板，请到 ${agentName} 里按 ⌘V 粘贴。开权限：系统设置 → 隐私与安全性 → 辅助功能 → 给「AI 魔方」打勾（翻译功能用的是同一个权限）`,
      }
    case 'timeout':
      return { state: 'timeout', note: `没等到 ${agentName} 窗口就绪（20 秒），已停止自动粘贴；任务已复制到剪贴板，切到应用里手动 ⌘V 即可` }
    case 'frontmost-mismatch':
      return {
        state: 'mismatch',
        note: `粘贴前发现前台不是 ${agentName}${result.frontmostName ? `（当前是 ${result.frontmostName}）` : ''}，已中止自动粘贴（防粘错窗口）；任务在剪贴板里，切到 ${agentName} 按 ⌘V 即可`,
      }
    case 'no-input':
      return {
        state: 'no-input',
        note: `没能定位到 ${agentName} 的输入框，自动粘贴已取消（不盲粘）；任务已复制到剪贴板，请手动点一下它的输入框再按 ⌘V 粘贴发送`,
      }
    case 'failed':
      return { state: 'failed', note: `自动送达失败：${result.reason}；任务已复制到剪贴板，手动 ⌘V 即可` }
  }
}

/** 送达状态的短标签（任务卡状态徽标旁的送达 chip） */
export function deliveryChipLabel(state: AgentDeliveryState['state']): string | null {
  switch (state) {
    case 'pasted': return '已送达 · 已粘贴'
    case 'sent': return '已送达 · 已发送'
    case 'delivering': return '送达中…'
    case 'copied': return '已复制待送达'
    default: return null
  }
}

/** 生产提供者：经 Rust 桥探测/激活/粘贴（粘贴的原子实现在 Rust 侧） */
export function createBridgeDeliveryProvider(
  appNames: string[], bundleIds: string[], taskText: string,
): DeliveryProvider {
  return {
    axTrusted: () => agentAxTrusted(),
    snapshot: async () => {
      const p = await agentAppProbe(appNames, bundleIds)
      return { running: p.running, hasWindow: p.hasWindow, isFrontmost: p.isFrontmost, frontmostName: p.frontmostName }
    },
    activate: () => agentActivateApp(appNames, bundleIds),
    paste: async (autoSend: boolean) => {
      const r = await agentPasteDeliver(appNames, bundleIds, taskText, autoSend)
      return { status: r.status, frontmostName: r.frontmostName || undefined }
    },
    now: () => Date.now(),
    sleep: (ms: number) => new Promise(r => setTimeout(r, ms)),
  }
}
