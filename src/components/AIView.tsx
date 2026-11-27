// AI 助手聊天页：类 WorkBuddy 的干净对话界面。
// 布局自适应：桌面居中宽栏、移动端占满屏；流式输出、可中止、快捷提问。

import { useEffect, useRef, useState, useMemo, useCallback, Fragment, type ReactNode } from 'react'
import {
  Send, Square, Plus, ChevronDown, ChevronUp, ChevronRight, Copy, Volume2, VolumeX,
  Phone, Layers, ExternalLink, Info, Loader2, FileText, Image as ImageIcon, Video, X, RotateCcw, Mic,
  Search, Download, Database, BookMarked, Columns2, Trash2, MessagesSquare, ArrowLeft, Check, Globe, Shuffle, Lock, Power, Gauge,
} from 'lucide-react'
import {
  listModels, loadHistory, rotateConversationId,
  loadModel, saveModel, streamChat, friendlyAiError,
  type ChatMessage, type AiModel,
} from '../core/ai'
import { saveExportFile } from '../core/saveFile'
import { openExternal } from '../core/openExternal'
import { speakAsync, stopSpeak, getSavedVoice, cleanForAutoSpeech } from '../core/tts'
import { startSpeechInput, type SpeechInputSession } from '../core/speechInput'
import { listClonedVoices, type ClonedVoice } from '../core/voiceClone'
import {
  loadBotProfile, saveBotProfile, loadUserProfile, saveUserProfile,
  getAvatar, buildIdentitySystemPrompt, buildVoiceSystemPrompt, resizeAvatarImage, AVATAR_PRESETS,
  type BotProfile, type UserProfile,
} from '../core/aiIdentity'
import { VoiceCall } from './VoiceCall'
import {
  CATEGORY_META, categoryForModel, isVoiceConfigAccount, type ModelCategory,
} from '../core/modelCategories'
import { detectModelCapability, capabilityChatCapable } from '../core/modelCapability'
import { inferbaseGate } from '../core/inferbase'
import { oneAiGate, ONEAI_SMOKE_MODEL } from '../core/oneai'
import { anyApiGate, getAnyApiSmokeModel } from '../core/anyapi'
import { tokenRouterGate, getTokenRouterSmokeModel, isTokenRouterFreeModel, TOKENROUTER_SMOKE_MODEL } from '../core/tokenrouter'
import {
  momaGate, isMomaChatCandidate, orderMomaProbeModels, momaModelBillingNote, MOMA_PROVIDER_ID,
  isMomaSelfOperated, isMomaAutoTestable, groupMomaModels, loadMomaModelTests, saveMomaModelTest,
  loadMomaFreeOnly, saveMomaFreeOnly, MOMA_CATEGORY_LABEL,
  type MomaModelCategory, type MomaModelTest,
} from '../core/moma'
import { dedupeSameKeyAccounts } from '../core/adapters'
import { loadState } from '../core/store'
import { t, locale } from '../core/i18n'
import { buildDataDigest } from '../core/dataDigest'
import { SESSIONS_EVENT, OPEN_SESSION_EVENT, NEW_SESSION_EVENT, requestToggleHistory, consumePendingSessionActions } from '../core/chatSessions'
import { callByCategory, fetchProviderModels, callLocalChat, fetchLocalAssistantModels, callChat } from '../core/providerCall'
import { fetchUpstreamFreeModels, chatUpstream, UPSTREAM_LABEL, upstreamRetryDelayMs, type UpstreamModel, type UpstreamSource } from '../core/upstreamFree'
import { testFreeAiOption, type FreeAiOption } from '../core/freeAi'
import {
  loadApisFreeState, apisFreeReady, chatApisFree,
  APISFREE_MODEL, APISFREE_CHANGED_EVENT, type ApisFreeState,
} from '../core/apisFree'
import {
  runFreeChain, loadChainMode, saveChainMode, classifyChainError, failoverEligible, orderChainCandidates,
  CHAIN_KIND_REASON, CHAIN_MODE_EVENT, ChainAllFailedError, ChainPartialError,
  type ChainMode, type ChainCandidate, type ChainAvailability,
} from '../core/freeChain'
import { hasPoolAccounts, poolChat } from '../core/wbPool'
import { defaultChatEngine } from '../core/workshopChat'
import { collectMcpTools, loadToolCallingEnabled, runToolChatLoop } from '../core/toolChat'
import { buildSearchContextCached, loadWebSearchEnabled, saveWebSearchEnabled } from '../core/webSearch'
import type { Account, PromptTemplate, AiToolbarPrefs } from '../core/types'
import { mergeToolbarOrder } from '../core/types'
import { LOCAL_SERVICE_CHANGED_EVENT, isAccountServiceEnabled, shouldShowLocalCategory } from '../core/localServicesSettings'
import { decryptSecret, getBiometricPassword, verifyVault } from '../core/crypto'
import { PROVIDER_MAP } from '../data/providers'
import { groupOptionsByPlatform, platformKeyOf, platformNameOf, modelNameOf, isFreeModelName, freeModelsFirst, filterModelsByQuery } from '../core/modelCascade'
import {
  loadProbeStore, syncProbeTargets, recordProbeOutcome, seedProbeOutcome, classifyProbeError,
  probeSummary, unavailableTargets, rankProbeGroup, selectProbeBatch, medianSamples,
  PROBE_CHANGED_EVENT, type ProbeTarget, type ProbeGroup,
} from '../core/probeCenter'
import { loadKeyHealth } from '../core/healthCheck'
import { isVisionModelId } from '../core/galleryIndex'
import {
  fileToAttachment, isTextAttachment, decodeAttachmentText, type PickedAttachment,
} from '../core/attachments'
import { needsBinaryParse, parseBinaryDocument } from '../core/documentParse'
import { AttachmentPicker } from './AttachmentPicker'
import {
  enginesFor, enginesFromRemote, isChatProbeCandidate, REASONING_LEVELS, REASONING_DESC, toReasoningEffort, defaultReasoningLevel,
  type ReasoningLevel, type Engine,
} from '../data/engines'

/** 根据系统时间生成问候语（ Claude 式动态称呼） */
function timeGreeting(): string {
  const h = new Date().getHours()
  if (h >= 5 && h < 11) return '早上好'
  if (h >= 11 && h < 13) return '中午好'
  if (h >= 13 && h < 18) return '下午好'
  if (h >= 18 && h < 22) return '晚上好'
  if (h >= 22 || h < 5) return '夜深了'   // 深夜/凌晨
  return '您好'
}
/** 结合时段与用户昵称生成欢迎语，如"晚上好，夜猫子" */
function welcomeText(userNick?: string): string {
  const greet = timeGreeting()
  const name = (userNick || '').trim()
  // 默认昵称"我"或空时，按时段给一个自然的称呼，避免"夜深了，我"这种生硬表达
  if (!name || name === '我') {
    const h = new Date().getHours()
    const defaultName = (h >= 22 || h < 5) ? '夜猫子' : '朋友'
    return t('{greet}，{name}', { greet: t(greet), name: t(defaultName) })
  }
  return t('{greet}，{name}', { greet: t(greet), name })
}

/** AI 助手页只展示这 4 类模型，免费模型排第一（生图型/视频型/文本型不在此页展示） */
const AI_CATEGORIES: ModelCategory[] = ['免费模型', '通用型', '对话型', '本地型']

/** 听写文本并入已有输入：中文直接相连，英文单词间补空格，标点后不加空格 */
function joinDictation(base: string, text: string): string {
  if (!base) return text
  if (!text) return base
  if (/[\s。！？；，、,.!?;:]$/u.test(base)) return base + text
  if (/[A-Za-z0-9]$/.test(base) && /^[A-Za-z0-9]/.test(text)) return `${base} ${text}`
  return base + text
}

/** AI 助手多会话：每个会话独立保存消息，可新建/切换/重命名/删除（存本机 localStorage） */
export interface ChatSession {
  id: string
  title: string
  messages: ChatMessage[]
  updatedAt: number
  /** 已归档（边栏归档操作写入，AIView 只透传保存） */
  archived?: boolean
}

const SESSIONS_KEY = 'acm_ai_sessions_v1'

function loadSessionStore(): { sessions: ChatSession[]; activeId: string } {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as { sessions?: ChatSession[]; activeId?: string }
      if (Array.isArray(parsed.sessions)) {
        const sessions = parsed.sessions.filter(s => s && Array.isArray(s.messages))
        if (sessions.length) {
          return { sessions, activeId: parsed.activeId && sessions.some(s => s.id === parsed.activeId) ? parsed.activeId : sessions[0].id }
        }
      }
    }
  } catch { /* 忽略 */ }
  const legacy = loadHistory()
  const first: ChatSession = { id: `sess-${Date.now()}`, title: legacy.length ? '历史对话' : '新对话', messages: legacy, updatedAt: Date.now() }
  return { sessions: [first], activeId: first.id }
}

function saveSessionStore(store: { sessions: ChatSession[]; activeId: string }): void {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify({
      activeId: store.activeId,
      sessions: store.sessions.map(s => ({ ...s, messages: s.messages.slice(-100) })),
    }))
  } catch { /* 忽略 */ }
}

export function AIView({ notify, accounts, settings, serviceController, prompts, onPromptsChange, onOpenSearch }: {
  notify: (m: string, kind?: 'ok' | 'err') => void
  accounts: Account[]
  settings?: import('../core/types').AppSettings
  serviceController?: import('../core/useServiceController').ServiceController
  prompts?: PromptTemplate[]
  onPromptsChange?: (p: PromptTemplate[]) => void
  /** v0.1.481：顶栏胶囊内的全局搜索按钮（打开 App 的命令面板，与 ⌘K 同一个） */
  onOpenSearch?: () => void
}) {
  const [sessionStore, setSessionStore] = useState<{ sessions: ChatSession[]; activeId: string }>(loadSessionStore)
  const [messages, setMessages] = useState<ChatMessage[]>(() => sessionStore.sessions.find(s => s.id === sessionStore.activeId)?.messages ?? [])
  const [input, setInput] = useState('')
  const [generating, setGenerating] = useState(false)
  const [models, setModels] = useState<AiModel[]>([])
  const [upstreamModels, setUpstreamModels] = useState<UpstreamModel[]>([])
  const [needLogin, setNeedLogin] = useState(false)
  const [model, setModel] = useState<string>('')
  const [modelOpen, setModelOpen] = useState(false)
  // v0.1.513：第三段模型菜单搜索词（纯过滤，不落盘、不是模式开关）；换分类/平台时清空，避免把上一个列表的过滤带过来
  const [modelQuery, setModelQuery] = useState('')
  const [category, setCategory] = useState<ModelCategory>('免费模型')
  const [categoryOpen, setCategoryOpen] = useState(false)
  // 三段选择器（v0.1.496）：第二段「平台」的展开态与当前平台上下文（分组键，见 modelCascade）
  const [platformOpen, setPlatformOpen] = useState(false)
  const [platformKey, setPlatformKey] = useState('')
  useEffect(() => { setModelQuery('') }, [category, platformKey])
  const [streamingText, setStreamingText] = useState('')
  // 联网搜索进行中（驱动流式气泡里的旋转地球动画，v0.1.323 Ethan 要求）
  const [searching, setSearching] = useState(false)
  const [speakingId, setSpeakingId] = useState<string | null>(null)
  // 朗读合成进度（v0.1.428）：Qwen 合成进行中按钮显示「合成中…X 秒」，再点取消
  const [synthId, setSynthId] = useState<string | null>(null)
  const [synthElapsed, setSynthElapsed] = useState(0)
  const synthCancelRef = useRef<{ cancelled: boolean } | null>(null)
  // 自动朗读：AI 回复完成后自动朗读（只读文字，去表情/标点），开关持久化
  const [autoSpeak, setAutoSpeak] = useState(() => {
    try { return localStorage.getItem('acm.ai.autoSpeak') === '1' } catch { return false }
  })
  const toggleAutoSpeak = () => setAutoSpeak(v => {
    const next = !v
    try { localStorage.setItem('acm.ai.autoSpeak', next ? '1' : '0') } catch { /* 忽略 */ }
    if (!next) stopSpeak()
    return next
  })
  const [callOpen, setCallOpen] = useState(false)
  const [resolvingKey, setResolvingKey] = useState(false)
  const [attachPickerOpen, setAttachPickerOpen] = useState(false)
  const [attachments, setAttachments] = useState<PickedAttachment[]>([])
  // 粘贴/拖放添加文件（v0.1.321）：复用附件管线——图片走看图、文本类解码、PDF/Word 发送时解析正文
  const addFiles = async (files: File[]) => {
    if (!files.length) return
    const room = 6 - attachments.length
    if (room <= 0) { notify(t('一次最多添加 6 个附件')); return }
    const accepted: PickedAttachment[] = []
    for (const f of files.slice(0, room)) {
      if (f.size > 10 * 1024 * 1024) { notify(t('「{name}」超过 10MB，已跳过', { name: f.name || t('附件') })); continue }
      try { accepted.push(await fileToAttachment(f)) } catch { /* 单个失败不影响其余 */ }
    }
    if (files.length > room) notify(t('一次最多添加 6 个附件'))
    if (accepted.length) {
      setAttachments(prev => [...prev, ...accepted])
      notify(t('已添加 {n} 个附件', { n: accepted.length }))
    }
  }
  const [enginePanelOpen, setEnginePanelOpen] = useState(false)
  const [engineId, setEngineId] = useState<string>('')
  const [remoteEngines, setRemoteEngines] = useState<string[] | null>(null)
  const [engineSource, setEngineSource] = useState<'remote' | 'builtin' | 'none'>('none')
  const [loadingEngines, setLoadingEngines] = useState(false)
  const [reasoning, setReasoning] = useState<ReasoningLevel>(() => defaultReasoningLevel(settings?.thinkingMode))
  const [reasoningOpen, setReasoningOpen] = useState(false)
  // 设置页「AI 思考模式」开关变化时，同步默认推理等级；不覆盖用户此后手动的选择
  const lastThinkingMode = useRef(settings?.thinkingMode)
  useEffect(() => {
    if (lastThinkingMode.current !== settings?.thinkingMode) {
      lastThinkingMode.current = settings?.thinkingMode
      setReasoning(defaultReasoningLevel(settings?.thinkingMode))
    }
  }, [settings?.thinkingMode])
  const [identityOpen, setIdentityOpen] = useState<'bot' | 'user' | null>(null)
  const [botProfile, setBotProfile] = useState<BotProfile>(() => loadBotProfile())
  const [userProfile, setUserProfile] = useState<UserProfile>(() => loadUserProfile())
  // 克隆音色列表：语音配置页增删改时通过事件实时同步
  const [clonedVoices, setClonedVoices] = useState<ClonedVoice[]>(() => listClonedVoices())
  useEffect(() => {
    const refresh = () => setClonedVoices(listClonedVoices())
    window.addEventListener('acm:cloned-voices-changed', refresh)
    // 弹窗打开时也刷新一次，确保跨页面/跨标签的改动也能拿到
    return () => window.removeEventListener('acm:cloned-voices-changed', refresh)
  }, [])
  // 点击下拉列表以外的任意位置（含页面空白、输入框等），关闭所有未选择的弹层
  useEffect(() => {
    const closeOnOutside = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (t && t.closest('.ai-model-wrap, .reasoning-wrap')) return
      setCategoryOpen(false); setModelOpen(false); setReasoningOpen(false)
    }
    document.addEventListener('click', closeOnOutside)
    return () => document.removeEventListener('click', closeOnOutside)
  }, [])
  // 本地服务在设置页被关闭时：立即清理该服务在本 App 内的缓存（引擎列表/选中态），释放内存。
  // 不触碰系统服务与其他软件，仅重置本组件内存状态。
  useEffect(() => {
    const onServiceChanged = (e: Event) => {
      const detail = (e as CustomEvent<{ key: string; enabled: boolean }>).detail
      if (!detail || detail.enabled) return // 开启无需清理
      const providerId = `local-${detail.key}`
      // 若当前选中的正是该服务的账户，取消选择
      setModel(prev => {
        if (!prev || !prev.startsWith('own:')) return prev
        const acct = accounts.find(a => `own:${a.id}` === prev)
        return acct?.providerId === providerId ? '' : prev
      })
      // 重置引擎缓存相关状态，释放内存
      setRemoteEngines(null)
      setEngineId('')
      setEngineSource('none')
      setLoadingEngines(false)
      setEnginePanelOpen(false)
    }
    window.addEventListener(LOCAL_SERVICE_CHANGED_EVENT, onServiceChanged)
    return () => window.removeEventListener(LOCAL_SERVICE_CHANGED_EVENT, onServiceChanged)
  }, [accounts])
  // 自有模型的解密凭据：优先用指纹/人脸模式保存的密码自动解密；纯密码模式则本次会话内输入一次
  const [aiPwd, setAiPwd] = useState('')
  const [aiPwdInput, setAiPwdInput] = useState('')
  const [aiPwdBusy, setAiPwdBusy] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // 语音输入（听写）：点麦克风开始，识别文本实时并入输入框；再点一次停止
  const [listening, setListening] = useState(false)
  const speechRef = useRef<SpeechInputSession | null>(null)
  const dictBaseRef = useRef('')
  useEffect(() => () => { speechRef.current?.stop() }, [])
  const toggleMic = async () => {
    if (listening) { speechRef.current?.stop(); return }
    dictBaseRef.current = input
    setListening(true)
    const session = await startSpeechInput({
      onText: (t) => onInput(joinDictation(dictBaseRef.current, t)),
      onError: (m) => { notify(m); setListening(false) },
      onEnd: () => { speechRef.current = null; setListening(false) },
      onProcessing: () => notify(t('录音结束，正在转写成文字…')),
    })
    if (!session) { setListening(false); return }
    speechRef.current = session
  }
  const longPressRef = useRef<number | null>(null)

  const avatarContent = (p: BotProfile | UserProfile) => p.avatarDataUrl
    ? <img className="ai-avatar-img" src={p.avatarDataUrl} alt={t('头像')} />
    : getAvatar(p.avatarId).emoji
  const avatarBg = (p: BotProfile | UserProfile) => getAvatar(p.avatarId).color

  const copyMessage = async (text: string) => {
    try { await navigator.clipboard.writeText(text); notify(t('已复制对话内容')) }
    catch {
      const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); notify(t('已复制对话内容'))
    }
  }
  const startLongPress = (text: string) => {
    if (longPressRef.current !== null) window.clearTimeout(longPressRef.current)
    longPressRef.current = window.setTimeout(() => { void copyMessage(text); longPressRef.current = null }, 550)
  }
  const endLongPress = () => {
    if (longPressRef.current !== null) { window.clearTimeout(longPressRef.current); longPressRef.current = null }
  }

  // 加载模型列表：空列表给明确提示，不硬编码兜底
  useEffect(() => {
    let alive = true
    listModels().then(list => {
      if (!alive) return
      setNeedLogin(false)
      setModels(list)
      const saved = loadModel()
      if (saved && (saved.startsWith('own:') || saved.startsWith('up:'))) return  // 恢复的是自有账户/免费通道模型，由 allOptions 匹配（下方 effect）
      const picked = saved && list.some(m => m.id === saved) ? saved : list[0]?.id
      if (picked) setModel(picked)
    }).catch(e => {
      if (!alive) return
      const msg = String((e as Error)?.message ?? e)
      // 未登录云同步时免费模型不可用：不弹错误 toast，只在模型菜单里给登录提示
      if (msg.includes('401') || msg.toLowerCase().includes('login')) { setNeedLogin(true); return }
      notify(t('模型加载失败：{msg}', { msg: friendlyAiError(e) }))
    })
    return () => { alive = false }
  }, [notify])

  // 内置免费通道（Zen / Kilo）：清单跟随上游拉取。拉空/失败自动重试（启动瞬间网络/代理
  // 未就绪是最常见的一次性失败，旧版只拉一次且静默，会整会话都缺这批模型——2026-11-21 实测）；
  // 重试耗尽仍为空则在模型菜单里明示并给手动重试入口，不再静默消失。
  const upstreamFreeOn = settings?.upstreamFree !== false
  const [upstreamErr, setUpstreamErr] = useState(false)
  useEffect(() => {
    if (!upstreamFreeOn) { setUpstreamModels([]); setUpstreamErr(false); return }
    let alive = true
    let timer: number | undefined
    let attempt = 0
    const load = () => {
      fetchUpstreamFreeModels(attempt > 0).then(list => {
        if (!alive) return
        if (list.length) { setUpstreamModels(list); setUpstreamErr(false); return }
        const delay = upstreamRetryDelayMs(attempt)
        if (delay !== null) { attempt++; timer = window.setTimeout(load, delay) }
        else setUpstreamErr(true)
      }).catch(() => {
        if (!alive) return
        const delay = upstreamRetryDelayMs(attempt)
        if (delay !== null) { attempt++; timer = window.setTimeout(load, delay) }
        else setUpstreamErr(true)
      })
    }
    load()
    return () => { alive = false; if (timer) window.clearTimeout(timer) }
  }, [upstreamFreeOn])

  /** 免费通道手动重试（菜单里点「重试」）：强制跳过缓存重拉 */
  const retryUpstream = () => {
    setUpstreamErr(false)
    fetchUpstreamFreeModels(true).then(list => {
      if (list.length) setUpstreamModels(list)
      else setUpstreamErr(true)
    }).catch(() => setUpstreamErr(true))
  }

  // 持久化历史 + 自动滚动到底部
  // 多会话：messages 变化时同步回当前会话并持久化全部会话
  useEffect(() => {
    setSessionStore(store => ({
      ...store,
      sessions: store.sessions.map(s => s.id === store.activeId
        ? { ...s, messages: messages.slice(-100), updatedAt: Date.now(), title: s.title === '新对话' ? (messages.find(m => m.role === 'user')?.content.slice(0, 20) || '新对话') : s.title }
        : s),
    }))
  }, [messages])
  // 保存会话并广播给左侧边栏历史列表；lastSavedRawRef 防止把自己广播的事件当外部变更重载
  const lastSavedRawRef = useRef('')
  useEffect(() => {
    saveSessionStore(sessionStore)
    try { lastSavedRawRef.current = localStorage.getItem(SESSIONS_KEY) ?? '' } catch { /* 忽略 */ }
    window.dispatchEvent(new Event(SESSIONS_EVENT))
  }, [sessionStore])
  // 边栏（或其他端）改动了会话存储 → 重载到内存；边栏的打开/新建请求 → 消费 pending 并执行（切换/新建逻辑在 consumePending 内）
  const sessionStoreRef = useRef(sessionStore)
  sessionStoreRef.current = sessionStore
  useEffect(() => {
    const reloadExternal = () => {
      let raw = ''
      try { raw = localStorage.getItem(SESSIONS_KEY) ?? '' } catch { return }
      if (!raw || raw === lastSavedRawRef.current) return
      lastSavedRawRef.current = raw
      const next = loadSessionStore()
      setSessionStore(next)
      setMessages(next.sessions.find(s => s.id === next.activeId)?.messages ?? [])
    }
    const consumePending = () => {
      const { openId, wantNew } = consumePendingSessionActions()
      if (openId) {
        const target = sessionStoreRef.current.sessions.find(s => s.id === openId)
        if (target) {
          setSessionStore(store => ({ ...store, activeId: openId }))
          setMessages(target.messages)
          setCompareRuns(null)
        }
      } else if (wantNew) {
        // 当前会话还是空的时连点「新建会话」不重复建空会话（防刷屏式闪烁与空会话堆积）
        const cur = sessionStoreRef.current
        const active = cur.sessions.find(s => s.id === cur.activeId)
        if (active && active.messages.length === 0) return
        const s: ChatSession = { id: `sess-${Date.now()}`, title: '新对话', messages: [], updatedAt: Date.now() }
        setSessionStore(store => ({ sessions: [s, ...store.sessions], activeId: s.id }))
        setMessages([])
        rotateConversationId()
      }
    }
    consumePending()
    window.addEventListener(SESSIONS_EVENT, reloadExternal)
    window.addEventListener(OPEN_SESSION_EVENT, consumePending)
    window.addEventListener(NEW_SESSION_EVENT, consumePending)
    return () => {
      window.removeEventListener(SESSIONS_EVENT, reloadExternal)
      window.removeEventListener(OPEN_SESSION_EVENT, consumePending)
      window.removeEventListener(NEW_SESSION_EVENT, consumePending)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // 自动滚动只滚聊天区容器本身：用 scrollIntoView 会连带滚动侧边栏与整页（祖先滚动容器），表现为侧边栏闪屏/滑动
  useEffect(() => {
    const c = bottomRef.current?.parentElement
    if (c) c.scrollTo({ top: c.scrollHeight, behavior: 'smooth' })
  }, [messages, streamingText])

  // 本地型：Ollama 服务开启时拉取本机可用模型（文本+视觉，排除嵌入/生图/视频/语音）。
  // v0.1.499：开/关 Ollama 只更新本地模型清单，绝不改动当前分类/平台/模型选择——
  // 497 真机录屏里开 Ollama 后选择被自动跳到本地型/gemma3:4b，已废除两处自动切换。
  const [localModels, setLocalModels] = useState<string[]>([])
  const ollamaEnabled = useMemo(() => {
    const svc = (settings?.localServices as Record<string, boolean> | undefined)
    return svc?.ollama !== false
  }, [settings])
  useEffect(() => {
    let alive = true
    if (!ollamaEnabled) {
      setLocalModels([])
      return
    }
    // 服务刚启动需短暂就绪时间，延迟拉取；超时保护避免慢服务卡住 UI
    const timer = window.setTimeout(() => {
      void Promise.race([
        fetchLocalAssistantModels('http://127.0.0.1:11434'),
        new Promise<string[]>((_, rej) => window.setTimeout(() => rej(new Error('timeout')), 15000)),
      ]).then(ids => {
        if (!alive) return
        setLocalModels(ids)
      }).catch(() => { if (alive) setLocalModels([]) })
    }, 1200)
    return () => { alive = false; window.clearTimeout(timer) }
  }, [ollamaEnabled])

  // 免费路线切换链模式 + APIsFreeLLM 通道状态（v0.1.433，本机偏好；工坊 RouteSelect 共用同一份）
  const [chainMode, setChainModeState] = useState<ChainMode>(() => loadChainMode())
  const [apisFreeState, setApisFreeState] = useState<ApisFreeState>(() => loadApisFreeState())
  useEffect(() => {
    const refresh = () => { setApisFreeState(loadApisFreeState()); setChainModeState(loadChainMode()) }
    window.addEventListener(APISFREE_CHANGED_EVENT, refresh)
    window.addEventListener(CHAIN_MODE_EVENT, refresh)
    return () => { window.removeEventListener(APISFREE_CHANGED_EVENT, refresh); window.removeEventListener(CHAIN_MODE_EVENT, refresh) }
  }, [])
  const changeChainMode = (m: ChainMode) => { saveChainMode(m); setChainModeState(m) }
  // v0.1.439：右上角功能菜单里的「免费路线切换」组点选——全局同一设置（与工坊共用），切换给 toast 确认
  // v0.1.497：入口改为图标栏下小浮层，点选后只收浮层、图标栏保持打开（当前模式的勾随之可见地移动）
  const pickChainMode = (m: ChainMode) => {
    if (m !== chainMode) {
      changeChainMode(m)
      notify(m === 'auto' ? '免费路线已切到「自动切换」：首选失败自动切下一条免费路线并说明原因' : '免费路线已切到「手动锁定」：只用所选路线，失败只报真实原因')
    }
    setChainOpen(false)
  }
  // 免费模型 + 用户自己的账户模型，按分类联动过滤
  const freeOptions = useMemo(() => models.map(m => ({ key: m.id, label: m.name, account: null as Account | null, category: '免费模型' as ModelCategory, free: true, localModel: undefined as string | undefined, upstream: undefined as UpstreamSource | undefined, apisFree: undefined as boolean | undefined })), [models])
  // 内置免费通道模型（Zen / Kilo）：与云端免费模型同列「免费模型」分类，标签带来源后缀区分
  const upstreamOptions = useMemo(() => upstreamModels.map(m => ({
    key: `up:${m.source}:${m.id}`,
    label: `${m.name} · ${UPSTREAM_LABEL[m.source]}`,
    account: null as Account | null,
    category: '免费模型' as ModelCategory,
    free: true,
    localModel: undefined as string | undefined,
    upstream: m.source as UpstreamSource | undefined,
    apisFree: undefined as boolean | undefined,
  })), [upstreamModels])
  // APIsFreeLLM 兜底通道：仅在开启且真实测活通过后才作为选项出现（未测通不冒充可用）
  const apisFreeOptions = useMemo(() => (apisFreeReady(apisFreeState) ? [{
    key: `apisfree:${APISFREE_MODEL}`,
    label: `${APISFREE_MODEL} · APIsFreeLLM`,
    account: null as Account | null,
    category: '免费模型' as ModelCategory,
    free: true,
    localModel: undefined as string | undefined,
    upstream: undefined as UpstreamSource | undefined,
    apisFree: true as boolean | undefined,
  }] : []), [apisFreeState])
  const ownOptions = useMemo(() => dedupeSameKeyAccounts(accounts
    // 无密钥的影子账户（多由早期导入/合并产生）不能调用，与翻译/图片等模块一致不展示；
    // Key 管理页按密钥计数同样不含它们，所以会出现「管理页 1 个、助手里 2 个」的假重复
    .filter(a => !!a.encryptedKey))
    // 语音配置(APP)账户只服务语音模块，不在 AI 聊天列表展示、不参与调用
    .filter(a => !isVoiceConfigAccount(a.providerId, a.note))
    // 嵌入/图像/音频模型不能聊天，自动隐藏。
    // 存储值与实时识别取「更保守」者：规则增强后，老账户即使标着旧值也会被正确隐藏。
    .filter(a => {
      const stored = a.modelCapability
      const live = detectModelCapability(a.label).capability
      return capabilityChatCapable(live) && (stored === undefined || capabilityChatCapable(stored))
    })
    // 本地账户：设置页对应服务开关关闭时隐藏（账户数据本身保留）
    .filter(a => isAccountServiceEnabled(settings, a.providerId))
    .map(a => ({
      key: `own:${a.id}`,
      // Inferbase 启用门槛（v0.1.432）：冒烟未通过时在选项上明示待实测，不等发送失败才知道
      label: `${a.label}${a.note ? ` · ${a.note.replace(/^\[[^\]]+\]\s*/, '')}` : ''}${a.providerId === 'inferbase' && !inferbaseGate(a).enabled ? ' · 待实测（未启用）' : ''}${a.providerId === 'oneai' && !oneAiGate(a).enabled ? ' · 待实测（未启用）' : ''}${a.providerId === 'anyapi' && !anyApiGate(a).enabled ? ' · 待实测（未启用）' : ''}${a.providerId === 'tokenrouter' && !tokenRouterGate(a).enabled ? ' · 待实测（未启用）' : ''}${a.providerId === 'moma' && !momaGate(a).enabled ? ' · 待实测（未启用）' : ''}`,
      account: a,
      category: categoryForModel(a.note) as ModelCategory,
      free: false,
      localModel: undefined as string | undefined,
      upstream: undefined as UpstreamSource | undefined,
      apisFree: undefined as boolean | undefined,
    })), [accounts, settings])
  // 本机 Ollama 模型作为「本地型」选项（无账户、无 Key，直接调本机服务）
  const localOptions = useMemo(() => localModels.map(m => ({
    key: `local:${m}`,
    label: m,
    account: null as Account | null,
    category: '本地型' as ModelCategory,
    free: false,
    localModel: m,
    upstream: undefined as UpstreamSource | undefined,
    apisFree: undefined as boolean | undefined,
  })), [localModels])
  const allOptions = useMemo(() => [...freeOptions, ...upstreamOptions, ...apisFreeOptions, ...ownOptions, ...localOptions], [freeOptions, upstreamOptions, apisFreeOptions, ownOptions, localOptions])
  const visibleOptions = useMemo(() => allOptions.filter(o => o.category === category), [category, allOptions])
  const selectedOption = allOptions.find(o => o.key === model) ?? null
  // 三段选择器（v0.1.496）：当前分类的选项按平台分组（第二段的数据来源，纯视图分组）
  const platformGroups = useMemo(() => groupOptionsByPlatform(visibleOptions), [visibleOptions])
  const currentPlatform = platformGroups.find(g => g.platformKey === platformKey) ?? null

  const freeModelIdOf = (o: { key: string; upstream?: UpstreamSource; apisFree?: boolean }) => (o.apisFree ? APISFREE_MODEL : (o.upstream ? o.key.slice(`up:${o.upstream}:`.length) : o.key))

  // ---- v0.1.504：全局模型探测中心（AI 助手首个接入）----
  // 一份结果全 App 共用（存储 acm.probeCenter.v1）；探测只影响排序与「推荐」标记，
  // 绝不拦发送、绝不改已选（499 定案）。触发：进入 AI 助手时后台测一轮过期/未测项。
  const [probeStore, setProbeStore] = useState(() => loadProbeStore())
  useEffect(() => {
    const f = () => setProbeStore(loadProbeStore())
    window.addEventListener(PROBE_CHANGED_EVENT, f)
    return () => window.removeEventListener(PROBE_CHANGED_EVENT, f)
  }, [])
  const [probeRunning, setProbeRunning] = useState(false)
  const probingRef = useRef(false)
  const [probePanelOpen, setProbePanelOpen] = useState(false)
  const [probeFoldOpen, setProbeFoldOpen] = useState(false)
  const [menuUnavailOpen, setMenuUnavailOpen] = useState(false)
  const [probeSingleId, setProbeSingleId] = useState('')
  const generatingRef = useRef(false)
  useEffect(() => { generatingRef.current = generating }, [generating])

  const probeTargets = useMemo<ProbeTarget[]>(() => {
    const out: ProbeTarget[] = []
    const groupOf = (c: ModelCategory): ProbeGroup => (c === '免费模型' ? 'free' : c === '通用型' ? 'general' : 'chat')
    for (const o of allOptions) {
      if (o.account) continue
      out.push({
        id: o.key, name: modelNameOf(o), platformName: platformNameOf(o), platformKey: platformKeyOf(o),
        group: groupOf(o.category), vision: isVisionModelId(freeModelIdOf(o)),
        price: o.free ? 0 : null, autoProbe: true,
        // WorkBuddy 云端免费走账号池网关：同池每轮主动只测一个（护栏⑦），其余吃被动数据
        poolKey: (!o.upstream && !o.apisFree && !o.localModel) ? 'wb-cloud' : undefined,
      })
    }
    for (const o of ownOptions) {
      const acct = o.account!
      const gated = acct.providerId === 'inferbase' || acct.providerId === 'oneai' || acct.providerId === 'anyapi' || acct.providerId === 'moma' || acct.providerId === 'tokenrouter'
      for (const e of enginesFor(acct.providerId)) {
        out.push({
          id: `own:${acct.id}:${e.id}`, name: e.name, platformName: platformNameOf(o), platformKey: `own:${acct.id}`,
          group: groupOf(o.category), vision: isVisionModelId(e.id), price: e.multiplier ?? null,
          // 护栏：MoMA 只自动测自营九天（合作模型按量扣费不进自动探测，469 口径）；
          // 门槛平台的冒烟由健康检查负责，探测中心只吃其被动结果，不重复烧额度。
          // TokenRouter（v0.1.514）：两个免费模型同口径只吃被动播种；付费版按普通
          // 自有账户模型口径可主动探测，但仅限冒烟已通过的账户（未验证不发请求）。
          autoProbe: acct.providerId === 'moma' ? isMomaAutoTestable(e.id)
            : acct.providerId === 'tokenrouter' ? (!isTokenRouterFreeModel(e.id) && tokenRouterGate(acct).enabled)
            : !gated,
          accountId: acct.id,
        })
      }
    }
    return out
  }, [allOptions, ownOptions])
  const probeTargetsRef = useRef(probeTargets)
  probeTargetsRef.current = probeTargets
  const allOptionsRef = useRef(allOptions)
  allOptionsRef.current = allOptions
  useEffect(() => { if (probeTargets.length) syncProbeTargets(probeTargets) }, [probeTargets])

  const probeSummaryNow = probeSummary(probeTargets, probeStore.results)
  const probeUnavail = unavailableTargets(probeTargets, probeStore.results)

  /** 被动播种：健康检查（账户+Key 指纹冒烟）与四平台门槛的既有结论直接作探测结果，
   *  同一事实不测两遍；只播种不覆盖（seedProbeOutcome 内部保证） */
  const seedPassiveProbe = useCallback(() => {
    const health = loadKeyHealth()
    for (const o of ownOptions) {
      const acct = o.account!
      const eng = defaultChatEngine(acct.providerId) ?? enginesFor(acct.providerId)[0]?.id
      if (!eng) continue
      const id = `own:${acct.id}:${eng}`
      const h = health[acct.id]
      if (h && h.status !== 'pending' && h.status !== 'skipped') {
        seedProbeOutcome(id, {
          ok: h.status === 'ok', ms: h.latencyMs || undefined, source: 'passive',
          failKind: h.status === 'auth' ? 'auth' : h.status === 'quota' || h.status === 'rate' ? 'quota' : h.status === 'model' ? 'model' : h.status === 'network' ? 'network' : 'other',
          failReason: h.message?.slice(0, 80),
        }, h.checkedAt)
      }
      const gate = acct.providerId === 'inferbase' ? inferbaseGate(acct)
        : acct.providerId === 'oneai' ? oneAiGate(acct)
        : acct.providerId === 'anyapi' ? anyApiGate(acct)
        : acct.providerId === 'tokenrouter' ? tokenRouterGate(acct)
        : acct.providerId === 'moma' ? momaGate(acct) : null
      if (gate && gate.state !== 'pending_verification') {
        seedProbeOutcome(id, {
          ok: gate.enabled, source: 'passive',
          failKind: gate.enabled ? undefined : 'other', failReason: gate.enabled ? undefined : gate.message.slice(0, 80),
        }, Date.now())
      }
    }
  }, [ownOptions])

  /** 主动探测单个目标：分层——先列表接口验 Key/模型在不在，过关才发最小真请求测速 */
  const probeOneTarget = async (t: ProbeTarget): Promise<void> => {
    const opt = allOptionsRef.current.find(o => o.key === t.id)
    if (opt && !opt.account) {
      // 第一层：模型列表里在不在
      if (opt.upstream && !upstreamModels.some(m => m.source === opt.upstream && m.id === freeModelIdOf(opt))) {
        recordProbeOutcome(t.id, { ok: false, source: 'active', failKind: 'model' })
        return
      }
      if (opt.apisFree && !apisFreeReady(apisFreeState)) {
        recordProbeOutcome(t.id, { ok: false, source: 'active', failKind: 'other', failReason: '通道未开启或未测活' })
        return
      }
      if (opt.localModel && !localModels.includes(opt.localModel)) {
        recordProbeOutcome(t.id, { ok: false, source: 'active', failKind: 'network', failReason: '本地服务未运行' })
        return
      }
      // 第二层：最小真请求
      if (opt.localModel) {
        const t0 = Date.now()
        try {
          const r = await Promise.race([
            callLocalChat('http://127.0.0.1:11434', opt.localModel, [{ role: 'user', content: 'Reply with OK' }]),
            new Promise<never>((_, rej) => { setTimeout(() => rej(new Error('响应超时')), 12000) }),
          ])
          if (!r.ok) throw new Error(r.error || '本地模型调用失败')
          recordProbeOutcome(t.id, { ok: true, ms: Date.now() - t0, source: 'active' })
        } catch (e) { const c = classifyProbeError(e); recordProbeOutcome(t.id, { ok: false, source: 'active', failKind: c.kind, failReason: c.reason, retryAfterSec: c.retryAfterSec }) }
        return
      }
      const r = await testFreeAiOption(toFreeAiOption(opt), 12000)
      if (r.ok) recordProbeOutcome(t.id, { ok: true, ms: r.ms, source: 'active' })
      else { const c = classifyProbeError(new Error(r.error || '测活失败')); recordProbeOutcome(t.id, { ok: false, source: 'active', failKind: c.kind, failReason: c.reason, retryAfterSec: c.retryAfterSec }) }
      return
    }
    // 自有账户引擎：需要本次会话可用的凭据；没有凭据只吃被动数据，不在此报错
    const acct = accounts.find(a => a.id === t.accountId)
    if (!acct?.encryptedKey) return
    const pwd = resolvePwd()
    if (!pwd) return
    const engineId = t.id.slice(`own:${acct.id}:`.length)
    let key: string
    try { key = await decryptSecret(acct.encryptedKey, pwd) } catch { return }
    // 第一层：列表接口验 Key 有效与服务可达（拉不到才记失败）。
    // 注意：内置引擎目录与平台实时清单常不一致，「列表里没有」不等于模型不存在——
    // 真不存在由第二层真请求的 model_not_found 坐实，不在此误判（避免假不可用）。
    try {
      await fetchProviderModels(acct, key)
    } catch (e) { const c = classifyProbeError(e); recordProbeOutcome(t.id, { ok: false, source: 'active', failKind: c.kind, failReason: c.reason, retryAfterSec: c.retryAfterSec }); return }
    // 第二层：1-token 级真请求
    const t0 = Date.now()
    try {
      const r = await callChat(acct, key, [{ role: 'user', content: 'Reply with OK' }], engineId)
      if (!r.ok) throw new Error(r.error || r.text || '调用失败')
      recordProbeOutcome(t.id, { ok: true, ms: Date.now() - t0, source: 'active' })
    } catch (e) { const c = classifyProbeError(e); recordProbeOutcome(t.id, { ok: false, source: 'active', failKind: c.kind, failReason: c.reason, retryAfterSec: c.retryAfterSec }) }
  }
  const probeOneTargetRef = useRef(probeOneTarget)
  probeOneTargetRef.current = probeOneTarget

  /** 一轮主动探测：到期清单由 selectProbeBatch 纯判定（新鲜/退避/护栏）；
   *  执行侧礼让调度——用户正在聊天时暂停推进、每平台串行、全局并发 2 */
  const runProbeRound = useCallback(async (force = false) => {
    if (probingRef.current) return
    const store = loadProbeStore()
    const batch = selectProbeBatch(probeTargetsRef.current, store.results, Date.now(), { force })
    if (!batch.length) return
    probingRef.current = true
    setProbeRunning(true)
    try {
      const queues = new Map<string, ProbeTarget[]>()
      for (const t of batch) {
        const arr = queues.get(t.platformKey) ?? []
        arr.push(t)
        queues.set(t.platformKey, arr)
      }
      const lanes = [...queues.values()]
      let laneIdx = 0
      const laneWorker = async () => {
        while (laneIdx < lanes.length) {
          const lane = lanes[laneIdx++]
          for (const t of lane) {
            // 礼让：用户正在聊天时等空档（最多等约 30 秒，仍不抢占发送）
            for (let w = 0; w < 40 && generatingRef.current; w++) await new Promise(r => setTimeout(r, 750))
            await probeOneTargetRef.current(t).catch(() => { /* 单项失败已记结果，不中断整轮 */ })
          }
        }
      }
      await Promise.all([laneWorker(), laneWorker()])
      if (force) {
        const after = loadProbeStore()
        const cur = allOptionsRef.current.find(o => o.key === model)
        const curTarget = cur ? probeTargetsRef.current.find(t => t.id === cur.key) : undefined
        if (curTarget && after.results[curTarget.id] && !after.results[curTarget.id].ok) {
          notify(t('当前所选模型 {name} 刚检测未通过，可换一个模型；直接发送时若开了自动切换会顺延到下一条免费路线', { name: curTarget.name }), 'err')
        } else {
          const s = probeSummary(probeTargetsRef.current, after.results)
          notify(t('探测完成：{ok}/{total} 个模型可用', { ok: s.ok, total: s.total }))
        }
      }
    } finally {
      probingRef.current = false
      setProbeRunning(false)
    }
  }, [model, notify, t])

  // 进入 AI 助手：先播种被动事实，再后台测一轮过期/未测项（新鲜的直接用缓存）。
  // 手机端只做轻量版：只播种被动数据，不主动发探测请求（护栏⑥）。
  const probeKickRef = useRef(0)
  useEffect(() => {
    if (!probeTargets.length) return
    seedPassiveProbe()
    const now = Date.now()
    if (now - probeKickRef.current < 60_000) return
    probeKickRef.current = now
    const isMobileShell = typeof window !== 'undefined' && window.matchMedia?.('(max-width: 860px)').matches
    if (!isMobileShell) void runProbeRound(false)
  }, [probeTargets, seedPassiveProbe, runProbeRound])

  /** 面板「单测」：单个目标立即测一次（护栏目标也可手动单测，如 MoMA 合作模型） */
  const probeSingle = async (target: ProbeTarget) => {
    if (probeSingleId) return
    if (target.accountId && !resolvePwd()) { notify(t('单测自有账户模型需先在本页验证主密码')); return }
    setProbeSingleId(target.id)
    try { await probeOneTarget(target) } finally { setProbeSingleId('') }
  }

  /** 菜单/面板里点选一个探测目标（不可用也可点选：探测不拦发送、不拦选择） */
  const selectProbeTarget = (t: ProbeTarget) => {
    setModelOpen(false)
    setProbePanelOpen(false)
    if (t.accountId) {
      const o = allOptionsRef.current.find(x => x.account?.id === t.accountId)
      if (o) {
        setCategory(o.category); setModel(o.key); saveModel(o.key)
        setEngineId(t.id.slice(`own:${t.accountId}:`.length))
      }
      return
    }
    const o = allOptionsRef.current.find(x => x.key === t.id)
    if (!o) return
    setCategory(o.category)
    if (o.free) selectFreeModel(o)
    else { setModel(o.key); saveModel(o.key) }
  }
  // 选中项变化时平台上下文跟随其所属平台（用户在第二段里临时浏览其他平台时不覆盖，
  // 只在选中项真正变化时同步，避免浏览态被弹回）
  const lastModelKeyRef = useRef('')
  useEffect(() => {
    if (model === lastModelKeyRef.current) return
    lastModelKeyRef.current = model
    setPlatformKey(selectedOption ? platformKeyOf(selectedOption) : '')
  }, [model, selectedOption])
  const canChat = !selectedOption || selectedOption.free || CATEGORY_META[selectedOption.category].canChat
  // 当前自有账户 → 引擎列表：动态拉取优先，内置目录兜底
  const currentAccount = selectedOption?.account ?? null

  /**
   * 自有模型解密凭据：与 Key 管理页的解锁状态完全独立。
   * 优先用指纹/人脸模式保存的凭据自动解密（无感）；纯密码模式用本次会话内输入并验证过的密码。
   * 这样"解锁"只作用于 Key 管理页，AI 助手不再受其影响，所有平台一致。
   */
  const resolvePwd = useCallback(() => getBiometricPassword() || aiPwd || '', [aiPwd])
  const hasCredential = !!getBiometricPassword() || !!aiPwd
  const needPwd = !!currentAccount && !!currentAccount.encryptedKey && !hasCredential

  /** 在 AI 页内验证主密码（本次会话记住，验证成功才可用） */
  const verifyAiPwd = async () => {
    if (!aiPwdInput) return
    setAiPwdBusy(true)
    try {
      const ok = await verifyVault(aiPwdInput)
      if (!ok) { notify(t('主密码错误')); return }
      setAiPwd(aiPwdInput)
      setAiPwdInput('')
      notify(t('已验证，本次会话调用自有模型无需再次输入'))
    } finally { setAiPwdBusy(false) }
  }

  const engines = useMemo(() => {
    if (!currentAccount) return []
    if (engineSource === 'remote' && remoteEngines?.length) return enginesFromRemote(currentAccount.providerId, remoteEngines)
    return enginesFor(currentAccount.providerId)
  }, [currentAccount, engineSource, remoteEngines])
  const selectedEngine = engines.find(e => e.id === engineId) ?? null

  useEffect(() => {
    // 兜底：当前分类不在展示列表（如旧存档停在生图型），或当前模型已不在选项里，先清掉再重选
    if (!AI_CATEGORIES.includes(category) || (model && allOptions.length > 0 && !allOptions.some(o => o.key === model))) {
      setModel('')
      if (!AI_CATEGORIES.includes(category)) setCategory('免费模型')
      return
    }
    if (model || allOptions.length === 0) return
    const saved = loadModel()
    if (saved && allOptions.some(o => o.key === saved)) { setModel(saved); return }
    // 默认从当前分类选；当前分类为空则切到第一个有模型的分类
    const inCategory = allOptions.filter(o => o.category === category)
    if (inCategory.length) { setModel(inCategory[0].key); return }
    const firstCat = AI_CATEGORIES.find(c => allOptions.some(o => o.category === c))
    if (firstCat) { setCategory(firstCat); setModel(allOptions.find(o => o.category === firstCat)!.key) }
  }, [allOptions, model, category])

  // 本地服务被全部关闭时，若当前停在「本地型」则自动切到有模型的分类，避免停留在隐藏分类的空列表
  useEffect(() => {
    if (category === '本地型' && !shouldShowLocalCategory(settings)) {
      const firstCat = AI_CATEGORIES.find(c => c !== '本地型' && allOptions.some(o => o.category === c))
      if (firstCat) {
        setCategory(firstCat)
        setModel(allOptions.find(o => o.category === firstCat)?.key ?? '')
      }
    }
  }, [settings, category, allOptions])

  // 选中自有账户后：用其 Key 动态拉取真实可用引擎（/v1/models）；失败回退内置目录
  useEffect(() => {
    let alive = true
    setRemoteEngines(null)
    if (!currentAccount) { setEngineSource('none'); return () => { alive = false } }
    const acct = currentAccount
    const pwd = resolvePwd()
    if (!acct.encryptedKey || !pwd) {
      setEngineSource('builtin')
      return () => { alive = false }
    }
    ;(async () => {
      setLoadingEngines(true)
      try {
        const key = await decryptSecret(acct.encryptedKey!, pwd)
        const ids = await fetchProviderModels(acct, key)
        if (!alive) return
        setRemoteEngines(ids)
        setEngineSource('remote')
      } catch {
        if (!alive) return
        setEngineSource('builtin')  // 拉取失败（CORS/Key无权限/私有协议）→ 内置目录
      } finally { if (alive) setLoadingEngines(false) }
    })()
    return () => { alive = false }
  }, [currentAccount, resolvePwd])

  // 引擎列表变化时：保留仍有效的选择；失效（换平台/列表刷新后不在列）即清空回未选，
  // 不自动替选（v0.1.496 三段选择器口径：第三段未选时按钮显示空）。发送时 engineId
  // 为空走平台默认引擎（callByCategory 的既有兜底），生效逻辑不变。
  useEffect(() => {
    if (currentAccount) {
      setEngineId(prev => engines.some(e => e.id === prev) ? prev : '')
    } else setEngineId('')
  }, [currentAccount, engines])

  /** 统一取回复：用户自己的账户走其 API，否则走平台免费模型 */
  const getReply = async (content: string, history: ChatMessage[], signal?: AbortSignal, images?: string[], voiceMode = false, optKey?: string, onDelta?: (d: string) => void, convId?: string): Promise<string> => {
    const opt = allOptions.find(o => o.key === (optKey ?? model))
    const isFirstReply = !history.some(m => m.role === 'assistant')
    const systemPrompt = voiceMode
      ? buildVoiceSystemPrompt(botProfile, userProfile)
      : buildIdentitySystemPrompt(botProfile, userProfile, isFirstReply)
    // 引用我的数据：把本地额度/消费/签到摘要附加到 system 提示（语音通话不附，保持低延迟）
    let effectiveSystemPrompt = systemPrompt
    if (useMyData && !voiceMode) {
      try { effectiveSystemPrompt = `${systemPrompt}\n\n${buildDataDigest(loadState())}` } catch { /* 摘要生成失败不阻断对话 */ }
    }
    // AI 记忆（设置开启）：把其他历史会话的近期上下文附加进 system 提示，让助手记得之前聊过什么（语音通话不附）
    if (settings?.aiMemory && !voiceMode) {
      try {
        const others = [...sessionStoreRef.current.sessions]
          .filter(s => s.id !== sessionStoreRef.current.activeId && s.messages.length > 0)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 6)
        if (others.length) {
          const parts = others.map(s => `【历史会话：${s.title}】\n${s.messages.slice(-8).map(m => `${m.role === 'user' ? '用户' : 'AI'}：${m.content.slice(0, 300)}`).join('\n')}`)
          effectiveSystemPrompt += `\n\n以下是用户在其他历史会话中聊过的内容（AI 记忆），回答时可参考这些背景，但不要主动复述无关内容：\n${parts.join('\n\n')}`.slice(0, 6500)
        }
      } catch { /* 记忆拼装失败不阻断对话 */ }
    }
    // 联网搜索（v0.1.318）：开启时先真实搜索并抓取原文，资料附进 system 提示并强约束
    // 「依据资料作答、标注来源、没有就说没有、不许猜」；来源存 ref 供 send() 附在回答末尾。
    // 搜索失败/无结果不阻断对话：提示一句后按普通对话继续（语音通话不附，保持低延迟）
    searchSourcesRef.current = []
    if (webSearchOn && !voiceMode) {
      if (!onDelta) setStreamingText(t('🔍 正在联网搜索…'))
      setSearching(true)
      try {
        const ctx = await buildSearchContextCached(content)
        if (ctx) {
          // 工具调用同开时让位（v0.1.324）：搜索资料只作垫底参考，工具拿到更直接的结果以工具为准，
          // 且不许用「资料里没有」开场白绑架回答（Ethan 实测 DeepWiki 问题被搜索资料抢戏）
          const toolsYield = loadToolCallingEnabled()
            ? '若你通过工具调用获得了更直接的资料，以工具结果为准，不必受搜索资料有无的限制，也不要以「搜索资料中没有提到」作为开场。'
            : '资料里没有提到的不要编造、不要猜测，明确说明「搜索资料中没有提到」。'
          effectiveSystemPrompt += `\n\n${ctx.block}\n\n回答要求：涉及事实的问题必须优先依据上面【联网搜索资料】作答，并在对应内容后标注来源编号（如 [1]）；${toolsYield}`
          searchSourcesRef.current = ctx.sources
        } else if (!onDelta) notify(t('联网搜索没拿到结果，已按普通对话回答'))
      } catch { if (!onDelta) notify(t('联网搜索失败，已按普通对话回答')) }
      finally { setSearching(false) }
    }
    // 语音模式：关闭推理、只带最近 2 条上下文，最大限度缩短首字延迟
    const effectiveReasoning = voiceMode ? undefined : toReasoningEffort(reasoning)
    const voiceHistory = voiceMode ? history.slice(-2) : history
    // ---- 免费路线自动切换链（v0.1.433）：候选只含免费类（云端/Zen/Kilo、已验证启用的
    // Inferbase / One AI / AnyAPI、WorkBuddy 账号池、APIsFreeLLM 兜底、TokenRouter 末位
    // （v0.1.514，只用其免费模型））；自有付费账户永不被自动切入 ----
    const chainMsgs = [{ role: 'system', content: effectiveSystemPrompt }, ...voiceHistory.map(m => ({ role: m.role, content: m.content })), { role: 'user', content }]
    const chainFid = (o: (typeof allOptions)[number]) => (o.apisFree ? APISFREE_MODEL : (o.upstream ? o.key.slice(`up:${o.upstream}:`.length) : o.key))
    type AiCand = { id: string; label: string; kind: string; opt?: (typeof allOptions)[number]; acct?: Account; pool?: boolean }
    const buildAiChain = (selectedKey?: string, excludeId?: string): { cands: AiCand[]; byId: Map<string, AiCand> } => {
      const list: AiCand[] = []
      for (const o of allOptions.filter(x => x.free)) list.push({ id: o.key, label: o.label, kind: o.apisFree ? 'apisfree' : (o.upstream ?? 'cloud'), opt: o })
      for (const o of allOptions.filter(x => x.account?.providerId === 'inferbase')) {
        if (o.account && inferbaseGate(o.account).enabled) list.push({ id: `inferbase:${o.account.id}`, label: o.account.label, kind: 'inferbase', acct: o.account })
      }
      for (const o of allOptions.filter(x => x.account?.providerId === 'oneai')) {
        if (o.account && oneAiGate(o.account).enabled) list.push({ id: `oneai:${o.account.id}`, label: o.account.label, kind: 'oneai', acct: o.account })
      }
      for (const o of allOptions.filter(x => x.account?.providerId === 'anyapi')) {
        if (o.account && anyApiGate(o.account).enabled) list.push({ id: `anyapi:${o.account.id}`, label: o.account.label, kind: 'anyapi', acct: o.account })
      }
      // TokenRouter（v0.1.514）：已验证启用的才进候选，kind=tokenrouter 排全链末位；
      // 链上只发免费模型（aiChainAttemptInner 按 kind 选免费主力款），付费版不进链。
      for (const o of allOptions.filter(x => x.account?.providerId === 'tokenrouter')) {
        if (o.account && tokenRouterGate(o.account).enabled) list.push({ id: `tokenrouter:${o.account.id}`, label: o.account.label, kind: 'tokenrouter', acct: o.account })
      }
      try { if (hasPoolAccounts()) list.push({ id: 'wbpool', label: 'WorkBuddy 账号池', kind: 'wbpool', pool: true }) } catch { /* 池不可用 */ }
      const filtered = excludeId ? list.filter(c => c.id !== excludeId) : list
      const ordered = orderChainCandidates(selectedKey ?? '', filtered)
      return { cands: ordered, byId: new Map(ordered.map(c => [c.id, c])) }
    }
    // v0.1.504 被动探测：免费链每次真实尝试的成败顺手记入全局探测中心（零额外额度）。
    // 候选→目标：免费选项=选项键；已验证自有账户=其默认引擎目标；账号池不是单个模型，不记。
    const aiChainAttempt = async (cand: AiCand, ctx: { markEmitted: () => void }): Promise<string> => {
      const t0 = Date.now()
      let firstDeltaAt = 0
      const wrappedCtx = { markEmitted: () => { if (!firstDeltaAt) firstDeltaAt = Date.now(); ctx.markEmitted() } }
      try {
        const text = await aiChainAttemptInner(cand, wrappedCtx)
        const targetId = cand.opt ? cand.id : cand.acct ? `own:${cand.acct.id}:${defaultChatEngine(cand.acct.providerId) ?? enginesFor(cand.acct.providerId)[0]?.id ?? ''}` : ''
        if (targetId && probeTargetsRef.current.some(x => x.id === targetId)) {
          recordProbeOutcome(targetId, { ok: true, ms: (firstDeltaAt || Date.now()) - t0, source: 'passive' })
        }
        return text
      } catch (e) {
        const targetId = cand.opt ? cand.id : cand.acct ? `own:${cand.acct.id}:${defaultChatEngine(cand.acct.providerId) ?? enginesFor(cand.acct.providerId)[0]?.id ?? ''}` : ''
        if (targetId && probeTargetsRef.current.some(x => x.id === targetId)) {
          const c = classifyProbeError(e)
          recordProbeOutcome(targetId, { ok: false, source: 'passive', failKind: c.kind, failReason: c.reason, retryAfterSec: c.retryAfterSec })
        }
        throw e
      }
    }
    const aiChainAttemptInner = async (cand: AiCand, ctx: { markEmitted: () => void }): Promise<string> => {
      if (cand.pool) {
        const r = await poolChat(resolvePwd(), chainMsgs)
        return r.text
      }
      if (cand.acct) {
        const key = await decryptSecret(cand.acct.encryptedKey!, resolvePwd())
        const model = cand.kind === 'oneai'
          ? (defaultChatEngine('oneai') || ONEAI_SMOKE_MODEL)
          : cand.kind === 'anyapi'
            ? (getAnyApiSmokeModel(cand.acct.id) || defaultChatEngine('anyapi') || '')
            : cand.kind === 'tokenrouter'
              // 链上恒用免费模型：冒烟用通的免费款，无记录回落精选清单免费主力款
              ? (getTokenRouterSmokeModel(cand.acct.id) || TOKENROUTER_SMOKE_MODEL)
              : (defaultChatEngine('inferbase') || 'auto')
        const r = await callChat(cand.acct, key, chainMsgs, model)
        if (!r.ok) throw new Error(r.error || r.text || '调用失败')
        return r.text
      }
      const o = cand.opt!
      if (o.apisFree) {
        const text = await chatApisFree(chainMsgs)
        if (onDelta) onDelta(text); else setStreamingText(text)
        return text
      }
      if (o.upstream) {
        const text = await chatUpstream(o.upstream, chainFid(o), chainMsgs, effectiveReasoning)
        if (onDelta) onDelta(text); else setStreamingText(text)
        return text
      }
      // 云端免费走流式：已吐字后失败由 chain 判定为 partial，不自动重发（避免回答混杂）
      return streamChat(o.key, voiceHistory, content, delta => { ctx.markEmitted(); if (onDelta) onDelta(delta); else setStreamingText(prev => prev + delta) }, signal, images, effectiveReasoning, effectiveSystemPrompt, convId)
    }
    const aiChainAvailability = (cand: AiCand): ChainAvailability | null => {
      if (cand.acct && (!cand.acct.encryptedKey || !resolvePwd())) return { available: false, probe: false, reason: '保险箱未解锁，无法使用该账户路线' }
      // v0.1.470：账号池凭据已改设备本地加密，锁定状态照常可用，不再拦
      return null
    }
    const runAiChain = async (selectedKey?: string, excludeId?: string) => {
      const { cands, byId } = buildAiChain(selectedKey, excludeId)
      return runFreeChain(
        cands.map(c => ({ id: c.id, label: c.label, kind: c.kind } satisfies ChainCandidate)),
        (cand, ctx) => aiChainAttempt(byId.get(cand.id)!, ctx),
        { extraAvailability: cand => aiChainAvailability(byId.get(cand.id)!) },
      )
    }
    // 注：旧版把链的成败同步进模型菜单的测活标记；v0.1.496 起第三段列表只展示
    // 模型名、不再打标，切换结果由下方 notify 逐条明示，标记逻辑随之移除。
    // 用户自己的账户：用其 Key 真正调用
    if (opt?.account) {
      const acct = opt.account
      // Inferbase 启用门槛（v0.1.432）：未冒烟通过不调用、不自动切换，打标让上层原样展示真实原因
      if (acct.providerId === 'inferbase') {
        const gate = inferbaseGate(acct)
        if (!gate.enabled) throw Object.assign(new Error(gate.message), { inferbaseGate: true })
      }
      // One AI 启用门槛（v0.1.434）：与 Inferbase 同口径，未冒烟通过不调用、不自动切换
      if (acct.providerId === 'oneai') {
        const gate = oneAiGate(acct)
        if (!gate.enabled) throw Object.assign(new Error(gate.message), { oneaiGate: true })
      }
      // AnyAPI 启用门槛（v0.1.435）：与 Inferbase / One AI 同口径，未冒烟通过不调用、不自动切换
      if (acct.providerId === 'anyapi') {
        const gate = anyApiGate(acct)
        if (!gate.enabled) throw Object.assign(new Error(gate.message), { anyapiGate: true })
      }
      // MoMA 启用门槛（v0.1.456）：与 AnyAPI 同口径，未冒烟通过不调用；MoMA 是付费平台，
      // 本就不进自动切换链（buildAiChain 不收 moma 候选），这里只管手动直选的发送拦截
      if (acct.providerId === 'moma') {
        const gate = momaGate(acct)
        if (!gate.enabled) throw Object.assign(new Error(gate.message), { momaGate: true })
      }
      // TokenRouter 启用门槛（v0.1.514）：与 AnyAPI 同口径，未冒烟通过不调用、不自动切换
      if (acct.providerId === 'tokenrouter') {
        const gate = tokenRouterGate(acct)
        if (!gate.enabled) throw Object.assign(new Error(gate.message), { tokenrouterGate: true })
      }
      if (!acct.encryptedKey) throw new Error(t('该账户未配置 API Key，请在 API Key 管理页添加'))
      const pwd = resolvePwd()
      if (!pwd) {
        // 不再拦截去 Key 管理页解锁，就地提示输入本次会话密码（见输入区上方的内嵌输入）
        notify(t('请输入主密码以调用自有模型（本次会话只需一次）'))
        throw Object.assign(new Error('__NEED_AI_PWD__'), { needPwd: true })
      }
      setResolvingKey(true)
      let apiKey: string
      try { apiKey = await decryptSecret(acct.encryptedKey, pwd) }
      catch {
        // 解密失败通常意味着：保险箱材料已变更（改过主密码/重置/云同步覆盖），或该 Key 是用另一个主密码加密的
        const hint = t('此 API Key 无法解密：保险箱主密码已变更或该密钥由另一主密码加密。请到「设置 → 安全」用当前主密码重新添加该 Key')
        notify(hint)
        throw Object.assign(new Error(hint), { needPwd: true })
      }
      finally { setResolvingKey(false) }
      const msgs = [{ role: 'system', content: effectiveSystemPrompt }, ...voiceHistory.map(m => ({ role: m.role, content: m.content })), { role: 'user', content }]
      // 引擎必须与账户匹配：主选账户用当前所选引擎；对比/换 Key 重试等异账户调用用该平台自己的默认引擎，
      // 否则会把主选模型的 id（如 glm-4.6）发给别的平台接口（如 DeepSeek）导致 400
      const mainOpt = allOptions.find(o => o.key === model)
      const sameAsMain = !optKey || mainOpt?.account?.id === acct.id
      const engForCall = sameAsMain ? (engineId || undefined) : (enginesFor(acct.providerId)[0]?.id || undefined)
      // 对话自动调用工具（v0.1.317）：开关开 + 有已连接的 MCP 工具 + 可对话分类时走工具循环，
      // 模型可自主调用 MCP 工具（抓网页/读文件等）；否则维持原路径
      if (CATEGORY_META[opt.category].canChat && loadToolCallingEnabled()) {
        const collected = collectMcpTools()
        if (collected.defs.length > 0) {
          const outcome = await runToolChatLoop({
            account: acct, apiKey, engineId: engForCall, reasoningEffort: effectiveReasoning, messages: msgs, collected,
            onToolStart: info => { if (!onDelta) setStreamingText(t('🔧 正在调用工具：{name}', { name: `${info.serverName} · ${info.toolName}` })) },
          })
          { // v0.1.504 被动探测：工具循环真实调用成功记入探测中心
            const probeId = `own:${acct.id}:${engForCall ?? defaultChatEngine(acct.providerId) ?? enginesFor(acct.providerId)[0]?.id ?? ''}`
            if (probeTargetsRef.current.some(x => x.id === probeId)) recordProbeOutcome(probeId, { ok: true, source: 'passive' })
          }
          let text = outcome.text
          if (outcome.events.length) {
            text += `\n\n${t('🔧 本次调用了 {n} 次工具：{list}', { n: String(outcome.events.length), list: outcome.events.map(e => `${e.serverName}·${e.toolName}${e.ok ? ' ✓' : ' ✗'}`).join('、') })}`
          }
          if (outcome.toolsUnsupported) text += `\n\n${t('（当前模型不支持工具调用，已按普通对话回答）')}`
          if (onDelta) onDelta(text); else setStreamingText(text)
          return text
        }
      }
      const callT0 = Date.now()
      const r = await callByCategory(acct, apiKey, opt.category, msgs, engForCall, effectiveReasoning)
      // v0.1.504 被动探测：自有账户真实调用结果记入探测中心对应引擎目标（零额外额度）
      {
        const probeId = `own:${acct.id}:${engForCall ?? defaultChatEngine(acct.providerId) ?? enginesFor(acct.providerId)[0]?.id ?? ''}`
        if (probeTargetsRef.current.some(x => x.id === probeId)) {
          if (r.ok) recordProbeOutcome(probeId, { ok: true, ms: Date.now() - callT0, source: 'passive', vision: images?.length ? true : undefined })
          else { const c = classifyProbeError(new Error(r.error ?? '调用失败')); recordProbeOutcome(probeId, { ok: false, source: 'passive', failKind: c.kind, failReason: c.reason, retryAfterSec: c.retryAfterSec, vision: images?.length ? false : undefined }) }
        }
      }
      if (!r.ok) {
        const errMsg = r.error ?? t('调用失败')
        // 自动切换（v0.1.433）：自有账户（含已验证的 Inferbase）聊天失败且属可切换类时，
        // 只切免费路线并明示；Inferbase 门槛错误在上方已拦下、不会走到这里。
        // 手动锁定 / 指定 optKey 的调用不切换，失败原样报真实原因。
        const cls = classifyChainError(new Error(errMsg))
        if (!optKey && loadChainMode() === 'auto' && CATEGORY_META[opt.category].canChat && failoverEligible(cls.kind)) {
          try {
            const res = await runAiChain(undefined, `${acct.providerId}:${acct.id}`)
            notify(`「${acct.label}」${CHAIN_KIND_REASON[cls.kind]}，已自动切换到「${res.usedLabel}」（免费路线）`)
            return res.text
          } catch (chainErr) {
            if (chainErr instanceof ChainPartialError) throw new Error(`${chainErr.message}（已输出部分内容，未自动重发；可点重试或换一个模型）`)
            if (chainErr instanceof ChainAllFailedError) throw new Error(`${errMsg}\n${chainErr.message}`)
            throw chainErr
          }
        }
        throw Object.assign(new Error(errMsg), { cors: r.cors })
      }
      if (r.images?.length) {
        return `${r.text}\n${r.images.map(u => u.startsWith('data:') ? t('[已生成图片]') : u).join('\n')}`
      }
      return r.text
    }
    // 本机 Ollama 模型：无需账户 Key，直接调本机服务（图片附件随多模态消息发送）
    if (opt?.localModel) {
      const msgs = [
        { role: 'system', content: effectiveSystemPrompt },
        ...voiceHistory.map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content },
      ]
      const localT0 = Date.now()
      const r = await callLocalChat('http://127.0.0.1:11434', opt.localModel, msgs, images)
      // v0.1.504 被动探测：本地模型真实调用结果记入探测中心（带图成功同时证明视觉可用）
      if (!r.ok) {
        const c = classifyProbeError(new Error(r.error ?? '本地模型调用失败'))
        recordProbeOutcome(opt.key, { ok: false, source: 'passive', failKind: c.kind, failReason: c.reason, vision: images?.length ? false : undefined })
        throw new Error(r.error ?? t('本地模型调用失败'))
      }
      recordProbeOutcome(opt.key, { ok: true, ms: Date.now() - localT0, source: 'passive', vision: images?.length ? true : undefined })
      return r.text
    }
    // 免费模型（云端免费 / Zen / Kilo / APIsFreeLLM）：自动模式走 freeChain 切换链——
    // 首选遇限流/额度/5xx/超时/空响应/网络问题时切下一条免费路线（含已验证 Inferbase 与
    // 账号池），切换原因明示，冷却/熔断中的路线自动跳过；流式已吐字后失败不重发。
    // 手动锁定或指定 optKey（对比/换 Key 重试）时只跑所选路线，失败原样抛出。
    if (opt?.free) {
      if (optKey || loadChainMode() === 'locked') {
        const single: AiCand = { id: opt.key, label: opt.label, kind: opt.apisFree ? 'apisfree' : (opt.upstream ?? 'cloud'), opt }
        return aiChainAttempt(single, { markEmitted: () => {} })
      }
      try {
        const res = await runAiChain(opt.key)
        if (res.usedId !== opt.key) {
          const usedOpt = allOptions.find(o => o.key === res.usedId)
          if (usedOpt?.free) { setModel(usedOpt.key); saveModel(usedOpt.key) }
          for (const s of res.switches) notify(`「${s.fromLabel}」${s.reason}，已自动切换到「${s.toLabel}」`)
        }
        return res.text
      } catch (e) {
        if (e instanceof ChainPartialError) throw new Error(`${e.message}（已输出部分内容，未自动重发；可点重试或换一个模型）`)
        if (e instanceof ChainAllFailedError) { throw new Error(e.message) }
        throw e
      }
    }
    // 自有账户等其他模型：流式输出
    return streamChat((model || 'auto'), voiceHistory, content, delta => { if (onDelta) onDelta(delta); else setStreamingText(prev => prev + delta) }, signal, images, effectiveReasoning, effectiveSystemPrompt, convId)
  }

  // 报错自动换 Key：调用失败（鉴权/额度类）时，若同平台还有别的可用账户，给出「一键切换重试」
  const [pendingRetry, setPendingRetry] = useState<{ text: string; altKey: string; altLabel: string } | null>(null)

  const send = async (text?: string, optKey?: string) => {
    const content = (text ?? input).trim()
    const hasAttach = attachments.length > 0
    if ((!content && !hasAttach) || generating) return
    // 对比模式：同一个问题并行发给所选的 2–3 个模型（换 Key 重试等带 optKey 的调用不走对比）
    if (compareMode && !optKey) {
      if (hasAttach) { notify(t('对比模式暂不支持附件，请先移除附件')); return }
      if (compareKeys.length < 2) { notify(t('对比模式：请先在上方选择至少 2 个模型')); return }
      await runCompare(content)
      return
    }
    const effectiveText = content || '请分析这些附件'
    if (!model && !optKey) { notify(t('模型尚未就绪，请稍候')); return }
    // 生图型/视频型：允许发送提示词，交给 callByCategory 调用生图/视频接口（不再拦截）
    // 自有模型需要先有解密凭据：给出持久可见的对话提示，避免"打字没反应"
    if (needPwd) {
      notify(t('请先在上方的密码框验证主密码，再发送消息'))
      setMessages(prev => [...prev,
        { id: `u-${Date.now()}`, role: 'user', content, at: Date.now() },
        { id: `err-${Date.now()}`, role: 'assistant', content: t('🔒 当前使用自有模型「{label}」，需先在上方密码框验证主密码（本次会话只需一次），验证后请重新发送。', { label: currentAccount?.label ?? '' }), at: Date.now() },
      ])
      return
    }
    setInput('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    const imageUrls = attachments.filter(a => a.mime.startsWith('image/')).map(a => a.dataUrl)
    const attachNote = attachments.length ? `\n${attachments.map(a => `[附件:${a.name}]`).join(' ')}` : ''
    // 文本/文档附件：把真实内容解码后随消息发给 AI。
    // 之前的版本只把文件名拼给用户气泡、AI 侧只收到有效文字，导致“AI 说看不到文件内容”。
    const textBlocks = (await Promise.all(attachments
      .filter(a => isTextAttachment(a) || needsBinaryParse(a.name))
      .map(async a => {
        let raw = ''
        if (needsBinaryParse(a.name)) {
          // PDF/Word：本地解析正文（与文档问答同一套解析器），解析失败明确标注，不让 AI 装作看过
          try {
            const bin = atob(a.base64)
            const bytes = new Uint8Array(bin.length)
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
            raw = (await parseBinaryDocument(a.name, bytes.buffer as ArrayBuffer)).text
          } catch { return `----- 附件：${a.name} -----\n${t('（该文档解析失败，AI 只能看到文件名）')}` }
        } else {
          raw = decodeAttachmentText(a)
        }
        const text = raw.length > 12000 ? `${raw.slice(0, 12000)}\n…（内容过长，已截断）` : raw
        return `----- 附件：${a.name} -----\n${text || '（该文件无可读文本内容）'}`
      })))
    const aiText = textBlocks.length ? `${effectiveText}\n\n${textBlocks.join('\n\n')}` : effectiveText
    const userMsg: ChatMessage = { id: `${Date.now()}-u`, role: 'user', content: effectiveText + attachNote, at: Date.now() }
    setMessages(prev => [...prev, userMsg])
    setAttachments([])
    setGenerating(true)
    setStreamingText('')
    const controller = new AbortController()
    abortRef.current = controller
    try {
      let answer = ''
      let failoverNote = ''
      try {
        answer = await getReply(aiText, messages, controller.signal, imageUrls, false, optKey)
      } catch (firstErr) {
        // 自动故障转移：鉴权/额度/限流类失败且同平台有备用账户时，自动换备用 Key 重试（最多 2 个），
        // 全部失败才落到外层 catch（保留手动换 Key 重试条）
        const fe = firstErr as { needPwd?: boolean; message?: string; inferbaseGate?: boolean; oneaiGate?: boolean; anyapiGate?: boolean; momaGate?: boolean; tokenrouterGate?: boolean }
        const retryable = !fe?.needPwd && !fe?.inferbaseGate && !fe?.oneaiGate && !fe?.anyapiGate && !fe?.momaGate && !fe?.tokenrouterGate && /401|403|unauthor|invalid|api ?key|余额|额度|quota|insufficient|身份验证|过期|429|rate limit/i.test(fe?.message ?? '')
        const failed0 = !optKey ? allOptions.find(o => o.key === model)?.account : undefined
        const alts = retryable && failed0
          ? ownOptions.filter(o => o.account && o.account.providerId === failed0.providerId && o.account.id !== failed0.id).slice(0, 2)
          : []
        if (!alts.length) throw firstErr
        let lastErr: unknown = firstErr
        let switched = ''
        for (const alt of alts) {
          try {
            answer = await getReply(aiText, messages, controller.signal, imageUrls, false, alt.key)
            switched = alt.account!.label
            break
          } catch (e2) { lastErr = e2 }
        }
        if (!switched) throw lastErr
        failoverNote = `\n\n${t('（原账户调用失败，已自动切换到备用账户「{label}」）', { label: switched })}`
        notify(t('已自动切换到备用账户「{label}」', { label: switched }))
      }
      setPendingRetry(null)
      setMessages(prev => [...prev, { id: `${Date.now()}-a`, role: 'assistant', content: (answer || t('（无回复内容）')) + failoverNote + (searchSourcesRef.current.length ? `\n\n${t('📎 信息来源：')}\n${searchSourcesRef.current.map((x, i) => `[${i + 1}] ${x.title}\n${x.url}`).join('\n')}` : ''), at: Date.now() }])
      // 自动朗读：AI 回复完成且未被中止时，朗读清洗后的纯文字
      if (autoSpeak && answer && !controller.signal.aborted) {
        const spoken = cleanForAutoSpeech(answer)
        if (spoken) {
          void speakAsync(spoken, botProfile.voiceURI ?? getSavedVoice(), (s) => {
            setSpeakingId(s === 'start' ? 'auto' : null)
          }, (reason) => notify(reason), {
            // v0.1.428：自动朗读失败也不再静默（服务没开时明确提示，不回落系统音色）
            onQwenServiceOff: (msg) => notify(msg),
          })
        }
      }
    } catch (e) {
      const need = (e as { needPwd?: boolean })?.needPwd
      // Inferbase / One AI / AnyAPI / MoMA / TokenRouter 门槛错误含真实状态与原因，原样展示（friendlyAiError 会把含「额度/401」的原文吞成泛化文案）
      const gateErr = e as { inferbaseGate?: boolean; oneaiGate?: boolean; anyapiGate?: boolean; momaGate?: boolean; tokenrouterGate?: boolean }
      const msg = gateErr?.inferbaseGate || gateErr?.oneaiGate || gateErr?.anyapiGate || gateErr?.momaGate || gateErr?.tokenrouterGate ? ((e as Error)?.message ?? '') : friendlyAiError(e)
      // needPwd 的情况：不重复 toast（顶部已有常驻解锁条），但仍需在对话里给出可见提示
      if (!need && msg !== '已停止生成' && !String(msg).includes('NEED_AI_PWD')) notify(msg)
      // 鉴权/额度类失败且同平台有备用账户 → 提供一键换 Key 重试（密码未验证/用户中止不触发）
      if (!need && msg !== '已停止生成') {
        const raw = `${(e as Error)?.message ?? ''} ${msg}`
        if (/401|403|unauthor|invalid|api ?key|余额|额度|quota|insufficient|身份验证|过期/i.test(raw)) {
          const failed = allOptions.find(o => o.key === (optKey ?? model))?.account
          const alt = failed ? ownOptions.find(o => o.account && o.account.providerId === failed.providerId && o.account.id !== failed.id) : undefined
          if (failed && alt?.account) setPendingRetry({ text: aiText, altKey: alt.key, altLabel: alt.account.label })
        }
      }
      setStreamingText(prev => {
        if (prev) setMessages(p => [...p, { id: `${Date.now()}-a`, role: 'assistant', content: prev, at: Date.now() }])
        else {
          // 失败时插入持久提示气泡，避免 toast 一闪而过看着像"没反应"
          const hint = need ? t('🔒 当前为自有模型，请先在上方的密码框验证主密码，然后重新发送。')
            : msg !== '已停止生成' && !String(msg).includes('NEED_AI_PWD') ? `⚠️ ${msg}` : null
          if (hint) setMessages(p => [...p, { id: `err-${Date.now()}`, role: 'assistant', content: hint, at: Date.now() }])
        }
        return ''
      })
    } finally {
      setGenerating(false)
      setStreamingText('')
      abortRef.current = null
    }
  }

  const stop = () => { abortRef.current?.abort(); setGenerating(false) }

  const toggleSpeak = (m: ChatMessage) => {
    // 正在合成：再点一次即取消（v0.1.428）
    if (synthId === m.id) {
      if (synthCancelRef.current) synthCancelRef.current.cancelled = true
      stopSpeak()
      setSynthId(null)
      return
    }
    if (speakingId === m.id) { stopSpeak(); setSpeakingId(null); return }
    const token = { cancelled: false }
    synthCancelRef.current = token
    let handled = false
    setSynthId(m.id)
    setSynthElapsed(0)
    void speakAsync(m.content, botProfile.voiceURI ?? getSavedVoice(), (state) => {
      if (state === 'start') setSynthId(null)
      if (state === 'end' || state === 'error') { setSpeakingId(null); setSynthId(null) }
    }, (reason) => { notify(reason); setSynthId(null) }, {
      onSynthProgress: (el) => setSynthElapsed(el),
      cancelToken: token,
      onQwenServiceOff: (msg) => { handled = true; setSynthId(null); notify(msg) },
    }).then(ok => {
      if (!ok) {
        setSynthId(null)
        // 服务没开/用户取消已有专门提示，不再补一句笼统的「不支持朗读」
        if (!handled && !token.cancelled) notify(t('当前环境不支持语音朗读'))
        return
      }
      setSpeakingId(m.id)
    })
  }

  useEffect(() => () => { stopSpeak() }, [])

  const clear = () => {
    if (generating) stop()
    setMessages([])
    setSessionStore(store => ({ ...store, sessions: store.sessions.map(s => s.id === store.activeId ? { ...s, title: '新对话' } : s) }))
    rotateConversationId()
    notify(t('已开启新对话'))
  }

  // ---- 对话搜索（当前会话内查找，命中高亮 + 上下跳转） ----
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchIdx, setSearchIdx] = useState(0)
  const searchMatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return [] as string[]
    return messages.filter(m => m.content.toLowerCase().includes(q)).map(m => m.id)
  }, [messages, searchQuery])
  const currentMatchId = searchMatches.length ? searchMatches[Math.min(searchIdx, searchMatches.length - 1)] : null
  // 容器内定位滚动（不用 scrollIntoView，避免连带滚动侧边栏/整页造成闪屏）
  const scrollMsgIntoCenter = (id: string) => {
    const el = document.getElementById(`aimsg-${id}`)
    const c = el?.closest('.ai-messages') as HTMLElement | null
    if (!el || !c) return
    const top = el.getBoundingClientRect().top - c.getBoundingClientRect().top + c.scrollTop - c.clientHeight / 2
    c.scrollTo({ top, behavior: 'smooth' })
  }
  const jumpMatch = (dir: 1 | -1) => {
    if (!searchMatches.length) return
    const next = (searchIdx + dir + searchMatches.length) % searchMatches.length
    setSearchIdx(next)
    scrollMsgIntoCenter(searchMatches[next])
  }
  useEffect(() => {
    if (searchMatches.length) {
      setSearchIdx(0)
      scrollMsgIntoCenter(searchMatches[0])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery])

  // ---- 对话导出（Markdown） ----
  const [exportOpen, setExportOpen] = useState(false)
  // 「引用我的数据」：开启后每次对话附带本地数据摘要（额度/消费/签到），助手可据此回答；默认开，记住选择
  const [useMyData, setUseMyData] = useState(() => { try { return localStorage.getItem('acm_ai_use_my_data') !== '0' } catch { return true } })
  const toggleUseMyData = () => {
    setUseMyData(v => {
      const next = !v
      try { localStorage.setItem('acm_ai_use_my_data', next ? '1' : '0') } catch { /* 忽略 */ }
      notify(next ? t('已开启「引用我的数据」：问额度、消费、签到时，助手会按你的真实数据回答') : t('已关闭「引用我的数据」：对话不再附带你的本地数据'))
      return next
    })
  }
  // 「联网搜索」：开启后回答前先真实搜索并抓原文，模型依据资料作答并标注来源；默认关，记住选择
  const [webSearchOn, setWebSearchOn] = useState(() => loadWebSearchEnabled())
  const searchSourcesRef = useRef<{ title: string; url: string }[]>([])
  const toggleWebSearch = () => {
    setWebSearchOn(v => {
      const next = !v
      saveWebSearchEnabled(next)
      notify(next ? t('已开启「联网搜索」：问事实类问题时，助手会先联网搜索、依据真实资料回答并标注来源') : t('已关闭「联网搜索」'))
      return next
    })
  }
  // ---- 多模型同问对比 ----
  const [compareMode, setCompareMode] = useState(false)
  const [compareKeys, setCompareKeys] = useState<string[]>([])
  const [compareRuns, setCompareRuns] = useState<Array<{ key: string; label: string; status: 'loading' | 'done' | 'error'; text: string; ms: number }> | null>(null)
  const toggleCompareKey = (k: string) => {
    setCompareKeys(prev => {
      if (prev.includes(k)) return prev.filter(x => x !== k)
      if (prev.length >= 3) { notify(t('对比最多选 3 个模型')); return prev }
      return [...prev, k]
    })
  }
  const runCompare = async (content: string) => {
    const history = messages
    setMessages(prev => [...prev, { id: `${Date.now()}-u`, role: 'user', content, at: Date.now() }])
    setInput('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    setGenerating(true)
    const controller = new AbortController()
    abortRef.current = controller
    setCompareRuns(compareKeys.map(k => ({ key: k, label: allOptions.find(x => x.key === k)?.label ?? k, status: 'loading' as const, text: '', ms: 0 })))
    await Promise.all(compareKeys.map(async (k) => {
      const t0 = Date.now()
      // 每列用独立 conversationId（共用主会话 id 并行发流会被网关互相顶掉）；失败自动重试一次
      const convId = `cmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const errText = (e: unknown): string => {
        if (e instanceof Error) return e.message || t('调用失败')
        if (typeof e === 'string') return e // Tauri invoke 拒绝值是字符串（Rust 侧的真实报错）
        return t('调用失败')
      }
      let lastErr: unknown = null
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (attempt > 0) {
            setCompareRuns(prev => prev ? prev.map(r => r.key === k ? { ...r, text: '' } : r) : prev)
            await new Promise(r => setTimeout(r, 800))
          }
          const ans = await getReply(content, history, controller.signal, undefined, false, k, (d) => {
            setCompareRuns(prev => prev ? prev.map(r => r.key === k ? { ...r, text: r.text + d } : r) : prev)
          }, convId)
          setCompareRuns(prev => prev ? prev.map(r => r.key === k ? { ...r, status: 'done' as const, text: ans || r.text, ms: Date.now() - t0 } : r) : prev)
          lastErr = null
          break
        } catch (e) {
          lastErr = e
          if ((e as { name?: string })?.name === 'AbortError') break
        }
      }
      if (lastErr !== null) {
        setCompareRuns(prev => prev ? prev.map(r => r.key === k ? { ...r, status: 'error' as const, text: errText(lastErr), ms: Date.now() - t0 } : r) : prev)
      }
    }))
    setGenerating(false)
  }
  // ---- 引擎可用性探测（给当前账户的对话引擎发一条极短消息验证真能出话） ----
  // v0.1.464：只探测真对话模型。聚合型 /v1/models 列表混有语音/生图/视频/向量等
  // 非对话模型，旧实现按列表顺序取前 12 个照单全 ping——MoMA 172 个模型按名称
  // 排序后前面全是 asr/bge/视频/语音与合作池模型，自营九天根本轮不到，且非对话
  // 模型回的 400 model_not_found 还会污染结论（实机「探测全红」主因）。现改为：
  // 非对话模型直接标记跳过（不发请求）、MoMA 先按九天自营优先排序再取前 12。
  const [probeResults, setProbeResults] = useState<Record<string, { ok: boolean; ms: number; error?: string; skipped?: boolean }>>({})
  const [probing, setProbing] = useState(false)
  const probeEngines = async () => {
    if (!currentAccount?.encryptedKey) { notify(t('当前账户未配置 Key，无法探测')); return }
    const pwd = resolvePwd()
    if (!pwd) { notify(t('请先解锁保险箱，再探测引擎可用性')); return }
    let apiKey = ''
    try { apiKey = await decryptSecret(currentAccount.encryptedKey, pwd) } catch { notify(t('Key 解密失败，无法探测')); return }
    const isMoma = currentAccount.providerId === MOMA_PROVIDER_ID
    const isCandidate = (id: string) => isMoma ? isMomaChatCandidate(id) : isChatProbeCandidate(id)
    const skipped = engines.filter(e => !isCandidate(e.id))
    const candidateIds = engines.filter(e => isCandidate(e.id)).map(e => e.id)
    const orderedIds = isMoma ? orderMomaProbeModels(candidateIds) : candidateIds
    const targetIds = orderedIds.slice(0, 12)
    const targets = targetIds
      .map(id => engines.find(e => e.id === id))
      .filter((e): e is NonNullable<typeof e> => !!e)
    setProbing(true)
    setProbeResults(Object.fromEntries(skipped.map(e => [e.id, {
      ok: false, ms: 0, skipped: true,
      error: t('非对话模型（语音/图像/视频/向量等），不参与聊天探测'),
    }])))
    await Promise.all(targets.map(async (e) => {
      const t0 = Date.now()
      try {
        const r = await callByCategory(currentAccount, apiKey, selectedOption?.category ?? '通用型', [{ role: 'user', content: 'ping' }], e.id, undefined)
        setProbeResults(prev => ({ ...prev, [e.id]: r.ok ? { ok: true, ms: Date.now() - t0 } : { ok: false, ms: Date.now() - t0, error: r.error ?? t('调用失败') } }))
      } catch (err) {
        setProbeResults(prev => ({ ...prev, [e.id]: { ok: false, ms: Date.now() - t0, error: (err as Error)?.message ?? t('调用失败') } }))
      }
    }))
    setProbing(false)
    notify(t('引擎探测完成（共 {n} 个）', { n: targets.length }))
  }
  // ---- MoMA 模型列表治理（v0.1.469） ----
  // 打开面板先显示本地缓存的实测结果，再后台轮测九天自营对话模型（真实 chat
  // 冒烟、走 2500 万免费试用额度），逐个测完逐个回填界面与缓存。合作对话模型
  // ping 一次就是一次按量调用：不自动测、不进批量，只能逐个点「测试」并在弹窗
  // 里确认可能扣费后才发。非对话模型只按功能分类展示、永不 ping（沿用 464 口径）。
  const isMomaAccount = currentAccount?.providerId === MOMA_PROVIDER_ID
  const [momaTests, setMomaTests] = useState<Record<string, MomaModelTest>>({})
  const [momaTesting, setMomaTesting] = useState<ReadonlySet<string>>(new Set())
  const [momaSweeping, setMomaSweeping] = useState(false)
  const [momaSweepNote, setMomaSweepNote] = useState('')
  const [momaFreeOnly, setMomaFreeOnly] = useState<boolean>(() => loadMomaFreeOnly())
  const [momaCollapsed, setMomaCollapsed] = useState<ReadonlySet<MomaModelCategory>>(new Set())
  const [momaConfirmId, setMomaConfirmId] = useState<string | null>(null)
  const momaSweepKeyRef = useRef('')
  const momaSweepingRef = useRef(false)
  const pingMomaModel = async (account: Account, apiKey: string, modelId: string): Promise<MomaModelTest> => {
    setMomaTesting(prev => new Set(prev).add(modelId))
    const t0 = Date.now()
    let result: MomaModelTest
    try {
      const r = await callByCategory(account, apiKey, selectedOption?.category ?? '通用型', [{ role: 'user', content: 'ping' }], modelId, undefined)
      result = r.ok
        ? { ok: true, ms: Date.now() - t0, testedAt: Date.now() }
        : { ok: false, ms: Date.now() - t0, error: (r.error ?? t('调用失败')).slice(0, 200), testedAt: Date.now() }
    } catch (err) {
      result = { ok: false, ms: Date.now() - t0, error: ((err as Error)?.message ?? t('调用失败')).slice(0, 200), testedAt: Date.now() }
    }
    saveMomaModelTest(account, modelId, result)
    setMomaTests(prev => ({ ...prev, [modelId]: result }))
    setMomaTesting(prev => { const next = new Set(prev); next.delete(modelId); return next })
    return result
  }
  const runMomaSweep = async (targets: string[]) => {
    const account = currentAccount
    if (!account?.encryptedKey || momaSweepingRef.current) return
    const pwd = resolvePwd()
    if (!pwd) { setMomaSweepNote(t('保险箱未解锁，无法后台轮测；解锁后重新打开列表或点「重新测试」')); return }
    let apiKey = ''
    try { apiKey = await decryptSecret(account.encryptedKey, pwd) } catch { setMomaSweepNote(t('Key 解密失败，无法轮测')); return }
    if (!targets.length) return
    momaSweepingRef.current = true
    setMomaSweeping(true)
    setMomaSweepNote('')
    const queue = [...targets]
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        await pingMomaModel(account, apiKey, id)
      }
    }
    await Promise.all([worker(), worker(), worker()])
    momaSweepingRef.current = false
    setMomaSweeping(false)
  }
  // 面板打开 + 引擎列表就绪 → 先上缓存、再后台刷新（同账户同列表只自动跑一次；手动「重新测试」不限）
  useEffect(() => {
    if (!enginePanelOpen || !isMomaAccount || !currentAccount || loadingEngines || !engines.length) return
    const key = `${currentAccount.id}:${currentAccount.keyFingerprint ?? ''}:${engines.length}`
    if (momaSweepKeyRef.current === key) return
    momaSweepKeyRef.current = key
    setMomaTests(loadMomaModelTests(currentAccount))
    void runMomaSweep(engines.map(e => e.id).filter(isMomaAutoTestable))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enginePanelOpen, isMomaAccount, currentAccount?.id, loadingEngines, engines.length])
  const testMomaPartnerModel = async (modelId: string) => {
    setMomaConfirmId(null)
    const account = currentAccount
    if (!account?.encryptedKey) { notify(t('当前账户未配置 Key，无法测试')); return }
    const pwd = resolvePwd()
    if (!pwd) { notify(t('请先解锁保险箱，再测试模型')); return }
    let apiKey = ''
    try { apiKey = await decryptSecret(account.encryptedKey, pwd) } catch { notify(t('Key 解密失败，无法测试')); return }
    const r = await pingMomaModel(account, apiKey, modelId)
    notify(r.ok
      ? t('「{name}」测试通过（{ms}ms）', { name: modelId, ms: r.ms })
      : t('「{name}」测试失败：{error}', { name: modelId, error: r.error ?? '' }))
  }
  const toggleMomaGroup = (cat: MomaModelCategory) => {
    setMomaCollapsed(prev => { const next = new Set(prev); if (next.has(cat)) next.delete(cat); else next.add(cat); return next })
  }
  const renderMomaItem = (e: Engine, category: MomaModelCategory) => {
    const test = momaTests[e.id]
    const isChat = category === 'chat'
    const partnerChat = isChat && !isMomaSelfOperated(e.id)
    const untestedPartner = partnerChat && !test && !momaTesting.has(e.id)
    return (
      <div key={e.id} role="button" tabIndex={0}
        className={`engine-item ${engineId === e.id ? 'active' : ''}`}
        onClick={() => { setEngineId(e.id); notify(t('已选引擎：{name}', { name: e.name })) }}
        onKeyDown={ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setEngineId(e.id) } }}>
        <span className="engine-icon">{e.reasoning ? '🧠' : '⚡'}</span>
        <span className="engine-info">
          <span className="engine-name">{e.name}
            {e.tag && <em className={`engine-tag ${e.tag === '夜间折扣' ? 'discount' : e.tag === '订阅优先' ? 'sub' : ''}`}>{t(e.tag)}</em>}
          </span>
          <span className="engine-id">{e.id}</span>
          <span className="engine-billing-note">{untestedPartner ? t('未测试（自动测试可能扣按量费）') : t(momaModelBillingNote(e.id))}</span>
        </span>
        <span className="engine-multi">{e.multiplier.toFixed(2)}x</span>
        {!isChat && <span className="engine-probe skip">{t('○ 非对话模型')}</span>}
        {isChat && (momaTesting.has(e.id)
          ? <span className="engine-probe skip">{t('测试中…')}</span>
          : test
            ? <span className={`engine-probe ${test.ok ? 'ok' : 'fail'}`} title={test.error ?? ''}>{test.ok ? `● ${test.ms}ms` : t('● 不可用')}</span>
            : partnerChat
              ? <span className="moma-untested">
                  <span className="engine-probe skip">{t('未测试')}</span>
                  <button className="btn sm moma-test-btn" onClick={ev => { ev.stopPropagation(); setMomaConfirmId(e.id) }}>{t('测试')}</button>
                </span>
              : <span className="engine-probe skip">{t('待测试')}</span>)}
        {engineId === e.id && <span className="engine-check">✓</span>}
      </div>
    )
  }
  // ---- 顶栏工具显隐（设置「AI 助手工具栏」逐个开关，缺省显示） ----
  const tbShow = (k: keyof AiToolbarPrefs) => settings?.aiToolbar?.[k] !== false
  // 工具顺序：设置页可调序，菜单按此顺序渲染（CSS order）
  const toolbarOrder = useMemo(() => mergeToolbarOrder(settings?.aiToolbarOrder), [settings?.aiToolbarOrder])
  const toolOrder = (k: keyof AiToolbarPrefs) => toolbarOrder.indexOf(k)
  // 顶栏功能菜单（v0.1.240）：只保留一个入口图标，点开列出全部功能；选中后关闭，开关型功能变色
  // v0.1.497：竖排文字列表改横向图标栏（见下方 toolBarGroups）；免费路线切换在图标栏下另开小浮层
  const [toolsOpen, setToolsOpen] = useState(false)
  const [chainOpen, setChainOpen] = useState(false)
  useEffect(() => { if (!toolsOpen) setChainOpen(false) }, [toolsOpen])
  const toolsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!toolsOpen) return
    const onDown = (e: MouseEvent) => { if (toolsRef.current && !toolsRef.current.contains(e.target as Node)) setToolsOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setToolsOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [toolsOpen])
  const anyToolOn = autoSpeak || useMyData || webSearchOn || compareMode || searchOpen
  // ---- 提示词库（完整页面） ----
  const [promptsOpen, setPromptsOpen] = useState(false)
  const [promptTitle, setPromptTitle] = useState('')
  const [promptBody, setPromptBody] = useState('')
  const [promptQuery, setPromptQuery] = useState('')
  const promptList = prompts ?? []
  const openPromptsPage = () => {
    // 打开整页时把聊天输入框里已写的内容带进新建表单，方便直接存为模板
    setPromptBody(input)
    setPromptsOpen(true)
  }
  const savePrompt = () => {
    const body = promptBody.trim()
    if (!body) { notify(t('先写好提示词正文再保存')); return }
    if (!onPromptsChange) return
    const title = promptTitle.trim() || body.slice(0, 18)
    onPromptsChange([{ id: `pt-${Date.now()}`, title, body, createdAt: new Date().toISOString() }, ...promptList])
    setPromptTitle('')
    setPromptBody('')
    notify(t('已存为模板「{title}」', { title }))
  }
  const insertPrompt = (body: string) => {
    setInput(prev => prev.trim() ? `${prev}\n${body}` : body)
    setPromptsOpen(false)
    textareaRef.current?.focus()
  }
  const buildChatMarkdown = () => {
    const lines = [
      `# ${t('AI 助手对话记录')}`,
      '',
      t('导出时间：{time}', { time: new Date().toLocaleString(locale()) }),
      t('模型：{model}', { model: currentModel }),
      '',
      '---',
      '',
    ]
    for (const m of messages) {
      lines.push(`**${m.role === 'user' ? t('我') : t('AI 助手')}：**`)
      lines.push('')
      lines.push(m.content)
      lines.push('')
    }
    return lines.join('\n')
  }
  const downloadChat = async () => {
    const p = (n: number) => String(n).padStart(2, '0')
    const d = new Date()
    const r = await saveExportFile(`${t('AI对话记录')}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.md`, buildChatMarkdown(), 'ai')
    if (r.cancelled) return
    setExportOpen(false)
    notify(r.ok ? t('对话记录已导出到：{where}', { where: r.where ?? '' }) : t('导出失败：{error}', { error: r.error ?? t('未知错误') }))
  }

  const onInput = (v: string) => {
    setInput(v)
    const el = textareaRef.current
    if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 160) + 'px' }
  }

  const currentModel = selectedOption?.account
    ? `${PROVIDER_MAP[selectedOption.account.providerId]?.shortName ?? selectedOption.account.label}${selectedEngine ? ` · ${selectedEngine.name}` : ''}`
    : selectedOption?.label ?? t('选择模型')
  const hasChat = messages.length > 0 || generating
  const callEnabled = !selectedOption || CATEGORY_META[selectedOption.category].canChat
  // 对话态：点击输入框或发送后进入，欢迎语/图标隐藏、输入框落到底部；进入页或切回来时复位居中
  const [composeActive, setComposeActive] = useState(false)
  useEffect(() => { if (!hasChat) setComposeActive(false) }, [hasChat])
  // 引擎面板只在对话态需要时保留开关状态，切走对话复位
  const enteredChat = composeActive || hasChat
  const layoutMode = !enteredChat ? 'welcome' : (hasChat ? 'chat' : 'focus')

  // 工具条下拉：分类 / 平台 / 模型三段级联（v0.1.496 定版：每段只展示本段的名字）
  const categoryDropdown = <div className="ai-model-wrap">
    <button className="ai-model-btn" onClick={() => { setCategoryOpen(v => !v); setPlatformOpen(false); setModelOpen(false) }} title={t('模型分类')}>
      <Layers size={13} /> {t(category)} <ChevronDown size={13} />
    </button>
    {categoryOpen && <div className="ai-model-menu me-panel-in" key={`cat-${category}`}>
      {AI_CATEGORIES.filter(c => {
        // 本地服务全关时隐藏「本地型」分类；开启任一服务则显示
        if (c === '本地型' && !shouldShowLocalCategory(settings)) return false
        return true
      }).map(c => (
        <button key={c} className={`ai-model-option ${c === category ? 'active' : ''}`}
          onClick={() => {
            setCategory(c); setCategoryOpen(false)
            const list = allOptions.filter(o => o.category === c)
            if (list.length && !list.some(o => o.key === model)) { setModel(list[0].key); saveModel(list[0].key) }
          }}>
          <span>{CATEGORY_META[c].icon} {t(c)}</span>
        </button>
      ))}
    </div>}
  </div>
  // 免费模型：选中即测活，结果以通知反馈（v0.1.496 起第三段只展示模型名，列表内不再打标）
  const toFreeAiOption = (o: (typeof allOptions)[number]): FreeAiOption => ({
    key: o.key, label: o.label,
    group: o.apisFree ? 'APIsFreeLLM 兜底通道' : (o.upstream ? (o.upstream === 'zen' ? 'Zen 免费通道' : 'Kilo 免费通道') : '云端免费'),
    source: o.apisFree ? 'apisfree' : (o.upstream ?? 'cloud'), modelId: freeModelIdOf(o),
  })
  const selectFreeModel = (o: (typeof visibleOptions)[number]) => {
    setModel(o.key); saveModel(o.key); setModelOpen(false)
    const id = freeModelIdOf(o)
    const opt: FreeAiOption = {
      key: o.key, label: o.label,
      group: o.apisFree ? 'APIsFreeLLM 兜底通道' : (o.upstream ? (o.upstream === 'zen' ? 'Zen 免费通道' : 'Kilo 免费通道') : '云端免费'),
      source: o.apisFree ? 'apisfree' : (o.upstream ?? 'cloud'), modelId: id,
    }
    void testFreeAiOption(opt).then(r => {
      // v0.1.504：选中即测活的结果同时记入全局探测中心（被动数据源之一）
      if (r.ok) recordProbeOutcome(o.key, { ok: true, ms: r.ms, source: 'passive' })
      else { const c = classifyProbeError(new Error(r.error || '测活失败')); recordProbeOutcome(o.key, { ok: false, source: 'passive', failKind: c.kind, failReason: c.reason, retryAfterSec: c.retryAfterSec }) }
      if (r.ok) notify(t('免费模型已跑通：{name}（{ms} 毫秒）', { name: id, ms: String(r.ms) }))
      else notify(t('免费模型测不通：{name} —— {err}', { name: id, err: r.error ?? '' }))
    })
  }

  // 第二段「平台」：按钮与列表只展示平台名（分组逻辑见 modelCascade）。
  // 自有账户平台点选即选中该账户；多模型平台（WorkBuddy / Zen / Kilo / APIsFreeLLM /
  // Ollama）点选只切换平台上下文，具体模型到第三段里选。
  // v0.1.504：第二段平台排序接入探测结果——平台内有可用模型且最快者优先（无数据保持原序）
  const sortedPlatformGroups = useMemo(() => {
    const score = (g: (typeof platformGroups)[number]): number => {
      let best = Number.POSITIVE_INFINITY
      for (const o of g.options) {
        if (o.account) {
          for (const t of probeTargets) {
            if (t.accountId !== o.account.id) continue
            const r = probeStore.results[t.id]
            if (r?.ok) best = Math.min(best, medianSamples(r.latencySamples) ?? Number.POSITIVE_INFINITY)
          }
        } else {
          const r = probeStore.results[o.key]
          if (r?.ok) best = Math.min(best, medianSamples(r.latencySamples) ?? Number.POSITIVE_INFINITY)
        }
      }
      return best
    }
    return platformGroups
      .map((g, i) => ({ g, i, s: score(g) }))
      .sort((a, b) => (a.s === b.s ? a.i - b.i : a.s - b.s))
      .map(x => x.g)
  }, [platformGroups, probeTargets, probeStore])

  const platformDropdown = <div className="ai-model-wrap">
    <button className="ai-model-btn" onClick={() => { setPlatformOpen(v => !v); setCategoryOpen(false); setModelOpen(false) }} title={t('模型平台')}>
      {currentPlatform?.platformName ?? ''} <ChevronDown size={13} />
    </button>
    {platformOpen && <div className="ai-model-menu me-panel-in" key={`plat-${category}`}>
      {platformGroups.length === 0 && <div className="ai-model-empty">{category === '免费模型' && needLogin ? t('免费模型需先登录云同步：点左侧边栏底部的同步状态条即可登录') : t('该分类暂无模型，请到 API Key 管理页添加')}</div>}
      {sortedPlatformGroups.map(g => (
        <button key={g.platformKey} className={`ai-model-option ${g.platformKey === platformKey ? 'active' : ''}`}
          onClick={() => {
            setPlatformKey(g.platformKey); setPlatformOpen(false)
            const first = g.options[0]
            if (first?.account) { setModel(first.key); saveModel(first.key) }
          }}>
          <span>{g.platformName}</span>
        </button>
      ))}
    </div>}
  </div>

  // 第三段「模型」：按钮与列表只展示模型名；未选时按钮显示空、不自动替选。
  // 自有账户平台下是该账户的引擎列表，菜单底部「全部模型与测速 →」进引擎面板
  // （原底部行「引擎」按钮的去处，469 面板功能原样保留）；其余平台下是平台内的模型选项。
  const platformIsAccount = !!currentPlatform?.options[0]?.account
  // v0.1.504：第三段列表接入探测结果——可用优先按口径排序（免费/对话比速度、通用比有效价格），
  // 不可用不进主列表（收进菜单底部「暂时不可用」折叠组，仍可点选）；已选项即使不可用也保留在主列表原位可见
  const orderedPlatformOptions = useMemo(() => {
    if (!currentPlatform || platformIsAccount) return []
    const targets = currentPlatform.options
      .map(o => probeTargets.find(x => x.id === o.key))
      .filter((x): x is ProbeTarget => !!x)
    if (!targets.length) return currentPlatform.options
    const orderIds: string[] = []
    for (const g of ['free', 'chat', 'general'] as ProbeGroup[]) {
      const sub = targets.filter(x => x.group === g)
      if (!sub.length) continue
      const ranked = rankProbeGroup(sub, probeStore.results, g).map(r => r.target.id)
      const bad = sub.filter(x => probeStore.results[x.id] && !probeStore.results[x.id].ok).map(x => x.id)
      orderIds.push(...ranked, ...bad)
    }
    const byKey = new Map(currentPlatform.options.map(o => [o.key, o]))
    const seen = new Set<string>()
    const out: (typeof currentPlatform.options)[number][] = []
    for (const id of orderIds) { const o = byKey.get(id); if (o && !seen.has(id)) { out.push(o); seen.add(id) } }
    for (const o of currentPlatform.options) if (!seen.has(o.key)) out.push(o)
    return out
  }, [currentPlatform, platformIsAccount, probeTargets, probeStore])
  const optionProbeBad = (key: string) => {
    const r = probeStore.results[key]
    return !!r && !r.ok
  }
  const engineProbeBad = (engineId: string) => {
    if (!currentAccount) return false
    const r = probeStore.results[`own:${currentAccount.id}:${engineId}`]
    return !!r && !r.ok
  }
  const probeDot = (id: string) => {
    const r = probeStore.results[id]
    // v0.1.506：未测显性化——无结果时不再整行空白（与「测了没数据」无法区分、看着像坏了），
    // 改渲染浅灰点 + 「未测」小字（与面板 probe-dot none + 指标列「未测」口径一致）
    if (!r) return <span className="probe-row-meta"><span className="probe-dot none" /><small>{t('未测')}</small></span>
    const med = medianSamples(r.latencySamples)
    return <span className="probe-row-meta">{r.ok
      ? <><span className="probe-dot ok" />{med !== null && <small>{med >= 1000 ? `${(med / 1000).toFixed(1)}s` : `${med}ms`}</small>}</>
      : <span className="probe-dot bad" />}</span>
  }
  const seg3Label = !currentPlatform
    ? ''
    : platformIsAccount
      ? (selectedEngine?.name ?? '')
      : (selectedOption && platformKeyOf(selectedOption) === currentPlatform.platformKey ? modelNameOf(selectedOption) : '')
  // v0.1.513：第三段列表的搜索过滤 + 免费置顶，排序合成规则——
  // ① 探测口径先定大序（504：可用优先、可用内按速度/有效价格排名；不可用沉底或进底部折叠组）；
  // ② 免费置顶只在「可用」组内做稳定分区（-free/:free 结尾的排前、组内保留探测名次），不跨可用性分组；
  // ③ 已选但不可用的条目维持现行口径留在主列表原位（账户引擎/平台选项一致），不被免费置顶挤走；
  // ④ 搜索只过滤显示；已选项若被搜索词滤掉且不在折叠组里，单独在列表顶部钉一行并标「已选」，永远找得回来。
  const engineRows = useMemo(() => {
    if (!platformIsAccount) return []
    const visible = engines.filter(e => !engineProbeBad(e.id) || e.id === engineId)
    const avail = visible.filter(e => !engineProbeBad(e.id))
    const badSelected = visible.filter(e => engineProbeBad(e.id))
    const ordered = [...freeModelsFirst(avail, e => isFreeModelName(e.id) || isFreeModelName(e.name)), ...badSelected]
    return filterModelsByQuery(ordered, modelQuery, e => `${e.name} ${e.id}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platformIsAccount, engines, engineId, probeStore, modelQuery])
  const pinnedEngine = platformIsAccount && engineId && !engineRows.some(e => e.id === engineId)
    ? engines.find(e => e.id === engineId) : undefined
  // 平台选项的免费判定：显示名或 key 尾段的模型 id 任一以 -free/:free 结尾（云端清单的 id 如 hy4-free 藏在 key 里）
  const optionIsFree = (o: (typeof orderedPlatformOptions)[number]) =>
    isFreeModelName(modelNameOf(o)) || isFreeModelName(o.key.split(':').pop() ?? '')
  const optionRows = useMemo(() => {
    if (platformIsAccount) return []
    const main = orderedPlatformOptions.filter(o => !optionProbeBad(o.key) || o.key === model)
    const avail = main.filter(o => !optionProbeBad(o.key))
    const badSelected = main.filter(o => optionProbeBad(o.key))
    const ordered = [...freeModelsFirst(avail, o => optionIsFree(o)), ...badSelected]
    return filterModelsByQuery(ordered, modelQuery, o => modelNameOf(o))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platformIsAccount, orderedPlatformOptions, model, probeStore, modelQuery])
  const unavailRows = modelQuery.trim()
    ? probeUnavail.filter(({ target }) => target.name.toLowerCase().includes(modelQuery.trim().toLowerCase()))
    : probeUnavail
  const pinnedOption = !platformIsAccount && model && currentPlatform
    && !optionRows.some(o => o.key === model) && !unavailRows.some(x => x.target.id === model)
    ? currentPlatform.options.find(o => o.key === model) : undefined
  const engineRowBtn = (e: (typeof engines)[number], pinned: boolean) => (
    <button key={`eng-${e.id}`} className={`ai-model-option ${e.id === engineId ? 'active' : ''}`}
      onClick={() => { setEngineId(e.id); setModelOpen(false); notify(t('已选引擎：{name}', { name: e.name })) }}>
      <span className="ai-model-name">{e.name}{(isFreeModelName(e.id) || isFreeModelName(e.name)) && <span className="ai-model-tag">{t('免费')}</span>}{pinned && <span className="ai-model-tag">{t('已选')}</span>}</span>{probeDot(`own:${currentAccount?.id}:${e.id}`)}
    </button>
  )
  const optionRowBtn = (o: (typeof orderedPlatformOptions)[number], pinned: boolean) => (
    <button key={`opt-${o.key}`} className={`ai-model-option ${o.key === model ? 'active' : ''}`}
      onClick={() => { if (o.free) selectFreeModel(o); else { setModel(o.key); saveModel(o.key); setModelOpen(false) } }}>
      <span className="ai-model-name">{modelNameOf(o)}{optionIsFree(o) && <span className="ai-model-tag">{t('免费')}</span>}{pinned && <span className="ai-model-tag">{t('已选')}</span>}</span>{probeDot(o.key)}
    </button>
  )
  const modelDropdown = <div className="ai-model-wrap">
    <button className={`ai-model-btn ${seg3Label ? '' : 'seg-empty'}`} onClick={() => { if (!modelOpen) setModelQuery(''); setModelOpen(v => !v); setCategoryOpen(false); setPlatformOpen(false) }} title={t('切换模型')}>
      {seg3Label} <ChevronDown size={13} />
    </button>
    {modelOpen && <div className="ai-model-menu me-panel-in" key={`model-${category}-${platformKey}`}>
      {/* v0.1.448：433 的「免费路线切换」模式块已摘除——模式切换全 App 只保留右上角「···」菜单一处（v0.1.439），这里回归纯选择列表 */}
      {/* v0.1.454：APIsFreeLLM 兜底通道控制块（开关/测活/剩余量/详情）也已摘除——通道控制全 App 只留工坊 RouteSelect 一处；通道开启且测通时 free-ai 仍作为普通模型条目出现在这里（apisFreeOptions） */}
      {/* v0.1.504：菜单顶部「一键检测」卡已删除——检测移入功能图标栏的探测中心（全局一份结果），菜单回归纯选择列表 */}
      {/* v0.1.513：菜单顶部搜索框——纯过滤输入（输入即过滤、清空恢复全量），不是模式开关，不带其他控件 */}
      {currentPlatform && <div className="ai-model-search"><Search size={13} /><input value={modelQuery} onChange={e => setModelQuery(e.target.value)} placeholder={t('搜索模型…')} autoFocus /></div>}
      {category === '免费模型' && upstreamFreeOn && upstreamErr && <div className="ai-model-empty">{t('Zen / Kilo 免费通道清单没拉到（网络或上游问题），自动重试后仍失败。')}<button className="btn sm" style={{ marginLeft: 8 }} onClick={() => retryUpstream()}>{t('重试')}</button></div>}
      {!currentPlatform && <div className="ai-model-empty">{category === '免费模型' && needLogin ? t('免费模型需先登录云同步：点左侧边栏底部的同步状态条即可登录') : t('该分类暂无模型，请到 API Key 管理页添加')}</div>}
      {currentPlatform && platformIsAccount && <>
        {loadingEngines && <div className="ai-model-empty">{t('正在获取实时引擎…')}</div>}
        {!loadingEngines && engines.length === 0 && <div className="ai-model-empty">{t('该平台暂无内置引擎目录')}</div>}
        {pinnedEngine && engineRowBtn(pinnedEngine, true)}
        {engineRows.map(e => engineRowBtn(e, false))}
        {!loadingEngines && engines.length > 0 && modelQuery.trim() && engineRows.length === 0 && !pinnedEngine && <div className="ai-model-empty">{t('没有匹配的模型')}</div>}
        <button className="ai-model-option ai-model-more" onClick={() => { setModelOpen(false); setEnginePanelOpen(true) }}>
          <span>{t('全部模型与测速')} →</span>
        </button>
      </>}
      {currentPlatform && !platformIsAccount && <>
        {pinnedOption && optionRowBtn(pinnedOption, true)}
        {optionRows.map(o => optionRowBtn(o, false))}
        {modelQuery.trim() && optionRows.length === 0 && !pinnedOption && unavailRows.length === 0 && <div className="ai-model-empty">{t('没有匹配的模型')}</div>}
      </>}
      {/* v0.1.504：不可用模型收进菜单底部折叠组（计数与面板/角标同源），展开仍可点击选中，探测不拦选择 */}
      {/* v0.1.513：搜索时折叠组同步按名过滤、计数显示过滤后的条数；无搜索时口径不变 */}
      {unavailRows.length > 0 && <>
        <button className="ai-model-option probe-fold-toggle" onClick={() => setMenuUnavailOpen(v => !v)}>
          <span>{t('暂时不可用（{n}）', { n: unavailRows.length })}</span><ChevronDown size={13} style={{ transform: menuUnavailOpen ? 'rotate(180deg)' : undefined }} />
        </button>
        {menuUnavailOpen && unavailRows.map(({ target, result }) => (
          <button key={target.id} className="ai-model-option probe-unavail-row" onClick={() => { selectProbeTarget(target); setMenuUnavailOpen(false) }}>
            <span>{target.name}</span><small>{target.platformName} · {result.failReason ?? t('调用失败')}</small>
          </button>
        ))}
      </>}
    </div>}
  </div>

  // ---- 提示词库整页：点「提示词」后整页打开，不再是小弹层 ----
  const shownPrompts = promptQuery.trim()
    ? promptList.filter(p => p.title.toLowerCase().includes(promptQuery.trim().toLowerCase()) || p.body.toLowerCase().includes(promptQuery.trim().toLowerCase()))
    : promptList
  if (promptsOpen) {
    return (
      <div className="ai-page prompts-page">
        <div className="prompts-page-inner">
          <div className="prompts-page-head">
            <button className="btn sm" onClick={() => setPromptsOpen(false)}><ArrowLeft size={15} /> {t('返回聊天')}</button>
            <div className="prompts-page-title">
              <h2>{t('提示词库')}</h2>
              <span>{t('共 {n} 个模板 · 随云同步，跨设备可用 · 点「插入」放回聊天输入框，正文里的 {变量} 插入后自己改', { n: promptList.length })}</span>
            </div>
          </div>

          <div className="prompts-new">
            <div className="prompts-new-title">{t('新建模板')}</div>
            <input className="input" placeholder={t('模板标题（留空取正文前 18 字）')} value={promptTitle} onChange={e => setPromptTitle(e.target.value)} />
            <textarea className="input prompts-new-body" rows={5} placeholder={t('提示词正文，例如：你是一位资深翻译，把下面的内容翻译成英文：{内容}')} value={promptBody} onChange={e => setPromptBody(e.target.value)} />
            <div className="prompts-new-foot">
              <span>{t('打开本页时已自动带入聊天输入框里写好的内容，可直接修改后保存')}</span>
              <button className="btn primary" onClick={savePrompt}>{t('保存模板')}</button>
            </div>
          </div>

          <div className="prompts-search">
            <Search size={15} />
            <input className="input" placeholder={t('搜索模板标题或正文…')} value={promptQuery} onChange={e => setPromptQuery(e.target.value)} />
          </div>

          {promptList.length === 0 && <div className="prompts-empty">{t('还没有模板。在上方写好标题和正文，点「保存模板」就会出现在这里。')}</div>}
          {promptList.length > 0 && shownPrompts.length === 0 && <div className="prompts-empty">{t('没有匹配「{q}」的模板。', { q: promptQuery })}</div>}
          <div className="prompts-grid">
            {shownPrompts.map(p => (
              <div key={p.id} className="prompt-card">
                <div className="prompt-card-title">{p.title}</div>
                <div className="prompt-card-body">{p.body}</div>
                <div className="prompt-card-foot">
                  <span className="prompt-card-date">{p.createdAt?.slice(0, 10) ?? ''}</span>
                  <span className="prompt-card-actions">
                    <button className="btn sm" onClick={() => { void navigator.clipboard?.writeText(p.body).then(() => notify(t('已复制模板正文'))).catch(() => notify(t('复制失败，请手动复制'))) }}><Copy size={13} /> {t('复制')}</button>
                    <button className="btn sm primary" onClick={() => insertPrompt(p.body)}>{t('插入')}</button>
                    <button className="icon-btn" title={t('删除模板')} onClick={() => onPromptsChange?.(promptList.filter(x => x.id !== p.id))}><Trash2 size={14} /></button>
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }
  // ---- v0.1.497：功能菜单横向图标栏的分组构建 ----
  // 分组：0 对话（通话/朗读/搜索/导出）｜1 增强（我的数据/联网/免费路线/对比）｜2 管理（会话/提示词/清空）｜3 Ollama（最右独立组）。
  // 组内按设置页的工具顺序（toolOrder）排；被设置隐藏的（tbShow=false）不渲染，整组空了连分隔线一起不渲染。
  // keepOpen=true 的项点后不关图标栏：免费路线（要开下方浮层）、Ollama（要当场看到开关变色）。
  type ToolBarItem = {
    id: string; group: number; order: number; tip: string; label: string; icon: ReactNode
    on?: boolean; svcOn?: boolean; svcRunning?: boolean; disabled?: boolean; keepOpen?: boolean
    /** v0.1.499：服务项的常驻状态点（不悬停也可辨）：切换中/失败/运行中/开但未运行/已关闭 */
    svcState?: 'busy' | 'failed' | 'running' | 'onidle' | 'off'
    /** v0.1.504：探测项的红色角标（不可用数）与三态状态点 */
    badge?: number
    probeState?: 'probing' | 'done' | 'idle'
    action: () => void
  }
  const ollamaOn = serviceController?.enabled('ollama') ?? false
  const ollamaRunning = !!serviceController?.status.ollama
  const ollamaBusy = serviceController?.busyKey === 'ollama'
  // 失败态来自控制器记录的真实启停结果；状态本身来自真实探测（status），不按用户点没点关臆测
  const ollamaFailed = serviceController?.failed?.ollama
  const ollamaState: NonNullable<ToolBarItem['svcState']> = ollamaBusy ? 'busy'
    : ollamaFailed ? 'failed'
    : ollamaRunning ? 'running'
    : ollamaOn ? 'onidle'
    : 'off'
  const ollamaTip = ollamaBusy
    ? 'Ollama 本地服务：切换中…'
    : ollamaFailed
      ? `Ollama 本地服务：上次启停失败（${ollamaFailed}）${ollamaRunning ? '，服务仍在运行' : ''}（点击重试）`
      : ollamaOn
        ? (ollamaRunning ? 'Ollama 本地服务：运行中（点击关闭）' : 'Ollama 本地服务：已开启（点击关闭）')
        : 'Ollama 本地服务：已关闭（点击开启）'
  const toolBarItems: ToolBarItem[] = [
    ...(tbShow('voiceCall') ? [{
      id: 'voiceCall', group: 0, order: toolOrder('voiceCall'), label: t('语音通话'),
      tip: callEnabled ? t('语音通话') : `${t('语音通话')}${t('（当前模型不支持）')}`,
      icon: <Phone size={20} />, disabled: !callEnabled,
      action: () => setCallOpen(true),
    }] : []),
    ...(tbShow('autoSpeak') ? [{
      id: 'autoSpeak', group: 0, order: toolOrder('autoSpeak'), label: t('自动朗读'),
      tip: `${t('自动朗读')}：${autoSpeak ? t('已开启') : t('已关闭')}`,
      icon: autoSpeak ? <Volume2 size={20} /> : <VolumeX size={20} />, on: autoSpeak,
      action: () => toggleAutoSpeak(),
    }] : []),
    ...(tbShow('chatSearch') ? [{
      id: 'chatSearch', group: 0, order: toolOrder('chatSearch'), label: t('搜索对话'),
      tip: `${t('搜索对话')}：${searchOpen ? t('已开启') : t('已关闭')}`,
      icon: <Search size={20} />, on: searchOpen,
      action: () => { setSearchOpen(v => !v); if (searchOpen) setSearchQuery('') },
    }] : []),
    ...(tbShow('chatExport') ? [{
      id: 'chatExport', group: 0, order: toolOrder('chatExport'), label: t('导出对话'),
      tip: t('导出对话'),
      icon: <Download size={20} />, disabled: messages.length === 0,
      action: () => setExportOpen(true),
    }] : []),
    ...(tbShow('myData') ? [{
      id: 'myData', group: 1, order: toolOrder('myData'), label: t('引用我的数据'),
      tip: `${t('引用我的数据')}：${useMyData ? t('已开启') : t('已关闭')}`,
      icon: <Database size={20} />, on: useMyData,
      action: () => toggleUseMyData(),
    }] : []),
    ...(tbShow('webSearch') ? [{
      id: 'webSearch', group: 1, order: toolOrder('webSearch'), label: t('联网搜索'),
      tip: `${t('联网搜索')}：${webSearchOn ? t('已开启') : t('已关闭')}`,
      icon: <Globe size={20} />, on: webSearchOn,
      action: () => toggleWebSearch(),
    }] : []),
    {
      id: 'chain', group: 1, order: toolOrder('webSearch') + 0.5, label: '免费路线切换',
      tip: `免费路线切换：${chainMode === 'auto' ? '自动切换' : '手动锁定'}`,
      icon: <Shuffle size={20} />, on: chainOpen, keepOpen: true,
      action: () => setChainOpen(v => !v),
    },
    {
      // v0.1.504：全局模型探测中心入口——三态（探测中转圈+琥珀脉冲点 / 完成绿点+红角标=不可用数）
      id: 'probe', group: 1, order: toolOrder('webSearch') + 0.6, label: '模型探测',
      tip: probeRunning ? '模型探测：探测中…'
        : (probeSummaryNow.ok + probeSummaryNow.bad > 0
          ? `模型探测：已完成 · ${probeSummaryNow.ok} 个可用 / ${probeSummaryNow.bad} 个不可用`
          : '模型探测：尚未探测'),
      icon: probeRunning ? <Loader2 size={20} className="spin" /> : <Gauge size={20} />,
      probeState: probeRunning ? 'probing' : (probeSummaryNow.ok + probeSummaryNow.bad > 0 ? 'done' : 'idle'),
      badge: probeSummaryNow.bad || undefined,
      on: probePanelOpen, keepOpen: true,
      action: () => setProbePanelOpen(v => !v),
    },
    ...(tbShow('compare') ? [{
      id: 'compare', group: 1, order: toolOrder('compare'), label: t('多模型对比'),
      tip: `${t('多模型对比')}：${compareMode ? t('已开启') : t('已关闭')}`,
      icon: <Columns2 size={20} />, on: compareMode,
      action: () => setCompareMode(v => !v),
    }] : []),
    ...(tbShow('sessions') ? [{
      id: 'sessions', group: 2, order: toolOrder('sessions'), label: t('会话列表'),
      tip: t('会话列表'),
      icon: <MessagesSquare size={20} />,
      action: () => requestToggleHistory(),
    }] : []),
    ...(tbShow('prompts') ? [{
      id: 'prompts', group: 2, order: toolOrder('prompts'), label: t('提示词'),
      tip: t('提示词'),
      icon: <BookMarked size={20} />,
      action: () => openPromptsPage(),
    }] : []),
    ...(tbShow('clearChat') ? [{
      id: 'clearChat', group: 2, order: toolOrder('clearChat'), label: t('清空对话'),
      tip: t('清空对话'),
      icon: <RotateCcw size={20} />,
      action: () => clear(),
    }] : []),
    ...(serviceController ? [{
      id: 'ollama', group: 3, order: 0, label: 'Ollama 本地服务',
      tip: ollamaTip,
      icon: ollamaBusy ? <Loader2 size={20} className="spin" /> : <Power size={20} />,
      svcOn: ollamaOn, svcRunning: ollamaRunning, svcState: ollamaState, disabled: ollamaBusy, keepOpen: true,
      action: () => { void serviceController.toggle('ollama') },
    }] : []),
  ]
  const toolBarGroups: ToolBarItem[][] = [0, 1, 2, 3]
    .map(g => toolBarItems.filter(i => i.group === g).sort((a, b) => a.order - b.order))
    .filter(items => items.length > 0)
  return (
    <div className={`ai-page ai-layout-${layoutMode}`}>
      {/* 手机端底部弹层遮罩：任一下拉打开时出现，点空白处关闭（桌面端 CSS 隐藏） */}
      {(categoryOpen || modelOpen || reasoningOpen) && (
        <div className="ai-menu-backdrop" onClick={() => { setCategoryOpen(false); setModelOpen(false); setReasoningOpen(false) }} />
      )}
      <div className="ai-shell">
        {/* 顶部栏：朗读开关 / 电话 / 刷新，靠右间距适中 */}
        <div className="ai-topbar">
          <div className="ai-top-actions" ref={toolsRef}>
            {/* 全局搜索：桌面端已统一到窗口标题栏右端（v0.1.485），胶囊里只剩宫格；
                手机壳无桌面标题栏，保留 481 形态——仅手机端传入 onOpenSearch 时才渲染这颗放大镜（宫格左侧） */}
            {onOpenSearch && (
              <button className="ai-icon-btn" onClick={() => onOpenSearch()} data-tip={`${t('搜索页面 / 账户 / 工具')} (⌘K)`} aria-label={t('搜索页面 / 账户 / 工具')}>
                <Search size={17} />
              </button>
            )}
            <button className={`ai-icon-btn ${toolsOpen || anyToolOn ? 'active' : ''}`} onClick={() => setToolsOpen(v => !v)} data-tip={t('全部功能')} aria-label={t('全部功能')}>
              {/* v0.1.497 追加（Ethan 13:59 定）：入口图标由九宫格换成 App 图标原图（与侧边栏底部卡同资源 pwa-512.png），位置/尺寸/功能不变 */}
              <span className="ai-tools-entry-mark"><img src="./pwa-512.png" alt="" /></span>
            </button>
            {toolsOpen && (
              <div className="ai-tools-bar" role="menu">
                <div className="ai-tools-bar-row">
                  {toolBarGroups.map((items, gi) => (
                    <Fragment key={gi}>
                      {gi > 0 && <span className="ai-tools-sep" aria-hidden="true" />}
                      <div className="ai-tools-seg">
                        {items.map(it => (
                          <button key={it.id} type="button"
                            className={`ai-tools-icon ${it.on ? 'on' : ''} ${it.svcOn ? 'svc-on' : ''} ${it.svcRunning ? 'svc-running' : ''}`}
                            data-tip={it.tip} aria-label={it.label} disabled={it.disabled}
                            onClick={() => { it.action(); if (!it.keepOpen) setToolsOpen(false) }}>
                            {it.icon}
                            {it.svcState && <span className={`svc-dot ${it.svcState}`} aria-hidden="true" />}
                            {it.probeState && <span className={`probe-state-dot ${it.probeState}`} aria-hidden="true" />}
                            {!!it.badge && <span className="probe-badge" aria-hidden="true">{it.badge}</span>}
                          </button>
                        ))}
                      </div>
                    </Fragment>
                  ))}
                </div>
                {/* v0.1.439 免费路线切换（全局设置，与工坊共用同一份）→ v0.1.497 改为图标栏下方小浮层：
                    模式控制仍只此一处；工坊 RouteSelect 只管 APIsFreeLLM 开关测活，不在此重复 */}
                {chainOpen && (
                  <div className="ai-chain-pop">
                    <div className="ai-chain-pop-title">免费路线切换</div>
                    <button className={`ai-chain-opt ${chainMode === 'auto' ? 'active' : ''}`} onClick={() => pickChainMode('auto')}>
                      <Shuffle size={16} /><span>自动切换</span>{chainMode === 'auto' && <Check size={15} className="ai-tools-check" />}
                    </button>
                    <button className={`ai-chain-opt ${chainMode === 'locked' ? 'active' : ''}`} onClick={() => pickChainMode('locked')}>
                      <Lock size={16} /><span>手动锁定</span>{chainMode === 'locked' && <Check size={15} className="ai-tools-check" />}
                    </button>
                    <div className="ai-tools-note">{chainMode === 'auto' ? '自动切换：首选路线撞限流/超时等失败时，自动切到下一条免费路线继续，并弹出提示说明原因。' : '手动锁定：只用当前选中的路线，失败时直接显示真实原因，不自动换路线。'}</div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* 多模型对比选择条 */}
        {compareMode && (
          <div className="ai-compare-bar">
            <span className="ai-compare-hint">{t('对比模式：选 2–3 个模型（已选 {n}），发送后并排看回答与耗时', { n: compareKeys.length })}</span>
            <div className="ai-compare-chips">
              {allOptions.map(o => (
                <button key={o.key} className={`ai-compare-chip ${compareKeys.includes(o.key) ? 'active' : ''}`} onClick={() => toggleCompareKey(o.key)}>{o.label}</button>
              ))}
              {allOptions.length === 0 && <span className="ai-compare-hint">{t('暂无可用模型')}</span>}
            </div>
          </div>
        )}

        {/* 会话列表面板 */}
        {/* 会话列表已移到左侧边栏 AI 助手下方（历史会话区），此处不再内嵌面板 */}

        {/* 对话搜索栏 */}
        {searchOpen && (
          <div className="ai-search-bar">
            <Search size={14} />
            <input autoFocus value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') jumpMatch(e.shiftKey ? -1 : 1); if (e.key === 'Escape') { setSearchOpen(false); setSearchQuery('') } }}
              placeholder={t('搜索当前对话内容…')} />
            <span className="ai-search-count">{searchQuery.trim() ? (searchMatches.length ? `${Math.min(searchIdx + 1, searchMatches.length)}/${searchMatches.length}` : t('无结果')) : ''}</span>
            <button className="ai-icon-btn" onClick={() => jumpMatch(-1)} disabled={searchMatches.length === 0} title={t('上一个（Shift+Enter）')}><ChevronUp size={15} /></button>
            <button className="ai-icon-btn" onClick={() => jumpMatch(1)} disabled={searchMatches.length === 0} title={t('下一个（Enter）')}><ChevronDown size={15} /></button>
            <button className="ai-icon-btn" onClick={() => { setSearchOpen(false); setSearchQuery('') }} title={t('关闭搜索')}><X size={15} /></button>
          </div>
        )}

        {/* 对话导出弹窗 */}
        {exportOpen && (
          <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) setExportOpen(false) }}>
            <div className="modal" style={{ maxWidth: 520 }}>
              <div className="modal-head"><h3 style={{ margin: 0 }}>{t('导出对话记录')}</h3><button className="icon-btn" onClick={() => setExportOpen(false)}><X size={18} /></button></div>
              <div className="modal-body">
                <p style={{ fontSize: 13, lineHeight: 1.6, marginTop: 0 }}>{t('把当前对话导出为 Markdown 文件存档，或复制全文到剪贴板。共 {n} 条消息。', { n: messages.length })}</p>
                <textarea className="input" readOnly rows={8} value={buildChatMarkdown()} style={{ width: '100%', fontSize: 12, lineHeight: 1.6 }} />
              </div>
              <div className="modal-foot">
                <button className="btn" onClick={() => setExportOpen(false)}>{t('取消')}</button>
                <button className="btn" onClick={() => void copyMessage(buildChatMarkdown())}><Copy size={14} /> {t('复制全文')}</button>
                <button className="btn primary" onClick={downloadChat}><Download size={14} /> {t('下载 .md')}</button>
              </div>
            </div>
          </div>
        )}

        {/* 非对话型模型提示卡 */}
        {selectedOption && !canChat && (
          <div className="ai-model-notice">
            <Info size={15} />
            <div>
              <b>{selectedOption.label}</b> {t('属于「{category}」——{desc}。直接在输入框写画面描述并发送，App 会调用该账户 API 地址对应的{endpoint}；若该模型不是生图/生视频模型或接口为私有协议，会返回错误提示，此时请改用官方页面生成。', {
                category: t(selectedOption.category),
                desc: t(CATEGORY_META[selectedOption.category].desc),
                endpoint: t(selectedOption.category === '生图型' ? '「/images/generations」生图接口' : '生视频接口'),
              })}
            </div>
            <button className="btn sm ghost" onClick={() => {
              const url = PROVIDER_MAP[selectedOption.account!.providerId]?.officialUrl
              if (url) void openExternal(url)
              else notify(t('暂无官方地址'))
            }}><ExternalLink size={13} /> {t('官方')}</button>
          </div>
        )}

        {/* 自有模型解锁：固定在对话区顶部，不随滚动消失（与 Key 管理页解锁独立） */}
        {needPwd && <div className="ai-pwd-gate">
          <span className="ai-pwd-gate-label"><Info size={13} /> {t('正在使用自有模型「{label}」，需验证主密码后才能调用（本次会话只需一次，与 Key 管理页解锁互不影响）', { label: currentAccount?.label ?? '' })}</span>
          <div className="ai-pwd-gate-row">
            <input className="input" type="password" placeholder={t('输入主密码')} value={aiPwdInput}
              onChange={e => setAiPwdInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void verifyAiPwd() }} />
            <button className="btn sm primary" disabled={aiPwdBusy || !aiPwdInput} onClick={() => void verifyAiPwd()}>
              {aiPwdBusy ? <><Loader2 size={13} className="spin" /> {t('验证')}</> : t('验证')}
            </button>
          </div>
        </div>}

        {/* 报错换 Key 重试：当前账户调用失败且同平台有备用账户时出现 */}
        {pendingRetry && <div className="ai-retry-bar">
          <span className="ai-pwd-gate-label"><Info size={13} /> {t('当前 Key 调用失败（可能失效或额度不足），同平台还有备用账户。')}</span>
          <div className="ai-pwd-gate-row">
            <button className="btn sm primary" onClick={() => { const r = pendingRetry; setPendingRetry(null); setModel(r.altKey); void send(r.text, r.altKey) }}>
              {t('切换到「{label}」重试', { label: pendingRetry.altLabel })}
            </button>
            <button className="btn sm ghost" onClick={() => setPendingRetry(null)}>{t('不用了')}</button>
          </div>
        </div>}

        {/* 对话区 */}
        <div className="ai-messages">
          {!enteredChat ? (
            <div className="ai-welcome">
              <div className="ai-welcome-mark" onClick={() => { setClonedVoices(listClonedVoices()); setIdentityOpen('bot') }} title={t('点击更换 AI 头像、名字与音色')}><img src={`${import.meta.env.BASE_URL}pwa-512.png`} alt={t('AI 魔方')} className="app-mark-img" /></div>
              <h2>{welcomeText(userProfile.nickname)}</h2>
            </div>
          ) : (
            <div className="ai-thread">
              {messages.map(m => {
                const profile = m.role === 'assistant' ? botProfile : userProfile
                return (
                <div key={m.id} id={`aimsg-${m.id}`} className={`ai-msg ${m.role}${searchMatches.includes(m.id) ? ' search-hit' : ''}${currentMatchId === m.id ? ' search-current' : ''}`}>
                  <div className="ai-avatar avatar-click" title={m.role === 'assistant' ? t('点击更换 AI 头像/名字/音色') : t('点击更换我的头像/昵称/前缀')}
                    style={{ background: avatarBg(profile) }} onClick={() => { setClonedVoices(listClonedVoices()); setIdentityOpen(m.role === 'assistant' ? 'bot' : 'user') }}>{avatarContent(profile)}</div>
                  <div className="ai-msg-body">
                    <div className="ai-bubble" onTouchStart={() => startLongPress(m.content)} onTouchEnd={endLongPress} onTouchMove={endLongPress}>{m.content}</div>
                    {m.content && (
                      <div className="ai-msg-tools">
                        {m.role === 'assistant' && (
                          <button className={`ai-speak ${speakingId === m.id || synthId === m.id ? 'active' : ''}`}
                            onClick={() => toggleSpeak(m)} title={synthId === m.id ? '取消合成' : speakingId === m.id ? t('停止朗读') : t('朗读此回复')}>
                            {synthId === m.id || speakingId === m.id ? <VolumeX size={14} /> : <Volume2 size={14} />}
                            <span>{synthId === m.id ? `合成中…${synthElapsed} 秒` : speakingId === m.id ? t('停止') : t('朗读')}</span>
                          </button>
                        )}
                        <button className="ai-copy" onClick={() => void copyMessage(m.content)} title={t('复制对话内容')}><Copy size={13} /></button>
                      </div>
                    )}
                  </div>
                </div>
                )
              })}
              {generating && streamingText && (
                <div className="ai-msg assistant">
                  <div className="ai-avatar" style={{ background: avatarBg(botProfile) }}>{avatarContent(botProfile)}</div>
                  <div className="ai-bubble">{searching && <span className="ai-search-anim"><Globe size={15} /></span>}<span className="ai-typing">{streamingText}</span><span className="ai-cursor" /></div>
                </div>
              )}
              {generating && !streamingText && (
                <div className="ai-msg assistant">
                  <div className="ai-avatar" style={{ background: avatarBg(botProfile) }}>{avatarContent(botProfile)}</div>
                  <div className="ai-bubble ai-thinking"><span /><span /><span /></div>
                </div>
              )}
              {compareRuns && (
                <div className="ai-compare-wrap">
                  <div className="ai-compare-grid">
                    {compareRuns.map(r => (
                      <div key={r.key} className="ai-compare-col">
                        <div className="ai-compare-head">
                          <b>{r.label}</b>
                          <span>{r.status === 'loading' ? t('生成中…') : r.status === 'error' ? t('失败 · {s}s', { s: (r.ms / 1000).toFixed(1) }) : t('{s}s · {n} 字', { s: (r.ms / 1000).toFixed(1), n: r.text.length })}</span>
                        </div>
                        <div className={`ai-compare-body ${r.status === 'error' ? 'error' : ''}`}>{r.text || (r.status === 'loading' ? '…' : t('（无回复）'))}</div>
                      </div>
                    ))}
                  </div>
                  <button className="btn sm ghost" onClick={() => setCompareRuns(null)}>{t('关闭对比结果')}</button>
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        {/* 输入区 */}
        <div className="ai-compose">
          {attachments.length > 0 && <div className="ai-attachments">
            {attachments.map((a, i) => (
              <div key={i} className="ai-attachment" title={a.name}>
                {a.mime.startsWith('image/') ? <img src={a.dataUrl} alt={a.name} />
                  : a.mime.startsWith('video/') ? <Video size={18} /> : <FileText size={18} />}
                <span>{a.name}</span>
                <button onClick={() => setAttachments(prev => prev.filter((_, j) => j !== i))} title={t('移除')}><X size={13} /></button>
              </div>
            ))}
          </div>}
          {/* 输入框上方同一行（v0.1.499 合并）：左=分类/平台/模型三段级联成组，右=推理等级 + 添加附件，
              两组同一水平线垂直居中（497 时分居两行高低错位，Ethan 截图点名）。三段级联为 v0.1.496 定版
              （原「引擎」按钮已删除，引擎面板从第三段菜单底部进入；菜单向上弹）；「+」与推理菜单行为不变 */}
          <div className="ai-toolbar" onClick={() => setComposeActive(true)}>
            {/* v0.1.497：Ollama 服务开关已移入右上功能菜单的横向图标栏最右组（电源图标），此处不再渲染 */}
            {categoryDropdown}
            {platformDropdown}
            {modelDropdown}
            <div className="ai-toolbar-right">
              <div className="reasoning-wrap">
                <button className="reasoning-btn" onClick={() => setReasoningOpen(v => !v)} title={t(REASONING_DESC[reasoning])}>{t('推理 {level}', { level: reasoning })} <ChevronDown size={12} /></button>
                {reasoningOpen && <div className="reasoning-menu">
                  {REASONING_LEVELS.map(l => (
                    <button key={l} className={`reasoning-option ${l === reasoning ? 'active' : ''}`} title={t(REASONING_DESC[l])}
                      onClick={() => {
                        setReasoning(l); setReasoningOpen(false)
                        notify(t('{level}：{desc}', { level: l, desc: t(REASONING_DESC[l]) }))
                      }}>
                      <span className="reasoning-option-label">{l} {l === reasoning && <span>✓</span>}</span>
                      <small>{t(REASONING_DESC[l])}</small>
                    </button>
                  ))}
                </div>}
              </div>
              <button className="ai-icon-btn" onClick={() => setAttachPickerOpen(true)} title={t('添加附件（点击选择或拖拽）')}><Plus size={18} /></button>
            </div>
          </div>
          <div className="ai-compose-box" onClick={() => setComposeActive(true)}
            onDragOver={e => { e.preventDefault() }}
            onDrop={e => { e.preventDefault(); void addFiles([...e.dataTransfer.files]) }}>
            <textarea ref={textareaRef} className="ai-textarea" rows={1}
              placeholder={attachments.length ? t('对这些附件说点什么…（也可直接发送）') : t('输入你的问题…')} value={input}
              onPaste={e => { if (e.clipboardData.files.length) { e.preventDefault(); void addFiles([...e.clipboardData.files]) } }}
              onChange={e => onInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
              disabled={generating} />
            <button className={`ai-mic-btn ${listening ? 'listening' : ''}`} onClick={() => void toggleMic()} disabled={generating}
              title={listening ? t('停止语音输入') : t('语音输入（点击后说话，文字会填入输入框）')}>
              <Mic size={16} />
            </button>
            {generating ? (
              <button className="ai-send stop" onClick={stop} title={t('停止生成')}><Square size={15} fill="currentColor" /></button>
            ) : (
              <button className="ai-send" onClick={() => void send()} disabled={!input.trim() && attachments.length === 0} title={t('发送')}><Send size={17} /></button>
            )}
          </div>
          {resolvingKey && <div className="ai-hint-inline"><Loader2 size={12} className="spin" /> {t('正在解锁密钥…')}</div>}
        </div>
      </div>
      {/* 右侧引擎选择面板 */}
      {/* v0.1.504：全局模型探测结果面板（照定版预览）：总览 + 分组排名 + 共用说明 + 不可用折叠组 */}
      {probePanelOpen && (
        <>
          <div className="engine-backdrop" onClick={() => setProbePanelOpen(false)} />
          <aside className="probe-panel">
            <div className="engine-panel-head">
              <div>
                <div className="engine-panel-title">{t('模型探测结果')}</div>
                <div className="engine-panel-sub">
                  {probeRunning ? t('探测中…') : (probeSummaryNow.ok + probeSummaryNow.bad > 0 ? t('已完成') : t('尚未探测'))}
                </div>
              </div>
              <button className="icon-btn" onClick={() => setProbePanelOpen(false)}><X size={17} /></button>
            </div>
            <div className="probe-overview">
              <span>{t('共 {total} 个模型，{ok} 可用 / {bad} 不可用', { total: probeSummaryNow.total, ok: probeSummaryNow.ok, bad: probeSummaryNow.bad })}{probeSummaryNow.untested > 0 ? t(' · {n} 未测', { n: probeSummaryNow.untested }) : ''}</span>
              <button className="btn sm" disabled={probeRunning} onClick={() => void runProbeRound(true)}>{probeRunning ? t('探测中…') : t('重新探测')}</button>
            </div>
            <div className="probe-shared-note">
              <div className="probe-shared-title">{t('全 App 共用这一份探测结果')}</div>
              <div className="probe-shared-sub">{t('AI 助手选模型 · 翻译助手选服务商 · 工坊工具 · 图库索引（视觉能力单独标记）')}</div>
            </div>
            {(['free', 'chat', 'general'] as ProbeGroup[]).map(g => {
              const rows = rankProbeGroup(probeTargets, probeStore.results, g)
              if (!rows.length) return null
              const groupName = g === 'free' ? t('免费型') : g === 'chat' ? t('对话型') : t('通用型')
              const rankWord = g === 'general' ? t('最便宜 · 推荐') : t('最快 · 推荐')
              return (
                <div key={g} className="probe-group">
                  <div className="probe-group-title">{groupName}<small>{g === 'general' ? t('按有效价格（标价 ÷ 成功率）') : t('按首字延迟（最近几次中位数）')}</small></div>
                  {rows.map((row, i) => (
                    <div key={row.target.id} className="probe-row">
                      <span className="probe-rank">{i + 1}</span>
                      <span className={`probe-dot ${row.result ? (row.result.ok ? 'ok' : 'bad') : 'none'}`} />
                      <span className="probe-row-name">{row.target.name}</span>
                      <span className="probe-row-plat">{row.target.platformName}</span>
                      <span className="probe-row-metric">{row.metricLabel}</span>
                      {row.recommended && <span className="probe-rec-badge">{rankWord}</span>}
                    </div>
                  ))}
                </div>
              )
            })}
            {(() => {
              const visionTargets = probeTargets.filter(x => x.vision)
              if (!visionTargets.length) return null
              return (
                <div className="probe-group">
                  <div className="probe-group-title">{t('视觉型')}<small>{t('视觉能力单独测、单独标记，图库索引只读这里')}</small></div>
                  {visionTargets.map(x => {
                    const r = probeStore.results[x.id]
                    return (
                      <div key={x.id} className="probe-row">
                        <span className={`probe-dot ${r?.visionOk === true ? 'ok' : r?.visionOk === false ? 'bad' : 'none'}`} />
                        <span className="probe-row-name">{x.name}</span>
                        <span className="probe-row-plat">{x.platformName}</span>
                        <span className="probe-row-metric">{r?.visionOk === true ? t('视觉可用') : r?.visionOk === false ? t('视觉不可用') : t('视觉未测')}</span>
                      </div>
                    )
                  })}
                </div>
              )
            })()}
            <div className="probe-guard-note">{t('护栏：MoMA 合作模型等按量计费的模型不自动测，避免扣费；它们保留手动单测。探测只是参考，不拦发送、不改你已选的模型。')}</div>
            {probeUnavail.length > 0 && (
              <div className="probe-group">
                <button className="probe-fold-head" onClick={() => setProbeFoldOpen(v => !v)}>
                  <span>{t('暂时不可用（{n}）', { n: probeUnavail.length })}</span>
                  <ChevronDown size={14} style={{ transform: probeFoldOpen ? 'rotate(180deg)' : undefined }} />
                </button>
                {probeFoldOpen && probeUnavail.map(({ target, result }) => (
                  <div key={target.id} className="probe-row probe-unavail-item">
                    <span className="probe-dot bad" />
                    <span className="probe-row-name">{target.name}</span>
                    <span className="probe-row-plat">{target.platformName}</span>
                    <span className="probe-row-metric">{result.failReason ?? t('调用失败')} · {new Date(result.checkedAt).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}</span>
                    <button className="btn sm" disabled={probeSingleId === target.id} onClick={() => void probeSingle(target)}>{probeSingleId === target.id ? t('测速中…') : t('单测')}</button>
                  </div>
                ))}
              </div>
            )}
          </aside>
        </>
      )}
      {enginePanelOpen && currentAccount && (
        <>
          <div className="engine-backdrop" onClick={() => setEnginePanelOpen(false)} />
          <aside className="engine-panel">
            <div className="engine-panel-head">
              <div>
                <div className="engine-panel-title">{t('模型引擎')}</div>
                <div className="engine-panel-sub">
                  {t('{name} · 按 token 消耗从低到高', { name: PROVIDER_MAP[currentAccount.providerId]?.shortName ?? currentAccount.label })}
                  {loadingEngines && t(' · 正在获取实时引擎…')}
                  {!loadingEngines && engineSource === 'remote' && t(' · 实时获取')}
                  {!loadingEngines && engineSource === 'builtin' && t(' · 内置参考')}
                </div>
              </div>
              <button className="icon-btn" onClick={() => setEnginePanelOpen(false)}><X size={17} /></button>
            </div>
            {isMomaAccount ? (
              <>
                <div className="engine-probe-bar">
                  <button className="btn sm" disabled={momaSweeping} onClick={() => {
                    setMomaTests(loadMomaModelTests(currentAccount))
                    void runMomaSweep(engines.map(e => e.id).filter(isMomaAutoTestable))
                  }}>{momaSweeping ? t('轮测中…') : t('重新测试')}</button>
                  <span>{t('打开列表时自动轮测九天自营对话模型（走 2500 万免费试用额度）；合作模型自动测可能扣按量费，不自动测，可逐个手动测试')}</span>
                </div>
                <div className="moma-free-bar">
                  <label className="moma-free-toggle">
                    <input type="checkbox" checked={momaFreeOnly} onChange={ev => { setMomaFreeOnly(ev.target.checked); saveMomaFreeOnly(ev.target.checked) }} />
                    {t('只显示免费通道（仅九天自营）')}
                  </label>
                  {momaFreeOnly && engines.some(e => !isMomaSelfOperated(e.id)) && (
                    <span className="moma-hidden-note">{t('已隐藏 {n} 个合作模型', { n: engines.filter(e => !isMomaSelfOperated(e.id)).length })}</span>
                  )}
                </div>
                {momaSweepNote && <div className="moma-sweep-note">{momaSweepNote}</div>}
              </>
            ) : (
              <div className="engine-probe-bar">
                <button className="btn sm" disabled={probing} onClick={() => void probeEngines()}>{probing ? t('探测中…') : t('探测可用性')}</button>
                <span>{t('只给对话模型发一条极短消息验证真能出话（非对话模型自动跳过，最多 12 个，会消耗极少量额度）')}</span>
              </div>
            )}
            <div className="engine-list">
              {isMomaAccount ? (() => {
                const visible = momaFreeOnly ? engines.filter(e => isMomaSelfOperated(e.id)) : engines
                const byId = new Map(visible.map(e => [e.id, e]))
                const groups = groupMomaModels(visible.map(e => e.id), momaTests)
                if (!loadingEngines && visible.length === 0) return <div className="engine-empty">{t('没有符合条件的模型')}</div>
                return groups.map(g => (
                  <div key={g.category} className="engine-group">
                    <button className="engine-group-head" onClick={() => toggleMomaGroup(g.category)}>
                      {momaCollapsed.has(g.category) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                      <span>{t(MOMA_CATEGORY_LABEL[g.category])}</span>
                      <span className="engine-group-count">{g.ids.length}</span>
                    </button>
                    {!momaCollapsed.has(g.category) && g.ids.map(id => renderMomaItem(byId.get(id)!, g.category))}
                  </div>
                ))
              })() : engines.map(e => (
                <button key={e.id} className={`engine-item ${engineId === e.id ? 'active' : ''}`}
                  onClick={() => { setEngineId(e.id); notify(t('已选引擎：{name}', { name: e.name })) }}>
                  <span className="engine-icon">{e.reasoning ? '🧠' : '⚡'}</span>
                  <span className="engine-info">
                    <span className="engine-name">{e.name}
                      {e.tag && <em className={`engine-tag ${e.tag === '夜间折扣' ? 'discount' : e.tag === '订阅优先' ? 'sub' : ''}`}>{t(e.tag)}</em>}
                    </span>
                    <span className="engine-id">{e.id}</span>
                    {currentAccount.providerId === MOMA_PROVIDER_ID && (
                      <span className="engine-billing-note">{t(momaModelBillingNote(e.id))}</span>
                    )}
                  </span>
                  <span className="engine-multi">{e.multiplier.toFixed(2)}x</span>
                  {probeResults[e.id] && (
                    probeResults[e.id].skipped ? (
                      <span className="engine-probe skip" title={probeResults[e.id].error ?? ''}>{t('○ 非对话模型')}</span>
                    ) : (
                      <span className={`engine-probe ${probeResults[e.id].ok ? 'ok' : 'fail'}`} title={probeResults[e.id].error ?? ''}>
                        {probeResults[e.id].ok ? `● ${probeResults[e.id].ms}ms` : t('● 不可用')}
                      </span>
                    )
                  )}
                  {engineId === e.id && <span className="engine-check">✓</span>}
                </button>
              ))}
              {loadingEngines && <div className="engine-empty"><Loader2 size={22} className="spin" /><div style={{ marginTop: 10 }}>{t('正在从官方接口获取可用引擎…')}</div></div>}
              {!loadingEngines && engines.length === 0 && <div className="engine-empty">{t('该平台暂无内置引擎目录。')}<br />{t('请到 API Key 管理页检查账户平台，或手动填写引擎名。')}</div>}
            </div>
            <div className="engine-note">
              <Info size={12} /> {t('倍率为参考值，用于排序；实际计费以官方账单为准。部分引擎需订阅或支持推理等级。')}
            </div>
          </aside>
          {momaConfirmId && (
            <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) setMomaConfirmId(null) }}>
              <div className="modal" style={{ maxWidth: 420 }}>
                <div className="modal-head"><h3 style={{ margin: 0 }}>{t('测试合作模型')}</h3><button className="icon-btn" onClick={() => setMomaConfirmId(null)}><X size={18} /></button></div>
                <div className="modal-body">
                  <p style={{ fontSize: 13, lineHeight: 1.6, margin: 0 }}>{t('测试会真实调用一次「{name}」，可能扣按量费（该模型不在 2500 万免费试用覆盖范围内）。确定测试？', { name: momaConfirmId })}</p>
                </div>
                <div className="modal-foot">
                  <button className="btn" onClick={() => setMomaConfirmId(null)}>{t('取消')}</button>
                  <button className="btn primary" onClick={() => void testMomaPartnerModel(momaConfirmId)}>{t('确认测试')}</button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {attachPickerOpen && <AttachmentPicker
        onClose={() => setAttachPickerOpen(false)}
        onConfirm={(items) => {
          setAttachments(prev => [...prev, ...items])
          setAttachPickerOpen(false)
          notify(t('已添加 {n} 个附件', { n: items.length }))
        }}
        notify={notify}
      />}

      {identityOpen && <IdentityModal
        kind={identityOpen}
        bot={botProfile}
        user={userProfile}
        voices={clonedVoices.map(v => ({ id: v.id, name: v.name, voiceId: v.voiceId }))}
        onClose={() => setIdentityOpen(null)}
        onSaveBot={(p) => { saveBotProfile(p); setBotProfile(p); setIdentityOpen(null); notify(t('AI 身份已保存，切换模型也不会重置')) }}
        onSaveUser={(p) => { saveUserProfile(p); setUserProfile(p); setIdentityOpen(null); notify(t('我的身份与回答前缀已保存')) }}
      />}

      {callOpen && <VoiceCall
        voiceURI={botProfile.voiceURI}
        onSend={async (text) => {
          // 语音通话：用口语化提示，回复简短自然；不写入文字对话记录，全程只朗读
          return getReply(text, messages, undefined, undefined, true)
        }}
        onClose={() => setCallOpen(false)}
        notify={notify}
        needPwd={needPwd}
        onUnlock={async (pwd) => {
          const ok = await verifyVault(pwd)
          if (!ok) { notify(t('主密码错误')); return false }
          setAiPwd(pwd)
          notify(t('已验证，本次会话可正常通话'))
          return true
        }}
      />}
    </div>
  )
}

/** AI / 我的身份设置弹窗：仅存本机，不随云同步；同一账号不同平台互相独立。 */
function IdentityModal({ kind, bot, user, voices, onClose, onSaveBot, onSaveUser }: {
  kind: 'bot' | 'user'
  bot: BotProfile
  user: UserProfile
  voices: { id: string; name: string; voiceId: string }[]
  onClose: () => void
  onSaveBot: (p: BotProfile) => void
  onSaveUser: (p: UserProfile) => void
}) {
  const isBot = kind === 'bot'
  const [avatarId, setAvatarId] = useState(isBot ? bot.avatarId : user.avatarId)
  const [avatarDataUrl, setAvatarDataUrl] = useState<string | undefined>(isBot ? bot.avatarDataUrl : user.avatarDataUrl)
  const [name, setName] = useState(isBot ? bot.name : user.nickname)
  const [voiceURI, setVoiceURI] = useState<string | null>(bot.voiceURI)
  const [phrase, setPhrase] = useState(user.phrase)

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" style={{ maxWidth: 460 }}>
        <div className="modal-head"><h3>{isBot ? t('设置 AI 助手') : t('设置我的资料')}</h3><button className="icon-btn" onClick={onClose}><X size={18} /></button></div>
        <div className="modal-body">
          <div className="field-label" style={{ marginTop: 0 }}>{t('头像')}</div>
          <div className="identity-avatars">
            {AVATAR_PRESETS.map(a => (
              <button key={a.id} title={t(a.label)} className={`identity-avatar ${avatarId === a.id ? 'active' : ''}`}
                style={{ background: a.color }} onClick={() => { setAvatarId(a.id); setAvatarDataUrl(undefined) }}>{a.emoji}</button>
            ))}
            <label className={`identity-avatar identity-upload ${avatarId === 'custom' ? 'active' : ''}`} title={t('上传自定义图片（等比缩放）')}>
              {avatarDataUrl ? <img src={avatarDataUrl} alt={t('自定义头像')} /> : <ImageIcon size={17} />}
              <input type="file" accept="image/*" style={{ display: 'none' }} onChange={e => {
                const file = e.target.files?.[0]
                if (file) void resizeAvatarImage(file).then(url => { setAvatarDataUrl(url); setAvatarId('custom') }).catch(() => {})
                e.target.value = ''
              }} />
            </label>
          </div>
          <label className="form-label" style={{ marginTop: 16 }}>
            {isBot ? t('AI 名字') : t('我的昵称')}
            <input className="input" value={name} maxLength={20} onChange={e => setName(e.target.value)} placeholder={isBot ? t('AI 助手') : t('我')} />
          </label>
          {isBot ? (
            <label className="form-label" style={{ marginTop: 12 }}>
              {t('说话音色（AI 复刻音色）')}
              <select className="select" value={voiceURI ?? ''} onChange={e => setVoiceURI(e.target.value || null)}>
                <option value="">{t('跟随全局音色设置')}</option>
                {voices.map(v => <option key={v.id} value={v.voiceId}>{v.name}</option>)}
              </select>
              <span style={{ display: 'block', fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>
                {voices.length === 0
                  ? t('还没有克隆音色，请到「语音配置 → 声音克隆」创建一个。')
                  : t('选择后 AI 朗读会用这个克隆音色；在「语音配置」里增删改音色会自动同步到这里。')}
              </span>
            </label>
          ) : (
            <label className="form-label" style={{ marginTop: 12 }}>
              {t('AI 回答前缀短语 / 词组')}
              <input className="input" value={phrase} maxLength={30} onChange={e => setPhrase(e.target.value)} placeholder={t('例如：请注意')} />
              <span style={{ display: 'block', fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>{t('每次回答开头会显示“昵称：短语”，例如“小明：请注意”。')}</span>
            </label>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>{t('取消')}</button>
          <button className="btn primary" disabled={!name.trim()} onClick={() => {
            if (isBot) onSaveBot({ avatarId, avatarDataUrl, name: name.trim(), voiceURI })
            else onSaveUser({ avatarId, avatarDataUrl, nickname: name.trim(), phrase: phrase.trim() })
          }}>{t('完成')}</button>
        </div>
      </div>
    </div>
  )
}
