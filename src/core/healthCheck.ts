// API Key 健康检查：用账户自己的 Key 轻量探测平台接口（GET /v1/models），
// 判断密钥是否可用、服务是否可达，并记录延迟。结果只存本地（不进云同步）。

import type { Account } from './types'
import { isLocalProvider } from './types'
import { fetchProviderModels, fetchLocalMediaModels, callChat } from './providerCall'
import {
  fetchInferbaseModels, fetchInferbaseAccountData, inferbaseStateFromError, inferbaseErrorText,
  recordInferbaseVerification, INFERBASE_CHAT_BASE, INFERBASE_SMOKE_MODEL, INFERBASE_STATE_LABEL,
  type InferbaseRouteState,
} from './inferbase'
import { parseInferbaseBalance, formatUsageBalance } from './adapters'
import {
  oneAiStateFromError, oneAiErrorText, recordOneAiVerification, oneAiEstimateText,
  ONEAI_BASE, ONEAI_SMOKE_MODEL, ONEAI_STATE_LABEL, type OneAiRouteState,
} from './oneai'
import {
  anyApiStateFromError, anyApiErrorText, recordAnyApiVerification, anyApiEstimateText,
  pickAnyApiSmokeModel, ANYAPI_BASE, ANYAPI_STATE_LABEL, type AnyApiRouteState,
} from './anyapi'
import {
  momaStateFromError, momaErrorText, recordMomaVerification, momaEstimateText,
  pickMomaSmokeModel, MOMA_BASE, MOMA_STATE_LABEL, type MomaRouteState,
} from './moma'
import {
  tokenRouterStateFromError, tokenRouterErrorText, recordTokenRouterVerification, tokenRouterEstimateText,
  pickTokenRouterSmokeModel, TOKENROUTER_BASE, TOKENROUTER_STATE_LABEL, type TokenRouterRouteState,
} from './tokenrouter'

export type KeyHealthStatus = 'ok' | 'auth' | 'quota' | 'network' | 'error' | 'skipped' | 'rate' | 'pending' | 'model'

export interface KeyHealthResult {
  status: KeyHealthStatus
  /** 探测耗时（毫秒）；未真正发请求时为 0 */
  latencyMs: number
  /** 探测到的可用模型数（成功时） */
  modelCount?: number
  /** 人话结论 / 失败原因（截断后的原文） */
  message: string
  checkedAt: number
}

const STORE_KEY = 'acm.keyHealth.v1'

/** 把任意错误归类为健康状态（纯函数，可测） */
export function classifyHealthError(e: unknown): { status: KeyHealthStatus; message: string } {
  const msg = (e instanceof Error ? e.message : String(e ?? '')).slice(0, 160)
  const lower = msg.toLowerCase()
  // v0.1.464：网关不认此模型（400 model_not_found，官方措辞 "is not available"）
  // 必须最先归类——旧顺序里它排在额度判定之后且只认带空格的 "not found"，
  // 对官方实际报文失配，会被误吞成额度不足/兜底异常（与四平台分类器同口径）。
  if (/model_not_found|model.*(?:not found|not available|does not exist|no such model)|no such model|模型(?:不存在|不可用|未找到|已下线)/.test(lower)) {
    return { status: 'model', message: `网关不认此模型：${msg}` }
  }
  if (/401|403|unauthorized|forbidden|invalid api key|invalid_api_key|api key.*(无效|错误|过期)|密钥.*(无效|错误|过期)|authentication/.test(lower)) {
    return { status: 'auth', message: `密钥无效或无权限：${msg}` }
  }
  if (/402|429|quota|insufficient|balance|rate limit|额度不足|余额不足|欠费|超出.*额度/.test(lower)) {
    return { status: 'quota', message: `额度不足或被限流：${msg}` }
  }
  if (/failed to fetch|network|load failed|cors|代理不可用|econnrefused|enotfound|timeout|timed out|网络/.test(lower)) {
    return { status: 'network', message: `网络不通或被跨域拦截：${msg}` }
  }
  return { status: 'error', message: msg || '未知错误' }
}

/**
 * 探测单个账户的 Key 健康。
 * - 云端账户：需要明文 Key（未解锁时返回 skipped）；走 /v1/models。
 * - 本地服务（Ollama/ComfyUI 等）：不需要 Key，直接探测本机服务地址。
 */
/** Inferbase 状态 → 健康徽标状态（433 自动切换链直接消费 InferbaseRouteState） */
function inferbaseHealthStatus(state: InferbaseRouteState): KeyHealthStatus {
  switch (state) {
    case 'available': return 'ok'
    case 'auth_invalid': return 'auth'
    case 'quota_exceeded': return 'quota'
    case 'rate_limited': return 'rate'
    case 'network_error': return 'network'
    case 'model_unavailable': return 'model'
    case 'pending_verification': return 'pending'
    default: return 'error'
  }
}

/**
 * Inferbase 专用健康检查 = 真实冒烟（v0.1.432 启用门槛）：
 * 公开模型列表 → 用 Ethan 自己的 Key 查余额/用量 → 用 auto 模型发一条测试消息。
 * 全过才记录「已验证」并启用路线；任一步失败记录真实状态与原因，路线保持未启用。
 * 注意：冒烟会消耗 1 次请求（免费档每月 5,000 次内）。
 */
async function checkInferbaseHealth(account: Account, apiKey: string | undefined, started: number): Promise<KeyHealthResult> {
  const done = (r: Omit<KeyHealthResult, 'checkedAt' | 'latencyMs'> & { latencyMs?: number }): KeyHealthResult => ({
    ...r, latencyMs: r.latencyMs ?? (Date.now() - started), checkedAt: Date.now(),
  })
  let modelCount: number
  try {
    modelCount = (await fetchInferbaseModels()).length
  } catch (e) {
    const state = inferbaseStateFromError(e)
    const text = inferbaseErrorText(e)
    recordInferbaseVerification(account, 'failed', state, `模型列表拉取失败：${text}`)
    return done({ status: inferbaseHealthStatus(state), message: `冒烟未通过（${INFERBASE_STATE_LABEL[state]}）：模型列表拉取失败：${text}` })
  }
  if (!apiKey) {
    return done({
      status: 'pending', latencyMs: 0, modelCount,
      message: `待实测：模型列表可达（${modelCount} 个模型），但保险箱未解锁，无法用你的 Key 做余额与聊天冒烟；解锁后重新点健康检查，通过后才启用`,
    })
  }
  let balanceText: string
  try {
    const data = await fetchInferbaseAccountData(apiKey)
    balanceText = formatUsageBalance({ ...parseInferbaseBalance(data), unit: 'currency' })
  } catch (e) {
    const state = inferbaseStateFromError(e)
    const text = inferbaseErrorText(e)
    recordInferbaseVerification(account, 'failed', state, text)
    return done({ status: inferbaseHealthStatus(state), modelCount, message: `冒烟未通过（${INFERBASE_STATE_LABEL[state]}）：${text}` })
  }
  try {
    const eff: Account = { ...account, apiUrl: account.apiUrl?.trim() || INFERBASE_CHAT_BASE }
    const res = await callChat(eff, apiKey, [{ role: 'user', content: 'Reply with OK' }], INFERBASE_SMOKE_MODEL)
    if (!res.ok || res.error) throw new Error(res.error || '聊天接口无有效回复')
    if (!res.text?.trim()) throw new Error('聊天接口返回空回复')
  } catch (e) {
    const state = inferbaseStateFromError(e)
    const text = inferbaseErrorText(e)
    recordInferbaseVerification(account, 'failed', state, `聊天冒烟失败：${text}`)
    return done({ status: inferbaseHealthStatus(state), modelCount, message: `冒烟未通过（${INFERBASE_STATE_LABEL[state]}）：聊天测试失败：${text}` })
  }
  const message = `冒烟通过，已启用：${balanceText} · ${modelCount} 个模型 · auto 聊天可用`
  recordInferbaseVerification(account, 'verified', 'available', message)
  return done({ status: 'ok', modelCount, message })
}

/** One AI 状态 → 健康徽标状态（与 Inferbase 同口径，供 433 切换链消费 OneAiRouteState） */
function oneAiHealthStatus(state: OneAiRouteState): KeyHealthStatus {
  switch (state) {
    case 'available': return 'ok'
    case 'auth_invalid': return 'auth'
    case 'quota_exceeded': return 'quota'
    case 'rate_limited': return 'rate'
    case 'network_error': return 'network'
    case 'model_unavailable': return 'model'
    case 'pending_verification': return 'pending'
    default: return 'error'
  }
}

/**
 * One AI API Key 专用健康检查 = 真实冒烟（v0.1.434 启用门槛，与 Inferbase 同口径）：
 * 用 Ethan 自己的 Key 查 /v1/models（官方口径：返回该 Key 可调用的模型）→ 用免费车道
 * 模型发一条测试消息。全过才记录「已验证」并启用路线；任一步失败记录真实状态与原因，
 * 路线保持未启用、不进自动切换链。无公开余额接口，不查余额；冒烟消耗免费档 1 次请求。
 */
async function checkOneAiHealth(account: Account, apiKey: string | undefined, started: number): Promise<KeyHealthResult> {
  const done = (r: Omit<KeyHealthResult, 'checkedAt' | 'latencyMs'> & { latencyMs?: number }): KeyHealthResult => ({
    ...r, latencyMs: r.latencyMs ?? (Date.now() - started), checkedAt: Date.now(),
  })
  if (!apiKey) {
    return done({
      status: 'pending', latencyMs: 0,
      message: '待实测：保险箱未解锁，无法用你的 Key 做模型列表与聊天冒烟；解锁后重新点健康检查，通过后才启用（One AI 无公开余额接口，本检查不查余额）',
    })
  }
  const eff: Account = { ...account, apiUrl: account.apiUrl?.trim() || ONEAI_BASE }
  let modelCount: number
  try {
    modelCount = (await fetchProviderModels(eff, apiKey)).length
  } catch (e) {
    const state = oneAiStateFromError(e)
    const text = oneAiErrorText(e)
    recordOneAiVerification(account, 'failed', state, `模型列表拉取失败：${text}`)
    return done({ status: oneAiHealthStatus(state), message: `冒烟未通过（${ONEAI_STATE_LABEL[state]}）：模型列表拉取失败：${text}` })
  }
  try {
    const res = await callChat(eff, apiKey, [{ role: 'user', content: 'Reply with OK' }], ONEAI_SMOKE_MODEL)
    if (!res.ok || res.error) throw new Error(res.error || '聊天接口无有效回复')
    if (!res.text?.trim()) throw new Error('聊天接口返回空回复')
  } catch (e) {
    const state = oneAiStateFromError(e)
    const text = oneAiErrorText(e)
    recordOneAiVerification(account, 'failed', state, `聊天冒烟失败：${text}`)
    return done({ status: oneAiHealthStatus(state), modelCount, message: `冒烟未通过（${ONEAI_STATE_LABEL[state]}）：聊天测试失败：${text}` })
  }
  const message = `冒烟通过，已启用：${modelCount} 个模型 · ${ONEAI_SMOKE_MODEL} 聊天可用 · ${oneAiEstimateText(account.id)}`
  recordOneAiVerification(account, 'verified', 'available', message)
  return done({ status: 'ok', modelCount, message })
}

/** AnyAPI 状态 → 健康徽标状态（与 Inferbase / One AI 同口径，供 433 切换链消费 AnyApiRouteState） */
function anyApiHealthStatus(state: AnyApiRouteState): KeyHealthStatus {
  switch (state) {
    case 'available': return 'ok'
    case 'auth_invalid': return 'auth'
    case 'quota_exceeded': return 'quota'
    case 'rate_limited': return 'rate'
    case 'network_error': return 'network'
    case 'model_unavailable': return 'model'
    case 'pending_verification': return 'pending'
    default: return 'error'
  }
}

/**
 * AnyAPI.ai 专用健康检查 = 真实冒烟（v0.1.435 启用门槛，与 Inferbase / One AI 同口径）：
 * 用 Ethan 自己的 Key 查 /v1/models → 从真实返回列表里挑一个模型发一条测试消息。
 * 全过才记录「已验证」（含用通的模型）并启用路线、进入自动切换链；任一步失败记录
 * 真实状态与原因，路线保持未启用。无公开余额接口，不查余额；冒烟消耗免费档 1 次请求。
 * 官网无可核实的免费模型 id 清单，冒烟模型只从 /v1/models 的真实返回里挑，不写死。
 */
async function checkAnyApiHealth(account: Account, apiKey: string | undefined, started: number): Promise<KeyHealthResult> {
  const done = (r: Omit<KeyHealthResult, 'checkedAt' | 'latencyMs'> & { latencyMs?: number }): KeyHealthResult => ({
    ...r, latencyMs: r.latencyMs ?? (Date.now() - started), checkedAt: Date.now(),
  })
  if (!apiKey) {
    return done({
      status: 'pending', latencyMs: 0,
      message: '待实测：保险箱未解锁，无法用你的 Key 做模型列表与聊天冒烟；解锁后重新点健康检查，通过后才启用（AnyAPI 无公开余额接口，本检查不查余额）',
    })
  }
  const eff: Account = { ...account, apiUrl: account.apiUrl?.trim() || ANYAPI_BASE }
  let models: string[]
  try {
    models = await fetchProviderModels(eff, apiKey)
  } catch (e) {
    const state = anyApiStateFromError(e)
    const text = anyApiErrorText(e)
    recordAnyApiVerification(account, 'failed', state, `模型列表拉取失败：${text}`)
    return done({ status: anyApiHealthStatus(state), message: `冒烟未通过（${ANYAPI_STATE_LABEL[state]}）：模型列表拉取失败：${text}` })
  }
  const smokeModel = pickAnyApiSmokeModel(models)
  if (!smokeModel) {
    recordAnyApiVerification(account, 'failed', 'model_unavailable', '模型列表为空，无可用于冒烟的模型')
    return done({ status: 'model', modelCount: 0, message: `冒烟未通过（${ANYAPI_STATE_LABEL.model_unavailable}）：模型列表为空，无可用于冒烟的模型` })
  }
  try {
    const res = await callChat(eff, apiKey, [{ role: 'user', content: 'Reply with OK' }], smokeModel)
    if (!res.ok || res.error) throw new Error(res.error || '聊天接口无有效回复')
    if (!res.text?.trim()) throw new Error('聊天接口返回空回复')
  } catch (e) {
    const state = anyApiStateFromError(e)
    const text = anyApiErrorText(e)
    recordAnyApiVerification(account, 'failed', state, `聊天冒烟失败：${text}`)
    return done({ status: anyApiHealthStatus(state), modelCount: models.length, message: `冒烟未通过（${ANYAPI_STATE_LABEL[state]}）：聊天测试失败：${text}` })
  }
  const message = `冒烟通过，已启用：${models.length} 个模型 · ${smokeModel} 聊天可用 · ${anyApiEstimateText(account.id)}`
  recordAnyApiVerification(account, 'verified', 'available', message, smokeModel)
  return done({ status: 'ok', modelCount: models.length, message })
}

/** MoMA 状态 → 健康徽标状态（与 Inferbase / One AI / AnyAPI 同口径） */
function momaHealthStatus(state: MomaRouteState): KeyHealthStatus {
  switch (state) {
    case 'available': return 'ok'
    case 'auth_invalid': return 'auth'
    case 'quota_exceeded': return 'quota'
    case 'rate_limited': return 'rate'
    case 'network_error': return 'network'
    case 'model_unavailable': return 'model'
    case 'pending_verification': return 'pending'
    default: return 'error'
  }
}

/**
 * 移动云 MoMA 专用健康检查 = 真实冒烟（v0.1.456 启用门槛，与 AnyAPI 同口径）：
 * 用 Ethan 自己的 Key 查 /v1/models → 从真实返回列表里挑一个模型发一条测试消息。
 * 注意 /v1/models 公开可达（无 Key 也返回 200），证明不了 Key 有效——Key 有效性以
 * 聊天冒烟为准（无 Key 聊天实测 401 code 1001）。挑模型优先九天自营对话模型：
 * 2500 万免费试用仅覆盖部分自营模型，冒烟用自营便于他核对扣的是试用额度还是按量。
 * 全过才记录「已验证」（含用通的模型）并启用路线；任一步失败记录真实状态与原因，
 * 路线保持未启用。无公开余额接口，不查余额；冒烟消耗 1 次真实调用（可能计费/扣试用额度）。
 * MoMA 是付费平台：冒烟通过也只启用手动直选，不进 433 自动切换链。
 */
async function checkMomaHealth(account: Account, apiKey: string | undefined, started: number): Promise<KeyHealthResult> {
  const done = (r: Omit<KeyHealthResult, 'checkedAt' | 'latencyMs'> & { latencyMs?: number }): KeyHealthResult => ({
    ...r, latencyMs: r.latencyMs ?? (Date.now() - started), checkedAt: Date.now(),
  })
  if (!apiKey) {
    return done({
      status: 'pending', latencyMs: 0,
      message: '待实测：保险箱未解锁，无法用你的 Key 做模型列表与聊天冒烟；解锁后重新点健康检查，通过后才启用（MoMA 无公开余额接口，本检查不查余额）',
    })
  }
  const eff: Account = { ...account, apiUrl: account.apiUrl?.trim() || MOMA_BASE }
  let models: string[]
  try {
    models = await fetchProviderModels(eff, apiKey)
  } catch (e) {
    const state = momaStateFromError(e)
    const text = momaErrorText(e)
    recordMomaVerification(account, 'failed', state, `模型列表拉取失败：${text}`)
    return done({ status: momaHealthStatus(state), message: `冒烟未通过（${MOMA_STATE_LABEL[state]}）：模型列表拉取失败：${text}` })
  }
  const smokeModel = pickMomaSmokeModel(models)
  if (!smokeModel) {
    recordMomaVerification(account, 'failed', 'model_unavailable', '模型列表里没有可用于冒烟的对话模型')
    return done({ status: 'model', modelCount: models.length, message: `冒烟未通过（${MOMA_STATE_LABEL.model_unavailable}）：模型列表里没有可用于冒烟的对话模型` })
  }
  try {
    const res = await callChat(eff, apiKey, [{ role: 'user', content: 'Reply with OK' }], smokeModel)
    if (!res.ok || res.error) throw new Error(res.error || '聊天接口无有效回复')
    if (!res.text?.trim()) throw new Error('聊天接口返回空回复')
  } catch (e) {
    const state = momaStateFromError(e)
    const text = momaErrorText(e)
    recordMomaVerification(account, 'failed', state, `聊天冒烟失败：${text}`)
    return done({ status: momaHealthStatus(state), modelCount: models.length, message: `冒烟未通过（${MOMA_STATE_LABEL[state]}）：聊天测试失败：${text}` })
  }
  const message = `冒烟通过，已启用：${models.length} 个模型 · ${smokeModel} 聊天可用 · ${momaEstimateText(account.id)}（冒烟优先用九天自营模型：请到 MoMA 控制台核对这次调用扣的是 2500 万免费试用额度还是按量余额；MoMA 为付费平台，不进入自动切换链）`
  recordMomaVerification(account, 'verified', 'available', message, smokeModel)
  return done({ status: 'ok', modelCount: models.length, message })
}

/** TokenRouter 状态 → 健康徽标状态（与 Inferbase / One AI / AnyAPI / MoMA 同口径） */
function tokenRouterHealthStatus(state: TokenRouterRouteState): KeyHealthStatus {
  switch (state) {
    case 'available': return 'ok'
    case 'auth_invalid': return 'auth'
    case 'quota_exceeded': return 'quota'
    case 'rate_limited': return 'rate'
    case 'network_error': return 'network'
    case 'model_unavailable': return 'model'
    case 'pending_verification': return 'pending'
    default: return 'error'
  }
}

/**
 * TokenRouter 专用健康检查 = 真实冒烟（v0.1.514 启用门槛，与 AnyAPI / MoMA 同口径）：
 * 模型清单是本机精选常量、不发列表请求（也不拉平台全量 100+ 目录），Key 有效性
 * 直接以聊天冒烟为准：用 Ethan 自己的 Key 拿精选清单里的免费主力模型发一条
 * 测试消息。全过才记录「已验证」（含用通的免费模型）并启用路线、进入自动切换链
 * 末位；任一步失败记录真实状态与原因，路线保持未启用。无公开余额接口、不查余额；
 * 冒烟消耗免费模型 1 次请求（免费额度未公布，量级可忽略但如实说明）。
 * 免费模型若已轮换下线，网关回 model_not_found → 状态 model_unavailable 如实显示。
 */
async function checkTokenRouterHealth(account: Account, apiKey: string | undefined, started: number): Promise<KeyHealthResult> {
  const done = (r: Omit<KeyHealthResult, 'checkedAt' | 'latencyMs'> & { latencyMs?: number }): KeyHealthResult => ({
    ...r, latencyMs: r.latencyMs ?? (Date.now() - started), checkedAt: Date.now(),
  })
  if (!apiKey) {
    return done({
      status: 'pending', latencyMs: 0,
      message: '待实测：保险箱未解锁，无法用你的 Key 做聊天冒烟；解锁后重新点健康检查，通过后才启用（TokenRouter 无公开余额接口、免费额度未公布，本检查不查余额）',
    })
  }
  const eff: Account = { ...account, apiUrl: account.apiUrl?.trim() || TOKENROUTER_BASE }
  let models: string[]
  try {
    models = await fetchProviderModels(eff, apiKey) // TokenRouter 分支返回精选清单（本机常量）
  } catch (e) {
    const state = tokenRouterStateFromError(e)
    const text = tokenRouterErrorText(e)
    recordTokenRouterVerification(account, 'failed', state, `模型清单读取失败：${text}`)
    return done({ status: tokenRouterHealthStatus(state), message: `冒烟未通过（${TOKENROUTER_STATE_LABEL[state]}）：模型清单读取失败：${text}` })
  }
  const smokeModel = pickTokenRouterSmokeModel(models)
  try {
    const res = await callChat(eff, apiKey, [{ role: 'user', content: 'Reply with OK' }], smokeModel)
    if (!res.ok || res.error) throw new Error(res.error || '聊天接口无有效回复')
    if (!res.text?.trim()) throw new Error('聊天接口返回空回复')
  } catch (e) {
    const state = tokenRouterStateFromError(e)
    const text = tokenRouterErrorText(e)
    recordTokenRouterVerification(account, 'failed', state, `聊天冒烟失败：${text}`)
    return done({ status: tokenRouterHealthStatus(state), modelCount: models.length, message: `冒烟未通过（${TOKENROUTER_STATE_LABEL[state]}）：聊天测试失败：${text}` })
  }
  const message = `冒烟通过，已启用：精选清单 ${models.length} 个模型 · ${smokeModel} 聊天可用 · ${tokenRouterEstimateText(account.id)}（TokenRouter 为第三方中转，免费额度未公布；已进入免费路线自动切换链末位，只切免费模型）`
  recordTokenRouterVerification(account, 'verified', 'available', message, smokeModel)
  return done({ status: 'ok', modelCount: models.length, message })
}

export async function checkKeyHealth(account: Account, apiKey?: string): Promise<KeyHealthResult> {
  const started = Date.now()
  const done = (r: Omit<KeyHealthResult, 'checkedAt' | 'latencyMs'> & { latencyMs?: number }): KeyHealthResult => ({
    ...r, latencyMs: r.latencyMs ?? (Date.now() - started), checkedAt: Date.now(),
  })
  try {
    if (account.providerId === 'inferbase') return await checkInferbaseHealth(account, apiKey, started)
    if (account.providerId === 'oneai') return await checkOneAiHealth(account, apiKey, started)
    if (account.providerId === 'anyapi') return await checkAnyApiHealth(account, apiKey, started)
    if (account.providerId === 'moma') return await checkMomaHealth(account, apiKey, started)
    if (account.providerId === 'tokenrouter') return await checkTokenRouterHealth(account, apiKey, started)
    if (isLocalProvider(account.providerId)) {
      const base = (account.apiUrl || '').trim()
      if (!base) return done({ status: 'skipped', latencyMs: 0, message: '未填写本地服务地址' })
      try {
        const models = await fetchLocalMediaModels(base)
        return done({ status: 'ok', modelCount: models.length, message: `本地服务正常 · ${models.length} 个模型` })
      } catch (e) {
        // 服务有 HTTP 响应（如 ComfyUI 没有 /v1/models）也算可达，只是拿不到模型列表
        const msg = e instanceof Error ? e.message : String(e ?? '')
        if (/接口返回 \d+/.test(msg)) return done({ status: 'ok', message: '本地服务可达' })
        throw e
      }
    }
    if (!account.apiUrl?.trim()) return done({ status: 'skipped', latencyMs: 0, message: '未填写 API 地址' })
    if (!apiKey) return done({ status: 'skipped', latencyMs: 0, message: '保险箱未解锁，无法读取密钥' })
    const models = await fetchProviderModels(account, apiKey)
    return done({ status: 'ok', modelCount: models.length, message: `可用 · ${models.length} 个模型` })
  } catch (e) {
    const c = classifyHealthError(e)
    return done({ status: c.status, message: c.message })
  }
}

export function loadKeyHealth(): Record<string, KeyHealthResult> {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, KeyHealthResult> : {}
  } catch { return {} }
}

export function saveKeyHealth(map: Record<string, KeyHealthResult>): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(map)) } catch { /* 忽略 */ }
}

export const HEALTH_LABEL: Record<KeyHealthStatus, string> = {
  ok: '正常', auth: '密钥失效', quota: '额度不足', network: '网络不通', error: '异常', skipped: '未检查',
  rate: '限流', pending: '待实测', model: '模型不可用',
}
