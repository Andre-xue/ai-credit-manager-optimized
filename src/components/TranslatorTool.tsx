import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Languages, Copy, Volume2, Loader2, ShieldCheck, ShieldAlert, Keyboard, MousePointer2,
  MonitorUp, SlidersHorizontal, X, Check,
} from 'lucide-react'
import type { Account } from '../core/types'
import { isDesktopApp } from '../core/openExternal'
import {
  loadTranslatorSettings, saveTranslatorSettings, applyTranslatorShortcuts,
  getTranslatorPermissions, requestAccessibility, requestScreenCapture, openPermissionSettings,
  preprocessText, pickTargetLang, translateWithRoutes, speakLangOf, writeClipboard,
  noteTranslatorDiag, humanizeTranslateError,
  getInvalidTranslatorShortcutFields,
  TRANSLATOR_LANGS, type TranslatorSettings, type TranslatorPermissions, type OpsDisplay,
  type TranslatorShortcutField,
} from '../core/translator'
import {
  loadTranslatorProviders, saveProviderPref, saveProviderModelPref, saveGroupPref, loadGroupPrefs,
  pickTranslatorEngine, loadTranslatorEngineKey,
  measureProviderMs, formatDurationMs, TRANSLATOR_OPEN_SETTINGS_KEY,
  TRANSLATOR_GROUPS, withProviderEnabled, withGroupEnabled, withModelEnabled, withProviderModel, withModelMs,
  type TranslatorProviderInfo, type TranslatorGroupId,
} from '../core/translatorProviders'
import type { FreeAiOption } from '../core/freeAi'
import { acceleratorFromEvent } from '../core/hotkey'

// 果冻开关（与设置页 Toggle 同款 jelly 动画，本地复制一份避免跨文件耦合）
function JellyToggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const [anim, setAnim] = useState<'on' | 'off' | null>(null)
  const prev = useRef(checked)
  useEffect(() => {
    if (prev.current !== checked) {
      setAnim(checked ? 'on' : 'off')
      prev.current = checked
      const t = window.setTimeout(() => setAnim(null), 360)
      return () => window.clearTimeout(t)
    }
  }, [checked])
  return (
    <button role="switch" aria-checked={checked} disabled={disabled}
      onClick={() => { if (!disabled) onChange(!checked) }}
      className={`jelly-toggle ${checked ? 'is-on' : ''}`}
      style={disabled ? { opacity: .45, pointerEvents: 'none' } : undefined}
      aria-label={checked ? '关闭' : '开启'}>
      <span className={`jelly-dot ${anim ? `anim-${anim}` : (checked ? 'static-on' : 'static-off')}`} />
    </button>
  )
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform ?? '')
function fmtAccel(a: string): string {
  if (!a) return '未注册'
  return a.split('+').map(p => {
    if (p === 'CommandOrControl') return IS_MAC ? '⌘' : 'Ctrl'
    if (IS_MAC && p === 'Alt') return '⌥'
    if (IS_MAC && p === 'Shift') return '⇧'
    return p
  }).join('+')
}

/** 快捷键录入框（借鉴 Manggo：点框后按键录入、带清除；交互规则与全局设置页一致）。
 * v0.1.451：录入按物理键位 e.code 折算（core/hotkey），不再用 e.key——macOS 上
 * Option 组合会把 e.key 改成特殊字符（Œ），440 就是这样存出无效组合的。
 * invalid=true 表示旧版本存过坏值、已按未注册处理，提示重新录入。 */
function ShortcutRecorder({ value, onChange, others, notify, invalid }: {
  value: string; onChange: (v: string) => void; others: string[]; notify: (m: string) => void; invalid?: boolean
}) {
  const [recording, setRecording] = useState(false)
  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation()
      if (e.code === 'Escape') { setRecording(false); return }
      const r = acceleratorFromEvent(e)
      if (!r.ok) {
        if (r.reason === 'no-modifier') notify('组合键需至少带一个修饰键（Ctrl/⌘/Alt/Shift）')
        else if (r.reason === 'unsupported') notify('这个主键暂不支持，请用字母、数字、方向键、空格或 F 键')
        return // modifier-only：继续等主键
      }
      if (others.includes(r.accel)) { notify('与另一个快捷键冲突，换个组合'); return }
      onChange(r.accel)
      setRecording(false)
      notify(`已设为 ${fmtAccel(r.accel)}`)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, others, onChange, notify])
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <button className={`btn sm trs-recorder ${recording ? 'rec' : ''}`} onClick={() => setRecording(true)}>
        <Keyboard size={13} /> {recording ? '请按下组合键…（Esc 取消）' : (value ? fmtAccel(value) : (invalid ? '未注册（请重新录入）' : '未注册'))}
      </button>
      {value && !recording && (
        <button className="btn sm ghost" title="清除快捷键" onClick={() => onChange('')}><X size={13} /></button>
      )}
    </span>
  )
}

function usePermissions(): { perms: TranslatorPermissions; refresh: () => void } {
  const [perms, setPerms] = useState<TranslatorPermissions>({ macos: false, accessibility: false, screenCapture: false })
  // v0.1.462 面包屑：挂载与首轮权限返回各落一行（与 Rust 的 perm-open 对照）
  const notedFirst = useRef(false)
  const refresh = useCallback(() => {
    void getTranslatorPermissions().then(p => {
      setPerms(p)
      if (!notedFirst.current) {
        notedFirst.current = true
        void noteTranslatorDiag(`tool-perms-first macos=${p.macos} ax=${p.accessibility} screen=${p.screenCapture}`)
      }
    })
  }, [])
  useEffect(() => {
    refresh()
    // 实时监测真实状态：定时轮询 + 窗口聚焦时刷新（去系统设置改完切回来立刻同步）
    const timer = window.setInterval(refresh, 2500)
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', onFocus) }
  }, [refresh])
  return { perms, refresh }
}

function StatusDot({ ok, warn }: { ok: boolean; warn?: boolean }) {
  return <span className={`trs-dot ${ok ? 'ok' : warn ? 'warn' : 'off'}`} />
}

export function TranslatorTool({ accounts, sessionPwd, notify }: {
  accounts: Account[]; sessionPwd: string; notify: (m: string) => void
}) {
  const [tab, setTab] = useState<'input' | 'settings'>('input')
  // 设置页横向页签（v0.1.477 增量，Ethan 拍板布局）：选中页签仅本机记住
  const [subTab, setSubTabState] = useState<'perms' | 'trans' | 'providers' | 'keys'>(() => {
    try {
      const v = localStorage.getItem('acm.translator.settingsTab.v1')
      return v === 'trans' || v === 'providers' || v === 'keys' ? v : 'perms'
    } catch { return 'perms' }
  })
  const setSubTab = (v: 'perms' | 'trans' | 'providers' | 'keys') => {
    setSubTabState(v)
    try { localStorage.setItem('acm.translator.settingsTab.v1', v) } catch { /* 忽略 */ }
  }
  const [settings, setSettings] = useState<TranslatorSettings>(loadTranslatorSettings)
  // 旧版本存下的无效快捷键字段：录入框显示「未注册（请重新录入）」；重录出合法值即消
  const [invalidFields, setInvalidFields] = useState<TranslatorShortcutField[]>(() => getInvalidTranslatorShortcutFields())
  const { perms, refresh: refreshPerms } = usePermissions()

  // v0.1.473：旧版这里消费 pending 输入页签（Alt+E 跳页机制）——该机制已
  // 随输入小窗直开删除，takePendingTranslatorTab 一并移除，勿恢复。
  // v0.1.462 面包屑：页面挂载落一行——若闪退时日志里连这行都没有，问题在
  // 组件挂载之前；有这行没 perm-open，就是死在首次 invoke 的路上。
  useEffect(() => { void noteTranslatorDiag('tool-mount') }, [])

  // v0.1.477：小窗「打开翻译设置」置的一次性标记——挂载时消费、直落设置页签
  useEffect(() => {
    try {
      if (localStorage.getItem(TRANSLATOR_OPEN_SETTINGS_KEY) === '1') {
        localStorage.removeItem(TRANSLATOR_OPEN_SETTINGS_KEY)
        setTab('settings')
        // 从小窗来就是为了启用服务商：直落「翻译服务商」页签
        setSubTab('providers')
      }
    } catch { /* 忽略 */ }
  }, [])

  // ---------------- 翻译服务商（v0.1.480 三层管理：大组→平台→模型） ----------------
  const [providers, setProviders] = useState<TranslatorProviderInfo[]>([])
  const [provFreeOptions, setProvFreeOptions] = useState<FreeAiOption[]>([])
  const [testingKey, setTestingKey] = useState('')
  const [testMsg, setTestMsg] = useState<Record<string, { ok: boolean; text: string }>>({})
  const [groupPrefs, setGroupPrefs] = useState<Record<string, boolean>>(loadGroupPrefs)
  const [groupTab, setGroupTabState] = useState<TranslatorGroupId>(() => {
    try {
      const v = localStorage.getItem('acm.translator.providerGroupTab.v1')
      return v === 'pool' || v === 'general' || v === 'chat' ? v : 'free'
    } catch { return 'free' }
  })
  const setGroupTab = (v: TranslatorGroupId) => {
    setGroupTabState(v)
    try { localStorage.setItem('acm.translator.providerGroupTab.v1', v) } catch { /* 忽略 */ }
  }
  const [selProviderKey, setSelProviderKey] = useState('')
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(false)
  const reloadProviders = useCallback(() => {
    void loadTranslatorProviders(accounts).then(r => {
      setProviders(r.providers)
      setProvFreeOptions(r.freeOptions)
    }).catch(() => { /* 路线拉取失败时保持旧列表，翻译执行会再报真实原因 */ })
  }, [accounts])
  useEffect(() => { reloadProviders() }, [reloadProviders])

  const replaceProvider = useCallback((next: TranslatorProviderInfo) => {
    setProviders(prev => prev.map(p => (p.key === next.key ? next : p)))
  }, [])
  const toggleGroup = useCallback((group: TranslatorGroupId, v: boolean) => {
    saveGroupPref(group, v)
    setGroupPrefs(loadGroupPrefs())
    setProviders(prev => prev.map(p => (p.group === group ? withGroupEnabled(p, v) : p)))
  }, [])
  const toggleProvider = useCallback((info: TranslatorProviderInfo, v: boolean) => {
    saveProviderPref(info.key, { enabled: v })
    replaceProvider(withProviderEnabled(info, v))
  }, [replaceProvider])
  const toggleModel = useCallback((info: TranslatorProviderInfo, modelId: string, v: boolean) => {
    saveProviderModelPref(info.key, modelId, { enabled: v })
    replaceProvider(withModelEnabled(info, modelId, v))
  }, [replaceProvider])
  const pickModel = useCallback((info: TranslatorProviderInfo, modelId: string) => {
    saveProviderPref(info.key, { modelId })
    replaceProvider(withProviderModel(info, modelId))
  }, [replaceProvider])
  const testModel = useCallback(async (info: TranslatorProviderInfo, modelId: string) => {
    const tk = `${info.key}|${modelId}`
    setTestingKey(tk)
    setTestMsg(prev => ({ ...prev, [tk]: { ok: true, text: '测速中…' } }))
    try {
      const ms = await measureProviderMs({ accounts, sessionPwd, provider: info, freeOptions: provFreeOptions, modelId })
      replaceProvider(withModelMs(info, modelId, ms))
      setTestMsg(prev => ({ ...prev, [tk]: { ok: true, text: `实测 ${formatDurationMs(ms)}` } }))
    } catch (e) {
      setTestMsg(prev => ({ ...prev, [tk]: { ok: false, text: e instanceof Error ? e.message : '测速失败' } }))
    } finally { setTestingKey('') }
  }, [accounts, sessionPwd, provFreeOptions, replaceProvider])
  const currentEngine = pickTranslatorEngine(providers, loadTranslatorEngineKey())

  // 大组/平台选择兜底：当前组没平台时落到第一个非空组；选中平台不在当前
  // 组时落到当前引擎所在平台、再落到组内第一家
  const groupProviders = providers.filter(p => p.group === groupTab)
  useEffect(() => {
    if (providers.length && groupProviders.length === 0) {
      const first = TRANSLATOR_GROUPS.find(g => providers.some(p => p.group === g.id))
      if (first && first.id !== groupTab) setGroupTab(first.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, groupTab])
  useEffect(() => {
    if (!groupProviders.length) return
    if (!groupProviders.some(p => p.key === selProviderKey)) {
      const engineInGroup = groupProviders.find(p => p.key === currentEngine?.key)
      setSelProviderKey((engineInGroup ?? groupProviders[0]).key)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupTab, providers])
  const selProvider = groupProviders.find(p => p.key === selProviderKey) ?? groupProviders[0]
  const listedProviders = providers.filter(p => p.listed)
  const listedModelCount = listedProviders.reduce(
    (n, p) => n + p.models.filter(m => m.visible && m.enabled).length, 0)

  // v0.1.465：「去开启」点了必须有明确去向与反馈——先请求系统登记/提示，
  // 再直达系统设置对应面板，并留一行常驻说明写清去哪开、怎么开（464 实机
  // 划词那颗点了无弹窗无变化、用户无从下手；辅助功能最终也始终没授上）。
  // 权限轮询感知到两个都开启后自动收起说明。
  const [permHint, setPermHint] = useState('')
  useEffect(() => {
    if (perms.accessibility && perms.screenCapture) setPermHint('')
  }, [perms.accessibility, perms.screenCapture])
  const goEnable = useCallback((kind: 'accessibility' | 'screen') => {
    if (kind === 'accessibility') {
      void requestAccessibility().then(() => refreshPerms())
      setPermHint('已打开系统设置 → 隐私与安全性 → 辅助功能：请把「AI Cube」的开关打开；若列表里没有它，点列表下方的 + 号、从「应用程序」里把它添加进来。打开后回到本页会自动变「已开启」。')
    } else {
      void requestScreenCapture().then(() => refreshPerms())
      setPermHint('已打开系统设置 → 隐私与安全性 → 录屏与系统录音：请把「AI Cube」的开关打开。注意录屏授权对已经在运行的程序不生效，打开后请完全退出并重开本 App。')
    }
    void openPermissionSettings(kind)
  }, [refreshPerms])

  const update = useCallback((patch: Partial<TranslatorSettings>) => {
    setSettings(prev => {
      const next = { ...prev, ...patch }
      saveTranslatorSettings(next)
      return next
    })
  }, [])

  const setShortcut = useCallback((field: TranslatorShortcutField, v: string) => {
    if (v) setInvalidFields(prev => prev.filter(f => f !== field))
    update({ [field]: v } as Partial<TranslatorSettings>)
  }, [update])

  // 设置变化 → 重新下发快捷键注册（注册失败把真实原因报出来，如被其他应用占用）
  const applyTimer = useRef(0)
  useEffect(() => {
    window.clearTimeout(applyTimer.current)
    applyTimer.current = window.setTimeout(() => {
      void applyTranslatorShortcuts(settings).then(err => {
        if (err) notify(`快捷键注册失败：${err}`)
        void noteTranslatorDiag(err ? 'tool-apply-err' : 'tool-apply-ok')
      })
    }, 300)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.shortcutSelection, settings.shortcutScreenshot, settings.shortcutInput, settings.selectionEnabled, settings.screenshotEnabled, settings.disableInFullscreen, settings.doubleClick])

  // ---------------- 输入即译 ----------------
  const [src, setSrc] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ text: string; targetLang: string } | null>(null)
  const [errText, setErrText] = useState('')
  const runRef = useRef<() => Promise<void>>(async () => {})
  const run = useCallback(async () => {
    const raw = src
    if (!raw.trim()) { setResult(null); setErrText(''); return }
    setBusy(true); setErrText('')
    try {
      const text = preprocessText(raw, settings.preprocess)
      const out = await translateWithRoutes({
        accounts, sessionPwd, text, settings,
        onChainNote: msg => notify(msg),
      })
      setResult({ text: out.translated, targetLang: out.targetLang })
    } catch (e) {
      setErrText(e instanceof Error ? e.message : '翻译失败')
    } finally { setBusy(false) }
  }, [src, settings, accounts, sessionPwd, notify])
  runRef.current = run
  useEffect(() => {
    if (!src.trim()) return
    const t = window.setTimeout(() => { void runRef.current() }, 800)
    return () => window.clearTimeout(t)
  }, [src])

  const speak = (text: string, langName: string) => {
    try {
      const u = new SpeechSynthesisUtterance(text)
      u.lang = speakLangOf(langName)
      window.speechSynthesis?.cancel()
      window.speechSynthesis?.speak(u)
    } catch { notify('朗读不可用') }
  }

  // ---------------- 权限与功能状态 ----------------
  const featureState = (enabled: boolean, granted: boolean): { text: string; cls: string } => {
    if (!enabled) return { text: '已关闭', cls: 'off' }
    if (!perms.macos) return { text: '仅支持 macOS', cls: 'off' }
    return granted ? { text: '已开启', cls: 'ok' } : { text: '待授权', cls: 'warn' }
  }
  const selState = featureState(settings.selectionEnabled, perms.accessibility)
  const shotState = featureState(settings.screenshotEnabled, perms.screenCapture)

  const bannerItems = [
    { label: '划词翻译', state: selState, granted: perms.accessibility, kind: 'accessibility' as const },
    { label: '截图翻译', state: shotState, granted: perms.screenCapture, kind: 'screen' as const },
  ]

  return (
    <div>
      {/* 顶部权限横幅：与设置页共用同一份实时状态 */}
      <div className="trs-banner">
        {perms.macos ? bannerItems.map(it => (
          <span key={it.kind} className="trs-banner-item">
            <StatusDot ok={it.state.cls === 'ok'} warn={it.state.cls === 'warn'} />
            {it.label}：{it.state.text}
            {it.state.cls === 'warn' && (
              <button className="btn sm" onClick={() => goEnable(it.kind)}>去开启</button>
            )}
          </span>
        )) : (
          <span className="trs-banner-item"><ShieldAlert size={14} /> 划词与截图翻译需要 macOS 桌面端；输入翻译不受影响。</span>
        )}
      </div>
      {permHint && perms.macos && (
        <p className="trs-note" style={{ margin: '6px 0 0' }}>{permHint}</p>
      )}

      <div className="ws-chips" style={{ marginTop: 4 }}>
        <button className={`chip-btn ${tab === 'input' ? 'on' : ''}`} onClick={() => setTab('input')}><Languages size={13} /> 输入翻译</button>
        <button className={`chip-btn ${tab === 'settings' ? 'on' : ''}`} onClick={() => setTab('settings')}><SlidersHorizontal size={13} /> 设置</button>
      </div>

      {tab === 'input' && (
        <div>
          <p style={{ fontSize: 12, opacity: 0.65, margin: '2px 0 8px' }}>
            翻译服务商：{currentEngine
              ? <b>{currentEngine.label}</b>
              : <span style={{ color: 'var(--red)' }}>还没有启用的服务商——去「设置 → 翻译服务商」里启用至少一家</span>}
            <span style={{ marginLeft: 6 }}>（与小窗共用同一引擎，在设置里管理）</span>
          </p>
          <textarea className="input ws-textarea" rows={5} placeholder="输入或粘贴要翻译的文本，停顿片刻自动翻译…"
            value={src} onChange={e => setSrc(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void run() }} />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
            <button className="btn primary" disabled={busy || !src.trim()} onClick={() => void run()}>
              {busy ? <Loader2 size={15} className="spin" /> : <Languages size={15} />} 翻译成{src.trim() ? pickTargetLang(preprocessText(src, settings.preprocess), settings) : settings.targetLang}
            </button>
            <span style={{ fontSize: 12, opacity: 0.6 }}>默认目标 {settings.targetLang}，源语言相同时自动改用 {settings.fallbackLang}</span>
          </div>
          {busy && <div className="ws-result"><Loader2 size={16} className="spin" /> 正在翻译…</div>}
          {errText && (() => {
            const human = humanizeTranslateError(errText)
            return (
              <div className="ws-result" style={{ color: 'var(--red)' }}>
                {human.title}{human.hint ? `——${human.hint}` : ''}
                {human.detail && human.detail !== human.title && (
                  <details style={{ marginTop: 6 }}>
                    <summary style={{ cursor: 'pointer', fontSize: 12 }}>查看原始错误</summary>
                    <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 11, margin: '6px 0 0' }}>{human.detail}</pre>
                  </details>
                )}
              </div>
            )
          })()}
          {result && !busy && (
            <div className="ws-result">
              <div className="ws-result-head">
                <span>译文 · {result.targetLang}</span>
                <span style={{ display: 'flex', gap: 4 }}>
                  <button className="btn sm ghost" onClick={() => void writeClipboard(result.text)}><Copy size={13} /> 复制</button>
                  <button className="btn sm ghost" onClick={() => speak(result.text, result.targetLang)}><Volume2 size={13} /> 朗读</button>
                </span>
              </div>
              <div className="ws-result-text">{result.text}</div>
            </div>
          )}
          <p style={{ fontSize: 12, opacity: 0.6, marginTop: 12 }}>
            全局用法（桌面端）：在任何应用里选中文字按 {fmtAccel(settings.shortcutSelection)} 划词翻译；按 {fmtAccel(settings.shortcutScreenshot)} 框选截图翻译。权限与快捷键在「设置」里管理。
          </p>
        </div>
      )}

      {tab === 'settings' && (
        <div className="trs-settings">
          {/* 横向页签（v0.1.477 增量）：点哪个页签下方只显示那一组，
              不再纵向长卡片堆叠；样式与 App 现有横向页签同口径 */}
          <div className="ws-chips" style={{ marginBottom: 10 }}>
            {([['perms', '权限管理'], ['trans', '翻译设置'], ['providers', '翻译服务商'], ['keys', '快捷键']] as const).map(([v, label]) => (
              <button key={v} className={`chip-btn ${subTab === v ? 'on' : ''}`} onClick={() => setSubTab(v)}>{label}</button>
            ))}
          </div>
          {/* 权限管理：功能开关与权限状态分开，开关即权威，不假开 */}
          {subTab === 'perms' && (
          <section className="trs-card">
            <h4><ShieldCheck size={15} /> 权限管理</h4>
            <div className="trs-row">
              <div className="trs-row-main">
                <span><MousePointer2 size={14} /> 划词翻译</span>
                <span className={`trs-state ${selState.cls}`}>{selState.text}</span>
              </div>
              <JellyToggle checked={settings.selectionEnabled} onChange={v => update({ selectionEnabled: v })} />
            </div>
            <div className="trs-row sub">
              <div className="trs-row-main">
                <span>辅助功能权限（模拟复制取词）</span>
                <span className={`trs-state ${perms.accessibility ? 'ok' : 'warn'}`}>
                  <StatusDot ok={perms.accessibility} warn={!perms.accessibility} /> {perms.accessibility ? '已开启' : '未开启'}
                </span>
              </div>
              {!perms.accessibility && perms.macos && (
                <button className="btn sm" onClick={() => goEnable('accessibility')}>去开启</button>
              )}
            </div>
            <div className="trs-row">
              <div className="trs-row-main">
                <span><MonitorUp size={14} /> 截图翻译</span>
                <span className={`trs-state ${shotState.cls}`}>{shotState.text}</span>
              </div>
              <JellyToggle checked={settings.screenshotEnabled} onChange={v => update({ screenshotEnabled: v })} />
            </div>
            <div className="trs-row sub">
              <div className="trs-row-main">
                <span>录屏权限（框选截图与本地识别）</span>
                <span className={`trs-state ${perms.screenCapture ? 'ok' : 'warn'}`}>
                  <StatusDot ok={perms.screenCapture} warn={!perms.screenCapture} /> {perms.screenCapture ? '已开启' : '未开启'}
                </span>
              </div>
              {!perms.screenCapture && perms.macos && (
                <button className="btn sm" onClick={() => goEnable('screen')}>去开启</button>
              )}
            </div>
            <p className="trs-note">权限状态实时读取系统真实值：在系统设置里关掉，这里立刻变「未开启」；功能开着但缺权限会显示「待授权」，不会假装可用。</p>
            {perms.macos && (!perms.accessibility || !perms.screenCapture) && (
              <p className="trs-note">已在系统设置里开启、这里却仍显示未开启时，按顺序排查：①开启后请完全退出并重开本 App（录屏授权对已经在运行的进程不生效）；②刚更新版本后出现的，是系统里登记的还是旧版本——请在对应面板的列表中将「AI Cube」移除后重新添加、再打开开关并重开本 App。</p>
            )}
          </section>
          )}

          {/* 翻译设置 */}
          {subTab === 'trans' && (
          <section className="trs-card">
            <h4><Languages size={15} /> 翻译设置</h4>
            <div className="trs-row">
              <div className="trs-row-main"><span>默认目标语言</span></div>
              <select className="select" style={{ width: 150 }} value={settings.targetLang} onChange={e => update({ targetLang: e.target.value })}>
                {TRANSLATOR_LANGS.map(l => <option key={l} value={l}>{l}</option>)}
              </select>
            </div>
            <div className="trs-row">
              <div className="trs-row-main"><span>备用目标语言</span><span className="trs-note inline">源语言与默认目标相同时用它</span></div>
              <select className="select" style={{ width: 150 }} value={settings.fallbackLang} onChange={e => update({ fallbackLang: e.target.value })}>
                {TRANSLATOR_LANGS.map(l => <option key={l} value={l}>{l}</option>)}
              </select>
            </div>
            <div className="trs-row">
              <div className="trs-row-main"><span>原文预处理</span><span className="trs-note inline">自动删换行、拆分驼峰/下划线/连字符命名</span></div>
              <JellyToggle checked={settings.preprocess} onChange={v => update({ preprocess: v })} />
            </div>
          </section>
          )}

          {/* 翻译服务商（v0.1.480 三层管理）：大组（按 Key 管理分类，带总
              开关）→ 左平台 → 右模型；小窗下拉只列可见的（平台开+组开+
              有启用的可翻译模型）；只展示能文本翻译的对话模型，非对话
              模型按 469 分类口径过滤并如实标注隐藏数；Key 只在 Key 管理
              维护，这里不存 Key */}
          {subTab === 'providers' && (
          <section className="trs-card">
            <h4><SlidersHorizontal size={15} /> 翻译服务商</h4>
            {providers.length === 0 && (
              <p className="trs-note">暂无可用来源：先在「Key 管理」添加账户，或登录云账号使用免费路线。</p>
            )}
            {providers.length > 0 && (
              <>
                <div className="trs-prov-groups">
                  {TRANSLATOR_GROUPS.filter(g => providers.some(p => p.group === g.id)).map(g => {
                    const on = groupPrefs[g.id] !== false
                    const cnt = providers.filter(p => p.group === g.id).length
                    return (
                      <span key={g.id} className={`trs-prov-group ${groupTab === g.id ? 'on' : ''} ${on ? '' : 'off'}`}>
                        <button className="trs-prov-group-btn" onClick={() => setGroupTab(g.id)}>
                          <b>{g.label}</b><span className="trs-prov-group-cnt">{cnt} 家</span>
                        </button>
                        <JellyToggle checked={on} onChange={v => toggleGroup(g.id, v)} />
                      </span>
                    )
                  })}
                </div>
                <p className="trs-prov-summary">
                  小窗下拉当前可见：{listedProviders.length} 家平台 · {listedModelCount} 个模型
                  {groupPrefs[groupTab] === false && <span style={{ color: 'var(--red)' }}>（「{TRANSLATOR_GROUPS.find(g => g.id === groupTab)?.label}」组总开关已关：本组在小窗里整体隐匿，这里仍可管理）</span>}
                </p>
                <div className="trs-prov-split">
                  <div className={`trs-prov-left ${leftCollapsed ? 'collapsed' : ''}`}>
                    <div className="trs-prov-lefthead">
                      {!leftCollapsed && <span>平台</span>}
                      <button className="trs-prov-foldbtn" title={leftCollapsed ? '展开平台列表' : '收起平台列表'}
                        onClick={() => setLeftCollapsed(v => !v)}>{leftCollapsed ? '›' : '‹'}</button>
                    </div>
                    {!leftCollapsed && (
                      <div className="trs-prov-plats">
                        {groupProviders.map(info => {
                          const vis = info.models.filter(m => m.visible)
                          const en = vis.filter(m => m.enabled)
                          const fastest = en.reduce<number | undefined>(
                            (best, m) => (typeof m.ms === 'number' && (best === undefined || m.ms < best) ? m.ms : best), undefined)
                          return (
                            <button key={info.key}
                              className={`trs-prov-plat ${selProvider?.key === info.key ? 'sel' : ''} ${info.listed ? '' : 'dim'}`}
                              onClick={() => setSelProviderKey(info.key)}>
                              <span className="trs-prov-plat-name">
                                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{info.label}</span>
                                {currentEngine?.key === info.key && <span className="trs-prov-engine-badge">当前引擎</span>}
                              </span>
                              <span className="trs-prov-plat-sub">
                                {info.kind === 'free' ? '免费路线' : info.kind === 'wbpool' ? '账号池' : '自有账户'}
                                {info.kind !== 'wbpool' && <> · 已启用 {en.length}/{vis.length}</>}
                                {typeof fastest === 'number' && <> · 最快 {formatDurationMs(fastest)}</>}
                                {!info.listed && info.enabled && info.groupEnabled && info.kind !== 'wbpool' && <> · 无可用模型</>}
                                {!info.enabled && <> · 已关闭</>}
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                  <div className="trs-prov-right">
                    {selProvider && (
                      <>
                        <div className="trs-prov-righthead">
                          <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {selProvider.label}
                            <span className="trs-prov-kindtag" style={{ marginLeft: 6 }}>
                              {selProvider.kind === 'free' ? '免费路线' : selProvider.kind === 'wbpool' ? '账号池' : '自有账户'}
                            </span>
                          </span>
                          <JellyToggle checked={selProvider.enabled} onChange={v => toggleProvider(selProvider, v)} />
                          <button className="trs-prov-foldbtn" title={rightCollapsed ? '展开模型列表' : '收起模型列表'}
                            onClick={() => setRightCollapsed(v => !v)}>{rightCollapsed ? '▸' : '▾'}</button>
                        </div>
                        {!rightCollapsed && (
                          <div>
                            {selProvider.disabledReason && (
                              <p className="trs-prov-note" style={{ color: 'var(--red)', opacity: 1 }}>{selProvider.disabledReason}</p>
                            )}
                            {selProvider.kind === 'wbpool' ? (
                              <p className="trs-prov-note">模型由账号池自动调度，没有逐个模型开关。</p>
                            ) : selProvider.models.filter(m => m.visible).length === 0 ? (
                              <p className="trs-prov-note">这个平台没有能做文本翻译的对话模型。</p>
                            ) : (
                              selProvider.models.filter(m => m.visible).map(m => {
                                const tk = `${selProvider.key}|${m.id}`
                                const isCurrent = selProvider.modelId === m.id
                                return (
                                  <div key={m.id} className={`trs-prov-model ${m.enabled ? '' : 'dim'}`}>
                                    {selProvider.modelOptions.length > 1 ? (
                                      <span className="trs-prov-model-name trs-prov-model-pick" title="设为当前模型"
                                        onClick={() => pickModel(selProvider, m.id)}>{m.id}</span>
                                    ) : (
                                      <span className="trs-prov-model-name">{m.id}</span>
                                    )}
                                    {isCurrent && <span className="trs-prov-cur">当前模型</span>}
                                    <button className="btn sm" disabled={testingKey === tk}
                                      onClick={() => void testModel(selProvider, m.id)}>
                                      {testingKey === tk ? <Loader2 size={13} className="spin" /> : null} 测速
                                    </button>
                                    {testMsg[tk] ? (
                                      <span className="trs-note inline" style={testMsg[tk].ok ? undefined : { color: 'var(--red)' }}>{testMsg[tk].text}</span>
                                    ) : typeof m.ms === 'number' ? (
                                      <span className="trs-note inline">{formatDurationMs(m.ms)}</span>
                                    ) : (
                                      <span className="trs-note inline">未测速</span>
                                    )}
                                    <JellyToggle checked={m.enabled} onChange={v => toggleModel(selProvider, m.id, v)} />
                                  </div>
                                )
                              })
                            )}
                            {selProvider.hiddenCount > 0 && (
                              <p className="trs-prov-note">另有 {selProvider.hiddenCount} 个非对话模型已自动隐藏（生图/语音/向量/重排等不能做文本翻译）。</p>
                            )}
                            {selProvider.kind !== 'wbpool' && selProvider.models.some(m => m.visible)
                              && !selProvider.models.some(m => m.visible && m.enabled) && (
                              <p className="trs-prov-note" style={{ color: 'var(--red)', opacity: 1 }}>模型都关掉了：这家不会出现在小窗下拉里，也不会被选为引擎。</p>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </>
            )}
            <p className="trs-note">大组总开关关掉后，该组在小窗下拉里整体隐匿（这里仍可管理，组内开关状态保留）；当前引擎所在组被关时，小窗自动回落到其他可见服务商里实测最快的一家。测速会真实发一条短翻译请求。</p>
          </section>
          )}

          {/* 快捷键设置 */}
          {subTab === 'keys' && (
          <section className="trs-card">
            <h4><Keyboard size={15} /> 快捷键设置</h4>
            <div className="trs-row">
              <div className="trs-row-main"><span>划词翻译</span></div>
              <ShortcutRecorder value={settings.shortcutSelection} others={[settings.shortcutScreenshot, settings.shortcutInput]}
                invalid={invalidFields.includes('shortcutSelection')}
                onChange={v => setShortcut('shortcutSelection', v)} notify={notify} />
            </div>
            <div className="trs-row">
              <div className="trs-row-main"><span>截图翻译</span></div>
              <ShortcutRecorder value={settings.shortcutScreenshot} others={[settings.shortcutSelection, settings.shortcutInput]}
                invalid={invalidFields.includes('shortcutScreenshot')}
                onChange={v => setShortcut('shortcutScreenshot', v)} notify={notify} />
            </div>
            <div className="trs-row">
              <div className="trs-row-main"><span>打开输入翻译</span></div>
              <ShortcutRecorder value={settings.shortcutInput} others={[settings.shortcutSelection, settings.shortcutScreenshot]}
                invalid={invalidFields.includes('shortcutInput')}
                onChange={v => setShortcut('shortcutInput', v)} notify={notify} />
            </div>
            <div className="trs-row">
              <div className="trs-row-main"><span>在全屏应用中禁用快捷键</span></div>
              <JellyToggle checked={settings.disableInFullscreen} onChange={v => update({ disableInFullscreen: v })} />
            </div>
          </section>
          )}

          {/* 划词浮窗（归「翻译设置」页签：小窗呈现方式与偏移） */}
          {subTab === 'trans' && (
          <section className="trs-card">
            <h4><MousePointer2 size={15} /> 划词浮窗</h4>
            <div className="trs-row">
              <div className="trs-row-main"><span>启用浮窗</span><span className="trs-note inline">关了则译文直接复制到剪贴板</span></div>
              <JellyToggle checked={settings.popEnabled} onChange={v => update({ popEnabled: v })} />
            </div>
            <div className="trs-row">
              <div className="trs-row-main"><span>监听鼠标双击</span><span className="trs-note inline">双击选词后自动翻译（实验）</span></div>
              <JellyToggle checked={settings.doubleClick} onChange={v => update({ doubleClick: v })} />
            </div>
            <div className="trs-row">
              <div className="trs-row-main"><span>操作显示方式</span></div>
              <span className="ws-chips" style={{ margin: 0 }}>
                {([['icon', '仅图标'], ['text', '仅文字'], ['both', '图标+文字']] as [OpsDisplay, string][]).map(([v, label]) => (
                  <button key={v} className={`chip-btn ${settings.opsDisplay === v ? 'on' : ''}`} onClick={() => update({ opsDisplay: v })}>{label}</button>
                ))}
              </span>
            </div>
            <div className="trs-row">
              <div className="trs-row-main"><span>水平偏移</span><span className="trs-note inline">{settings.offsetX}px</span></div>
              <input type="range" min={-80} max={120} value={settings.offsetX} onChange={e => update({ offsetX: Number(e.target.value) })} style={{ width: 170 }} />
            </div>
            <div className="trs-row">
              <div className="trs-row-main"><span>垂直偏移</span><span className="trs-note inline">{settings.offsetY}px</span></div>
              <input type="range" min={-80} max={120} value={settings.offsetY} onChange={e => update({ offsetY: Number(e.target.value) })} style={{ width: 170 }} />
            </div>
          </section>
          )}

          {!isDesktopApp() && <p className="trs-note">当前不是桌面端：划词/截图与全局快捷键不可用，设置仅作预览。</p>}
          <p className="trs-note"><Check size={12} /> 设置只存本机，改完立即生效。</p>
        </div>
      )}
    </div>
  )
}
