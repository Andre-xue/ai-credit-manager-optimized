// 更新下载进度呈现（v0.1.495）：手动更新弹窗与后台下载悬浮卡共用同一份——
// 进度条 + 百分比 + 已下载/总大小。总大小未知（源站未给长度）时只报已下载量，
// 不拿 0% 假条糊弄。样式复用 .upd-progress / .upd-downloading。
// v0.1.498：带 startedAt 时每秒自刷新——下载超过 5 秒必须有确定呈现：有字节
// 就报已下载量+速率，一个字节都没来就明说「正在连接…已等待 N 秒」，禁止
// 只剩一个无限转的菊花（2026-11-27 真机投诉原样）。
import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { t } from '../core/i18n'

const mb = (bytes: number) => Math.round(bytes / 1024 / 1024 * 10) / 10

export function UpdateProgressBar({ downloaded, total, startedAt }: { downloaded: number; total?: number; startedAt?: number }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!startedAt) return
    const id = setInterval(() => setTick(x => x + 1), 1000)
    return () => clearInterval(id)
  }, [startedAt])
  const pct = total && total > 0 ? Math.min(100, Math.round(downloaded / total * 100)) : null
  const elapsedSec = startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0
  const rate = startedAt && elapsedSec >= 2 && downloaded > 0 ? mb(downloaded / elapsedSec) : null
  let text: string
  if (pct !== null) {
    text = t('正在下载… {pct}%（{mb} / {total} MB）', { pct, mb: mb(downloaded), total: mb(total as number) })
    if (rate !== null) text += t(' · 约 {rate} MB/s', { rate })
  } else if (downloaded > 0) {
    text = t('正在下载… 已下载 {mb} MB', { mb: mb(downloaded) })
    if (rate !== null) text += t(' · 约 {rate} MB/s', { rate })
  } else if (startedAt && elapsedSec >= 5) {
    text = t('正在连接更新服务器…已等待 {sec} 秒', { sec: elapsedSec })
  } else {
    text = t('正在下载… 已下载 {mb} MB', { mb: 0 })
  }
  return (
    <>
      <div className="upd-progress"><div style={{ width: `${pct ?? 0}%` }} /></div>
      <div className="upd-downloading"><Loader2 size={14} className="spin" /> {text}</div>
    </>
  )
}
