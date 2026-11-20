// 统一数据模型 —— 各端（Web / 桌面 / 安卓 / 小程序）共享的核心类型
// 设计原则：本地优先、只读官方接口、跳转由本人操作、不模拟登录、不自动领取

import type { ModelCapability } from './modelCapability'

export type CreditUnit =
  | 'credit'      // 通用积分
  | 'token'       // Token 额度
  | 'request'     // 请求次数
  | 'currency'    // 货币额度（美元/人民币）
  | 'day'         // 天数（订阅剩余）

export type AccountMode =
  | 'api'         // 通过官方只读 API 查询用量
  | 'manual'      // 手动录入额度（无公开 API 的平台）
  | 'subscription'// 订阅制，只记录到期日

/** 平台目录条目（内置，不含任何用户凭证） */
export interface ProviderDefinition {
  id: string
  name: string
  shortName: string
  category:
    | 'llm'        // 文本大模型（对话/推理）
    | 'code'       // 编程助手
    | 'image'      // 图像生成/编辑
    | 'video'      // 视频生成
    | 'voice'      // 语音/音频
    | 'search'     // 搜索/研究
    | 'design'     // 设计工具
    | 'embedding'  // 嵌入/向量
    | 'local'      // 本地部署模型（Ollama / ComfyUI 等）
    | 'voice-config' // 语音配置(APP)专用账户：仅存语音服务 Key，不参与 AI 聊天
    | 'other'
  officialUrl: string
  /** 官方用量/账单页面，用于跳转（本人登录后查看） */
  usageUrl: string
  /** 官方签到/福利页面（如有），仅跳转，不自动操作 */
  checkinUrl?: string
  /** 官方 API base_url（自动填充到账户的链接地址） */
  apiBaseUrl?: string
  /** 官方创建/管理 API Key 的页面（仅跳转，由本人操作） */
  apiKeyUrl?: string
  /** 官方确有「每日签到领积分」机制（不是免费层/试用/充值页）。未标记则不进签到页 */
  dailyCheckin?: boolean
  color: string
  initials: string
  /** 该平台账户支持的数据获取方式 */
  modes: AccountMode[]
  /** 说明文字 */
  note?: string
}

/** 用户账户（本地存储，凭证加密） */
export interface Account {
  id: string
  providerId: string
  label: string
  mode: AccountMode
  /** 加密后的 API Key（仅 api 模式），密文；永不上传 */
  encryptedKey?: string
  /** 密钥指纹（用于识别是否已配置，不泄露原文） */
  keyFingerprint?: string
  /** API 链接地址（用户自填，如 https://api.deepseek.com/v1） */
  apiUrl?: string
  /** 备注（用途） */
  note?: string
  /** 模型能力分类（添加时自动识别：chat/translation/embedding/image/audio/unknown） */
  modelCapability?: ModelCapability
  /** 语音配置(APP)账户所选的语音服务商 id（aliyun/volcengine/tencent/minimax/elevenlabs） */
  voiceProvider?: string
  createdAt: string
  updatedAt: string
}

/** 额度/积分快照 */
export interface QuotaSnapshot {
  id: string
  accountId: string
  unit: CreditUnit
  total: number
  used: number
  /** 重置或到期时间 ISO 字符串 */
  resetAt?: string
  capturedAt: string
  source: 'api' | 'manual' | 'import'
}

/** 签到记录（只记录「提醒 + 本人已跳转」，不执行自动签到） */
export interface CheckinRecord {
  id: string
  providerId: string
  accountId?: string
  /** 本地日期 YYYY-MM-DD */
  date: string
  /** 本人跳转到官方页面后手动标记完成 */
  done: boolean
  rewarded?: boolean
  note?: string
}

/** 用量事件（用于费用趋势） */
export interface UsageEvent {
  id: string
  accountId: string
  date: string          // YYYY-MM-DD
  inputTokens: number
  outputTokens: number
  estimatedCost: number // 估算费用（货币单位）
  model?: string
}

/** 福利领取标记（仅记录本人已跳转/领取，不执行任何自动操作） */
export interface BenefitMark {
  benefitId: string
  /** 本地日期 YYYY-MM-DD；daily 类型按日记录，其他类型只记首次 */
  date: string
}

/** 应用整体状态 */
export interface AppState {
  version: number
  accounts: Account[]
  quotas: QuotaSnapshot[]
  checkins: CheckinRecord[]
  usage: UsageEvent[]
  benefitMarks: BenefitMark[]
  settings: AppSettings
}

/** 系统通知提醒偏好（签到/到期/告急/预算） */
export interface NotifyPrefs {
  enabled: boolean
  checkin: boolean
  /** 签到提醒时间 HH:mm */
  checkinTime: string
  expiry: boolean
  forecast: boolean
  budget: boolean
}

export interface AppSettings {
  /** 本地加密主密码校验位（不存明文） */
  vaultInitialized: boolean
  /** 每月预算（货币单位），用于预警 */
  monthlyBudget: number
  /** 签到提醒开关 */
  checkinReminder: boolean
  /** 系统通知提醒偏好（可选，缺省见 reminders.DEFAULT_NOTIFY_PREFS） */
  notify?: NotifyPrefs
  /** 用户手动确认有官方每日签到的平台 id（默认空，只展示真正可签到的） */
  checkinProviders: string[]
  /** 额度耗尽预警阈值（天）：低于此值计入"即将耗尽" */
  alertDays: number
  /** 新账户录入额度时的默认单位 */
  defaultUnit: CreditUnit
  /** 备份提醒开关（超过 backupReminderDays 天未备份时提示） */
  backupReminder: boolean
  /** 备份提醒阈值天数（3/7/15），缺省按 7 天 */
  backupReminderDays?: 3 | 7 | 15
  /** 解锁方式：系统生物识别（指纹/Face ID/Touch ID）或密码 */
  unlockMethod: 'biometric' | 'password'
  /** 各平台每单位额度价值（元），key 为 providerId，'default' 为兜底；用户可自行校准 */
  unitPrices: Record<string, number>
  /** 是否把本地模型账户（Ollama/ComfyUI 等）也纳入云同步，默认否（仅本机） */
  syncLocalProviders?: boolean
  /** 上次导出备份时间 ISO */
  lastExportAt?: string
  /** 上次同步时间（预留云同步） */
  lastSyncAt?: string
  /** 界面风格：claude=极简留白(默认/全平台)，liquid=液态玻璃，classic=经典 */
  uiStyle?: 'claude' | 'auto' | 'liquid' | 'classic'
  /** 界面动态效果开关（抽屉滑入、卡片渐入、光斑浮动等） */
  uiMotion?: boolean
  /** AI 思考模式：开启后所有对话默认进行推理（AI 聊天/文档问答全局统一） */
  thinkingMode?: boolean
  /** 本地模型服务在 App 内的启用开关（纯 App 层，不启停系统服务；键为 ollama/comfyui/lmstudio） */
  localServices?: Partial<Record<LocalServiceKey, boolean>>
  /** 本地服务开关是否已按内存档位完成过首次初始化 */
  localServicesInitialized?: boolean
  /** 内存档位手动覆盖（Web/手机端无系统内存检测时使用；desktop 以实际检测为准） */
  memoryTierOverride?: MemoryTier
}

/** 本地模型服务类型 */
export type LocalServiceKey = 'ollama' | 'comfyui' | 'lmstudio'
/** 内存档位（GB） */
export type MemoryTier = 8 | 16 | 32

/** 数据源适配器接口 —— 插件化核心 */
export interface DataSourceAdapter {
  providerId: string
  mode: AccountMode
  /** 是否配置了可用的官方只读 API */
  supported: boolean
  /** 拉取用量（仅 api 模式且用户显式触发）；失败时抛出可读错误 */
  fetchUsage?(apiKey: string): Promise<{
    used: number
    total?: number
    unit: CreditUnit
    /** 余额型接口：可直接展示的剩余余额（与 used/total 并存时以此为准） */
    remaining?: number
    /** 余额货币符号（¥ / $） */
    symbol?: string
    /** 余额明细文案（如「充值 ¥100 · 赠金 ¥10」） */
    detail?: string
    /** 完整展示文案（如无额度上限时），优先于其它字段 */
    label?: string
    events?: Array<{ date: string; inputTokens: number; outputTokens: number; model?: string }>
  }>
  /** 官方用量页，跳转用 */
  usageUrl: string
}

/** 汇总后的看板视图模型 */
export interface AccountView {
  account: Account
  provider: ProviderDefinition
  quota?: QuotaSnapshot
  usagePercent: number
  daysUntilReset?: number
  /** 用量耗尽预测 */
  forecast?: import('./forecast').Forecast
}

/** 本地部署模型账户的 providerId 统一前缀（Ollama / ComfyUI 等） */
export const LOCAL_PROVIDER_PREFIX = 'local-'

/** 该账户是否为本地模型（本地模型不进云同步、备份与导出） */
export function isLocalProvider(providerId: string | undefined | null): boolean {
  return !!providerId && providerId.startsWith(LOCAL_PROVIDER_PREFIX)
}
