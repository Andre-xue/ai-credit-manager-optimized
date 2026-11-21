import { useCallback, useEffect, useMemo, useRef, useState, memo, lazy, Suspense, Fragment } from 'react'
import { SESSIONS_EVENT, TOGGLE_HISTORY_EVENT, loadSessionList, requestOpenSession, requestNewSession, updateSessionTitle, deleteStoredSession } from './core/chatSessions'
import {
  LayoutDashboard, CalendarCheck2, CalendarDays, KeyRound, BarChart3, Plus, ShieldCheck,
  ExternalLink, Trash2, RefreshCw, AlertTriangle, Info, Check,
  Wallet, Clock, TrendingUp, Lock, Unlock, Download, X, Copy, CircleHelp,
  Code2, Sparkles, Search, Image, Mic, PenTool, Settings, Eye, EyeOff, Pencil, Fingerprint,
  Film, Layers, Monitor, Network, PanelLeftClose, PanelLeftOpen,
  Cloud, Database, Volume2, HardDrive, Palette, RotateCcw, Menu, FileText, Languages,
  Bell, CloudOff, Activity, ClipboardList, Upload, ClipboardPaste, Wrench, History, ChevronDown, ChevronRight,
} from 'lucide-react'
import type { AppState, AccountView, ProviderDefinition, CreditUnit, AccountMode, QuotaSnapshot, AppSettings } from './core/types'
import { isLocalProvider } from './core/types'
import { detectLocalServices, getSystemMemoryGb, checkLocalService, startLocalService, stopLocalService, stopServiceByPort, isServiceAppManaged, fetchLocalModels, chooseModelFile, type LocalService } from './core/localServices'
import { buildReminders, filterUnsent, markSent, notifyPrefsOf } from './core/reminders'
import { getNotificationPermission, requestNotificationPermission, showNotification, scheduleDailyCheckin, cancelDailyCheckin, type NotificationPermissionState } from './core/notifications'
import { syncVoiceAccounts, setVoiceSessionPwd } from './core/voiceKey'
import { saveTtsConfig } from './core/voice-download'
import { detectModelCapability, shouldHideFromChat } from './core/modelCapability'
import { VOICE_PROVIDERS } from './core/voiceProviders'
import {
  LOCAL_SERVICE_KEYS, memoryToTier, tierAdvice, maxServicesForTier,
  isServiceEnabled, planServiceToggle, notifyLocalServiceChanged, initServicesForTier,
} from './core/localServicesSettings'
import type { LocalServiceKey, MemoryTier } from './core/types'
import { PROVIDERS, PROVIDER_MAP, CATEGORY_LABEL, CATEGORY_ORDER } from './data/providers'
import {
  loadState, saveStateDebounced, flushState, uid, updateAccount, removeAccount, upsertQuota, latestQuota, toggleCheckin,
  importState, mergeState, addUsageEvent, updateSettings, clearAllData,
} from './core/store'
import { HoldToConfirm } from './components/HoldToConfirm'
import {
  AGENT_TOOLS, CHECKIN_TOOLS, CATEGORY_TAGS, PLATFORM_TAGS,
  type AgentTool, type AgentRegion, type AgentCategory, type AgentPlatform,
} from './data/agentTools'
import { currentCatalog, fetchCatalog, getUnseenTools, markCatalogSeen } from './core/agentCatalog'
import { checkPriceUpdates, loadPriceAlerts, savePriceAlerts, lastPriceCheckAt, type PriceChange } from './core/priceWatch'
import { detectSpendAnomalies } from './core/anomaly'
import { buildMonthlyReport, prevMonthKey } from './core/monthlyReport'
import { detectProviderFromKey, extractKey } from './core/keyDetect'
import { rankProvidersByValue, rankModelsByValue } from './core/valueRank'
import { summarizeSubscriptions } from './core/subscriptions'
import { scoreAccounts } from './core/healthScore'
import { summarizeByProject, projectSuggestions } from './core/projectStats'
import { forecastMonthSpend } from './core/spendForecast'
import { buildGatewayRoutes, gatewaySetRoutes, gatewayStart, gatewayStop, gatewayStatus, genGatewayToken, type GatewayStatusInfo } from './core/gateway'
import { bindVaultPasswordNative, resolveBiometricVaultPassword, unbindVaultPasswordNative } from './core/biometric'
import { copyKeyWithAutoClear } from './core/clipboard'
import { buildBackup, parseBackup, type ParseBackupResult } from './core/backup'
import { syncWidgetData } from './core/widgetData'
import { buildEnvExport, buildJsonExport, type ToolExportItem } from './core/toolExport'
import { totalPortfolioValue, monthlySpendByPlatform, DEFAULT_UNIT_PRICES, OFFICIAL_PRICES_AS_OF, officialUnitPrice, priceDrifted } from './core/value'
import { predictExhaustion, forecastText } from './core/forecast'
import { todayISO } from './core/store'
import {
  isVaultInitialized, initVault, verifyVault, encryptSecret, decryptSecret, fingerprint, resetVault,
  changeMasterPassword, saveBiometricPassword, getBiometricPassword, clearBiometricPassword,
} from './core/crypto'
import { getAdapter, formatUsageBalance, errorText } from './core/adapters'
import { parseUsageCsv, type UsageEventInput } from './core/csv'
import {
  type ExportFormat, type ServiceEntry, exportByFormat, detectCsvKind, isJsonImport,
  parseAccountsCsv, parseQuotasCsv, isServiceList, parseServiceList, noteCategory,
} from './core/io'
import { openExternal, openTool, isDesktopApp, isNativeApp, isAppInstalled, biometricAvailable, biometricAuth, biometricLabel } from './core/openExternal'
import { cloud, type CloudUser } from './core/cloud'
import { UpdateModal } from './components/UpdateModal'
import { APP_VERSION, currentPlatform } from './core/updater'
import { NOTE_CATEGORIES, buildNote, categoryFromNote, type NoteCategory } from './core/modelCategories'
import { pullPayload, pushPayload, applyPayload, getLastSyncAt, getClientId, checkRemoteVersion, setBaseline, getRemoteVersion, type PullResult } from './core/sync'
import { useServiceController } from './core/useServiceController'
import { CloudLoginModal } from './components/CloudLogin'
import { CommandPalette, type PaletteItem } from './components/CommandPalette'
// 性能优化：标签页级代码分割 —— 重型视图按需加载，减小首屏解析与内存占用（本地资源加载近乎瞬时）
const DocQAView = lazy(() => import('./components/DocQAView').then(m => ({ default: m.DocQAView })))
const TranslationView = lazy(() => import('./components/TranslationView').then(m => ({ default: m.TranslationView })))
const ChatTranslateView = lazy(() => import('./components/ChatTranslateView').then(m => ({ default: m.ChatTranslateView })))
const ImageView = lazy(() => import('./components/ImageView').then(m => ({ default: m.ImageView })))
const VideoView = lazy(() => import('./components/VideoView').then(m => ({ default: m.VideoView })))
const LocalImageView = lazy(() => import('./components/LocalImageView').then(m => ({ default: m.LocalImageView })))
const LocalVideoView = lazy(() => import('./components/LocalVideoView').then(m => ({ default: m.LocalVideoView })))
const AIView = lazy(() => import('./components/AIView').then(m => ({ default: m.AIView })))
const VoiceSettings = lazy(() => import('./components/VoiceSettings').then(m => ({ default: m.VoiceSettings })))
const CalendarView = lazy(() => import('./components/CalendarView').then(m => ({ default: m.CalendarView })))
const ReportView = lazy(() => import('./components/ReportView').then(m => ({ default: m.ReportView })))
import { appendAudit, makeAuditEntry } from './core/auditLog'
import { loadDevices, touchCurrentDevice, type DeviceRecord } from './core/accountDevices'
import { checkKeyHealth, loadKeyHealth, saveKeyHealth, HEALTH_LABEL, type KeyHealthResult } from './core/healthCheck'
import {
  buildKeyBackup, backupToCloud, backupToLocalFile, backupToNotes, chooseBackupFolder, importKeyBackup, parseKeyBackup,
  type KeyBackupMode, type KeyBackupFormat, type KeyBackupFile, type BackupFileFormat,
} from './core/keyBackup'

/** CSV 导入预览：解析后的数据按类型区分 */
type CsvImportPreview =
  | { kind: 'accounts'; accounts: ReturnType<typeof parseAccountsCsv> }
  | { kind: 'quotas'; quotas: ReturnType<typeof parseQuotasCsv> }
  | { kind: 'usage'; events: UsageEventInput[] }

type Tab = 'ai' | 'dashboard' | 'checkin' | 'benefits' | 'chat-translate' | 'image' | 'video' | 'local-image' | 'local-video' | 'keys' | 'usage' | 'calendar' | 'report' | 'voice' | 'docs' | 'settings'

const UNIT_LABEL: Record<CreditUnit, string> = {
  credit: '积分', token: 'Tokens', request: '次', currency: '元', day: '天',
}

const MODE_LABEL: Record<AccountMode, string> = {
  api: '官方 API', manual: '手动录入', subscription: '订阅制',
}

const CATEGORY_ICON: Record<ProviderDefinition['category'], typeof Code2> = {
  llm: Sparkles, code: Code2, image: Image, video: Film, voice: Mic,
  search: Search, design: PenTool, embedding: Layers, local: HardDrive, 'voice-config': Volume2, other: CircleHelp,
}

/** 左侧边栏「历史会话」区：挂在 AI 助手导航项下方，默认隐藏，点「展示更多」展开（新→旧排序）。
 *  数据来自 AI 助手的会话存储（localStorage），点击某条整页打开该会话并可继续聊。 */
function SidebarHistory({ open, onToggle, onNavigate }: { open: boolean; onToggle: () => void; onNavigate: () => void }) {
  const [list, setList] = useState(loadSessionList)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  useEffect(() => {
    const refresh = () => setList(loadSessionList())
    window.addEventListener(SESSIONS_EVENT, refresh)
    window.addEventListener('storage', refresh)
    return () => { window.removeEventListener(SESSIONS_EVENT, refresh); window.removeEventListener('storage', refresh) }
  }, [])
  useEffect(() => { if (open) setList(loadSessionList()) }, [open ])
  const fmtTime = (ts: number) => {
    const d = new Date(ts)
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
  }
  return (
    <div className="side-history">
      <button className="side-history-head" onClick={onToggle} title="AI 助手的历史会话">
        <History size={13} />
        <span>历史会话</span>
        <span className="side-history-more">{open ? '收起' : '展示更多'}</span>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {open && (
        <div className="side-history-list">
          <button className="side-history-new" onClick={() => { onNavigate(); requestNewSession() }}>
            <Plus size={13} /> 新建会话
          </button>
          {list.sessions.length === 0 && <div className="side-history-empty">暂无历史会话</div>}
          {list.sessions.map(s => (
            <div key={s.id} className={`side-history-item ${s.id === list.activeId ? 'active' : ''}`}>
              {renaming === s.id ? (
                <input className="input side-history-rename" autoFocus value={renameText} onChange={e => setRenameText(e.target.value)}
                  onBlur={() => { if (renameText.trim()) updateSessionTitle(s.id, renameText.trim()); setRenaming(null) }}
                  onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null) }} />
              ) : (
                <button className="side-history-main" onClick={() => { onNavigate(); requestOpenSession(s.id) }} title={s.title}>
                  <b>{s.title}</b>
                  <span>{s.count} 条 · {fmtTime(s.updatedAt)}</span>
                </button>
              )}
              <button className="icon-btn side-history-act" title="重命名" onClick={() => { setRenaming(s.id); setRenameText(s.title) }}><Pencil size={12} /></button>
              <button className="icon-btn side-history-act" title="删除会话" onClick={() => deleteStoredSession(s.id)}><Trash2 size={12} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function App() {
  const [state, setState] = useState<AppState>(() => loadState())

  // 本机物理内存 GB（供内存档位判断与服务联动开关共用）
  const [memGb, setMemGb] = useState(0)
  // 首次启动：按本机内存档位初始化本地服务开关（8G 只开 1 个），仅执行一次
  useEffect(() => {
    let alive = true
    void getSystemMemoryGb().then(gb => {
      if (!alive) return
      setMemGb(gb)
      if (state.settings.localServicesInitialized) return
      const tier = memoryToTier(gb)
      setState(s => s.settings.localServicesInitialized ? s : ({
        ...s,
        settings: {
          ...s.settings,
          localServices: initServicesForTier(tier),
          localServicesInitialized: true,
        },
      }))
    })
    return () => { alive = false }
  }, [])
  // 同步账户到语音模块（供语音 Key 读取，账户变化时自动失效缓存）
  useEffect(() => { syncVoiceAccounts(state.accounts) }, [state.accounts])
  // 手机原生端（安卓/iOS）默认进入 AI 聊天页、侧栏抽屉默认隐藏；其他端沿用旧行为
  // 预览参数仅用于浏览器验收手机端界面，生产环境不会带此参数
  const phonePreview = typeof location !== 'undefined' && (new URLSearchParams(location.search).get('preview') === 'phone' || location.hash.includes('preview=phone'))
  const isPhone = isNativeApp() || phonePreview
  const [tab, setTab] = useState<Tab>(() => {
    const t = new URLSearchParams(location.search).get('tab')
    // 手机客户端已移除文档问答与本地生成：即使外部带参指向这些页也回落到默认页
    if (t && ['ai', 'dashboard', 'checkin', 'benefits', 'chat-translate', 'image', 'video', 'local-image', 'local-video', 'keys', 'usage', 'calendar', 'report', 'voice', 'docs', 'settings'].includes(t)
      && !(isPhone && (t === 'docs' || t === 'local-image' || t === 'local-video'))) return t as Tab
    return isPhone ? 'ai' : 'dashboard'
  })
  const [sidebarVisible, setSidebarVisible] = useState<boolean>(() => {
    if (phonePreview) return location.hash.includes('drawer') || new URLSearchParams(location.search).get('drawer') === '1'
    if (isPhone) return false
    try { return localStorage.getItem('acm.sidebar.visible') !== '0' } catch { return true }
  })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const toggleSidebar = () => setSidebarVisible(v => !v)
  // AI 助手历史会话区（侧边栏 AI 助手下方）：顶栏「会话列表」按钮经事件切换展开/收起
  const [historyOpen, setHistoryOpen] = useState(false)
  useEffect(() => {
    const onToggle = () => { setSidebarVisible(true); setHistoryOpen(v => !v) }
    window.addEventListener(TOGGLE_HISTORY_EVENT, onToggle)
    return () => window.removeEventListener(TOGGLE_HISTORY_EVENT, onToggle)
  }, [])
  // 统一导航：Claude 风格下"设置"走居中弹窗，其余模块正常切 tab
  const openTab = (id: Tab) => {
    // 手机客户端已移除文档问答与本地生成：任何残留入口跳到这些页时回落到 AI 页
    if (isPhone && (id === 'docs' || id === 'local-image' || id === 'local-video')) id = 'ai'
    if (id === 'settings') { setSettingsOpen(true); if (isPhone) setSidebarVisible(false); return }
    setTab(id)
    if (isPhone) setSidebarVisible(false)
    window.scrollTo(0, 0)
  }
  useEffect(() => {
    try { localStorage.setItem('acm.sidebar.visible', sidebarVisible ? '1' : '0') } catch { /* 忽略 */ }
  }, [sidebarVisible])
  const [onboardingOff, setOnboardingOff] = useState(() => {
    try { return localStorage.getItem('acm.onboarding.dismissed') === '1' } catch { return false }
  })
  const [catalogNews, setCatalogNews] = useState<AgentTool[]>([])
  // 启动时拉取工具目录，发现用户没见过的新工具则提醒（导航红点 + 目录页横幅）
  useEffect(() => {
    let alive = true
    void fetchCatalog(false).then(r => {
      if (alive && r.ok && r.snapshot) setCatalogNews(getUnseenTools(r.snapshot.tools))
    })
    return () => { alive = false }
  }, [])
  const ackCatalogNews = useCallback(() => {
    markCatalogSeen(currentCatalog().tools)
    setCatalogNews([])
  }, [])
  const [addOpen, setAddOpen] = useState(false)
  // 智能粘贴：粘贴 Key 识别平台后，带着 Key 直接打开对应平台的添加账户表单
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteSecret, setPasteSecret] = useState('')
  const [formProviderId, setFormProviderId] = useState<string | null>(null)
  const [vaultOpen, setVaultOpen] = useState(false)
  const [quotaTarget, setQuotaTarget] = useState<string | null>(null)
  const [usageOpen, setUsageOpen] = useState(false)
  const [updateOpen, setUpdateOpen] = useState(false)
  const [importData, setImportData] = useState<AppState | null>(null)
  const [csvPreview, setCsvPreview] = useState<CsvImportPreview | null>(null)
  const [servicePreview, setServicePreview] = useState<ServiceEntry[] | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [backupGate, setBackupGate] = useState<{
    ids: string[]
    title: string
    confirmLabel: string
    backupOnly: boolean
    after: () => void
  } | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [backupDue, setBackupDue] = useState(false)
  const [bioAvailableGlobal, setBioAvailableGlobal] = useState(false)
  const [bioLabel, setBioLabel] = useState('生物识别')
  /**
   * 当前会话已验证的主密码。作用域仅限「API Key 管理页 + 安全设置」这一范畴：
   * 添加账户加密、修改主密码回填等。AI 助手等其余模块不读此值（各自独立解密），
   * 因此 Key 管理页的解锁状态不会影响其他功能。指纹/人脸模式则用 biometric 凭据。
   */
  const [sessionPwd, setSessionPwd] = useState('')
  /** 从设置页指纹/人脸解锁后，带入 Key 管理页的初始解锁密码（仅作用于 Key 页） */
  const [keyPageInitialPwd, setKeyPageInitialPwd] = useState('')
  useEffect(() => {
    void biometricAvailable().then(setBioAvailableGlobal)
    void biometricLabel().then(setBioLabel)
    touchCurrentDevice()
  }, [])

  useEffect(() => { saveStateDebounced(state) }, [state])
  // 页面隐藏/关闭前立即落盘，避免 250ms 防抖窗口内丢失最后一笔
  useEffect(() => {
    const flush = () => { if (document.visibilityState === 'hidden') flushState() }
    document.addEventListener('visibilitychange', flush)
    window.addEventListener('beforeunload', flushState)
    return () => {
      document.removeEventListener('visibilitychange', flush)
      window.removeEventListener('beforeunload', flushState)
      flushState()
    }
  }, [])

  // 切换模块后重置滚动到顶部，避免从长页面切到短页面时停留在半空造成"一高一低"
  useEffect(() => {
    const id = window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
      document.querySelector('.content')?.scrollTo?.(0, 0)
    })
    return () => window.cancelAnimationFrame(id)
  }, [tab])

  // 用 ref 跟踪最新 state，供稳定回调（定时通知等）读取，避免闭包陈旧
  const stateRef = useRef(state)
  useEffect(() => { stateRef.current = state }, [state])

  const toastTimer = useRef<number | null>(null)
  const notify = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2600)
  }, [])

  // 本地服务联动控制器：设置页 / AI翻译 / AI图像 / AI视频 共用的服务开关状态源。
  // 所有开关读写同一份 settings.localServices，任一处切换后各处同步显示。
  const patchSettings = useCallback((patch: Partial<AppSettings>) => {
    setState(s => updateSettings(s, patch))
  }, [])
  const appMemTier: MemoryTier = state.settings.memoryTierOverride ?? memoryToTier(memGb)
  const serviceController = useServiceController(state.settings, patchSettings, appMemTier, notify)

  /** 统一备份门禁：任何删除/备份操作都先走同一个弹窗，备份完成后才执行后续动作 */
  const requestBackup = useCallback((ids: string[], title: string, confirmLabel: string, after: () => void, backupOnly = false) => {
    if (!ids.length) { notify('没有选中的数据'); return }
    setBackupGate({ ids, title, confirmLabel, backupOnly, after })
  }, [notify])

  // ===== 删除撤回：保存删除前的完整快照，5 秒内可恢复 =====
  const [undo, setUndo] = useState<{ snapshot: AppState; label: string } | null>(null)
  const undoTimer = useRef<number | null>(null)
  const scheduleUndo = useCallback((snapshot: AppState, label: string) => {
    if (undoTimer.current !== null) window.clearTimeout(undoTimer.current)
    setUndo({ snapshot, label })
    undoTimer.current = window.setTimeout(() => setUndo(null), 5000)
  }, [])
  const doUndo = useCallback(() => {
    if (!undo) return
    setState(undo.snapshot)
    if (undoTimer.current !== null) window.clearTimeout(undoTimer.current)
    setUndo(null)
    notify('已撤回，数据已恢复')
  }, [undo, notify])

  /** 设置页快捷解锁：生物验证通过后（原生端密码在系统钥匙串、桌面端系统验证），把凭据带入 Key 管理页自动解锁 */
  const handleBioUnlock = useCallback(async () => {
    const pwd = await resolveBiometricVaultPassword('验证身份以解锁 API Key 管理')
    if (!pwd) { notify(`${bioLabel}验证未通过，或未配置解锁凭据（请先在「解锁方式」中开启）`); return }
    if (!(await verifyVault(pwd))) { notify('解锁凭据已失效，请重新开启'); return }
    setKeyPageInitialPwd('')
    window.setTimeout(() => setKeyPageInitialPwd(pwd), 0)
    setTab('keys')
    notify(`已通过${bioLabel}验证，正在解锁 API Key 管理页`)
  }, [notify, bioLabel])

  // ============ 云同步 ============
  const [cloudUser, setCloudUser] = useState<CloudUser | null>(null)
  const [loginOpen, setLoginOpen] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [, setSyncTick] = useState(0)
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(() => getLastSyncAt())
  const cloudUserRef = useRef<CloudUser | null>(null)
  const localDirtyRef = useRef(false)   // 本机有尚未推送成功的修改
  const pushTimer = useRef<number | null>(null)
  const syncReady = useRef(false)
  const syncingRef = useRef(false)      // 同步互斥：拉取/推送不可同时进行
  const skipPushOnce = useRef(false)
  const lastPullAt = useRef(0)          // 最近一次拉取时间，避免拉取触发的 state 变化又被推回去
  const myClientId = useRef(getClientId())

  /** 把云端数据应用到本地（仅在确认是其他端更新时调用） */
  const applyRemote = useCallback((payload: NonNullable<PullResult['payload']>, version: string | null) => {
    lastPullAt.current = Date.now()
    skipPushOnce.current = true
    setBaseline(version)
    setState(s => applyPayload(payload, s))
    setLastSyncAt(getLastSyncAt())
    setSyncError(null)
    localDirtyRef.current = false
  }, [])

  // 统一的登录后初始化：拉取云端；云端为空则把本地作为初始快照上传；完成后才允许自动推送。
  const bootstrapCloud = useCallback(async (user: CloudUser, announce = true) => {
    cloudUserRef.current = user
    setCloudUser(user)
    syncReady.current = false
    syncingRef.current = true
    setSyncing(true)
    try {
      const result = await pullPayload()
      if (!result.ok) {
        setSyncError(result.error ?? '云端连接失败')
        if (announce) notify(`云端连接失败：${result.error}`)
      } else if (result.payload) {
        applyRemote(result.payload, result.remoteVersion)
        if (announce) notify('已从云端同步最新数据')
      } else {
        const pushed = await pushPayload(stateRef.current, undefined, { includeLocal: !!stateRef.current.settings.syncLocalProviders })
        if (pushed.ok) {
          setSyncError(null)
          setLastSyncAt(getLastSyncAt())
          if (announce) notify('本地数据已上传云端，其他端登录即可同步')
        } else setSyncError(pushed.error ?? '上传失败')
      }
    } finally {
      syncReady.current = true
      syncingRef.current = false
      setSyncing(false)
    }
  }, [notify, applyRemote])

  // OAuth 回调必须在守卫之前处理；普通访问恢复会话后同样走 bootstrap。
  useEffect(() => {
    ;(async () => {
      try {
        const url = new URL(location.href)
        const provider = url.searchParams.get('provider')
        if (url.searchParams.has('code') && (provider === 'wechat' || provider === 'workbuddy')) {
          const handle = provider === 'wechat' ? cloud.auth.handleWechatWebCallback : cloud.auth.handleWorkBuddyCallback
          const { data: session, error } = await handle.call(cloud.auth)
          if (error) { notify(`登录失败：${error.message}`); return }
          if (session) {
            for (const k of ['code', 'state', 'provider']) url.searchParams.delete(k)
            history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
            await bootstrapCloud(session.user)
            return
          }
        }
        const { data: session } = await cloud.auth.getSession()
        if (session) await bootstrapCloud(session.user, false)
      } catch { /* 未登录或网络异常时保持本地模式 */ }
    })()
  }, [notify, bootstrapCloud])

  // 数据变更时防抖推送（仅初始化完成后，且没有其他同步在进行）
  useEffect(() => {
    if (!cloudUser || !syncReady.current) return
    if (skipPushOnce.current) { skipPushOnce.current = false; return }
    localDirtyRef.current = true   // 有本地修改待推送
    if (pushTimer.current !== null) window.clearTimeout(pushTimer.current)
    pushTimer.current = window.setTimeout(async () => {
      if (syncingRef.current) return
      if (Date.now() - lastPullAt.current < 1500) return  // 刚拉取过，丢弃这次由拉取引发的回环推送
      syncingRef.current = true
      try {
        const r = await pushPayload(stateRef.current, undefined, { includeLocal: !!stateRef.current.settings.syncLocalProviders })
        if (r.ok) { setLastSyncAt(getLastSyncAt()); setSyncError(null); localDirtyRef.current = false }
        else setSyncError(r.error ?? '推送失败')
      } finally { syncingRef.current = false }
    }, 1200)
    return () => { if (pushTimer.current !== null) window.clearTimeout(pushTimer.current) }
  }, [state, cloudUser])

  /** 检查云端是否有其他端的更新：版本变化且不是自己推的，则拉取并刷新 */
  const checkRemote = useCallback(async (silent = true) => {
    if (!cloudUserRef.current || !syncReady.current || syncingRef.current) return
    // 先占互斥锁再发请求，避免 interval 与 visibilitychange 并发触发重复拉取
    syncingRef.current = true
    try {
      const known = getRemoteVersion()
      const check = await checkRemoteVersion()
      if (!check.ok || !check.version) return
      if (known && check.version === known) return   // 无变化
      const result = await pullPayload()
      if (!result.ok) return
      // 是自己刚推的（比如推送延迟导致基线未更新），只更新基线不覆盖本地
      if (result.payload?.clientId === myClientId.current) {
        setBaseline(result.remoteVersion)
        return
      }
      if (result.payload) {
        // 同步策略（用户 2026-11-20 选定）：静默覆盖、新盖旧——云端是其他端的更新就直接应用，
        // 本机未推送的修改随之被覆盖，不再弹冲突提醒。applyRemote 会清掉待推送标记，不会把旧数据推回去。
        applyRemote(result.payload, result.remoteVersion)
        if (!silent) notify('已从云端同步其他端的最新数据')
      } else setBaseline(result.remoteVersion)
    } finally { syncingRef.current = false }
  }, [applyRemote, notify])

  // 轮询 + 切回前台立即检查：后台/锁屏时暂停轮询，省电省流量
  useEffect(() => {
    if (!cloudUser) return
    let timer: number | null = null
    const start = () => {
      if (timer !== null) return
      void checkRemote()  // 切回前台立即检查一次
      timer = window.setInterval(() => {
        if (document.visibilityState === 'visible') void checkRemote()
      }, 8000)
    }
    const stop = () => {
      if (timer !== null) { window.clearInterval(timer); timer = null }
    }
    const onVisible = () => { if (document.visibilityState === 'visible') start(); else stop() }
    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [cloudUser, checkRemote])

  // 手动「立即同步」：重新拉取云端覆盖本地
  const pullCloud = useCallback(async () => {
    if (!cloudUserRef.current) return
    setSyncing(true)
    syncingRef.current = true
    try {
      const result = await pullPayload()
      if (!result.ok) { setSyncError(result.error ?? '拉取失败'); notify(`拉取失败：${result.error}`) }
      else if (result.payload) {
        applyRemote(result.payload, result.remoteVersion)
        notify('已同步云端最新数据')
      } else { setSyncError(null); notify('云端暂无数据') }
    } finally { syncingRef.current = false; setSyncing(false) }
  }, [notify, applyRemote])

  const handleCloudLogin = useCallback(async (user: CloudUser) => {
    setLoginOpen(false)
    setState(s => appendAudit(s, makeAuditEntry('云登录', user.name ?? undefined)))
    notify(`已登录：${user.name ?? '用户'}`)
    await bootstrapCloud(user)
  }, [notify, bootstrapCloud])

  const handleCloudLogout = useCallback(async () => {
    await cloud.auth.signOut()
    setCloudUser(null)
    cloudUserRef.current = null
    syncReady.current = false
    setSyncError(null)
    setState(s => appendAudit(s, makeAuditEntry('云登出')))
    notify('已退出云同步，数据仍保存在本机')
  }, [notify])

  // 已登录时每 30 秒刷新一次侧边栏「最近同步」相对时间文案
  useEffect(() => {
    if (!cloudUser) return
    const t = window.setInterval(() => setSyncTick(n => n + 1), 30000)
    return () => window.clearInterval(t)
  }, [cloudUser])

  /** 读取文件：自动识别 JSON 备份 / 账户 CSV / 额度 CSV / 用量 CSV */
  const handleImportFile = useCallback((file?: File) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const text = String(reader.result ?? '')
      try {
        // API Key 备份文件（JSON / CSV / TXT，按内容识别）
        if (parseKeyBackup(text)) {
          void (async () => {
            try {
              const pwd = sessionPwd || getBiometricPassword() || undefined
              const next = await importKeyBackup(text, stateRef.current, pwd)
              setState(next)
              notify('密钥备份已导入并合并（重复 ID 已覆盖）')
            } catch (e) { notify((e as Error)?.message ?? '备份导入失败') }
          })()
          return
        }
        // 第三方 API 服务清单（数组格式，含明文 Key）
        if (isServiceList(text)) {
          setServicePreview(parseServiceList(text))
          return
        }
        if (isJsonImport(file.name, text)) {
          setImportData(importState(text))
          return
        }
        const kind = detectCsvKind(text)
        if (!kind) { notify('无法识别文件格式：支持密钥备份 JSON/CSV/TXT、账户/额度/用量 CSV'); return }
        const s = stateRef.current
        if (kind === 'accounts') {
          setCsvPreview({ kind, accounts: parseAccountsCsv(text) })
        } else if (kind === 'quotas') {
          setCsvPreview({ kind, quotas: parseQuotasCsv(text, s.accounts) })
        } else {
          setCsvPreview({ kind, events: parseUsageCsv(text, s.accounts) })
        }
      } catch (err: any) { notify(err.message ?? '文件解析失败') }
    }
    reader.readAsText(file)
  }, [notify, sessionPwd])

  /** 按选择格式导出文件；dir 非空则写入指定目录（桌面端） */
  const doExport = useCallback(async (format: ExportFormat, dir?: string) => {
    const s = stateRef.current
    const { content, ext } = exportByFormat(format, s, latestQuota)
    const suffix = format === 'json' ? 'backup' : format
    const filename = `ai-credit-manager-${suffix}-${todayISO()}.${ext}`
    if (dir && isDesktopApp()) {
      // 桌面端：写入用户选择的目录
      const w = window as unknown as { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args: Record<string, unknown>) => Promise<string> } }
      try {
        const invoke = w.__TAURI_INTERNALS__?.invoke
        if (!invoke) throw new Error('桌面端接口不可用')
        const path = await invoke('write_file_to_dir', { dir, filename, content })
        notify(`已导出到：${path}`)
      } catch (e: any) { notify(e.message ?? '写入文件失败') }
    } else {
      // Web 端：浏览器下载
      const blob = new Blob([content], { type: (format === 'json' ? 'application/json' : 'text/csv') + ';charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = filename; a.click()
      URL.revokeObjectURL(url)
    }
    if (format === 'json') setState(prev => updateSettings(prev, { lastExportAt: new Date().toISOString() }))
    setState(prev => appendAudit(prev, makeAuditEntry(format === 'json' ? '导出备份' : '导出数据', format.toUpperCase())))
  }, [notify])

  /** 立即把本地数据推送云端（备份横幅/手动备份用） */
  const pushCloud = useCallback(async (): Promise<boolean> => {
    if (!cloudUserRef.current) return false
    setSyncing(true)
    syncingRef.current = true
    try {
      const r = await pushPayload(stateRef.current, undefined, { includeLocal: !!stateRef.current.settings.syncLocalProviders })
      if (r.ok) {
        setLastSyncAt(getLastSyncAt())
        setSyncError(null)
        setState(prev => updateSettings(prev, { lastExportAt: new Date().toISOString() }))
        notify('已备份到云端')
        return true
      }
      setSyncError(r.error ?? '推送失败')
      notify(`云端备份失败：${r.error ?? '未知错误'}`)
      return false
    } finally { syncingRef.current = false; setSyncing(false) }
  }, [notify])

  /** 备份提醒：全平台通用的界面横幅。超过阈值天数未备份即提示。 */
  const checkBackupDue = useCallback(() => {
    const st = stateRef.current.settings
    if (!st.backupReminder) { setBackupDue(false); return }
    try {
      const snooze = Number(localStorage.getItem('acm.backup.snoozeUntil') ?? 0)
      if (snooze && Date.now() < snooze) { setBackupDue(false); return }
    } catch { /* 忽略 */ }
    const days = st.backupReminderDays ?? 7
    const ref = st.lastExportAt || stateRef.current.accounts[0]?.createdAt
    if (!ref) { setBackupDue(false); return }   // 没有数据时无需提醒
    const elapsed = Date.now() - new Date(ref).getTime()
    setBackupDue(elapsed >= days * 86400000)
  }, [])
  useEffect(() => {
    checkBackupDue()
    const t = window.setInterval(checkBackupDue, 60 * 60 * 1000)
    return () => window.clearInterval(t)
  }, [checkBackupDue, state.settings.backupReminder, state.settings.backupReminderDays, state.settings.lastExportAt])

  const views: AccountView[] = useMemo(() => state.accounts.map((account) => {
    const provider = PROVIDER_MAP[account.providerId]
    const quota = latestQuota(state.quotas, account.id)
    const used = quota?.used ?? 0
    const total = quota?.total ?? 0
    const percent = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0
    let days: number | undefined
    if (quota?.resetAt) days = Math.ceil((new Date(quota.resetAt).getTime() - Date.now()) / 86400000)
    const forecast = quota ? predictExhaustion(state, account.id) : undefined
    return { account, provider, quota, usagePercent: percent, daysUntilReset: days, forecast }
  }), [state])

  const pendingCheckins = CHECKIN_TOOLS.filter((t) =>
    !state.checkins.some((c) => c.providerId === t.id && c.date === todayISO() && c.done),
  )

  const lowQuota = views.filter((v) => v.usagePercent >= 80)
  const runningOut = views.filter((v) =>
    v.forecast?.level === 'exhausted' || v.forecast?.level === 'critical' ||
    (v.forecast?.level === 'warning' && (v.forecast.daysLeft ?? 99) <= state.settings.alertDays),
  )
  const monthCost = state.usage
    .filter((u) => u.date.startsWith(todayISO().slice(0, 7)))
    .reduce((s, u) => s + u.estimatedCost, 0)
  const portfolioValue = totalPortfolioValue(state)
  const healthRows = useMemo(() => scoreAccounts(state), [state])

  // ---- 主题（深色模式）：system 跟随系统，其余按设置固定；写入 <html data-theme> ----
  const themePref = state.settings.theme ?? 'system'
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = themePref === 'dark' || (themePref === 'system' && mq.matches)
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    }
    apply()
    if (themePref === 'system') {
      mq.addEventListener('change', apply)
      return () => mq.removeEventListener('change', apply)
    }
  }, [themePref])

  // ---- 桌面外壳联动（仅 Tauri）：托盘/快捷键发来导航事件时切页；待签到数同步到菜单栏标题 ----
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return
    let unlisten: (() => void) | undefined
    void (async () => {
      const { listen } = await import('@tauri-apps/api/event')
      unlisten = await listen<string>('acm-navigate', (e) => { if (e.payload) openTab(e.payload as Tab) })
    })()
    return () => { unlisten?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // ---- 桌面端：把快捷键设置（总开关 + 自定义组合）下发给 Tauri 动态注册 ----
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return
    const w = window as unknown as { __TAURI_INTERNALS__?: { invoke?: (c: string, a?: Record<string, unknown>) => Promise<unknown> } }
    void w.__TAURI_INTERNALS__?.invoke?.('shortcuts_apply', {
      enabled: state.settings.shortcutsEnabled ?? true,
      ai: state.settings.shortcutAi ?? 'CommandOrControl+Shift+A',
      mini: state.settings.shortcutMini ?? 'CommandOrControl+Shift+M',
    }).catch(() => { /* 旧版本桌面壳没有此命令时忽略，壳内默认快捷键仍生效 */ })
  }, [state.settings.shortcutsEnabled, state.settings.shortcutAi, state.settings.shortcutMini])

  // ---- 桌面端：图标显示位置（Dock / 菜单栏）下发给 Tauri 壳 ----
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return
    const w = window as unknown as { __TAURI_INTERNALS__?: { invoke?: (c: string, a?: Record<string, unknown>) => Promise<unknown> } }
    void w.__TAURI_INTERNALS__?.invoke?.('icon_display_apply', {
      mode: state.settings.iconDisplay ?? 'both',
    }).catch(() => { /* 旧版本桌面壳没有此命令时忽略 */ })
  }, [state.settings.iconDisplay])

  // ---- 价格变动订阅：启动时（6 小时节流）拉取仓库价格表与本地快照对比，变动记入提醒 ----
  const [priceAlerts, setPriceAlerts] = useState<PriceChange[]>(() => loadPriceAlerts())
  const [priceCheckedAt, setPriceCheckedAt] = useState<string | null>(() => lastPriceCheckAt())
  const [checkingPrices, setCheckingPrices] = useState(false)
  const runPriceCheck = useCallback(async (force: boolean, silent: boolean) => {
    setCheckingPrices(true)
    try {
      const r = await checkPriceUpdates(force)
      setPriceCheckedAt(lastPriceCheckAt())
      if (r.ok && r.changes.length) {
        setPriceAlerts(prev => { const next = [...r.changes, ...prev].slice(0, 30); savePriceAlerts(next); return next })
        const fmt = (c: PriceChange) => `${PROVIDER_MAP[c.providerId]?.shortName ?? c.providerId} ${c.newPrice > c.oldPrice ? '涨价' : '降价'} ¥${c.oldPrice}→¥${c.newPrice}`
        const mine = r.changes.filter(c => stateRef.current.accounts.some(a => a.providerId === c.providerId))
        if (mine.length) notify(`价格变动提醒：${mine.slice(0, 3).map(fmt).join('；')}${mine.length > 3 ? ` 等 ${mine.length} 处` : ''}`)
        else if (!silent) notify(`价格表有 ${r.changes.length} 处变动（不涉及你已添加的平台），详见用量页「价格动态」`)
      } else if (!silent) {
        notify(r.ok ? '已检查，暂无价格变动' : `检查失败（${r.error ?? '网络不可用'}），请稍后再试`)
      }
    } finally { setCheckingPrices(false) }
  }, [notify])
  const priceCheckRanRef = useRef(false)
  useEffect(() => {
    if (priceCheckRanRef.current) return
    priceCheckRanRef.current = true
    void runPriceCheck(false, true)
  }, [runPriceCheck])

  // ---- 本地网关自动开启：解锁保险箱后（且设置开启）注册路由并启动（仅桌面端） ----
  const gatewayAutoRef = useRef(false)
  useEffect(() => {
    if (!sessionPwd) { gatewayAutoRef.current = false; return }
    if (gatewayAutoRef.current) return
    const st = stateRef.current
    if (!('__TAURI_INTERNALS__' in window) || !st.settings.gatewayAutoStart || !st.settings.gatewayToken) return
    gatewayAutoRef.current = true
    void (async () => {
      try {
        const routes = await buildGatewayRoutes(st, sessionPwd)
        if (!Object.keys(routes).length) return
        await gatewaySetRoutes(routes)
        await gatewayStart(st.settings.gatewayPort || 8787, st.settings.gatewayToken!)
      } catch { /* 网关是增强功能，失败静默 */ }
    })()
  }, [sessionPwd])

  // ---- 保险箱闲置自动上锁：解锁后无操作达到设置时长，清空会话密码并通知 Key 管理页同步上锁 ----
  useEffect(() => {
    const mins = state.settings.autoLockMinutes ?? 0
    if (!sessionPwd || !mins) return
    const lock = () => {
      setSessionPwd('')
      window.dispatchEvent(new Event('acm-autolock'))
      notify(`保险箱已自动上锁（闲置 ${mins} 分钟）`)
    }
    let timer = window.setTimeout(lock, mins * 60_000)
    const reset = () => { window.clearTimeout(timer); timer = window.setTimeout(lock, mins * 60_000) }
    window.addEventListener('pointerdown', reset, { passive: true })
    window.addEventListener('keydown', reset)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('pointerdown', reset)
      window.removeEventListener('keydown', reset)
    }
  }, [sessionPwd, state.settings.autoLockMinutes, notify])

  // ---- 余额自动巡检：保险箱解锁后（sessionPwd 就绪）静默刷新可查余额平台的官方余额 ----
  // 6 小时节流（localStorage 时间戳）；失败静默，不打扰；无总额度上限的结果（仅 label）不落快照。
  const balancePatrolRef = useRef(false)
  useEffect(() => {
    if (!sessionPwd || balancePatrolRef.current) return
    const KEY = 'acm_balance_patrol_at'
    const last = Number(localStorage.getItem(KEY) ?? 0)
    if (Date.now() - last < 6 * 3600 * 1000) return
    balancePatrolRef.current = true
    localStorage.setItem(KEY, String(Date.now()))
    void (async () => {
      for (const a of stateRef.current.accounts) {
        if (!a.encryptedKey) continue
        const adapter = getAdapter(a.providerId)
        if (!adapter.supported) continue
        try {
          const plain = await decryptSecret(a.encryptedKey, sessionPwd)
          const r = await adapter.fetchUsage!(plain)
          const total = r.total
          if (total === undefined) continue
          setState(s => upsertQuota(s, { accountId: a.id, used: r.used, total, unit: r.unit, source: 'api' }))
        } catch { /* 巡检失败静默：单账户问题不打扰用户，手动刷新仍会给出明确报错 */ }
      }
    })()
  }, [sessionPwd])

  // ---- 系统通知提醒引擎：启动时 + 每 15 分钟评估一次，去重后发送 ----
  const notifyPrefs = notifyPrefsOf(state.settings)
  useEffect(() => {
    if (!notifyPrefs.enabled) return
    let cancelled = false
    const run = async () => {
      const perm = await getNotificationPermission()
      if (cancelled || perm !== 'granted') return
      const events = buildReminders({
        now: new Date(),
        prefs: notifyPrefs,
        pendingCheckins: pendingCheckins.map((t) => t.name),
        expiring: views
          .filter((v) => v.daysUntilReset != null && v.daysUntilReset >= 0 && v.daysUntilReset <= state.settings.alertDays)
          .map((v) => ({ accountId: v.account.id, name: v.account.label || v.provider?.name || '账户', days: v.daysUntilReset as number })),
        forecastAlerts: views
          .filter((v) => v.forecast && (v.forecast.level === 'exhausted' || v.forecast.level === 'critical' || (v.forecast.level === 'warning' && (v.forecast.daysLeft ?? 99) <= state.settings.alertDays)))
          .map((v) => ({ accountId: v.account.id, name: v.account.label || v.provider?.name || '账户', daysLeft: v.forecast?.daysLeft ?? 0 })),
        monthCost,
        monthlyBudget: state.settings.monthlyBudget,
        lowBalances: views
          .filter((v) => v.quota?.unit === 'currency' && (v.quota.total - v.quota.used) >= 0 && (v.quota.total - v.quota.used) < (state.settings.lowBalanceThreshold ?? 10))
          .map((v) => ({ accountId: v.account.id, name: v.account.label || v.provider?.name || '账户', remaining: (v.quota!.total - v.quota!.used), symbol: '¥' })),
        spendAnomalies: detectSpendAnomalies(state, todayISO()).map((sa) => {
          const acc = state.accounts.find((a) => a.id === sa.accountId)
          return { ...sa, name: acc?.label || (acc ? PROVIDER_MAP[acc.providerId]?.name : undefined) || '账户' }
        }),
        providerBudgets: Object.entries(state.settings.providerBudgets ?? {})
          .filter(([, b]) => b > 0)
          .map(([providerId, budget]) => ({
            providerId,
            name: PROVIDER_MAP[providerId]?.shortName ?? providerId,
            cost: state.usage
              .filter((u) => u.date.startsWith(todayISO().slice(0, 7)) && state.accounts.find((a) => a.id === u.accountId)?.providerId === providerId)
              .reduce((s, u) => s + u.estimatedCost, 0),
            budget,
          })),
        monthlyReportSummary: (() => {
          const lastMonth = prevMonthKey(todayISO().slice(0, 7))
          const rep = buildMonthlyReport(state, lastMonth)
          return { month: lastMonth, totalCost: rep.totalCost, recordCount: rep.recordCount, topPlatform: rep.byPlatform[0]?.name, deltaPct: rep.costDeltaPct }
        })(),
        subscriptionRenewals: summarizeSubscriptions(state).rows
          .filter((r) => r.daysLeft <= (state.settings.alertDays || 7))
          .map((r) => ({ accountId: r.accountId, name: r.label, days: r.daysLeft, renewAt: r.nextRenewAt })),
        accountBudgets: Object.entries(state.settings.accountBudgets ?? {})
          .filter(([, b]) => b > 0)
          .map(([accountId, budget]) => {
            const acc = state.accounts.find((a) => a.id === accountId)
            return {
              accountId,
              name: acc?.label || (acc ? PROVIDER_MAP[acc.providerId]?.shortName : undefined) || '账户',
              cost: state.usage
                .filter((u) => u.date.startsWith(todayISO().slice(0, 7)) && u.accountId === accountId)
                .reduce((s, u) => s + u.estimatedCost, 0),
              budget,
            }
          }),
      })
      const fresh = filterUnsent(events).slice(0, 3)
      for (const e of fresh) { if (!cancelled) await showNotification(e.title, e.body, e.id) }
      if (fresh.length && !cancelled) markSent(fresh)
    }
    void run()
    const t = window.setInterval(run, 15 * 60 * 1000)
    return () => { cancelled = true; window.clearInterval(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // 安卓端：把额度摘要同步给桌面小组件（原生小组件读 Preferences 渲染）
  useEffect(() => { if (isNativeApp()) syncWidgetData(state) }, [state])

  // 安卓端：同步每日签到定时通知（App 关闭也能提醒）
  useEffect(() => {
    if (notifyPrefs.enabled && notifyPrefs.checkin) {
      const [h, m] = notifyPrefs.checkinTime.split(':').map((x) => Number(x) || 0)
      void scheduleDailyCheckin(h, m)
    } else {
      void cancelDailyCheckin()
    }
  }, [notifyPrefs.enabled, notifyPrefs.checkin, notifyPrefs.checkinTime])

  const tabs: Array<{ id: Tab; label: string; icon: typeof LayoutDashboard }> = [
    { id: 'ai', label: 'AI 助手', icon: Sparkles },
    { id: 'dashboard', label: '额度看板', icon: LayoutDashboard },
    { id: 'checkin', label: 'AI 工具大全', icon: CalendarCheck2 },
    { id: 'benefits', label: 'AI 翻译', icon: Languages },
    { id: 'image', label: 'AI 图像', icon: Image },
    { id: 'video', label: 'AI 视频', icon: Film },
    { id: 'keys', label: 'API Key 管理', icon: KeyRound },
    { id: 'usage', label: '用量与费用', icon: BarChart3 },
    { id: 'calendar', label: '额度日历', icon: CalendarDays },
    { id: 'voice', label: '语音配置', icon: Volume2 },
    { id: 'docs', label: '文档问答', icon: FileText },
    { id: 'settings', label: '设置', icon: Settings },
  ]

  // 侧栏分组（仅布局层：不改变任何 tab id / 路由 / 数据逻辑）
  const navGroups: Array<{ label: string; ids: Tab[] }> = [
    { label: '概览', ids: ['ai', 'dashboard'] },
    { label: 'AI 创作', ids: ['image', 'video', 'benefits', 'docs'] },
    { label: '资产管理', ids: ['keys', 'usage', 'calendar', 'checkin'] },
    { label: '系统', ids: ['voice', 'settings'] },
  ]

  // 移动端底部导航：只保留 5 个高频入口，AI 置于正中，其余从抽屉进入（原 10 个太挤）
  const bottomTabs: Tab[] = ['dashboard', 'checkin', 'ai', 'keys', 'settings']
  const shortLabel: Record<Tab, string> = {
    ai: 'AI', dashboard: '看板', checkin: '工具', benefits: '翻译', 'chat-translate': '对话翻译', image: '图像', video: '视频',
    'local-image': '本地图像', 'local-video': '本地视频',
    keys: '密钥', usage: '用量', calendar: '日历', report: '报告', voice: '语音', docs: '文档', settings: '设置',
  }

  // ---- 全局搜索（Cmd/Ctrl+K） ----
  const [paletteOpen, setPaletteOpen] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); setPaletteOpen(v => !v) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const paletteItems: PaletteItem[] = useMemo(() => {
    const pages: PaletteItem[] = tabs.map(t => ({ id: `page-${t.id}`, group: '页面', title: t.label, keywords: t.id, run: () => openTab(t.id) }))
    pages.push({ id: 'page-report', group: '页面', title: '月度报告', keywords: 'report month 月度 报告 汇总', run: () => openTab('report') })
    const actions: PaletteItem[] = [
      { id: 'act-add', group: '操作', title: '添加账户', keywords: 'add account new 添加 账户 新建 key', run: () => setAddOpen(true) },
    ]
    const accounts: PaletteItem[] = state.accounts.map(a => ({
      id: `acc-${a.id}`, group: '账户',
      title: a.label || PROVIDER_MAP[a.providerId]?.name || a.providerId,
      hint: PROVIDER_MAP[a.providerId]?.shortName,
      keywords: `${a.providerId} ${a.note ?? ''}`,
      run: () => openTab('keys'),
    }))
    let tools: PaletteItem[] = []
    try {
      tools = currentCatalog().tools.map(t => ({
        id: `tool-${t.id}`, group: 'AI 工具', title: t.name, hint: t.nameEn,
        keywords: `${t.id} ${t.nameEn} ${t.category}`, run: () => openTab('checkin'),
      }))
    } catch { /* 工具目录不可用时跳过 */ }
    return [...pages, ...actions, ...accounts, ...tools]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.accounts])

  // ---- 审计日志快捷写入 ----
  const audit = useCallback((action: string, detail?: string) => {
    setState(s => appendAudit(s, makeAuditEntry(action, detail)))
  }, [])

  // 手机端侧栏：与桌面端使用同一分组顺序；手机客户端不含文档问答（无本机服务）
  const drawerTabs: Tab[] = (['ai', 'dashboard', 'image', 'video', 'benefits', 'docs', 'keys', 'usage', 'calendar', 'checkin', 'voice', 'settings'] as Tab[])
    .filter(id => !(isPhone && id === 'docs'))

  // 界面风格：全平台统一极简留白风（已移除其他风格选项，强制 claude）
  const motionOn = state.settings.uiMotion !== false
  const shellClass = [
    'app-shell',
    isPhone ? 'phone-shell' : '',
    'claude-ui',
    motionOn ? 'motion-ui' : 'no-motion',
    sidebarVisible ? '' : 'sidebar-collapsed',
  ].filter(Boolean).join(' ')

  return (
    <div className={shellClass}>
      {/* 手机端抽屉遮罩：点击关闭侧栏 */}
      {isPhone && sidebarVisible && <button className="phone-scrim" aria-label="关闭菜单" onClick={() => setSidebarVisible(false)} />}
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><img src="./pwa-512.png" alt="AI 积分管家" className="app-mark-img" /></div>
          <div className="brand-text">
            <div className="brand-name">AI 积分管家</div>
            <div className="brand-sub">AI CREDIT MANAGER</div>
          </div>
          {isPhone && <button className="icon-btn sidebar-toggle" onClick={() => setSidebarVisible(false)} title="关闭菜单"><X size={19} /></button>}
          {!isPhone && <button className="icon-btn sidebar-toggle sidebar-head-toggle" onClick={toggleSidebar} title={sidebarVisible ? '收起侧边栏（只显示图标）' : '展开侧边栏'} aria-label="切换侧边栏">{sidebarVisible ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}</button>}
        </div>
        <nav className="nav" aria-label="主导航">
          {navGroups.map((group) => {
            const visibleIds = group.ids.filter((id) => (isPhone ? drawerTabs : tabs.map((t) => t.id)).includes(id))
            if (!visibleIds.length) return null
            return (
              <div className="nav-group" key={group.label}>
                <div className="nav-group-label">{group.label}</div>
                {visibleIds.map((id) => {
                  const t = tabs.find((x) => x.id === id)!
                  const Icon = t.icon
                  const badge = id === 'dashboard' && runningOut.length > 0 ? runningOut.length : id === 'checkin' && pendingCheckins.length > 0 ? pendingCheckins.length : null
                  return (
                    <Fragment key={t.id}>
                      <button className={`nav-item ${tab === t.id ? 'active' : ''}`}
                        onClick={() => openTab(t.id)} title={t.label}>
                        <span className="nav-item-icon"><Icon size={17} /></span>
                        <span className="nav-item-label">{t.label}</span>
                        {id === 'checkin' && catalogNews.length > 0 ? <span className="nav-new-dot" title={`目录新增 ${catalogNews.length} 款工具`} /> : null}
                        {badge ? <span className="badge nav-badge">{badge}</span> : null}
                      </button>
                      {id === 'ai' && sidebarVisible && (
                        <SidebarHistory open={historyOpen} onToggle={() => setHistoryOpen(v => !v)} onNavigate={() => openTab('ai')} />
                      )}
                    </Fragment>
                  )
                })}
              </div>
            )
          })}
        </nav>
        <button className="cmdk-trigger" onClick={() => setPaletteOpen(true)} title="全局搜索（Ctrl/⌘ + K）">
          <Search size={15} />
          <span className="cmdk-trigger-label">搜索页面 / 账户 / 工具</span>
          <kbd>⌘K</kbd>
        </button>
        <button
          className="sync-status-bar"
          onClick={() => {
            if (!cloudUser) { setLoginOpen(true); return }
            if (!syncing) void pullCloud()
          }}
          title={!cloudUser ? '登录后开启云同步' : syncError ? `同步失败：${syncError}，点击重试` : '点击立即同步'}
        >
          <span className={`status-dot ${!cloudUser ? 'off' : syncing ? 'busy' : syncError ? 'err' : 'ok'}`} />
          <div className="sync-status-text">
            <b>{!cloudUser ? '本地模式' : syncing ? '同步中…' : syncError ? '同步失败' : '已云同步'}</b>
            <span>{!cloudUser
              ? '未登录云同步 · 点此登录'
              : syncing
                ? (cloudUser.name ?? cloudUser.email ?? '正在与云端同步')
                : syncError
                  ? '点此重试'
                  : `最近 ${syncTimeText(lastSyncAt)} · 点此刷新`}</span>
          </div>
          <span className="sync-status-icon">{!cloudUser ? <CloudOff size={16} /> : syncError ? <AlertTriangle size={16} /> : <Cloud size={16} />}</span>
        </button>
        <div className="sidebar-foot">
          <div className="sidebar-status">
            <span className="status-dot" />
            <div><b>本地优先</b><span>数据只保存在此设备</span></div>
          </div>
          <div className="compliance">
            仅只读官方接口 · 签到跳转官方页本人操作
          </div>
        </div>
      </aside>

      <main className="main">
        {/* 手机端：悬浮玻璃菜单按钮，点击打开侧栏抽屉 */}
        {isPhone && !sidebarVisible && <button className="phone-menu-fab" aria-label="打开菜单" onClick={() => setSidebarVisible(true)}><Menu size={22} /></button>}

        <div className={`content ${tab === 'ai' ? 'content-ai' : ''}`}>
          <Suspense fallback={<div style={{ padding: 32, color: 'var(--text-3)', fontSize: 13 }}>加载中…</div>}>
          {tab === 'ai' && <AIView notify={notify} accounts={state.accounts} settings={state.settings} serviceController={isPhone ? undefined : serviceController} prompts={state.prompts ?? []} onPromptsChange={(prompts) => setState(s => ({ ...s, prompts }))} />}
          {tab === 'dashboard' && <>
          {state.accounts.length === 0 && !onboardingOff && <div className="onboarding-card">
            <button className="onboarding-close" onClick={() => { try { localStorage.setItem('acm.onboarding.dismissed', '1') } catch { /* 忽略 */ } setOnboardingOff(true) }} title="不再显示"><X size={15} /></button>
            <h3>三步上手 AI 积分管家</h3>
            <div className="onboarding-steps">
              <div className="onboarding-step">
                <b>1 · 添加账户</b>
                <span>把你在用的 AI 平台账户（DeepSeek、Kimi、智谱等）加进来。</span>
                <button className="btn sm primary" onClick={() => setAddOpen(true)}><Plus size={14} /> 添加账户</button>
              </div>
              <div className="onboarding-step">
                <b>2 · 录入额度</b>
                <span>在账户卡片上点「录入/更新额度」，看板会自动预测到期时间与耗尽风险。</span>
              </div>
              <div className="onboarding-step">
                <b>3 · 开提醒与同步</b>
                <span>开启签到/到期提醒，登录云同步后手机与电脑自动对齐。</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn sm" onClick={() => setSettingsOpen(true)}>开启提醒</button>
                  <button className="btn sm" onClick={() => setLoginOpen(true)}>登录同步</button>
                </div>
              </div>
            </div>
          </div>}
          <div className="bento-greeting">
            <h2>{runningOut.length ? `今天先处理这 ${runningOut.length} 件` : '今天一切正常'}</h2>
            {runningOut.length ? <span className="bento-alert-pill">{runningOut.length} 个账户告急</span> : pendingCheckins.length ? <span className="bento-alert-pill warn">{pendingCheckins.length} 个待签到</span> : <span className="bento-alert-pill ok">额度健康</span>}
          </div>
          <section className="bento-grid" aria-label="概览">
            <div className="bento-tile bento-main">
              <div className="bento-label">资源总估值 · {state.accounts.length} 个账户</div>
              <div className="bento-big">¥{portfolioValue.toFixed(0)}</div>
              <div className="bento-sub">本月已用 ¥{monthCost.toFixed(2)} / 预算 ¥{state.settings.monthlyBudget}<br />单价可在用量页校准</div>
              <button className="btn bento-cta" onClick={() => setAddOpen(true)}><Plus size={15} /> 添加账户</button>
            </div>
            <button className="bento-tile bento-amber" onClick={() => openTab('checkin')}>
              <div className="bento-label">今日待签到</div>
              <div className="bento-num">{pendingCheckins.length}<small> 个</small></div>
              <div className="bento-sub">{pendingCheckins.length ? '去领取免费额度 →' : '今日已全部完成'}</div>
            </button>
            <button className="bento-tile bento-red" onClick={() => openTab('usage')}>
              <div className="bento-label">即将耗尽</div>
              <div className="bento-num">{runningOut.length}<small> 个</small></div>
              <div className="bento-sub">{runningOut.length ? `${state.settings.alertDays} 天内优先处理 →` : `${lowQuota.length} 个用量超 80%`}</div>
            </button>
            <button className="bento-tile bento-green" onClick={() => openTab('image')}>
              <div className="bento-label">AI 图像</div>
              <div className="bento-action">开始生成 →</div>
              <div className="bento-sub">用你的模型账户生图</div>
            </button>
            <button className="bento-tile bento-blue" onClick={() => openTab('video')}>
              <div className="bento-label">AI 视频</div>
              <div className="bento-action">开始生成 →</div>
              <div className="bento-sub">用你的模型账户生视频</div>
            </button>
            <button className="bento-tile bento-violet" onClick={() => openTab('ai')}>
              <div className="bento-label">AI 助手</div>
              <div className="bento-action">开始对话 →</div>
              <div className="bento-sub">对话、推理与附件分析</div>
            </button>
            <button className="bento-tile bento-teal" onClick={() => openTab('usage')}>
              <div className="bento-label">本月预估费用</div>
              <div className="bento-num">¥{monthCost.toFixed(2)}</div>
              <div className="bento-sub">预算 ¥{state.settings.monthlyBudget} · 查看趋势 →</div>
            </button>
          </section>

          {healthRows.length > 0 && (
            <div className="panel" style={{ padding: 16, marginBottom: 14 }}>
              <div className="row between">
                <b style={{ fontSize: 13.5 }}>账户体检 <span className="hint">按分数从低到高 · 先救最差的</span></b>
                <span style={{ fontSize: 12, color: 'var(--text-3)' }}>告急 {healthRows.filter(h => h.grade === '告急').length} · 注意 {healthRows.filter(h => h.grade === '注意').length} · 健康 {healthRows.filter(h => h.grade === '健康').length}</span>
              </div>
              <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
                {healthRows.slice(0, 5).map(h => (
                  <div key={h.accountId} className="row" style={{ gap: 10, alignItems: 'center' }}>
                    <b style={{ fontSize: 15, minWidth: 34, textAlign: 'center', color: h.grade === '告急' ? 'var(--red)' : h.grade === '注意' ? '#d97706' : '#16a34a' }}>{h.score}</b>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13 }}>{h.label} <span className="hint">{h.platform}</span></div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.reasons.length ? h.reasons.join('；') : '状态良好'}</div>
                    </div>
                    <div style={{ width: 90, height: 6, borderRadius: 3, background: 'var(--border)', overflow: 'hidden', flex: 'none' }}>
                      <div style={{ height: '100%', width: `${h.score}%`, background: h.grade === '告急' ? 'var(--red)' : h.grade === '注意' ? '#d97706' : '#16a34a' }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <DashboardView views={views} onAdd={() => setAddOpen(true)} onRemove={(id) => {
            const acc = state.accounts.find(a => a.id === id)
            const doRemove = () => {
              scheduleUndo(stateRef.current, '账户已移除')
              setState(s => removeAccount(s, id))
              notify(`账户「${acc?.label ?? ''}」及关联数据已移除（5 秒内可撤回）`)
            }
            // 本地模型删除无需备份（仅存本机、无密钥价值）
            if (acc && isLocalProvider(acc.providerId)) doRemove()
            else requestBackup([id], '删除前必须备份', '确认删除', doRemove)
          }} onRemoveMany={(ids) => {
            const localOnly = ids.every(id => {
              const a = state.accounts.find(x => x.id === id)
              return a && isLocalProvider(a.providerId)
            })
            const doRemove = () => {
              scheduleUndo(stateRef.current, `已删除 ${ids.length} 个账户`)
              setState(s => ids.reduce((acc, id) => removeAccount(acc, id), s))
              notify(`已删除 ${ids.length} 个账户（5 秒内可撤回）`)
            }
            if (localOnly) doRemove()
            else requestBackup(ids, '删除前必须备份', '确认删除', doRemove)
          }} onEditQuota={(accountId) => setQuotaTarget(accountId)} notify={notify} />
          </>}

          {tab === 'checkin' && <AgentToolsView
            checkins={state.checkins} notify={notify}
            onToggle={(pid, aid) => setState(s => toggleCheckin(s, pid, aid))}
            catalogNews={catalogNews} onCatalogNewsAck={ackCatalogNews}
          />}

          {tab === 'benefits' && <TranslationView accounts={state.accounts} notify={notify} settings={state.settings} serviceController={isPhone ? undefined : serviceController} onOpenChat={() => openTab('chat-translate')} />}

          {tab === 'chat-translate' && <ChatTranslateView accounts={state.accounts} notify={notify} settings={state.settings} serviceController={isPhone ? undefined : serviceController} onBack={() => openTab('benefits')} />}

          {tab === 'image' && <ImageView accounts={state.accounts} sessionPwd={sessionPwd} onUnlock={setSessionPwd} notify={notify} settings={state.settings} onOpenLocal={isPhone ? undefined : () => openTab('local-image')} />}

          {tab === 'video' && <VideoView accounts={state.accounts} sessionPwd={sessionPwd} onUnlock={setSessionPwd} notify={notify} settings={state.settings} onOpenLocal={isPhone ? undefined : () => openTab('local-video')} />}

          {!isPhone && tab === 'local-image' && <div className="set-content"><button className="btn sm ghost sd-back" onClick={() => openTab('image')}><X size={15} /> 返回 AI 图像</button><LocalImageView notify={notify} serviceController={serviceController} /></div>}

          {!isPhone && tab === 'local-video' && <div className="set-content"><button className="btn sm ghost sd-back" onClick={() => openTab('video')}><X size={15} /> 返回 AI 视频</button><LocalVideoView notify={notify} serviceController={serviceController} /></div>}

          {tab === 'keys' && <div className="page-action-row"><button className="btn" onClick={() => setPasteOpen(true)}><ClipboardPaste size={16} /> 智能粘贴</button><button className="btn primary" onClick={() => setAddOpen(true)}><Plus size={16} /> 添加账户</button></div>}
          {tab === 'keys' && <KeysView
            state={state} notify={notify}
            onAudit={audit}
            onImportFile={handleImportFile}
            onExport={() => setExportOpen(true)}
            onOpenVault={() => setVaultOpen(true)}
            onQuotaFetched={(accountId, used, total, unit) => {
              setState(s => upsertQuota(s, { accountId, used, total: total ?? used, unit, source: 'api' }))
            }}
            onRemoveKeys={(ids) => {
              audit('删除账户', ids.length === 1 ? (state.accounts.find(a => a.id === ids[0])?.label ?? '账户') : `${ids.length} 个账户`)
              scheduleUndo(stateRef.current, ids.length === 1
                ? `已删除「${state.accounts.find(a => a.id === ids[0])?.label ?? '账户'}」`
                : `已删除 ${ids.length} 个账户`)
              setState(s => ids.reduce((acc, id) => removeAccount(acc, id), s))
              notify(`已删除 ${ids.length} 个账户及关联数据（5 秒内可撤回）`)
            }}
            onRequestBackup={(ids, title, confirmLabel, after, backupOnly) => {
              // 本地模型删除跳过备份门禁；真 API Key 保持原流程
              const localOnly = !backupOnly && ids.length > 0 && ids.every(id => {
                const a = state.accounts.find(x => x.id === id)
                return a && isLocalProvider(a.providerId)
              })
              if (localOnly) { after(); return }
              requestBackup(ids, title, confirmLabel, after, backupOnly)
            }}
            onUpdateAccount={(id, patch) => setState(s => updateAccount(s, id, patch))}
            onUnlocked={(pwd) => setSessionPwd(pwd)}
            initialPwd={keyPageInitialPwd}
            bioLabel={bioLabel}
          />}

          {tab === 'calendar' && <CalendarView state={state} />}

          {tab === 'report' && <ReportView state={state} notify={notify} />}

          {tab === 'usage' && <UsageView state={state} notify={notify}
            priceAlerts={priceAlerts} priceCheckedAt={priceCheckedAt} checkingPrices={checkingPrices}
            onCheckPrices={() => void runPriceCheck(true, false)}
            onAckPriceAlerts={() => { setPriceAlerts([]); savePriceAlerts([]) }}
            onOpenReport={() => openTab('report')}
            onProviderBudget={(providerId, v) => setState(s => ({ ...s, settings: {
              ...s.settings, providerBudgets: { ...(s.settings.providerBudgets ?? {}), [providerId]: v },
            } }))}
            onAccountBudget={(accountId, v) => setState(s => ({ ...s, settings: {
              ...s.settings, accountBudgets: { ...(s.settings.accountBudgets ?? {}), [accountId]: v },
            } }))}
            onBudget={(v) => setState(s => ({ ...s, settings: { ...s.settings, monthlyBudget: v } }))}
            onPriceChange={(providerId, price) => setState(s => ({ ...s, settings: {
              ...s.settings, unitPrices: { ...s.settings.unitPrices, [providerId]: price },
            } }))}
            onAddUsage={() => setUsageOpen(true)}
            onDeleteUsage={(ids) => setState(s => ({ ...s, usage: s.usage.filter(u => !ids.includes(u.id)) }))}
            onImport={(events) => {
              setState(s => ({ ...s, usage: [
                ...s.usage,
                ...events.map(e => ({ ...e, id: uid('u') })),
              ] }))
              notify(`已导入 ${events.length} 条用量记录`)
            }}
          />}

          {tab === 'voice' && <div className="set-content">
            <SettingsSection title="语音配置" desc="朗读音色、方言、语速与声音克隆 · 所有配置仅保存在此设备" icon={Volume2} tone="blue">
              <div style={{ padding: '4px 2px 2px' }}><VoiceSettings notify={notify} accounts={state.accounts} sessionPwd={sessionPwd} onUnlock={setSessionPwd} /></div>
            </SettingsSection>
          </div>}

          {!isPhone && tab === 'docs' && <div className="set-content">
            <SettingsSection title="本地文档问答" desc="导入文档，基于本机模型问答 · 文档与向量只存此设备" icon={FileText} tone="indigo">
              <div style={{ padding: '4px 2px 2px' }}>
                <DocQAView accounts={state.accounts} sessionPwd={sessionPwd} onUnlock={setSessionPwd} notify={notify} thinkingMode={state.settings.thinkingMode} settings={state.settings} serviceController={serviceController} />
              </div>
            </SettingsSection>
          </div>}
          </Suspense>
        </div>
      </main>

      {/* 设置中心：Claude 风为居中模态弹窗，其他风格仍可经 tab 打开 */}
      {settingsOpen && (() => {
        const node = <SettingsView
          state={state}
          onChange={(patch) => setState(s => updateSettings(s, patch))}
          notify={notify}
          auditEntries={state.audit ?? []}
          onClearAudit={() => { setState(s => ({ ...s, audit: [] })); notify('审计日志已清空') }}
          onImportBackup={(imported) => {
            try { localStorage.setItem('acm.state.pre-import-backup', JSON.stringify(state)) } catch { /* 存不下就忽略，不阻断导入 */ }
            // 网关令牌是本机凭据：导入备份不覆盖本机的令牌
            setState({ ...imported, settings: { ...imported.settings, gatewayToken: state.settings.gatewayToken } })
            setSessionPwd('')
            audit('导入完整备份', `账户 ${imported.accounts.length} 个`)
            notify('备份已导入并覆盖当前数据；保险箱已锁定，请用备份来源的主密码重新解锁')
          }}
          onOpenVault={() => setVaultOpen(true)}
          onChangePassword={async (oldPwd, newPwd) => {
            const keyAccounts = state.accounts.filter(a => a.encryptedKey)
            const ciphers = keyAccounts.map(a => a.encryptedKey!)
            const renewed = await changeMasterPassword(oldPwd, newPwd, ciphers)
            renewed.forEach((cipher, i) => {
              setState(s => ({ ...s, accounts: s.accounts.map(a => a.id === keyAccounts[i].id ? { ...a, encryptedKey: cipher } : a) }))
            })
            if (state.settings.unlockMethod === 'biometric') { saveBiometricPassword(newPwd); void bindVaultPasswordNative(newPwd) }
            setSessionPwd(newPwd)
            audit('修改主密码')
          }}
          onResetVault={() => {
            clearBiometricPassword()
            void unbindVaultPasswordNative()
            resetVault()
            setSessionPwd('')
            setState(s => ({
              ...s,
              accounts: s.accounts.map(a => ({ ...a, encryptedKey: undefined, keyFingerprint: undefined })),
              settings: { ...s.settings, vaultInitialized: false, unlockMethod: 'password' },
            }))
            notify('保险箱已重置')
          }}
          onBioAvailable={bioAvailableGlobal}
          onBioUnlock={() => void handleBioUnlock()}
          bioLabel={bioLabel}
          sessionPwd={sessionPwd}
          onCheckUpdate={() => setUpdateOpen(true)}
          onClear={() => {
            requestBackup(state.accounts.map(a => a.id), '清空前必须备份', '确认清空', () => {
              void (async () => {
                const bioOk = await biometricAuth('验证身份以清空全部业务数据')
                if (!bioOk) {
                  const unlocked = !!(sessionPwd || getBiometricPassword())
                  if (!unlocked) { notify('请先解锁保险箱或在支持生物识别的设备上验证，未执行清空'); return }
                }
                scheduleUndo(stateRef.current, '业务数据已清空')
                setState(s => clearAllData(s))
                notify('业务数据已清空（5 秒内可撤回）')
              })()
            })
          }}
          cloudUser={cloudUser}
          syncing={syncing}
          syncError={syncError}
          lastSyncAt={lastSyncAt}
          onLogin={() => setLoginOpen(true)}
          onLogout={handleCloudLogout}
          onSync={() => void pullCloud()}
        />
        return (
          <div className="set-modal-backdrop" onClick={() => setSettingsOpen(false)}>
            <div className="set-modal" onClick={e => e.stopPropagation()}>
              <div className="set-modal-head">
                <h2>设置</h2>
                <button className="icon-btn" onClick={() => setSettingsOpen(false)} title="关闭"><X size={18} /></button>
              </div>
              <div className="set-modal-body">{node}</div>
            </div>
          </div>
        )
      })()}

      {/* 移动端底部导航：手机原生端改用侧栏抽屉，此处仅 Web/其他端显示 */}
      {!isPhone && <nav className="bottom-nav">
        {bottomTabs.map(id => {
          const t = tabs.find(x => x.id === id)!
          const Icon = t.icon
          return (
            <button key={t.id} className={`bottom-nav-item ${tab === t.id ? 'active' : ''} ${t.id === 'ai' ? 'center' : ''}`} onClick={() => openTab(t.id)}>
              <Icon size={20} />
              <span>{shortLabel[t.id]}</span>
            </button>
          )
        })}
      </nav>}

      {addOpen && <PlatformPickerModal
        onClose={() => setAddOpen(false)}
        onPick={(pid) => {
          // 本地服务账户可直接添加，无需先在设置页开启开关（开关只控制功能可用性，不限制添加）
          setAddOpen(false); setFormProviderId(pid)
        }}
      />}
      {pasteOpen && <SmartPasteModal
        onClose={() => setPasteOpen(false)}
        onConfirm={(pid, key) => { setPasteOpen(false); setPasteSecret(key); setFormProviderId(pid) }}
      />}
      {formProviderId && isLocalProvider(formProviderId) && <LocalAccountFormModal
        provider={PROVIDER_MAP[formProviderId]} sessionPwd={sessionPwd}
        onClose={() => setFormProviderId(null)}
        onSave={(account, pwd) => {
          setState(s => ({ ...s, accounts: [{ ...account }, ...s.accounts] }))
          if (pwd && !sessionPwd) setSessionPwd(pwd)
          setFormProviderId(null)
          notify(`已添加本地模型「${account.label}」`)
        }}
        notify={notify}
      />}
      {formProviderId && !isLocalProvider(formProviderId) && <AccountFormModal
        provider={PROVIDER_MAP[formProviderId]} sessionPwd={sessionPwd}
        initialSecret={pasteSecret || undefined}
        groupSuggestions={Array.from(new Set(state.accounts.map(a => a.group).filter((g): g is string => !!g))).sort()}
        onClose={() => { setFormProviderId(null); setPasteSecret('') }}
        onSave={async (data) => {
          setState(s => ({
            ...s,
            accounts: [{ ...data.account }, ...s.accounts],
            quotas: data.quota ? [...s.quotas, data.quota] : s.quotas,
          }))
          if (data.pwd && !sessionPwd) setSessionPwd(data.pwd)
          // 语音配置(APP)：解密 Key 并同步到语音配置模块，让「第三方语音服务配置」立即显示已配置
          if (data.account.providerId === 'voice-config' && data.account.encryptedKey && data.account.voiceProvider) {
            try {
              const plain = await decryptSecret(data.account.encryptedKey, data.pwd)
              saveTtsConfig({ provider: data.account.voiceProvider as import('./core/voice-download').TtsProviderConfig['provider'], endpoint: '', mode: 'direct', apiKey: plain })
              if (data.pwd) setVoiceSessionPwd(data.pwd)
              notify(`已添加「${data.account.label}」，并同步到语音配置模块`)
            } catch {
              notify(`已添加「${data.account.label}」，但同步语音配置失败，请在语音配置页手动填写`)
            }
          } else {
            notify(`已添加「${data.account.label}」，已置顶到 API Key 管理列表`)
          }
          setFormProviderId(null); setPasteSecret('')
        }}
      />}
      {vaultOpen && <VaultModal
        initialized={state.settings.vaultInitialized}
        currentPwd={sessionPwd || getBiometricPassword() || ''}
        onClose={() => setVaultOpen(false)} notify={notify}
        onInit={async (pwd) => {
          await initVault(pwd)
          if (state.settings.unlockMethod === 'biometric') { saveBiometricPassword(pwd); void bindVaultPasswordNative(pwd) }
          setState(s => ({ ...s, settings: { ...s.settings, vaultInitialized: true } }))
          setSessionPwd(pwd)
          notify('保险箱已创建')
        }}
      />}
      {quotaTarget && (() => {
        const acc = state.accounts.find(a => a.id === quotaTarget)
        if (!acc) return null
        const existing = latestQuota(state.quotas, quotaTarget)
        return <QuotaModal
          account={acc} provider={PROVIDER_MAP[acc.providerId]} existing={existing}
          defaultUnit={state.settings.defaultUnit}
          onClose={() => setQuotaTarget(null)}
          onSave={(q) => { setState(s => upsertQuota(s, { accountId: quotaTarget, ...q })); setQuotaTarget(null); notify('额度已更新') }}
        />
      })()}
      {usageOpen && <UsageModal
        accounts={state.accounts} projectSuggestions={projectSuggestions(state)} onClose={() => setUsageOpen(false)}
        onSave={(e) => { setState(s => addUsageEvent(s, e)); setUsageOpen(false); notify('用量记录已添加') }}
      />}
      {importData && <ImportModal
        incoming={importData} current={state} onClose={() => setImportData(null)}
        onImport={(mode) => {
          const before = stateRef.current
          if (mode === 'replace') {
            setState(importData)
            notify(`已覆盖导入 ${importData.accounts.length} 个账户`)
          } else {
            setState(s => mergeState(s, importData))
            notify(`已合并，新增 ${importData.accounts.filter(a => !before.accounts.some(x => x.id === a.id)).length} 个账户`)
          }
          setImportData(null)
        }}
      />}
      {csvPreview && <CsvImportModal
        preview={csvPreview} current={state} onClose={() => setCsvPreview(null)}
        onImport={(counts) => {
          const p = csvPreview
          setState(s => {
            if (p.kind === 'accounts') {
              const existing = new Set(s.accounts.map(a => `${a.providerId}|${a.label}`))
              const fresh = p.accounts.accounts.filter(a => !existing.has(`${a.providerId}|${a.label}`))
              return { ...s, accounts: [...s.accounts, ...fresh] }
            }
            if (p.kind === 'quotas') return { ...s, quotas: [...s.quotas, ...p.quotas.quotas] }
            return { ...s, usage: [...s.usage, ...p.events.map(e => ({ ...e, id: uid('u') }))] }
          })
          notify(`已导入 ${counts} 条${p.kind === 'accounts' ? '账户' : p.kind === 'quotas' ? '额度' : '用量'}记录`)
          setCsvPreview(null)
        }}
      />}
      {servicePreview && <ServiceImportModal
        entries={servicePreview} current={state} sessionPwd={sessionPwd}
        onClose={() => setServicePreview(null)}
        onImport={(accounts, quotas, pwd) => {
          setState(s => {
            const existing = new Set(s.accounts.map(a => `${a.providerId}|${a.label}`))
            const fresh = accounts.filter(a => !existing.has(`${a.providerId}|${a.label}`))
            const freshIds = new Set(fresh.map(a => a.id))
            return {
              ...s,
              accounts: [...s.accounts, ...fresh],
              quotas: [...s.quotas, ...quotas.filter(q => freshIds.has(q.accountId))],
            }
          })
          if (pwd) setSessionPwd(pwd)
          setServicePreview(null)
          notify(`已安全导入 ${accounts.length} 个服务（密钥已加密）`)
        }}
      />}
      {exportOpen && <ExportModal state={state} onClose={() => setExportOpen(false)} onExport={(fmt, dir) => { void doExport(fmt, dir); setExportOpen(false) }} />}
      {backupGate && <DeleteBackupModal
        state={state}
        accountIds={backupGate.ids}
        unlockedPwd={sessionPwd || getBiometricPassword() || undefined}
        title={backupGate.title}
        confirmLabel={backupGate.confirmLabel}
        backupOnly={backupGate.backupOnly}
        notify={notify}
        onClose={() => setBackupGate(null)}
        onDone={() => {
          // 备份完成即更新基准时间（全平台通用，CSV/备忘录/云备份都算）
          setState(prev => updateSettings(prev, { lastExportAt: new Date().toISOString() }))
          const after = backupGate.after; setBackupGate(null); after()
        }}
      />}
      {loginOpen && <CloudLoginModal onClose={() => setLoginOpen(false)} onSuccess={handleCloudLogin} />}
      {paletteOpen && <CommandPalette items={paletteItems} onClose={() => setPaletteOpen(false)} />}
      {updateOpen && <UpdateModal onClose={() => setUpdateOpen(false)} notify={notify} />}
      {undo && <div className="undo-bar">
        <span><Check size={15} /> {undo.label}</span>
        <button onClick={doUndo}><RotateCcw size={14} /> 撤回</button>
        <i className="undo-countdown" />
      </div>}
      {backupDue && !undo && <div className="backup-due-bar">
        <AlertTriangle size={15} />
        <span>已超过 {state.settings.backupReminderDays ?? 7} 天未备份数据。</span>
        <button onClick={() => { void doExport('json') }}>立即导出备份</button>
        <button onClick={() => { if (cloudUser) { void pushCloud().then(ok => { if (ok) setBackupDue(false) }) } else setLoginOpen(true) }}>{cloudUser ? '备份到云端' : '登录后云备份'}</button>
        <button onClick={() => { try { localStorage.setItem('acm.backup.snoozeUntil', String(Date.now() + 3 * 86400000)) } catch { /* 忽略 */ } setBackupDue(false) }}>3 天后再提醒</button>
        <button className="backup-due-close" onClick={() => setBackupDue(false)} title="本次忽略"><X size={14} /></button>
      </div>}
      {toast && !undo && <div className="toast"><Check size={15} /> {toast}</div>}
    </div>
  )
}

/** 同步时间相对文案：刚刚 / N 分钟前 / N 小时前 / 日期 */
function syncTimeText(iso: string | null): string {
  if (!iso) return '尚未同步'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '尚未同步'
  const diff = Date.now() - t
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return new Date(iso).toLocaleDateString('zh-CN')
}

function StatCard({ icon, color, label, value, hint }: { icon: React.ReactNode; color: string; label: string; value: string; hint: string }) {
  const map: Record<string, { bg: string; fg: string }> = {
    blue: { bg: 'var(--blue-soft)', fg: 'var(--blue)' },
    amber: { bg: 'var(--amber-soft)', fg: 'var(--amber)' },
    red: { bg: 'var(--red-soft)', fg: 'var(--red)' },
    green: { bg: 'var(--green-soft)', fg: 'var(--green)' },
  }
  const c = map[color]
  return (
    <div className="stat-card">
      <div className="stat-top">
        <div className="stat-icon" style={{ background: c.bg, color: c.fg }}>{icon}</div>
        <span className="stat-label">{label}</span>
      </div>
      <div className="stat-value"><span className="me-num" key={value}>{value}</span></div>
      <div className="stat-hint">{hint}</div>
    </div>
  )
}

function ProviderLogo({ provider, size = 38 }: { provider: ProviderDefinition; size?: number }) {
  // 全局平台图标：优先用打包的官网图标（public/logos/<id>.png），加载失败回退彩色分类图标
  const [err, setErr] = useState(false)
  if (!err) {
    return (
      <div className="ac-logo ac-logo-img" style={{ width: size, height: size }}>
        <img src={`logos/${provider.id}.png`} alt={provider.name} onError={() => setErr(true)} />
      </div>
    )
  }
  const Icon = CATEGORY_ICON[provider.category]
  return (
    <div className="ac-logo" style={{ background: provider.color, width: size, height: size }}>
      <Icon size={size * 0.45} />
    </div>
  )
}

/** 官方外链按钮：桌面端用系统浏览器打开，Web 端开新标签；失败给出可复制的链接提示 */
function OutLink({ url, label, className = 'btn sm ghost', title, notify, style }: {
  url: string; label: React.ReactNode; className?: string; title?: string;
  notify: (m: string) => void; style?: React.CSSProperties
}) {
  return (
    <button className={className} style={{ ...style, display: 'inline-flex', alignItems: 'center', gap: 5 }} title={title}
      onClick={async () => {
        const ok = await openExternal(url)
        if (!ok) notify(`${isDesktopApp() ? '系统浏览器打开失败' : '弹窗被拦截'}，请手动复制：${url}`)
        else if (!isDesktopApp()) notify('已在新标签页打开官方页面，请本人操作')
      }}>
      {label} <ExternalLink size={12} />
    </button>
  )
}

/** 智能打开工具：桌面端默认优先唤醒本机客户端；forceWeb 时强制打开官网（用于「官方下载」） */
function ToolLink({ tool, label, className = 'btn sm ghost', title, notify, icon: Icon = ExternalLink, forceWeb = false }: {
  tool: AgentTool; label: React.ReactNode; className?: string; title?: string;
  notify: (m: string) => void; icon?: typeof ExternalLink; forceWeb?: boolean
}) {
  const url = tool.checkinUrl ?? tool.downloadUrl
  return (
    <button className={className} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }} title={title ?? `${tool.name} 官方站点`}
      onClick={async () => {
        if (forceWeb) {
          const ok = await openExternal(tool.downloadUrl)
          if (!ok) notify(`打开失败，请手动访问：${tool.downloadUrl}`)
          return
        }
        const { opened, via } = await openTool(tool.localApp, url)
        if (!opened) notify(`打开失败，请手动访问官方站点：${url}`)
        else if (via === 'local') notify(`已唤醒本机「${tool.name}」客户端`)
        else if (!isDesktopApp()) notify('已在新标签页打开官方页面，请本人操作')
      }}>
      {label} <Icon size={12} />
    </button>
  )
}

/** 工具卡片（模块级 memo：搜索/筛选时避免整墙卸载重挂载） */
const AgentToolCard = memo(function AgentToolCard({ t, done, hasLocal, notify, onToggle }: {
  t: AgentTool; done: boolean; hasLocal: boolean; notify: (m: string) => void; onToggle: (id: string) => void
}) {
  return (
    <article className="agent-card">
      <div className="agent-card-top">
        <div className="agent-logo" style={{ background: `${t.color}14` }}>
          <img src={t.icon} alt={`${t.name} 官方图标`} width={36} height={36} loading="lazy"
            onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
        </div>
        <div className="agent-card-title">
          <div className="agent-name">{t.name}</div>
          <div className="agent-name-en">{t.nameEn}</div>
        </div>
        {t.canCheckin && <span className={`tag ${done ? 'green' : 'amber'}`} style={{ flex: 'none' }}>
          {done ? <><Check size={11} /> 已签到</> : '可签到'}
        </span>}
      </div>
      <div className="agent-card-badges">
        <span className="agent-chip" style={{ color: t.color, background: `${t.color}12` }}>{t.category}</span>
        <span className="agent-chip muted">{t.region === 'cn' ? '国内' : '海外'}</span>
        {hasLocal && <span className="agent-chip local"><Monitor size={10} /> 本机已装</span>}
      </div>
      <p className="agent-desc" title={t.desc}>{t.desc}</p>
      <div className="agent-card-meta">
        <span className="agent-usage" title="按公开月访问量/月活估算，由高到低排序"><TrendingUp size={12} /> {t.usageLabel}</span>
        <span className="agent-platforms">{t.platforms.map(p => <i key={p} title={p}>{p === '浏览器插件' ? '插件' : p}</i>)}</span>
      </div>
      <div className={`agent-tip ${t.canCheckin ? 'checkin' : 'benefit'}`}
        title={t.canCheckin ? t.checkinTip : t.benefitTip}>
        <span className="agent-tip-label">{t.canCheckin ? '签到规则' : '福利说明'}</span>
        {t.canCheckin ? t.checkinTip : t.benefitTip}
      </div>
      <div className="agent-card-actions">
        <ToolLink tool={t} label={hasLocal ? '直达客户端' : '官方网站'} className={`btn sm ${hasLocal ? 'primary' : 'ghost'}`}
          title={hasLocal ? `唤醒本机 ${t.name} 客户端（未安装则打开官网）` : `打开 ${t.name} 官方站点`} notify={notify} />
        {/* 官方下载直达：始终打开官网下载页，不唤醒本地客户端 */}
        <ToolLink tool={t} label="官方下载" className="btn sm ghost" icon={Download} forceWeb
          title={`打开 ${t.name} 官方下载/主页`} notify={notify} />
        {t.canCheckin && <button className="btn sm" onClick={() => onToggle(t.id)} title={done ? '标记为未签到' : '标记今日已签到'}>
          {done ? '撤销标记' : '标记完成'}
        </button>}
      </div>
    </article>
  )
})

/** 分页工具条 */
function AgentPager({ page, pages, onChange }: { page: number; pages: number; onChange: (p: number) => void }) {
  if (pages <= 1) return null
  const nums = Array.from({ length: pages }, (_, i) => i + 1).filter(n =>
    n === 1 || n === pages || Math.abs(n - page) <= 1)
  return (
    <div className="agent-pager">
      <button disabled={page <= 1} onClick={() => onChange(page - 1)}>上一页</button>
      {nums.map((n, i) => (
        <span key={n}>
          {i > 0 && n - nums[i - 1] > 1 && <em>…</em>}
          <button className={n === page ? 'active' : ''} onClick={() => onChange(n)}>{n}</button>
        </span>
      ))}
      <button disabled={page >= pages} onClick={() => onChange(page + 1)}>下一页</button>
      <span className="agent-pager-info">{page} / {pages}</span>
    </div>
  )
}

function DashboardView({ views, onAdd, onRemove, onRemoveMany, onEditQuota, notify }: {
  views: AccountView[]; onAdd: () => void; onRemove: (id: string) => void; onRemoveMany: (ids: string[]) => void; onEditQuota: (id: string) => void;
  notify: (m: string) => void
}) {
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const PAGE_SIZE = 6
  useEffect(() => { setPage(1) }, [views.length])
  const cur = Math.min(page, Math.max(1, Math.ceil(views.length / PAGE_SIZE)))
  const pageViews = views.slice((cur - 1) * PAGE_SIZE, cur * PAGE_SIZE)
  if (views.length === 0) {
    return (
      <div className="empty me-stack">
        <div className="stat-icon" style={{ background: 'var(--primary-soft)', color: 'var(--primary)', margin: '0 auto' }}><Wallet size={22} /></div>
        <h3 className="me-text-layer">还没有账户</h3>
        <p className="me-text-layer">添加一个你自己的 AI 平台账户，开始统一管理积分与额度</p>
        <button className="btn primary" onClick={onAdd}><Plus size={15} /> 添加第一个账户</button>
      </div>
    )
  }
  return (
    <>
      <div className="section-head">
        <h2>账户额度 <span className="hint">{views.length} 个账户</span></h2>
        <button className="btn sm" onClick={onAdd}><Plus size={14} /> 添加</button>
      </div>
      <SelectionBar
        selectedCount={selected.size} totalOnPage={pageViews.length}
        allSelected={pageViews.length > 0 && pageViews.every(v => selected.has(v.account.id))}
        onToggleAll={() => {
          const next = new Set(selected)
          const allOn = pageViews.every(v => next.has(v.account.id))
          if (allOn) pageViews.forEach(v => next.delete(v.account.id)); else pageViews.forEach(v => next.add(v.account.id))
          setSelected(next)
        }}
        onClear={() => setSelected(new Set())}
        actions={<button className="btn sm danger" onClick={() => {
          onRemoveMany(Array.from(selected))
          setSelected(new Set())
        }}><Trash2 size={13} /> 批量删除</button>}
      />
      <div className="account-grid">
        {pageViews.map((v) => {
          const percent = v.usagePercent
          const color = percent >= 90 ? 'var(--red)' : percent >= 70 ? 'var(--amber)' : 'var(--green)'
          const hasQuota = !!v.quota
          return (
            <div className={`account-card selectable ${selected.has(v.account.id) ? 'selected' : ''}`} key={v.account.id}>
              <input className="item-check" type="checkbox" title="选择此账户"
                checked={selected.has(v.account.id)} onChange={e => {
                  const next = new Set(selected)
                  if (e.target.checked) next.add(v.account.id); else next.delete(v.account.id)
                  setSelected(next)
                }} />
              <div className="ac-head">
                <ProviderLogo provider={v.provider} />
                <div style={{ minWidth: 0 }}>
                  <div className="ac-title">{v.account.label}</div>
                  <div className="ac-mode">
                    <span>{v.provider.name}</span>
                    <span style={{ color: 'var(--border-strong)' }}>·</span>
                    <span>{MODE_LABEL[v.account.mode]}</span>
                  </div>
                </div>
                <div className="ac-menu">
                  <div className="dots">
                    <button className="icon-btn" title="录入/更新额度" onClick={() => onEditQuota(v.account.id)}><RefreshCw size={14} /></button>
                    <HoldToConfirm title="移除账户" onConfirm={() => onRemove(v.account.id)} />
                  </div>
                </div>
              </div>
              {hasQuota ? (
                <>
                  <div className="ac-quota">
                    <div className="ac-quota-num">
                      <span className="me-num" key={`q-${v.account.id}-${v.quota!.used}`}>{(v.quota!.total - v.quota!.used).toLocaleString()}</span>
                      <small>{UNIT_LABEL[v.quota!.unit]}</small>
                    </div>
                    <div className="ac-quota-label">剩余 / 共 {v.quota!.total.toLocaleString()}</div>
                  </div>
                  <div className="progress"><div style={{ width: `${Math.max(percent, 2)}%`, background: color }} /></div>
                  <div className="ac-foot">
                    <span className={`tag ${percent >= 90 ? 'red' : percent >= 70 ? 'amber' : 'green'}`}>
                      已用 {percent}%
                    </span>
                    {v.daysUntilReset !== undefined
                      ? <span><Clock size={11} style={{ verticalAlign: '-1px' }} /> {v.daysUntilReset > 0 ? `${v.daysUntilReset} 天后重置` : '即将重置'}</span>
                      : <span style={{ color: 'var(--text-3)' }}>更新日期：{v.quota!.capturedAt.slice(0, 10)}</span>}
                  </div>
                  {v.forecast && v.forecast.level !== 'insufficient' && (
                    <div className={`forecast ${v.forecast.level}`} title={`依据：${v.forecast.basis === 'quota-history' ? '额度历史' : '用量记录'} · ${v.forecast.samples} 个样本${v.forecast.exhaustDate ? ` · 预计 ${v.forecast.exhaustDate}` : ''}`}>
                      <TrendingUp size={13} />
                      <span>{forecastText(v.forecast)}</span>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div style={{ padding: '10px 0 14px', fontSize: 13, color: 'var(--text-3)' }}>尚未录入额度</div>
                  <div className="ac-foot">
                    <button className="btn sm" onClick={() => onEditQuota(v.account.id)}><RefreshCw size={13} /> 录入额度</button>
                    <OutLink url={v.provider.usageUrl} label="官方用量页" notify={notify} style={{ color: 'var(--primary)' }} />
                  </div>
                </>
              )}
            </div>
          )
        })}
      </div>
      <Pager total={views.length} page={page} pageSize={PAGE_SIZE} onChange={setPage} />
    </>
  )
}

/** AI 工具目录：地区 → 签到 → 功能 → 平台 多级筛选 + 使用量排序 + 每页 3 项分页 */
function AgentToolsView({ checkins, notify, onToggle, catalogNews, onCatalogNewsAck }: {
  checkins: AppState['checkins']; notify: (m: string) => void;
  onToggle: (pid: string, aid?: string) => void
  catalogNews?: AgentTool[]; onCatalogNewsAck?: () => void
}) {
  const today = todayISO()
  const initial = useMemo(() => currentCatalog(), [])
  const [tools, setTools] = useState<AgentTool[]>(initial.tools)
  const [updatedAt, setUpdatedAt] = useState<string | null>(initial.updatedAt)
  const [syncing, setSyncing] = useState(false)
  const [region, setRegion] = useState<'all' | AgentRegion>('all')
  const [checkin, setCheckin] = useState<'all' | 'yes' | 'no'>('all')
  const [category, setCategory] = useState<'all' | AgentCategory>('all')
  const [platform, setPlatform] = useState<'all' | AgentPlatform>('all')
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)
  const [installed, setInstalled] = useState<Set<string>>(new Set())
  const PAGE_SIZE = 3

  // 实时抓取：挂载后后台拉取最新目录（15 分钟内有缓存则不重复），成功则覆盖内置快照
  useEffect(() => {
    let alive = true
    void fetchCatalog(false).then(r => {
      if (alive && r.ok && r.snapshot) {
        setTools(r.snapshot.tools)
        setUpdatedAt(r.snapshot.updatedAt)
      }
    })
    return () => { alive = false }
  }, [])

  const refreshCatalog = async () => {
    setSyncing(true)
    try {
      const r = await fetchCatalog(true)
      if (r.ok && r.snapshot) {
        setTools(r.snapshot.tools)
        setUpdatedAt(r.snapshot.updatedAt)
        notify(`目录已更新 · ${r.snapshot.tools.length} 款工具`)
      } else notify(`更新失败（${r.error ?? '网络不可用'}），当前显示本地数据`)
    } finally { setSyncing(false) }
  }

  // 桌面端：启动时并行检测本机已安装的客户端
  useEffect(() => {
    if (!isDesktopApp()) return
    let alive = true
    const withLocal = AGENT_TOOLS.filter(t => t.localApp)
    Promise.all(withLocal.map(async t => {
      const ok = await isAppInstalled(t.localApp!.bundleIds, t.localApp!.exeNames)
      return ok && alive ? t.id : null
    })).then(ids => {
      if (alive) setInstalled(new Set(ids.filter(Boolean) as string[]))
    }).catch(() => { /* 检测失败保持未安装状态 */ })
    return () => { alive = false }
  }, [])

  const doneIds = useMemo(() => new Set(
    checkins.filter(c => c.date === today && c.done).map(c => c.providerId),
  ), [checkins, today])
  const doneCount = tools.filter(t => t.canCheckin && doneIds.has(t.id)).length

  // ---- 签到助手（引导模式）：把待签到排成队列，逐个打开页面→点「已签到」自动推进 ----
  const [guideQueue, setGuideQueue] = useState<string[] | null>(null)
  const [guideSkipped, setGuideSkipped] = useState<string[]>([])
  const pendingTools = useMemo(
    () => tools.filter(t => t.canCheckin && !doneIds.has(t.id)).sort((a, b) => b.usage - a.usage),
    [tools, doneIds],
  )
  const guideCurrent = guideQueue
    ? tools.find(t => t.id === guideQueue.find(id => !doneIds.has(id) && !guideSkipped.includes(id)))
    : undefined
  const guideDone = guideQueue ? guideQueue.filter(id => doneIds.has(id)).length : 0
  const startGuide = () => {
    if (!pendingTools.length) { notify('今日待签到已全部完成'); return }
    setGuideSkipped([])
    setGuideQueue(pendingTools.map(t => t.id))
  }
  // 一键全部打开待签到页（桌面/Web）：逐个错峰打开，签完回工具页点卡片上的签到按钮登记
  const openAllCheckins = () => {
    const urls = pendingTools.map(t => t.checkinUrl ?? t.downloadUrl).filter((u): u is string => !!u)
    if (!urls.length) { notify('待签到工具暂无可打开的签到页'); return }
    urls.forEach((u, i) => { window.setTimeout(() => { void openExternal(u) }, i * 350) })
    notify(`正在打开 ${urls.length} 个签到页面，挨个领取即可（浏览器若拦截多标签，请允许弹窗后重试）`)
  }
  const endGuide = () => { setGuideQueue(null); setGuideSkipped([]) }
  const q = keyword.trim().toLowerCase()

  // 多级筛选：地区 → 签到 → 功能 → 平台 → 关键词；再按使用量由高到低排序
  const filtered = useMemo(() => tools.filter(t =>
    (region === 'all' || t.region === region) &&
    (checkin === 'all' || (checkin === 'yes' ? t.canCheckin : !t.canCheckin)) &&
    (category === 'all' || t.category === category) &&
    (platform === 'all' || t.platforms.includes(platform)) &&
    (!q || t.name.toLowerCase().includes(q) || t.nameEn.toLowerCase().includes(q) || t.desc.toLowerCase().includes(q)),
  ).sort((a, b) => b.usage - a.usage), [tools, region, checkin, category, platform, q])

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, pages)
  const pageItems = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  // 任一筛选变化时回到第一页
  const reset = <T,>(setter: (v: T) => void) => (v: T) => { setter(v); setPage(1) }
  const setRegionP = reset(setRegion)
  const setCheckinP = reset(setCheckin)
  const setCategoryP = reset(setCategory)
  const setPlatformP = reset(setPlatform)
  const setKeywordP = (v: string) => { setKeyword(v); setPage(1) }

  const handleToggle = useCallback((id: string) => onToggle(id), [onToggle])
  const updatedLabel = updatedAt
    ? new Date(updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '内置数据'

  return (
    <div className="agent-tools">
      {catalogNews && catalogNews.length > 0 && <div className="catalog-news-bar">
        <Sparkles size={15} />
        <span>目录上新：{catalogNews.slice(0, 3).map(t => t.name).join('、')}{catalogNews.length > 3 ? ` 等 ${catalogNews.length} 款新工具` : ''}，去看看有没有免费额度可领。</span>
        <button onClick={onCatalogNewsAck}>知道了</button>
      </div>}
      <div className="checkin-guide">
        {!guideQueue ? (
          <div className="cg-row">
            <div className="cg-info">
              <div className="cg-title"><CalendarCheck2 size={16} /> 今日签到助手</div>
              <div className="cg-sub">{pendingTools.length > 0
                ? `还有 ${pendingTools.length} 个工具待签到：逐个打开签到页，你点完领取，这边自动跳下一个`
                : '今日可签到的工具已全部完成 🎉'}</div>
            </div>
            {pendingTools.length > 0 && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn primary" onClick={startGuide}>开始签到（{pendingTools.length}）</button>
              {!isNativeApp() && <button className="btn" onClick={openAllCheckins} title="把今天待签到的页面一次全部打开，挨个领取"><ExternalLink size={14} /> 全部打开</button>}
            </div>}
          </div>
        ) : guideCurrent ? (
          <div className="cg-active">
            <div className="cg-progress-row">
              <span className="cg-progress-label">进度 {guideDone + guideSkipped.length}/{guideQueue.length}</span>
              <div className="cg-bar"><i style={{ width: `${((guideDone + guideSkipped.length) / guideQueue.length) * 100}%` }} /></div>
              <button className="btn sm ghost" onClick={endGuide}>结束</button>
            </div>
            <div className="cg-current">
              <span className="cg-tool-ic" style={{ background: guideCurrent.color }}>{guideCurrent.name.slice(0, 1)}</span>
              <div className="cg-tool-info">
                <b>{guideCurrent.name}</b>
                <span>{guideCurrent.checkinTip ?? guideCurrent.desc}</span>
              </div>
            </div>
            <div className="cg-actions">
              <button className="btn" onClick={() => { void openExternal(guideCurrent.checkinUrl ?? guideCurrent.downloadUrl) }}><ExternalLink size={14} /> 打开签到页</button>
              <button className="btn primary" onClick={() => handleToggle(guideCurrent.id)}><Check size={14} /> 我已签到</button>
              <button className="btn ghost" onClick={() => setGuideSkipped(sk => [...sk, guideCurrent.id])}>跳过</button>
            </div>
          </div>
        ) : (
          <div className="cg-row">
            <div className="cg-info">
              <div className="cg-title">🎉 本轮签到完成</div>
              <div className="cg-sub">完成 {guideDone} 个{guideSkipped.length ? `，跳过 ${guideSkipped.length} 个` : ''}，明天再来领新额度。</div>
            </div>
            <button className="btn" onClick={endGuide}>关闭</button>
          </div>
        )}
      </div>
      <div className="agent-toolbar">
        <div className="agent-search">
          <Search size={15} />
          <input value={keyword} onChange={e => setKeywordP(e.target.value)} placeholder="搜索工具名称 / 英文名 / 简介" />
          {keyword && <button className="icon-btn" onClick={() => setKeywordP('')} title="清除"><X size={13} /></button>}
        </div>
        <div className="agent-toolbar-meta">
          <span className="agent-quick-stat" title="已收录工具总数"><b>{tools.length}</b> 款</span>
          <span className="agent-quick-stat checkin" title="今日已签到 / 可签到"><b>{doneCount}</b>/{tools.filter(t => t.canCheckin).length} 已签</span>
        </div>
        <button className="btn sm" onClick={() => void refreshCatalog()} disabled={syncing} title="从数据源抓取最新使用量与签到规则">
          <RefreshCw size={13} className={syncing ? 'spin' : ''} /> {syncing ? '更新中' : '更新数据'}
        </button>
        <span className="agent-sync-time" title="目录数据最后更新时间">更新于 {updatedLabel}</span>
      </div>

      {/* ① 地区 */}
      <div className="agent-filter-row">
        <span className="agent-filter-label">地区</span>
        <div className="agent-filter">
          {(['all', 'cn', 'global'] as const).map(r => (
            <button key={r} className={`agent-filter-btn ${region === r ? 'active' : ''}`} onClick={() => setRegionP(r)}>
              {r === 'all' ? '全部' : r === 'cn' ? '🇨🇳 国内' : '🌍 海外'}
            </button>
          ))}
        </div>
      </div>
      {/* ② 可签到 / 不可签到 */}
      <div className="agent-filter-row">
        <span className="agent-filter-label">签到</span>
        <div className="agent-filter">
          {([['all', '全部'], ['yes', '可签到'], ['no', '不可签到']] as const).map(([v, label]) => (
            <button key={v} className={`agent-filter-btn ${checkin === v ? 'active' : ''}`} onClick={() => setCheckinP(v)}>{label}</button>
          ))}
        </div>
      </div>
      {/* ③ 功能分类 */}
      <div className="agent-filter-row">
        <span className="agent-filter-label">功能</span>
        <div className="agent-filter agent-filter-wrap">
          <button className={`agent-filter-btn ${category === 'all' ? 'active' : ''}`} onClick={() => setCategoryP('all')}>全部</button>
          {CATEGORY_TAGS.map(c => (
            <button key={c} className={`agent-filter-btn ${category === c ? 'active' : ''}`} onClick={() => setCategoryP(c)}>{c}</button>
          ))}
        </div>
      </div>
      {/* ④ 平台分类 */}
      <div className="agent-filter-row">
        <span className="agent-filter-label">平台</span>
        <div className="agent-filter agent-filter-wrap">
          <button className={`agent-filter-btn ${platform === 'all' ? 'active' : ''}`} onClick={() => setPlatformP('all')}>全部</button>
          {PLATFORM_TAGS.map(p => (
            <button key={p} className={`agent-filter-btn ${platform === p ? 'active' : ''}`} onClick={() => setPlatformP(p)}>{p}</button>
          ))}
        </div>
      </div>

      <div className="agent-result-head">
        <span>共 <b>{filtered.length}</b> 款 · 按使用量由高到低</span>
        <span>每页 {PAGE_SIZE} 项</span>
      </div>

      {pageItems.length > 0 ? (
        <>
          <div className="agent-grid">{pageItems.map(t => (
            <AgentToolCard key={t.id} t={t} done={doneIds.has(t.id)} hasLocal={installed.has(t.id)}
              notify={notify} onToggle={handleToggle} />
          ))}</div>
          <AgentPager page={safePage} pages={pages} onChange={setPage} />
        </>
      ) : (
        <div className="agent-empty" style={{ padding: 56 }}>当前分类下暂无工具，换个筛选条件试试</div>
      )}
    </div>
  )
}

function KeysView({ state, notify, onOpenVault, onRemoveKeys, onRequestBackup, onQuotaFetched, onUpdateAccount, onImportFile, onExport, onUnlocked, initialPwd, bioLabel, onAudit }: {
  state: AppState; notify: (m: string) => void; onOpenVault: () => void;
  onImportFile: (file?: File) => void; onExport: () => void;
  onRemoveKeys: (ids: string[]) => void;
  onRequestBackup: (ids: string[], title: string, confirmLabel: string, after: () => void, backupOnly?: boolean) => void;
  onQuotaFetched: (accountId: string, used: number, total: number | undefined, unit: CreditUnit) => void;
  onUpdateAccount: (id: string, patch: Partial<AppState['accounts'][number]>) => void;
  onUnlocked: (pwd: string) => void;
  initialPwd?: string;
  bioLabel?: string
  onAudit: (action: string, detail?: string) => void
}) {
  const [unlockPwd, setUnlockPwd] = useState('')
  const [vaultPwd, setVaultPwd] = useState('')
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [showBalance, setShowBalance] = useState<Record<string, boolean>>({})
  const [bioAvailable, setBioAvailable] = useState(false)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [unlockOpen, setUnlockOpen] = useState(false)
  const [category, setCategory] = useState('__all__')
  const [groupFilter, setGroupFilter] = useState('__all__')
  const [page, setPage] = useState(1)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [toolExportOpen, setToolExportOpen] = useState(false)
  const [toolExportFormat, setToolExportFormat] = useState<'env' | 'json'>('env')
  const [revealKeyTarget, setRevealKeyTarget] = useState<{ id: string; label: string; plain: string } | null>(null)
  // 点眼睛查看值（余额/Key）时若未解锁：先记下待查看目标，走解锁流程，解锁成功后自动打开查看
  const [pendingView, setPendingView] = useState<{ kind: 'key' | 'balance'; id: string } | null>(null)
  const [refreshing, setRefreshing] = useState<Set<string>>(new Set())
  // Key 健康检查：结果存本地（healthCheck.ts），逐个/全部探测 /v1/models
  const [health, setHealth] = useState<Record<string, KeyHealthResult>>(() => loadKeyHealth())
  const [checking, setChecking] = useState<Set<string>>(new Set())
  const runHealthCheck = async (list: AppState['accounts']) => {
    const targets = list.filter(a => !checking.has(a.id))
    if (!targets.length) return
    setChecking(s => new Set([...s, ...targets.map(a => a.id)]))
    let okN = 0, badN = 0, skipN = 0
    await Promise.all(targets.map(async a => {
      const eff = { ...a, apiUrl: a.apiUrl || PROVIDER_MAP[a.providerId]?.apiBaseUrl || '' }
      const r = await checkKeyHealth(eff, revealed[a.id])
      if (r.status === 'ok') okN++; else if (r.status === 'skipped') skipN++; else badN++
      setHealth(prev => { const next = { ...prev, [a.id]: r }; saveKeyHealth(next); return next })
      setChecking(s => { const n = new Set(s); n.delete(a.id); return n })
    }))
    if (list.length > 1) notify(`健康检查完成：正常 ${okN}${badN ? ` · 异常 ${badN}` : ''}${skipN ? ` · 跳过 ${skipN}（未解锁或无地址）` : ''}`)
  }
  const PAGE_SIZE = 3
  const keyAccounts = state.accounts.filter(a => a.encryptedKey)

  useEffect(() => { void biometricAvailable().then(setBioAvailable) }, [])
  // 全局自动上锁事件：同步锁上本页（清掉本页会话密码与已显示的明文）
  useEffect(() => {
    const onAutoLock = () => { setVaultPwd(''); setRevealed({}); setUnlockOpen(false); setShowBalance({}); setPendingView(null); setRevealKeyTarget(null) }
    window.addEventListener('acm-autolock', onAutoLock)
    return () => window.removeEventListener('acm-autolock', onAutoLock)
  }, [])
  // 筛选条件变化时重置页码
  useEffect(() => { setPage(1) }, [category])

  const unlockWith = async (pwd: string) => {
    setBusy(true)
    try {
      const ok = await verifyVault(pwd)
      if (!ok) { notify('主密码错误'); return }
      const decrypted: Record<string, string> = {}
      for (const a of keyAccounts) {
        try { decrypted[a.id] = await decryptSecret(a.encryptedKey!, pwd) } catch { /* skip */ }
      }
      setRevealed(decrypted)
      setVaultPwd(pwd)
      onUnlocked(pwd)
      setUnlockPwd('')
      setUnlockOpen(false)
      notify('已解锁，密钥已明文展示')
      // 解锁前点过眼睛查看某个值：解锁成功后自动完成那次查看
      if (pendingView) {
        const pv = pendingView
        setPendingView(null)
        if (pv.kind === 'balance') {
          setShowBalance(s => ({ ...s, [pv.id]: true }))
        } else {
          const acc = keyAccounts.find(a => a.id === pv.id)
          if (acc && decrypted[pv.id]) { onAudit('查看Key', acc.label); setRevealKeyTarget({ id: acc.id, label: acc.label, plain: decrypted[pv.id] }) }
          else if (acc) notify('该 Key 解密失败，无法查看')
        }
      }
    } finally { setBusy(false) }
  }

  // 从设置页指纹/人脸解锁跳转进来时，用带入的已验证密码自动解锁本页
  const autoUnlockedRef = useRef('')
  useEffect(() => {
    if (initialPwd && initialPwd !== autoUnlockedRef.current && !vaultPwd) {
      autoUnlockedRef.current = initialPwd
      void unlockWith(initialPwd)
    }
  }, [initialPwd])

  /** 从备注提取分类：取 [ xxx ] 或冒号前的部分 */
  const categoryOf = noteCategory
  const categories = Array.from(new Set(keyAccounts.map(a => categoryOf(a.note)))).sort()
  /** 保险箱分组（账户 group 字段）：已有分组名列表 */
  const groups = Array.from(new Set(keyAccounts.map(a => a.group).filter((g): g is string => !!g))).sort()
  const filtered = keyAccounts.filter(a =>
    (category === '__all__' || categoryOf(a.note) === category) &&
    (groupFilter === '__all__' || (groupFilter === '__none__' ? !a.group : a.group === groupFilter)))
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const pageItems = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)

  return (
    <>
      <div className="keys-header">
        <div>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>API Key 管理</h2>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 3 }}>{keyAccounts.length} 个密钥 · 本地加密存储</div>
        </div>
        <div className="keys-header-tools">
          <button className="btn sm" disabled={checking.size > 0 || keyAccounts.length === 0}
            onClick={() => void runHealthCheck(keyAccounts)}
            title="用每个 Key 轻量调用一次平台接口，检查密钥是否可用、服务是否可达（云端 Key 需先解锁保险箱）">
            <Activity size={14} /> {checking.size > 0 ? `检查中（剩 ${checking.size}）` : '健康检查'}
          </button>
          {categories.length > 0 && (
            <select className="select keys-filter-select" value={category} onChange={e => setCategory(e.target.value)}>
              <option value="__all__">全部分类 ({keyAccounts.length})</option>
              {categories.map(c => <option key={c} value={c}>{c} ({keyAccounts.filter(a => categoryOf(a.note) === c).length})</option>)}
            </select>
          )}
          <select className="select keys-filter-select" value={groupFilter} onChange={e => { setGroupFilter(e.target.value); setPage(1) }} title="按保险箱分组筛选（在编辑条目里给 Key 填分组）">
            <option value="__all__">全部分组 ({keyAccounts.length})</option>
            {groups.map(g => <option key={g} value={g}>{g} ({keyAccounts.filter(a => a.group === g).length})</option>)}
            <option value="__none__">未分组 ({keyAccounts.filter(a => !a.group).length})</option>
          </select>
          <div className="keys-unlock-group">
            <label className="btn sm" style={{ cursor: 'pointer' }} title="导入备份">
              <Download size={14} style={{ transform: 'rotate(180deg)' }} /> 导入
              <input type="file" accept=".json,.csv,.txt,application/json,text/csv" style={{ display: 'none' }} onChange={e => {
                onImportFile(e.target.files?.[0]); e.target.value = ''
              }} />
            </label>
            <button className="btn sm" onClick={onExport} title="导出备份（不含密钥）"><Download size={14} /> 导出</button>
            {!isVaultInitialized() && <button className="btn sm" onClick={onOpenVault}><ShieldCheck size={14} /> 创建保险箱</button>}
            {vaultPwd ? (
              <button className="btn sm" onClick={() => { setRevealed({}); setVaultPwd(''); setUnlockPwd(''); setRevealKeyTarget(null); setShowBalance({}); setPendingView(null); notify('已锁定') }}><Lock size={14} /> 锁定</button>
            ) : (
              <button className="btn sm primary" onClick={() => setUnlockOpen(true)}><Unlock size={14} /> 解锁</button>
            )}
          </div>
        </div>
      </div>

      {groups.length === 0 && keyAccounts.length > 0 && (
        <div className="group-stats">
          <span className="group-stats-label">保险箱分组</span>
          <span style={{ fontSize: 12, color: 'var(--text-2)' }}>点任意 Key 的「编辑」填写分组（如 工作 / 个人 / 项目），或添加账户时直接填；分好组后这里会按组统计剩余额度，表头下拉可按组筛选。</span>
        </div>
      )}
      {groups.length > 0 && (
        <div className="group-stats">
          <span className="group-stats-label">分组额度</span>
          {groups.map(g => {
            const members = state.accounts.filter(a => a.group === g)
            const remain = members.reduce((sum, a) => {
              const q = latestQuota(state.quotas, a.id)
              return q && q.unit === 'currency' ? sum + Math.max(0, q.total - q.used) : sum
            }, 0)
            return (
              <button key={g} className={`group-stat-chip ${groupFilter === g ? 'active' : ''}`}
                onClick={() => { setGroupFilter(groupFilter === g ? '__all__' : g); setPage(1) }}
                title="点击按此分组筛选">
                {g} · {members.length} 个账户 · 剩余 ¥{remain.toFixed(1)}
              </button>
            )
          })}
          <button className={`group-stat-chip ${groupFilter === '__none__' ? 'active' : ''}`}
            onClick={() => { setGroupFilter(groupFilter === '__none__' ? '__all__' : '__none__'); setPage(1) }}>
            未分组 · {keyAccounts.filter(a => !a.group).length} 个密钥
          </button>
        </div>
      )}

      <div className="panel key-table-wrap">
        <table className="key-table">
          <thead>
            <tr>
              <th style={{ width: 32 }}>
                <input type="checkbox" title="全选本页"
                  checked={pageItems.length > 0 && pageItems.every(a => selectedKeys.has(a.id))}
                  onChange={e => {
                    const next = new Set(selectedKeys)
                    if (e.target.checked) pageItems.forEach(a => next.add(a.id))
                    else pageItems.forEach(a => next.delete(a.id))
                    setSelectedKeys(next)
                  }} />
              </th>
              <th style={{ width: 150 }}>名称</th>
              <th style={{ width: 110 }}>余额</th>
              <th style={{ width: 160 }}>链接地址 (API)</th>
              <th style={{ width: 130 }}>API Key</th>
              <th style={{ width: 118 }}>健康状态</th>
              <th>备注 (用途)</th>
              <th style={{ width: 110 }}>分组</th>
              <th style={{ width: 210 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {pageItems.length === 0 ? (
              <tr><td colSpan={9} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 40 }}>
                {keyAccounts.length === 0 ? '暂无密钥。添加账户时选择「官方 API」模式即可保存。' : '当前筛选下没有密钥'}
              </td></tr>
            ) : pageItems.map(a => {
              const provider = PROVIDER_MAP[a.providerId]
              const plain = revealed[a.id]
              const q = latestQuota(state.quotas, a.id)
              const balance = q ? `${(q.total - q.used).toLocaleString()} ${UNIT_LABEL[q.unit]}` : '未录入'
              const apiUrl = a.apiUrl || provider?.apiBaseUrl || ''
              const adapter = getAdapter(a.providerId)
              return (
                <tr key={a.id}>
                  <td>
                    <input type="checkbox" checked={selectedKeys.has(a.id)} onChange={e => {
                      const next = new Set(selectedKeys)
                      if (e.target.checked) next.add(a.id); else next.delete(a.id)
                      setSelectedKeys(next)
                    }} />
                  </td>
                  <td>
                    <div className="row" style={{ gap: 8 }}>
                      <ProviderLogo provider={provider} size={26} />
                      <div style={{ minWidth: 0 }}>
                        <div className="key-name" title={a.label}>{a.label}</div>
                        <div className="key-sub">{provider?.shortName ?? a.providerId}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div className="row" style={{ gap: 5 }}>
                      {showBalance[a.id] && (
                        <span className="mono" style={{ fontSize: 11.5, minWidth: 42 }}>{balance}</span>
                      )}
                      <button className="icon-btn" title={showBalance[a.id] ? '隐藏余额' : '显示余额（需先解锁保险箱）'}
                        onClick={() => {
                          if (showBalance[a.id]) { setShowBalance(s => ({ ...s, [a.id]: false })); return }
                          if (vaultPwd) { setShowBalance(s => ({ ...s, [a.id]: true })); return }
                          // 未解锁：先走解锁流程，解锁成功后自动显示（见 unlockWith 的 pendingView 消费）
                          setPendingView({ kind: 'balance', id: a.id })
                          setUnlockOpen(true)
                        }}>{showBalance[a.id] ? <EyeOff size={13} /> : <Eye size={13} />}</button>
                      {adapter.supported && <button className="icon-btn" title="刷新官方余额"
                        disabled={refreshing.has(a.id)}
                        onClick={async () => {
                          if (!plain) { notify('请先解锁保险箱'); return }
                          setRefreshing(s => new Set(s).add(a.id))
                          try {
                            const r = await adapter.fetchUsage!(plain)
                            onQuotaFetched(a.id, r.used, r.total, r.unit)
                            notify(`余额已更新：${formatUsageBalance(r)}`)
                          } catch (e: any) { notify(errorText(e, '获取官方余额失败')) }
                          finally { setRefreshing(s => { const n = new Set(s); n.delete(a.id); return n }) }
                        }}><RefreshCw size={13} style={refreshing.has(a.id) ? { animation: 'acm-spin 1s linear infinite' } : undefined} /></button>}
                    </div>
                  </td>
                  <td>
                    {apiUrl
                      ? <button className="key-link" title={apiUrl} onClick={() => { navigator.clipboard.writeText(apiUrl); notify('API 地址已复制') }}>{apiUrl}</button>
                      : <button className="key-link muted" onClick={() => setEditing(a.id)}>+ 添加地址</button>}
                  </td>
                  <td>
                    <div className="row" style={{ gap: 5 }}>
                      <button className="icon-btn" title="查看完整 Key（需先解锁保险箱）"
                        onClick={() => {
                          if (plain) { onAudit('查看Key', a.label); setRevealKeyTarget({ id: a.id, label: a.label, plain }); return }
                          // 未解锁：先走解锁流程，解锁成功后自动打开查看弹窗
                          setPendingView({ kind: 'key', id: a.id })
                          setUnlockOpen(true)
                        }}><Eye size={13} /></button>
                    </div>
                  </td>
                  <td>
                    {(() => { const h = health[a.id]; const busyH = checking.has(a.id); return (
                      <button className={`health-badge ${h ? h.status : 'none'}`} disabled={busyH}
                        title={h ? `${h.message}（${new Date(h.checkedAt).toLocaleString()}）· 点击重新检查` : '点击检查该 Key 是否可用'}
                        onClick={() => void runHealthCheck([a])}>
                        <span className="health-dot" />
                        {busyH ? '检查中…' : h ? `${HEALTH_LABEL[h.status]}${h.status === 'ok' && h.latencyMs ? ` ${h.latencyMs}ms` : ''}` : '未检查'}
                      </button> ) })()}
                  </td>
                  <td><span className="key-note" title={a.note ?? ''}>{a.note ?? '—'}</span></td>
                  <td>{a.group
                    ? <span className="group-chip">{a.group}</span>
                    : <span style={{ fontSize: 12, color: 'var(--text-3)' }}>未分组</span>}</td>
                  <td>
                    <div className="key-actions">
                      <button className="key-action" title="编辑" onClick={() => setEditing(a.id)}><Pencil size={15} /></button>
                      <button className="key-action" title="复制 Key" onClick={async () => {
                        if (!plain) { notify('请先解锁保险箱'); return }
                        const okCopy = await copyKeyWithAutoClear(plain)
                        if (okCopy) { onAudit('复制Key', a.label); notify('API Key 已复制（30 秒后自动清除剪贴板）') }
                        else notify('复制失败，请检查浏览器权限')
                      }}><Copy size={15} /></button>
                      <button className="key-action" title="备份密钥" onClick={() => onRequestBackup([a.id], '备份密钥', '完成备份', () => notify('备份已完成'), true)}><Download size={15} /></button>
                      {adapter.supported && <button className="key-action" title="查询官方用量" onClick={async () => {
                        if (!plain) { notify('请先解锁保险箱'); return }
                        try {
                          const r = await adapter.fetchUsage!(plain)
                          onQuotaFetched(a.id, r.used, r.total, r.unit)
                          notify(r.remaining !== undefined || r.label ? `查询成功：${formatUsageBalance(r)}` : `查询成功：已用 ${r.used.toLocaleString()} ${r.unit}`)
                        } catch (e: any) { notify(errorText(e, '查询失败')) }
                      }}><RefreshCw size={15} /></button>}
                      <HoldToConfirm title={isLocalProvider(a.providerId) ? '删除本地模型' : '删除前必须先备份'} onConfirm={() => onRequestBackup([a.id], '删除前必须备份', '确认删除', () => {
                        onRemoveKeys([a.id])
                        setSelectedKeys(prev => { const n = new Set(prev); n.delete(a.id); return n })
                        setRevealed(prev => { const n = { ...prev }; delete n[a.id]; return n })
                      })} />
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <SelectionBar
        selectedCount={selectedKeys.size} totalOnPage={pageItems.length}
        allSelected={pageItems.length > 0 && pageItems.every(a => selectedKeys.has(a.id))}
        onToggleAll={() => {
          const next = new Set(selectedKeys)
          const allOn = pageItems.every(a => next.has(a.id))
          if (allOn) pageItems.forEach(a => next.delete(a.id)); else pageItems.forEach(a => next.add(a.id))
          setSelectedKeys(next)
        }}
        onClear={() => setSelectedKeys(new Set())}
        actions={<>
          <button className="btn sm" disabled={selectedKeys.size === 0} onClick={() => setToolExportOpen(true)}><Download size={13} /> 导出工具配置</button>
          <button className="btn sm danger" disabled={selectedKeys.size === 0} onClick={() => {
            const ids = Array.from(selectedKeys)
            onRequestBackup(ids, '删除前必须备份', '确认删除', () => {
              onRemoveKeys(ids)
              setRevealed(prev => { const n = { ...prev }; ids.forEach(id => delete n[id]); return n })
              setSelectedKeys(new Set())
            })
          }}><Trash2 size={13} /> 批量删除账户</button>
        </>}
      />
      <Pager total={filtered.length} page={page} pageSize={PAGE_SIZE} onChange={setPage} />

      {editing && (() => {
        const acc = state.accounts.find(a => a.id === editing)
        if (!acc) return null
        return <KeyEditModal
          account={acc} provider={PROVIDER_MAP[acc.providerId]}
          groupSuggestions={groups}
          currentKey={revealed[acc.id]}
          onClose={() => setEditing(null)}
          onSave={(patch, newKey) => {
            onUpdateAccount(acc.id, patch)
            if (newKey !== undefined && newKey !== '') {
              void (async () => {
                if (!vaultPwd) { notify('修改密钥请先解锁保险箱'); return }
                const enc = await encryptSecret(newKey, vaultPwd)
                onUpdateAccount(acc.id, { encryptedKey: enc, keyFingerprint: fingerprint(newKey) })
                setRevealed(s => ({ ...s, [acc.id]: newKey }))
                notify('密钥已更新')
              })()
            }
            setEditing(null)
          }}
          notify={notify}
        />
      })()}

      {toolExportOpen && (() => {
        const items: ToolExportItem[] = []
        const missing: string[] = []
        for (const id of selectedKeys) {
          const a = state.accounts.find(x => x.id === id)
          if (!a) continue
          const plain = revealed[a.id]
          if (plain) items.push({ providerId: a.providerId, label: a.label || PROVIDER_MAP[a.providerId]?.name || a.providerId, apiKey: plain, apiUrl: a.apiUrl || PROVIDER_MAP[a.providerId]?.apiBaseUrl || undefined })
          else missing.push(a.label || a.providerId)
        }
        const doExport = () => {
          const content = toolExportFormat === 'env' ? buildEnvExport(items) : buildJsonExport(items)
          const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
          const url = URL.createObjectURL(blob)
          const link = document.createElement('a')
          link.href = url
          link.download = toolExportFormat === 'env' ? 'ai-keys.env' : 'ai-keys.json'
          link.click()
          URL.revokeObjectURL(url)
          onAudit('导出工具配置', `${items.length} 个 Key · ${toolExportFormat === 'env' ? '.env' : 'JSON'}`)
          notify(`已导出 ${items.length} 个 Key 的配置（明文，请妥善保管）`)
          setToolExportOpen(false)
        }
        return (
          <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) setToolExportOpen(false) }}>
            <div className="modal" style={{ maxWidth: 460 }}>
              <div className="modal-head"><h3 style={{ margin: 0 }}>导出工具配置</h3><button className="icon-btn" onClick={() => setToolExportOpen(false)}><X size={18} /></button></div>
              <div className="modal-body">
                <p style={{ fontSize: 13, lineHeight: 1.6, marginTop: 0 }}>把所选 Key 生成其他工具（如 Cursor、各类 CLI / SDK）能直接使用的配置文件。</p>
                <div className="form-row">
                  <label className="form-label">格式</label>
                  <div className="row" style={{ gap: 8 }}>
                    <button className={`btn sm ${toolExportFormat === 'env' ? 'primary' : ''}`} onClick={() => setToolExportFormat('env')}>.env 环境变量</button>
                    <button className={`btn sm ${toolExportFormat === 'json' ? 'primary' : ''}`} onClick={() => setToolExportFormat('json')}>JSON</button>
                  </div>
                </div>
                <p style={{ fontSize: 12.5, color: '#dc2626', lineHeight: 1.6 }}>⚠️ 导出文件包含明文 Key，请妥善保管，不要发给他人或提交到代码仓库。</p>
                <p style={{ fontSize: 12.5, color: 'var(--text-2)' }}>可导出 {items.length} 个{missing.length ? `；${missing.length} 个未解锁/无 Key 已跳过（${missing.slice(0, 3).join('、')}${missing.length > 3 ? ' 等' : ''}）` : ''}</p>
              </div>
              <div className="modal-foot">
                <button className="btn" onClick={() => setToolExportOpen(false)}>取消</button>
                <button className="btn primary" disabled={items.length === 0} onClick={doExport}><Download size={14} /> 生成并下载</button>
              </div>
            </div>
          </div>
        )
      })()}

      {unlockOpen && !vaultPwd && <UnlockModal
        method={state.settings.unlockMethod} bioAvailable={bioAvailable} bioLabel={bioLabel ?? '生物'}
        onClose={() => { setUnlockOpen(false); setUnlockPwd(''); setPendingView(null) }}
        onPassword={(pwd) => void unlockWith(pwd)}
        onBiometric={async () => {
          const pwd = await resolveBiometricVaultPassword('验证身份以解锁保险箱')
          if (!pwd) { notify(`未通过${bioLabel ?? '生物'}验证，或未配置解锁凭据（请在设置中开启）`); return false }
          await unlockWith(pwd)
          return true
        }}
        busy={busy} pwd={unlockPwd} setPwd={setUnlockPwd}
      />}

      {revealKeyTarget && <KeyRevealModal
        label={revealKeyTarget.label} plain={revealKeyTarget.plain}
        onClose={() => setRevealKeyTarget(null)}
        onCopied={() => notify('API Key 已复制到剪贴板')}
      />}

    </>
  )
}


/** 删除前强制备份弹窗：三种备份方式，只有备份成功且确认后才允许删除 */
function DeleteBackupModal({ state, accountIds, unlockedPwd, title, confirmLabel, backupOnly = false, notify, onClose, onDone }: {
  state: AppState
  accountIds: string[]
  unlockedPwd?: string
  title: string
  confirmLabel: string
  backupOnly?: boolean
  notify: (m: string) => void
  onClose: () => void
  onDone: () => void
}) {
  const [mode, setMode] = useState<KeyBackupMode>('cloud')
  const [format, setFormat] = useState<KeyBackupFormat>('cipher')
  const [fileFormat, setFileFormat] = useState<BackupFileFormat>('json')
  const [pwd, setPwd] = useState(unlockedPwd ?? '')
  const [busy, setBusy] = useState(false)
  const [backup, setBackup] = useState<KeyBackupFile | null>(null)
  const [location, setLocation] = useState('')
  const [backupDir, setBackupDir] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [codeInput, setCodeInput] = useState('')

  const targets = state.accounts.filter(a => accountIds.includes(a.id))
  const names = targets.slice(0, 3).map(a => a.label).join('、') + (targets.length > 3 ? ` 等 ${targets.length} 个` : '')
  const effectiveFormat: KeyBackupFormat = mode === 'notes' ? 'plain' : format
  const needPwd = effectiveFormat === 'plain' && !unlockedPwd

  const resetBackup = (m: KeyBackupMode, f: KeyBackupFormat) => {
    setMode(m); setFormat(f); setBackup(null); setLocation(''); setConfirmed(false); setCodeInput(''); setBackupDir(null)
  }

  const doBackup = async () => {
    setBusy(true)
    try {
      if (effectiveFormat === 'plain') {
        const p = unlockedPwd || pwd
        if (!p) { notify('请先输入主密码'); return }
        if (!(await verifyVault(p))) { notify('主密码错误'); return }
      }
      const b = await buildKeyBackup(state, accountIds, effectiveFormat, unlockedPwd || pwd)
      const r = mode === 'cloud'
        ? await backupToCloud(b, state)
        : mode === 'local'
          ? await backupToLocalFile(b, backupDir, fileFormat)
          : await backupToNotes(b, fileFormat)
      if (!r.ok) { notify(r.error ?? '备份失败'); return }
      setBackup(b)
      setLocation(r.location ?? '')
      notify(mode === 'cloud' ? '密文备份已存入云端' : mode === 'local' ? '备份文件已保存' : '备份内容已就绪，请在备忘录中保存')
    } catch (e) {
      notify((e as Error)?.message ?? '备份失败')
    } finally { setBusy(false) }
  }

  const canDelete = !!backup && confirmed && (mode !== 'notes' || codeInput.trim() === backup.confirmationCode)

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" style={{ maxWidth: 560 }}>
        <div className="modal-head"><h3>{title}</h3><button className="icon-btn" onClick={onClose}><X size={18} /></button></div>
        <div className="modal-body">
          <div className="upd-current">即将处理 <b>{names}</b></div>
          {!backupOnly && <div className="backup-warn"><AlertTriangle size={15} /> 删除后只有 5 秒可撤回。请先完成一份长期备份，否则密钥将无法恢复。</div>}

          <div className="backup-options">
            <button className={`backup-option ${mode === 'cloud' ? 'active' : ''}`} onClick={() => resetBackup('cloud', 'cipher')} disabled={busy}>
              <Cloud size={17} />
              <span><b>密文备份到云</b><small>密钥仍为密文，含保险箱材料，可跨设备恢复</small></span>
            </button>
            <button className={`backup-option ${mode === 'local' ? 'active' : ''}`} onClick={() => resetBackup('local', 'cipher')} disabled={busy}>
              <HardDrive size={17} />
              <span><b>备份到本机文件夹</b><small>桌面下载到「下载」，手机写入 Documents 目录</small></span>
            </button>
            <button className={`backup-option ${mode === 'notes' ? 'active' : ''}`} onClick={() => resetBackup('notes', 'plain')} disabled={busy}>
              <Download size={17} />
              <span><b>备份到本机备忘录</b><small>仅明文；调起系统分享或复制到剪贴板，由你粘贴保存</small></span>
            </button>
          </div>

          {mode === 'local' && (
            <>
              <div className="backup-format">
                <span className="field-label" style={{ margin: '0 8px 0 0' }}>文件格式</span>
                <button className={`btn sm ${format === 'cipher' ? 'primary' : ''}`} onClick={() => resetBackup('local', 'cipher')}><Lock size={13} /> 密文</button>
                <button className={`btn sm ${format === 'plain' ? 'primary' : ''}`} onClick={() => resetBackup('local', 'plain')}><Unlock size={13} /> 明文</button>
              </div>
              <div className="backup-format" style={{ marginTop: 10 }}>
                <span className="field-label" style={{ margin: '0 8px 0 0' }}>文件容器</span>
                {(['json', 'csv', 'txt'] as BackupFileFormat[]).map(f => (
                  <button key={f} className={`btn sm ${fileFormat === f ? 'primary' : ''}`} onClick={() => { setFileFormat(f); setBackup(null); setConfirmed(false) }}>{f.toUpperCase()}</button>
                ))}
              </div>
              {isDesktopApp() && (
                <button className="btn sm" style={{ marginTop: 10 }} onClick={async () => {
                  const dir = await chooseBackupFolder()
                  if (dir) { setBackupDir(dir); setBackup(null); setConfirmed(false); notify(`备份目录：${dir}`) }
                  else notify('已取消选择目录')
                }}><HardDrive size={13} /> {backupDir ? `目录：${backupDir}` : '选择备份文件夹'}</button>
              )}
            </>
          )}

          {needPwd && (
            <div className="backup-pwd">
              <span className="field-label" style={{ margin: 0 }}>主密码（仅用于本次明文备份，不保存）</span>
              <input className="input" type="password" value={pwd} onChange={e => { setPwd(e.target.value); setBackup(null) }} placeholder="输入保险箱主密码" disabled={busy} />
            </div>
          )}

          <button className="btn primary" style={{ width: '100%', marginTop: 16 }} onClick={() => void doBackup()} disabled={busy}>
            {busy ? <RefreshCw size={15} className="spin" /> : <ShieldCheck size={15} />}
            {busy ? '正在备份…' : mode === 'cloud' ? '备份到云' : mode === 'local' ? '生成备份文件' : '生成备忘录备份内容'}
          </button>

          {backup && (
            <div className="backup-success">
              <div className="upd-new ok"><Check size={16} /> 备份已完成</div>
              <div className="hint" style={{ marginTop: 6 }}>{location}</div>
              {mode === 'notes' && (
                <>
                  <div className="backup-code">确认码 {backup.confirmationCode}</div>
                  <input className="input" style={{ marginTop: 8 }} value={codeInput} onChange={e => setCodeInput(e.target.value)} placeholder="请在备忘录保存后输入确认码" />
                </>
              )}
              <label className="backup-confirm">
                <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
                {mode === 'notes' ? '我已将明文备份粘贴到备忘录并保存' : mode === 'local' ? '我已保存备份文件' : '我确认密文备份已存入云端'}
              </label>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>取消</button>
          <button className={`btn ${backupOnly ? 'primary' : 'danger'}`} disabled={!canDelete} onClick={() => onDone()}>
            {backupOnly ? <Check size={15} /> : <Trash2 size={15} />} {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 明文 Key 查看弹窗：显示完整 Key 并可一键复制 */
function KeyRevealModal({ label, plain, onClose, onCopied }: {
  label: string; plain: string; onClose: () => void; onCopied: () => void
}) {
  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" style={{ maxWidth: 480 }}>
        <div className="modal-head"><h3>查看 API Key</h3><button className="icon-btn" onClick={onClose}><X size={18} /></button></div>
        <div className="modal-body">
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 10 }}>{label}</div>
          <div className="secret-reveal" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, fontSize: 13 }}>
            <span className="mono" style={{ wordBreak: 'break-all', lineHeight: 1.6 }}>{plain}</span>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>关闭</button>
          <button className="btn primary" onClick={async () => {
            if (await copyKeyWithAutoClear(plain)) onCopied()
          }}><Copy size={14} /> 复制 Key</button>
        </div>
      </div>
    </div>
  )
}

/** 解锁弹窗：按设置只显示指纹或密码一种方式 */
function UnlockModal({ method, bioAvailable, bioLabel, onClose, onPassword, onBiometric, busy, pwd, setPwd }: {
  method: 'biometric' | 'password'; bioAvailable: boolean; bioLabel: string;
  onClose: () => void; onPassword: (pwd: string) => void; onBiometric: () => Promise<boolean>;
  busy: boolean; pwd: string; setPwd: (v: string) => void
}) {
  const useBio = method === 'biometric' && bioAvailable
  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" style={{ maxWidth: 420 }}>
        <div className="modal-head"><h3>解锁密钥保险箱</h3><button className="icon-btn" onClick={onClose}><X size={18} /></button></div>
        <div className="modal-body">
          {useBio ? (
            <div style={{ textAlign: 'center', padding: '12px 0' }}>
              <div style={{
                width: 72, height: 72, borderRadius: '50%', margin: '0 auto 18px',
                background: 'var(--primary-soft)', color: 'var(--primary)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}><Fingerprint size={36} /></div>
              <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 6 }}>使用{bioLabel}解锁</div>
              <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 22 }}>验证{bioLabel === '人脸' ? 'Face ID' : bioLabel === '指纹' ? 'Touch ID' : bioLabel}后显示全部 API Key 明文</div>
              <button className="btn primary" style={{ width: '100%' }} onClick={onBiometric} disabled={busy}>
                <Fingerprint size={16} /> 验证{bioLabel}
              </button>
            </div>
          ) : (
            <>
              <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 14 }}>输入主密码解锁，解密后本页所有 API Key 将以明文展示。</div>
              <div className="field">
                <label>主密码</label>
                <input className="input" type="password" autoFocus placeholder="输入主密码" value={pwd}
                  onChange={e => setPwd(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && pwd) onPassword(pwd) }} />
              </div>
              <button className="btn primary" style={{ width: '100%' }} onClick={() => onPassword(pwd)} disabled={busy || !pwd}>
                <Unlock size={15} /> 解锁
              </button>
            </>
          )}
        </div>
        <div className="modal-foot"><button className="btn" onClick={onClose}>取消</button></div>
      </div>
    </div>
  )
}


/** 密钥条目编辑弹窗 */
function KeyEditModal({ account, provider, currentKey, onClose, onSave, notify, groupSuggestions }: {
  account: AppState['accounts'][number]; provider: ProviderDefinition; currentKey?: string;
  onClose: () => void;
  onSave: (patch: Partial<AppState['accounts'][number]>, newKey?: string) => void;
  notify: (m: string) => void
  groupSuggestions: string[]
}) {
  const [label, setLabel] = useState(account.label)
  const [apiUrl, setApiUrl] = useState(account.apiUrl ?? '')
  const [noteCat, setNoteCat] = useState<NoteCategory>(() => categoryFromNote(account.note))
  const [noteExtra, setNoteExtra] = useState(() => (account.note ?? '').replace(/^\[[^\]]+\]\s*/, '').split(/[:：]/).slice(1).join(':').trim())
  const [newKey, setNewKey] = useState('')
  const [group, setGroup] = useState(account.group ?? '')
  const [subOn, setSubOn] = useState(!!account.subscription)
  const [subPrice, setSubPrice] = useState(account.subscription ? String(account.subscription.price) : '')
  const [subCycle, setSubCycle] = useState<'monthly' | 'yearly'>(account.subscription?.cycle ?? 'monthly')
  const [subRenewAt, setSubRenewAt] = useState(account.subscription?.renewAt ?? '')

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" style={{ maxWidth: 480 }}>
        <div className="modal-head"><h3>编辑密钥条目</h3><button className="icon-btn" onClick={onClose}><X size={18} /></button></div>
        <div className="modal-body">
          <div className="row" style={{ gap: 10, marginBottom: 16 }}>
            <ProviderLogo provider={provider} size={28} />
            <div style={{ fontSize: 13, fontWeight: 500 }}>{provider.name} · {currentKey ? '已配置密钥' : '未配置'}</div>
          </div>
          <div className="field">
            <label>名称</label>
            <input className="input" value={label} onChange={e => setLabel(e.target.value)} />
          </div>
          <div className="field">
            <label>链接地址 (API)</label>
            <div className="row" style={{ gap: 6 }}>
              <input className="input" placeholder={provider.apiBaseUrl ?? 'https://api.example.com/v1'} value={apiUrl} onChange={e => setApiUrl(e.target.value)} />
              {provider.apiBaseUrl && <button className="btn sm" title="恢复官方地址" onClick={() => setApiUrl(provider.apiBaseUrl!)}>官方</button>}
            </div>
            {provider.apiBaseUrl && <div className="desc">官方地址：{provider.apiBaseUrl}（留空则自动使用此地址）</div>}
          </div>
          <div className="field">
            <label>模型分类</label>
            <select className="select" value={noteCat} onChange={e => setNoteCat(e.target.value as NoteCategory)}>
              {NOTE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <input className="input" style={{ marginTop: 8 }} placeholder="补充说明（可选）" value={noteExtra} onChange={e => setNoteExtra(e.target.value)} />
            <div className="desc">分类决定 AI 助手里该模型的用途与联动</div>
          </div>
          <div className="field">
            <label>保险箱分组（可选）</label>
            <input className="input" list="acm-group-list" placeholder="如：工作 / 个人 / 项目（留空 = 未分组）" value={group} onChange={e => setGroup(e.target.value)} />
            <datalist id="acm-group-list">{groupSuggestions.map(g => <option key={g} value={g} />)}</datalist>
            <div className="desc">按用途分组管理密钥；Key 管理页可按组筛选，并按组统计剩余额度</div>
          </div>
          <div className="field">
            <label>订阅续费（可选）</label>
            <label className="row" style={{ gap: 6, fontSize: 13, alignItems: 'center' }}><input type="checkbox" checked={subOn} onChange={e => setSubOn(e.target.checked)} /> 这是订阅制账户（包月/包年）</label>
            {subOn && (
              <div className="row" style={{ gap: 6, marginTop: 8 }}>
                <input className="input" type="number" min="0" step="0.01" placeholder="价格（元）" value={subPrice} onChange={e => setSubPrice(e.target.value)} style={{ flex: 1 }} />
                <select className="select" value={subCycle} onChange={e => setSubCycle(e.target.value as 'monthly' | 'yearly')}>
                  <option value="monthly">每月</option>
                  <option value="yearly">每年</option>
                </select>
                <input className="input" type="date" value={subRenewAt} onChange={e => setSubRenewAt(e.target.value)} style={{ flex: 1.2 }} title="下次续费日" />
              </div>
            )}
            <div className="desc">填好后会出现在用量页「订阅续费」总览里，临近续费日会收到提醒</div>
          </div>
          <div className="field">
            <label>更换 API Key（留空表示不修改）</label>
            <input className="input" type="password" placeholder="留空保持不变" value={newKey} onChange={e => setNewKey(e.target.value)} />
            <div className="desc">修改密钥需先在主界面解锁保险箱；新密钥将以主密码重新加密。</div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={() => {
            if (!label.trim()) { notify('名称不能为空'); return }
            onSave({ label: label.trim(), apiUrl: apiUrl.trim(), note: buildNote(noteCat, noteExtra), group: group.trim() || undefined, subscription: subOn && Number(subPrice) > 0 && subRenewAt ? { price: Number(subPrice), cycle: subCycle, renewAt: subRenewAt } : undefined }, newKey.trim() || undefined)
          }}>保存</button>
        </div>
      </div>
    </div>
  )
}

function UsageView({ state, notify, onBudget, onAddUsage, onImport, onPriceChange, onDeleteUsage, onProviderBudget, onAccountBudget, onOpenReport, priceAlerts, priceCheckedAt, checkingPrices, onCheckPrices, onAckPriceAlerts }: {
  state: AppState; notify: (m: string) => void; onBudget: (v: number) => void;
  onAddUsage: () => void;
  onDeleteUsage: (ids: string[]) => void;
  onImport: (events: UsageEventInput[]) => void
  onPriceChange: (providerId: string, price: number) => void
  onProviderBudget: (providerId: string, v: number) => void
  onAccountBudget: (accountId: string, v: number) => void
  onOpenReport: () => void
  priceAlerts: PriceChange[]; priceCheckedAt: string | null; checkingPrices: boolean
  onCheckPrices: () => void; onAckPriceAlerts: () => void
}) {
  const [selectedUsage, setSelectedUsage] = useState<Set<string>>(new Set())
  const [rankTab, setRankTab] = useState<'provider' | 'model'>('provider')
  const month = todayISO().slice(0, 7)
  const monthEvents = state.usage.filter(u => u.date.startsWith(month))
  const [usagePage, setUsagePage] = useState(1)
  const USAGE_PAGE_SIZE = 3
  useEffect(() => { setUsagePage(1) }, [monthEvents.length])
  const usageCur = Math.min(usagePage, Math.max(1, Math.ceil(monthEvents.length / USAGE_PAGE_SIZE)))
  const pagedUsage = monthEvents.slice().reverse().slice((usageCur - 1) * USAGE_PAGE_SIZE, usageCur * USAGE_PAGE_SIZE)
  const totalCost = monthEvents.reduce((s, u) => s + u.estimatedCost, 0)
  const totalIn = monthEvents.reduce((s, u) => s + u.inputTokens, 0)
  const totalOut = monthEvents.reduce((s, u) => s + u.outputTokens, 0)
  const budget = state.settings.monthlyBudget
  const budgetPct = budget > 0 ? Math.min(100, Math.round(totalCost / budget * 100)) : 0

  const byDay = useMemo(() => {
    const map: Record<string, number> = {}
    monthEvents.forEach(u => { map[u.date] = (map[u.date] ?? 0) + u.estimatedCost })
    return Object.entries(map).sort((a, b) => a[0].localeCompare(b[0])).slice(-14)
  }, [monthEvents])

  const maxDay = Math.max(...byDay.map(d => d[1]), 0.01)
  const spendByPlatform = monthlySpendByPlatform(state, month)
  const ownedProviders = Array.from(new Set(state.accounts.map(a => a.providerId)))
  const prices = state.settings.unitPrices ?? {}
  const effectivePrices = { ...DEFAULT_UNIT_PRICES, ...prices }
  const rankRows = rankTab === 'provider' ? rankProvidersByValue(state) : rankModelsByValue(state)
  const subSummary = summarizeSubscriptions(state)
  const projectRows = summarizeByProject(state, month)
  const spendFc = forecastMonthSpend(state)

  return (
    <>
      <div className="stats-grid">
        <StatCard icon={<Wallet size={17} />} color="blue" label="本月费用" value={`¥${totalCost.toFixed(2)}`} hint="本地估算" />
        <StatCard icon={<BarChart3 size={17} />} color="green" label="本月 Tokens" value={(totalIn + totalOut).toLocaleString()} hint={`输入 ${totalIn.toLocaleString()} · 输出 ${totalOut.toLocaleString()}`} />
        <StatCard icon={<TrendingUp size={17} />} color="amber" label="预算使用" value={`${budgetPct}%`} hint={`预算 ¥${budget.toFixed(0)}`} />
        <StatCard icon={<CalendarCheck2 size={17} />} color="blue" label="记录天数" value={String(new Set(monthEvents.map(u => u.date)).size)} hint="本月已记录" />
      </div>

      <div className="split">
        <div className="panel" style={{ padding: 18 }}>
          <div className="section-head" style={{ marginTop: 0 }}><h2>费用趋势 <span className="hint">近 14 天</span></h2></div>
          {byDay.length === 0 ? <div style={{ color: 'var(--text-3)', fontSize: 13, padding: '20px 0' }}>暂无数据</div> : (
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 130, paddingTop: 10 }}>
              {byDay.map(([date, cost]) => (
                <div key={date} style={{ flex: 1, textAlign: 'center' }} title={`${date}: ¥${cost.toFixed(2)}`}>
                  <div style={{ background: 'var(--primary)', borderRadius: '4px 4px 0 0', height: `${Math.max(4, cost / maxDay * 96)}px`, marginBottom: 5 }} />
                  <div style={{ fontSize: 9, color: 'var(--text-3)' }}>{date.slice(8)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="panel" style={{ padding: 18 }}>
          <div className="section-head" style={{ marginTop: 0 }}><h2>预算设置</h2></div>
          <div className="field">
            <label>每月预算（元）</label>
            <input className="input" type="number" min="0" step="10" defaultValue={budget}
                   onBlur={e => { const v = Number(e.target.value); if (!isNaN(v) && v >= 0) { onBudget(v); notify('预算已更新') } }} />
          </div>
          <div className="progress" style={{ height: 8 }}><div style={{ width: `${budgetPct}%`, background: budgetPct >= 90 ? 'var(--red)' : 'var(--primary)' }} /></div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: 'var(--text-3)', marginTop: 6 }}>
            <span>已用 ¥{totalCost.toFixed(2)}</span><span>预算 ¥{budget.toFixed(0)}</span>
          </div>
          <button className="btn sm" style={{ marginTop: 12 }} onClick={onOpenReport}>查看月度报告 →</button>
        </div>
      </div>

      <div className="section-head"><h2>按平台消费结构 <span className="hint">本月</span></h2></div>
      <div className="panel" style={{ padding: 18 }}>
        {spendByPlatform.length === 0 ? (
          <div style={{ color: 'var(--text-3)', fontSize: 13 }}>暂无消费数据</div>
        ) : spendByPlatform.map(p => (
          <div key={p.providerId} style={{ marginBottom: 13 }}>
            <div className="row between" style={{ fontSize: 12.5, marginBottom: 6 }}>
              <span style={{ fontWeight: 500 }}>{p.name}</span>
              <span style={{ color: 'var(--text-2)' }}>¥{p.cost.toFixed(2)} · {(p.share * 100).toFixed(0)}%</span>
            </div>
            <div className="progress"><div style={{ width: `${Math.max(2, p.share * 100)}%`, background: 'var(--primary)' }} /></div>
          </div>
        ))}
      </div>

      <div className="section-head"><h2>分平台预算 <span className="hint">本月 · 留空或 0 表示不限；超 90% 会提醒</span></h2></div>
      <div className="panel" style={{ padding: 18 }}>
        {ownedProviders.length === 0 ? (
          <div style={{ color: 'var(--text-3)', fontSize: 13 }}>添加账户后可为各平台单独设置月预算</div>
        ) : Array.from(new Set([...ownedProviders, ...Object.keys(state.settings.providerBudgets ?? {})])).map(pid => {
          const spend = spendByPlatform.find(p => p.providerId === pid)?.cost ?? 0
          const pb = state.settings.providerBudgets?.[pid] ?? 0
          const pct = pb > 0 ? Math.min(100, Math.round(spend / pb * 100)) : 0
          return (
            <div className="settings-row" key={pid}>
              <span style={{ fontSize: 13 }}>{PROVIDER_MAP[pid]?.shortName ?? pid}
                <span style={{ color: 'var(--text-3)', fontSize: 11.5, marginLeft: 8 }}>本月已花 ¥{spend.toFixed(2)}{pb > 0 ? ` · ${pct}%` : ''}</span>
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {pb > 0 && <span className="progress" style={{ width: 90 }}><span style={{ display: 'block', height: '100%', width: `${pct}%`, background: pct >= 100 ? 'var(--red)' : pct >= 90 ? 'var(--amber)' : 'var(--primary)' }} /></span>}
                <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>预算 ¥</span>
                <input className="input" type="number" min="0" step="10" style={{ width: 96 }}
                  defaultValue={pb || ''}
                  placeholder="不限"
                  key={`${pid}-${pb}`}
                  onBlur={e => { const v = Number(e.target.value); if (!isNaN(v) && v >= 0 && v !== pb) { onProviderBudget(pid, v); notify(v > 0 ? '分平台预算已更新' : '已取消该平台预算') } }} />
              </span>
            </div>
          )
        })}
      </div>

      <div className="section-head"><h2>分账户预算 <span className="hint">本月 · 给单个 Key/账户单独设上限；留空或 0 表示不限，超 90% 会提醒</span></h2></div>
      <div className="panel" style={{ padding: 18 }}>
        {state.accounts.length === 0 ? (
          <div style={{ color: 'var(--text-3)', fontSize: 13 }}>添加账户后可为单个账户单独设置月预算</div>
        ) : state.accounts
          .filter(a => (state.settings.accountBudgets?.[a.id] ?? 0) > 0 || monthEvents.some(u => u.accountId === a.id))
          .map(a => {
            const spend = monthEvents.filter(u => u.accountId === a.id).reduce((s, u) => s + u.estimatedCost, 0)
            const ab = state.settings.accountBudgets?.[a.id] ?? 0
            const pct = ab > 0 ? Math.min(100, Math.round(spend / ab * 100)) : 0
            return (
              <div className="settings-row" key={a.id}>
                <span style={{ fontSize: 13 }}>{a.label || PROVIDER_MAP[a.providerId]?.shortName || a.providerId}
                  <span style={{ color: 'var(--text-3)', fontSize: 11.5, marginLeft: 8 }}>{PROVIDER_MAP[a.providerId]?.shortName ?? a.providerId} · 本月已花 ¥{spend.toFixed(2)}{ab > 0 ? ` · ${pct}%` : ''}</span>
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {ab > 0 && <span className="progress" style={{ width: 90 }}><span style={{ display: 'block', height: '100%', width: `${pct}%`, background: pct >= 100 ? 'var(--red)' : pct >= 90 ? 'var(--amber)' : 'var(--primary)' }} /></span>}
                  <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>预算 ¥</span>
                  <input className="input" type="number" min="0" step="10" style={{ width: 96 }}
                    defaultValue={ab || ''}
                    placeholder="不限"
                    key={`${a.id}-${ab}`}
                    onBlur={e => { const v = Number(e.target.value); if (!isNaN(v) && v >= 0 && v !== ab) { onAccountBudget(a.id, v); notify(v > 0 ? '分账户预算已更新' : '已取消该账户预算') } }} />
                </span>
              </div>
            )
          })}
        {state.accounts.length > 0 && state.accounts.every(a => (state.settings.accountBudgets?.[a.id] ?? 0) <= 0 && !monthEvents.some(u => u.accountId === a.id)) && (
          <div style={{ color: 'var(--text-3)', fontSize: 13 }}>本月暂无消费的账户不显示；给账户所在行填预算即可单独管控</div>
        )}
      </div>

      <div className="section-head"><h2>订阅续费 <span className="hint">订阅制账户的固定支出与下次续费日 · 在 API Key 管理里编辑账户填写订阅信息</span></h2></div>
      <div className="panel" style={{ padding: 18 }}>
        {subSummary.rows.length === 0
          ? <div style={{ color: 'var(--text-3)', fontSize: 13 }}>暂无订阅账户。订阅制账户（如包月/包年套餐）在 API Key 管理里编辑该账户，勾选「这是订阅制账户」并填价格、周期和下次续费日，就会汇总到这里。</div>
          : <>
            {subSummary.rows.map(r => (
              <div key={r.accountId} className="row between" style={{ padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
                <span style={{ fontSize: 13.5 }}>{r.label} <span className="hint">{r.platform}</span></span>
                <span style={{ fontSize: 13.5 }}>¥{r.price.toFixed(2)} / {r.cycle === 'monthly' ? '月' : '年'} · 下次续费 {r.nextRenewAt} <b style={{ color: r.daysLeft <= 7 ? 'var(--red)' : r.daysLeft <= 30 ? 'var(--amber, #d97706)' : 'var(--text-3)' }}>{r.daysLeft === 0 ? '今天' : `${r.daysLeft} 天后`}</b></span>
              </div>
            ))}
            <div className="row between" style={{ paddingTop: 10 }}>
              <span style={{ fontSize: 13, color: 'var(--text-2)' }}>每月固定支出合计（年付按月摊销）</span>
              <b>¥{subSummary.monthlyTotal.toFixed(2)}</b>
            </div>
          </>}
      </div>

      <div className="section-head"><h2>性价比榜 <span className="hint">按你的实际用量统计 · ¥/百万 token，越低越划算（样本需 ≥1 万 token）</span></h2>
        <div className="row" style={{ gap: 6 }}>
          <button className={`btn sm ${rankTab === 'provider' ? 'primary' : 'ghost'}`} onClick={() => setRankTab('provider')}>按平台</button>
          <button className={`btn sm ${rankTab === 'model' ? 'primary' : 'ghost'}`} onClick={() => setRankTab('model')}>按模型</button>
        </div>
      </div>
      <div className="panel" style={{ padding: 18 }}>
        {rankRows.length === 0
          ? <div style={{ color: 'var(--text-3)', fontSize: 13 }}>暂无足够样本：某个{rankTab === 'provider' ? '平台' : '模型'}的累计用量达到 1 万 token 后会出现在这里。</div>
          : rankRows.slice(0, 10).map((r, i) => (
            <div key={r.key} className="row between" style={{ padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontSize: 13.5 }}>{i + 1}. {r.name}</span>
              <span style={{ fontSize: 13.5 }}><b>¥{r.perMillion.toFixed(2)}</b> / 百万 token <span className="hint">共 {(r.tokens / 10000).toFixed(1)} 万 token · 花 ¥{r.cost.toFixed(2)}</span></span>
            </div>
          ))}
      </div>

      <div className="section-head"><h2>本月消费预测 <span className="hint">按本月日均速度推算到月底，提前看会不会超预算</span></h2></div>
      <div className="panel" style={{ padding: 18 }}>
        {spendFc.spent <= 0
          ? <div style={{ color: 'var(--text-3)', fontSize: 13 }}>本月暂无消费记录。</div>
          : <div style={{ fontSize: 13.5, lineHeight: 1.9 }}>
              本月已过 {spendFc.daysElapsed}/{spendFc.daysInMonth} 天 · 已花 <b>¥{spendFc.spent.toFixed(2)}</b> · 日均 ¥{spendFc.dailyAvg.toFixed(2)}<br />
              按当前速度，月底预计总消费 <b style={{ fontSize: 15 }}>¥{spendFc.projected.toFixed(2)}</b>
              {state.settings.monthlyBudget > 0 && (
                <> · 月预算 ¥{state.settings.monthlyBudget.toFixed(0)} —— {spendFc.projected > state.settings.monthlyBudget
                  ? <b style={{ color: 'var(--red)' }}>预计超支 ¥{(spendFc.projected - state.settings.monthlyBudget).toFixed(2)}，注意控制</b>
                  : <span style={{ color: '#16a34a' }}>在预算内（预计用 {(spendFc.projected / state.settings.monthlyBudget * 100).toFixed(0)}%）</span>}</>
              )}
            </div>}
      </div>

      <div className="section-head"><h2>按项目汇总 <span className="hint">给用量记录打项目标签后，这里看每个项目花了多少 · 添加用量记录时填写「项目标签」</span></h2></div>
      <div className="panel" style={{ padding: 18 }}>
        {projectRows.length === 0
          ? <div style={{ color: 'var(--text-3)', fontSize: 13 }}>暂无用量记录。</div>
          : projectRows.map(r => (
            <div key={r.project} className="row between" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontSize: 13.5 }}>{r.project} <span className="hint">{r.count} 笔</span></span>
              <span style={{ fontSize: 13 }}>本月 ¥{r.monthCost.toFixed(2)} · 累计 <b>¥{r.totalCost.toFixed(2)}</b> · {(r.tokens / 10000).toFixed(1)} 万 token</span>
            </div>
          ))}
      </div>

      <div className="section-head"><h2>价格动态 <span className="hint">官方参考单价变动订阅 · 每 6 小时自动检查</span></h2></div>
      <div className="panel" style={{ padding: 18 }}>
        <div className="row between" style={{ marginBottom: priceAlerts.length ? 10 : 6 }}>
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
            {priceCheckedAt
              ? `上次检查：${new Date(priceCheckedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`
              : '尚未检查'} · 平台调价时自动记录，涉及你账户的变动会弹窗提醒
          </span>
          <button className="btn sm" disabled={checkingPrices} onClick={onCheckPrices}>{checkingPrices ? '检查中…' : '检查更新'}</button>
        </div>
        {priceAlerts.length === 0 ? (
          <div style={{ color: 'var(--text-3)', fontSize: 13 }}>暂无价格变动</div>
        ) : <>
          {priceAlerts.map((c, i) => (
            <div key={`${c.providerId}-${c.detectedAt}-${i}`} className="settings-row">
              <span style={{ fontSize: 13 }}>{PROVIDER_MAP[c.providerId]?.name ?? c.providerId}
                <span style={{ color: 'var(--text-3)', fontSize: 11.5, marginLeft: 8 }}>{new Date(c.detectedAt).toLocaleDateString('zh-CN')} 检测到</span>
              </span>
              <span style={{ fontSize: 12.5, fontWeight: 500, color: c.newPrice > c.oldPrice ? '#dc2626' : '#16a34a' }}>
                {c.newPrice > c.oldPrice ? '↑ 涨价' : '↓ 降价'} ¥{c.oldPrice} → ¥{c.newPrice} / 单位
              </span>
            </div>
          ))}
          <div style={{ textAlign: 'right', marginTop: 8 }}>
            <button className="btn sm ghost" onClick={onAckPriceAlerts}>全部知道了</button>
          </div>
        </>}
      </div>

      <div className="section-head"><h2>额度单价校准 <span className="hint">用于资源总估值 · 官方参考价 {OFFICIAL_PRICES_AS_OF}</span></h2></div>
      <div className="panel" style={{ padding: 18 }}>
        {ownedProviders.length === 0 ? (
          <div style={{ color: 'var(--text-3)', fontSize: 13 }}>添加账户后可校准对应平台的单价</div>
        ) : (<>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
            <button className="btn sm" onClick={() => {
              let changed = 0
              for (const pid of ownedProviders) {
                const off = officialUnitPrice(pid)
                if (off !== undefined && priceDrifted(effectivePrices[pid] ?? DEFAULT_UNIT_PRICES.default, off)) { onPriceChange(pid, off); changed++ }
              }
              notify(changed ? `已按官方参考价校准 ${changed} 个平台` : '所有平台单价已与官方参考价一致')
            }} title="把已收录平台的单价一键填为官方参考价（不同模型价格差异较大，仅作估值参考）">按官方价自动校准</button>
          </div>
          {ownedProviders.map(pid => { const off = officialUnitPrice(pid); const eff = effectivePrices[pid] ?? DEFAULT_UNIT_PRICES.default; const drift = priceDrifted(eff, off); return (
          <div className="settings-row" key={pid}>
            <span style={{ fontSize: 13 }}>{PROVIDER_MAP[pid]?.shortName ?? pid}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {drift && <span style={{ fontSize: 11.5, color: 'var(--amber, #d97706)' }}>官方参考 ¥{off}</span>}
              {drift && <button className="btn sm ghost" onClick={() => onPriceChange(pid, off!)}>采用</button>}
              <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>元 / {UNIT_LABEL[state.quotas.find(q => q.accountId === state.accounts.find(a => a.providerId === pid)?.id)?.unit ?? 'credit']}</span>
              <input className="input" type="number" min="0" step="0.0001"
                value={eff}
                onChange={e => onPriceChange(pid, Math.max(0, Number(e.target.value)))}
                style={{ width: 100 }} />
            </span>
          </div> ) })}
        </>)}
      </div>

      <div className="section-head"><h2>用量记录 <span className="hint">{monthEvents.length} 条</span></h2></div>
      <SelectionBar
        selectedCount={selectedUsage.size} totalOnPage={pagedUsage.length}
        allSelected={pagedUsage.length > 0 && pagedUsage.every(u => selectedUsage.has(u.id))}
        onToggleAll={() => {
          const next = new Set(selectedUsage)
          const allOn = pagedUsage.every(u => next.has(u.id))
          if (allOn) pagedUsage.forEach(u => next.delete(u.id)); else pagedUsage.forEach(u => next.add(u.id))
          setSelectedUsage(next)
        }}
        onClear={() => setSelectedUsage(new Set())}
        actions={<button className="btn sm danger" onClick={() => {
          onDeleteUsage(Array.from(selectedUsage)); notify(`已删除 ${selectedUsage.size} 条记录`); setSelectedUsage(new Set())
        }}><Trash2 size={13} /> 批量删除</button>}
      />
      <div className="panel">
        <table>
          <thead><tr>
            <th style={{ width: 32 }}><input type="checkbox" title="全选本页"
              checked={pagedUsage.length > 0 && pagedUsage.every(u => selectedUsage.has(u.id))}
              onChange={e => {
                const next = new Set(selectedUsage)
                if (e.target.checked) pagedUsage.forEach(u => next.add(u.id)); else pagedUsage.forEach(u => next.delete(u.id))
                setSelectedUsage(next)
              }} /></th>
            <th>日期</th><th>账户</th><th>模型</th><th>输入 Tokens</th><th>输出 Tokens</th><th>估算费用</th>
          </tr></thead>
          <tbody>
            {monthEvents.length === 0 ? <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 30 }}>暂无记录</td></tr> :
              pagedUsage.map(u => {
                const acc = state.accounts.find(a => a.id === u.accountId)
                return (
                  <tr key={u.id}>
                    <td><input type="checkbox" checked={selectedUsage.has(u.id)} onChange={e => {
                      const next = new Set(selectedUsage)
                      if (e.target.checked) next.add(u.id); else next.delete(u.id)
                      setSelectedUsage(next)
                    }} /></td>
                    <td className="mono">{u.date}</td>
                    <td>{acc?.label ?? '—'}</td>
                    <td className="mono">{u.model ?? '—'}</td>
                    <td className="mono">{u.inputTokens.toLocaleString()}</td>
                    <td className="mono">{u.outputTokens.toLocaleString()}</td>
                    <td>¥{u.estimatedCost.toFixed(3)}</td>
                  </tr>
                )
              })}
          </tbody>
        </table>
      </div>
      <Pager total={monthEvents.length} page={usagePage} pageSize={USAGE_PAGE_SIZE} onChange={setUsagePage} />
      <div style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn sm" onClick={onAddUsage}><Plus size={13} /> 手动添加记录</button>
        <label className="btn sm" style={{ cursor: 'pointer' }}>
          <Download size={13} style={{ transform: 'rotate(180deg)' }} /> 导入 CSV
          <input type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={(e) => {
            const file = e.target.files?.[0]
            if (!file) return
            const reader = new FileReader()
            reader.onload = () => {
              try {
                const events = parseUsageCsv(String(reader.result), state.accounts)
                if (events.length === 0) { notify('未解析到有效记录，请检查 CSV 格式'); return }
                onImport(events)
              } catch (err: any) { notify(err.message ?? 'CSV 解析失败') }
            }
            reader.readAsText(file)
            e.target.value = ''
          }} />
        </label>
        <button className="btn sm ghost" onClick={() => {
          const csv = 'date,account,inputTokens,outputTokens,cost,model\n2026-01-01,我的账户,1000,500,0.15,gpt-4o\n'
          const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a'); a.href = url; a.download = 'usage-template.csv'; a.click()
          URL.revokeObjectURL(url)
          notify('模板已下载')
        }}><Download size={13} /> CSV 模板</button>
        <span style={{ fontSize: 11.5, color: 'var(--text-3)', alignSelf: 'center' }}>列：date, account, inputTokens, outputTokens, cost, model</span>
      </div>
    </>
  )
}

/** 第一步：选择要添加的平台 */
/** 本地模型独立添加页：路径为 Key，网关端口由本机实时探测（只读不可改） */
function LocalAccountFormModal({ provider, sessionPwd, onClose, onSave, notify }: {
  provider: ProviderDefinition; sessionPwd: string;
  onClose: () => void;
  onSave: (account: AppState['accounts'][number], pwd: string) => void;
  notify: (m: string) => void;
}) {
  const [services, setServices] = useState<LocalService[]>([])
  const [selected, setSelected] = useState<LocalService | null>(null)
  const [path, setPath] = useState('')
  const [note, setNote] = useState('')
  const [detecting, setDetecting] = useState(true)
  const [detectErr, setDetectErr] = useState('')
  const [busy, setBusy] = useState(false)
  // 就地输入主密码（无会话解锁/生物识别时）
  const [formPwd, setFormPwd] = useState('')
  const pwdRef = useRef<HTMLInputElement>(null)
  const setPwdFocus = () => pwdRef.current?.focus()
  const needInlinePwd = !sessionPwd && !getBiometricPassword()
  // 从本地服务拉取的已加载模型列表（选择式输入主入口）
  const [availModels, setAvailModels] = useState<string[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsErr, setModelsErr] = useState('')

  const serviceKey = provider.id === 'local-ollama' ? 'ollama'
    : provider.id === 'local-comfyui' ? 'comfyui' : 'lmstudio'
  /** 拉取当前服务的模型列表 */
  const loadModels = async (svc: LocalService) => {
    setModelsLoading(true); setModelsErr('')
    const r = await fetchLocalModels(serviceKey, svc.url)
    setAvailModels(r.models)
    setModelsErr(r.error ?? '')
    setModelsLoading(false)
  }
  // 选中服务变化时拉取模型列表
  useEffect(() => {
    if (selected) void loadModels(selected)
    else { setAvailModels([]); setModelsErr('') }
  }, [selected?.url])

  // 当前弹窗期望的服务类型（用于过滤探测结果，避免把别的本地服务混进来）
  const expectService = provider.id === 'local-ollama' ? 'Ollama'
    : provider.id === 'local-comfyui' ? 'ComfyUI' : ''
  const detect = async () => {
    setDetecting(true); setDetectErr('')
    const r = await detectLocalServices()
    // 按 provider 精确匹配：如添加 Ollama 只显示识别为 Ollama 的服务
    const matched = expectService ? r.services.filter(s => s.service === expectService) : r.services
    setServices(matched)
    setDetectErr(r.error ?? '')
    if (matched.length) setSelected(prev => prev && matched.some(s => s.port === prev.port) ? prev : matched[0])
    else setSelected(null)
    setDetecting(false)
  }
  useEffect(() => { void detect() }, [])

  const submit = async () => {
    if (!selected) { notify('请先选择本机探测到的服务'); return }
    if (!path.trim()) { notify('请选择或输入模型'); return }
    if (!isVaultInitialized()) { notify('请先在「设置 → 安全」创建保险箱'); return }
    // 密码来源：会话解锁 > 生物识别 > 表单内就地输入（不再强制跳转到 Key 管理页解锁）
    const pwd = sessionPwd || getBiometricPassword() || formPwd.trim()
    if (!pwd) { notify('请在下方输入主密码以加密保存'); setPwdFocus(); return }
    setBusy(true)
    try {
      if (!(await verifyVault(pwd))) { notify('主密码错误'); return }
      // Key 值 = 模型路径地址；apiUrl = 探测到的本机网关（不可改）
      const enc = await encryptSecret(path.trim(), pwd)
      const now = new Date().toISOString()
      const capability = detectModelCapability(path.trim())
      const account: AppState['accounts'][number] = {
        id: uid('acc'), providerId: provider.id, label: path.trim().split(/[\\/]/).pop() || provider.shortName,
        mode: 'api', encryptedKey: enc, keyFingerprint: fingerprint(path.trim()),
        apiUrl: selected.url, note: note.trim() || `本地 ${selected.service}`,
        modelCapability: capability.capability,
        createdAt: now, updatedAt: now,
      }
      onSave(account, pwd)
    } catch (e) { notify((e as Error)?.message ?? '保存失败') }
    finally { setBusy(false) }
  }

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal account-form-modal" style={{ maxWidth: 520 }}>
        <div className="modal-head">
          <div className="row" style={{ gap: 10 }}>
            <ProviderLogo provider={provider} size={30} />
            <div>
              <h3 style={{ margin: 0 }}>添加本地模型 · {provider.shortName}</h3>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>网关地址由本机实时探测，不可修改</div>
            </div>
          </div>
          <button className="icon-btn" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="modal-body">
          <div className="form-row">
            <label className="form-label">本机服务（实时探测 · 网关与端口不可改）</label>
            {detecting ? <div className="form-static">正在探测本机服务…</div> : services.length === 0
              ? <div className="form-static" style={{ color: 'var(--red)' }}>
                  {detectErr || (expectService
                    ? `未检测到运行中的 ${expectService} 服务，请先在本机启动${expectService === 'Ollama' ? '（默认端口 11434）' : expectService === 'ComfyUI' ? '（默认端口 8188）' : ''}后点「重新探测」`
                    : '未检测到本机本地模型服务，请确认服务已启动')}
                </div>
              : <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {services.map(s => (
                  <button key={`${s.host}:${s.port}`} className={`backup-option ${selected?.port === s.port ? 'active' : ''}`} onClick={() => setSelected(s)}>
                    <span><b>{s.service}</b><small>{s.url}</small></span>
                  </button>
                ))}
              </div>}
            <button className="btn sm" style={{ marginTop: 8 }} onClick={() => void detect()} disabled={detecting}>重新探测</button>
          </div>
          <div className="form-row" style={{ marginTop: 12 }}>
            <label className="form-label">选择模型
              <span style={{ fontWeight: 400, color: 'var(--text-3)', fontSize: 11 }}>（作为标识加密保存）</span>
            </label>
            {/* 主入口：从服务已加载的模型列表选择（自动标注能力类型） */}
            {availModels.length > 0 ? (
              <select className="select" value={path} onChange={e => setPath(e.target.value)} disabled={busy} style={{ width: '100%' }}>
                <option value="">请选择模型…</option>
                {availModels.map(m => {
                  const cap = detectModelCapability(m)
                  return <option key={m} value={m}>{m}　[{cap.label}]</option>
                })}
              </select>
            ) : modelsLoading ? (
              <div className="me-skeleton-stack" aria-label="正在从本机服务读取模型列表">
                <div className="me-skeleton" style={{ height: 14, width: '72%' }} />
                <div className="me-skeleton" style={{ height: 14, width: '55%', marginTop: 8 }} />
                <div className="me-skeleton" style={{ height: 14, width: '63%', marginTop: 8 }} />
              </div>
            ) : (
              <div className="local-model-hint">
                {modelsErr ? `未能自动读取模型列表：${modelsErr}` : '本机服务暂无可读取的模型列表'}
              </div>
            )}
            {/* 选中模型的能力标注与提示 */}
            {path.trim() && (() => {
              const cap = detectModelCapability(path.trim())
              const hidden = shouldHideFromChat(cap)
              return (
                <div className={`model-cap-hint ${hidden ? 'warn' : ''}`}>
                  <span className="cap-badge">{cap.label}</span>
                  <span>{hidden
                    ? `${cap.reason}识别为「${cap.label}」模型，不能用于 AI 聊天对话；添加后会在聊天列表自动隐藏。`
                    : cap.capability === 'translation'
                      ? '翻译专用模型，可走对话接口但更适合翻译任务。'
                      : cap.capability === 'unknown'
                        ? '未识别类型，默认允许聊天；如实际不能对话请留意。'
                        : '识别为对话模型，可用于 AI 聊天。'}</span>
                </div>
              )
            })()}
            <div className="local-model-actions">
              <button className="btn sm" disabled={busy || modelsLoading} onClick={() => { if (selected) void loadModels(selected) }}>
                {modelsLoading ? '读取中…' : '刷新模型列表'}
              </button>
              <button className="btn sm" disabled={busy} onClick={async () => {
                const picked = await chooseModelFile()
                if (picked) setPath(picked.split(/[\\/]/).pop() || picked)
              }}>浏览本地文件…</button>
            </div>
            {/* 兜底：手动输入 */}
            <input className="input" style={{ marginTop: 8 }} value={path} onChange={e => setPath(e.target.value)}
              placeholder="也可手动输入模型名，如 llama3:latest" disabled={busy} />
            <div className="local-model-note">
              优先从服务已加载的模型中选择；「浏览本地文件」仅取文件名作标识。支持格式：Ollama 用自身管理的模型（如 llama3、qwen2.5:7b）；ComfyUI 支持 .gguf / .safetensors / .ckpt / .bin（需放在 ComfyUI 的 models 目录）；LM Studio 支持 .gguf。App 不直接加载文件，实际调用由本机服务完成。
            </div>
          </div>
          <div className="form-row" style={{ marginTop: 12 }}>
            <label className="form-label">备注（可选）</label>
            <input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="用途说明" disabled={busy} />
          </div>
          {needInlinePwd && (
            <div className="form-row" style={{ marginTop: 12 }}>
              <label className="form-label">主密码 <span className="req">*</span> <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>· 用于加密本次保存，输入后本次会话记住</span></label>
              <input ref={pwdRef} className="input" type="password" value={formPwd} onChange={e => setFormPwd(e.target.value)} placeholder="输入保险箱主密码" disabled={busy} />
            </div>
          )}
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 10, lineHeight: 1.6 }}>
            本地模型仅保存在本机，不参与云同步、备份与导出（路径含本机信息，无跨端意义）。
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={() => void submit()} disabled={busy || !selected}>{busy ? '保存中…' : '添加本地模型'}</button>
        </div>
      </div>
    </div>
  )
}

function PlatformPickerModal({ onClose, onPick }: {
  onClose: () => void; onPick: (providerId: string) => void
}) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<ProviderDefinition['category'] | 'all'>('all')
  const q = query.trim().toLowerCase()
  const matched = PROVIDERS.filter(p =>
    (category === 'all' || p.category === category) &&
    (!q || p.name.toLowerCase().includes(q) || p.shortName.toLowerCase().includes(q) || p.id.includes(q)),
  )
  const grouped = CATEGORY_ORDER
    .map(cat => ({ cat, items: matched.filter(p => p.category === cat) }))
    .filter(g => g.items.length > 0)
  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" style={{ maxWidth: 640 }}>
        <div className="modal-head"><h3>选择平台</h3><button className="icon-btn" onClick={onClose}><X size={18} /></button></div>
        <div className="modal-body">
          <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginBottom: 12 }}>按模型功能分类 · 共 {PROVIDERS.length} 个平台</div>
          <div className="row" style={{ gap: 8, marginBottom: 12 }}>
            <div className="search-wrap" style={{ flex: 1 }}>
              <Search size={14} />
              <input className="input" placeholder="搜索平台名称…" value={query} onChange={e => setQuery(e.target.value)} />
            </div>
          </div>
          <div className="category-chips">
            <button className={`chip ${category === 'all' ? 'active' : ''}`} onClick={() => setCategory('all')}>全部</button>
            {CATEGORY_ORDER.map(cat => (
              <button key={cat} className={`chip ${category === cat ? 'active' : ''}`} onClick={() => setCategory(cat)}>{CATEGORY_LABEL[cat]}</button>
            ))}
          </div>
          <div className="platform-groups">
            {grouped.length === 0 && <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>没有匹配的平台</div>}
            {grouped.map(g => (
              <div className="platform-group" key={g.cat}>
                <div className="platform-group-title"><span className={`cat-dot cat-${g.cat}`} />{CATEGORY_LABEL[g.cat]} <span className="hint">{g.items.length}</span></div>
                <div className="provider-picker" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                  {g.items.map(p => (
                    <button key={p.id} className="provider-opt" onClick={() => onPick(p.id)} title={`添加 ${p.name}`}>
                      <ProviderLogo provider={p} size={30} />
                      <span className="p-name">{p.shortName}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="modal-foot"><button className="btn" onClick={onClose}>取消</button></div>
      </div>
    </div>
  )
}

/** 第二步：填表 —— 平台名(固定) / API链接(只读可跳转) / 备注 / Key+自动余额 */
/** 智能粘贴：粘贴 API Key（可带说明文字）→ 按格式识别平台 → 确认后带着 Key 打开添加账户表单 */
function SmartPasteModal({ onClose, onConfirm }: {
  onClose: () => void
  onConfirm: (providerId: string, key: string) => void
}) {
  const [text, setText] = useState('')
  const [picked, setPicked] = useState('')
  const detection = useMemo(() => detectProviderFromKey(text), [text])
  const key = useMemo(() => extractKey(text), [text])
  useEffect(() => { if (detection) setPicked(detection.providerId) }, [detection?.providerId])
  const candidates = PROVIDERS.filter(p => !p.id.startsWith('local-'))
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <div className="modal-head"><h3 style={{ margin: 0 }}>智能粘贴添加账户</h3><button className="icon-btn" onClick={onClose}><X size={18} /></button></div>
        <div style={{ padding: '4px 18px 18px' }}>
          <p style={{ fontSize: 13, lineHeight: 1.6, marginTop: 0, color: 'var(--text-2)' }}>把 API Key 粘贴进来（带说明文字也没关系），按格式自动识别平台；识别不准可以在下面改选。</p>
          <textarea
            value={text} onChange={e => setText(e.target.value)} rows={3} autoFocus
            placeholder="粘贴 API Key，例如 sk-… / gsk_… / sk-ant-…"
            style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'monospace', fontSize: 12.5 }}
          />
          {text.trim() && !key && <p style={{ fontSize: 12.5, color: 'var(--red)' }}>没识别到像 Key 的内容（需要一段至少 16 位的字母数字串）。</p>}
          {key && (
            <div style={{ marginTop: 10 }}>
              {detection
                ? <p style={{ fontSize: 12.5, margin: 0, color: 'var(--text-2)' }}>识别结果：<b>{PROVIDER_MAP[detection.providerId]?.name ?? detection.providerId}</b>{detection.confidence === 'low' ? '（低置信，请确认）' : ''} · {detection.reason}</p>
                : <p style={{ fontSize: 12.5, margin: 0, color: 'var(--text-2)' }}>这个 Key 的格式没有特征，请手动选择平台：</p>}
              <div className="row" style={{ gap: 8, marginTop: 10, alignItems: 'center' }}>
                <span style={{ fontSize: 13 }}>平台</span>
                <select className="select" value={picked} onChange={e => setPicked(e.target.value)} style={{ flex: 1 }}>
                  <option value="">请选择平台</option>
                  {candidates.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            </div>
          )}
          <div className="row" style={{ gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
            <button className="btn" onClick={onClose}>取消</button>
            <button className="btn primary" disabled={!key || !picked} onClick={() => onConfirm(picked, key)}>下一步：填写账户信息</button>
          </div>
        </div>
      </div>
    </div>
  )
}

function AccountFormModal({ provider, sessionPwd, onClose, onSave, groupSuggestions, initialSecret }: {
  provider: ProviderDefinition; sessionPwd: string;
  onClose: () => void;
  onSave: (data: { account: AppState['accounts'][number]; quota?: QuotaSnapshot; pwd: string }) => void
  groupSuggestions: string[]
  /** 智能粘贴带入的 Key（预填密钥框） */
  initialSecret?: string
}) {
  const [note, setNote] = useState('')
  const [group, setGroup] = useState('')
  const [noteCat, setNoteCat] = useState<NoteCategory>('通用型')
  const [secret, setSecret] = useState(initialSecret ?? '')
  const [balance, setBalance] = useState<string | null>(null)
  // 已获取的剩余额度（结构化保存，提交时生成初始额度快照；label 型结果无快照）
  const [fetchedQuota, setFetchedQuota] = useState<{ total: number; unit: CreditUnit } | null>(null)
  const [fetching, setFetching] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  // 就地输入主密码（无会话解锁/生物识别时）
  const [formPwd, setFormPwd] = useState('')
  const pwdRef = useRef<HTMLInputElement>(null)
  const needInlinePwd = !sessionPwd && !getBiometricPassword()
  const adapter = getAdapter(provider.id)

  const isVoiceCfg = provider.id === 'voice-config'
  // 语音配置(APP)可选服务商（需 API Key 的；system/local 无需 Key，排除）
  const voiceProviderChoices = VOICE_PROVIDERS.filter(p => p.id !== 'system' && p.id !== 'local')
  const [voiceProvider, setVoiceProvider] = useState<string>(voiceProviderChoices[0]?.id ?? 'aliyun')
  const chosenVoice = voiceProviderChoices.find(p => p.id === voiceProvider)

  const apiUrl = provider.apiBaseUrl ?? ''
  // 语音配置：API 链接用所选服务商官方文档；其余用平台默认
  const keyUrl = isVoiceCfg ? (chosenVoice?.docs ?? provider.officialUrl) : (provider.apiKeyUrl ?? provider.usageUrl ?? provider.officialUrl)

  const fetchBalance = async () => {
    setErr('')
    if (!secret.trim()) { setErr('请先输入 API Key'); return }
    if (!adapter.supported) {
      setBalance('该平台无公开余额 API，请在官方页面查看后手动录入')
      return
    }
    setFetching(true)
    try {
      const r = await adapter.fetchUsage!(secret.trim())
      setBalance(formatUsageBalance(r))
      if (r.label) setFetchedQuota(null)
      else if (r.remaining !== undefined) setFetchedQuota({ total: r.remaining, unit: 'currency' })
      else setFetchedQuota({ total: Math.max(0, (r.total ?? r.used) - r.used), unit: r.unit })
    } catch (e: any) { setErr(errorText(e, '获取余额失败')); setBalance(null); setFetchedQuota(null) }
    finally { setFetching(false) }
  }

  const reset = () => { setNote(''); setNoteCat('通用型'); setSecret(''); setBalance(null); setFetchedQuota(null); setErr('') }

  const submit = async () => {
    setErr('')
    if (!secret.trim()) { setErr('请填写 API Key'); return }
    if (!isVaultInitialized()) { setErr('请先在「设置 → 安全」创建保险箱'); return }
    // 密码来源：会话解锁 > 生物识别 > 表单内就地输入（不再强制跳转到 Key 管理页解锁）
    const pwd = sessionPwd || getBiometricPassword() || formPwd.trim()
    if (!pwd) { setErr('请在下方输入主密码以加密保存'); pwdRef.current?.focus(); return }
    setBusy(true)
    try {
      const ok = await verifyVault(pwd)
      if (!ok) { setErr('主密码错误'); return }
      const enc = await encryptSecret(secret.trim(), pwd)
      const fp = fingerprint(secret.trim())
      const now = new Date().toISOString()
      // 已获取的余额生成初始额度快照（若成功获取）
      const quotaTotal = fetchedQuota?.total ?? 0
      const account: AppState['accounts'][number] = {
        id: uid('acc'), providerId: provider.id,
        label: isVoiceCfg ? `${chosenVoice?.short ?? '语音'}（语音配置APP）` : provider.shortName,
        mode: 'api',
        encryptedKey: enc, keyFingerprint: fp, apiUrl: apiUrl || undefined,
        note: isVoiceCfg ? `[语音配置(APP)] ${chosenVoice?.short ?? ''}${note.trim() ? ' · ' + note.trim() : ''}` : buildNote(noteCat, note),
        group: group.trim() || undefined,
        voiceProvider: isVoiceCfg ? voiceProvider : undefined,
        createdAt: now, updatedAt: now,
      }
      const quota: QuotaSnapshot | undefined = quotaTotal > 0 ? {
        id: uid('q'), accountId: account.id, unit: fetchedQuota!.unit, total: quotaTotal, used: 0,
        capturedAt: now, source: 'api' as const,
      } : undefined
      onSave({ account, quota, pwd })
    } catch (e: any) { setErr(e.message ?? '保存失败') }
    finally { setBusy(false) }
  }

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal account-form-modal" style={{ maxWidth: 520 }}>
        <div className="modal-head">
          <div className="row" style={{ gap: 10 }}>
            <ProviderLogo provider={provider} size={30} />
            <div>
              <h3 style={{ margin: 0 }}>添加账户</h3>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>填写下方信息以添加并加密保存</div>
            </div>
          </div>
          <button className="icon-btn" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="modal-body">
          {/* 行1：平台名（固定写死） */}
          <div className="form-row">
            <label className="form-label">平台名称</label>
            <div className="form-static"><ProviderLogo provider={provider} size={22} /> <b>{provider.name}</b><span className="tag gray" style={{ marginLeft: 'auto' }}>固定</span></div>
          </div>
          {/* 行2：API 链接地址（只读可点击直达创建 key 页） */}
          <div className="form-row">
            <label className="form-label">API 链接地址 <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>· 点击前往官方创建 Key</span></label>
            <button className="form-link" onClick={() => { void openExternal(keyUrl); }} title={keyUrl}>
              <span>{isVoiceCfg ? (chosenVoice?.name ?? keyUrl) : (provider.apiBaseUrl || '—')}</span><ExternalLink size={13} />
            </button>
            <div className="form-hint">只读 · 点击上述地址可直达官方 API Key 管理页</div>
          </div>
          {/* 行3：模型分类（语音配置固定，其余写死下拉）+ 可选说明 */}
          <div className="form-row">
            {isVoiceCfg ? (
              <>
                <label className="form-label">语音服务商 <span className="req">*</span></label>
                <select className="select" value={voiceProvider} onChange={e => { setVoiceProvider(e.target.value); setBalance(null) }}>
                  {voiceProviderChoices.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <div className="form-hint" style={{ marginTop: 6 }}>{chosenVoice?.desc}</div>
                <div className="voice-fixed-cat" style={{ marginTop: 10 }}>🔊 语音配置(APP) · 专用于语音朗读/声音克隆</div>
                <input className="input" style={{ marginTop: 8 }} placeholder="备注（可选），例如：我的百炼 Key" value={note} onChange={e => setNote(e.target.value)} />
                <div className="form-hint">此 Key 仅「语音配置」模块使用；AI 聊天不会调用，也不会在聊天模型列表里出现。添加后会自动同步到「语音配置」页。</div>
              </>
            ) : (
              <>
                <label className="form-label">模型分类 <span className="req">*</span> <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>· 决定 AI 助手里该模型的用途与联动</span></label>
                <select className="select" value={noteCat} onChange={e => setNoteCat(e.target.value as NoteCategory)}>
                  {NOTE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <input className="input" style={{ marginTop: 8 }} placeholder="补充说明（可选），例如：日常对话 / 批量生图" value={note} onChange={e => setNote(e.target.value)} />
                <div className="form-hint">分类按该模型的官方真实用途选择；AI 助手将按此分类展示与调用</div>
              </>
            )}
          </div>
          {/* 行3.5：保险箱分组（可选） */}
          <div className="form-row">
            <label className="form-label">保险箱分组（可选）</label>
            <input className="input" list="acm-group-list-add" placeholder="如：工作 / 个人 / 项目（留空 = 未分组）" value={group} onChange={e => setGroup(e.target.value)} />
            <datalist id="acm-group-list-add">{groupSuggestions.map(g => <option key={g} value={g} />)}</datalist>
            <div className="form-hint">按用途分组管理；Key 管理页可按组筛选与统计剩余额度</div>
          </div>
          {/* 行4：API Key 输入（语音配置无需余额） */}
          <div className="form-row">
            <label className="form-label">API Key <span className="req">*</span>
              {provider.id !== 'voice-config' && <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>· 输入后自动获取余额</span>}
            </label>
            <div className="row" style={{ gap: 8 }}>
              <input className="input" style={{ flex: 1 }} type="text" placeholder="粘贴你的 API Key（明文输入）" value={secret} onChange={e => { setSecret(e.target.value); setBalance(null) }} />
              {provider.id !== 'voice-config' && (
                <button className="btn sm" onClick={() => void fetchBalance()} disabled={fetching || !secret.trim()}>
                  <RefreshCw size={13} style={fetching ? { animation: 'acm-spin 1s linear infinite' } : undefined} /> {fetching ? '获取中' : '获取余额'}
                </button>
              )}
            </div>
            {provider.id !== 'voice-config' && (
              <div className={`balance-box ${balance ? 'has' : ''}`}>
                <Wallet size={13} /> {balance ?? '余额未获取（可选，可稍后手动录入）'}
              </div>
            )}
          </div>
          {needInlinePwd && (
            <div className="form-row">
              <label className="form-label">主密码 <span className="req">*</span> <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>· 用于加密本次保存，输入后本次会话记住</span></label>
              <input ref={pwdRef} className="input" type="password" value={formPwd} onChange={e => setFormPwd(e.target.value)} placeholder="输入保险箱主密码" disabled={busy} />
              <div className="form-hint">Key 会加密保存在本机。查看/删除已保存的 Key 仍需解锁保险箱。</div>
            </div>
          )}
          {err && <div className="form-error">{err}</div>}
        </div>
        <div className="modal-foot account-form-foot">
          <button className="btn btn-close" onClick={onClose}>关闭</button>
          <button className="btn btn-reset" onClick={reset}>重置</button>
          <button className="btn btn-add" onClick={() => void submit()} disabled={busy}>{busy ? '添加中…' : '添加'}</button>
        </div>
      </div>
    </div>
  )
}


function VaultModal({ initialized, currentPwd, onClose, onInit, notify }: {
  initialized: boolean
  currentPwd: string
  onClose: () => void
  onInit: (pwd: string) => Promise<void>
  notify: (m: string) => void
}) {
  const [pwd, setPwd] = useState('')
  const [confirm, setConfirm] = useState('')
  const [revealed, setRevealed] = useState(currentPwd)
  const [viewPwd, setViewPwd] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (pwd.length < 6) { notify('主密码至少 6 位'); return }
    if (pwd !== confirm) { notify('两次密码不一致'); return }
    setBusy(true)
    try { await onInit(pwd); onClose() } finally { setBusy(false) }
  }
  /** 重置：仅清空本页内容，不删除保险箱数据 */
  const resetPage = () => {
    setPwd(''); setConfirm(''); setRevealed(''); setViewPwd('')
    notify('已清空本页内容')
  }
  const reveal = async () => {
    const ok = await verifyVault(viewPwd)
    if (!ok) { notify('主密码错误'); return }
    setRevealed(viewPwd); setViewPwd('')
  }

  // 已创建保险箱：明文展示当前密码
  if (initialized) {
    return (
      <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
        <div className="modal" style={{ maxWidth: 440 }}>
          <div className="modal-head"><h3>本地保险箱</h3><button className="icon-btn" onClick={onClose}><X size={18} /></button></div>
          <div className="modal-body">
            <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 10 }}>当前主密码（明文）</div>
            {revealed ? (
              <div className="secret-reveal" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <span className="mono" style={{ fontSize: 15, letterSpacing: 1 }}>{revealed}</span>
                <button className="icon-btn" title="复制主密码" onClick={() => { navigator.clipboard.writeText(revealed); notify('主密码已复制') }}><Copy size={14} /></button>
              </div>
            ) : (
              <div className="field">
                <label>输入主密码以查看</label>
                <div className="row" style={{ gap: 8 }}>
                  <input className="input" type="password" placeholder="输入主密码" value={viewPwd}
                    onChange={e => setViewPwd(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && viewPwd) void reveal() }} />
                  <button className="btn sm primary" onClick={() => void reveal()} disabled={!viewPwd}>查看</button>
                </div>
              </div>
            )}
          </div>
          <div className="modal-foot">
            <button className="btn danger" style={{ marginRight: 'auto' }} onClick={resetPage}>重置</button>
            <button className="btn" onClick={onClose}>关闭</button>
          </div>
        </div>
      </div>
    )
  }

  // 未创建保险箱：创建密码页
  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" style={{ maxWidth: 440 }}>
        <div className="modal-head"><h3>创建本地保险箱</h3><button className="icon-btn" onClick={onClose}><X size={18} /></button></div>
        <div className="modal-body">
          <div className="field"><label>设置主密码（至少 6 位）</label><input className="input" type="text" value={pwd} onChange={e => setPwd(e.target.value)} /></div>
          <div className="field"><label>确认主密码</label><input className="input" type="text" value={confirm} onChange={e => setConfirm(e.target.value)} /></div>
        </div>
        <div className="modal-foot">
          <button className="btn danger" style={{ marginRight: 'auto' }} onClick={resetPage}>重置</button>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={submit} disabled={busy}>创建</button>
        </div>
      </div>
    </div>
  )
}

/** 额度录入 / 更新模态框 */
function QuotaModal({ account, provider, existing, defaultUnit, onClose, onSave }: {
  account: AppState['accounts'][number]; provider: ProviderDefinition; existing?: AppState['quotas'][number];
  defaultUnit?: CreditUnit;
  onClose: () => void;
  onSave: (q: { unit: CreditUnit; used: number; total: number; resetAt?: string; source: QuotaSnapshot['source'] }) => void
}) {
  const [unit, setUnit] = useState<CreditUnit>(existing?.unit ?? defaultUnit ?? 'credit')
  const [total, setTotal] = useState(existing ? String(existing.total) : '')
  const [used, setUsed] = useState(existing ? String(existing.used) : '0')
  const [resetAt, setResetAt] = useState(existing?.resetAt?.slice(0, 10) ?? '')
  const totalNum = Number(total), usedNum = Number(used)
  const valid = total !== '' && !isNaN(totalNum) && totalNum >= 0 && !isNaN(usedNum) && usedNum >= 0
  const pct = valid && totalNum > 0 ? Math.min(100, Math.round(usedNum / totalNum * 100)) : 0

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" style={{ maxWidth: 460 }}>
        <div className="modal-head">
          <h3>{existing ? '更新额度' : '录入额度'}</h3>
          <button className="icon-btn" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="modal-body">
          <div className="row" style={{ gap: 10, marginBottom: 16 }}>
            <ProviderLogo provider={provider} size={28} />
            <div style={{ fontSize: 13, fontWeight: 500 }}>{account.label} · {provider.name}</div>
          </div>
          <div className="field-row">
            <div className="field">
              <label>单位</label>
              <select className="select" value={unit} onChange={e => setUnit(e.target.value as CreditUnit)}>
                {(Object.keys(UNIT_LABEL) as CreditUnit[]).map(u => <option key={u} value={u}>{UNIT_LABEL[u]}</option>)}
              </select>
            </div>
            <div className="field">
              <label>重置/到期日（可选）</label>
              <input className="input" type="date" value={resetAt} onChange={e => setResetAt(e.target.value)} />
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label>总额度</label>
              <input className="input" type="number" min="0" placeholder="如 100" value={total} onChange={e => setTotal(e.target.value)} />
            </div>
            <div className="field">
              <label>已使用</label>
              <input className="input" type="number" min="0" placeholder="如 20" value={used} onChange={e => setUsed(e.target.value)} />
            </div>
          </div>
          {valid && totalNum > 0 && (
            <div style={{ background: 'var(--panel-2)', borderRadius: 8, padding: 12 }}>
              <div className="row between" style={{ fontSize: 12.5, marginBottom: 8 }}>
                <span style={{ color: 'var(--text-2)' }}>剩余 <b style={{ color: 'var(--text)' }}>{Math.max(0, totalNum - usedNum).toLocaleString()} {UNIT_LABEL[unit]}</b></span>
                <span className={`tag ${pct >= 90 ? 'red' : pct >= 70 ? 'amber' : 'green'}`}>已用 {pct}%</span>
              </div>
              <div className="progress"><div style={{ width: `${Math.max(pct, 2)}%`, background: pct >= 90 ? 'var(--red)' : pct >= 70 ? 'var(--amber)' : 'var(--green)' }} /></div>
            </div>
          )}
          <div className="desc" style={{ marginTop: 10 }}>来源：手动录入 {existing ? `· 上次更新 ${existing.capturedAt.slice(0, 10)}` : ''}</div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={!valid} onClick={() => onSave({
            unit, used: usedNum, total: totalNum,
            resetAt: resetAt ? new Date(`${resetAt}T23:59:59`).toISOString() : undefined,
            source: 'manual',
          })}>保存</button>
        </div>
      </div>
    </div>
  )
}

/** 用量记录添加模态框 */
function UsageModal({ accounts, projectSuggestions: projSug, onClose, onSave }: {
  accounts: AppState['accounts'];
  projectSuggestions?: string[];
  onClose: () => void;
  onSave: (e: UsageEventInput) => void
}) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [date, setDate] = useState(todayISO())
  const [inputTokens, setInputTokens] = useState('0')
  const [outputTokens, setOutputTokens] = useState('0')
  const [estimatedCost, setEstimatedCost] = useState('0')
  const [model, setModel] = useState('')
  const [project, setProject] = useState('')
  const valid = !!accountId && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    [inputTokens, outputTokens, estimatedCost].every(v => v !== '' && !isNaN(Number(v)) && Number(v) >= 0)

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" style={{ maxWidth: 480 }}>
        <div className="modal-head"><h3>添加用量记录</h3><button className="icon-btn" onClick={onClose}><X size={18} /></button></div>
        <div className="modal-body">
          {accounts.length === 0 ? (
            <div style={{ color: 'var(--text-3)', fontSize: 13 }}>请先添加一个账户后再录入用量。</div>
          ) : (
            <>
              <div className="field-row">
                <div className="field">
                  <label>账户</label>
                  <select className="select" value={accountId} onChange={e => setAccountId(e.target.value)}>
                    {accounts.map(a => <option key={a.id} value={a.id}>{a.label} · {PROVIDER_MAP[a.providerId]?.shortName ?? a.providerId}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label>日期</label>
                  <input className="input" type="date" value={date} onChange={e => setDate(e.target.value)} />
                </div>
              </div>
              <div className="field-row">
                <div className="field">
                  <label>输入 Tokens</label>
                  <input className="input" type="number" min="0" value={inputTokens} onChange={e => setInputTokens(e.target.value)} />
                </div>
                <div className="field">
                  <label>输出 Tokens</label>
                  <input className="input" type="number" min="0" value={outputTokens} onChange={e => setOutputTokens(e.target.value)} />
                </div>
              </div>
              <div className="field-row">
                <div className="field">
                  <label>估算费用（元）</label>
                  <input className="input" type="number" min="0" step="0.001" value={estimatedCost} onChange={e => setEstimatedCost(e.target.value)} />
                </div>
                <div className="field">
                  <label>模型（可选）</label>
                  <input className="input" placeholder="如 gpt-4o" value={model} onChange={e => setModel(e.target.value)} />
                </div>
              </div>
              <div className="field">
                <label>项目标签（可选）</label>
                <input className="input" list="acm-project-list" placeholder="如：短视频项目 / 客户 A（用量页可按项目汇总）" value={project} onChange={e => setProject(e.target.value)} />
                <datalist id="acm-project-list">{(projSug ?? []).map(p => <option key={p} value={p} />)}</datalist>
              </div>
              <div className="desc">费用为本地估算，以平台官方账单为准。</div>
            </>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={!valid} onClick={() => onSave({
            accountId, date,
            inputTokens: Number(inputTokens), outputTokens: Number(outputTokens),
            estimatedCost: Number(estimatedCost), model: model.trim() || undefined,
            project: project.trim() || undefined,
          })}>保存记录</button>
        </div>
      </div>
    </div>
  )
}

/** 数据导入确认模态框：选择覆盖或合并 */
/** 导出格式选择弹窗 */
function ExportModal({ state, onClose, onExport }: {
  state: AppState; onClose: () => void; onExport: (format: ExportFormat, dir?: string) => void
}) {
  const [dir, setDir] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const options: { fmt: ExportFormat; icon: React.ReactNode; title: string; desc: string; tag?: string }[] = [
    { fmt: 'json', icon: <Download size={18} />, title: 'JSON 完整备份', tag: '推荐',
      desc: `全部数据（${state.accounts.length} 账户 / ${state.quotas.length} 额度 / ${state.usage.length} 用量），可完整导回，不含密钥` },
    { fmt: 'accounts-csv', icon: <KeyRound size={18} />, title: '账户 CSV',
      desc: `平台、名称、模式、API 地址、备注（${state.accounts.length} 条），Excel 可直接打开，不含密钥` },
    { fmt: 'quotas-csv', icon: <Wallet size={18} />, title: '额度 CSV',
      desc: '每个账户最新额度（单位/总额/已用/重置日），可导回匹配账户' },
    { fmt: 'usage-csv', icon: <BarChart3 size={18} />, title: '用量 CSV',
      desc: `日期、账户、输入/输出 Tokens、费用、模型（${state.usage.length} 条），可导回` },
  ]
  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" style={{ maxWidth: 520 }}>
        <div className="modal-head"><h3>选择导出格式</h3><button className="icon-btn" onClick={onClose}><X size={18} /></button></div>
        <div className="modal-body">
          {/* 保存位置选择（桌面端可选目录，Web 端走浏览器下载） */}
          <div className="export-dir-box">
            <div className="row" style={{ gap: 8 }}>
              <span style={{ fontSize: 12.5, color: 'var(--text-2)', flex: 1 }}>保存位置</span>
              {isDesktopApp() && <button className="btn sm" disabled={picking} onClick={async () => {
                setPicking(true)
                try {
                  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke?: (cmd: string) => Promise<string | null> } }
                  const invoke = w.__TAURI_INTERNALS__?.invoke
                  if (!invoke) return
                  const picked = await invoke('choose_save_dir')
                  if (picked) setDir(picked)
                } catch { /* 用户取消或不支持 */ }
                finally { setPicking(false) }
              }}><Download size={13} style={{ transform: 'rotate(180deg)' }} /> {picking ? '选择中…' : '选择文件夹'}</button>}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 6, wordBreak: 'break-all' }}>
              {dir ? `将保存到：${dir}` : (isDesktopApp() ? '未选择 → 使用系统默认下载目录' : '浏览器下载 → 由浏览器决定保存位置')}
            </div>
            {dir && <button className="btn sm ghost" style={{ marginTop: 6 }} onClick={() => setDir(null)}>清除，改回默认位置</button>}
          </div>
          <div className="provider-picker" style={{ gridTemplateColumns: '1fr', maxHeight: 'none', gap: 8 }}>
            {options.map(o => (
              <button key={o.fmt} className="provider-opt" style={{ padding: 13, alignItems: 'flex-start' }} onClick={() => onExport(o.fmt, dir ?? undefined)}>
                <span style={{ color: 'var(--primary)', marginTop: 2 }}>{o.icon}</span>
                <div style={{ textAlign: 'left', flex: 1 }}>
                  <div className="p-name">{o.title}{o.tag && <span className="tag green" style={{ marginLeft: 8, fontSize: 10 }}>{o.tag}</span>}</div>
                  <div className="desc" style={{ marginTop: 4 }}>{o.desc}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
        <div className="modal-foot"><button className="btn" onClick={onClose}>取消</button></div>
      </div>
    </div>
  )
}

/** CSV 导入预览弹窗：显示解析结果，确认后追加 */
function CsvImportModal({ preview, current, onClose, onImport }: {
  preview: CsvImportPreview; current: AppState; onClose: () => void; onImport: (count: number) => void
}) {
  const title = preview.kind === 'accounts' ? '账户' : preview.kind === 'quotas' ? '额度' : '用量'
  const count = preview.kind === 'accounts'
    ? preview.accounts.accounts.length
    : preview.kind === 'quotas'
      ? preview.quotas.quotas.length
      : preview.events.length
  const rows: string[][] = preview.kind === 'accounts'
    ? preview.accounts.accounts.slice(0, 8).map(a => [a.label, PROVIDER_MAP[a.providerId]?.shortName ?? a.providerId, MODE_LABEL[a.mode], a.note ?? ''])
    : preview.kind === 'quotas'
      ? preview.quotas.quotas.slice(0, 8).map(q => [current.accounts.find(a => a.id === q.accountId)?.label ?? q.accountId, UNIT_LABEL[q.unit], String(q.total), String(q.used)])
      : preview.events.slice(0, 8).map(e => [e.date, current.accounts.find(a => a.id === e.accountId)?.label ?? e.accountId, String(e.inputTokens), String(e.outputTokens), `¥${e.estimatedCost}`])
  const heads = preview.kind === 'accounts' ? ['名称', '平台', '模式', '备注']
    : preview.kind === 'quotas' ? ['账户', '单位', '总额', '已用']
      : ['日期', '账户', '输入', '输出', '费用']
  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" style={{ maxWidth: 560 }}>
        <div className="modal-head"><h3>导入{title} CSV</h3><button className="icon-btn" onClick={onClose}><X size={18} /></button></div>
        <div className="modal-body">
          <div style={{ fontSize: 13, marginBottom: 12 }}>识别到 <b>{count}</b> 条{title}记录，将追加到现有数据（不会删除已有内容）：</div>
          {count === 0 ? (
            <div style={{ color: 'var(--text-3)', fontSize: 12.5, padding: 20, textAlign: 'center' }}>未解析到有效数据行，请检查表头格式</div>
          ) : (
            <div style={{ maxHeight: 260, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
              <table className="key-table" style={{ fontSize: 12 }}>
                <thead><tr>{heads.map(h => <th key={h}>{h}</th>)}</tr></thead>
                <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
              </table>
            </div>
          )}
          {count > 8 && <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 8 }}>仅预览前 8 条，共 {count} 条</div>}
          {preview.kind === 'accounts' && preview.accounts.unknownProviders.length > 0 && (
            <div style={{ fontSize: 11.5, color: 'var(--amber)', marginTop: 8 }}>未识别平台：{preview.accounts.unknownProviders.join('、')}（将按原 id 保存）</div>
          )}
          {preview.kind === 'quotas' && preview.quotas.unmatched.length > 0 && (
            <div style={{ fontSize: 11.5, color: 'var(--amber)', marginTop: 8 }}>未匹配账户：{preview.quotas.unmatched.slice(0, 5).join('、')}{preview.quotas.unmatched.length > 5 ? '…' : ''}（这些行已跳过）</div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={count === 0} onClick={() => onImport(count)}>确认导入 {count} 条</button>
        </div>
      </div>
    </div>
  )
}

/** 第三方 API 服务清单导入：预览 + 主密码加密入库 */
function ServiceImportModal({ entries, current, sessionPwd, onClose, onImport }: {
  entries: ServiceEntry[]; current: AppState; sessionPwd: string; onClose: () => void;
  onImport: (accounts: AppState['accounts'], quotas: QuotaSnapshot[], pwd: string) => void
}) {
  const [selected, setSelected] = useState<Set<number>>(() => new Set(entries.map((_, i) => i)))
  const [pwd, setPwd] = useState(sessionPwd || getBiometricPassword() || '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const known = new Set(current.accounts.map(a => `${a.providerId}|${a.label}`))
  const dupCount = entries.filter(e => known.has(`${e.providerId}|${e.label}`)).length

  const maskKey = (k: string) => k.length > 12 ? `${k.slice(0, 6)}…${k.slice(-4)}` : (k ? '••••' : '（空）')

  const doImport = async () => {
    setErr('')
    if (!isVaultInitialized()) { setErr('请先在「设置 → 安全」创建保险箱，再导入含密钥的清单'); return }
    if (!pwd) { setErr('请输入主密码用于加密密钥'); return }
    setBusy(true)
    try {
      const ok = await verifyVault(pwd)
      if (!ok) { setErr('主密码错误'); return }
      const now = new Date().toISOString()
      const accounts: AppState['accounts'] = []
      const quotas: QuotaSnapshot[] = []
      for (const i of selected) {
        const e = entries[i]
        if (!e.plainKey) continue // 空密钥跳过（如本地服务可能无需密钥）
        const enc = await encryptSecret(e.plainKey, pwd)
        const accId = uid('acc')
        accounts.push({
          id: accId, providerId: e.providerId, label: e.label, mode: 'api',
          encryptedKey: enc, keyFingerprint: fingerprint(e.plainKey),
          apiUrl: e.apiBase || undefined, note: e.note,
          createdAt: now, updatedAt: now,
        })
        if (e.quota) {
          quotas.push({
            id: uid('q'), accountId: accId, unit: 'currency',
            total: e.quota.total, used: 0,
            capturedAt: now, source: 'import',
          })
        }
      }
      onImport(accounts, quotas, pwd)
    } catch (e: any) { setErr(e.message ?? '导入失败') }
    finally { setBusy(false) }
  }

  const toggle = (i: number) => setSelected(prev => {
    const next = new Set(prev); if (next.has(i)) next.delete(i); else next.add(i); return next
  })

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" style={{ maxWidth: 660 }}>
        <div className="modal-head"><h3>导入 API 服务清单</h3><button className="icon-btn" onClick={onClose}><X size={18} /></button></div>
        <div className="modal-body">
          <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginBottom: 10 }}>
            识别到 <b>{entries.length}</b> 个服务（含密钥）。请选择要导入的项，密钥将用主密码 <b>AES-256-GCM 加密</b>后仅存本机。
          </div>
          {dupCount > 0 && <div style={{ fontSize: 11.5, color: 'var(--amber)', marginBottom: 8 }}>{dupCount} 项与现有账户重名，将自动跳过。</div>}
          <div style={{ maxHeight: 280, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
            <table className="key-table" style={{ fontSize: 12 }}>
              <thead><tr><th style={{ width: 34 }}></th><th>名称 / 用途</th><th>平台</th><th>API Key</th><th>额度</th></tr></thead>
              <tbody>
                {entries.map((e, i) => {
                  const p = PROVIDER_MAP[e.providerId]
                  const isDup = known.has(`${e.providerId}|${e.label}`)
                  return (
                    <tr key={i} style={{ opacity: isDup ? 0.5 : 1 }} onClick={() => !isDup && toggle(i)}>
                      <td><input type="checkbox" checked={selected.has(i) && !isDup} disabled={isDup} onChange={() => toggle(i)} onClick={ev => ev.stopPropagation()} /></td>
                      <td><div style={{ fontWeight: 500 }}>{e.label}</div><div style={{ color: 'var(--text-3)', fontSize: 11 }}>{e.note} · {e.model}</div></td>
                      <td>{p?.shortName ?? e.name}</td>
                      <td className="mono" style={{ fontSize: 11 }}>{maskKey(e.plainKey)}</td>
                      <td>{e.quota ? `¥${e.quota.total}` : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="field" style={{ marginTop: 14 }}>
            <label>主密码（用于加密密钥{isVaultInitialized() ? '' : ' · 保险箱尚未创建'}）</label>
            <input className="input" type="text" placeholder="输入主密码" value={pwd} onChange={e => setPwd(e.target.value)} />
          </div>
          {err && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 8 }}>{err}</div>}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={busy || selected.size === 0} onClick={() => void doImport()}>
            {busy ? '加密导入中…' : `安全导入 ${selected.size} 项`}
          </button>
        </div>
      </div>
    </div>
  )
}

function ImportModal({ incoming, current, onClose, onImport }: {
  incoming: AppState; current: AppState; onClose: () => void; onImport: (mode: 'replace' | 'merge') => void
}) {
  const newIds = incoming.accounts.filter(a => !current.accounts.some(c => c.id === a.id)).length
  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" style={{ maxWidth: 480 }}>
        <div className="modal-head"><h3>导入数据</h3><button className="icon-btn" onClick={onClose}><X size={18} /></button></div>
        <div className="modal-body">
          <div className="field">
            <label>导入方式</label>
            <div className="provider-picker" style={{ gridTemplateColumns: '1fr', maxHeight: 'none' }}>
              <button className="provider-opt" style={{ padding: 14 }} onClick={() => onImport('merge')}>
                <RefreshCw size={18} style={{ color: 'var(--primary)' }} />
                <div style={{ textAlign: 'left' }}>
                  <div className="p-name">合并（推荐）</div>
                  <div className="desc" style={{ marginTop: 4 }}>保留当前数据，追加 {newIds} 个新账户；相同 id 不重复</div>
                </div>
              </button>
              <button className="provider-opt" style={{ padding: 14 }} onClick={() => onImport('replace')}>
                <Trash2 size={18} style={{ color: 'var(--red)' }} />
                <div style={{ textAlign: 'left' }}>
                  <div className="p-name">覆盖</div>
                  <div className="desc" style={{ marginTop: 4 }}>清空当前全部数据，仅保留备份内容（不可撤销）</div>
                </div>
              </button>
            </div>
          </div>
        </div>
        <div className="modal-foot"><button className="btn" onClick={onClose}>取消</button></div>
      </div>
    </div>
  )
}


/** 通用分页控件（每页 3 条），各列表页复用 */
function Pager({ total, page, pageSize, onChange }: {
  total: number; page: number; pageSize: number; onChange: (p: number) => void
}) {
  if (total <= pageSize) return null
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const cur = Math.min(page, pages)
  return (
    <div className="keys-pagination">
      <span>共 {total} 条 · 第 {cur}/{pages} 页</span>
      <div className="row" style={{ gap: 6 }}>
        <button className="btn sm" disabled={cur <= 1} onClick={() => onChange(Math.max(1, cur - 1))}>上一页</button>
        {Array.from({ length: pages }, (_, i) => i + 1).map(n => (
          <button key={n} className={`btn sm ${n === cur ? 'primary' : ''}`} onClick={() => onChange(n)}>{n}</button>
        ))}
        <button className="btn sm" disabled={cur >= pages} onClick={() => onChange(Math.min(pages, cur + 1))}>下一页</button>
      </div>
    </div>
  )
}

/** 批量选择操作条：显示选中数、全选本页、清空、自定义批量操作 */
function SelectionBar({ selectedCount, totalOnPage, allSelected, onToggleAll, onClear, actions }: {
  selectedCount: number; totalOnPage: number; allSelected: boolean;
  onToggleAll: () => void; onClear: () => void; actions?: React.ReactNode
}) {
  if (totalOnPage === 0 && selectedCount === 0) return null
  return (
    <div className="selection-bar">
      <label className="selection-all" title="全选/取消本页">
        <input type="checkbox" checked={allSelected} onChange={onToggleAll} /> 全选本页
      </label>
      <span className="selection-count">已选 <b>{selectedCount}</b> 项</span>
      {selectedCount > 0 && (
        <>
          {actions}
          <button className="btn sm ghost" onClick={onClear}>清空选择</button>
        </>
      )}
    </div>
  )
}

/** 开关组件 */
function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  // 果冻动画：null=静态，'on'/'off'=正在向对应方向滑动
  const [anim, setAnim] = useState<'on' | 'off' | null>(null)
  const prevChecked = useRef(checked)
  useEffect(() => {
    if (prevChecked.current !== checked) {
      setAnim(checked ? 'on' : 'off')
      prevChecked.current = checked
      const t = window.setTimeout(() => setAnim(null), 360)
      return () => window.clearTimeout(t)
    }
  }, [checked])
  return (
    <button
      role="switch" aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`jelly-toggle ${checked ? 'is-on' : ''}`}
      aria-label={checked ? '关闭' : '开启'}
    >
      <span className={`jelly-dot ${anim ? `anim-${anim}` : (checked ? 'static-on' : 'static-off')}`} />
    </button>
  )
}

/** 设置分组容器 */
function SettingsSection({ title, desc, icon: Icon, tone = 'indigo', children }: {
  title: string; desc?: string; icon?: typeof Settings; tone?: 'indigo' | 'green' | 'amber' | 'blue' | 'red'; children: React.ReactNode
}) {
  return (
    <section className="set-card">
      <div className="set-card-head">
        {Icon && <span className={`set-card-icon ${tone}`}><Icon size={17} /></span>}
        <div className="set-card-heading">
          <h3>{title}</h3>
          {desc && <p>{desc}</p>}
        </div>
      </div>
      <div className="set-card-body">{children}</div>
    </section>
  )
}

/** 设置行：标题 + 说明 + 控件 */
function SettingsRow({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="settings-row">
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500 }}>{title}</div>
        {desc && <div className="settings-row-desc" style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 3, lineHeight: 1.5 }}>{desc}</div>}
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  )
}

/** 设置中心 */
function SettingsView({ state, onChange, notify, onOpenVault, onClear, onChangePassword, onResetVault, onBioAvailable, onBioUnlock, bioLabel, sessionPwd, cloudUser, syncing, syncError, lastSyncAt, onLogin, onLogout, onSync, onCheckUpdate, auditEntries, onClearAudit, onImportBackup }: {
  state: AppState
  onChange: (patch: Partial<AppState['settings']>) => void
  notify: (m: string) => void
  auditEntries: AppState['audit']
  onClearAudit: () => void
  onImportBackup: (state: AppState) => void
  onOpenVault: () => void
  onClear: () => void
  onChangePassword: (oldPwd: string, newPwd: string) => Promise<void>
  onResetVault: () => void
  onBioAvailable: boolean
  onBioUnlock: () => void
  bioLabel: string
  sessionPwd: string
  cloudUser: CloudUser | null
  syncing: boolean
  syncError: string | null
  lastSyncAt: string | null
  onLogin: () => void
  onLogout: () => void
  onSync: () => void
  onCheckUpdate: () => void
}) {
  const s = state.settings
  const [confirmClear, setConfirmClear] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [pwdOpen, setPwdOpen] = useState(false)
  const [oldPwd, setOldPwd] = useState('')
  const [newPwd, setNewPwd] = useState('')
  const [confirmPwd, setConfirmPwd] = useState('')
  const [pwdBusy, setPwdBusy] = useState(false)
  const [bioSwitchOpen, setBioSwitchOpen] = useState(false)
  const [bioSwitchPwd, setBioSwitchPwd] = useState('')
  const [bioSwitchBusy, setBioSwitchBusy] = useState(false)
  const [setTab, setSetTab] = useState<'general' | 'data' | 'security'>('general')
  // ---- 完整数据备份（导出/导入 JSON 文件） ----
  const backupInputRef = useRef<HTMLInputElement>(null)
  const [pendingImport, setPendingImport] = useState<Extract<ParseBackupResult, { ok: true }> | null>(null)
  const doExportBackup = () => {
    const blob = new Blob([buildBackup(state, APP_VERSION)], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `ai-credit-manager-backup-${todayISO()}.json`
    link.click()
    URL.revokeObjectURL(url)
    notify('完整备份已导出（包含全部数据；密钥为加密密文）')
  }
  const onBackupFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    const r = parseBackup(await f.text())
    if (!r.ok) { notify(r.error); return }
    setPendingImport(r)
  }
  // ---- 提醒通知（系统通知） ----
  const np = notifyPrefsOf(s)
  const [notifyPerm, setNotifyPerm] = useState<NotificationPermissionState>('prompt')
  useEffect(() => { void getNotificationPermission().then(setNotifyPerm) }, [])
  const patchNotify = (patch: Partial<typeof np>) => onChange({ notify: { ...np, ...patch } })
  const onToggleNotifyEnabled = async (v: boolean) => {
    if (!v) { patchNotify({ enabled: false }); return }
    const perm = await requestNotificationPermission()
    setNotifyPerm(perm)
    if (perm === 'denied') notify('通知权限被拒绝，请到系统设置里允许本应用发送通知')
    if (perm === 'unsupported') notify('当前平台不支持系统通知')
    patchNotify({ enabled: true })
  }
  const onTestNotification = async () => {
    let perm = await getNotificationPermission()
    if (perm !== 'granted') { perm = await requestNotificationPermission(); setNotifyPerm(perm) }
    if (perm !== 'granted') { notify('未获得通知权限，无法发送测试通知'); return }
    const ok = await showNotification('AI 积分管家', '这是一条测试通知，提醒功能工作正常。', 'acm-test')
    notify(ok ? '测试通知已发送，请留意系统通知' : '当前平台不支持系统通知')
  }
  // ---- 桌面外壳（仅 Tauri 桌面端）：开机自启开关 ----
  const desktopShell = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  const shortcutMod = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform ?? '') ? '⌘' : 'Ctrl'
  const [autostart, setAutostart] = useState<boolean | null>(null)
  useEffect(() => {
    if (!desktopShell) return
    const w = window as unknown as { __TAURI_INTERNALS__?: { invoke?: (c: string, a?: Record<string, unknown>) => Promise<unknown> } }
    void w.__TAURI_INTERNALS__?.invoke?.('autostart_is_enabled').then(v => setAutostart(!!v)).catch(() => setAutostart(null))
  }, [desktopShell])
  const onToggleAutostart = async (v: boolean) => {
    const w = window as unknown as { __TAURI_INTERNALS__?: { invoke?: (c: string, a?: Record<string, unknown>) => Promise<unknown> } }
    try { await w.__TAURI_INTERNALS__?.invoke?.('autostart_set', { enabled: v }); setAutostart(v) }
    catch { notify('设置开机自启失败，请重试') }
  }
  // ---- 本地统一网关（仅桌面端） ----
  const [gwStatus, setGwStatus] = useState<GatewayStatusInfo | null>(null)
  const [gwBusy, setGwBusy] = useState(false)
  const refreshGw = async () => { try { setGwStatus(await gatewayStatus()) } catch { setGwStatus(null) } }
  useEffect(() => { if (desktopShell) void refreshGw() }, [desktopShell])
  const gwStartFlow = async () => {
    if (!sessionPwd) { notify('请先解锁保险箱，再开启网关（需要解密各账户的 Key 来注册路由）'); return }
    setGwBusy(true)
    try {
      let tok = s.gatewayToken
      if (!tok) { tok = genGatewayToken(); onChange({ gatewayToken: tok }) }
      const routes = await buildGatewayRoutes(state, sessionPwd)
      const models = Object.keys(routes).length
      if (!models) { notify('没有可注册的模型：需要已配 Key、且平台在引擎目录里的账户'); setGwBusy(false); return }
      await gatewaySetRoutes(routes)
      const msg = await gatewayStart(s.gatewayPort || 8787, tok)
      notify(`${msg} · 已注册 ${models} 个模型`)
      await refreshGw()
    } catch (e) { notify(`开启网关失败：${(e as Error)?.message ?? e}`) }
    setGwBusy(false)
  }
  const gwStopFlow = async () => {
    setGwBusy(true)
    try { await gatewayStop(); notify('网关已停止，内存中的 Key 路由已清除') } catch { /* 忽略 */ }
    await refreshGw()
    setGwBusy(false)
  }
  // ---- 全局快捷键自定义（桌面端）：组合存 settings，App 壳下发 Tauri 动态注册 ----
  const [recording, setRecording] = useState<'ai' | 'mini' | null>(null)
  const accelAi = s.shortcutAi ?? 'CommandOrControl+Shift+A'
  const accelMini = s.shortcutMini ?? 'CommandOrControl+Shift+M'
  const fmtAccel = (a: string) => a.split('+').map(p => (p === 'CommandOrControl' ? shortcutMod : p)).join('+')
  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation()
      if (e.key === 'Escape') { setRecording(null); return }
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return // 只按了修饰键，继续等主键
      const mods: string[] = []
      if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl')
      if (e.altKey) mods.push('Alt')
      if (e.shiftKey) mods.push('Shift')
      if (mods.length === 0) { notify('组合键需至少带一个修饰键（Ctrl/⌘/Alt/Shift）'); return }
      let key = e.key
      if (key === ' ') key = 'Space'
      else if (key.length === 1) key = key.toUpperCase()
      else if (/^f\d{1,2}$/i.test(key)) key = key.toUpperCase()
      else { notify(`主键「${key}」暂不支持，请用字母、数字、空格或 F 键`); return }
      const accel = [...mods, key].join('+')
      if ((recording === 'ai' ? accelMini : accelAi) === accel) { notify('与另一个快捷键冲突，换个组合'); return }
      onChange(recording === 'ai' ? { shortcutAi: accel } : { shortcutMini: accel })
      setRecording(null)
      notify(`已设为 ${fmtAccel(accel)}`)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, accelAi, accelMini])
  const [devices, setDevices] = useState<DeviceRecord[]>(() => loadDevices())

  // 本地模型服务：检测物理内存 → 档位（Web/手机端检测失败用手动覆盖档位）
  const [memGb, setMemGb] = useState(0)
  useEffect(() => { let alive = true; void getSystemMemoryGb().then(g => { if (alive) setMemGb(g) }); return () => { alive = false } }, [])
  const memTier: MemoryTier = s.memoryTierOverride ?? memoryToTier(memGb)
  const memDetected = memGb > 0
  // 手机客户端没有本机服务概念：「本地模型服务」整段不渲染（判定与 App 壳 isPhone 一致）
  const phoneShell = isNativeApp() || (typeof location !== 'undefined' && (new URLSearchParams(location.search).get('preview') === 'phone' || location.hash.includes('preview=phone')))

  // 各服务实时运行状态（null=未检测/非桌面端，字符串=运行中的地址，''=未运行）
  const [serviceStatus, setServiceStatus] = useState<Partial<Record<LocalServiceKey, string | null>>>({})
  const [managedKeys, setManagedKeys] = useState<Partial<Record<LocalServiceKey, boolean>>>({})
  const [busyKey, setBusyKey] = useState<LocalServiceKey | null>(null)
  const refreshServiceStatus = useCallback(() => {
    void Promise.all(LOCAL_SERVICE_KEYS.map(async k => [k, await checkLocalService(k), await isServiceAppManaged(k)] as const))
      .then(rows => {
        setServiceStatus(Object.fromEntries(rows.map(r => [r[0], r[1]])))
        setManagedKeys(Object.fromEntries(rows.map(r => [r[0], r[2]])))
      })
  }, [])
  useEffect(() => { refreshServiceStatus() }, [refreshServiceStatus])

  /** 启动服务后台进程（不打开 GUI 窗口）；启动后轮询状态 */
  const onStartService = async (key: LocalServiceKey) => {
    setBusyKey(key)
    try {
      const r = await startLocalService(key)
      notify(r.message)
      if (r.ok) {
        let tries = 0
        const poll = window.setInterval(() => {
          void checkLocalService(key).then(addr => {
            if (addr) {
              setServiceStatus(prev => ({ ...prev, [key]: addr }))
              setManagedKeys(prev => ({ ...prev, [key]: true }))
              window.clearInterval(poll)
            } else if (++tries >= 15) window.clearInterval(poll) // 最多等 ~30s（ComfyUI 首次加载较慢）
          })
        }, 2000)
      }
    } finally { setBusyKey(null) }
  }

  /** 停止由本 App 启动的服务进程（不碰用户手动启动的服务） */
  const onStopService = async (key: LocalServiceKey) => {
    setBusyKey(key)
    try {
      const r = await stopLocalService(key)
      notify(r.message)
      if (r.ok) {
        setServiceStatus(prev => ({ ...prev, [key]: null }))
        setManagedKeys(prev => ({ ...prev, [key]: false }))
      }
    } finally { setBusyKey(null) }
  }

  /** 切换本地服务开关：8G 互斥（开新服务自动停旧服务释放内存）；开启拉起进程，关闭停止端口进程 */
  const onToggleLocalService = async (key: LocalServiceKey) => {
    const plan = planServiceToggle(s, key, memTier)
    if (!plan) return
    const { next, stopKeys, enabled } = plan
    onChange({ localServices: next })
    const name = key === 'ollama' ? 'Ollama' : key === 'comfyui' ? 'ComfyUI' : 'LM Studio'
    // 互斥：先停掉被挤掉的旧服务（关自己的情况留给下方 else 分支统一处理）
    for (const oldKey of stopKeys) {
      if (oldKey === key) continue
      const r = await stopServiceByPort(oldKey)
      setServiceStatus(prev => ({ ...prev, [oldKey]: '' }))
      setManagedKeys(prev => ({ ...prev, [oldKey]: false }))
      notifyLocalServiceChanged(oldKey, false)
      const oldName = oldKey === 'ollama' ? 'Ollama' : oldKey === 'comfyui' ? 'ComfyUI' : 'LM Studio'
      if (r.ok) notify(`已关闭 ${oldName} 以释放内存（${r.message}）`)
    }
    if (enabled) {
      // 开启：若端口已有服务在跑则直接复用，否则拉起进程（LM Studio 无 CLI，跳过）
      const already = await checkLocalService(key)
      if (already) {
        setServiceStatus(prev => ({ ...prev, [key]: already }))
        notify(`${name} 服务已在运行，已直接启用（${already}）`)
      } else if (key !== 'lmstudio') {
        const r = await startLocalService(key)
        notify(`${name}：${r.message}`)
        if (r.ok) {
          let tries = 0
          const poll = window.setInterval(() => {
            void checkLocalService(key).then(addr => {
              if (addr) { setServiceStatus(prev => ({ ...prev, [key]: addr })); window.clearInterval(poll) }
              else if (++tries >= 15) window.clearInterval(poll)
            })
          }, 2000)
        }
      } else {
        notify(`${name} 无 CLI 后台启动方式，请在 LM Studio 应用内手动开启本地服务器`)
      }
    } else {
      // 关闭：停止端口上的进程（含外部启动的），真正释放端口与内存
      const r = await stopServiceByPort(key)
      notify(`${name}：${r.ok ? r.message : `停止失败：${r.message}`}`)
      setServiceStatus(prev => ({ ...prev, [key]: '' }))
      setManagedKeys(prev => ({ ...prev, [key]: false }))
    }
    notifyLocalServiceChanged(key, enabled)
  }

  /** 切换到指纹解锁：验证主密码后保存到本机，再更新设置 */
  const enableBio = async () => {
    setBioSwitchBusy(true)
    try {
      const ok = await verifyVault(bioSwitchPwd)
      if (!ok) { notify('主密码错误，未切换'); return }
      saveBiometricPassword(bioSwitchPwd)
      void bindVaultPasswordNative(bioSwitchPwd)
      onChange({ unlockMethod: 'biometric' })
      setBioSwitchOpen(false)
      setBioSwitchPwd('')
      notify('已切换为指纹解锁')
    } finally { setBioSwitchBusy(false) }
  }

  return (
    <>
      <div className="set-hero">
        <div className="set-hero-mark"><Settings size={26} /></div>
        <div className="set-hero-text">
          <h2>设置中心</h2>
          <p>管理你的账户、偏好与数据安全 · 所有设置仅保存在此设备</p>
        </div>
        <div className="set-hero-badges">
          <span className={`set-badge ${cloudUser ? 'on' : ''}`}><Cloud size={13} /> {cloudUser ? '云同步已开启' : '仅本机存储'}</span>
          <span className="set-badge">v{APP_VERSION}</span>
        </div>
      </div>

      <nav className="set-tabs">
        <button className={setTab === 'general' ? 'active' : ''} onClick={() => setSetTab('general')}><Palette size={15} /> 偏好设置</button>
        <button className={setTab === 'data' ? 'active' : ''} onClick={() => setSetTab('data')}><Database size={15} /> 账户与数据</button>
        <button className={setTab === 'security' ? 'active' : ''} onClick={() => setSetTab('security')}><ShieldCheck size={15} /> 安全隐私</button>
      </nav>

      <div className="set-content" key={setTab}>
        {setTab === 'general' && <>
          <SettingsSection title="外观设计" desc="界面风格与动态效果" icon={Palette} tone="indigo">
            <SettingsRow title="主题" desc="深色模式护眼省电；跟随系统时随系统外观自动切换">
              <div className="seg-control">
                {([['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']] as const).map(([v, label]) => (
                  <button key={v} className={`seg-btn ${(s.theme ?? 'system') === v ? 'active' : ''}`} onClick={() => onChange({ theme: v })}>{label}</button>
                ))}
              </div>
            </SettingsRow>
            <SettingsRow title="动态效果" desc="抽屉滑入、卡片渐入、光斑浮动等动效">
              <Toggle checked={s.uiMotion !== false} onChange={v => onChange({ uiMotion: v })} />
            </SettingsRow>
          </SettingsSection>

          <SettingsSection title="AI 行为" desc="对话推理与思考偏好，全局生效" icon={Sparkles} tone="indigo">
            <SettingsRow title="AI 思考模式" desc="开启后 AI 对话默认深度推理（答案更严谨，但更慢、消耗更高）；仍可在聊天框单独调整等级。文档问答等模块同步生效。">
              <Toggle checked={!!s.thinkingMode} onChange={v => onChange({ thinkingMode: v })} />
            </SettingsRow>
            <SettingsRow title="AI 记忆" desc="开启后，AI 在任何会话里都会带上全部历史会话的近期上下文，能记住你之前聊过的内容；关闭则每个会话互相独立。开启会多消耗一些 token。">
              <Toggle checked={!!s.aiMemory} onChange={v => onChange({ aiMemory: v })} />
            </SettingsRow>
          </SettingsSection>

          <SettingsSection title="AI 助手工具栏" desc="AI 助手右上角工具按钮逐个开关（悬停按钮可看名称）；关掉的按钮不在页面上显示" icon={Wrench} tone="indigo">
            {([
              ['autoSpeak', '自动朗读'],
              ['voiceCall', '语音通话'],
              ['chatSearch', '搜索对话'],
              ['chatExport', '导出对话'],
              ['myData', '引用我的数据'],
              ['compare', '多模型对比'],
              ['sessions', '会话列表'],
              ['clearChat', '清空对话'],
            ] as const).map(([key, label]) => (
              <SettingsRow key={key} title={label}>
                <Toggle checked={s.aiToolbar?.[key] !== false} onChange={v => onChange({ aiToolbar: { ...(s.aiToolbar ?? {}), [key]: v } })} />
              </SettingsRow>
            ))}
          </SettingsSection>

          {!phoneShell && (<SettingsSection title="本地模型服务" desc="App 内按需启用，不影响系统服务与其他软件" icon={HardDrive} tone="green">
            <div className="local-mem-info">
              <span className="local-mem-badge">
                {memDetected ? `已检测物理内存 ${memGb.toFixed(1)} GB` : '未获取到系统内存（请在下方选择档位）'}
              </span>
              <span className="local-mem-tier">当前档位：{memTier}G · 最多同时开启 {maxServicesForTier(memTier)} 个</span>
            </div>
            <div className="local-mem-advice">{tierAdvice(memTier)}</div>
            {!memDetected && (
              <div className="local-mem-override">
                <span>内存档位：</span>
                <select className="select" style={{ width: 110 }} value={memTier}
                  onChange={e => onChange({ memoryTierOverride: Number(e.target.value) as MemoryTier })}>
                  <option value={8}>8G 及以下</option>
                  <option value={16}>16G 左右</option>
                  <option value={32}>16G 以上</option>
                </select>
              </div>
            )}
            {LOCAL_SERVICE_KEYS.map(key => {
              const label = key === 'ollama' ? 'Ollama' : key === 'comfyui' ? 'ComfyUI' : 'LM Studio'
              const enabled = isServiceEnabled(s, key)
              const status = serviceStatus[key]
              const running = typeof status === 'string' && status.length > 0
              const managed = !!managedKeys[key]
              return (
                <div className="local-service-row" key={key}>
                  <div className="local-service-main">
                    <div className="local-service-title">
                      <span>允许 App 使用 {label}</span>
                      <span className={`local-status-badge ${enabled && running ? 'running' : ''}`}>
                        {!enabled ? '已停用' : status === undefined || status === null ? '未检测' : running ? (managed ? '运行中 · App启动' : '运行中 · 外部') : '未运行'}
                      </span>
                    </div>
                    <div className="local-service-desc">
                      {!enabled
                        ? '已停用：端口进程已停止、内存已释放。打开开关将重新启动服务。'
                        : running
                          ? `服务地址 ${status} · ${managed ? '由本 App 启动' : '由你或其他软件启动'}`
                          : '本机后台服务未启动，打开开关或点「启动」将拉起服务进程（不开图形界面）'}
                    </div>
                  </div>
                  <div className="local-service-actions">
                    {enabled && !running && (
                      <button className="btn sm" disabled={busyKey === key}
                        onClick={() => void onStartService(key)} title="仅启动后台服务进程，不打开 GUI">
                        {busyKey === key ? '处理中…' : '启动'}
                      </button>
                    )}
                    {enabled && running && managed && (
                      <button className="btn sm" disabled={busyKey === key}
                        onClick={() => void onStopService(key)} title="停止由本 App 启动的进程">
                        {busyKey === key ? '处理中…' : '停止'}
                      </button>
                    )}
                    {enabled && running && <button className="btn sm" onClick={refreshServiceStatus} title="刷新运行状态">刷新</button>}
                    <Toggle checked={enabled} onChange={() => void onToggleLocalService(key)} />
                  </div>
                </div>
              )
            })}
            <div className="local-mem-note">
              「允许 App 使用」开启会拉起服务进程，关闭会停止该服务端口上的进程（含其他软件启动的）并释放内存；「启动/停止」单独管理服务进程（不开图形界面、不改系统自启）。LM Studio 无 CLI 后台启动方式，需在其应用内手动开启。
            </div>
          </SettingsSection>)}

          <SettingsSection title="通用" desc="提醒与预警行为" icon={Settings} tone="indigo">
            <SettingsRow title="签到提醒" desc="在看板与侧栏显示 AI Agent 工具今日待签到数量">
              <Toggle checked={s.checkinReminder} onChange={v => onChange({ checkinReminder: v })} />
            </SettingsRow>
            <SettingsRow title="耗尽预警阈值" desc={`额度预计剩余不超过 ${s.alertDays} 天时计入"即将耗尽"`}>
              <select className="select" style={{ width: 90 }} value={s.alertDays} onChange={e => onChange({ alertDays: Number(e.target.value) })}>
                {[1, 3, 7, 14, 30].map(d => <option key={d} value={d}>{d} 天</option>)}
              </select>
            </SettingsRow>
            <SettingsRow title="默认额度单位" desc="新账户录入额度时的预选单位">
              <select className="select" style={{ width: 110 }} value={s.defaultUnit} onChange={e => onChange({ defaultUnit: e.target.value as CreditUnit })}>
                {(Object.keys(UNIT_LABEL) as CreditUnit[]).map(u => <option key={u} value={u}>{UNIT_LABEL[u]}</option>)}
              </select>
            </SettingsRow>
            <SettingsRow title="每月预算" desc="人民币，超出 90% 时提示">
              <input className="input" type="number" min="0" step="10" value={s.monthlyBudget}
                     onChange={e => onChange({ monthlyBudget: Math.max(0, Number(e.target.value)) })}
                     style={{ width: 100 }} />
            </SettingsRow>
          </SettingsSection>

          <SettingsSection title="提醒通知" desc="通过系统通知提醒签到、到期、额度告急与预算" icon={Bell} tone="amber">
            <SettingsRow title="开启系统通知" desc={notifyPerm === 'granted' ? '通知权限已获得' : notifyPerm === 'denied' ? '通知权限被拒绝，请到系统设置中开启' : notifyPerm === 'unsupported' ? '当前平台不支持系统通知' : '开启时将请求系统通知权限'}>
              <Toggle checked={np.enabled} onChange={(v) => void onToggleNotifyEnabled(v)} />
            </SettingsRow>
            {np.enabled && <>
              <SettingsRow title="每日签到提醒" desc="到达设定时间后，当天仍有未签到工具时提醒；安卓端关掉 App 也会定时提醒">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input className="input" type="time" value={np.checkinTime} onChange={e => patchNotify({ checkinTime: e.target.value || '09:00' })} style={{ width: 108 }} />
                  <Toggle checked={np.checkin} onChange={v => patchNotify({ checkin: v })} />
                </div>
              </SettingsRow>
              <SettingsRow title="到期提醒" desc={`订阅/额度在 ${s.alertDays} 天内到期时提醒`}>
                <Toggle checked={np.expiry} onChange={v => patchNotify({ expiry: v })} />
              </SettingsRow>
              <SettingsRow title="额度告急提醒" desc="按当前用量预测，账户额度即将耗尽时提醒">
                <Toggle checked={np.forecast} onChange={v => patchNotify({ forecast: v })} />
              </SettingsRow>
              <SettingsRow title="预算提醒" desc="本月花费达到预算 90% 以及超支时提醒">
                <Toggle checked={np.budget} onChange={v => patchNotify({ budget: v })} />
              </SettingsRow>
              <SettingsRow title="低余额提醒" desc="账户余额低于阈值时提醒（余额由自动巡检与手动刷新更新）">
                <Toggle checked={np.lowBalance} onChange={v => patchNotify({ lowBalance: v })} />
              </SettingsRow>
              <SettingsRow title="低余额阈值（元）" desc="货币额度账户的剩余额度低于此值时触发低余额提醒">
                <input className="input" type="number" min="0" step="1" value={s.lowBalanceThreshold ?? 10}
                       onChange={e => onChange({ lowBalanceThreshold: Math.max(0, Number(e.target.value)) })}
                       style={{ width: 100 }} />
              </SettingsRow>
              <SettingsRow title="消费异常提醒" desc="某账户单日花费远超近 7 天日均时提醒（防 Key 盗刷/程序跑飞）">
                <Toggle checked={np.anomaly} onChange={v => patchNotify({ anomaly: v })} />
              </SettingsRow>
              <SettingsRow title="月度报告推送" desc="进入新月份后推一条上月消费摘要（总消费、最高平台、环比），每月只推一次">
                <Toggle checked={np.monthlyReport} onChange={v => patchNotify({ monthlyReport: v })} />
              </SettingsRow>
              <SettingsRow title="测试通知" desc="立即发送一条测试通知，确认系统能收到">
                <button className="btn sm" onClick={() => void onTestNotification()}>发送测试</button>
              </SettingsRow>
            </>}
          </SettingsSection>

          {desktopShell && <SettingsSection title="桌面端" desc="菜单栏常驻、全局快捷键与开机自启（仅桌面客户端）" icon={Monitor} tone="indigo">
            <SettingsRow title="应用图标显示" desc="仅菜单栏：不在 Dock 显示；仅 Dock：无菜单栏图标，关闭主窗口即退出应用；迷你窗打开后无操作且鼠标移开约 5 秒会自动收起">
              <div style={{ display: 'flex', gap: 6 }}>
                {([['both', '两者都显示'], ['dock', '仅 Dock'], ['menubar', '仅菜单栏']] as const).map(([v, label]) => (
                  <button key={v} className={`btn sm ${((s.iconDisplay ?? 'both') === v) ? 'primary' : ''}`} onClick={() => onChange({ iconDisplay: v })}>{label}</button>
                ))}
              </div>
            </SettingsRow>
            <SettingsRow title="开机自启（登录系统后常驻菜单栏）" desc="开启后开机自动启动，点菜单栏图标打开迷你窗">
              {autostart === null
                ? <span style={{ fontSize: 12, color: 'var(--text-3)' }}>不可用</span>
                : <Toggle checked={autostart} onChange={(v) => void onToggleAutostart(v)} />}
            </SettingsRow>
            <SettingsRow title="全局快捷键" desc="关闭后两个组合键都不再生效（托盘图标与迷你窗不受影响）">
              <Toggle checked={s.shortcutsEnabled ?? true} onChange={v => onChange({ shortcutsEnabled: v })} />
            </SettingsRow>
            <SettingsRow title="快捷键：呼出 AI 助手" desc="在任何应用中按下即可呼出主窗口并打开 AI 助手；点按钮后按新组合录制">
              <button className="btn sm" onClick={() => setRecording('ai')}>{recording === 'ai' ? '请按下组合键…（Esc 取消）' : fmtAccel(accelAi)}</button>
            </SettingsRow>
            <SettingsRow title="快捷键：菜单栏迷你窗" desc="点菜单栏图标也可弹出速览；关闭主窗口后应用仍常驻，退出请用托盘菜单">
              <button className="btn sm" onClick={() => setRecording('mini')}>{recording === 'mini' ? '请按下组合键…（Esc 取消）' : fmtAccel(accelMini)}</button>
            </SettingsRow>
            {(s.shortcutAi || s.shortcutMini) && <SettingsRow title="恢复默认快捷键" desc="回到 ⌘/Ctrl+Shift+A（AI 助手）与 ⌘/Ctrl+Shift+M（迷你窗）">
              <button className="btn sm" onClick={() => onChange({ shortcutAi: undefined, shortcutMini: undefined })}>恢复默认</button>
            </SettingsRow>}
          </SettingsSection>}

          {desktopShell && <SettingsSection title="本地统一网关" desc="在本机开一个 OpenAI 兼容接口（仅 127.0.0.1），Cursor 等工具填这个地址即可用管家里的 Key；按模型名路由，同模型多账户自动故障转移；真实 Key 只存内存，停止即清除" icon={Network} tone="indigo">
            <SettingsRow title={gwStatus?.running ? `运行中 · ${gwStatus.modelCount} 个模型 / ${gwStatus.routeCount} 条路由 · 已处理 ${gwStatus.requests} 次请求` : '网关未运行'} desc="开启需要先解锁保险箱（解密 Key 注册路由，只存内存不落盘）">
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn sm" onClick={() => void refreshGw()}>刷新</button>
                {gwStatus?.running
                  ? <button className="btn sm" disabled={gwBusy} onClick={() => void gwStopFlow()}>停止并清除 Key</button>
                  : <button className="btn sm primary" disabled={gwBusy} onClick={() => void gwStartFlow()}>{gwBusy ? '开启中…' : '开启网关'}</button>}
              </div>
            </SettingsRow>
            <SettingsRow title="接口地址（填到 Cursor 等工具的 OpenAI Base URL）" desc="模型名填引擎目录里的 id（如 deepseek-chat），工具会自动按名路由">
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <code style={{ fontSize: 12 }}>http://127.0.0.1:{s.gatewayPort || 8787}/v1</code>
                <button className="btn sm" onClick={() => { void navigator.clipboard?.writeText(`http://127.0.0.1:${s.gatewayPort || 8787}/v1`); notify('接口地址已复制') }}>复制</button>
              </div>
            </SettingsRow>
            <SettingsRow title="访问令牌（工具里的 API Key 填这个）" desc="不是你的真实平台 Key；泄露了重新生成即可（生成后需重启网关生效）">
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input className="input" style={{ width: 190 }} value={s.gatewayToken ?? ''} placeholder="尚未生成" onChange={e => onChange({ gatewayToken: e.target.value })} />
                <button className="btn sm" onClick={() => onChange({ gatewayToken: genGatewayToken() })}>生成</button>
                <button className="btn sm" onClick={() => { void navigator.clipboard?.writeText(s.gatewayToken ?? ''); notify('令牌已复制') }}>复制</button>
              </div>
            </SettingsRow>
            <SettingsRow title="监听端口" desc="改端口后需停止再重新开启网关">
              <input className="input" type="number" min={1024} max={65535} style={{ width: 110 }} value={s.gatewayPort ?? 8787} onChange={e => onChange({ gatewayPort: Number(e.target.value) || 8787 })} />
            </SettingsRow>
            <SettingsRow title="解锁保险箱后自动开启" desc="每次解锁后自动注册路由并启动网关（令牌需已生成）">
              <Toggle checked={!!s.gatewayAutoStart} onChange={v => onChange({ gatewayAutoStart: v })} />
            </SettingsRow>
          </SettingsSection>}
        </>}

        {setTab === 'data' && <>
          <SettingsSection title="云同步" desc="同一账号跨 Web / 桌面 / 安卓 / 小程序自动同步" icon={Cloud} tone="indigo">
            <SettingsRow
              title={cloudUser ? `已登录${cloudUser.name ? `：${cloudUser.name}` : ''}` : '未登录（仅本机存储）'}
              desc={cloudUser
                ? `数据自动同步 · 最近同步 ${lastSyncAt ? new Date(lastSyncAt).toLocaleString('zh-CN') : '待同步'}`
                : '登录后在任意客户端的数据都会自动同步；不登录也可正常本地使用'}
            >
              {cloudUser ? <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn sm" onClick={onSync} disabled={syncing}>{syncing ? '同步中…' : '立即同步'}</button>
                <button className="btn sm ghost" onClick={onLogout}>退出</button>
              </div> : <button className="btn sm primary" onClick={onLogin}>登录 / 注册</button>}
            </SettingsRow>
            {cloudUser && syncError && <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 12.5, color: 'var(--red, #d92d20)' }}>
              <AlertTriangle size={14} /> 同步失败：{syncError}（点「立即同步」重试）
            </div>}
            <SettingsRow title="同步本地模型账户" desc="把 Ollama / ComfyUI 等本地模型账户也同步到云端（其他设备上仅显示记录，仍需本机服务才能调用）">
              <Toggle checked={!!s.syncLocalProviders} onChange={v => onChange({ syncLocalProviders: v })} />
            </SettingsRow>
            <p className="set-note">支持微信扫码、手机号验证码、邮箱验证码、WorkBuddy 账号登录。登录后任意端的增删改会在约 5 秒内自动同步到其他端；同步内容包含账户、额度、签到、用量与加密密钥（密文），各端需用同一主密码解锁。</p>
          </SettingsSection>

          <SettingsSection title="账号管理" desc="已登录账号、登录方式与本机可见设备" icon={Fingerprint} tone="blue">
            <SettingsRow title="当前账号" desc="已登录账号的 ID 与登录来源">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {/* 账号信息必须渲染为可见内容：主题会隐藏 settings-row-desc，写进 desc 等于不显示 */}
                {cloudUser
                  ? <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>ID：{cloudUser.id.slice(0, 12)}… · 来源：{cloudUser.provider ?? (cloudUser.email ? '邮箱' : cloudUser.phone ? '手机号' : '第三方')}</span>
                  : <span style={{ fontSize: 12.5, color: 'var(--text-3)' }}>未登录</span>}
                <button className="btn sm" onClick={onLogin}>{cloudUser ? '切换账号' : '登录'}</button>
              </div>
            </SettingsRow>
            {cloudUser && <>
              <SettingsRow title="账号标识" desc="登录所用的邮箱或手机号">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>{cloudUser.email ?? cloudUser.phone ?? cloudUser.name ?? '未公开'}</span>
                  <span className="set-status-dot ok" />
                </div>
              </SettingsRow>
            </>}
            <div className="voice-section-label" style={{ marginTop: 12 }}>本机可见登录设备 <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>（{devices.length}）</span></div>
            {devices.length === 0 ? <div className="voice-empty">暂无设备记录</div> : devices.map(d => (
              <div key={d.clientId} className="set-stat" style={{ justifyContent: 'space-between' }}>
                <span>{d.label} · {d.platform}</span>
                <b style={{ fontSize: 11, color: 'var(--text-3)' }}>{new Date(d.lastSeen).toLocaleString('zh-CN')}</b>
              </div>
            ))}
            <div className="voice-hint"><Info size={13} /> 当前云服务接口不提供服务端会话列表，这里显示的是本机登记过的设备；同一账号的实际登录设备请到官方账号中心查看。</div>
            <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setDevices([...loadDevices()])}><RefreshCw size={13} /> 刷新设备列表</button>
          </SettingsSection>

          <SettingsSection title="应用更新" desc={`当前版本 v${APP_VERSION} · 检查并安装新版本`} icon={RefreshCw} tone="green">
            <SettingsRow title="检查更新" desc={isDesktopApp()
              ? '桌面端自动下载安装，完成后点击重启生效'
              : currentPlatform() === 'docker'
                ? 'Docker 版提供可一键复制的更新命令，在终端执行后自动替换实例'
                : currentPlatform() === 'android'
                  ? '安卓端下载最新 APK 覆盖安装，数据不丢失'
                  : '检测新版本并按平台提示更新方式'}>
              <button className="btn sm primary" onClick={onCheckUpdate}><RefreshCw size={14} /> 检查更新</button>
            </SettingsRow>
          </SettingsSection>

          <SettingsSection title="数据管理" desc="备份、恢复与清理" icon={HardDrive} tone="amber">
            <SettingsRow title="备份提醒" desc="超过设定天数未备份时在界面提示（全平台通用）">
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <select className="select" style={{ width: 76 }} value={s.backupReminderDays ?? 7}
                  onChange={e => onChange({ backupReminderDays: Number(e.target.value) as 3 | 7 | 15 })}>
                  <option value={3}>3 天</option>
                  <option value={7}>7 天</option>
                  <option value={15}>15 天</option>
                </select>
                <Toggle checked={s.backupReminder} onChange={v => onChange({ backupReminder: v })} />
              </span>
            </SettingsRow>
            <SettingsRow title="清空业务数据" desc="删除全部账户、额度、签到与用量记录；设置与保险箱保留">
              {confirmClear ? (
                <span style={{ display: 'flex', gap: 6 }}>
                  <button className="btn sm danger" onClick={() => { onClear(); setConfirmClear(false) }}>确认清空</button>
                  <button className="btn sm ghost" onClick={() => setConfirmClear(false)}>取消</button>
                </span>
              ) : <button className="btn sm danger" onClick={() => setConfirmClear(true)}><Trash2 size={13} /> 清空</button>}
            </SettingsRow>
          </SettingsSection>

          <SettingsSection title="数据备份" desc="导出/导入完整数据文件，不依赖云同步" icon={Database} tone="green">
            <SettingsRow title="导出完整备份" desc="账户、额度、签到、用量与设置导出为一个 JSON 文件；密钥只含加密密文，文件请妥善保管">
              <button className="btn sm" onClick={doExportBackup}><Download size={13} /> 导出备份</button>
            </SettingsRow>
            <SettingsRow title="导入备份" desc="用备份文件覆盖当前全部数据；导入前会自动把当前数据另存到本机（localStorage），后悔了可用那份文件再导回">
              <button className="btn sm" onClick={() => backupInputRef.current?.click()}><Upload size={13} /> 选择备份文件</button>
              <input ref={backupInputRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={e => void onBackupFile(e)} />
            </SettingsRow>
          </SettingsSection>

          {pendingImport && (
            <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) setPendingImport(null) }}>
              <div className="modal" style={{ maxWidth: 440 }}>
                <div className="modal-head"><h3 style={{ margin: 0 }}>确认导入备份</h3><button className="icon-btn" onClick={() => setPendingImport(null)}><X size={18} /></button></div>
                <div className="modal-body">
                  <p style={{ fontSize: 13, lineHeight: 1.7, marginTop: 0 }}>
                    备份内容：账户 {pendingImport.summary.accounts} 个 · 用量 {pendingImport.summary.usage} 条 · 签到 {pendingImport.summary.checkins} 条 · 额度快照 {pendingImport.summary.quotas} 条。
                  </p>
                  <p style={{ fontSize: 13, lineHeight: 1.7, color: '#dc2626' }}>
                    导入将覆盖当前全部数据（导入前会自动另存当前数据到本机）。备份里的密钥是密文，导入后请用备份来源设备的同一主密码解锁保险箱。
                  </p>
                </div>
                <div className="modal-foot">
                  <button className="btn" onClick={() => setPendingImport(null)}>取消</button>
                  <button className="btn primary" onClick={() => { onImportBackup(pendingImport.state); setPendingImport(null) }}>确认导入并覆盖</button>
                </div>
              </div>
            </div>
          )}

          <div className="set-grid-2">
            <SettingsSection title="数据概览" desc="当前本地存储的内容" icon={Database} tone="blue">
              <div className="set-stat"><span>账户</span><b>{state.accounts.length}</b></div>
              <div className="set-stat"><span>额度快照</span><b>{state.quotas.length}</b></div>
              <div className="set-stat"><span>签到记录</span><b>{state.checkins.length}</b></div>
              <div className="set-stat"><span>用量记录</span><b>{state.usage.length}</b></div>
            </SettingsSection>
            <SettingsSection title="关于" desc="版本与合规说明" icon={Info} tone="indigo">
              <div className="set-stat"><span>版本</span><b className="mono">v{APP_VERSION}</b></div>
              <div className="set-stat"><span>定位</span><b style={{ fontSize: 12 }}>本地优先 · 个人资源管理工具</b></div>
              <div className="set-about-note"><ShieldCheck size={14} /> 数据仅存本机，密钥经 AES-256-GCM 加密，不上传明文</div>
            </SettingsSection>
          </div>
        </>}

        {setTab === 'security' && <>
          <SettingsSection title="操作审计日志" desc="查看/复制/删除 Key、导出、改密码、云登录等敏感操作的时间线（只记动作，不记密钥内容；随云同步跨端合并）" icon={ClipboardList} tone="indigo">
            {(auditEntries ?? []).length === 0
              ? <div style={{ fontSize: 12.5, color: 'var(--text-3)', padding: '6px 2px' }}>暂无审计记录。进行查看 Key、导出备份等敏感操作后会出现在这里。</div>
              : <>
                <div className="audit-list">
                  {[...(auditEntries ?? [])].slice(-30).reverse().map(e => (
                    <div key={e.id} className="audit-row">
                      <span className="audit-time">{new Date(e.at).toLocaleString()}</span>
                      <span className="audit-action">{e.action}</span>
                      {e.detail && <span className="audit-detail">{e.detail}</span>}
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                  <button className="btn sm ghost" onClick={onClearAudit}>清空日志</button>
                </div>
              </>}
          </SettingsSection>
          <SettingsSection title="密钥保险箱" desc="本地 AES-256-GCM 加密存储" icon={ShieldCheck} tone="green">
            <SettingsRow title="保险箱状态" desc={s.vaultInitialized ? '已启用 · API Key 加密保存' : '未创建 · API Key 将无法加密保存'}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className={`set-status-dot ${s.vaultInitialized ? 'ok' : ''}`} />
                <button className="btn sm" onClick={onOpenVault}>{s.vaultInitialized ? '管理' : '创建'}</button>
              </div>
            </SettingsRow>
            <SettingsRow title="解锁方式" desc={onBioAvailable
              ? (bioLabel.includes('人脸') ? '可选密码或系统人脸解锁（Face ID）' : `可选密码或系统生物识别解锁（${bioLabel}）`)
              : '当前设备不支持生物识别，仅可用密码'}>
              <select className="select" style={{ width: 150 }} value={bioSwitchOpen ? 'biometric' : s.unlockMethod}
                onChange={e => {
                  const m = e.target.value as 'biometric' | 'password'
                  if (m === 'password') {
                    clearBiometricPassword()
                    void unbindVaultPasswordNative()
                    onChange({ unlockMethod: 'password' })
                    setBioSwitchOpen(false)
                  } else if (m === 'biometric' && onBioAvailable) {
                    setBioSwitchPwd('')
                    setBioSwitchOpen(true)
                  }
                }}>
                <option value="password">密码解锁</option>
                {onBioAvailable && <option value="biometric">
                  {bioLabel.includes('人脸') ? '系统人脸解锁 (Face ID)' : bioLabel.includes('触控') ? '系统触控解锁 (Touch ID)' : `${bioLabel}解锁`}
                </option>}
              </select>
            </SettingsRow>
            {onBioAvailable && s.vaultInitialized && (
              <SettingsRow title={`${bioLabel}快速解锁`} desc={`验证${bioLabel}后直接进入 API Key 管理页并解锁密钥（仅作用于该页）`}>
                <button className="btn sm" onClick={onBioUnlock}><Fingerprint size={14} /> 验证解锁</button>
              </SettingsRow>
            )}
            {bioSwitchOpen && (
              <div className="set-inline-panel">
                <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 10 }}>输入主密码以启用{bioLabel}解锁（验证后本机保存）</div>
                <div className="field">
                  <input className="input" type="password" autoFocus placeholder="主密码" value={bioSwitchPwd}
                    onChange={e => setBioSwitchPwd(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && bioSwitchPwd) void enableBio() }} />
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <button className="btn sm primary" disabled={bioSwitchBusy || !bioSwitchPwd} onClick={() => void enableBio()}>确认启用</button>
                  <button className="btn sm" onClick={() => { setBioSwitchOpen(false); setBioSwitchPwd('') }}>取消</button>
                </div>
              </div>
            )}
            <SettingsRow title="闲置自动上锁" desc="解锁后无操作达到此时长，自动清空会话密码并重新上锁（活动会重置计时）">
              <select className="select" style={{ width: 150 }} value={s.autoLockMinutes ?? 0} onChange={e => onChange({ autoLockMinutes: Number(e.target.value) })}>
                <option value={0}>关闭</option>
                <option value={1}>1 分钟</option>
                <option value={5}>5 分钟</option>
                <option value={15}>15 分钟</option>
                <option value={30}>30 分钟</option>
              </select>
            </SettingsRow>
            <SettingsRow title="修改主密码" desc="需用原密码验证，所有密钥将重新加密">
              <button className="btn sm" onClick={() => {
                const known = sessionPwd || getBiometricPassword() || ''
                setOldPwd(known); setNewPwd(''); setConfirmPwd(''); setPwdOpen(true)
              }} disabled={!s.vaultInitialized}>修改</button>
            </SettingsRow>
            <SettingsRow title="重置保险箱" desc="清除所有密钥与密码，不可恢复">
              {confirmReset ? (
                <span style={{ display: 'flex', gap: 6 }}>
                  <button className="btn sm danger" onClick={() => { onResetVault(); setConfirmReset(false) }}>确认重置</button>
                  <button className="btn sm ghost" onClick={() => setConfirmReset(false)}>取消</button>
                </span>
              ) : (
                <button className="btn sm danger" onClick={() => setConfirmReset(true)} disabled={!s.vaultInitialized}>重置</button>
              )}
            </SettingsRow>
          </SettingsSection>
          <p className="set-note"><Lock size={13} /> 主密码仅用于派生加密密钥，永不存储明文；"解锁"仅作用于 API Key 管理页，不影响其他功能。</p>
        </>}
      </div>

      {pwdOpen && (
        <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) { setPwdOpen(false); setOldPwd(''); setNewPwd(''); setConfirmPwd('') } }}>
          <div className="modal" style={{ maxWidth: 400 }}>
            <div className="modal-head"><h3>修改主密码</h3><button className="icon-btn" onClick={() => { setPwdOpen(false); setOldPwd(''); setNewPwd(''); setConfirmPwd('') }}><X size={18} /></button></div>
            <div className="modal-body">
              <div className="field">
                <label>原主密码</label>
                <input className="input" type="text" autoFocus placeholder="输入当前主密码" value={oldPwd} onChange={e => setOldPwd(e.target.value)} />
              </div>
              <div className="field">
                <label>新主密码（至少 6 位）</label>
                <input className="input" type="password" placeholder="输入新主密码" value={newPwd} onChange={e => setNewPwd(e.target.value)} />
              </div>
              <div className="field">
                <label>确认新密码</label>
                <input className="input" type="password" placeholder="再次输入新主密码" value={confirmPwd} onChange={e => setConfirmPwd(e.target.value)} />
              </div>
            </div>
            <div className="modal-foot" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => { setPwdOpen(false); setOldPwd(''); setNewPwd(''); setConfirmPwd('') }}>取消</button>
              <button className="btn primary" disabled={pwdBusy || !oldPwd || !newPwd} onClick={async () => {
                if (newPwd.length < 6) { notify('新密码至少 6 位'); return }
                if (newPwd !== confirmPwd) { notify('两次新密码不一致'); return }
                setPwdBusy(true)
                try {
                  await onChangePassword(oldPwd, newPwd)
                  setPwdOpen(false); setOldPwd(''); setNewPwd(''); setConfirmPwd('')
                  notify('主密码已修改，密钥已重新加密')
                } catch (e: any) { notify(e.message ?? '修改失败') }
                finally { setPwdBusy(false) }
              }}>确认修改</button>
            </div>
          </div>
        </div>
      )}

    </>
  )
}

export default App
