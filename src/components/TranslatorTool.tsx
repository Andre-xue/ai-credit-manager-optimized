import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Languages, Copy, Volume2, Loader2, ShieldCheck, ShieldAlert, Keyboard, MousePointer2,
  MonitorUp, SlidersHorizontal, X, Check,
} from 'lucide-react'
import type { Account } from '../core/types'
import { isDesktopApp } from '../core/openExternal'
import { useRouteData, RouteSelect } from './WorkshopView'
import {
  loadTranslatorSettings, saveTranslatorSettings, applyTranslatorShortcuts,
  getTranslatorPermissions, requestAccessibility, requestScreenCapture, openPermissionSettings,
  preprocessText, pickTargetLang, translateWithRoutes, speakLangOf, writeClipboard,
  noteTranslatorDiag,
  saveTranslatorRouteKey, takePendingTranslatorTab, getInvalidTranslatorShortcutFields,
  TRANSLATOR_LANGS, type TranslatorSettings, type TranslatorPermissions, type OpsDisplay,
  type TranslatorShortcutField,
} from '../core/translator'
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
  const [settings, setSettings] = useState<TranslatorSettings>(loadTranslatorSettings)
  // 旧版本存下的无效快捷键字段：录入框显示「未注册（请重新录入）」；重录出合法值即消
  const [invalidFields, setInvalidFields] = useState<TranslatorShortcutField[]>(() => getInvalidTranslatorShortcutFields())
  const { perms, refresh: refreshPerms } = usePermissions()
  const { data, routeKey, setRouteKey } = useRouteData(accounts)

  useEffect(() => { takePendingTranslatorTab() }, [])
  // v0.1.462 面包屑：页面挂载落一行——若闪退时日志里连这行都没有，问题在
  // 组件挂载之前；有这行没 perm-open，就是死在首次 invoke 的路上。
  useEffect(() => { void noteTranslatorDiag('tool-mount') }, [])
  useEffect(() => { saveTranslatorRouteKey(routeKey) }, [routeKey])

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
          <RouteSelect data={data} routeKey={routeKey} setRouteKey={setRouteKey} />
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
          {errText && <div className="ws-result" style={{ color: 'var(--red)' }}>{errText}</div>}
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
          {/* 权限管理：功能开关与权限状态分开，开关即权威，不假开 */}
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

          {/* 翻译设置 */}
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
            <div style={{ marginTop: 6 }}>
              <RouteSelect data={data} routeKey={routeKey} setRouteKey={setRouteKey} />
            </div>
          </section>

          {/* 快捷键设置 */}
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

          {/* 划词浮窗 */}
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

          {!isDesktopApp() && <p className="trs-note">当前不是桌面端：划词/截图与全局快捷键不可用，设置仅作预览。</p>}
          <p className="trs-note"><Check size={12} /> 设置只存本机，改完立即生效。</p>
        </div>
      )}
    </div>
  )
}
