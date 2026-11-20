// AI 助手聊天页：类 WorkBuddy 的干净对话界面。
// 布局自适应：桌面居中宽栏、移动端占满屏；流式输出、可中止、快捷提问。

import { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import {
  Send, Square, Plus, ChevronDown, Copy, Volume2, VolumeX,
  Phone, Layers, ExternalLink, Info, Loader2, FileText, Image as ImageIcon, Video, X, RotateCcw, Cpu,
} from 'lucide-react'
import {
  listModels, loadHistory, saveHistory, rotateConversationId,
  loadModel, saveModel, streamChat, friendlyAiError,
  type ChatMessage, type AiModel,
} from '../core/ai'
import { speakAsync, stopSpeak, getSavedVoice, cleanForAutoSpeech } from '../core/tts'
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
import { callByCategory, fetchProviderModels, callLocalChat, fetchLocalAssistantModels } from '../core/providerCall'
import type { Account } from '../core/types'
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

export function AIView({ notify, accounts, settings, serviceController }: {
  notify: (m: string) => void
  accounts: Account[]
  settings?: import('../core/types').AppSettings
  serviceController?: import('../core/useServiceController').ServiceController
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadHistory())
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
  useEffect(() => { saveHistory(messages) }, [messages])
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
  const ownOptions = useMemo(() => accounts
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
  const getReply = async (content: string, history: ChatMessage[], signal?: AbortSignal, images?: string[], voiceMode = false): Promise<string> => {
    const opt = allOptions.find(o => o.key === model)
    const isFirstReply = !history.some(m => m.role === 'assistant')
    const systemPrompt = voiceMode
      ? buildVoiceSystemPrompt(botProfile, userProfile)
      : buildIdentitySystemPrompt(botProfile, userProfile, isFirstReply)
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
      const msgs = [{ role: 'system', content: systemPrompt }, ...voiceHistory.map(m => ({ role: m.role, content: m.content })), { role: 'user', content }]
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
        { role: 'system', content: systemPrompt },
        ...voiceHistory.map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content },
      ]
      const r = await callLocalChat('http://127.0.0.1:11434', opt.localModel, msgs, images)
      if (!r.ok) throw new Error(r.error ?? '本地模型调用失败')
      return r.text
    }
    // 平台免费模型：流式输出（图片附件随多模态消息发送）
    return streamChat(model || 'auto', voiceHistory, content, delta => setStreamingText(prev => prev + delta), signal, images, effectiveReasoning, systemPrompt)
  }

  const send = async (text?: string) => {
    const content = (text ?? input).trim()
    const hasAttach = attachments.length > 0
    if ((!content && !hasAttach) || generating) return
    const effectiveText = content || '请分析这些附件'
    if (!model) { notify('模型尚未就绪，请稍候'); return }
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
      const answer = await getReply(aiText, messages, controller.signal, imageUrls)
      setMessages(prev => [...prev, { id: `${Date.now()}-a`, role: 'assistant', content: answer || '（无回复内容）', at: Date.now() }])
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
    rotateConversationId()
    notify('已开启新对话')
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
            <button className="ai-icon-btn" onClick={clear} title="新建对话"><RotateCcw size={17} /></button>
          </div>
        </div>

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
                <div key={m.id} className={`ai-msg ${m.role}`}>
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
            {currentAccount && hasCatalog(currentAccount.providerId) && (
              <button className="ai-model-btn ai-engine-btn" onClick={() => setEnginePanelOpen(v => !v)} title="选择该平台的模型引擎">
                <Cpu size={13} /> 引擎 <ChevronDown size={13} />
              </button>
            )}
          </div>
          {resolvingKey && <div className="ai-hint-inline"><Loader2 size={12} className="spin" /> 正在解锁密钥…</div>}
        </div>
      </div>
      {/* 右侧引擎选择面板 */}
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
