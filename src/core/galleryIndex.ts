import type { Account } from './types'
import { decryptSecret } from './crypto'
import { callChat } from './providerCall'
import { chatUpstream } from './upstreamFree'
import { classifyModelPurpose } from './modelPurpose'
import type { FreeAiOption } from './freeAi'
import type { WorkshopRoute } from './workshopChat'
import { PROVIDER_MAP } from '../data/providers'

/**
 * AI 图库索引（v0.1.343）：用看图模型给每张图片/每个视频首帧生成中文描述+标签，
 * 存本机 IndexedDB（acm-gallery-db/captions，按路径+mtime 失效），搜索时按描述命中。
 * 打标走工坊同款路线（上游免费/自有账户），但只收看图模型；云端免费路线暂不走（其多模态通道未验）。
 */
export interface CaptionRec { path: string; mtime: number; text: string; model: string; at: number }

const DB_NAME = 'acm-gallery-db'
const STORE = 'captions'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'path' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function loadCaptions(): Promise<Map<string, CaptionRec>> {
  const map = new Map<string, CaptionRec>()
  try {
    const db = await openDb()
    const all = await new Promise<CaptionRec[]>((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
      req.onsuccess = () => resolve((req.result as CaptionRec[]) ?? [])
      req.onerror = () => reject(req.error)
    })
    for (const r of all) if (r && r.path) map.set(r.path, r)
  } catch { /* 索引库不可用时按未索引处理 */ }
  return map
}

export async function saveCaption(rec: CaptionRec): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const req = db.transaction(STORE, 'readwrite').objectStore(STORE).put(rec)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  } catch { /* 保存失败不阻塞索引流程 */ }
}

/** 模型是否能看图：modelPurpose 的「看图」标签 + 常见多模态型号补充 */
export function isVisionModelId(id: string): boolean {
  if (classifyModelPurpose(id).tags.includes('看图')) return true
  return /gpt-4o|gpt-5|claude|gemini|internvl|llava|minicpm-v|glm-4v|qwen[^ ]*vl|step-1v|moonshot[^ ]*vision/i.test(id)
}

const TAG_PROMPT = '请用中文描述这张图片（视频取的是首帧）：第一行写一句不超过30字的画面描述；第二行以「标签：」开头，写 5-8 个便于检索的关键词（空格分隔），覆盖人物、场景、物体、颜色、氛围。只输出这两行，不要解释。'

/** 给一张图（data URL）打标，返回描述+标签文本 */
/** 自有账户下「能看图」的模型逐个列成路线（v0.1.354）：账户本身配置的模型（acct.label）
 * 已由基础路线覆盖，这里只补同一账户还能调的其他看图模型 */
export function accountVisionRoutes(acct: Account, models: string[]): WorkshopRoute[] {
  const providerName = PROVIDER_MAP[acct.providerId]?.name ?? acct.providerId
  return models
    .filter(m => m !== acct.label && isVisionModelId(m))
    .map(m => ({ kind: 'account' as const, key: `acct:${acct.id}:${m}`, label: `自有 · ${providerName} · ${m}`, accountId: acct.id, modelId: m }))
}

export async function visionTagImage(params: {
  route: WorkshopRoute
  freeOptions: FreeAiOption[]
  accounts: Account[]
  sessionPwd: string
  imageDataUrl: string
}): Promise<string> {
  const { route, freeOptions, accounts, sessionPwd, imageDataUrl } = params
  const messages = [
    { role: 'system', content: '你是图片标注助手，只输出描述与标签。' },
    {
      role: 'user',
      content: [
        { type: 'text', text: TAG_PROMPT },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ],
    },
  ] as unknown as { role: string; content: string }[]

  if (route.kind === 'free') {
    const opt = freeOptions.find(o => `free:${o.key}` === route.key)
    if (!opt) throw new Error('所选免费模型已不可用，请换一个')
    if (opt.source === 'cloud') throw new Error('云端免费模型暂不支持看图打标，请换带看图能力的免费模型或自有账户')
    const text = await chatUpstream(opt.source, opt.modelId, messages)
    if (!text.trim()) throw new Error('模型没有返回描述')
    return text.trim()
  }
  if (route.kind === 'wbpool') throw new Error('账号池暂不支持看图打标，请选免费看图模型或自有账户')
  const acct = accounts.find(a => a.id === route.accountId)
  if (!acct) throw new Error('所选账户不存在')
  if (!sessionPwd) throw new Error('保险箱未解锁，无法使用自有账户（可改用免费模型）')
  if (!acct.encryptedKey) throw new Error('该账户没有保存的密钥')
  const key = await decryptSecret(acct.encryptedKey, sessionPwd)
  const r = await callChat(acct, key, messages, route.modelId ?? route.engine)
  if (!r.ok) throw new Error(r.text || '调用失败')
  return r.text.trim()
}

/** 搜索命中：查询按空格/逗号分词，每个词都要在「文件名 + AI 描述」里出现（不分大小写） */
export function captionMatches(name: string, caption: string | undefined, query: string): boolean {
  const hay = `${name} ${caption ?? ''}`.toLowerCase()
  const tokens = query.toLowerCase().split(/[\s,，、]+/).filter(Boolean)
  return tokens.length > 0 && tokens.every(t => hay.includes(t))
}
