import { describe, it, expect } from 'vitest'
import {
  AGENT_REGISTRY, agentDef, buildCliInvocation, defaultAgentSettings,
  agentAvailability, quotaGate, capCheck, buildShellEnv, parseDelegation,
  pickStartable, isHeavyTask, parseCliUsage, summarizeLedger, ledgerSpentSince,
  loadAgentSettings, saveAgentSettings, markAgentVerified, loginStateText,
  multiAccountCapable, normalizeAccountEntries, entryEnvPairs, loginCommandFor, nativeEntryId,
  entryDisplayName, renameAccountEntry, setEntryIdentity,
  type AgentSettings, type AgentLedgerEntry,
} from './agents'
import type { Account } from './types'

const acct = (id: string, providerId: string, extra: Partial<Account> = {}): Account => ({
  id, providerId, label: `账户-${id}`, mode: 'api', encryptedKey: 'cipher-x',
  createdAt: '2026-01-01', updatedAt: '2026-01-01', ...extra,
})

const settings = (patch: Partial<AgentSettings> = {}): AgentSettings => ({
  ...defaultAgentSettings(), ...patch,
})

const det = (id: string, installed = true) => ({ id, installed, via: installed ? 'cli' : '', path: '' })

describe('注册表分类与资格', () => {
  it('两类齐全：账号型 5 家、空壳型 5 家', () => {
    expect(AGENT_REGISTRY.filter(a => a.kind === 'account').map(a => a.id))
      .toEqual(['dsh', 'antigravity', 'codex-desktop', 'workbuddy-app', 'qoder-app'])
    expect(AGENT_REGISTRY.filter(a => a.kind === 'shell').map(a => a.id))
      .toEqual(['pi', 'opencode', 'qwen-code', 'kimi-code', 'claude-code'])
  })
  it('资格如实标注：Claude Code 免费不含、Codex 免费限量、Antigravity 模型下线提示', () => {
    expect(agentDef('claude-code')?.qualification).toContain('免费档不含')
    expect(agentDef('codex-desktop')?.qualification).toContain('免费档可用')
    expect(agentDef('antigravity')?.qualification).toContain('2026-11-30')
  })
  it('CLI 派活命令按官方约定', () => {
    expect(buildCliInvocation('pi', '干活')).toEqual({ command: 'pi', args: ['-p', '干活'] })
    expect(buildCliInvocation('opencode', '干活')).toEqual({ command: 'opencode', args: ['run', '干活'] })
    expect(buildCliInvocation('qwen-code', '干活')).toEqual({ command: 'qwen', args: ['-p', '干活'] })
    expect(buildCliInvocation('claude-code', '干活')).toEqual({ command: 'claude', args: ['-p', '干活'] })
    expect(buildCliInvocation('kimi-code', '干活')?.command).toBe('kimi')
    // v0.1.509：DSH 有官方 headless 通道（形式在 agentTier.test.ts 详测）；真无调用形式的是纯桌面型
    expect(buildCliInvocation('dsh', '干活')).toEqual({ command: 'dsh', args: ['--profile', 'headless', '--json', '干活'] })
    expect(buildCliInvocation('workbuddy-app', '干活')).toBeNull()
  })
})

describe('可用性判定', () => {
  const pi = agentDef('pi')!
  const cc = agentDef('claude-code')!
  const dsh = agentDef('dsh')!
  it('未安装 → not-installed 带安装指引', () => {
    const r = agentAvailability(pi, det('pi', false), settings(), [])
    expect(r.state).toBe('not-installed')
    expect(r.reason).toContain('npm install')
  })
  it('已装未启用 → disabled', () => {
    expect(agentAvailability(pi, det('pi'), settings(), []).state).toBe('disabled')
  })
  it('空壳型未绑定 → blocked；Claude Code 写明免费档不含', () => {
    const s = settings({ enabled: { 'claude-code': true, pi: true } })
    const r = agentAvailability(cc, det('claude-code'), s, [])
    expect(r.state).toBe('blocked')
    expect(r.reason).toContain('免费档不含')
    expect(agentAvailability(pi, det('pi'), s, []).state).toBe('blocked')
  })
  it('绑定已删除账户 → blocked；绑定免费路线 → ready', () => {
    const s = settings({
      enabled: { pi: true },
      bindings: { pi: { kind: 'account', accountId: 'gone' } },
    })
    expect(agentAvailability(pi, det('pi'), s, []).state).toBe('blocked')
    const s2 = settings({ enabled: { pi: true }, bindings: { pi: { kind: 'free' } } })
    expect(agentAvailability(pi, det('pi'), s2, []).state).toBe('ready')
  })
  it('账号型启用即 ready（免 Key）', () => {
    const s = settings({ enabled: { dsh: true } })
    const r = agentAvailability(dsh, det('dsh'), s, [])
    expect(r.state).toBe('ready')
    expect(r.reason).toContain('免 Key')
  })
})

describe('额度护栏', () => {
  const pi = agentDef('pi')!
  const accounts = [acct('a1', 'deepseek')]
  it('只走免费 + 绑定付费账户 → 必须人工放行', () => {
    const s = settings()
    const g = quotaGate(s, pi, { kind: 'account', accountId: 'a1' }, accounts)
    expect(g.decision).toBe('approval')
    if (g.decision === 'approval') expect(g.reason).toContain('账户-a1')
  })
  it('免费路线 / 自身登录 / 关掉只走免费 → 直过', () => {
    const s = settings()
    expect(quotaGate(s, pi, { kind: 'free' }, accounts).decision).toBe('pass')
    expect(quotaGate(s, pi, { kind: 'self' }, accounts).decision).toBe('pass')
    const s2 = settings({ quota: { ...s.quota, freeOnly: false } })
    expect(quotaGate(s2, pi, { kind: 'account', accountId: 'a1' }, accounts).decision).toBe('pass')
  })
  it('上限：stop 挡、notify 只提醒、未超 ok', () => {
    const s = settings({ quota: { freeOnly: true, perSessionCap: 10, dailyCap: 20, overLimit: 'stop' } })
    expect(capCheck(s, 5, 5)).toBe('ok')
    expect(capCheck(s, 20, 0)).toBe('over-stop')
    expect(capCheck(s, 0, 10)).toBe('over-stop')
    const s2 = settings({ quota: { ...s.quota, overLimit: 'notify' } })
    expect(capCheck(s2, 25, 0)).toBe('over-notify')
  })
})

describe('环境变量注入', () => {
  it('免费路线给 Zen 端点，不带任何用户 Key', () => {
    const env = buildShellEnv({ kind: 'free' }, undefined, undefined)
    expect(env.OPENAI_BASE_URL).toContain('opencode.ai')
    expect(env.OPENAI_API_KEY).toBe('public')
  })
  it('自身登录不注入', () => {
    expect(buildShellEnv({ kind: 'self' }, undefined, undefined)).toEqual({})
  })
  it('OpenAI 兼容账户注入 OPENAI_*，Anthropic 账户注入 ANTHROPIC_*（去掉 /v1）', () => {
    const ds = acct('a1', 'deepseek')
    const env = buildShellEnv({ kind: 'account', accountId: 'a1' }, ds, 'sk-test-123')
    expect(env.OPENAI_API_KEY).toBe('sk-test-123')
    expect(env.OPENAI_BASE_URL).toBe('https://api.deepseek.com/v1')
    const an = acct('a2', 'anthropic')
    const env2 = buildShellEnv({ kind: 'account', accountId: 'a2' }, an, 'sk-ant-1')
    expect(env2.ANTHROPIC_API_KEY).toBe('sk-ant-1')
    expect(env2.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com')
    expect(env2.OPENAI_API_KEY).toBeUndefined()
  })
})

describe('# 委派解析', () => {
  it('#名称 / #id 命中并剥离前缀', () => {
    expect(parseDelegation('#DSH 修一下构建')).toMatchObject({ agentId: 'dsh', taskText: '修一下构建' })
    expect(parseDelegation('#claude-code 写个脚本')).toMatchObject({ agentId: 'claude-code', taskText: '写个脚本' })
    expect(parseDelegation('#Pi 干活')).toMatchObject({ agentId: 'pi', taskText: '干活' })
  })
  it('带空格的名称（Codex 桌面端）按最长前缀命中', () => {
    expect(parseDelegation('#Codex 桌面端 看一下这个报错')).toMatchObject({ agentId: 'codex-desktop', taskText: '看一下这个报错' })
    expect(parseDelegation('#Claude Code 写脚本')).toMatchObject({ agentId: 'claude-code', taskText: '写脚本' })
  })
  it('未知 # 标记如实回报 unknownToken；无 # 时 agentId 为空', () => {
    const r = parseDelegation('#不存在 干活')
    expect(r.agentId).toBeNull()
    expect(r.unknownToken).toBe('不存在')
    expect(parseDelegation('普通任务')).toMatchObject({ agentId: null, unknownToken: null })
  })
})

describe('调度：并行上限与重活锁', () => {
  const T = (id: string, heavy: boolean, status = 'queued') => ({ id, heavy, status })
  it('并行上限 3：4 个轻活只放 3 个', () => {
    expect(pickStartable([T('1', false), T('2', false), T('3', false), T('4', false)], 3)).toEqual(['1', '2', '3'])
  })
  it('已有 2 个在跑，只补 1 个', () => {
    const tasks = [T('r1', false, 'running'), T('r2', false, 'running'), T('q1', false), T('q2', false)]
    expect(pickStartable(tasks, 3)).toEqual(['q1'])
  })
  it('重活锁：一个重活在跑，第二个重活排队，轻活照常', () => {
    const tasks = [T('h1', true, 'running'), T('h2', true), T('l1', false)]
    expect(pickStartable(tasks, 3)).toEqual(['l1'])
  })
  it('两个重活排队时只放一个', () => {
    expect(pickStartable([T('h1', true), T('h2', true), T('l1', false)], 3)).toEqual(['h1', 'l1'])
  })
  it('isHeavyTask 关键词与手动标', () => {
    expect(isHeavyTask('帮我跑一下构建')).toBe(true)
    expect(isHeavyTask('run the tests please')).toBe(true)
    expect(isHeavyTask('写一首诗')).toBe(false)
    expect(isHeavyTask('写一首诗', true)).toBe(true)
    expect(isHeavyTask('帮我跑一下构建', false)).toBe(false)
  })
})

describe('v0.1.511（②）：已验证标记与登录态文案', () => {
  it('markAgentVerified 幂等：首次时间保留、再标记不覆盖', () => {
    const s0 = defaultAgentSettings()
    const s1 = markAgentVerified(s0, 'antigravity', 111)
    expect(s1.verifiedAgents).toEqual({ antigravity: 111 })
    const s2 = markAgentVerified(s1, 'antigravity', 222)
    expect(s2.verifiedAgents).toEqual({ antigravity: 111 })
    expect(markAgentVerified(s1, 'dsh', 333).verifiedAgents).toEqual({ antigravity: 111, dsh: 333 })
  })
  it('标记随 settings 存读往返不丢（510 落盘口径）', () => {
    const s = markAgentVerified(defaultAgentSettings(), 'antigravity', 999)
    saveAgentSettings(s)
    const back = loadAgentSettings()
    expect(back.verifiedAgents?.antigravity).toBe(999)
  })
  it('loginStateText：钥匙串口径不再说「读不到」、已验证优先', () => {
    expect(loginStateText('yes')).toBe('已登录')
    expect(loginStateText('no')).toBe('未登录')
    expect(loginStateText('unknown', { probeMissing: 'unknown' })).toBe('钥匙串保管，魔方读不到')
    expect(loginStateText('unknown', { probeMissing: 'unknown' })).not.toBe('读不到')
    expect(loginStateText('unknown', { probeMissing: 'unknown', verifiedAt: 5 })).toBe('已验证（派活成功）')
    expect(loginStateText(undefined)).toBe('检测中…')
  })
  it('DSH 登录指引走 dsh web 且文案提到浏览器登录页（①）', () => {
    const dsh = agentDef('dsh')!
    expect(dsh.loginCommandNative).toBe('dsh web')
    expect(dsh.loginGuide).toContain('浏览器')
    expect(dsh.loginGuide).toContain('重新检测')
  })
})

describe('v0.1.512（④）：Antigravity HOME 型多条目', () => {
  it('Antigravity 开多条目且注册表不再有「仅单账户」限制', () => {
    const agy = agentDef('antigravity')!
    expect(agy.credIsolation).toBe('home')
    expect(multiAccountCapable(agy)).toBe(true)
    expect(agy.multiAccountNote).toBeUndefined()
    expect(agentDef('dsh')!.credIsolation).toBe('env')
    expect(agentDef('codex-desktop')!.credIsolation).toBe('env')
    expect(multiAccountCapable(agentDef('workbuddy-app')!)).toBe(false)
  })
  it('条目归一化补 Antigravity 原生条目（与 DSH/Codex 同口径）', () => {
    const entries = normalizeAccountEntries([])
    const agy = entries.find(e => e.id === nativeEntryId('antigravity'))
    expect(agy).toMatchObject({ agentId: 'antigravity', credDir: 'native', enabled: true })
  })
  it('entryEnvPairs：HOME 型注入 HOME、env 型注入凭据变量、原生/无目录不注入', () => {
    const agy = agentDef('antigravity')!
    const dsh = agentDef('dsh')!
    const ent = (agentId: string, credDir: 'native' | 'isolated') => ({
      id: 'e1', agentId, label: '条目', credDir, enabled: true, createdAt: 1,
    })
    expect(entryEnvPairs(agy, ent('antigravity', 'isolated'), '/home/u/.ai-credit-manager/agents/creds/antigravity/e1'))
      .toEqual([['HOME', '/home/u/.ai-credit-manager/agents/creds/antigravity/e1']])
    expect(entryEnvPairs(dsh, ent('dsh', 'isolated'), '/x/dsh/e1')).toEqual([['DSH_HOME', '/x/dsh/e1']])
    expect(entryEnvPairs(agy, ent('antigravity', 'native'), '/x')).toEqual([])
    expect(entryEnvPairs(agy, ent('antigravity', 'isolated'), '')).toEqual([])
  })
  it('隔离条目登录命令：Antigravity 走 HOME={dir} agy', () => {
    const agy = agentDef('antigravity')!
    const ent = (credDir: 'native' | 'isolated') => ({
      id: 'e2', agentId: 'antigravity', label: '条目', credDir, enabled: true, createdAt: 1,
    })
    expect(loginCommandFor(agy, ent('isolated'), '/dir/agy/e2')).toBe('HOME=/dir/agy/e2 agy')
    expect(loginCommandFor(agy, ent('native'), '')).toBe('agy')
  })
})

describe('用量解析与账本汇总', () => {
  it('Claude Code JSON 输出解析 usage', () => {
    const out = '前置输出\n{"type":"result","usage":{"input_tokens":1200,"output_tokens":300},"total_cost_usd":0.02}'
    expect(parseCliUsage(out)).toEqual({ inputTokens: 1200, outputTokens: 300, costUsd: 0.02 })
    expect(parseCliUsage('普通文本没有 JSON')).toBeNull()
  })
  it('汇总：账号型只计任务数不计金额；空壳型按账户汇总', () => {
    const entries: AgentLedgerEntry[] = [
      { id: '1', taskId: 't1', agentId: 'dsh', agentName: 'DSH', kind: 'account', startedAt: 100, endedAt: 200, durationMs: 1000, status: 'manual', costYuan: null },
      { id: '2', taskId: 't2', agentId: 'pi', agentName: 'Pi', kind: 'shell', accountId: 'a1', accountLabel: '账户-a1', startedAt: 100, endedAt: 300, durationMs: 2000, status: 'done', costYuan: 0.5 },
      { id: '3', taskId: 't3', agentId: 'pi', agentName: 'Pi', kind: 'shell', accountId: 'a1', accountLabel: '账户-a1', startedAt: 100, endedAt: 300, durationMs: 500, status: 'done', costYuan: null },
    ]
    const s = summarizeLedger(entries)
    expect(s.totalTasks).toBe(3)
    expect(s.totalCostYuan).toBeCloseTo(0.5)
    expect(s.accountKindAgents).toEqual([{ agentId: 'dsh', agentName: 'DSH', tasks: 1, durationMs: 1000 }])
    expect(s.byAccount).toEqual([{ accountId: 'a1', accountLabel: '账户-a1', tasks: 2, costYuan: 0.5, costUsd: 0, tokens: 0 }])
    expect(ledgerSpentSince(entries, 50)).toBeCloseTo(0.5)
    expect(ledgerSpentSince(entries, 1000)).toBe(0)
  })
})

describe('v0.1.515：条目改名与身份', () => {
  it('entryDisplayName：没改名回落默认名、改名用新名、纯空白名回落', () => {
    const s = defaultAgentSettings()
    const e = s.accounts.find(x => x.agentId === 'antigravity')!
    expect(entryDisplayName(e)).toBe('默认（现有登录）')
    expect(entryDisplayName({ ...e, customLabel: '主号' })).toBe('主号')
    expect(entryDisplayName({ ...e, customLabel: '  ' })).toBe('默认（现有登录）')
  })
  it('renameAccountEntry：改名只动目标条目、id 与凭据目录不变；清空回落默认名；没变化返回原引用', () => {
    const s0 = defaultAgentSettings()
    const target = s0.accounts.find(x => x.agentId === 'dsh')!
    const s1 = renameAccountEntry(s0, target.id, '  小号  ')
    const renamed = s1.accounts.find(x => x.id === target.id)!
    expect(renamed.customLabel).toBe('小号')
    expect(renamed.id).toBe(target.id)
    expect(renamed.credDir).toBe(target.credDir)
    expect(entryDisplayName(renamed)).toBe('小号')
    expect(s1.accounts.filter(x => x.id !== target.id)).toEqual(s0.accounts.filter(x => x.id !== target.id))
    const s2 = renameAccountEntry(s1, target.id, '')
    expect(entryDisplayName(s2.accounts.find(x => x.id === target.id)!)).toBe('默认（现有登录）')
    expect(renameAccountEntry(s0, target.id, '')).toBe(s0)
  })
  it('改名与身份随 settings 存读往返不丢', () => {
    const s0 = defaultAgentSettings()
    const target = s0.accounts.find(x => x.agentId === 'codex-desktop')!
    const s1 = setEntryIdentity(renameAccountEntry(s0, target.id, '工作号'), target.id, 'x998***@gmail.com')
    saveAgentSettings(s1)
    const back = loadAgentSettings()
    const e = back.accounts.find(x => x.id === target.id)!
    expect(entryDisplayName(e)).toBe('工作号')
    expect(e.identity).toBe('x998***@gmail.com')
    expect(setEntryIdentity(s1, target.id, 'x998***@gmail.com')).toBe(s1)
  })
})

describe('v0.1.515：parseCliUsage 认 agy 嵌套 usage', () => {
  it('result.usage（全程总量、在最后一行）优先命中', () => {
    const out = [
      '{"event":"step_update","step_update":{"step_index":8,"step_type":"agent_response","usage":{"input_tokens":2768,"output_tokens":810,"total_tokens":3578}}}',
      '{"event":"result","result":{"status":"SUCCESS","response":"x","usage":{"input_tokens":20297,"output_tokens":1408,"total_tokens":21705}}}',
    ].join('\n')
    expect(parseCliUsage(out)).toEqual({ inputTokens: 20297, outputTokens: 1408, costUsd: 0 })
  })
  it('只有 step_update.usage 时也能吃到', () => {
    const out = '{"event":"step_update","step_update":{"step_index":0,"usage":{"input_tokens":100,"output_tokens":20}}}'
    expect(parseCliUsage(out)).toEqual({ inputTokens: 100, outputTokens: 20, costUsd: 0 })
  })
})
