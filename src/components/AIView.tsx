// AI 助手聊天页：类 WorkBuddy 的干净对话界面。
// 布局自适应：桌面居中宽栏、移动端占满屏；流式输出、可中止、快捷提问。

import { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import {
  Send, Square, Plus, ChevronDown, ChevronUp, Copy, Volume2, VolumeX,
  Phone, Layers, ExternalLink, Info, Loader2, FileText, Image as ImageIcon, Video, X, RotateCcw, Cpu, Mic,
  Search, Download, Database, BookMarked, Columns2, Trash2, MessagesSquare, Pencil,
} from 'lucide-react'
import {
  listModels, loadHistory, rotateConversationId,
  loadModel, saveModel, streamChat, friendlyAiError,
  type ChatMessage, type AiModel,
} from '../core/ai'
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
import { dedupeSameKeyAccounts } from '../core/adapters'
import { loadState } from '../core/store'
import { buildDataDigest } from '../core/dataDigest'
import { callByCategory, fetchProviderModels, callLocalChat, fetchLocalAssistantModels } from '../core/providerCall'
import type { Account, PromptTemplate } from '../core/types'
import { LOCAL_SERVICE_CHANGED_EVENT, isAccountServiceEnabled, shouldShowLocalCategory } from '../core/localServicesSettings'
import { decryptSecret, getBiometricPassword, verifyVault } from '../core/crypto'
import { PROVIDER_MAP } from '../data/providers'
import {
  isTextAttachment, decodeAttachmentText, type PickedAttachment,
} from '../core/attachments'
import { AttachmentPicker } from './AttachmentPicker'
import { ServiceSwitch } from './ServiceSwitch'
import {
  enginesFor, enginesFromRemote, hasCatalog, REASONING_LEVELS, REASONING_DESC, toReasoningEffort, defaultReasoningLevel,
  type ReasoningLevel,
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
    return `${greet}，${defaultName}`
  }
  return `${greet}，${name}`
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

export function AIView({ notify, accounts, settings, serviceController, prompts, onPromptsChange }: {
  notify: (m: string) => void
  accounts: Account[]
  settings?: import('../core/types').AppSettings
  serviceController?: import('../core/useServiceController').ServiceController
  prompts?: PromptTemplate[]
  onPromptsChange?: (p: PromptTemplate[]) => void
}) {
  const [sessionStore, setSessionStore] = useState<{ sessions: ChatSession[]; activeId: string }>(loadSessionStore)
  const [messages, setMessages] = useState<ChatMessage[]>(() => sessionStore.sessions.find(s => s.id === sessionStore.activeId)?.messages ?? [])
  const [input, setInput] = useState('')
  const [generating, setGenerating] = useState(false)
  const [models, setModels] = useState<AiModel[]>([])
  const [needLogin, setNeedLogin] = useState(false)
  const [model, setModel] = useState<string>('')
  const [modelOpen, setModelOpen] = useState(false)
  const [category, setCategory] = useState<ModelCategory>('免费模型')
  const [categoryOpen, setCategoryOpen] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const [speakingId, setSpeakingId] = useState<string | null>(null)
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
      onProcessing: () => notify('录音结束，正在转写成文字…'),
    })
    if (!session) { setListening(false); return }
    speechRef.current = session
  }
  const longPressRef = useRef<number | null>(null)

  const avatarContent = (p: BotProfile | UserProfile) => p.avatarDataUrl
    ? <img className="ai-avatar-img" src={p.avatarDataUrl} alt="头像" />
    : getAvatar(p.avatarId).emoji
  const avatarBg = (p: BotProfile | UserProfile) => getAvatar(p.avatarId).color

  const copyMessage = async (text: string) => {
    try { await navigator.clipboard.writeText(text); notify('已复制对话内容') }
    catch {
      const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); notify('已复制对话内容')
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
      if (saved?.startsWith('own:')) return  // 恢复的是自己的账户，由 allOptions 匹配（下方 effect）
      const picked = saved && list.some(m => m.id === saved) ? saved : list[0]?.id
      if (picked) setModel(picked)
    }).catch(e => {
      if (!alive) return
      const msg = String((e as Error)?.message ?? e)
      // 未登录云同步时免费模型不可用：不弹错误 toast，只在模型菜单里给登录提示
      if (msg.includes('401') || msg.toLowerCase().includes('login')) { setNeedLogin(true); return }
      notify(`模型加载失败：${friendlyAiError(e)}`)
    })
    return () => { alive = false }
  }, [notify])

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
  useEffect(() => { saveSessionStore(sessionStore) }, [sessionStore])
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  const switchSession = (id: string) => {
    const target = sessionStore.sessions.find(s => s.id === id)
    if (!target) return
    setSessionStore(store => ({ ...store, activeId: id }))
    setMessages(target.messages)
    setSessionsOpen(false)
    setCompareRuns(null)
  }
  const newSession = () => {
    const s: ChatSession = { id: `sess-${Date.now()}`, title: '新对话', messages: [], updatedAt: Date.now() }
    setSessionStore(store => ({ sessions: [s, ...store.sessions], activeId: s.id }))
    setMessages([])
    setSessionsOpen(false)
    rotateConversationId()
  }
  const deleteSession = (id: string) => {
    const rest = sessionStore.sessions.filter(s => s.id !== id)
    if (!rest.length) {
      const fresh: ChatSession = { id: `sess-${Date.now()}`, title: '新对话', messages: [], updatedAt: Date.now() }
      setSessionStore({ sessions: [fresh], activeId: fresh.id })
      setMessages([])
      return
    }
    if (sessionStore.activeId === id) {
      setSessionStore({ sessions: rest, activeId: rest[0].id })
      setMessages(rest[0].messages)
    } else {
      setSessionStore(store => ({ ...store, sessions: rest }))
    }
  }
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, streamingText])

  // 本地型：Ollama 服务开启时自动拉取本机可用模型（文本+视觉，排除嵌入/生图/视频/语音）
  const [localModels, setLocalModels] = useState<string[]>([])
  const localAutoSwitched = useRef(false)
  const ollamaEnabled = useMemo(() => {
    const svc = (settings?.localServices as Record<string, boolean> | undefined)
    return svc?.ollama !== false
  }, [settings])
  useEffect(() => {
    let alive = true
    if (!ollamaEnabled) {
      setLocalModels([]); localAutoSwitched.current = false
      // 服务关闭时若停在「本地型」，切回有模型的分类
      setCategory(prev => {
        if (prev !== '本地型') return prev
        return '免费模型'
      })
      setModel('')
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
        // 开启开关后首次拉到模型，自动切到本地型并选中第一个
        if (ids.length && !localAutoSwitched.current) {
          localAutoSwitched.current = true
          setCategory('本地型')
          setModel(`local:${ids[0]}`)
        }
      }).catch(() => { if (alive) setLocalModels([]) })
    }, 1200)
    return () => { alive = false; window.clearTimeout(timer) }
  }, [ollamaEnabled])

  // 免费模型 + 用户自己的账户模型，按分类联动过滤
  const freeOptions = useMemo(() => models.map(m => ({ key: m.id, label: m.name, account: null as Account | null, category: '免费模型' as ModelCategory, free: true, localModel: undefined as string | undefined })), [models])
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
      label: `${a.label}${a.note ? ` · ${a.note.replace(/^\[[^\]]+\]\s*/, '')}` : ''}`,
      account: a,
      category: categoryForModel(a.note) as ModelCategory,
      free: false,
      localModel: undefined as string | undefined,
    })), [accounts, settings])
  // 本机 Ollama 模型作为「本地型」选项（无账户、无 Key，直接调本机服务）
  const localOptions = useMemo(() => localModels.map(m => ({
    key: `local:${m}`,
    label: m,
    account: null as Account | null,
    category: '本地型' as ModelCategory,
    free: false,
    localModel: m,
  })), [localModels])
  const allOptions = useMemo(() => [...freeOptions, ...ownOptions, ...localOptions], [freeOptions, ownOptions, localOptions])
  const visibleOptions = useMemo(() => allOptions.filter(o => o.category === category), [category, allOptions])
  const selectedOption = allOptions.find(o => o.key === model) ?? null
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
      if (!ok) { notify('主密码错误'); return }
      setAiPwd(aiPwdInput)
      setAiPwdInput('')
      notify('已验证，本次会话调用自有模型无需再次输入')
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

  // 引擎列表变化时：保留仍有效的选择，否则优先旗舰模型（无旗舰则取第一个）
  useEffect(() => {
    if (currentAccount) {
      setEngineId(prev => engines.some(e => e.id === prev) ? prev : (engines.find(e => e.flagship)?.id ?? engines[0]?.id ?? ''))
    } else setEngineId('')
  }, [currentAccount, engines])

  /** 统一取回复：用户自己的账户走其 API，否则走平台免费模型 */
  const getReply = async (content: string, history: ChatMessage[], signal?: AbortSignal, images?: string[], voiceMode = false, optKey?: string, onDelta?: (d: string) => void): Promise<string> => {
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
    // 语音模式：关闭推理、只带最近 2 条上下文，最大限度缩短首字延迟
    const effectiveReasoning = voiceMode ? undefined : toReasoningEffort(reasoning)
    const voiceHistory = voiceMode ? history.slice(-2) : history
    // 用户自己的账户：用其 Key 真正调用
    if (opt?.account) {
      const acct = opt.account
      if (!acct.encryptedKey) throw new Error('该账户未配置 API Key，请在 API Key 管理页添加')
      const pwd = resolvePwd()
      if (!pwd) {
        // 不再拦截去 Key 管理页解锁，就地提示输入本次会话密码（见输入区上方的内嵌输入）
        notify('请输入主密码以调用自有模型（本次会话只需一次）')
        throw Object.assign(new Error('__NEED_AI_PWD__'), { needPwd: true })
      }
      setResolvingKey(true)
      let apiKey: string
      try { apiKey = await decryptSecret(acct.encryptedKey, pwd) }
      catch {
        // 解密失败通常意味着：保险箱材料已变更（改过主密码/重置/云同步覆盖），或该 Key 是用另一个主密码加密的
        const hint = '此 API Key 无法解密：保险箱主密码已变更或该密钥由另一主密码加密。请到「设置 → 安全」用当前主密码重新添加该 Key'
        notify(hint)
        throw Object.assign(new Error(hint), { needPwd: true })
      }
      finally { setResolvingKey(false) }
      const msgs = [{ role: 'system', content: effectiveSystemPrompt }, ...voiceHistory.map(m => ({ role: m.role, content: m.content })), { role: 'user', content }]
      const r = await callByCategory(acct, apiKey, opt.category, msgs, engineId || undefined, effectiveReasoning)
      if (!r.ok) throw Object.assign(new Error(r.error ?? '调用失败'), { cors: r.cors })
      if (r.images?.length) {
        return `${r.text}\n${r.images.map(u => u.startsWith('data:') ? '[已生成图片]' : u).join('\n')}`
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
      const r = await callLocalChat('http://127.0.0.1:11434', opt.localModel, msgs, images)
      if (!r.ok) throw new Error(r.error ?? '本地模型调用失败')
      return r.text
    }
    // 平台免费模型：流式输出（图片附件随多模态消息发送）
    // 指定了 optKey（换 Key 重试/多模型对比）时按该选项自己的模型 id 调用，否则用当前所选模型
    return streamChat(opt?.free ? opt.key : (model || 'auto'), voiceHistory, content, delta => { if (onDelta) onDelta(delta); else setStreamingText(prev => prev + delta) }, signal, images, effectiveReasoning, effectiveSystemPrompt)
  }

  // 报错自动换 Key：调用失败（鉴权/额度类）时，若同平台还有别的可用账户，给出「一键切换重试」
  const [pendingRetry, setPendingRetry] = useState<{ text: string; altKey: string; altLabel: string } | null>(null)

  const send = async (text?: string, optKey?: string) => {
    const content = (text ?? input).trim()
    const hasAttach = attachments.length > 0
    if ((!content && !hasAttach) || generating) return
    // 对比模式：同一个问题并行发给所选的 2–3 个模型（换 Key 重试等带 optKey 的调用不走对比）
    if (compareMode && !optKey) {
      if (hasAttach) { notify('对比模式暂不支持附件，请先移除附件'); return }
      if (compareKeys.length < 2) { notify('对比模式：请先在上方选择至少 2 个模型'); return }
      await runCompare(content)
      return
    }
    const effectiveText = content || '请分析这些附件'
    if (!model && !optKey) { notify('模型尚未就绪，请稍候'); return }
    // 生图型/视频型：允许发送提示词，交给 callByCategory 调用生图/视频接口（不再拦截）
    // 自有模型需要先有解密凭据：给出持久可见的对话提示，避免"打字没反应"
    if (needPwd) {
      notify('请先在上方的密码框验证主密码，再发送消息')
      setMessages(prev => [...prev,
        { id: `u-${Date.now()}`, role: 'user', content, at: Date.now() },
        { id: `err-${Date.now()}`, role: 'assistant', content: `🔒 当前使用自有模型「${currentAccount?.label ?? ''}」，需先在上方密码框验证主密码（本次会话只需一次），验证后请重新发送。`, at: Date.now() },
      ])
      return
    }
    setInput('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    const imageUrls = attachments.filter(a => a.mime.startsWith('image/')).map(a => a.dataUrl)
    const attachNote = attachments.length ? `\n${attachments.map(a => `[附件:${a.name}]`).join(' ')}` : ''
    // 文本/文档附件：把真实内容解码后随消息发给 AI。
    // 之前的版本只把文件名拼给用户气泡、AI 侧只收到有效文字，导致“AI 说看不到文件内容”。
    const textBlocks = attachments.filter(isTextAttachment).map(a => {
      const raw = decodeAttachmentText(a)
      const text = raw.length > 12000 ? `${raw.slice(0, 12000)}\n…（内容过长，已截断）` : raw
      return `----- 附件：${a.name} -----\n${text || '（该文件无可读文本内容）'}`
    })
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
        const fe = firstErr as { needPwd?: boolean; message?: string }
        const retryable = !fe?.needPwd && /401|403|unauthor|invalid|api ?key|余额|额度|quota|insufficient|身份验证|过期|429|rate limit/i.test(fe?.message ?? '')
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
        failoverNote = `\n\n（原账户调用失败，已自动切换到备用账户「${switched}」）`
        notify(`已自动切换到备用账户「${switched}」`)
      }
      setPendingRetry(null)
      setMessages(prev => [...prev, { id: `${Date.now()}-a`, role: 'assistant', content: (answer || '（无回复内容）') + failoverNote, at: Date.now() }])
      // 自动朗读：AI 回复完成且未被中止时，朗读清洗后的纯文字
      if (autoSpeak && answer && !controller.signal.aborted) {
        const spoken = cleanForAutoSpeech(answer)
        if (spoken) {
          void speakAsync(spoken, botProfile.voiceURI ?? getSavedVoice(), (s) => {
            setSpeakingId(s === 'start' ? 'auto' : null)
          })
        }
      }
    } catch (e) {
      const need = (e as { needPwd?: boolean })?.needPwd
      const msg = friendlyAiError(e)
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
          const hint = need ? '🔒 当前为自有模型，请先在上方的密码框验证主密码，然后重新发送。'
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
    if (speakingId === m.id) { stopSpeak(); setSpeakingId(null); return }
    void speakAsync(m.content, botProfile.voiceURI ?? getSavedVoice(), (state) => {
      if (state === 'end' || state === 'error') setSpeakingId(null)
    }, (reason) => notify(reason)).then(ok => {
      if (!ok) { notify('当前环境不支持语音朗读'); return }
      setSpeakingId(m.id)
    })
  }

  useEffect(() => () => { stopSpeak() }, [])

  const clear = () => {
    if (generating) stop()
    setMessages([])
    setSessionStore(store => ({ ...store, sessions: store.sessions.map(s => s.id === store.activeId ? { ...s, title: '新对话' } : s) }))
    rotateConversationId()
    notify('已开启新对话')
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
  const jumpMatch = (dir: 1 | -1) => {
    if (!searchMatches.length) return
    const next = (searchIdx + dir + searchMatches.length) % searchMatches.length
    setSearchIdx(next)
    document.getElementById(`aimsg-${searchMatches[next]}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
  useEffect(() => {
    if (searchMatches.length) {
      setSearchIdx(0)
      document.getElementById(`aimsg-${searchMatches[0]}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
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
      notify(next ? '已开启「引用我的数据」：问额度、消费、签到时，助手会按你的真实数据回答' : '已关闭「引用我的数据」：对话不再附带你的本地数据')
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
      if (prev.length >= 3) { notify('对比最多选 3 个模型'); return prev }
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
      try {
        const ans = await getReply(content, history, controller.signal, undefined, false, k, (d) => {
          setCompareRuns(prev => prev ? prev.map(r => r.key === k ? { ...r, text: r.text + d } : r) : prev)
        })
        setCompareRuns(prev => prev ? prev.map(r => r.key === k ? { ...r, status: 'done' as const, text: ans || r.text, ms: Date.now() - t0 } : r) : prev)
      } catch (e) {
        setCompareRuns(prev => prev ? prev.map(r => r.key === k ? { ...r, status: 'error' as const, text: (e as Error)?.message ?? '调用失败', ms: Date.now() - t0 } : r) : prev)
      }
    }))
    setGenerating(false)
  }
  // ---- 引擎可用性探测（给当前账户的每个引擎发一条极短消息验证真能出话） ----
  const [probeResults, setProbeResults] = useState<Record<string, { ok: boolean; ms: number; error?: string }>>({})
  const [probing, setProbing] = useState(false)
  const probeEngines = async () => {
    if (!currentAccount?.encryptedKey) { notify('当前账户未配置 Key，无法探测'); return }
    const pwd = resolvePwd()
    if (!pwd) { notify('请先解锁保险箱，再探测引擎可用性'); return }
    let apiKey = ''
    try { apiKey = await decryptSecret(currentAccount.encryptedKey, pwd) } catch { notify('Key 解密失败，无法探测'); return }
    setProbing(true)
    setProbeResults({})
    const targets = engines.slice(0, 12)
    await Promise.all(targets.map(async (e) => {
      const t0 = Date.now()
      try {
        const r = await callByCategory(currentAccount, apiKey, selectedOption?.category ?? '通用型', [{ role: 'user', content: 'ping' }], e.id, undefined)
        setProbeResults(prev => ({ ...prev, [e.id]: r.ok ? { ok: true, ms: Date.now() - t0 } : { ok: false, ms: Date.now() - t0, error: r.error ?? '调用失败' } }))
      } catch (err) {
        setProbeResults(prev => ({ ...prev, [e.id]: { ok: false, ms: Date.now() - t0, error: (err as Error)?.message ?? '调用失败' } }))
      }
    }))
    setProbing(false)
    notify(`引擎探测完成（共 ${targets.length} 个）`)
  }
  // ---- 提示词库 ----
  const [promptsOpen, setPromptsOpen] = useState(false)
  const [promptTitle, setPromptTitle] = useState('')
  const promptList = prompts ?? []
  const savePromptFromInput = () => {
    const body = input.trim()
    if (!body) { notify('输入框是空的，先写好提示词再存为模板'); return }
    if (!onPromptsChange) return
    const title = promptTitle.trim() || body.slice(0, 18)
    onPromptsChange([{ id: `pt-${Date.now()}`, title, body, createdAt: new Date().toISOString() }, ...promptList])
    setPromptTitle('')
    notify(`已存为模板「${title}」`)
  }
  const insertPrompt = (body: string) => {
    setInput(prev => prev.trim() ? `${prev}\n${body}` : body)
    setPromptsOpen(false)
    textareaRef.current?.focus()
  }
  const buildChatMarkdown = () => {
    const lines = [
      '# AI 助手对话记录',
      '',
      `导出时间：${new Date().toLocaleString('zh-CN')}`,
      `模型：${currentModel}`,
      '',
      '---',
      '',
    ]
    for (const m of messages) {
      lines.push(`**${m.role === 'user' ? '我' : 'AI 助手'}：**`)
      lines.push('')
      lines.push(m.content)
      lines.push('')
    }
    return lines.join('\n')
  }
  const downloadChat = () => {
    const blob = new Blob([buildChatMarkdown()], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    const p = (n: number) => String(n).padStart(2, '0')
    const d = new Date()
    link.href = url
    link.download = `AI对话记录-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.md`
    link.click()
    URL.revokeObjectURL(url)
    setExportOpen(false)
    notify('对话记录已导出为 Markdown 文件')
  }

  const onInput = (v: string) => {
    setInput(v)
    const el = textareaRef.current
    if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 160) + 'px' }
  }

  const currentModel = selectedOption?.account
    ? `${PROVIDER_MAP[selectedOption.account.providerId]?.shortName ?? selectedOption.account.label}${selectedEngine ? ` · ${selectedEngine.name}` : ''}`
    : selectedOption?.label ?? '选择模型'
  const hasChat = messages.length > 0 || generating
  const callEnabled = !selectedOption || CATEGORY_META[selectedOption.category].canChat
  // 对话态：点击输入框或发送后进入，欢迎语/图标隐藏、输入框落到底部；进入页或切回来时复位居中
  const [composeActive, setComposeActive] = useState(false)
  useEffect(() => { if (!hasChat) setComposeActive(false) }, [hasChat])
  // 引擎面板只在对话态需要时保留开关状态，切走对话复位
  const enteredChat = composeActive || hasChat
  const layoutMode = !enteredChat ? 'welcome' : (hasChat ? 'chat' : 'focus')

  // 工具条下拉：分类 / 模型（与模型下拉联动）
  const categoryDropdown = <div className="ai-model-wrap">
    <button className="ai-model-btn" onClick={() => { setCategoryOpen(v => !v); setModelOpen(false) }} title="模型分类">
      <Layers size={13} /> {category} <ChevronDown size={13} />
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
          <span>{CATEGORY_META[c].icon} {c}</span>
          <small>{allOptions.filter(o => o.category === c).length}</small>
        </button>
      ))}
    </div>}
  </div>
  const modelDropdown = <div className="ai-model-wrap">
    <button className="ai-model-btn" onClick={() => { setModelOpen(v => !v); setCategoryOpen(false) }} title="切换模型">
      {currentModel} <ChevronDown size={13} />
    </button>
    {modelOpen && <div className="ai-model-menu me-panel-in" key={`model-${category}`}>
      {visibleOptions.length === 0 && <div className="ai-model-empty">{category === '免费模型' && needLogin ? '免费模型需先登录云同步：点左侧边栏底部的同步状态条即可登录' : '该分类暂无模型，请到 API Key 管理页添加'}</div>}
      {visibleOptions.map(o => (
        <button key={o.key} className={`ai-model-option ${o.key === model ? 'active' : ''}`}
          onClick={() => { setModel(o.key); saveModel(o.key); setModelOpen(false) }}>
          <span>{o.free ? '⚡ ' : o.localModel ? '🖥️ ' : '🔑 '}{o.label}</span>
          {!o.free && !o.localModel && <small>{o.category}</small>}
        </button>
      ))}
    </div>}
  </div>

  return (
    <div className={`ai-page ai-layout-${layoutMode}`}>
      {/* 手机端底部弹层遮罩：任一下拉打开时出现，点空白处关闭（桌面端 CSS 隐藏） */}
      {(categoryOpen || modelOpen || reasoningOpen) && (
        <div className="ai-menu-backdrop" onClick={() => { setCategoryOpen(false); setModelOpen(false); setReasoningOpen(false) }} />
      )}
      <div className="ai-shell">
        {/* 顶部栏：朗读开关 / 电话 / 刷新，靠右间距适中 */}
        <div className="ai-topbar">
          <div className="ai-top-actions">
            <button className={`ai-icon-btn auto-speak-btn ${autoSpeak ? 'active' : ''}`} onClick={toggleAutoSpeak}
              title={autoSpeak ? '自动朗读已开启：AI 回复后自动朗读纯文字，点击关闭' : '开启自动朗读：AI 回复后自动朗读纯文字'}>
              <Volume2 size={17} />
            </button>
            <button className="ai-icon-btn call" onClick={() => setCallOpen(true)} disabled={!callEnabled}
              title={callEnabled ? 'AI 语音通话' : '当前分类模型不支持语音通话'}><Phone size={17} /></button>
            <button className={`ai-icon-btn ${searchOpen ? 'active' : ''}`} onClick={() => { setSearchOpen(v => !v); if (searchOpen) setSearchQuery('') }} title="搜索对话内容"><Search size={17} /></button>
            <button className="ai-icon-btn" onClick={() => setExportOpen(true)} disabled={messages.length === 0} title="导出对话记录（Markdown）"><Download size={17} /></button>
            <button className={`ai-icon-btn ${useMyData ? 'active' : ''}`} onClick={toggleUseMyData} title={useMyData ? '引用我的数据：已开启（问额度/消费/签到会按你的真实数据回答），点击关闭' : '引用我的数据：已关闭，点击开启后助手能查你的额度/消费/签到'}><Database size={17} /></button>
            <button className={`ai-icon-btn ${compareMode ? 'active' : ''}`} onClick={() => setCompareMode(v => !v)} title="多模型对比：同一个问题同时发给 2–3 个模型并排对比"><Columns2 size={17} /></button>
            <button className={`ai-icon-btn ${sessionsOpen ? 'active' : ''}`} onClick={() => setSessionsOpen(v => !v)} title="会话列表：新建/切换/重命名/删除多个对话"><MessagesSquare size={17} /></button>
            <button className="ai-icon-btn" onClick={clear} title="清空当前对话"><RotateCcw size={17} /></button>
          </div>
        </div>

        {/* 多模型对比选择条 */}
        {compareMode && (
          <div className="ai-compare-bar">
            <span className="ai-compare-hint">对比模式：选 2–3 个模型（已选 {compareKeys.length}），发送后并排看回答与耗时</span>
            <div className="ai-compare-chips">
              {allOptions.map(o => (
                <button key={o.key} className={`ai-compare-chip ${compareKeys.includes(o.key) ? 'active' : ''}`} onClick={() => toggleCompareKey(o.key)}>{o.label}</button>
              ))}
              {allOptions.length === 0 && <span className="ai-compare-hint">暂无可用模型</span>}
            </div>
          </div>
        )}

        {/* 会话列表面板 */}
        {sessionsOpen && (
          <div className="ai-sessions-panel">
            <div className="ai-sessions-head">
              <b>会话列表</b>
              <span className="hint">共 {sessionStore.sessions.length} 个 · 保存在本机</span>
              <button className="btn sm primary" onClick={newSession}><Plus size={13} /> 新建会话</button>
              <button className="ai-icon-btn" onClick={() => setSessionsOpen(false)} title="关闭"><X size={15} /></button>
            </div>
            {[...sessionStore.sessions].sort((a, b) => b.updatedAt - a.updatedAt).map(s => (
              <div key={s.id} className={`ai-session-item ${s.id === sessionStore.activeId ? 'active' : ''}`}>
                {renamingId === s.id ? (
                  <input className="input" autoFocus value={renameText} onChange={e => setRenameText(e.target.value)}
                    onBlur={() => { if (renameText.trim()) setSessionStore(store => ({ ...store, sessions: store.sessions.map(x => x.id === s.id ? { ...x, title: renameText.trim() } : x) })); setRenamingId(null) }}
                    onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
                ) : (
                  <button className="ai-session-main" onClick={() => switchSession(s.id)}>
                    <b>{s.title}</b>
                    <span>{s.messages.length} 条 · {new Date(s.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                  </button>
                )}
                <button className="icon-btn" title="重命名" onClick={() => { setRenamingId(s.id); setRenameText(s.title) }}><Pencil size={13} /></button>
                <button className="icon-btn" title="删除会话" onClick={() => deleteSession(s.id)}><Trash2 size={13} /></button>
              </div>
            ))}
          </div>
        )}

        {/* 对话搜索栏 */}
        {searchOpen && (
          <div className="ai-search-bar">
            <Search size={14} />
            <input autoFocus value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') jumpMatch(e.shiftKey ? -1 : 1); if (e.key === 'Escape') { setSearchOpen(false); setSearchQuery('') } }}
              placeholder="搜索当前对话内容…" />
            <span className="ai-search-count">{searchQuery.trim() ? (searchMatches.length ? `${Math.min(searchIdx + 1, searchMatches.length)}/${searchMatches.length}` : '无结果') : ''}</span>
            <button className="ai-icon-btn" onClick={() => jumpMatch(-1)} disabled={searchMatches.length === 0} title="上一个（Shift+Enter）"><ChevronUp size={15} /></button>
            <button className="ai-icon-btn" onClick={() => jumpMatch(1)} disabled={searchMatches.length === 0} title="下一个（Enter）"><ChevronDown size={15} /></button>
            <button className="ai-icon-btn" onClick={() => { setSearchOpen(false); setSearchQuery('') }} title="关闭搜索"><X size={15} /></button>
          </div>
        )}

        {/* 对话导出弹窗 */}
        {exportOpen && (
          <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) setExportOpen(false) }}>
            <div className="modal" style={{ maxWidth: 520 }}>
              <div className="modal-head"><h3 style={{ margin: 0 }}>导出对话记录</h3><button className="icon-btn" onClick={() => setExportOpen(false)}><X size={18} /></button></div>
              <div className="modal-body">
                <p style={{ fontSize: 13, lineHeight: 1.6, marginTop: 0 }}>把当前对话导出为 Markdown 文件存档，或复制全文到剪贴板。共 {messages.length} 条消息。</p>
                <textarea className="input" readOnly rows={8} value={buildChatMarkdown()} style={{ width: '100%', fontSize: 12, lineHeight: 1.6 }} />
              </div>
              <div className="modal-foot">
                <button className="btn" onClick={() => setExportOpen(false)}>取消</button>
                <button className="btn" onClick={() => void copyMessage(buildChatMarkdown())}><Copy size={14} /> 复制全文</button>
                <button className="btn primary" onClick={downloadChat}><Download size={14} /> 下载 .md</button>
              </div>
            </div>
          </div>
        )}

        {/* 非对话型模型提示卡 */}
        {selectedOption && !canChat && (
          <div className="ai-model-notice">
            <Info size={15} />
            <div>
              <b>{selectedOption.label}</b> 属于「{selectedOption.category}」——{CATEGORY_META[selectedOption.category].desc}。
              直接在输入框写画面描述并发送，App 会调用该账户 API 地址对应的
              {selectedOption.category === '生图型' ? '「/images/generations」生图接口' : '生视频接口'}；
              若该模型不是生图/生视频模型或接口为私有协议，会返回错误提示，此时请改用官方页面生成。
            </div>
            <button className="btn sm ghost" onClick={() => {
              const url = PROVIDER_MAP[selectedOption.account!.providerId]?.officialUrl
              if (url) window.open(url, '_blank', 'noopener')
              else notify('暂无官方地址')
            }}><ExternalLink size={13} /> 官方</button>
          </div>
        )}

        {/* 自有模型解锁：固定在对话区顶部，不随滚动消失（与 Key 管理页解锁独立） */}
        {needPwd && <div className="ai-pwd-gate">
          <span className="ai-pwd-gate-label"><Info size={13} /> 正在使用自有模型「{currentAccount?.label}」，需验证主密码后才能调用（本次会话只需一次，与 Key 管理页解锁互不影响）</span>
          <div className="ai-pwd-gate-row">
            <input className="input" type="password" placeholder="输入主密码" value={aiPwdInput}
              onChange={e => setAiPwdInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void verifyAiPwd() }} />
            <button className="btn sm primary" disabled={aiPwdBusy || !aiPwdInput} onClick={() => void verifyAiPwd()}>
              {aiPwdBusy ? <><Loader2 size={13} className="spin" /> 验证</> : '验证'}
            </button>
          </div>
        </div>}

        {/* 报错换 Key 重试：当前账户调用失败且同平台有备用账户时出现 */}
        {pendingRetry && <div className="ai-retry-bar">
          <span className="ai-pwd-gate-label"><Info size={13} /> 当前 Key 调用失败（可能失效或额度不足），同平台还有备用账户。</span>
          <div className="ai-pwd-gate-row">
            <button className="btn sm primary" onClick={() => { const r = pendingRetry; setPendingRetry(null); setModel(r.altKey); void send(r.text, r.altKey) }}>
              切换到「{pendingRetry.altLabel}」重试
            </button>
            <button className="btn sm ghost" onClick={() => setPendingRetry(null)}>不用了</button>
          </div>
        </div>}

        {/* 对话区 */}
        <div className="ai-messages">
          {!enteredChat ? (
            <div className="ai-welcome">
              <div className="ai-welcome-mark" onClick={() => { setClonedVoices(listClonedVoices()); setIdentityOpen('bot') }} title="点击更换 AI 头像、名字与音色"><img src={`${import.meta.env.BASE_URL}pwa-512.png`} alt="AI 积分管家" className="app-mark-img" /></div>
              <h2>{welcomeText(userProfile.nickname)}</h2>
            </div>
          ) : (
            <div className="ai-thread">
              {messages.map(m => {
                const profile = m.role === 'assistant' ? botProfile : userProfile
                return (
                <div key={m.id} id={`aimsg-${m.id}`} className={`ai-msg ${m.role}${searchMatches.includes(m.id) ? ' search-hit' : ''}${currentMatchId === m.id ? ' search-current' : ''}`}>
                  <div className="ai-avatar avatar-click" title={m.role === 'assistant' ? '点击更换 AI 头像/名字/音色' : '点击更换我的头像/昵称/前缀'}
                    style={{ background: avatarBg(profile) }} onClick={() => { setClonedVoices(listClonedVoices()); setIdentityOpen(m.role === 'assistant' ? 'bot' : 'user') }}>{avatarContent(profile)}</div>
                  <div className="ai-msg-body">
                    <div className="ai-bubble" onTouchStart={() => startLongPress(m.content)} onTouchEnd={endLongPress} onTouchMove={endLongPress}>{m.content}</div>
                    {m.content && (
                      <div className="ai-msg-tools">
                        {m.role === 'assistant' && (
                          <button className={`ai-speak ${speakingId === m.id ? 'active' : ''}`}
                            onClick={() => toggleSpeak(m)} title={speakingId === m.id ? '停止朗读' : '朗读此回复'}>
                            {speakingId === m.id ? <VolumeX size={14} /> : <Volume2 size={14} />}
                            <span>{speakingId === m.id ? '停止' : '朗读'}</span>
                          </button>
                        )}
                        <button className="ai-copy" onClick={() => void copyMessage(m.content)} title="复制对话内容"><Copy size={13} /></button>
                      </div>
                    )}
                  </div>
                </div>
                )
              })}
              {generating && streamingText && (
                <div className="ai-msg assistant">
                  <div className="ai-avatar" style={{ background: avatarBg(botProfile) }}>{avatarContent(botProfile)}</div>
                  <div className="ai-bubble"><span className="ai-typing">{streamingText}</span><span className="ai-cursor" /></div>
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
                          <span>{r.status === 'loading' ? '生成中…' : r.status === 'error' ? `失败 · ${(r.ms / 1000).toFixed(1)}s` : `${(r.ms / 1000).toFixed(1)}s · ${r.text.length} 字`}</span>
                        </div>
                        <div className={`ai-compare-body ${r.status === 'error' ? 'error' : ''}`}>{r.text || (r.status === 'loading' ? '…' : '（无回复）')}</div>
                      </div>
                    ))}
                  </div>
                  <button className="btn sm ghost" onClick={() => setCompareRuns(null)}>关闭对比结果</button>
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
                <button onClick={() => setAttachments(prev => prev.filter((_, j) => j !== i))} title="移除"><X size={13} /></button>
              </div>
            ))}
          </div>}
          {/* 输入框上方一行：左=添加附件，右=推理等级 */}
          <div className="ai-compose-top" onClick={() => setComposeActive(true)}>
            <button className="ai-icon-btn" onClick={() => setAttachPickerOpen(true)} title="添加附件（点击选择或拖拽）"><Plus size={18} /></button>
            <div className="reasoning-wrap">
              <button className="reasoning-btn" onClick={() => setReasoningOpen(v => !v)} title={REASONING_DESC[reasoning]}>推理 {reasoning} <ChevronDown size={12} /></button>
              {reasoningOpen && <div className="reasoning-menu">
                {REASONING_LEVELS.map(l => (
                  <button key={l} className={`reasoning-option ${l === reasoning ? 'active' : ''}`} title={REASONING_DESC[l]}
                    onClick={() => {
                      setReasoning(l); setReasoningOpen(false)
                      notify(`${l}：${REASONING_DESC[l]}`)
                    }}>
                    <span className="reasoning-option-label">{l} {l === reasoning && <span>✓</span>}</span>
                    <small>{REASONING_DESC[l]}</small>
                  </button>
                ))}
              </div>}
            </div>
          </div>
          <div className="ai-compose-box" onClick={() => setComposeActive(true)}>
            <textarea ref={textareaRef} className="ai-textarea" rows={1}
              placeholder={attachments.length ? '对这些附件说点什么…（也可直接发送）' : '输入你的问题…'} value={input}
              onChange={e => onInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
              disabled={generating} />
            <button className={`ai-mic-btn ${listening ? 'listening' : ''}`} onClick={() => void toggleMic()} disabled={generating}
              title={listening ? '停止语音输入' : '语音输入（点击后说话，文字会填入输入框）'}>
              <Mic size={16} />
            </button>
            {generating ? (
              <button className="ai-send stop" onClick={stop} title="停止生成"><Square size={15} fill="currentColor" /></button>
            ) : (
              <button className="ai-send" onClick={() => void send()} disabled={!input.trim() && attachments.length === 0} title="发送"><Send size={17} /></button>
            )}
          </div>
          {/* 输入框下方一行：左=模型分组，中=模型名，右=模型引擎，三分分散 */}
          <div className="ai-toolbar" onClick={() => setComposeActive(true)}>
            {serviceController && <span className="ai-toolbar-service" onClick={e => e.stopPropagation()}><ServiceSwitch controller={serviceController} serviceKey="ollama" compact /></span>}
            {categoryDropdown}
            {modelDropdown}
            {currentAccount && (hasCatalog(currentAccount.providerId) || engines.length > 0 || loadingEngines) && (
              <button className="ai-model-btn ai-engine-btn" onClick={() => setEnginePanelOpen(v => !v)} title="选择该平台的模型引擎">
                <Cpu size={13} /> 引擎 <ChevronDown size={13} />
              </button>
            )}
            <button className="ai-model-btn" onClick={() => setPromptsOpen(v => !v)} title="提示词库：常用提示词存成模板，一键插入（可跨设备同步）">
              <BookMarked size={13} /> 提示词
            </button>
          </div>
          {resolvingKey && <div className="ai-hint-inline"><Loader2 size={12} className="spin" /> 正在解锁密钥…</div>}
        </div>
      </div>
      {/* 右侧引擎选择面板 */}
      {promptsOpen && (
        <div className="ai-prompts-panel">
          <div className="ai-prompts-head">
            <b>提示词库</b>
            <span className="hint">点模板插入输入框；正文里的 {'{变量}'} 插入后自己改</span>
            <button className="icon-btn" onClick={() => setPromptsOpen(false)}><X size={15} /></button>
          </div>
          {promptList.length === 0 && <div className="ai-prompts-empty">还没有模板。在下面写好标题，把输入框里的内容存为模板。</div>}
          {promptList.map(p => (
            <div key={p.id} className="ai-prompt-item">
              <button className="ai-prompt-main" onClick={() => insertPrompt(p.body)} title={p.body}>
                <b>{p.title}</b>
                <span>{p.body.slice(0, 60)}{p.body.length > 60 ? '…' : ''}</span>
              </button>
              <button className="icon-btn" title="删除模板" onClick={() => onPromptsChange?.(promptList.filter(x => x.id !== p.id))}><Trash2 size={14} /></button>
            </div>
          ))}
          <div className="ai-prompts-add">
            <input className="input" placeholder="模板标题（留空取正文前 18 字）" value={promptTitle} onChange={e => setPromptTitle(e.target.value)} />
            <button className="btn sm primary" onClick={savePromptFromInput}>把当前输入存为模板</button>
          </div>
        </div>
      )}
      {enginePanelOpen && currentAccount && (
        <>
          <div className="engine-backdrop" onClick={() => setEnginePanelOpen(false)} />
          <aside className="engine-panel">
            <div className="engine-panel-head">
              <div>
                <div className="engine-panel-title">模型引擎</div>
                <div className="engine-panel-sub">
                  {PROVIDER_MAP[currentAccount.providerId]?.shortName ?? currentAccount.label} · 按 token 消耗从低到高
                  {loadingEngines && ' · 正在获取实时引擎…'}
                  {!loadingEngines && engineSource === 'remote' && ' · 实时获取'}
                  {!loadingEngines && engineSource === 'builtin' && ' · 内置参考'}
                </div>
              </div>
              <button className="icon-btn" onClick={() => setEnginePanelOpen(false)}><X size={17} /></button>
            </div>
            <div className="engine-probe-bar">
              <button className="btn sm" disabled={probing} onClick={() => void probeEngines()}>{probing ? '探测中…' : '探测可用性'}</button>
              <span>给每个引擎发一条极短消息，验证真能出话（最多 12 个，会消耗极少量额度）</span>
            </div>
            <div className="engine-list">
              {engines.map(e => (
                <button key={e.id} className={`engine-item ${engineId === e.id ? 'active' : ''}`}
                  onClick={() => { setEngineId(e.id); notify(`已选引擎：${e.name}`) }}>
                  <span className="engine-icon">{e.reasoning ? '🧠' : '⚡'}</span>
                  <span className="engine-info">
                    <span className="engine-name">{e.name}
                      {e.tag && <em className={`engine-tag ${e.tag === '夜间折扣' ? 'discount' : e.tag === '订阅优先' ? 'sub' : ''}`}>{e.tag}</em>}
                    </span>
                    <span className="engine-id">{e.id}</span>
                  </span>
                  <span className="engine-multi">{e.multiplier.toFixed(2)}x</span>
                  {probeResults[e.id] && (
                    <span className={`engine-probe ${probeResults[e.id].ok ? 'ok' : 'fail'}`} title={probeResults[e.id].error ?? ''}>
                      {probeResults[e.id].ok ? `● ${probeResults[e.id].ms}ms` : '● 不可用'}
                    </span>
                  )}
                  {engineId === e.id && <span className="engine-check">✓</span>}
                </button>
              ))}
              {loadingEngines && <div className="engine-empty"><Loader2 size={22} className="spin" /><div style={{ marginTop: 10 }}>正在从官方接口获取可用引擎…</div></div>}
              {!loadingEngines && engines.length === 0 && <div className="engine-empty">该平台暂无内置引擎目录。<br />请到 API Key 管理页检查账户平台，或手动填写引擎名。</div>}
            </div>
            <div className="engine-note">
              <Info size={12} /> 倍率为参考值，用于排序；实际计费以官方账单为准。部分引擎需订阅或支持推理等级。
            </div>
          </aside>
        </>
      )}

      {attachPickerOpen && <AttachmentPicker
        onClose={() => setAttachPickerOpen(false)}
        onConfirm={(items) => {
          setAttachments(prev => [...prev, ...items])
          setAttachPickerOpen(false)
          notify(`已添加 ${items.length} 个附件`)
        }}
        notify={notify}
      />}

      {identityOpen && <IdentityModal
        kind={identityOpen}
        bot={botProfile}
        user={userProfile}
        voices={clonedVoices.map(v => ({ id: v.id, name: v.name, voiceId: v.voiceId }))}
        onClose={() => setIdentityOpen(null)}
        onSaveBot={(p) => { saveBotProfile(p); setBotProfile(p); setIdentityOpen(null); notify('AI 身份已保存，切换模型也不会重置') }}
        onSaveUser={(p) => { saveUserProfile(p); setUserProfile(p); setIdentityOpen(null); notify('我的身份与回答前缀已保存') }}
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
          if (!ok) { notify('主密码错误'); return false }
          setAiPwd(pwd)
          notify('已验证，本次会话可正常通话')
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
        <div className="modal-head"><h3>{isBot ? '设置 AI 助手' : '设置我的资料'}</h3><button className="icon-btn" onClick={onClose}><X size={18} /></button></div>
        <div className="modal-body">
          <div className="field-label" style={{ marginTop: 0 }}>头像</div>
          <div className="identity-avatars">
            {AVATAR_PRESETS.map(a => (
              <button key={a.id} title={a.label} className={`identity-avatar ${avatarId === a.id ? 'active' : ''}`}
                style={{ background: a.color }} onClick={() => { setAvatarId(a.id); setAvatarDataUrl(undefined) }}>{a.emoji}</button>
            ))}
            <label className={`identity-avatar identity-upload ${avatarId === 'custom' ? 'active' : ''}`} title="上传自定义图片（等比缩放）">
              {avatarDataUrl ? <img src={avatarDataUrl} alt="自定义头像" /> : <ImageIcon size={17} />}
              <input type="file" accept="image/*" style={{ display: 'none' }} onChange={e => {
                const file = e.target.files?.[0]
                if (file) void resizeAvatarImage(file).then(url => { setAvatarDataUrl(url); setAvatarId('custom') }).catch(() => {})
                e.target.value = ''
              }} />
            </label>
          </div>
          <label className="form-label" style={{ marginTop: 16 }}>
            {isBot ? 'AI 名字' : '我的昵称'}
            <input className="input" value={name} maxLength={20} onChange={e => setName(e.target.value)} placeholder={isBot ? 'AI 助手' : '我'} />
          </label>
          {isBot ? (
            <label className="form-label" style={{ marginTop: 12 }}>
              说话音色（AI 复刻音色）
              <select className="select" value={voiceURI ?? ''} onChange={e => setVoiceURI(e.target.value || null)}>
                <option value="">跟随全局音色设置</option>
                {voices.map(v => <option key={v.id} value={v.voiceId}>{v.name}</option>)}
              </select>
              <span style={{ display: 'block', fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>
                {voices.length === 0
                  ? '还没有克隆音色，请到「语音配置 → 声音克隆」创建一个。'
                  : '选择后 AI 朗读会用这个克隆音色；在「语音配置」里增删改音色会自动同步到这里。'}
              </span>
            </label>
          ) : (
            <label className="form-label" style={{ marginTop: 12 }}>
              AI 回答前缀短语 / 词组
              <input className="input" value={phrase} maxLength={30} onChange={e => setPhrase(e.target.value)} placeholder="例如：请注意" />
              <span style={{ display: 'block', fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>每次回答开头会显示“昵称：短语”，例如“小明：请注意”。</span>
            </label>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={!name.trim()} onClick={() => {
            if (isBot) onSaveBot({ avatarId, avatarDataUrl, name: name.trim(), voiceURI })
            else onSaveUser({ avatarId, avatarDataUrl, nickname: name.trim(), phrase: phrase.trim() })
          }}>完成</button>
        </div>
      </div>
    </div>
  )
}
