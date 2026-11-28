import { describe, it, expect } from 'vitest'
import { parseCliOutput, parseCliIdentity, maskIdentity } from './agentOutput'
import { humanizeAgentError } from './agents'

describe('parseCliOutput · dsh headless --json（v0.1.511 ④）', () => {
  const lines = [
    '{"type":"session","sessionId":"session-abc123","cwd":"/Users/x/proj"}',
    '{"type":"status","phase":"turn_start","turn":1,"reason":{}}',
    '{"type":"status","phase":"step_start","turn":1,"step":1,"reason":{}}',
    '{"type":"status","phase":"step_end","turn":1,"step":1,"reason":{"toolName":"web_search"}}',
    '{"type":"status","phase":"step_start","turn":1,"step":2,"reason":{}}',
    '{"type":"status","phase":"turn_end","turn":1,"reason":{}}',
    '{"type":"final","sessionId":"session-abc123","reason":{},"text":"今天的金价是每克 812 元。"}',
  ]
  it('抽最终答复 + 步骤进度，主区域不出现原始 JSON', () => {
    const p = parseCliOutput('dsh', lines)
    expect(p.finalText).toBe('今天的金价是每克 812 元。')
    expect(p.progress).toContain('会话已建立')
    expect(p.progress).toContain('第 1 步 · 正在处理')
    expect(p.progress).toContain('第 2 步 · 正在处理')
    expect(p.errorText).toBe('')
    expect(p.progress.join('\n')).not.toContain('{')
  })
  it('失败：final.reason.error.message 抽成失败原因且走对人话分类', () => {
    const fail = [
      '{"type":"session","sessionId":"session-x","cwd":"/tmp"}',
      '{"type":"final","sessionId":"session-x","reason":{"error":{"message":"MISSING_CREDENTIAL: llm-deepseek: no API key for provider route \\"deepseek-official\\""}},"text":""}',
    ]
    const p = parseCliOutput('dsh', fail)
    expect(p.errorText).toContain('MISSING_CREDENTIAL')
    expect(p.finalText).toBe('')
    expect(humanizeAgentError(p.errorText)).toContain('还没有可用的 DeepSeek API Key')
  })
  it('stderr 汇总行 dsh: CODE: msg 也能兜底出失败原因', () => {
    const p = parseCliOutput('dsh', ['dsh: ACCOUNT_SIGN_IN_REQUIRED: Sign in to DeepSeek to use the account provider'])
    expect(p.errorText).toContain('Sign in to DeepSeek')
    expect(humanizeAgentError(p.errorText)).toContain('登录')
  })
})

describe('parseCliOutput · agy stream-json（v0.1.511 ④）', () => {
  it('init + step_update 工具调用 + result 文本', () => {
    const lines = [
      '{"event":"init","conversation_id":"conv-1"}',
      '{"event":"step_update","step_update":{"step_index":0,"step_type":"tool_call","tool_info":{"name":"search_web","args":"今日金价"}}}',
      '{"event":"step_update","step_update":{"step_index":1,"step_type":"tool_call","tool_info":{"name":"read_url_content","args":"https://example.com/gold"}}}',
      '{"event":"result","conversation_id":"conv-1","text":"查到了：今日金价 812 元/克。"}',
    ]
    const p = parseCliOutput('antigravity', lines)
    expect(p.progress).toContain('会话已建立')
    expect(p.progress.some(x => x.includes('搜索网页') && x.includes('今日金价'))).toBe(true)
    expect(p.progress.some(x => x.includes('读取网页'))).toBe(true)
    expect(p.finalText).toBe('查到了：今日金价 812 元/克。')
  })
  it('回复增量拼接为最终答复；error 事件抽失败原因', () => {
    const lines = [
      '{"event":"init","conversation_id":"conv-2"}',
      '{"event":"agent_response","delta":"你好"}',
      '{"event":"agent_response","delta":"，这是回答"}',
    ]
    const p = parseCliOutput('antigravity', lines)
    expect(p.finalText).toBe('你好，这是回答')
    expect(p.progress).toContain('正在整理答复')
    const err = parseCliOutput('antigravity', ['{"event":"error","message":"quota exceeded"}'])
    expect(err.errorText).toBe('quota exceeded')
  })
  it('④口径：认不出的工具名不许把英文原文糊进进度行', () => {
    const lines = [
      '{"event":"step_update","step_update":{"step_index":0,"step_type":"tool_call","tool_info":{"name":"some_exotic_tool_xyz","args":"{}"}}}',
    ]
    const p = parseCliOutput('antigravity', lines)
    expect(p.progress.join('\n')).not.toContain('some_exotic_tool_xyz')
    expect(p.progress.some(x => x.includes('正在调用工具'))).toBe(true)
  })
})

describe('parseCliOutput · codex exec --json（v0.1.511 ④）', () => {
  it('thread/item 事件：命令执行进度 + agent_message 为最终答复', () => {
    const lines = [
      '{"type":"thread.started","thread_id":"th-1"}',
      '{"type":"turn.started"}',
      '{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"ls -la","status":"in_progress"}}',
      '{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"ls -la","status":"completed"}}',
      '{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":"目录里有 3 个文件。"}}',
      '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":20}}',
    ]
    const p = parseCliOutput('codex-desktop', lines)
    expect(p.progress).toContain('会话已建立')
    expect(p.progress.some(x => x.includes('执行命令') && x.includes('ls -la'))).toBe(true)
    expect(p.finalText).toBe('目录里有 3 个文件。')
  })
  it('error 事件抽失败原因', () => {
    const p = parseCliOutput('codex-desktop', ['{"type":"error","message":"stream disconnected"}'])
    expect(p.errorText).toBe('stream disconnected')
  })
})

describe('parseCliOutput · 纯文本通道与兜底（v0.1.511 ④）', () => {
  it('空壳 CLI 纯文本行原样进进度行', () => {
    const p = parseCliOutput('pi', ['正在读取文件…', '完成'])
    expect(p.progress).toEqual(['正在读取文件…', '完成'])
    expect(p.finalText).toBe('')
  })
  it('claude-code 的 result 行抽最终答复', () => {
    const p = parseCliOutput('claude-code', ['{"type":"result","subtype":"success","result":"改好了。"}'])
    expect(p.finalText).toBe('改好了。')
    expect(p.progress).toEqual([])
  })
  it('解析不了的行不糊进进度（只留在原始输出）', () => {
    const p = parseCliOutput('dsh', ['{"type":"mystery","x":1}', 'not json at all {'])
    expect(p.progress).toEqual([])
    expect(p.finalText).toBe('')
  })
  it('空输入返回空结构', () => {
    expect(parseCliOutput('dsh', [])).toEqual({ progress: [], finalText: '', errorText: '' })
  })
})

describe('v0.1.515（②）：parseCliIdentity / maskIdentity', () => {
  it('maskIdentity：邮箱只留头部与域名、用户名截断', () => {
    expect(maskIdentity('x998820j@gmail.com')).toBe('x998***@gmail.com')
    expect(maskIdentity('xwj99xwj@gmail.com')).toBe('xwj9***@gmail.com')
    expect(maskIdentity('andre')).toBe('and***')
  })
  it('三家现行初始化事件都不带身份字段 → 恒为 null（2026-11-28 查证口径）', () => {
    expect(parseCliIdentity('dsh', ['{"type":"session","sessionId":"s1","cwd":"/tmp"}'])).toBeNull()
    expect(parseCliIdentity('codex-desktop', ['{"type":"thread.started","thread_id":"t1"}'])).toBeNull()
    expect(parseCliIdentity('antigravity', ['{"event":"init","conversation_id":"c1"}'])).toBeNull()
  })
  it('初始化事件带 email 时接住并打码；非初始化事件里的邮箱不误收', () => {
    expect(parseCliIdentity('dsh', ['{"type":"session","sessionId":"s1","cwd":"/tmp","email":"x998820j@gmail.com"}']))
      .toBe('x998***@gmail.com')
    expect(parseCliIdentity('antigravity', ['{"event":"init","conversation_id":"c1","user":{"email":"xwj99xwj@gmail.com"}}']))
      .toBe('xwj9***@gmail.com')
    // 任务正文 / 结果里出现的邮箱不是身份，不许收
    expect(parseCliIdentity('dsh', [
      '{"type":"session","sessionId":"s1","cwd":"/tmp"}',
      '{"type":"final","text":"联系邮箱 someone@example.com"}',
    ])).toBeNull()
    expect(parseCliIdentity('codex-desktop', ['{"type":"item.completed","item":{"type":"agent_message","text":"mail me at a@b.com"}}'])).toBeNull()
  })
})

describe('v0.1.515：agy 真实事件形状（2026-11-28 实机截图原文口径）', () => {
  const searchStep = (idx: number) => `{"event":"step_update","step_update":{"conversation_id":"c9","step_index":${idx},"state":"DONE","step_type":"tool_call","tool_info":{"name":"search_web"}}}`
  it('result.response 是最终答案；连续同名进度行合并计数', () => {
    const lines = [
      '{"event":"init","conversation_id":"c9"}',
      searchStep(2), searchStep(3), searchStep(5),
      '{"event":"step_update","step_update":{"conversation_id":"c9","step_index":8,"state":"DONE","step_type":"agent_response","text_delta":"片段","duration_seconds":6.49,"usage":{"input_tokens":2768,"output_tokens":810,"thinking_tokens":243,"cache_read_tokens":13432,"total_tokens":3578}}}',
      '{"event":"result","result":{"conversation_id":"c9","status":"SUCCESS","response":"最终答案全文：今日金价 812 元/克。","duration_seconds":34.21,"num_turns":1,"usage":{"input_tokens":20297,"output_tokens":1408,"thinking_tokens":664,"cache_read_tokens":39388,"total_tokens":21705}}}',
    ]
    const p = parseCliOutput('antigravity', lines)
    expect(p.finalText).toBe('最终答案全文：今日金价 812 元/克。')
    expect(p.progress).toEqual(['会话已建立', '正在搜索网页 ×3'])
    expect(p.errorText).toBe('')
  })
  it('没有 result 事件时，回落拼接 agent_response 的 text_delta', () => {
    const lines = [
      '{"event":"init","conversation_id":"c10"}',
      '{"event":"step_update","step_update":{"conversation_id":"c10","step_index":0,"state":"DONE","step_type":"agent_response","text_delta":"你好"}}',
      '{"event":"step_update","step_update":{"conversation_id":"c10","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"，世界"}}',
    ]
    const p = parseCliOutput('antigravity', lines)
    expect(p.finalText).toBe('你好，世界')
  })
  it('不同动作不合并、同名不连续也不合并', () => {
    const lines = [
      '{"event":"init","conversation_id":"c11"}',
      searchStep(0),
      '{"event":"step_update","step_update":{"conversation_id":"c11","step_index":1,"state":"DONE","step_type":"tool_call","tool_info":{"name":"read_file"}}}',
      searchStep(2),
    ]
    const p = parseCliOutput('antigravity', lines)
    expect(p.progress).toEqual(['会话已建立', '第 1 步 · 正在搜索网页', '第 2 步 · 正在读取文件', '第 3 步 · 正在搜索网页'])
  })
})
