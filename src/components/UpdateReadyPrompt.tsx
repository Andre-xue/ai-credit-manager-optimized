// 待安装更新提示弹窗（v0.1.474）：后台自动更新把安装包下载好后弹出，
// 问「现在更新 / 稍后」。现在更新 = 立即安装并重启；稍后 = 布防关窗闸门，
// 下次关窗/退出时等任务结束自动安装。状态来自 core/autoUpdate 状态机。
import { useEffect, useState } from 'react'
import { X, Download, Clock, Loader2 } from 'lucide-react'
import {
  getAutoUpdateUiState, subscribeAutoUpdate, installDownloadedNow,
  deferDownloadedInstall, dismissUpdatePrompt, type AutoUpdateUiState,
} from '../core/autoUpdate'
import { loadPendingUpdate } from '../core/updater'
import { t } from '../core/i18n'

export function UpdateReadyPrompt() {
  const [ui, setUi] = useState<AutoUpdateUiState>(() => getAutoUpdateUiState())
  useEffect(() => subscribeAutoUpdate(() => setUi(getAutoUpdateUiState())), [])

  if (ui.kind === 'installing') {
    return (
      <div className="overlay">
        <div className="modal" style={{ maxWidth: 440 }}>
          <div className="modal-body">
            <div className="upd-state">
              <Loader2 size={18} className="spin" />
              {ui.waitingBusy ? t('正在等待当前任务完成，随后自动安装…') : t('正在安装更新…')}
            </div>
          </div>
        </div>
      </div>
    )
  }
  if (ui.kind !== 'ready' || !ui.promptOpen) return null
  const pending = loadPendingUpdate()
  const notes = pending?.notes ?? ''
  const versionText = `v${ui.version.replace(/^v/i, '')}`

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) dismissUpdatePrompt() }}>
      <div className="modal" style={{ maxWidth: 460 }}>
        <div className="modal-head">
          <h3>{t('应用更新')}</h3>
          <button className="icon-btn" onClick={() => dismissUpdatePrompt()}><X size={18} /></button>
        </div>
        <div className="modal-body">
          <div className="upd-new"><Download size={16} /> {t('新版本 {ver} 已下载好', { ver: versionText })}</div>
          {notes && <pre className="upd-notes">{notes.slice(0, 600)}</pre>}
          <div className="upd-hint">{t('更新包已下载完成。现在更新将立即安装并重启应用；稍后则在下次关闭窗口时自动安装。')}</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn" style={{ flex: 1 }} onClick={() => void deferDownloadedInstall()}>
              <Clock size={15} /> {t('稍后')}
            </button>
            <button className="btn primary" style={{ flex: 1 }} onClick={() => void installDownloadedNow()}>
              <Download size={15} /> {t('现在更新')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
