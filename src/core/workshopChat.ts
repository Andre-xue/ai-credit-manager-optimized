// AI 工坊共用对话通道：工具页不重复造模型选择，统一走「免费模型 / 自有账户」两条现成路线。
// 免费模型走 freeAi（云端免费需登录云账号；Zen/Kilo 免登录），自有账户走保险箱解密 + callChat。

import type { Account } from './types'
import { decryptSecret } from './crypto'
import { callChat } from './providerCall'
import { categoryFromNote, isVoiceConfigAccount } from './modelCategories'
import { detectModelCapability, capabilityChatCapable } from './modelCapability'
import { loadFreeAiOptions, filterChatCapableFreeOptions, freeAiChat, type FreeAiOption } from './freeAi'

export type WorkshopRoute =
  | { kind: 'free'; key: string; label: string }
  | { kind: 'account'; key: string; label: string; accountId: string; engine?: string; modelId?: string }
  | { kind: 'wbpool'; key: string; label: string }

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
    ...workshopAccounts(accounts).map(a => ({ kind: 'account' as const, key: `acct:${a.id}`, label: a.label, accountId: a.id })),
  ]
  try {
    const { hasPoolAccounts } = await import('./wbPool')
    if (hasPoolAccounts()) routes.push({ kind: 'wbpool', key: 'wbpool', label: 'WorkBuddy 账号池' })
  } catch { /* 池不可用时不加路线 */ }
  return { routes, freeOptions }
}

/** 跑一次单轮对话（system + user），返回纯文本 */
export async function runWorkshopChat(params: {
  route: WorkshopRoute
  freeOptions: FreeAiOption[]
  accounts: Account[]
  sessionPwd: string
  system: string
  user: string
}): Promise<string> {
  const { route, freeOptions, accounts, sessionPwd, system, user } = params
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
  if (!sessionPwd) throw new Error('保险箱未解锁，无法使用自有账户（可改用免费模型）')
  if (!acct.encryptedKey) throw new Error('该账户没有保存的密钥')
  const key = await decryptSecret(acct.encryptedKey, sessionPwd)
  const r = await callChat(acct, key, [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], route.engine)
  if (!r.ok) throw new Error(r.text || '调用失败')
  return r.text
}
