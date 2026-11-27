// Agent 工作台二期（v0.1.508）纯逻辑：接力（候选筛选 / 上下文打包 / 失败分类）、
// 主控拆活（提示词 / JSON 解析 / 执行者解析）、交叉审查（提示词 / 结论解析）。
// 全部纯函数，界面层负责取数与落状态；这里不碰 IO、不编造数据。
import { classifyChainError} from './freeChain'
import type { AgentAvailability, AgentDef} from './agents'

// ---------------- 接力触发：失败分类 ----------------

export interface RelayFailure { kind: 'quota' | 'rate'; label: string}

/**
* CLI 任务失败是否属于「额度耗尽 / 限流」类（可自动触发接力）。
* 复用免费链的错误分类口径（classifyChainError）：只看输出末尾一段 + 退出信息，
* 分到 quota / rate 才算；auth/model/network 等不自动接力（可手动换人）。
*/
export function classifyRelayFailure(outputTail: string, exitCode: number | null): RelayFailure | null {
const tail = (outputTail?? '').slice(-3000)
if (!tail.trim() && exitCode === 0) return null
const cls = classifyChainError(new Error(tail))
if (cls.kind === 'quota') return { kind: 'quota', label: '额度耗尽'}
if (cls.kind === 'rate') return { kind: 'rate', label: '触发限流'}
return null
}

// ---------------- 接力候选筛选 ----------------

export interface RelaySkip { agentId: string; agentName: string; reason: string}
export interface RelayPick {
candidateId: string | null
candidateName: string | null
skipped: RelaySkip[]
}

/**
* 按接力链顺序找下一个可用 Agent。
* 跳过：已在本接力链中执行过的、未安装、未启用、无资格 / 无 Key 绑定（用可用性判定的原话作原因）。
* 链为空或全被跳过 → candidateId 为 null，skipped 写明每个候选被跳过的原因（链为空时 skipped 为空，
* 由调用方补「接力链是空的」说明）。
*/
export function pickRelayCandidate(
chain: string[],
usedAgentIds: readonly string[],
registry: readonly AgentDef[],
availability: (agentId: string) => AgentAvailability | null,
): RelayPick {
const skipped: RelaySkip[] = []
const used = new Set(usedAgentIds)
for (const id of chain) {
const def = registry.find(a => a.id === id)
if (!def) { skipped.push({ agentId: id, agentName: id, reason: '接力链里的这个 Agent 已不在注册表中'}); continue}
if (used.has(id)) { skipped.push({ agentId: id, agentName: def.name, reason: '已在本接力链中执行过，跳过避免来回换'}); continue}
const avail = availability(id)
if (!avail) { skipped.push({ agentId: id, agentName: def.name, reason: '可用性未知（尚未检测）'}); continue}
if (avail.state!== 'ready') { skipped.push({ agentId: id, agentName: def.name, reason: avail.reason}); continue}
return { candidateId: id, candidateName: def.name, skipped}
}
return { candidateId: null, candidateName: null, skipped}
}

// ---------------- 上下文打包 ----------------

export interface RelayPackInput {
originalText: string
/** 展示用原标题（缺省用 originalText 首行截断） */
originalTitle?: string
fromAgentName: string
/** 中断原因（人话，如「额度耗尽」） */
reason: string
workdir: string
/** 原执行者输出（全文或末尾若干行，函数内再按上限截断） */
output: string
/** 已改动文件清单（来自保险箱记录的原路径） */
changedFiles: string[]
/** 原执行者最后状态（人话，如「失败：进程退出码 1」） */
lastStatus: string
}

export const RELAY_PACK_MAX_OUTPUT = 3000
export const RELAY_PACK_MAX_FILES = 50

/** 接棒任务标题：原标题 +「（续）」 */
export function relayTitle(input: Pick<RelayPackInput, 'originalText' | 'originalTitle'>): string {
const base = (input.originalTitle?? input.originalText).split('\n')[0].trim().slice(0, 60) || '任务'
return base.endsWith('（续）')? base: `${base}（续）`
}

/**
* 组装接棒任务文本：原任务 + 工作目录 + 输出摘要（保留末尾、截断注明）
* + 已改文件清单（截断注明）+ 原 Agent 最后状态。
*/
export function buildRelayContextPack(input: RelayPackInput, maxOutputChars: number = RELAY_PACK_MAX_OUTPUT): string {
const lines: string[] = []
lines.push(`【接力任务】你接手一个由 ${input.fromAgentName} 未能完成的任务，请在已有进展上续跑，不要从零重来。`)
lines.push('')
lines.push('原任务：')
lines.push(input.originalText)
lines.push('')
if (input.workdir) lines.push(`工作目录：${input.workdir}`)
lines.push(`中断原因：${input.reason}`)
lines.push(`原执行者（${input.fromAgentName}）最后状态：${input.lastStatus}`)
lines.push('')
if (input.changedFiles.length) {
const shown = input.changedFiles.slice(0, RELAY_PACK_MAX_FILES)
lines.push(`已改动的文件（共 ${input.changedFiles.length} 个，上一版已存入文件保险箱、可还原）：`)
for (const f of shown) lines.push(`- ${f}`)
if (input.changedFiles.length > shown.length) lines.push(`- ……其余 ${input.changedFiles.length - shown.length} 个略`)
lines.push('')
}
const out = input.output?? ''
if (out.trim()) {
lines.push('原执行者的输出摘要（末尾节选）：')
if (out.length > maxOutputChars) {
lines.push(`（注：原输出共 ${out.length} 字，仅保留末尾 ${maxOutputChars} 字）`)
lines.push(out.slice(-maxOutputChars))
} else {
lines.push(out)
}
lines.push('')
}
lines.push('请先查看工作目录现状与上述已改动文件，再继续完成原任务。')
return lines.join('\n')
}

/** 询问模式确认卡上的上下文包摘要（一句话口径） */
export function relayPackSummary(input: RelayPackInput): string {
const parts = ['原任务全文', `工作目录 ${input.workdir || '（未指定）'}`]
if (input.output?.trim()) parts.push('输出摘要')
if (input.changedFiles.length) parts.push(`已改文件清单（${input.changedFiles.length} 个）`)
return `将带过去：${parts.join('、')}`
}

// ---------------- 主控拆活 ----------------

export interface MasterPlanItem {
title: string
task: string
agentId?: string
agentKind?: 'account' | 'shell'
workdir?: string
heavy?: boolean
}

export const MASTER_PLAN_MAX_ITEMS = 8

/** 递给主控的结构化拆活提示：要求只返回 JSON 子任务清单 */
export function buildMasterPrompt(userText: string, agentNames: string[]): string {
return [
'你是一个任务主控。下面是用户交办的一个目标，请把它拆成可以分派给其他 Agent 执行的子任务清单。',
'',
`用户目标：${userText}`,
'',
`可分派的 Agent 有：${agentNames.join('、')}（也可以只写类型：账号登录型 / 空壳型）。`,
'只输出一个 JSON，不要任何解释文字，格式如下：',
'{"tasks":[{"title":"子任务标题","task":"给执行者的完整任务说明","agent":"建议的 Agent 名称或类型（可省略）","heavy":false}]}',
'要求：子任务之间尽量独立；构建、跑测试、打包、部署类标 "heavy": true；不要超过 8 条；如果这个目标不需要拆分，就只输出一条与目标相同的子任务。',
].join('\n')
}

/** 从主控输出中解析子任务清单（容忍 ```json 围栏与前后杂字）；解析不出返回 null（调用方回落整单派发） */
export function parseMasterPlan(output: string): MasterPlanItem[] | null {
if (!output) return null
let text = output
const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
if (fenced) text = fenced[1]
const start = text.indexOf('{')
const end = text.lastIndexOf('}')
if (start < 0 || end <= start) return null
let parsed: unknown
try { parsed = JSON.parse(text.slice(start, end + 1))} catch { return null}
const rawList = Array.isArray(parsed)
? parsed
: (parsed as { tasks?: unknown})?.tasks
if (!Array.isArray(rawList) || rawList.length === 0) return null
const items: MasterPlanItem[] = []
for (const raw of rawList.slice(0, MASTER_PLAN_MAX_ITEMS)) {
const r = raw as Record<string, unknown>
const title = typeof r.title === 'string'? r.title.trim(): ''
const task = typeof r.task === 'string'? r.task.trim(): ''
if (!title ||!task) return null
const item: MasterPlanItem = { title, task}
const agent = typeof r.agent === 'string'? r.agent.trim(): (typeof r.agentId === 'string'? r.agentId.trim(): '')
if (agent) {
if (agent.includes('账号')) item.agentKind = 'account'
else if (agent.includes('空壳')) item.agentKind = 'shell'
else item.agentId = agent
}
if (typeof r.workdir === 'string' && r.workdir.trim()) item.workdir = r.workdir.trim()
if (typeof r.heavy === 'boolean') item.heavy = r.heavy
items.push(item)
}
return items.length? items: null
}

/**
* 给子任务挑执行者：先按建议的 Agent（id 或名称，须在 ready 列表中），
* 再按建议类型找第一个 ready 的，都没有返回 null（调用方如实标无可用执行者）。
*/
export function resolvePlanAgent(
item: MasterPlanItem,
readyAgents: readonly AgentDef[],
): AgentDef | null {
if (item.agentId) {
const byIdOrName = readyAgents.find(a => a.id === item.agentId || a.name === item.agentId)
if (byIdOrName) return byIdOrName
}
if (item.agentKind) {
const byKind = readyAgents.find(a => a.kind === item.agentKind)
if (byKind) return byKind
}
return null
}

// ---------------- 交叉审查 ----------------

export interface ReviewPromptInput {
taskText: string
taskTitle?: string
agentName: string
output: string
changedFiles: string[]
}

export const REVIEW_MAX_OUTPUT = 2500

/** 递给审查者的提示：要求最后一行给结构化结论 JSON */
export function buildReviewPrompt(input: ReviewPromptInput): string {
const lines: string[] = []
lines.push('你是一个严格的审查者。下面是另一个 Agent 刚完成的一个任务，请复核它的产出是否真正完成了目标、有没有明显问题。')
lines.push('')
lines.push(`任务目标：${input.taskText}`)
lines.push(`执行者：${input.agentName}`)
if (input.changedFiles.length) {
lines.push(`改动文件（${input.changedFiles.length} 个）：`)
for (const f of input.changedFiles.slice(0, RELAY_PACK_MAX_FILES)) lines.push(`- ${f}`)
lines.push('')
}
const out = input.output?? ''
if (out.trim()) {
lines.push('执行者输出摘要（末尾节选）：')
lines.push(out.length > REVIEW_MAX_OUTPUT? `（注：仅保留末尾 ${REVIEW_MAX_OUTPUT} 字）\n${out.slice(-REVIEW_MAX_OUTPUT)}`: out)
lines.push('')
}
lines.push('只依据上面给到的信息审查，不要臆测没给出的内容。最后一行只输出一个 JSON，不要其他文字：')
lines.push('{"verdict":"pass","points":"一句话要点"} 或 {"verdict":"issues","points":"问题要点，最多三条"}')
return lines.join('\n')
}

export interface ReviewVerdict { verdict: 'pass' | 'issues'; points: string}

/** 解析审查结论：优先找带 verdict 的 JSON；其次认「审查结论：通过/有问题」字样；都没有返回 null */
export function parseReviewVerdict(output: string): ReviewVerdict | null {
if (!output) return null
const lines = output.split('\n').map(l => l.trim()).filter(Boolean)
for (let i = lines.length - 1; i >= 0; i--) {
const line = lines[i]
const start = line.indexOf('{')
const end = line.lastIndexOf('}')
if (start < 0 || end <= start) continue
try {
const j = JSON.parse(line.slice(start, end + 1)) as { verdict?: unknown; points?: unknown}
if (j.verdict === 'pass' || j.verdict === 'issues') {
return { verdict: j.verdict, points: typeof j.points === 'string'? j.points.slice(0, 300): ''}
}
} catch { /* 非 JSON 行继续找 */}
}
const tail = lines.slice(-5).join('\n')
if (/审查结论[:：]\s*有问题/.test(tail)) return { verdict: 'issues', points: tail.slice(0, 300)}
if (/审查结论[:：]\s*通过/.test(tail)) return { verdict: 'pass', points: tail.slice(0, 300)}
return null
}
