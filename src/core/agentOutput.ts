// 无头 CLI 事件流 → 人话输出解析（v0.1.511 ④）
// 背景：任务卡原来把 agy / dsh / codex 的 JSON 事件流原样滚动展示，用户看不懂、也难看。
// 这里把三家事件流解析成「进度行 + 最终答复 + 失败原因」，解析不了的行不糊到主区域、
// 只留在卡内「原始输出」折叠里。纯函数，可单测；非无头通道（空壳 CLI 的纯文本输出）
// 按普通文本行处理。会话 id 捕获仍走 agents.ts 的 parseSessionId，不在这里重复。
export interface ParsedCliOutput {
  /** 人话进度行（第 N 步 / 正在调用的工具 / 状态变化） */
  progress: string[]
  /** 完成后的最终答复全文（未完成时为空串） */
  finalText: string
  /** 失败原因原文（渲染层再走 humanizeAgentError 翻成人话；这里只负责抽出来） */
  errorText: string
}

const EMPTY: ParsedCliOutput = { progress: [], finalText: '', errorText: '' }

function clip(s: string, n = 90): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** dsh 失败原因藏在 reason.error.message（final / turn_end 事件） */
function dshErrorOf(o: Record<string, unknown>): string {
  const reason = asRecord(o.reason)
  const err = asRecord(reason?.error)
  return str(err?.message) || str(o.message)
}

function parseDsh(lines: string[]): ParsedCliOutput {
  const out: ParsedCliOutput = { progress: [], finalText: '', errorText: '' }
  const steps = new Set<number>()
  for (const line of lines) {
    const t = line.trim()
    if (!t.startsWith('{')) {
      // dsh 的 stderr 汇总行形如 `dsh: CODE: message`——当失败原因兜底
      const m = t.match(/^dsh: ([A-Z_]+): (.+)$/)
      if (m && !out.errorText) out.errorText = m[2]
      continue
    }
    let o: Record<string, unknown> | null = null
    try { o = asRecord(JSON.parse(t)) } catch { /* 非 JSON 归原始输出 */ }
    if (!o) continue
    if (o.type === 'session') {
      out.progress.push('会话已建立')
    } else if (o.type === 'status') {
      if (o.phase === 'step_start' && typeof o.step === 'number' && !steps.has(o.step)) {
        steps.add(o.step)
        out.progress.push(`第 ${o.step} 步 · 正在处理`)
      } else if (o.phase === 'turn_end') {
        const e = dshErrorOf(o)
        if (e) out.errorText = e
      }
    } else if (o.type === 'final') {
      const text = str(o.text)
      if (text) out.finalText = text
      const e = dshErrorOf(o)
      if (e) out.errorText = e
    } else if (o.type === 'error') {
      const e = str(o.message)
      if (e) out.errorText = e
    }
  }
  return out
}

const AGY_TOOL_LABELS: Record<string, string> = {
  search_web: '搜索网页',
  read_url_content: '读取网页',
  open_browser_url: '打开网页',
  read_file: '读取文件',
  view_file: '查看文件',
  write_to_file: '写入文件',
  replace_file_content: '修改文件',
  multi_replace_file_content: '修改文件',
  run_command: '执行命令',
  send_command_input: '发送命令输入',
  command_status: '查看命令状态',
  grep_search: '搜索代码',
  list_dir: '列出目录',
  find_by_name: '查找文件',
  generate_image: '生成图片',
  search_marketplace: '搜索技能市场',
}

function agyStepLabel(stepType: string, su: Record<string, unknown>): string | null {
  if (!stepType || stepType === 'user_input') return null
  // 工具调用在不同版本里挂在 tool_info / tool_call / toolCalls 上，取第一个能认出的工具名
  const ti = asRecord(su.tool_info) ?? asRecord(su.tool_call)
  const toolName = str(ti?.name) || str(ti?.tool_name)
  if (toolName) {
    // ④口径（Ethan 定）：主区域只给普通人话——认不出的工具名不许把英文原文糊上去
    const label = AGY_TOOL_LABELS[toolName]
    if (!label) return '正在调用工具'
    const arg = clip(str(ti?.args) || str(ti?.arguments) || str(ti?.query) || str(ti?.command_line) || str(ti?.url), 70)
    return arg ? `正在${label}：${arg}` : `正在${label}`
  }
  if (stepType === 'tool_call' || stepType === 'tool') return '正在调用工具'
  if (stepType === 'agent_response' || stepType === 'response' || stepType === 'thinking') return null
  return null
}

/** 连续同名步骤进度行合并计数（v0.1.515）：「第 3 步 · 正在搜索网页」「第 4 步 · 正在搜索网页」…
 *  合成一行「正在搜索网页 ×4」，不让一排相同的行糊满卡片。只合并紧挨着的同名步骤行，
 *  无步骤前缀的行（会话已建立等）不参与合并、也会打断连续段。 */
function mergeStepProgress(lines: string[]): string[] {
  const out: string[] = []
  const labels: Array<string | null> = []
  for (const line of lines) {
    const m = line.match(/^第 \d+ 步 · (.+)$/)
    const label = m ? m[1] : null
    const li = labels.length - 1
    if (label && li >= 0 && labels[li] === label) {
      const cnt = out[li].match(/ ×(\d+)$/)
      out[li] = cnt ? `${label} ×${Number(cnt[1]) + 1}` : `${label} ×2`
    } else {
      out.push(line)
      labels.push(label)
    }
  }
  return out
}

function parseAgy(lines: string[]): ParsedCliOutput {
  const out: ParsedCliOutput = { progress: [], finalText: '', errorText: '' }
  let streamed = ''
  const seenSteps = new Set<string>()
  for (const line of lines) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    let o: Record<string, unknown> | null = null
    try { o = asRecord(JSON.parse(t)) } catch { /* 非 JSON 归原始输出 */ }
    if (!o) continue
    const ev = str(o.event) || str(o.type)
    if (ev === 'init') {
      out.progress.push('会话已建立')
      continue
    }
    if (ev === 'step_update') {
      const su = asRecord(o.step_update) ?? o
      // v0.1.515：真实事件形状——答复增量在 step_update 里（step_type=agent_response + text_delta），
      // 拼起来作 result 缺失时的答案回落（不单独占进度行，最终答案才是主内容）
      if (str(su.step_type) === 'agent_response') {
        const td = str(su.text_delta)
        if (td) streamed += td
        continue
      }
      const idx = typeof su.step_index === 'number' ? su.step_index : -1
      const label = agyStepLabel(str(su.step_type), su)
      if (label) {
        const key = `${idx}:${label}`
        if (!seenSteps.has(key)) {
          seenSteps.add(key)
          out.progress.push(idx >= 0 ? `第 ${idx + 1} 步 · ${label}` : label)
        }
      }
      continue
    }
    if (ev === 'error' || o.error) {
      const e = str(o.message) || str(asRecord(o.error)?.message)
      if (e) out.errorText = e
      continue
    }
    // 回复增量 / 结果（各版本字段名不一，宽容匹配）
    const delta = str(o.delta) || str(asRecord(o.content)?.text)
    if (delta && (ev === 'agent_response' || ev === 'response' || ev === 'text_delta' || ev === 'message')) {
      if (!streamed) out.progress.push('正在整理答复')
      streamed += delta
      continue
    }
    if (ev === 'result' || ev === 'final' || ev === 'done') {
      // v0.1.515：agy 1.5.18 真实形状——答案在 result.response（result 是对象、status=SUCCESS），
      // 旧解析只认 result.text / 顶层 text，答案被漏掉、卡上只剩进度行（Ethan 18:36 实机实证）
      const res = asRecord(o.result)
      const text = str(res?.response) || str(o.text) || str(o.result) || str(o.response) || str(res?.text)
      if (text) out.finalText = text
      if (res?.status && res.status !== 'SUCCESS' && !out.errorText) {
        const e = str(res.error) || str(o.message)
        if (e) out.errorText = e
      }
    }
  }
  if (!out.finalText && streamed.trim()) out.finalText = streamed.trim()
  out.progress = mergeStepProgress(out.progress)
  return out
}

function parseCodex(lines: string[]): ParsedCliOutput {
  const out: ParsedCliOutput = { progress: [], finalText: '', errorText: '' }
  let step = 0
  for (const line of lines) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    let o: Record<string, unknown> | null = null
    try { o = asRecord(JSON.parse(t)) } catch { /* 非 JSON 归原始输出 */ }
    if (!o) continue
    const type = str(o.type)
    if (type === 'thread.started') {
      out.progress.push('会话已建立')
    } else if (type === 'error') {
      const e = str(o.message)
      if (e) out.errorText = e
    } else if (type === 'item.started' || type === 'item.completed') {
      const item = asRecord(o.item)
      if (!item) continue
      const it = str(item.type)
      if (type === 'item.completed' && it === 'agent_message') {
        const text = str(item.text)
        if (text) out.finalText = text
        continue
      }
      if (type !== 'item.started') continue
      step++
      if (it === 'command_execution') out.progress.push(`第 ${step} 步 · 正在执行命令：${clip(str(item.command), 70)}`)
      else if (it === 'web_search') out.progress.push(`第 ${step} 步 · 正在搜索网页${str(item.query) ? `：${clip(str(item.query), 60)}` : ''}`)
      else if (it === 'file_change') out.progress.push(`第 ${step} 步 · 正在改动文件`)
      else if (it === 'mcp_tool_call') out.progress.push(`第 ${step} 步 · 正在调用工具`)
      else if (it === 'reasoning') { /* 思考过程不单独占行 */ }
      else if (it) out.progress.push(`第 ${step} 步 · 正在处理`)
    }
  }
  return out
}

/** 纯文本通道（空壳 CLI）与未知格式：文本行就是进度；Claude Code 的 result 行抽最终答复 */
function parsePlain(lines: string[]): ParsedCliOutput {
  const out: ParsedCliOutput = { progress: [], finalText: '', errorText: '' }
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    if (t.startsWith('{')) {
      try {
        const o = asRecord(JSON.parse(t))
        if (o?.type === 'result' && typeof o.result === 'string' && o.result) {
          out.finalText = o.result
          continue
        }
      } catch { /* 落到下面的文本行处理 */ }
    }
    out.progress.push(line)
  }
  return out
}

/** 身份打码（v0.1.515 ②）：只留可辨认的头部与域名，原始身份不落盘。
 *  邮箱 x998820j@gmail.com → x998***@gmail.com；用户名同理截断加 ***。 */
export function maskIdentity(raw: string): string {
  const v = raw.trim()
  const keepOf = (s: string) => Math.min(4, Math.max(3, Math.floor(s.length / 2)))
  const at = v.indexOf('@')
  if (at > 0) return `${v.slice(0, keepOf(v.slice(0, at)))}***@${v.slice(at + 1)}`
  return `${v.slice(0, keepOf(v))}***`
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function identityFromRecord(o: Record<string, unknown>): string | null {
  for (const v of [o.email, o.user_email, o.account_email]) {
    if (typeof v === 'string' && EMAIL_RE.test(v.trim())) return maskIdentity(v)
  }
  for (const k of ['user', 'account']) {
    const em = asRecord(o[k])?.email
    if (typeof em === 'string' && EMAIL_RE.test(em.trim())) return maskIdentity(em)
  }
  return null
}

/** 从会话初始化事件里找账号身份（v0.1.515 ②）：只看三家各自的初始化事件
 *  （dsh `session` / codex `thread.started` / agy `init`）的公开字段，命中第一条初始化事件即止，
 *  不扫后续事件（避免把任务正文里的 user_input 之类误当身份）。
 *  2026-11-28 查证结论：三家当前版本的初始化事件都不带身份字段——
 *  dsh 的 session 事件经其官方包源码确认只有 {sessionId, cwd}；
 *  codex 的 thread.started 只有 {thread_id}；agy 的 init 只有 {conversation_id}。
 *  故本函数对现行事件流恒返回 null；哪家将来在初始化事件里加了邮箱字段，会被这里接住并打码存下。 */
export function parseCliIdentity(agentId: string, lines: string[]): string | null {
  for (const line of lines) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    let o: Record<string, unknown> | null = null
    try { o = asRecord(JSON.parse(t)) } catch { continue }
    if (!o) continue
    const isInit =
      (agentId === 'dsh' && o.type === 'session')
      || (agentId === 'codex-desktop' && o.type === 'thread.started')
      || (agentId === 'antigravity' && (o.event === 'init' || o.type === 'init'))
    if (!isInit) continue
    return identityFromRecord(o)
  }
  return null
}

/** 按 Agent 分发解析；headless 三家走结构化解析，其余走纯文本 */
export function parseCliOutput(agentId: string, lines: string[]): ParsedCliOutput {
  if (!lines.length) return { ...EMPTY }
  switch (agentId) {
    case 'dsh': return parseDsh(lines)
    case 'antigravity': return parseAgy(lines)
    case 'codex-desktop': return parseCodex(lines)
    default: return parsePlain(lines)
  }
}
