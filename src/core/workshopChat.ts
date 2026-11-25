// AI 工坊共用对话通道：工具页不重复造模型选择，统一走「免费模型 / 自有账户」两条现成路线。
// 免费模型走 freeAi（云端免费需登录云账号；Zen/Kilo 免登录），自有账户走保险箱解密 + callChat。
// v0.1.433：自动模式下走 freeChain 切换链（限流/额度/5xx/超时/空响应自动切下一条免费路线并
// 明示原因）；手动锁定模式保持单路线行为（失败只报真实原因）。自有付费账户不被自动切入，
// 只有用户手动选它作首选时才排第一位，它失败后也只切免费路线。

import type { Account } from './types'
import { decryptSecret } from './crypto'
import { callChat, extractModelId } from './providerCall'
import { ENGINE_CATALOG } from '../data/engines'
import { categoryFromNote, isVoiceConfigAccount } from './modelCategories'
import { detectModelCapability, capabilityChatCapable } from './modelCapability'
import { loadFreeAiOptions, filterChatCapableFreeOptions, freeAiChat, type FreeAiOption } from './freeAi'
import { inferbaseGate } from './inferbase'
import { runFreeChain, loadChainMode, orderChainCandidates, ChainAllFailedError, type ChainCandidate } from './freeChain'

export type WorkshopRoute =
  | { kind: 'free'; key: string; label: string }
  | { kind: 'account'; key: string; label: string; accountId: string; engine?: string; modelId?: string; disabledReason?: string }
  | { kind: 'wbpool'; key: string; label: string }

/** 某平台的首选对话模型：引擎目录的旗舰款，没有旗舰则取倍率最低的一款；未收录返回 undefined */
export function defaultChatEngine(providerId: string): string | undefined {
  const list = ENGINE_CATALOG[providerId]
  if (!list?.length) return undefined
  return list.find(e => e.flagship)?.id ?? [...list].sort((a, b) => a.multiplier - b.multiplier)[0]?.id
}

/**
 * 工坊自有账户实际要发的模型 id（v0.1.430：修「拿账户名当模型名发」）。
 * 优先级：路线自带的 modelId/engine → label 本身就是目录里的模型 id →
 * 平台首选模型（引擎目录旗舰款）→ 备注/标签里带 '/' 的明确模型 id → 账户名（旧行为兜底）。
 */
export function resolveWorkshopModel(acct: Account, route?: WorkshopRoute): string {
  if (route?.kind === 'account') {
    const explicit = route.modelId ?? route.engine
    if (explicit) return explicit
  }
  const label = (acct.label ?? '').trim()
  const catalog = ENGINE_CATALOG[acct.providerId] ?? []
  if (label && catalog.some(e => e.id === label)) return label
  const preferred = defaultChatEngine(acct.providerId)
  if (preferred) return preferred
  const extracted = extractModelId(acct)
  return extracted.includes('/') ? extracted : acct.label
}

export interface WorkshopRouteData {
  routes: WorkshopRoute[]
  freeOptions: FreeAiOption[]
}

/** 能用于工坊工具的自有账户：通用/对话分类、非本地、非语音配置、聊天能力达标（与文档问答同口径） */
export function workshopAccounts(accounts: Account[]): Account[] {
  return accounts.filter(a => {
    if (a.providerId?.startsWith('local-') || isVoiceConfigAccount(a.providerId, a.note)) return false
    const cat = categoryFromNote(a.note)
    if (cat !== '通用型' && cat !== '对话型') return false
    const cap = a.modelCapability ?? detectModelCapability(a.label).capability
    return capabilityChatCapable(cap)
  })
}

/** 组装可选路线：免费模型在前（免配置先可用），自有账户在后 */
export async function loadWorkshopRoutes(accounts: Account[]): Promise<WorkshopRouteData> {
  let freeOptions: FreeAiOption[] = []
  try { freeOptions = filterChatCapableFreeOptions(await loadFreeAiOptions()) } catch { freeOptions = [] }
  const routes: WorkshopRoute[] = [
    ...freeOptions.map(o => ({ kind: 'free' as const, key: `free:${o.key}`, label: `免费 · ${o.label}` })),
    ...workshopAccounts(accounts).map(a => {
      // Inferbase 启用门槛（v0.1.432）：冒烟未通过的路线照常列出但标明待实测、不可调用，
      // 选中发送时给出真实原因与手动切换入口，不静默兜底到别的路线
      const gate = a.providerId === 'inferbase' ? inferbaseGate(a) : null
      return {
        kind: 'account' as const, key: `acct:${a.id}`,
        label: gate && !gate.enabled ? `${a.label}（Inferbase 待实测，未启用）` : a.label,
        accountId: a.id, engine: resolveWorkshopModel(a),
        disabledReason: gate && !gate.enabled ? gate.message : undefined,
      }
    }),
  ]
  try {
    const { hasPoolAccounts } = await import('./wbPool')
    if (hasPoolAccounts()) routes.push({ kind: 'wbpool', key: 'wbpool', label: 'WorkBuddy 账号池' })
  } catch { /* 池不可用时不加路线 */ }
  return { routes, freeOptions }
}

export interface WorkshopChatParams {
  route: WorkshopRoute
  freeOptions: FreeAiOption[]
  accounts: Account[]
  sessionPwd: string
  system: string
  user: string
  /** 自动切换发生时回调（界面明示实际路线与原因）；不传则切换仍发生但无额外提示 */
  onChainNote?: (msg: string) => void
}

/** 单条路线跑一次单轮对话（system + user），返回纯文本；不做任何切换 */
async function runOneWorkshopRoute(route: WorkshopRoute, params: WorkshopChatParams): Promise<string> {
  const { freeOptions, accounts, sessionPwd, system, user } = params
  if (route.kind === 'wbpool') {
    if (!sessionPwd) throw new Error('保险箱未解锁，无法使用账号池')
    const { poolChat } = await import('./wbPool')
    const r = await poolChat(sessionPwd, [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ])
    return r.text
  }
  if (route.kind === 'free') {
    const opt = freeOptions.find(o => `free:${o.key}` === route.key)
    if (!opt) throw new Error('所选免费模型已不可用，请换一个')
    return await freeAiChat(opt, system, user)
  }
  const acct = accounts.find(a => a.id === route.accountId)
  if (!acct) throw new Error('所选账户不存在')
  // Inferbase 门槛实时复查（路线列表生成后又完成冒烟的，以最新状态为准）
  if (acct.providerId === 'inferbase') {
    const gate = inferbaseGate(acct)
    if (!gate.enabled) throw new Error(gate.message)
  } else if (route.disabledReason) {
    throw new Error(route.disabledReason)
  }
  if (!sessionPwd) throw new Error('保险箱未解锁，无法使用自有账户（可改用免费模型）')
  if (!acct.encryptedKey) throw new Error('该账户没有保存的密钥')
  const key = await decryptSecret(acct.encryptedKey, sessionPwd)
  const r = await callChat(acct, key, [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], resolveWorkshopModel(acct, route))
  if (!r.ok) throw new Error(r.error || r.text || '调用失败')
  return r.text
}

/** 路线在切换链里的类别（决定缺省顺序；APIsFreeLLM 永远最后兜底） */
function workshopRouteChainKind(route: WorkshopRoute, params: WorkshopChatParams): string {
  if (route.kind === 'wbpool') return 'wbpool'
  if (route.kind === 'account') {
    const acct = params.accounts.find(a => a.id === route.accountId)
    return acct?.providerId === 'inferbase' ? 'inferbase' : 'account'
  }
  const opt = params.freeOptions.find(o => `free:${o.key}` === route.key)
  return opt?.source ?? 'cloud'
}

/**
 * 组装自动模式的候选路线：首选（用户所选，含自有付费账户）+ 全部免费类路线
 * （云端/Zen/Kilo/APIsFreeLLM 免费选项、已验证启用的 Inferbase、WorkBuddy 账号池）。
 * 自有付费账户除首选外不进候选——自动切换不会悄悄切到要花钱的账户。
 */
export async function buildWorkshopChainRoutes(params: WorkshopChatParams): Promise<WorkshopRoute[]> {
  const list: WorkshopRoute[] = []
  const push = (r: WorkshopRoute) => { if (!list.some(x => x.key === r.key)) list.push(r) }
  push(params.route)
  for (const o of params.freeOptions) push({ kind: 'free', key: `free:${o.key}`, label: `免费 · ${o.label}` })
  for (const a of workshopAccounts(params.accounts)) {
    if (a.providerId === 'inferbase' && inferbaseGate(a).enabled) {
      push({ kind: 'account', key: `acct:${a.id}`, label: a.label, accountId: a.id, engine: resolveWorkshopModel(a) })
    }
  }
  try {
    const { hasPoolAccounts } = await import('./wbPool')
    if (hasPoolAccounts()) push({ kind: 'wbpool', key: 'wbpool', label: 'WorkBuddy 账号池' })
  } catch { /* 池不可用时不加 */ }
  return list
}

/**
 * 跑一次单轮对话（system + user），返回纯文本。
 * 手动锁定模式：只跑所选路线，失败原样报真实原因（433 之前行为）。
 * 自动模式：所选路线遇可切换失败时按 freeChain 切到下一条免费路线，切换原因经
 * onChainNote 明示；不可切换的失败（400 类、Inferbase 门槛）仍原样抛出不偷换；
 * 全部失败抛汇总各路线真实原因的错误。
 */
export async function runWorkshopChat(params: WorkshopChatParams): Promise<string> {
  if (loadChainMode() === 'locked') return runOneWorkshopRoute(params.route, params)
  const routes = await buildWorkshopChainRoutes(params)
  if (routes.length <= 1) return runOneWorkshopRoute(params.route, params)
  const byKey = new Map(routes.map(r => [r.key, r]))
  const candidates: ChainCandidate[] = orderChainCandidates(
    params.route.key,
    routes.map(r => ({ id: r.key, label: r.label, kind: workshopRouteChainKind(r, params) })),
  )
  try {
    const res = await runFreeChain(candidates, async cand => runOneWorkshopRoute(byKey.get(cand.id)!, params))
    for (const s of res.switches) {
      params.onChainNote?.(`「${s.fromLabel}」${s.reason}，已自动切换到「${s.toLabel}」`)
    }
    return res.text
  } catch (e) {
    if (e instanceof ChainAllFailedError) throw new Error(e.message)
    throw e
  }
}
