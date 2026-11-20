// AI 图像生成模块：用自有生图账户的 API Key 调用 OpenAI 兼容 /images/generations。
// 支持文生图参数（尺寸/数量/质量/风格），结果预览与下载，历史记录仅存本机 localStorage。

import { useEffect, useMemo, useState } from 'react'
import {
  Image as ImageIcon, Sparkles, Loader2, Download, Trash2, Info, KeyRound,
  ExternalLink, History, HardDrive, RefreshCw, ChevronDown,
} from 'lucide-react'
import { callImage, extractModelId, fetchProviderModels, filterMediaModels } from '../core/providerCall'
import { decryptSecret, getBiometricPassword } from '../core/crypto'
import { ModelInfoCard } from './ModelInfoCard'
import { GenProgressBar, useGenProgress } from './GenProgressBar'
import { SafeThumb } from './SafeThumb'
import { PROVIDER_MAP } from '../data/providers'
import { categoryFromNote } from '../core/modelCategories'
import {
  addHistory, clearHistory, loadHistory, newMediaId, removeHistory, saveMedia, errTextSafe, urlsToThumbs,
  type MediaHistoryItem,
} from '../core/mediaGeneration'
import { HoldToConfirm } from './HoldToConfirm'
import type { Account, AppSettings } from '../core/types'

const SIZES = ['1024x1024', '1536x1024', '1024x1536', '1792x1024', '512x512']
const QUALITIES = ['', 'standard', 'hd']
const STYLES = ['', 'vivid', 'natural']

export function ImageView({ accounts, sessionPwd, onUnlock, notify, onOpenLocal }: {
  accounts: Account[]; sessionPwd: string; onUnlock: (pwd: string) => void; notify: (m: string) => void; settings?: AppSettings; onOpenLocal?: () => void
}) {
  // 可用于生图的账户：严格按「备注/用途」分类筛选——只列出标记为「生图型」的账户
  const usable = useMemo(() => accounts
    .filter(a => !!a.encryptedKey && a.apiUrl && categoryFromNote(a.note) === '生图型'), [accounts])
  const [accountId, setAccountId] = useState('')
  const account = usable.find(a => a.id === accountId) ?? usable[0]

  // 云端账户：该 Key 实际可用的生图模型（从 /v1/models 拉取并筛选）
  const [cloudModels, setCloudModels] = useState<string[]>([])
  const [cloudModel, setCloudModel] = useState('')
  const [loadingCloudModels, setLoadingCloudModels] = useState(false)
  const loadCloudModels = async () => {
    const pwd = getBiometricPassword() || sessionPwd
    if (!account) { notify('请先选择账户'); return }
    if (!pwd) { notify('请先在主密码框解锁密钥库'); return }
    setLoadingCloudModels(true)
    try {
      const key = await decryptSecret(account.encryptedKey!, pwd)
      const all = await fetchProviderModels(account, key)
      const imgs = filterMediaModels(all, 'image')
      setCloudModels(imgs)
      setCloudModel(prev => imgs.includes(prev) ? prev : (imgs[0] ?? ''))
      notify(imgs.length ? `找到 ${imgs.length} 个生图模型（已从 ${all.length} 个模型中筛选）` : `该 Key 的 ${all.length} 个模型里未识别出生图模型`)
    } catch (e) { notify(`拉取模型失败：${errTextSafe(e)}`) }
    finally { setLoadingCloudModels(false) }
  }

  const [prompt, setPrompt] = useState('')
  const [size, setSize] = useState('1024x1024')
  const [quality, setQuality] = useState('')
  const [style, setStyle] = useState('')
  const [count, setCount] = useState(1)
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<string[]>([])
  const [lastNote, setLastNote] = useState('')
  const [pwdInput, setPwdInput] = useState('')
  const [history, setHistory] = useState<MediaHistoryItem[]>(() => loadHistory('image'))
  const [showHistory, setShowHistory] = useState(false)
  const { progress, start: startProgress, advance: advanceProgress, done: doneProgress, fail: failProgress } = useGenProgress()

  useEffect(() => { setHistory(loadHistory('image')) }, [])

  const model = account ? extractModelId(account) : ''
  const activeModel = cloudModel || model
  const needPwd = !!account && !!account.encryptedKey && !getBiometricPassword() && !sessionPwd

  const generate = async () => {
    if (!prompt.trim()) { notify('请先输入画面描述'); return }
    if (!account) { notify(onOpenLocal ? '请先在「API Key 管理」添加带生图 API 地址的账户；本地生图请点右上角「本地生成」' : '请先在「API Key 管理」添加带生图 API 地址的账户'); return }
    const pwd = getBiometricPassword() || sessionPwd
    if (!pwd) { notify('请先解锁密钥库（本页下方输入主密码）'); return }
    setBusy(true); setResults([]); setLastNote('')
    const startedAt = Date.now()
    startProgress('正在提交生成请求…')
    try {
      const opts = { size, n: count, quality: quality || undefined, style: style || undefined, model: cloudModel || undefined }
      advanceProgress(30, '服务商正在生成图片…')
      const r = await callImage(account, await decryptSecret(account.encryptedKey!, pwd), prompt.trim(), opts)
      if (!r.ok) { setLastNote(r.error ?? '生成失败'); failProgress('生成失败'); notify(r.error ?? '生成失败'); return }
      const secs = ((Date.now() - startedAt) / 1000).toFixed(1)
      doneProgress(`生成完成 · 耗时 ${secs}s`)
      const imgs = r.images ?? []
      const thumbs = await urlsToThumbs(imgs)
      // 抓取成功用本地副本预览（不依赖可能过期的远程链接），失败则回退原 URL
      setResults(imgs.map((u, i) => thumbs[i] || u))
      setLastNote(r.text)
      const params = [size, quality || '', style || '', `${count}张`].filter(Boolean).join(' · ')
      setHistory(addHistory('image', {
        id: newMediaId(), kind: 'image', prompt: prompt.trim(),
        accountLabel: account.label, model: activeModel, createdAt: Date.now(), results: imgs, thumbs, params,
      }))
      notify(imgs.length ? `已生成 ${imgs.length} 张图片` : r.text)
    } catch (e) {
      const msg = errTextSafe(e)
      setLastNote(msg); failProgress('生成失败'); notify(msg)
    } finally { setBusy(false) }
  }

  const download = async (url: string, idx: number) => {
    try {
      const loc = await saveMedia(url, 'image', `ai-image-${Date.now()}-${idx + 1}`)
      notify(`已保存：${loc}`)
    } catch (e) { notify((e as Error)?.message ?? '保存失败') }
  }

  const resetHistory = () => { clearHistory('image'); setHistory([]); notify('历史已清空') }

  return (
    <div className="set-content">
      <div className="gen-layout">
        {/* 左：生成控制 */}
        <section className="gen-panel">
          <div className="gen-panel-head"><span className="gen-head-icon"><ImageIcon size={18} /></span><div><h3>AI 图像生成</h3><p>输入画面描述，用你自己的生图账户生成图片</p></div>
            {onOpenLocal && <button className="btn sm ghost gen-local-entry" onClick={onOpenLocal} title="打开 SD 风格的本地生成页面"><HardDrive size={14} /> 本地生成</button>}
          </div>
          <div className="gen-body">
            <label className="gen-label">生图账户</label>
                {usable.length === 0 ? (
                  <div className="gen-empty-hint"><KeyRound size={16} /> 没有「生图型」账户。请到「API Key 管理」把对应账户的备注/用途分类设为生图型（备注以 [生图型] 开头），并确保已填 API 地址与密钥。</div>
                ) : (
                  <div className="gen-select-wrap">
                    <select className="input" value={account?.id ?? ''} onChange={e => { setAccountId(e.target.value); setCloudModels([]); setCloudModel('') }}>
                      {usable.map(a => <option key={a.id} value={a.id}>{a.label} · {PROVIDER_MAP[a.providerId]?.shortName ?? a.providerId}</option>)}
                    </select>
                    {account && <span className="gen-model-tag">从备注识别：{model || '未填（可点下方拉取自动选）'}</span>}
                  </div>
                )}
                <label className="gen-label" style={{ marginTop: 12 }}>生图模型（仅列出可生图模型）</label>
                <div className="gen-local-row">
                  {cloudModels.length > 0 ? (
                    <select className="input" value={cloudModel} onChange={e => setCloudModel(e.target.value)}>
                      {cloudModels.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                  ) : (
                    <input className="input" placeholder="点右侧拉取，或手填模型ID（如 Kwai-Kolors/Kolors）" value={cloudModel} onChange={e => setCloudModel(e.target.value)} />
                  )}
                  <button className="btn sm ghost" onClick={() => void loadCloudModels()} disabled={loadingCloudModels || !account} title="从平台拉取并筛选生图模型">
                    {loadingCloudModels ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} 拉取
                  </button>
                </div>
                <ModelInfoCard modelId={cloudModel || model} kind="image" />

            <label className="gen-label" style={{ marginTop: 15 }}>画面描述（Prompt）</label>
            <textarea className="input gen-prompt" rows={4} placeholder="例如：赛博朋克风格的城市夜景，霓虹灯倒映在雨后的街道，电影质感"
              value={prompt} onChange={e => setPrompt(e.target.value)} disabled={busy} />

            <div className="gen-grid-2">
              <div>
                <label className="gen-label">图片尺寸</label>
                <div className="gen-select-wrap">
                  <select className="input" value={size} onChange={e => setSize(e.target.value)} disabled={busy}>
                    {SIZES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <ChevronDown size={14} className="gen-select-chevron" />
                </div>
              </div>
              <div>
                <label className="gen-label">生成张数</label>
                <select className="input" value={count} onChange={e => setCount(Number(e.target.value))} disabled={busy}>
                  {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n} 张</option>)}
                </select>
              </div>
              <div>
                <label className="gen-label">质量（可选）</label>
                <select className="input" value={quality} onChange={e => setQuality(e.target.value)} disabled={busy}>
                  {QUALITIES.map(q => <option key={q} value={q}>{q || '默认'}</option>)}
                </select>
              </div>
              <div>
                <label className="gen-label">风格（可选）</label>
                <select className="input" value={style} onChange={e => setStyle(e.target.value)} disabled={busy}>
                  {STYLES.map(s => <option key={s} value={s}>{s || '默认'}</option>)}
                </select>
              </div>
            </div>

            {needPwd && (
              <div className="gen-pwd-gate">
                <Info size={14} /> 该账户密钥已加密，请输入主密码解锁本次会话：
                <div className="gen-pwd-row">
                  <input className="input" type="password" placeholder="主密码" value={pwdInput} onChange={e => setPwdInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && pwdInput) onUnlock(pwdInput) }} />
                  <button className="btn sm" disabled={!pwdInput} onClick={() => { onUnlock(pwdInput); setPwdInput('') }}>解锁</button>
                </div>
              </div>
            )}

            <button className="btn primary gen-generate" onClick={() => void generate()} disabled={busy || !prompt.trim() || !account}>
              {busy ? <><Loader2 size={16} className="spin" /> 正在生成…</> : <><Sparkles size={16} /> 生成图片</>}
            </button>
            <GenProgressBar progress={progress} />
            <div className="gen-tip"><Info size={13} /> <span>生图走账户 API 地址对应的 OpenAI 兼容 images/generations 接口；若平台为私有协议会返回错误提示。{onOpenLocal ? '本地生图请点右上角「本地生成」进入专业页面。' : ''}</span></div>
          </div>
        </section>

        {/* 右：结果 + 历史 */}
        <section className="gen-panel">
          <div className="gen-panel-head">
            <span className="gen-head-icon"><Sparkles size={18} /></span>
            <div><h3>生成结果</h3><p>{lastNote || '生成后的图片会显示在这里'}</p></div>
            <button className="btn sm ghost gen-hist-btn" onClick={() => setShowHistory(v => !v)}><History size={14} /> {showHistory ? '返回预览' : `历史 (${history.length})`}</button>
          </div>
          <div className="gen-body">
            {showHistory ? (
              <div className="gen-history">
                {history.length === 0 && <div className="gen-empty">暂无历史记录</div>}
                {history.map(h => (
                  <div className="gen-hist-item" key={h.id}>
                    <div className="gen-hist-top">
                      <span className="gen-hist-time">{new Date(h.createdAt).toLocaleString('zh-CN')}</span>
                      <HoldToConfirm title="删除" onConfirm={() => setHistory(removeHistory('image', h.id))} className="sm" />
                    </div>
                    <div className="gen-hist-prompt">{h.prompt}</div>
                    <div className="gen-hist-meta">{h.accountLabel} · {h.params}</div>
                    <div className="gen-thumbs">
                      {h.results.map((u, i) => <SafeThumb key={i} src={h.thumbs?.[i] || u} fallbackSrc={u} className="gen-thumb" onClick={() => window.open(u, '_blank', 'noopener')} />)}
                    </div>
                  </div>
                ))}
                {history.length > 0 && <button className="btn sm ghost" onClick={resetHistory}><Trash2 size={13} /> 清空历史</button>}
              </div>
            ) : results.length > 0 ? (
              <div className="gen-results">
                {results.map((u, i) => (
                  <div className="gen-result-card" key={i}>
                    {u.startsWith('data:') || /^https?:\/\//.test(u)
                      ? <img src={u} alt={`生成图片 ${i + 1}`} className="gen-result-img" />
                      : <div className="gen-result-text">{u}</div>}
                    <div className="gen-result-actions">
                      <a className="btn sm ghost" href={u} target="_blank" rel="noopener" title="在新窗口打开"><ExternalLink size={13} /> 打开</a>
                      <button className="btn sm ghost" onClick={() => void download(u, i)}><Download size={13} /> 下载</button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="gen-empty">
                <ImageIcon size={40} />
                <p>还没有生成图片</p>
                <span>在左侧输入画面描述，点击「生成图片」即可开始</span>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
