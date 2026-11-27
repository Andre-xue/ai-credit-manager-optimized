// 更新下载进度呈现（v0.1.495）：手动更新弹窗与后台下载悬浮卡共用同一份——
// 进度条 + 百分比 + 已下载/总大小。总大小未知（源站未给长度）时只报已下载量，
// 不拿 0% 假条糊弄。样式复用 .upd-progress / .upd-downloading。
import { Loader2 } from 'lucide-react'
import { t } from '../core/i18n'

const mb = (bytes: number) => Math.round(bytes / 1024 / 1024 * 10) / 10

export function UpdateProgressBar({ downloaded, total }: { downloaded: number; total?: number }) {
  const pct = total && total > 0 ? Math.min(100, Math.round(downloaded / total * 100)) : null
  return (
    <>
      <div className="upd-progress"><div style={{ width: `${pct ?? 0}%` }} /></div>
      <div className="upd-downloading"><Loader2 size={14} className="spin" /> {pct !== null
        ? t('正在下载… {pct}%（{mb} / {total} MB）', { pct, mb: mb(downloaded), total: mb(total as number) })
        : t('正在下载… 已下载 {mb} MB', { mb: mb(downloaded) })}</div>
    </>
  )
}
