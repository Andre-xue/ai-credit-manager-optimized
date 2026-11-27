import { describe, it, expect } from 'vitest'
import {
  classifyRelayFailure, pickRelayCandidate, buildRelayContextPack, relayTitle, relayPackSummary,
  buildMasterPrompt, parseMasterPlan, resolvePlanAgent, buildReviewPrompt, parseReviewVerdict,
  RELAY_PACK_MAX_OUTPUT,
} from './agentRelay'
import { AGENT_REGISTRY, agentDef, type AgentAvailability } from './agents'

const ready: AgentAvailability = { state: 'ready', reason: 'ok' }
const availMap = (m: Record<string, AgentAvailability>) => (id: string) => m[id] ?? null

describe('接力触发：失败分类', () => {
  it('额度类输出 → quota', () => {
    expect(classifyRelayFailure('Error: quota exceeded for this account', 1)).toEqual({ kind: 'quota', label: '额度耗尽' })
    expect(classifyRelayFailure('FreeUsageLimitError — Free usage limit reached', 1)?.kind).toBe('quota')
    expect(classifyRelayFailure('接口返回 402：plan_limit exceeded', 1)?.kind).toBe('quota')
  })
  it('限流类输出 → rate', () => {
    expect(classifyRelayFailure('HTTP 429 too many requests', 1)).toEqual({ kind: 'rate', label: '触发限流' })
    expect(classifyRelayFailure('rate_limit_error: slow down', 1)?.kind).toBe('rate')
  })
  it('其他失败不自动接力（auth / 普通报错 / 成功退出）', () => {
    expect(classifyRelayFailure('invalid api key', 1)).toBeNull()
    expect(classifyRelayFailure('SyntaxError: unexpected token', 1)).toBeNull()
    expect(classifyRelayFailure('全部完成', 0)).toBeNull()
    expect(classifyRelayFailure('', null)).toBeNull()
  })
  it('model_not_found 不被误判成额度（464 口径）', () => {
    expect(classifyRelayFailure('400 model_not_found: quota model missing', 1)).toBeNull()
  })
})

describe('接力候选筛选', () => {
  const chain = ['pi', 'opencode', 'claude-code', 'dsh']
  it('按链顺序取第一个 ready 的，前面被跳过的写明原因', () => {
    const pick = pickRelayCandidate(chain, [], AGENT_REGISTRY, availMap({
      pi: { state: 'disabled', reason: '已安装，未启用（到设置 · Agent 管理打开）' },
      opencode: ready,
    }))
    expect(pick.candidateId).toBe('opencode')
    expect(pick.skipped).toEqual([{ agentId: 'pi', agentName: 'Pi', reason: '已安装，未启用（到设置 · Agent 管理打开）' }])
  })
  it('已在接力链中执行过的跳过（防来回换）', () => {
    const pick = pickRelayCandidate(chain, ['pi', 'opencode'], AGENT_REGISTRY, availMap({ pi: ready, opencode: ready, 'claude-code': ready }))
    expect(pick.candidateId).toBe('claude-code')
    expect(pick.skipped.map(s => s.agentId)).toEqual(['pi', 'opencode'])
    expect(pick.skipped[0].reason).toContain('已在本接力链中执行过')
  })
  it('无 Key 绑定 / 未安装的原因齐全', () => {
    const pick = pickRelayCandidate(['pi', 'dsh'], [], AGENT_REGISTRY, availMap({
      pi: { state: 'blocked', reason: '尚未绑定 Key：请在设置里绑定账户、选免费路线或使用自身登录' },
      dsh: { state: 'not-installed', reason: '到 deepseek.com/download 下载' },
    }))
    expect(pick.candidateId).toBeNull()
    expect(pick.skipped).toHaveLength(2)
    expect(pick.skipped[0].reason).toContain('尚未绑定 Key')
    expect(pick.skipped[1].reason).toContain('下载')
  })
  it('链走完 → candidateId 为 null 且 skipped 覆盖全链', () => {
    const pick = pickRelayCandidate(['pi'], ['pi'], AGENT_REGISTRY, availMap({ pi: ready }))
    expect(pick.candidateId).toBeNull()
    expect(pick.skipped).toHaveLength(1)
  })
  it('空链 → null 且 skipped 为空（调用方补链为空的说明）', () => {
    const pick = pickRelayCandidate([], [], AGENT_REGISTRY, availMap({}))
    expect(pick.candidateId).toBeNull()
    expect(pick.skipped).toEqual([])
  })
})

describe('上下文打包', () => {
  const base = {
    originalText: '把 src 的日志改成英文', fromAgentName: 'Pi', reason: '额度耗尽',
    workdir: '/work/proj', output: '第一行\n最后一行', changedFiles: ['/work/proj/a.ts'],
    lastStatus: '失败：进程退出码 1',
  }
  it('包含原任务 / 工作目录 / 原因 / 最后状态 / 文件清单 / 输出', () => {
    const pack = buildRelayContextPack(base)
    expect(pack).toContain('把 src 的日志改成英文')
    expect(pack).toContain('/work/proj')
    expect(pack).toContain('额度耗尽')
    expect(pack).toContain('进程退出码 1')
    expect(pack).toContain('- /work/proj/a.ts')
    expect(pack).toContain('最后一行')
    expect(pack).toContain('不要从零重来')
  })
  it('长输出只保留末尾并注明截断与总字数', () => {
    const big = 'x'.repeat(RELAY_PACK_MAX_OUTPUT + 500)
    const pack = buildRelayContextPack({ ...base, output: big }, 1000)
    expect(pack).toContain(`原输出共 ${big.length} 字，仅保留末尾 1000 字`)
    expect(pack).not.toContain('x'.repeat(1001))
  })
  it('文件清单超上限注明其余略', () => {
    const files = Array.from({ length: 60 }, (_, i) => `/w/f${i}.ts`)
    const pack = buildRelayContextPack({ ...base, changedFiles: files })
    expect(pack).toContain('共 60 个')
    expect(pack).toContain('其余 10 个略')
  })
  it('标题带（续），已有（续）不叠加', () => {
    expect(relayTitle(base)).toBe('把 src 的日志改成英文（续）')
    expect(relayTitle({ ...base, originalTitle: '改日志（续）' })).toBe('改日志（续）')
  })
  it('确认卡摘要列出将带过去的内容', () => {
    expect(relayPackSummary(base)).toContain('已改文件清单（1 个）')
    expect(relayPackSummary({ ...base, output: '', changedFiles: [] })).not.toContain('输出摘要')
  })
})

describe('主控拆活', () => {
  it('提示词要求只输出 JSON 并给出格式', () => {
    const p = buildMasterPrompt('做一个落地页', ['Pi', 'OpenCode'])
    expect(p).toContain('做一个落地页')
    expect(p).toContain('"tasks"')
    expect(p).toContain('Pi')
  })
  it('解析纯 JSON / 围栏 JSON / 带前后杂字', () => {
    const good = '{"tasks":[{"title":"写文案","task":"写首页文案","agent":"Pi"},{"title":"跑构建","task":"npm run build 验证","heavy":true}]}'
    const items = parseMasterPlan(good)
    expect(items).toHaveLength(2)
    expect(items![0]).toMatchObject({ title: '写文案', agentId: 'Pi' })
    expect(items![1].heavy).toBe(true)
    expect(parseMasterPlan('好的，我来拆：\n```json\n' + good + '\n```\n以上')).toHaveLength(2)
    expect(parseMasterPlan('前言 ' + good + ' 后记')).toHaveLength(2)
  })
  it('类型建议（账号登录型/空壳型）映射为 agentKind', () => {
    const items = parseMasterPlan('{"tasks":[{"title":"t","task":"x","agent":"空壳型"}]}')
    expect(items![0].agentKind).toBe('shell')
    expect(items![0].agentId).toBeUndefined()
  })
  it('解析失败回落：非 JSON / 空清单 / 缺字段 → null', () => {
    expect(parseMasterPlan('我拆不了')).toBeNull()
    expect(parseMasterPlan('{"tasks":[]}')).toBeNull()
    expect(parseMasterPlan('{"tasks":[{"title":"只有标题"}]}')).toBeNull()
    expect(parseMasterPlan('')).toBeNull()
  })
  it('子任务执行者解析：指定名优先、类型次之、无匹配为 null', () => {
    const readyAgents = [agentDef('pi')!, agentDef('dsh')!]
    expect(resolvePlanAgent({ title: 't', task: 'x', agentId: 'Pi' }, readyAgents)?.id).toBe('pi')
    expect(resolvePlanAgent({ title: 't', task: 'x', agentKind: 'account' }, readyAgents)?.id).toBe('dsh')
    expect(resolvePlanAgent({ title: 't', task: 'x', agentId: '不存在的' }, readyAgents)).toBeNull()
    expect(resolvePlanAgent({ title: 't', task: 'x' }, readyAgents)).toBeNull()
  })
})

describe('交叉审查', () => {
  it('提示词含目标/输出/文件并要求结论 JSON', () => {
    const p = buildReviewPrompt({ taskText: '改日志', agentName: 'Pi', output: 'done', changedFiles: ['/w/a.ts'] })
    expect(p).toContain('改日志')
    expect(p).toContain('/w/a.ts')
    expect(p).toContain('"verdict"')
  })
  it('解析 JSON 结论（pass / issues）', () => {
    expect(parseReviewVerdict('看完了\n{"verdict":"pass","points":"目标达成"}')).toEqual({ verdict: 'pass', points: '目标达成' })
    expect(parseReviewVerdict('{"verdict":"issues","points":"漏了测试"}')?.verdict).toBe('issues')
  })
  it('兜底认「审查结论：」字样；无结论 → null', () => {
    expect(parseReviewVerdict('复核完毕。\n审查结论：有问题，见要点')?.verdict).toBe('issues')
    expect(parseReviewVerdict('审查结论：通过')).toEqual({ verdict: 'pass', points: '审查结论：通过' })
    expect(parseReviewVerdict('随便说说没有结论')).toBeNull()
    expect(parseReviewVerdict('')).toBeNull()
  })
  it('用量 JSON（usage）不被误当审查结论', () => {
    expect(parseReviewVerdict('{"type":"result","usage":{"input_tokens":10},"total_cost_usd":0.01}')).toBeNull()
  })
})
