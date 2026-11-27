// 应用更新弹窗：按平台展示更新方式与操作。
import { useEffect, useState } from 'react'
import { X, RefreshCw, Download, RotateCw, ExternalLink, Copy, Check, Info, Loader2, Smartphone } from 'lucide-react'
import {
  APP_VERSION, currentPlatform, checkDesktopUpdate, checkReleaseUpdate,
  installDesktopUpdate, relaunchApp, dockerUpdateCommands, latestApkUrl,
  checkMiniappUpdate, markJustUpdated, loadAutoUpdateEnabled, saveAutoUpdateEnabled,
  onSilentUpdatePrefChange, type UpdatePlatform, type DesktopCheckStage,
} from '../core/updater'
import { SilentUpdateSwitch } from './SilentUpdateSwitch'
import { noteManualUpdateFound, noteManualUpToDate } from '../core/autoUpdate'
import { UpdateProgressBar } from './UpdateProgressBar'
import { openExternal } from '../core/openExternal'
import { t } from '../core/i18n'

type Phase = 'checking' | 'available' | 'latest' | 'downloading' | 'installing' | 'ready' | 'error' | 'manual'

export function UpdateModal({ onClose, notify }: { onClose: () => void; notify: (m: string) => void }) {
  const platform: UpdatePlatform = currentPlatform()
  const [phase, setPhase] = useState<Phase>('checking')
  const [latest, setLatest] = useState('')
  const [notes, setNotes] = useState('')
  const [releaseUrl, setReleaseUrl] = useState('')
  const [errMsg, setErrMsg] = useState('')
  const [dlBytes, setDlBytes] = useState(0)
  const [dlTotal, setDlTotal] = useState(0)
  const [copied, setCopied] = useState(false)
  const [apkUrl, setApkUrl] = useState<string | null>(null)
  const [fallback, setFallback] = useState(false)
  const [autoErr, setAutoErr] = useState('')
  // 检查阶段文案（v0.1.464）：连接中/确认中/重试中，不再只有一个干转的「正在检查更新…」
  const [stage, setStage] = useState<DesktopCheckStage>('connecting')
  const [nonce, setNonce] = useState(0)
  // 「静默更新」开关（v0.1.495）：与设置页签同一偏好，变更互相广播同步
  const [silentUpd, setSilentUpd] = useState(() => loadAutoUpdateEnabled())
  useEffect(() => onSilentUpdatePrefChange(v => setSilentUpd(v)), [])

  useEffect(() => {
    let alive = true
    setPhase('checking')
    setErrMsg('')
    setAutoErr('')
    setStage('connecting')
    ;(async () => {
      if (platform === 'desktop') {
        const u = await checkDesktopUpdate((s) => { if (alive) setStage(s) })
        if (!alive) return
        // 已是最新：立刻定论，不再多走一遍 GitHub 回退流程（旧实现白等十几秒）
        if (u.upToDate) { setLatest(u.version); setPhase('latest'); noteManualUpToDate(); return }
        if (!u.error) { setLatest(u.version); setNotes(u.body ?? ''); setPhase('available'); noteManualUpdateFound(u.version); return }
        // 自动更新检查失败：记住原因，继续走手动通道，保证用户仍可下载
        if (u.error) setAutoErr(u.error)
        setStage('comparing')
        // 没有签名更新清单时退回 GitHub Releases 检查：提示手动下载安装包
        // 传 true：若最新版桌面包仍在构建，自动回退到最近一个带完整安装包的版本
        const info = await checkReleaseUpdate(true)
        if (!alive) return
        if (!info || info.error) { setErrMsg(info?.error ?? t('检查更新失败')); setPhase('error'); return }
        setLatest(info.latest)
        setNotes(info.notes)
        setReleaseUrl(info.releaseUrl)
        setFallback(info.fallback === true)
        if (!info.hasUpdate) { setPhase('latest'); if (platform === 'desktop') noteManualUpToDate(); return }
        if (platform === 'desktop') noteManualUpdateFound(info.latest)
        if (info.installersReady === false) {
          setErrMsg(t('新版本已发布，但桌面安装包还在构建中（通常几分钟）。请稍后再点检查更新。'))
          setPhase('error'); return
        }
        // 回退版本或没有签名通道：引导到对应版本的下载页手动安装（覆盖安装不丢数据）
        setPhase('manual')
        return
      }
      if (platform === 'miniapp') {
        checkMiniappUpdate(notify)
        if (alive) setPhase('manual')
        return
      }
      setStage('comparing')
      const info = await checkReleaseUpdate()
      if (!alive) return
      if (!info || info.error) { setErrMsg(info?.error ?? t('检查更新失败')); setPhase('error'); return }
      setLatest(info.latest)
      setNotes(info.notes)
      setReleaseUrl(info.releaseUrl)
      if (platform === 'android') {
        setApkUrl(await latestApkUrl())
        setPhase('available')
      } else {
        // Docker/Web：给出手动更新指引
        setPhase('manual')
      }
    })()
    return () => { alive = false }
  }, [platform, notify, nonce])

  const doInstall = async () => {
    setPhase('downloading')
    setDlBytes(0)
    setDlTotal(0)
    const ok = await installDesktopUpdate(p => {
      setDlBytes(p.downloaded)
      if (p.total) setDlTotal(p.total)
    })
    if (!ok) { setErrMsg(t('下载安装失败，请稍后重试')); setPhase('error'); return }
    // v0.1.474：装完自动重启（旧流程停在「ready」等用户点重启，实机反馈
    // 以为没装上）。先落「刚更新」标记，重启回来会轻提示已更新到新版；
    // 自动重启没生效时 2.5 秒后回落到手动「重启应用」按钮，不卡死。
    if (latest) markJustUpdated(latest)
    setPhase('installing')
    void relaunchApp()
    window.setTimeout(() => { setPhase(prev => (prev === 'installing' ? 'ready' : prev)) }, 2500)
  }

  const versionText = latest ? `v${latest.replace(/^v/i, '')}` : ''
  const isDesktop = platform === 'desktop'

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" style={{ maxWidth: 520 }}>
        <div className="modal-head"><h3>{t('应用更新')}</h3><button className="icon-btn" onClick={onClose}><X size={18} /></button></div>
        <div className="modal-body">
          <div className="upd-current">{t('当前版本')} <b>v{APP_VERSION}</b> · {t(isDesktop ? '桌面客户端' : platform === 'android' ? '安卓客户端' : platform === 'docker' ? 'Docker 版' : platform === 'miniapp' ? '微信小程序' : '网页版')}</div>

          {phase === 'checking' && <div className="upd-state"><Loader2 size={18} className="spin" /> {stage === 'retrying' ? t('网络抖动，正在重试…') : stage === 'comparing' ? t('正在确认最新版本…') : t('正在连接更新服务器…')}</div>}

          {phase === 'latest' && <div className="upd-state ok"><Check size={18} /> {t('当前已是最新版本')}</div>}

          {phase === 'error' && <div className="upd-state"><Info size={18} /> {errMsg || t('检查更新失败，请稍后重试')}</div>}
          {phase === 'error' && errMsg && (
            <button className="btn" style={{ width: '100%', marginTop: 10 }} onClick={() => setNonce(n => n + 1)}>
              <RefreshCw size={14} /> {t('重新检查')}
            </button>
          )}

          {(phase === 'available' || phase === 'downloading') && (
            <div className="upd-box">
              <div className="upd-new">{t('发现新版本')} <b>{versionText}</b></div>
              {notes && <pre className="upd-notes">{notes.slice(0, 600)}</pre>}
              {isDesktop && (
                <>
                  <div className="upd-hint">{t('点击下方按钮自动下载并安装，完成后将自动重启应用。')}</div>
                  {phase === 'downloading' && <UpdateProgressBar downloaded={dlBytes} total={dlTotal || undefined} />}
                  <button className="btn primary" style={{ width: '100%' }} disabled={phase === 'downloading'} onClick={() => void doInstall()}>
                    <Download size={16} /> {phase === 'downloading' ? t('下载中…') : t('下载并安装')}
                  </button>
                </>
              )}
              {platform === 'android' && (
                <>
                  <div className="upd-hint">{t('安卓 APK 需手动下载安装（系统要求用户确认）。下载后覆盖安装即可，数据不会丢失。')}</div>
                  {apkUrl ? (
                    <button className="btn primary" style={{ width: '100%' }} onClick={() => void openExternal(apkUrl)}>
                      <Smartphone size={16} /> {t('下载最新 APK')}
                    </button>
                  ) : (
                    <button className="btn" style={{ width: '100%' }} onClick={() => void openExternal(releaseUrl || 'https://github.com/Andre-xue/ai-credit-manager-optimized/releases/latest')}>
                      <ExternalLink size={16} /> {t('前往下载页')}
                    </button>
                  )}
                </>
              )}
            </div>
          )}

          {phase === 'installing' && (
            <div className="upd-state"><Loader2 size={18} className="spin" /> {t('安装完成，正在重启应用…')}</div>
          )}

          {phase === 'ready' && (
            <div className="upd-box center">
              <div className="upd-new ok"><Check size={18} /> {t('新版本 {version} 已安装', { version: versionText })}</div>
              <div className="upd-hint">{t('重启后生效，当前数据不会丢失。')}</div>
              <button className="btn primary" style={{ width: '100%' }} onClick={() => void relaunchApp()}>
                <RotateCw size={16} /> {t('重启应用')}
              </button>
            </div>
          )}

          {phase === 'manual' && (
            <div className="upd-box">
              <div className="upd-new">{latest ? t('发现新版本 {version}', { version: versionText }) : t('更新方式')}</div>
              {platform === 'docker' && (
                <>
                  <div className="upd-hint">{t('网页运行在浏览器沙箱中，无法直接操作宿主机 Docker。请在终端执行以下命令，自动拉取新镜像、删除旧实例并启动新实例（数据卷保留）：')}</div>
                  <pre className="upd-cmd">{dockerUpdateCommands()}</pre>
                  <button className="btn primary" style={{ width: '100%' }} onClick={() => {
                    void navigator.clipboard.writeText(dockerUpdateCommands()).then(() => { setCopied(true); notify(t('更新命令已复制')); setTimeout(() => setCopied(false), 2000) })
                  }}>
                    {copied ? <Check size={16} /> : <Copy size={16} />} {copied ? t('已复制') : t('一键复制更新命令')}
                  </button>
                </>
              )}
              {platform === 'web' && (
                <>
                  <div className="upd-hint">{t('网页版由服务端统一部署，无需你手动更新。刷新页面即可获取最新前端资源。')}</div>
                  <button className="btn" style={{ width: '100%' }} onClick={() => location.reload()}><RefreshCw size={16} /> {t('刷新页面')}</button>
                </>
              )}
              {platform === 'miniapp' && (
                <div className="upd-hint">{t('小程序由微信平台托管更新：检测到新版本后会自动下载，下载完成会弹窗询问是否重启。也可在微信「发现 → 小程序 → 我的小程序」中下拉刷新检查。')}</div>
              )}
              {platform === 'desktop' && (
                <>
                  {autoErr && <div className="upd-hint" style={{ color: 'var(--amber)' }}>{t('⚠️ 自动更新暂时不可用：{error}。安装包通常已就绪，可点下方按钮手动下载，或稍后重试检查更新（会自动重试网络抖动）。', { error: autoErr.slice(0, 120) })}</div>}
                  <div className="upd-hint">{fallback
                    ? t('检查瞬间新版本的安装包可能尚未上传完。下面提供最近一个可直接安装的稳定版本；稍等几分钟再检查更新，即可升级到最新版。下载覆盖安装不会丢失数据。')
                    : t('可到 GitHub 下载页获取最新安装包，下载后覆盖安装即可，数据不会丢失。')}</div>
                  <button className="btn primary" style={{ width: '100%' }} onClick={() => void openExternal(releaseUrl || 'https://github.com/Andre-xue/ai-credit-manager-optimized/releases/latest')}>
                    <ExternalLink size={16} /> {fallback ? t('前往下载 {version}', { version: versionText }) : t('前往下载页')}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        <div className="modal-foot" style={{ justifyContent: isDesktop ? 'space-between' : 'flex-end', alignItems: 'center' }}>
          {isDesktop && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0, textAlign: 'left' }}>
              <SilentUpdateSwitch checked={silentUpd} onChange={v => { setSilentUpd(v); saveAutoUpdateEnabled(v) }} />
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 13, fontWeight: 600, lineHeight: 1.25 }}>{t('静默更新')}</span>
                <span style={{ display: 'block', fontSize: 11, fontWeight: 600, color: silentUpd ? '#16a34a' : '#dc2626', lineHeight: 1.3 }}>{silentUpd ? t('已开启 · 空闲时自动下载、安装并重启') : t('已关闭 · 需手动下载，下载后自动安装重启')}</span>
              </span>
            </span>
          )}
          <button className="btn" onClick={onClose}>{t('关闭')}</button>
        </div>
      </div>
    </div>
  )
}
