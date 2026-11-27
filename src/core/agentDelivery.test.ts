import { describe, it, expect } from 'vitest'
import {
  runDelivery, deliveryPresentation, deliveryChipLabel,
  type DeliveryProvider, type DeliveryWindowSnapshot, type DeliveryPasteOutcome,
} from './agentDelivery'

const READY: DeliveryWindowSnapshot = { running: true, hasWindow: true, isFrontmost: true, frontmostName: 'DSH' }
const NOT_FRONT: DeliveryWindowSnapshot = { running: true, hasWindow: true, isFrontmost: false, frontmostName: 'AI 魔方' }
const LOADING: DeliveryWindowSnapshot = { running: true, hasWindow: false, isFrontmost: false, frontmostName: 'AI 魔方' }
const DEAD: DeliveryWindowSnapshot = { running: false, hasWindow: false, isFrontmost: false, frontmostName: '' }

interface FakeOpts {
  trusted?: boolean
  snaps?: DeliveryWindowSnapshot[]
  paste?: DeliveryPasteOutcome
}

/** 假提供者：快照按队列出（出完重复最后一个），时钟随 sleep 推进（不真等） */
function fakeProvider(o: FakeOpts = {}) {
  const snaps = [...(o.snaps ?? [READY])]
  let clock = 0
  const calls = { activate: 0, paste: [] as boolean[], snapshots: 0 }
  const provider: DeliveryProvider = {
    axTrusted: async () => o.trusted ?? true,
    snapshot: async () => {
      calls.snapshots++
      return snaps.length > 1 ? snaps.shift()! : snaps[0]
    },
    activate: async () => { calls.activate++; return true },
    paste: async (autoSend: boolean) => { calls.paste.push(autoSend); return o.paste ?? { status: 'pasted' } },
    now: () => clock,
    sleep: async (ms: number) => { clock += ms },
  }
  return { provider, calls }
}

describe('runDelivery 送达状态机', () => {
  it('就绪 → 粘贴成功（自动发送关）', async () => {
    const { provider, calls } = fakeProvider()
    const r = await runDelivery(provider, { autoSend: false, pollMs: 100 })
    expect(r).toEqual({ kind: 'pasted' })
    expect(calls.paste).toEqual([false])
  })

  it('自动发送开 → paste 收到 autoSend=true 并回 sent', async () => {
    const { provider, calls } = fakeProvider({ paste: { status: 'sent' } })
    const r = await runDelivery(provider, { autoSend: true, pollMs: 100 })
    expect(r).toEqual({ kind: 'sent' })
    expect(calls.paste).toEqual([true])
  })

  it('无辅助功能权限 → 立刻回落，不轮询不粘贴', async () => {
    const { provider, calls } = fakeProvider({ trusted: false })
    const r = await runDelivery(provider, { autoSend: false, pollMs: 100 })
    expect(r).toEqual({ kind: 'no-permission' })
    expect(calls.snapshots).toBe(0)
    expect(calls.paste).toEqual([])
  })

  it('窗口一直没就绪（冷启动卡住）→ 超时回落', async () => {
    const { provider, calls } = fakeProvider({ snaps: [LOADING] })
    const r = await runDelivery(provider, { autoSend: false, timeoutMs: 2000, pollMs: 500 })
    expect(r).toEqual({ kind: 'timeout' })
    expect(calls.paste).toEqual([])
  })

  it('进程根本没起来 → 超时回落', async () => {
    const { provider } = fakeProvider({ snaps: [DEAD] })
    const r = await runDelivery(provider, { autoSend: false, timeoutMs: 1000, pollMs: 250 })
    expect(r).toEqual({ kind: 'timeout' })
  })

  it('有窗口但不在前台 → 先激活，激活后就绪再粘贴', async () => {
    const { provider, calls } = fakeProvider({ snaps: [NOT_FRONT, NOT_FRONT, READY] })
    const r = await runDelivery(provider, { autoSend: false, timeoutMs: 5000, pollMs: 100, activateMinIntervalMs: 100 })
    expect(r).toEqual({ kind: 'pasted' })
    expect(calls.activate).toBeGreaterThanOrEqual(1)
  })

  it('粘贴瞬间前台被别的窗口抢走 → Rust 回 mismatch，中止并带前台名', async () => {
    const { provider } = fakeProvider({ paste: { status: 'mismatch', frontmostName: '微信' } })
    const r = await runDelivery(provider, { autoSend: false, pollMs: 100 })
    expect(r).toEqual({ kind: 'frontmost-mismatch', frontmostName: '微信' })
  })

  it('焦点确认失败（定位不到输入框）→ no-input 回落，不盲粘', async () => {
    const { provider } = fakeProvider({ paste: { status: 'no-input' } })
    const r = await runDelivery(provider, { autoSend: false, pollMs: 100 })
    expect(r).toEqual({ kind: 'no-input' })
  })

  it('粘贴时权限被收回 → no-permission 回落', async () => {
    const { provider } = fakeProvider({ paste: { status: 'no-permission' } })
    const r = await runDelivery(provider, { autoSend: false, pollMs: 100 })
    expect(r).toEqual({ kind: 'no-permission' })
  })

  it('剪贴板写入失败 → failed 带原因', async () => {
    const { provider } = fakeProvider({ paste: { status: 'clipboard-failed' } })
    const r = await runDelivery(provider, { autoSend: false, pollMs: 100 })
    expect(r).toEqual({ kind: 'failed', reason: '写入剪贴板失败' })
  })

  it('非 macOS → failed 注明只支持 macOS', async () => {
    const { provider } = fakeProvider({ paste: { status: 'unsupported' } })
    const r = await runDelivery(provider, { autoSend: false, pollMs: 100 })
    expect(r.kind).toBe('failed')
    if (r.kind === 'failed') expect(r.reason).toContain('macOS')
  })
})

describe('deliveryPresentation 文案口径', () => {
  it('已粘贴：写明去应用里确认后发送', () => {
    const p = deliveryPresentation({ kind: 'pasted' }, 'DSH')
    expect(p.state).toBe('pasted')
    expect(p.note).toContain('已粘贴到 DSH')
    expect(p.note).toContain('确认后按发送')
  })
  it('已发送：写明已回车发出', () => {
    const p = deliveryPresentation({ kind: 'sent' }, 'Antigravity')
    expect(p.state).toBe('sent')
    expect(p.note).toContain('自动发送')
  })
  it('无权限：给出去系统设置开权限的路径 + ⌘V 回落', () => {
    const p = deliveryPresentation({ kind: 'no-permission' }, 'DSH')
    expect(p.state).toBe('no-permission')
    expect(p.note).toContain('辅助功能')
    expect(p.note).toContain('⌘V')
  })
  it('超时：写明 20 秒与手动 ⌘V', () => {
    const p = deliveryPresentation({ kind: 'timeout' }, 'Qoder')
    expect(p.state).toBe('timeout')
    expect(p.note).toContain('20 秒')
    expect(p.note).toContain('⌘V')
  })
  it('前台不符：写明当前前台是谁、防粘错窗口', () => {
    const p = deliveryPresentation({ kind: 'frontmost-mismatch', frontmostName: '微信' }, 'DSH')
    expect(p.state).toBe('mismatch')
    expect(p.note).toContain('当前是 微信')
    expect(p.note).toContain('已中止')
  })
  it('定位不到输入框：写明没能定位到输入框 + 手动点输入框后 ⌘V', () => {
    const p = deliveryPresentation({ kind: 'no-input' }, 'DSH')
    expect(p.state).toBe('no-input')
    expect(p.note).toContain('没能定位到 DSH 的输入框')
    expect(p.note).toContain('点一下它的输入框')
    expect(p.note).toContain('⌘V')
  })
})

describe('deliveryChipLabel', () => {
  it('成功态有短标签，进行/失败态不冒充', () => {
    expect(deliveryChipLabel('pasted')).toBe('已送达 · 已粘贴')
    expect(deliveryChipLabel('sent')).toBe('已送达 · 已发送')
    expect(deliveryChipLabel('timeout')).toBeNull()
    expect(deliveryChipLabel('no-permission')).toBeNull()
    expect(deliveryChipLabel('no-input')).toBeNull()
  })
})
