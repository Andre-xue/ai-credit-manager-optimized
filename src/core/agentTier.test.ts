// v0.1.509：派活分级（第一档无头直派 / 第三档粘贴兜底）+ 多账户条目 纯逻辑单测
import { describe, it, expect } from 'vitest'
import {
  agentDef, effectiveDispatch, dispatchTier, tierLabel, detectHasCli, detectHasApp,
  buildCliInvocation, parseSessionId, isHeadlessInterfaceFailure,
  normalizeAccountEntries, makeAccountEntry, pickEntryLru, agentAvailability,
  buildInstallCommand, loginCommandFor,
  defaultAgentSettings, type AgentDetectResult, type AgentAccountEntry,
} from './agents'

const det = (p: Partial<AgentDetectResult>): AgentDetectResult => ({ id: 'x', installed: true, via: '', path: '', ...p })

describe('档位判定：命令在 = 第一档，桌面 App 在不在不影响', () => {
  const dsh = agentDef('dsh')!
  it('命令 + 应用都在 → cli / 第一档', () => {
    const d = det({ cliPath: '/usr/local/bin/dsh', appPath: '/Applications/DeepSeek Harness.app' })
    expect(effectiveDispatch(dsh, d)).toBe('cli')
    expect(dispatchTier(dsh, d)).toBe(1)
    expect(tierLabel(1)).toBe('无头直派')
  })
  it('只有命令、没应用 → 仍是第一档', () => {
    expect(effectiveDispatch(dsh, det({ cliPath: '/usr/local/bin/dsh', appPath: '' }))).toBe('cli')
  })
  it('只有应用、没命令 → open / 第三档粘贴兜底', () => {
    const d = det({ cliPath: '', appPath: '/Applications/DeepSeek Harness.app' })
    expect(effectiveDispatch(dsh, d)).toBe('open')
    expect(dispatchTier(dsh, d)).toBe(3)
    expect(tierLabel(3)).toBe('粘贴送达（兜底）')
  })
  it('都没装 → null', () => {
    expect(effectiveDispatch(dsh, det({ installed: false }))).toBeNull()
    expect(dispatchTier(dsh, undefined)).toBeNull()
  })
  it('旧形状检测结果（只有 via）兜底成立', () => {
    expect(detectHasCli(det({ via: 'cli', path: '/bin/dsh' }))).toBe(true)
    expect(detectHasApp(det({ via: 'app', path: '/Applications/DSH.app' }))).toBe(true)
    expect(effectiveDispatch(dsh, det({ via: 'app', path: '/Applications/DSH.app' }))).toBe('open')
  })
  it('空壳型永远是 cli；无命令的桌面型（WorkBuddy）只有应用走 open', () => {
    expect(effectiveDispatch(agentDef('pi')!, det({ cliPath: '/bin/pi' }))).toBe('cli')
    expect(effectiveDispatch(agentDef('workbuddy-app')!, det({ appPath: '/Applications/WorkBuddy.app' }))).toBe('open')
  })
  it('Codex / Antigravity 同为第一档候选', () => {
    expect(effectiveDispatch(agentDef('codex-desktop')!, det({ cliPath: '/bin/codex', appPath: '' }))).toBe('cli')
    expect(effectiveDispatch(agentDef('antigravity')!, det({ cliPath: '/bin/agy', appPath: '' }))).toBe('cli')
  })
})

describe('无头调用形式（按官方文档核实，flags 在任务前）', () => {
  it('DSH headless --json；续跑带 --session-id', () => {
    expect(buildCliInvocation('dsh', '查金价')).toEqual({ command: 'dsh', args: ['headless', '--json', '查金价'] })
    expect(buildCliInvocation('dsh', '继续', 'session-abc')).toEqual({ command: 'dsh', args: ['headless', '--json', '--session-id', 'session-abc', '继续'] })
  })
  it('Codex exec --json；续跑 exec resume 带 thread id', () => {
    expect(buildCliInvocation('codex-desktop', '修 bug')).toEqual({ command: 'codex', args: ['exec', '--json', '--full-auto', '--skip-git-repo-check', '修 bug'] })
    expect(buildCliInvocation('codex-desktop', '继续', 'th-1')).toEqual({ command: 'codex', args: ['exec', 'resume', '--json', '--full-auto', '--skip-git-repo-check', 'th-1', '继续'] })
  })
  it('agy -p + stream-json；续跑带 --conversation', () => {
    expect(buildCliInvocation('antigravity', '写文档')).toEqual({ command: 'agy', args: ['--output-format', 'stream-json', '--print-timeout', '30m', '-p', '写文档'] })
    expect(buildCliInvocation('antigravity', '继续', 'conv-9')?.args).toContain('--conversation')
    expect(buildCliInvocation('antigravity', '继续', 'conv-9')?.args).toContain('conv-9')
  })
  it('空壳型调用不变', () => {
    expect(buildCliInvocation('pi', 'x')).toEqual({ command: 'pi', args: ['-p', 'x'] })
    expect(buildCliInvocation('workbuddy-app', 'x')).toBeNull()
  })
})

describe('会话 id 捕获', () => {
  it('Codex thread.started 的 thread_id', () => {
    const out = '{"type":"thread.started","thread_id":"th-42"}\n{"type":"turn.started"}'
    expect(parseSessionId(out)).toBe('th-42')
  })
  it('DSH 开场 session 事件的 sessionId', () => {
    expect(parseSessionId('{"type":"session","sessionId":"session-xyz"}')).toBe('session-xyz')
  })
  it('agy 结果里的 conversation_id', () => {
    expect(parseSessionId('{"type":"result","conversation_id":"conv-7","ok":true}')).toBe('conv-7')
  })
  it('纯文本 / 垃圾行 → null', () => {
    expect(parseSessionId('hello\n{"broken"')).toBeNull()
  })
})

describe('无头接口失败判定（只认参数/命令类错误，额度失败不降级）', () => {
  it('unknown option / unexpected argument / usage+exit2 → true', () => {
    expect(isHeadlessInterfaceFailure('error: unknown option --json', 1)).toBe(true)
    expect(isHeadlessInterfaceFailure('unexpected argument', 2)).toBe(true)
    expect(isHeadlessInterfaceFailure('Usage: dsh headless [options] <task>', 2)).toBe(true)
  })
  it('额度耗尽 / 未登录 / 一般失败 → false', () => {
    expect(isHeadlessInterfaceFailure('quota exceeded: weekly limit reached', 1)).toBe(false)
    expect(isHeadlessInterfaceFailure('authentication required', 1)).toBe(false)
    expect(isHeadlessInterfaceFailure('something crashed', 1)).toBe(false)
  })
})

describe('多账户条目', () => {
  it('归一化给 DSH / Codex 补原生默认条目，agy 与空壳型没有', () => {
    const entries = normalizeAccountEntries(undefined)
    expect(entries.some(e => e.agentId === 'dsh' && e.credDir === 'native' && e.enabled)).toBe(true)
    expect(entries.some(e => e.agentId === 'codex-desktop' && e.credDir === 'native')).toBe(true)
    expect(entries.some(e => e.agentId === 'antigravity')).toBe(false)
    expect(entries.some(e => e.agentId === 'pi')).toBe(false)
    // 幂等：再归一化不重复补
    expect(normalizeAccountEntries(entries).filter(e => e.credDir === 'native')).toHaveLength(2)
  })
  it('默认设置自带条目', () => {
    expect(defaultAgentSettings().accounts.length).toBe(2)
  })
  it('新建条目标签按 账号A / 账号B 递增，目录为隔离', () => {
    const base = normalizeAccountEntries(undefined)
    const a = makeAccountEntry('dsh', base, 1000)
    expect(a.label).toBe('账号A')
    expect(a.credDir).toBe('isolated')
    const b = makeAccountEntry('dsh', [...base, a], 2000)
    expect(b.label).toBe('账号B')
    expect(b.id).not.toBe(a.id)
  })
  it('最久未用：lastUsedAt 小者先；同值原生优先；停用跳过', () => {
    const mk = (p: Partial<AgentAccountEntry>): AgentAccountEntry => ({ id: 'e', agentId: 'dsh', label: 'x', credDir: 'isolated', enabled: true, createdAt: 0, ...p })
    const native = mk({ id: 'n', credDir: 'native', lastUsedAt: 5000 })
    const a = mk({ id: 'a', lastUsedAt: 1000 })
    const b = mk({ id: 'b', lastUsedAt: 9000 })
    expect(pickEntryLru([native, a, b])?.id).toBe('a')
    expect(pickEntryLru([native, b])?.id).toBe('n')
    expect(pickEntryLru([mk({ id: 'z', enabled: false, lastUsedAt: 1 }), b])?.id).toBe('b')
    expect(pickEntryLru([mk({ enabled: false })])).toBeUndefined()
  })
  it('可用性：多账户条目全停用 → blocked；有启用条目 → ready 且口径写明档位', () => {
    const st = defaultAgentSettings()
    st.enabled['dsh'] = true
    const d = det({ cliPath: '/bin/dsh', appPath: '' })
    const allOff = st.accounts.map(e => ({ ...e, enabled: false }))
    expect(agentAvailability(agentDef('dsh')!, d, st, [], allOff).state).toBe('blocked')
    const ok = agentAvailability(agentDef('dsh')!, d, st, [], st.accounts)
    expect(ok.state).toBe('ready')
    expect(ok.reason).toContain('无头直派')
  })
  it('检测口径：桌面应用在、命令不在 = 未安装（不算就绪，桌面应用仅兜底）', () => {
    const st = defaultAgentSettings()
    st.enabled['dsh'] = true
    const appOnly = agentAvailability(agentDef('dsh')!, det({ cliPath: '', appPath: '/Applications/DSH.app' }), st, [], st.accounts)
    expect(appOnly.state).toBe('not-installed')
    expect(appOnly.reason).toContain('命令未安装')
    expect(appOnly.reason).toContain('一键安装')
    // Codex / Antigravity 同口径；纯桌面型 WorkBuddy 不受影响（应用即就绪）
    const wb = agentAvailability(agentDef('workbuddy-app')!, det({ appPath: '/Applications/WorkBuddy.app' }), { ...st, enabled: { 'workbuddy-app': true } }, [])
    expect(wb.state).toBe('ready')
  })
})

describe('一键安装命令拼装（逐家与官方口径一致）', () => {
  it('npm 路线：DSH / Codex / Pi / OpenCode / Qwen / Claude Code', () => {
    expect(buildInstallCommand(agentDef('dsh')!)?.display).toBe('npm install -g @deepseek-ai/dsh')
    expect(buildInstallCommand(agentDef('codex-desktop')!)?.display).toBe('npm install -g @openai/codex')
    expect(buildInstallCommand(agentDef('pi')!)?.display).toBe('npm install -g @mariozechner/pi-coding-agent')
    expect(buildInstallCommand(agentDef('opencode')!)?.display).toBe('npm install -g opencode-ai')
    expect(buildInstallCommand(agentDef('qwen-code')!)?.display).toBe('npm install -g @qwen-code/qwen-code')
    expect(buildInstallCommand(agentDef('claude-code')!)?.display).toBe('npm install -g @anthropic-ai/claude-code')
    const c = buildInstallCommand(agentDef('dsh')!)
    expect(c?.command).toBe('npm')
    expect(c?.args).toEqual(['install', '-g', '@deepseek-ai/dsh'])
    expect(c?.needsNpm).toBe(true)
  })
  it('官方脚本路线：agy / Kimi（curl 官方 install.sh | bash，免 Node）', () => {
    const agy = buildInstallCommand(agentDef('antigravity')!)
    expect(agy?.display).toBe('curl -fsSL https://antigravity.google/cli/install.sh | bash')
    expect(agy?.command).toBe('bash')
    expect(agy?.needsNpm).toBe(false)
    expect(buildInstallCommand(agentDef('kimi-code')!)?.display).toBe('curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash')
  })
  it('纯桌面应用（WorkBuddy / Qoder）没有一键安装', () => {
    expect(buildInstallCommand(agentDef('workbuddy-app')!)).toBeNull()
    expect(buildInstallCommand(agentDef('qoder-app')!)).toBeNull()
  })
})

describe('去登录命令原文', () => {
  const native: AgentAccountEntry = { id: 'native-dsh', agentId: 'dsh', label: '默认', credDir: 'native', enabled: true, createdAt: 0 }
  const isolated: AgentAccountEntry = { id: 'ent-dsh-b', agentId: 'dsh', label: '账号A', credDir: 'isolated', enabled: true, createdAt: 1 }
  it('DSH：原生 dsh / 隔离带 DSH_HOME', () => {
    expect(loginCommandFor(agentDef('dsh')!, native, '/Users/x/.dsh')).toBe('dsh')
    expect(loginCommandFor(agentDef('dsh')!, isolated, '/Users/x/creds/ent-dsh-b')).toBe('DSH_HOME=/Users/x/creds/ent-dsh-b dsh')
  })
  it('Codex：原生 codex login / 隔离带 CODEX_HOME', () => {
    const cn: AgentAccountEntry = { ...native, agentId: 'codex-desktop' }
    const ci: AgentAccountEntry = { ...isolated, agentId: 'codex-desktop' }
    expect(loginCommandFor(agentDef('codex-desktop')!, cn, '/Users/x/.codex')).toBe('codex login')
    expect(loginCommandFor(agentDef('codex-desktop')!, ci, '/Users/x/creds/e1')).toBe('CODEX_HOME=/Users/x/creds/e1 codex login')
  })
})
