// CloudBase（andre 环境）通道：小程序成长计划 AI 资源包（10 亿 Token，2027-05-25 到期）。
// 与 utils/cloud.js 的 WorkBuddy 通道完全独立：这边走微信云开发基础库 wx.cloud.extend.AI，
// 身份是微信侧自动带的，不需要 WorkBuddy 登录，也不需要任何 API Key（小程序端 SDK 直调）。
//
// 分组口径（依据 CloudBase 官方《小程序成长计划使用指南》的分组对照表，2026-11-26 核对）：
// - hunyuan-v3 分组：只支持 hy3 一个模型，且只扣成长计划免费额度、额度不可用时直接报错，
//   永远不会转扣套餐/资源点 —— hy3 走这个分组，行为最严格。
// - cloudbase 分组：官方推荐分组，支持全部模型；自小程序等合法来源调用成长计划覆盖的模型时
//   先抵扣免费额度，免费额度耗尽后会按平台规则转扣环境套餐额度（平台行为，代码层无法关闭）。
//   hy4 / hy4-flash / deepseek-v4.1-flash 只在这个分组里有（hunyuan-v3 里不存在），只能走这里。
// 失败一律如实报错（andreFriendlyErr 保留后端原文），绝不静默回落到 WorkBuddy 通道。
const ANDRE_ENV_ID = 'andre-d0gqn97vr3cfd3950'
const ANDRE_GATEWAY = 'https://andre-d0gqn97vr3cfd3950.api.tcloudbasegateway.com'

// 成长计划 Token 包可抵扣的对话模型（hy4-preview 将于 2026-12-07 下线，不接；生图本版不接）
const GROWTH_MODELS = [
  { model: 'hy3', name: '混元 hy3', group: 'hunyuan-v3', blurb: '成长计划免费额度 · 仅扣免费额度' },
  { model: 'hy4', name: '混元 hy4', group: 'cloudbase', blurb: '成长计划免费额度 · 优先抵扣' },
  { model: 'hy4-flash', name: '混元 hy4-flash', group: 'cloudbase', blurb: '成长计划免费额度 · 优先抵扣' },
  { model: 'deepseek-v4.1-flash', name: 'DeepSeek v4.1-flash', group: 'cloudbase', blurb: '成长计划免费额度 · 优先抵扣' },
  { model: 'deepseek-v4.1-flash-1017', name: 'DeepSeek v4.1-flash-1017', group: 'cloudbase', blurb: '成长计划免费额度 · 同系列' },
]

/** 给 AI 页模型选择面板用的条目（id 加 andre: 前缀，与 WorkBuddy 模型 id 隔离） */
function andrePickerModels() {
  return GROWTH_MODELS.map((m) => ({
    id: 'andre:' + m.model,
    name: m.name,
    provider: m.blurb,
    channel: 'andre',
    group: m.group,
    model: m.model,
  }))
}

let inited = false
const chatModels = {}

function ensureInit() {
  if (inited) return
  if (typeof wx === 'undefined' || !wx.cloud) {
    throw new Error('当前微信不支持云开发（wx.cloud 不可用），请升级微信后重试')
  }
  if (!wx.cloud.extend || !wx.cloud.extend.AI || typeof wx.cloud.extend.AI.createModel !== 'function') {
    throw new Error('当前微信基础库版本过低，不支持 wx.cloud.extend.AI（需基础库 3.7.1 以上），请升级微信后重试')
  }
  wx.cloud.init({ env: ANDRE_ENV_ID, traceUser: true })
  inited = true
}

function getChatModel(group) {
  ensureInit()
  if (!chatModels[group]) chatModels[group] = wx.cloud.extend.AI.createModel(group)
  return chatModels[group]
}

/**
 * 流式对话：piece 为增量文本，逐段回调 onText。
 * 任何失败都抛错给调用方如实展示，不做任何通道回落。
 */
async function streamAndreChat(opts) {
  const chatModel = getChatModel(opts.group)
  const res = await chatModel.streamText({
    data: { model: opts.model, messages: opts.messages },
  })
  if (!res || !res.textStream) throw new Error('andre 通道没有返回流式结果（textStream 为空），请重试')
  for await (const piece of res.textStream) {
    if (piece) opts.onText(piece)
  }
}

/** 把 andre 通道错误翻成可操作的中文提示，同时保留后端原文（不许吞原因） */
function andreFriendlyErr(e) {
  const msg = (e && (e.message || e.errMsg)) || String(e || '未知错误')
  if (/domain|url not in|合法域名/i.test(msg)) {
    return '小程序服务器域名未配置完整：请到微信公众平台 → 开发 → 开发管理 → 开发设置 → 服务器域名，确认 request 合法域名已包含 ' + ANDRE_GATEWAY + ' 后重试（原始错误：' + msg + '）'
  }
  if (/quota|exhaust|insufficient|balance|arrearage|额度|欠费|资源包/i.test(msg)) {
    return '成长计划免费额度不可用（可能已用完、未生效或当前来源不受支持）：' + msg
  }
  if (/not found|not exist|not enabled|invalid model|model.*invalid|不存在|未开通|未启用/i.test(msg)) {
    return '该模型在 andre 环境不可用（未开通或不存在）：' + msg
  }
  if (/env|environment|环境/i.test(msg)) {
    return 'andre 云开发环境调用失败：' + msg
  }
  return msg
}

module.exports = { ANDRE_ENV_ID, ANDRE_GATEWAY, GROWTH_MODELS, andrePickerModels, streamAndreChat, andreFriendlyErr }
