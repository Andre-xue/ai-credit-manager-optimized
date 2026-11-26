// 移动云 MoMA 接入（v0.1.456）：平台预设、无余额接口口径、健康状态机、启用门槛、
// 429 冷却口径、本机用量估算、冒烟模型挑选（九天自营优先）、不进自动切换链红线。
// 沙箱无 Ethan 的真实 Key：聊天冒烟用 mock 验证状态机；公开侧已实测（2026-11-26）：
// GET /v1/models 无 Key 返回 200、172 个模型（公开目录，owned_by 为空、无自营标记）；
// POST /v1/chat/completions 无 Key 返回 401 {"error":{"code":"1001","message":
// "Authentication parameter not received in Header, unable to authenticate"}}。
// 真实 Key 的冒烟待 Ethan 在 App 里加 Key 后实测（健康检查即冒烟入口，看扣哪份额度）。
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { PROVIDER_MAP } from '../data/providers'
import { ENGINE_CATALOG } from '../data/engines'
import { getAdapter, NO_BALANCE_API_NOTE } from './adapters'
import {
  classifyMomaHttp, momaStateFromError, MomaApiError, momaGate, recordMomaVerification,
  momaCooldownFor, recordMomaRouteFailure, recordMomaRouteSuccess,
  recordMomaLocalUsage, loadMomaLocalUsage, momaEstimateText, momaLimitsText,
  pickMomaSmokeModel, getMomaSmokeModel, isMomaChatCandidate,
  isMomaSelfOperated, momaModelBillingNote, orderMomaProbeModels,
  classifyMomaModel, isMomaAutoTestable, groupMomaModels,
  loadMomaModelTests, saveMomaModelTest, loadMomaFreeOnly, saveMomaFreeOnly,
  MOMA_BASE, MOMA_RATE_COOLDOWN_MS, MOMA_QUOTA_COOLDOWN_MS,
} from './moma'
import { CHAIN_KIND_ORDER } from './freeChain'

vi.mock('./crypto', () => ({ decryptSecret: async () => 'test-key' }))

class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}
;(globalThis as any).localStorage = new MemStorage()

const acct = { id: 'mm1', providerId: 'moma', keyFingerprint: 'fp1' }

describe('MoMA 平台预设（第 61 个平台）', () => {
  it('目录里有 moma，Base URL 是模型广场按量网关（呼和浩特 /v1）', () => {
    const p = PROVIDER_MAP['moma']
    expect(p).toBeTruthy()
    expect(p.apiBaseUrl).toBe(MOMA_BASE)
    expect(p.apiBaseUrl).toBe('https://zhenze-huhehaote.cmecloud.cn/v1')
    expect(p.apiKeyUrl).toContain('ecloud.10086.cn')
    expect(p.apiKeyUrl).toContain('apiKeyManage')
    expect(p.note).toContain('无公开余额接口')
    expect(p.note).toContain('2500 万免费试用')
  })
  it('红线：预设地址不含 Coding Plan / Token Plan 路径', () => {
    const p = PROVIDER_MAP['moma']
    for (const u of [p.apiBaseUrl, p.apiKeyUrl, p.officialUrl, p.usageUrl]) {
      expect(u ?? '').not.toMatch(/coding-plan-token|tokenplan/i)
    }
    expect(MOMA_BASE).not.toMatch(/coding-plan-token|tokenplan/i)
  })
  it('无公开余额接口：适配器不支持自动查余额，提示去控制台手动录入', () => {
    expect(getAdapter('moma').supported).toBe(false)
    expect(NO_BALANCE_API_NOTE['moma']).toContain('无公开余额接口')
    expect(NO_BALANCE_API_NOTE['moma']).toContain('手动录入')
  })
  it('引擎目录不预置模型：全量走 /v1/models 动态拉取', () => {
    expect(ENGINE_CATALOG['moma']).toBeUndefined()
  })
  it('口径文案如实：按量付费 + 2500 万试用 + 本机估算 + 不进自动切换链', () => {
    const text = momaLimitsText()
    expect(text).toContain('按量付费')
    expect(text).toContain('2500 万免费试用')
    expect(text).toContain('无公开余额接口')
    expect(text).toContain('手动录入')
    expect(text).toContain('不进入免费路线自动切换链')
  })
})

describe('MoMA 状态归类', () => {
  it('HTTP 状态归类与 AnyAPI 同口径（401 用官方实测原文）', () => {
    expect(classifyMomaHttp(401, 'Authentication parameter not received in Header, unable to authenticate').state).toBe('auth_invalid')
    expect(classifyMomaHttp(403, 'forbidden').state).toBe('auth_invalid')
    expect(classifyMomaHttp(402, 'insufficient credit').state).toBe('quota_exceeded')
    expect(classifyMomaHttp(429, 'too many', 30).state).toBe('rate_limited')
    expect(classifyMomaHttp(429, 'too many', 30).retryAfterSec).toBe(30)
    expect(classifyMomaHttp(404, 'model not found').state).toBe('model_unavailable')
    expect(classifyMomaHttp(500, 'boom').state).toBe('error')
  })
  it('文本错误归类保留原文（含实测 401 英文原文）', () => {
    expect(momaStateFromError(new Error('接口返回 401：{"error":{"code":"1001","message":"Authentication parameter not received in Header, unable to authenticate"}}'))).toBe('auth_invalid')
    expect(momaStateFromError(new Error('接口返回 429：rate limit'))).toBe('rate_limited')
    expect(momaStateFromError(new Error('Failed to fetch'))).toBe('network_error')
    expect(momaStateFromError(new MomaApiError('x', 'quota_exceeded'))).toBe('quota_exceeded')
  })
  // v0.1.464：网关对不在聊天端点上的模型回 400 model_not_found（2026-11-27 沙箱
  // 无 Key 实测同款报文，模型校验先于鉴权）。旧归类只认带空格的 "not found"，
  // 对官方措辞（code=model_not_found + "is not available"）失配落兜底 error。
  const COSY_400 = '调用失败：接口返回 400 [POST https://zhenze-huhehaote.cmecloud.cn/v1/chat/completions body={"model":"CosyVoice","messages":[{"role":"user","content":"ping"}],"stream":false}]：{"error":{"code":"model_not_found","message":"The requested model is not available on this endpoint.","param":"model","type":"invalid_request_error"}}'
  it('400 model_not_found 如实归类为模型不可用（HTTP 与文本两路）', () => {
    expect(classifyMomaHttp(400, 'The requested model is not available on this endpoint.').state).toBe('model_unavailable')
    expect(classifyMomaHttp(400, 'model_not_found').state).toBe('model_unavailable')
    expect(momaStateFromError(new Error(COSY_400))).toBe('model_unavailable')
  })
  it('model_not_found 不给账户上冷却（区别于限流/额度）', () => {
    const rt = recordMomaRouteFailure('mm-model404', new Error(COSY_400), Date.UTC(2026, 10, 27))
    expect(rt.lastState).toBe('model_unavailable')
    expect(rt.cooldownUntil).toBe(0)
    expect(rt.authInvalid).toBeFalsy()
    expect(momaCooldownFor('model_unavailable', undefined, Date.UTC(2026, 10, 27))).toBeNull()
  })
})

describe('MoMA 冷却口径', () => {
  const now = Date.UTC(2026, 10, 26, 5, 30, 0) // 2026-11-26 05:30 UTC
  it('有 Retry-After 用 Retry-After 并写明口径', () => {
    const cd = momaCooldownFor('rate_limited', 120, now)!
    expect(cd.until).toBe(now + 120_000)
    expect(cd.reason).toContain('Retry-After')
  })
  it('429 无 Retry-After → 60 秒冷却，原因写明网关未公布限额（不编造重置时间）', () => {
    const cd = momaCooldownFor('rate_limited', undefined, now)!
    expect(cd.until).toBe(now + MOMA_RATE_COOLDOWN_MS)
    expect(cd.until).toBe(now + 60_000)
    expect(cd.reason).toContain('未公布')
  })
  it('额度不足无 Retry-After → 10 分钟冷却，原因写明网关未公布恢复口径', () => {
    const cd = momaCooldownFor('quota_exceeded', undefined, now)!
    expect(cd.until).toBe(now + MOMA_QUOTA_COOLDOWN_MS)
    expect(cd.reason).toContain('未公布')
  })
  it('非限流/额度状态不冷却', () => {
    expect(momaCooldownFor('auth_invalid', undefined, now)).toBeNull()
    expect(momaCooldownFor('available', undefined, now)).toBeNull()
  })
})

describe('MoMA 冒烟模型挑选（只从真实返回里挑，自营优先）', () => {
  // 形态取自 2026-11-26 公开实测列表（172 个，含非对话模型混杂）
  const realish = ['qwen/qwen4-max', 'Qwen3Guard-Gen-8B', 'CosyVoice', 'SenseVoice', 'JIUTIAN-75B-32K', 'JIUTIAN-75B-8K-Chat', 'jiutian-safe-40b', 'deepseek-v4.1-flash', 'Flux.1-dev']
  it('自营优先：挑九天对话模型（带 chat 优先于不带 chat）', () => {
    expect(pickMomaSmokeModel(realish)).toBe('JIUTIAN-75B-8K-Chat')
    expect(pickMomaSmokeModel(['qwen/qwen4-max', 'JIUTIAN-75B-32K', 'deepseek-v4.1-flash'])).toBe('JIUTIAN-75B-32K')
  })
  it('非对话模型不作冒烟候选（语音/生图/安全分类/视觉）', () => {
    expect(isMomaChatCandidate('CosyVoice')).toBe(false)
    expect(isMomaChatCandidate('SenseVoice')).toBe(false)
    expect(isMomaChatCandidate('Flux.1-dev')).toBe(false)
    expect(isMomaChatCandidate('jiutian-safe-40b')).toBe(false)
    expect(isMomaChatCandidate('qwen3-vl-32b-instruct')).toBe(false)
    expect(pickMomaSmokeModel(['CosyVoice', 'SenseVoice', 'jiutian-safe-40b'])).toBeUndefined()
    expect(pickMomaSmokeModel([])).toBeUndefined()
  })
  it('非对话剔除覆盖 172 条真实目录的全部非对话类（v0.1.464 补齐向量/视频/多模态）', () => {
    // 形态全部取自 2026-11-27 实拉的公开目录
    for (const id of [
      'aitc-qwen3-asr-1.7b', 'qwen/qwen3-tts-flash', 'qwen/cosyvoice-v3.5-flash',
      'hncm/qwen-image-2512', 'qwen/text-embedding-v4', 'bge-m3', 'bge-base-zh-v1.5',
      'bge-reranker-v2-m3', 'cmiot/kitchen-video-detection-model', 'qwen/happyhorse-1.1-t2v',
      'hncm/wan2.2-ti2v-5b-diffusers', 'doubao-seedance-2.5', 'Qwen3Guard-Gen-8B',
      'qwen/qwen3.5-omni-plus-realtime', 'qwen/qwen-mt-plus', 'hacm/qwen2.5-vl-32b-instruct',
    ]) {
      expect(isMomaChatCandidate(id), id).toBe(false)
    }
    for (const id of ['JIUTIAN-75B-8K-Chat', 'jiutian-236b-256k-chat', 'jiutian-35b-256k-chat', 'deepseek-v3', 'qwen/qwen4-max', 'glm-5.3', 'kimi/kimi-k3.1-pro']) {
      expect(isMomaChatCandidate(id), id).toBe(true)
    }
  })
  it('探测顺序：九天对话 → 其他九天 → 其余（v0.1.464）', () => {
    const ids = ['ahcm/deepseek-v4-flash-0731', 'JIUTIAN-75B-32K', 'deepseek-v3', 'jiutian-236b-256k-chat', 'JIUTIAN-75B-8K-Chat']
    expect(orderMomaProbeModels(ids)).toEqual([
      'jiutian-236b-256k-chat', 'JIUTIAN-75B-8K-Chat', 'JIUTIAN-75B-32K',
      'ahcm/deepseek-v4-flash-0731', 'deepseek-v3',
    ])
  })
  it('计费标注只标能坐实的：九天=自营可用试用，其余=可能走按量（v0.1.464）', () => {
    expect(isMomaSelfOperated('jiutian-35b-256k-chat')).toBe(true)
    expect(isMomaSelfOperated('ahcm/deepseek-v4-flash-0731')).toBe(false)
    expect(momaModelBillingNote('JIUTIAN-75B-8K-Chat')).toBe('移动云自营 · 可用免费试用额度')
    expect(momaModelBillingNote('deepseek-v3')).toBe('可能走按量付费')
  })
  it('没有自营时依次 free 标记 → 开源家族 → 第一个对话候选', () => {
    expect(pickMomaSmokeModel(['gpt-x-pro', 'some-model-free'])).toBe('some-model-free')
    expect(pickMomaSmokeModel(['gpt-x-pro', 'deepseek-v4.1-flash'])).toBe('deepseek-v4.1-flash')
    expect(pickMomaSmokeModel(['gpt-x-pro', 'claude-y'])).toBe('gpt-x-pro')
  })
})

describe('MoMA 启用门槛与运行状态', () => {
  beforeEach(() => { ;(localStorage as any).clear() })
  it('未冒烟 → 待实测未启用', () => {
    const g = momaGate(acct)
    expect(g.enabled).toBe(false)
    expect(g.state).toBe('pending_verification')
    expect(g.message).toContain('健康检查')
    expect(getMomaSmokeModel(acct.id)).toBeUndefined()
  })
  it('冒烟失败 → 保持未启用并带真实状态', () => {
    recordMomaVerification(acct, 'failed', 'auth_invalid', '聊天冒烟失败：接口返回 401')
    const g = momaGate(acct)
    expect(g.enabled).toBe(false)
    expect(g.state).toBe('auth_invalid')
    expect(g.message).toContain('冒烟未通过')
  })
  it('冒烟通过 → 启用且记住用通的模型；换 Key（指纹变）→ 回到待实测', () => {
    recordMomaVerification(acct, 'verified', 'available', '冒烟通过', 'JIUTIAN-75B-8K-Chat')
    expect(momaGate(acct).enabled).toBe(true)
    expect(getMomaSmokeModel(acct.id)).toBe('JIUTIAN-75B-8K-Chat')
    expect(momaGate({ ...acct, keyFingerprint: 'fp2' }).enabled).toBe(false)
    expect(momaGate({ ...acct, keyFingerprint: 'fp2' }).state).toBe('pending_verification')
  })
  it('已验证账户真实调用 429 → 门槛转冷却未启用，原因写明口径；成功后恢复', () => {
    recordMomaVerification(acct, 'verified', 'available', '冒烟通过', 'JIUTIAN-75B-8K-Chat')
    const now = Date.UTC(2026, 10, 26, 5, 30, 0)
    recordMomaRouteFailure(acct.id, new Error('接口返回 429：rate limit exceeded'), now)
    const g = momaGate(acct, now + 1000)
    expect(g.enabled).toBe(false)
    expect(g.state).toBe('rate_limited')
    expect(g.message).toContain('未公布')
    expect(momaGate(acct, now + MOMA_RATE_COOLDOWN_MS + 1).enabled).toBe(true)
    recordMomaRouteFailure(acct.id, new Error('接口返回 429：rate limit exceeded'), now)
    recordMomaRouteSuccess(acct.id)
    expect(momaGate(acct, now + 1000).enabled).toBe(true)
  })
  it('已验证账户 401 → 标记密钥失效停用，重新冒烟通过后恢复', () => {
    recordMomaVerification(acct, 'verified', 'available', '冒烟通过', 'JIUTIAN-75B-8K-Chat')
    recordMomaRouteFailure(acct.id, new Error('接口返回 401：Authentication parameter not received in Header, unable to authenticate'))
    const g = momaGate(acct)
    expect(g.enabled).toBe(false)
    expect(g.state).toBe('auth_invalid')
    recordMomaVerification(acct, 'verified', 'available', '重新冒烟通过', 'JIUTIAN-75B-8K-Chat')
    expect(momaGate(acct).enabled).toBe(true)
  })
  it('非 moma 账户不受门槛影响', () => {
    expect(momaGate({ id: 'x', providerId: 'deepseek' }).enabled).toBe(true)
  })
})

describe('MoMA 本机用量估算', () => {
  beforeEach(() => { ;(localStorage as any).clear() })
  it('按 UTC 日累计请求与 tokens，文案标注本机估算与控制台口径', () => {
    const now = Date.UTC(2026, 10, 26, 5, 0, 0)
    recordMomaLocalUsage('mm1', 1200, now)
    recordMomaLocalUsage('mm1', 800, now + 60_000)
    const u = loadMomaLocalUsage('mm1', now + 120_000)
    expect(u.requests).toBe(2)
    expect(u.tokens).toBe(2000)
    const text = momaEstimateText('mm1', now + 120_000)
    expect(text).toContain('本机估算')
    expect(text).toContain('控制台为准')
    expect(text).toContain('2500 万免费试用')
  })
  it('跨 UTC 日自动归零', () => {
    const day1 = Date.UTC(2026, 10, 26, 23, 59, 0)
    recordMomaLocalUsage('mm1', 500, day1)
    const day2 = Date.UTC(2026, 10, 27, 0, 1, 0)
    expect(loadMomaLocalUsage('mm1', day2).requests).toBe(0)
    recordMomaLocalUsage('mm1', 300, day2)
    expect(loadMomaLocalUsage('mm1', day2).requests).toBe(1)
    expect(loadMomaLocalUsage('mm1', day2).tokens).toBe(300)
  })
  it('无 usage 返回时只记请求数、tokens 记 0（不编造）', () => {
    const now = Date.UTC(2026, 10, 26, 5, 0, 0)
    recordMomaLocalUsage('mm1', 0, now)
    expect(loadMomaLocalUsage('mm1', now)).toEqual({ day: '2026-11-26', requests: 1, tokens: 0 })
  })
})

describe('MoMA 不进自动切换链（红线）', () => {
  it('切换链类别顺序里没有 moma', () => {
    expect(CHAIN_KIND_ORDER).not.toContain('moma')
  })
})

describe('MoMA 健康检查 = 真实冒烟（mock 网络验证状态机）', () => {
  beforeEach(() => { ;(localStorage as any).clear() })
  afterEach(() => vi.unstubAllGlobals())
  const account = {
    id: 'mm1', providerId: 'moma', label: 'MoMA', mode: 'api' as const,
    apiUrl: 'https://zhenze-huhehaote.cmecloud.cn/v1', encryptedKey: 'enc', keyFingerprint: 'fp1',
    modelCapability: 'chat' as const, note: '[通用型]', createdAt: '2026-01-01', updatedAt: '2026-01-01',
  }
  it('未解锁（无 Key）→ 待实测、零请求', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { checkKeyHealth } = await import('./healthCheck')
    const r = await checkKeyHealth(account, undefined)
    expect(r.status).toBe('pending')
    expect(r.message).toContain('待实测')
    expect(fetchMock.mock.calls.length).toBe(0)
    expect(momaGate(account).enabled).toBe(false)
  })
  it('模型列表 + 九天冒烟通过 → 已验证启用，记住冒烟模型', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: { body?: string }) => {
      if (String(url).includes('/models')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'qwen/qwen4-max' }, { id: 'CosyVoice' }, { id: 'JIUTIAN-75B-8K-Chat' }] }) }
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'OK' } }], usage: { total_tokens: 5 } }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    const { checkKeyHealth } = await import('./healthCheck')
    const r = await checkKeyHealth(account, 'test-key')
    expect(r.status).toBe('ok')
    expect(r.modelCount).toBe(3)
    expect(r.message).toContain('JIUTIAN-75B-8K-Chat')
    expect(r.message).toContain('2500 万免费试用')
    expect(momaGate(account).enabled).toBe(true)
    expect(getMomaSmokeModel('mm1')).toBe('JIUTIAN-75B-8K-Chat')
    // 聊天请求发的确实是九天模型（冒烟优先自营的证据）
    const chatCall = fetchMock.mock.calls.find(c => String(c[0]).includes('/chat/completions'))
    expect(chatCall).toBeTruthy()
    expect(JSON.parse((chatCall![1] as any).body).model).toBe('JIUTIAN-75B-8K-Chat')
  })
  it('聊天 401（官方实测信封）→ 密钥失效、保持未启用、原文透传', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/models')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'JIUTIAN-75B-8K-Chat' }] }) }
      }
      return { ok: false, status: 401, text: async () => '{"error":{"code":"1001","message":"Authentication parameter not received in Header, unable to authenticate"}}' }
    })
    vi.stubGlobal('fetch', fetchMock)
    const { checkKeyHealth } = await import('./healthCheck')
    const r = await checkKeyHealth(account, 'bad-key')
    expect(r.status).toBe('auth')
    expect(r.message).toContain('Authentication parameter not received')
    const g = momaGate(account)
    expect(g.enabled).toBe(false)
    expect(g.state).toBe('auth_invalid')
  })
})

describe('MoMA 工坊路线门槛（v0.1.456）', () => {
  beforeEach(() => { ;(localStorage as any).clear() })
  afterEach(() => vi.unstubAllGlobals())
  const account = {
    id: 'mm1', providerId: 'moma', label: 'MoMA', mode: 'api' as const,
    apiUrl: 'https://zhenze-huhehaote.cmecloud.cn/v1', encryptedKey: 'enc', keyFingerprint: 'fp1',
    modelCapability: 'chat' as const, note: '[通用型]', createdAt: '2026-01-01', updatedAt: '2026-01-01',
  }
  it('未冒烟的 MoMA 路线带 disabledReason，发送时原样抛真实原因且零调用', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const { loadWorkshopRoutes, runWorkshopChat } = await import('./workshopChat')
    const { routes } = await loadWorkshopRoutes([account])
    const route = routes.find(r => r.kind === 'account')
    expect(route).toBeTruthy()
    expect((route as { label: string }).label).toContain('待实测')
    expect((route as { disabledReason?: string }).disabledReason).toContain('健康检查')
    const callsBefore = fetchMock.mock.calls.length
    let errMsg = ''
    try {
      await runWorkshopChat({
        route: route!, freeOptions: [], accounts: [account],
        sessionPwd: 'pwd', system: 's', user: 'u',
      })
    } catch (e) { errMsg = e instanceof Error ? e.message : String(e) }
    expect(errMsg).toContain('待实测')
    expect(fetchMock.mock.calls.length).toBe(callsBefore) // 门槛拦截发生在解密/发请求之前
  })
  it('冒烟通过的 MoMA 账户不进自动切换链候选（红线），但工坊模型用冒烟用通的模型', async () => {
    const { buildWorkshopChainRoutes, resolveWorkshopModel } = await import('./workshopChat')
    recordMomaVerification(account, 'verified', 'available', '冒烟通过', 'JIUTIAN-75B-8K-Chat')
    const chain = await buildWorkshopChainRoutes({
      route: { kind: 'free', key: 'free:up:zen:m', label: '免费 · M' },
      freeOptions: [], accounts: [account], sessionPwd: 'pwd', system: 's', user: 'u',
    })
    expect(chain.some(r => r.key === 'acct:mm1')).toBe(false)
    expect(resolveWorkshopModel(account)).toBe('JIUTIAN-75B-8K-Chat')
  })
})

describe('MoMA 模型列表治理（v0.1.469）', () => {
  beforeEach(() => { ;(localStorage as any).clear() })
  // 2026-11-27 实拉的公开目录全量 172 条（GET /v1/models 无 Key 200）
  const REAL_172: string[] = [
  "qwen/qwen4-max", "Qwen3Guard-Gen-8B", "qwen2.5-coder-32b-Instruct", "Qwen2.5-14B-Instruct-1M",
  "qwen3-vl-32b-instruct", "JIUTIAN-75B-32K", "glm-4-9b", "CosyVoice",
  "SenseVoice", "Qwen3-235B-A22B", "deepseek-r1-128k", "Flux.1-dev",
  "Qwen2-VL-72B-Instruct", "Qwen2-VL-7B-Instruct", "JIUTIAN-75B-8K-Chat", "DeepSeek-V2",
  "DeepSeek-R1-Distill-Qwen-7B", "Glm-4-9B-Chat", "bjcm/minimax-m2.5", "jscm/deepseek-v4-flash",
  "yby/deepseek-v4-pro-0813", "deepseek-v4.1-flash-1017", "kimi/kimi-k3.1-pro", "doubao-seedance-2.5",
  "tencentcloud/hy3", "minimax/minimax-m3.1-flash", "hncm/qwen-image-2512", "hncm/wan2.2-ti2v-5b-diffusers",
  "hncm/qwen3-vl-32b-instruct", "hncm/glm-5.3-flash", "hncm/glm-5.3", "nmcm/minimax-h3",
  "hacm/minimax-h3", "fjcm/deepseek-v4-flash", "aitc-minimax-m2.5", "aitc-qwen3-asr-1.7b",
  "ahcm/deepseek-v4-flash-0731", "qwen/qwen-image-3.0-pro", "qwen/qwen-image-3.0", "jiutian-safe-40b",
  "jiutian-ict-35b-256k", "ykd/minimax-m2.5", "cmiot/kitchen-video-detection-model", "jiutian-236b-256k-chat",
  "jiutian-35b-256k-chat", "gscm/deepseek-v4-flash-0731", "jscm/kimi-k3", "deepseek-v4.1-flash",
  "cqcm/qwen3.6-27b", "cqcm/glm-5.2", "glm-5.3-flash", "minimax/minimax-h3-max",
  "qwen/qwen-audio-3.0-asr-flash", "qwen/qwen-audio-3.0-tts-flash", "qwen/text-embedding-v4-29042da26e0e", "glm-5.3",
  "fjcm/deepseek-v4-flash-0731", "qwen/text-embedding-v4", "qwen/qwen3.5-35b-a3b-29042da26e0e", "qwen3-vl-235b-a22b-instruct",
  "minimax-h3", "hacm/deepseek-v4-flash-0731", "jxcm/deepseek-v4-flash-0731", "hacm/qwen3.5-35b-a3b",
  "hacm/qwen2.5-vl-32b-instruct", "sycl/minimax-m3", "qwen/qwen-audio-3.0-asr-flash-streaming", "ykd/deepseek-v3.2",
  "zhipu/glm-5.3-flash", "hacm/deepseek-v3.2", "qwen3.5-397b-a17b", "gzdj/deepseek-v4-flash",
  "szsjb/deepseek-v4-flash", "gzdj/deepseek-v4-pro", "szsjb/deepseek-v4-pro", "szdx/deepseek-v4-pro",
  "gzho/deepseek-v3.2", "szsjb/deepseek-v3.2", "szym/deepseek-v3.2", "szdx/deepseek-v3.2",
  "qwen/qwen3.5-omni-plus", "nmcm/deepseek-v3.2", "zhipu/glm-5.3", "glm-5.2",
  "qwen/qwen3.5-omni-plus-realtime", "qwen/qwen3.5-omni-flash-realtime", "qwen/qwen3.5-omni-flash", "gnxx/deepseek-v3.2",
  "szym/deepseek-v4-pro", "qwen/qwen3.8-max", "qwen3.5-35b-a3b", "hacm/minimax-m2.5",
  "nmcm/deepseek-v4-flash", "qwen/deepseek-v4-pro", "qwen/glm-5.2", "minimax/minimax-h3",
  "szym/deepseek-v4-flash", "qwen/qwen3-asr-flash", "deepseek-r1-distill-qwen-32b", "qwen/fun-asr",
  "qwen/cosyvoice-v3.5-flash", "cqcm/deepseek-v4-flash", "bjcm/deepseek-v4-flash", "hlcm/glm-5",
  "hecm/minimax-m2.5", "zjcm/deepseek-v4-flash", "qwen/qwen3-tts-flash", "qwen/fun-asr-realtime",
  "hncm/minimax-m2.5", "aitc-deepseek-v4-flash", "qwen2.5-vl-7b-instruct", "qwen1.5-14b-chat",
  "deepseek-r1-64k", "bge-reranker-v2-m3", "bge-base-zh-v1.5", "gdmz/doubao-seedance-2.0",
  "jtxx/glm-5.2", "jszq/glm-5.2", "sycl/glm-5.2", "qwen3.5-27b",
  "qwen3.5-9b", "kimi/kimi-k3", "qwen/happyhorse-1.1-i2v", "qwen/happyhorse-1.1-t2v",
  "qwen/happyhorse-1.1-r2v", "qwen/happyhorse-1.0-video-edit", "qwen/qwen3.5-flash", "qwen/qwen3.7-plus",
  "qwen/qwen3.6-flash", "Qwen/Fun-ASR-Flash-8k-Realtime", "Qwen/Qwen3-ASR-Flash-Realtime", "Qwen/Qwen3-LiveTranslate-Flash",
  "aitc-qwen3.5-35b", "qwen3.5-4b", "kimi/kimi-k2.7-code", "kimi/kimi-k2.6",
  "qwen3.5-4b-awq", "zhipu/glm-5.2", "zhipu/glm-5.1", "qwen/qwen3.7-max",
  "minimax/MiniMax-M2.7-highspeed", "minimax/minimax-m2.7", "minimax/minimax-m3", "qwen/qwen3.6-plus",
  "qwen/qwen3-vl-plus", "qwen/qwen-mt-plus", "qwen/qwen3-omni-flash", "qwen/gui-plus",
  "qwen/qwen-mt-flash", "glm-5.1", "qwen/qwen3.5-plus", "deepseek-v3.2",
  "minimax-m2.5", "qwen2.5-7b-instruct", "qwen2.5-14b-instruct", "qwen2.5-32b-instruct",
  "qwen2.5-72b-instruct", "deepseek-r1-distill-qwen-14b", "deepseek-r1", "deepseek-r1-distill-llama-8b",
  "deepseek-v3", "deepseek-r1-distill-llama-70b", "deepseek-v2-lite-chat", "qwq-32b",
  "bge-m3", "deepseek-r1-0528", "qwen2.5-vl-32b-instruct", "qwen2.5-vl-72b-instruct",
  "deepseek-v3-0324", "qwen2.5-72b-instruct-64k", "qwen3-32b", "deepseek-v3.1",
  ]
  it('全量 172 条都有分类，且对话组与 464 的 isMomaChatCandidate 严格一致', () => {
    expect(REAL_172.length).toBe(172)
    const counts: Record<string, number> = {}
    for (const id of REAL_172) {
      const cat = classifyMomaModel(id)
      counts[cat] = (counts[cat] ?? 0) + 1
      expect(cat === 'chat', id).toBe(isMomaChatCandidate(id))
    }
    expect(counts).toEqual({ chat: 122, vision: 10, image: 4, tts: 4, asr: 9, embedding: 4, rerank: 1, safety: 2, other: 16 })
  })
  it('关键成员分类正确（九天对话/安全、视频与翻译落其他、VL 落视觉）', () => {
    expect(classifyMomaModel('jiutian-236b-256k-chat')).toBe('chat')
    expect(classifyMomaModel('JIUTIAN-75B-32K')).toBe('chat')
    expect(classifyMomaModel('jiutian-safe-40b')).toBe('safety')
    expect(classifyMomaModel('Qwen3Guard-Gen-8B')).toBe('safety')
    expect(classifyMomaModel('qwen3-vl-32b-instruct')).toBe('vision')
    expect(classifyMomaModel('qwen/qwen-image-3.0')).toBe('image')
    expect(classifyMomaModel('CosyVoice')).toBe('tts')
    expect(classifyMomaModel('SenseVoice')).toBe('asr')
    expect(classifyMomaModel('qwen/text-embedding-v4')).toBe('embedding')
    expect(classifyMomaModel('bge-reranker-v2-m3')).toBe('rerank')
    expect(classifyMomaModel('doubao-seedance-2.5')).toBe('other')
    expect(classifyMomaModel('qwen/qwen-mt-plus')).toBe('other')
    expect(classifyMomaModel('qwen/qwen3.5-omni-plus')).toBe('other')
  })
  it('自动轮测只许九天自营对话模型（合作与非对话一律不进批量）', () => {
    const auto = REAL_172.filter(isMomaAutoTestable)
    expect(auto).toEqual(expect.arrayContaining(['JIUTIAN-75B-32K', 'JIUTIAN-75B-8K-Chat', 'jiutian-ict-35b-256k', 'jiutian-236b-256k-chat', 'jiutian-35b-256k-chat']))
    expect(auto.length).toBe(5)
    expect(isMomaAutoTestable('jiutian-safe-40b')).toBe(false)
    expect(isMomaAutoTestable('jscm/deepseek-v4-flash')).toBe(false)
    expect(isMomaAutoTestable('deepseek-v3')).toBe(false)
  })
  it('分组：组序固定、空组省略、对话组已测按 ms 升序在前未测在后、其他组按名称', () => {
    const ids = ['qwen3-vl-32b-instruct', 'deepseek-v3', 'JIUTIAN-75B-8K-Chat', 'CosyVoice', 'jiutian-35b-256k-chat', 'bge-m3']
    const tests = {
      'jiutian-35b-256k-chat': { ok: true, ms: 900, testedAt: 1 },
      'JIUTIAN-75B-8K-Chat': { ok: false, ms: 300, error: '模型不可用', testedAt: 1 },
    }
    const groups = groupMomaModels(ids, tests)
    expect(groups.map(g => g.category)).toEqual(['chat', 'vision', 'tts', 'embedding'])
    expect(groups[0].ids).toEqual(['JIUTIAN-75B-8K-Chat', 'jiutian-35b-256k-chat', 'deepseek-v3'])
    expect(groups[1].ids).toEqual(['qwen3-vl-32b-instruct'])
  })
  it('实测缓存：逐条落盘可回读，按账户隔离，换 Key 指纹后旧结果作废', () => {
    saveMomaModelTest(acct, 'jiutian-35b-256k-chat', { ok: true, ms: 1234, testedAt: 100 })
    saveMomaModelTest(acct, 'JIUTIAN-75B-32K', { ok: false, ms: 800, error: 'The requested model is not available on this endpoint.', testedAt: 101 })
    const loaded = loadMomaModelTests(acct)
    expect(loaded['jiutian-35b-256k-chat']).toEqual({ ok: true, ms: 1234, testedAt: 100 })
    expect(loaded['JIUTIAN-75B-32K'].ok).toBe(false)
    expect(loaded['JIUTIAN-75B-32K'].error).toContain('not available')
    expect(loadMomaModelTests({ ...acct, id: 'other' })).toEqual({})
    expect(loadMomaModelTests({ ...acct, keyFingerprint: 'fp2' })).toEqual({})
  })
  it('只显示免费通道：默认开，存 0 后关，开/关往返一致', () => {
    expect(loadMomaFreeOnly()).toBe(true)
    saveMomaFreeOnly(false)
    expect(loadMomaFreeOnly()).toBe(false)
    saveMomaFreeOnly(true)
    expect(loadMomaFreeOnly()).toBe(true)
  })
})
