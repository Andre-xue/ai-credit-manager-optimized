import {
  hasCheckinCred, loadCheckinCred, getCheckinStatus, claimCheckin,
  getWorkbuddyStatus, claimWorkbuddy, getMinimaxStatus, claimMinimax,
} from './checkin'
import { listPoolMeta, poolCredBox, migrateLegacyWorkbuddyCred } from './wbPool'
import { listMmMeta, mmCredBox, migrateLegacyMinimaxCred } from './mmPool'

/**
 * 一键签到 / 自动签到（v0.1.362）：把所有已连接来源（MiniMax 单账号 + WorkBuddy
 * 账号池每个号）逐个查状态、可领就领，结果汇总并留痕到本机存储——
 * 菜单栏迷你窗直接读留痕展示，也可自己发起（全程不打开主窗口）。
 * 自动签到偏好只存本机；执行需要保险箱已解锁（主密码在内存或指纹密码副本可用）。
 */

export interface CheckinRunItem {
  label: string
  outcome: 'claimed' | 'already' | 'error'
  message: string
  points?: number
}

export interface CheckinRun { at: number; items: CheckinRunItem[] }

const RUN_KEY = 'acm.checkin.lastRun.v1'
const AUTO_KEY = 'acm.checkin.auto.v1'

export function readLastCheckinRun(): CheckinRun | null {
  try {
    const v = JSON.parse(localStorage.getItem(RUN_KEY) ?? 'null') as CheckinRun | null
    return v && typeof v.at === 'number' && Array.isArray(v.items) ? v : null
  } catch { return null }
}

export function checkinRunIsToday(run: CheckinRun | null): boolean {
  if (!run) return false
  const d = new Date(run.at)
  const now = new Date()
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
}

export function getAutoCheckinEnabled(): boolean {
  try { return localStorage.getItem(AUTO_KEY) === '1' } catch { return false }
}

export function setAutoCheckinEnabled(v: boolean): void {
  try { localStorage.setItem(AUTO_KEY, v ? '1' : '0') } catch { /* 忽略 */ }
}

/** 有没有任何已连接的签到来源 */
export function hasCheckinSources(): boolean {
  return hasCheckinCred('minimax') || hasCheckinCred('workbuddy')
    || listPoolMeta().length > 0 || listMmMeta().length > 0
}

/**
 * 逐个来源签到。密码不对（凭据全部解不开）时整体抛错，不产生误导性的逐项失败。
 */
export async function runAllCheckins(pwd: string): Promise<CheckinRun> {
  if (!pwd) throw new Error('保险箱未解锁')
  // 旧单账号凭据先迁进多账号存储（签到页/池页没打开过时自动签到也能覆盖到）
  await migrateLegacyWorkbuddyCred(pwd).catch(() => false)
  await migrateLegacyMinimaxCred(pwd).catch(() => false)
  // 先探一次密码对不对：任一已存凭据能解开即视为正确
  let probed = false
  if (hasCheckinCred('minimax')) {
    if (await loadCheckinCred('minimax', pwd)) probed = true
  }
  if (!probed) {
    for (const meta of listPoolMeta()) {
      if (await poolCredBox(meta.id, pwd).load()) { probed = true; break }
    }
  }
  if (!probed) {
    for (const meta of listMmMeta()) {
      if (await mmCredBox(meta.id, pwd).load()) { probed = true; break }
    }
  }
  if (!probed && hasCheckinSources()) throw new Error('主密码不正确，凭据解不开')

  const items: CheckinRunItem[] = []
  // MiniMax 多账号
  for (const meta of listMmMeta()) {
    const box = mmCredBox(meta.id, pwd)
    const label = `MiniMax · ${meta.label}`
    try {
      const st = await getMinimaxStatus(box)
      if (st.state === 'claimable') {
        const r = await claimMinimax(box)
        items.push({ label, outcome: 'claimed', message: r.message, points: r.points })
      } else if (st.state === 'claimed') {
        items.push({ label, outcome: 'already', message: st.message })
      } else {
        items.push({ label, outcome: 'error', message: st.message })
      }
    } catch (e) {
      items.push({ label, outcome: 'error', message: e instanceof Error ? e.message : '签到失败' })
    }
  }
  // 迁移没成功时兜底走旧单账号路径
  if (!listMmMeta().length && hasCheckinCred('minimax')) {
    try {
      const st = await getCheckinStatus('minimax', pwd)
      if (st.state === 'claimable') {
        const r = await claimCheckin('minimax', pwd)
        items.push({ label: 'MiniMax Code', outcome: 'claimed', message: r.message, points: r.points })
      } else if (st.state === 'claimed') {
        items.push({ label: 'MiniMax Code', outcome: 'already', message: st.message })
      } else {
        items.push({ label: 'MiniMax Code', outcome: 'error', message: st.message })
      }
    } catch (e) {
      items.push({ label: 'MiniMax Code', outcome: 'error', message: e instanceof Error ? e.message : '签到失败' })
    }
  }
  for (const meta of listPoolMeta()) {
    const box = poolCredBox(meta.id, pwd)
    const label = `WorkBuddy · ${meta.label}`
    try {
      const st = await getWorkbuddyStatus(box)
      if (st.state === 'claimable') {
        const r = await claimWorkbuddy(box)
        items.push({ label, outcome: 'claimed', message: r.message, points: r.points })
      } else if (st.state === 'claimed') {
        items.push({ label, outcome: 'already', message: st.message })
      } else {
        items.push({ label, outcome: 'error', message: st.message })
      }
    } catch (e) {
      items.push({ label, outcome: 'error', message: e instanceof Error ? e.message : '签到失败' })
    }
  }
  const run: CheckinRun = { at: Date.now(), items }
  saveCheckinRun(run)
  return run
}

function saveCheckinRun(run: CheckinRun): void {
  try { localStorage.setItem(RUN_KEY, JSON.stringify(run)) } catch { /* 忽略 */ }
  // 跨窗靠 localStorage 的 storage 事件；同窗（主窗口内自动签到完成时签到页正开着）靠这个自定义事件
  try { window.dispatchEvent(new CustomEvent('acm-checkin-done')) } catch { /* 忽略 */ }
}

/**
 * 把一次手动领取的结果并入今日留痕：主页面里逐个签、全部签也走这里，
 * 这样菜单栏迷你窗和签到页看到的是同一份记录，双向同步。
 */
export function recordCheckinOutcome(item: CheckinRunItem): void {
  const prev = readLastCheckinRun()
  const base: CheckinRun = checkinRunIsToday(prev) && prev ? prev : { at: Date.now(), items: [] }
  const items = base.items.filter(i => i.label !== item.label)
  items.push(item)
  saveCheckinRun({ at: Date.now(), items })
}

/** 一行摘要，给通知/迷你窗标题用 */
export function summarizeCheckinRun(run: CheckinRun): string {
  const claimed = run.items.filter(i => i.outcome === 'claimed')
  const points = claimed.reduce((s, i) => s + (i.points ?? 0), 0)
  const errors = run.items.filter(i => i.outcome === 'error').length
  if (!run.items.length) return '没有已连接的签到账号'
  const parts: string[] = []
  if (claimed.length) parts.push(`新领 ${claimed.length} 个${points ? `（+${points} 积分）` : ''}`)
  const already = run.items.length - claimed.length - errors
  if (already) parts.push(`${already} 个已签到`)
  if (errors) parts.push(`${errors} 个失败`)
  return parts.join('，') || '签到完成'
}
