import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Play, Heart, FolderPlus, X, ChevronLeft, ChevronRight, ExternalLink, Copy, Loader2, Image as ImageIcon, Film,
} from 'lucide-react'
import { loadStoragePrefs, storageDir } from '../core/storagePrefs'
import { isDesktopApp } from '../core/openExternal'
import { ToolShell } from './WorkshopView'

/**
 * AI 图库（v0.1.339，Ethan 拍板「两个都要」）：苹果照片式图库。
 * 默认看 AI 生成（数据存储·图像/视频文件夹，即生成自动保存的目录），可切换全部本地媒体
 * （来源文件夹可自行添加）。Rust gallery_scan 枚举文件，qlmanage 出缩略图，asset 协议播视频。
 * 仅桌面端（看的是本机文件）；文件夹与收藏只存本机。
 */
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'heic'])
const PLAY_VIDEO_EXTS = new Set(['mp4', 'mov', 'webm', 'm4v'])
const FOLDERS_KEY = 'acm.gallery.folders.v1'
const FAVS_KEY = 'acm.gallery.favs.v1'
const PHOTOS_ON_KEY = 'acm.gallery.photosLib'

interface GItem { path: string; name: string; size: number; mtime: number; kind: 'image' | 'video'; source: string; ai: boolean }
type GalView = 'ai' | 'all' | 'video' | 'fav'
type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
function getInvoke(): InvokeFn | null {
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke?: InvokeFn } }
  return w.__TAURI_INTERNALS__?.invoke ?? null
}
const extOf = (name: string) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : '' }
const baseName = (p: string) => p.split('/').pop() ?? p
function loadList(key: string): string[] {
  try { const v = JSON.parse(localStorage.getItem(key) ?? '[]'); return Array.isArray(v) ? v.filter(x => typeof x === 'string') : [] } catch { return [] }
}
function saveList(key: string, v: string[]) { try { localStorage.setItem(key, JSON.stringify(v)) } catch { /* 忽略 */ } }
const dayKeyOf = (secs: number) => { const d = new Date(secs * 1000); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` }
function dayLabelOf(secs: number): string {
  const now = Date.now() / 1000
  if (dayKeyOf(secs) === dayKeyOf(now)) return '今天'
  if (dayKeyOf(secs) === dayKeyOf(now - 86400)) return '昨天'
  const d = new Date(secs * 1000)
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}
const fmtSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(0)} KB` : `${n} B`)
const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export function GalleryView({ notify, onBack }: { notify: (msg: string) => void; onBack: () => void }) {
  const desktop = isDesktopApp()
  const mediaDir = useMemo(() => { try { return storageDir('media', loadStoragePrefs()) } catch { return null } }, [])
  const [folders, setFolders] = useState<string[]>(() => loadList(FOLDERS_KEY))
  const [photosDir, setPhotosDir] = useState<string | null>(null)
  const [photosOn, setPhotosOn] = useState(() => { try { return localStorage.getItem(PHOTOS_ON_KEY) !== '0' } catch { return true } })
  const [favs, setFavs] = useState<Set<string>>(() => new Set(loadList(FAVS_KEY)))
  const [items, setItems] = useState<GItem[]>([])
  const [scanning, setScanning] = useState(false)
  const [view, setView] = useState<GalView>(mediaDir ? 'ai' : 'all')
  const [zoom, setZoom] = useState<'s' | 'm' | 'l'>('m')
  const [limit, setLimit] = useState(300)
  const [lightbox, setLightbox] = useState<number | null>(null)
  const [thumbs, setThumbs] = useState<Map<string, string>>(new Map())
  const thumbBusy = useRef(new Set<string>())
  const [assetUrls, setAssetUrls] = useState<Map<string, string>>(new Map())
  const assetBusy = useRef(new Set<string>())
  const [hoverVideo, setHoverVideo] = useState<{ path: string; x: number; y: number } | null>(null)
  const hoverTimer = useRef<number | null>(null)

  const scan = useCallback(async () => {
    const invoke = getInvoke()
    if (!invoke) return
    setScanning(true)
    try {
      const sources: { dir: string; label: string; ai: boolean }[] = []
      if (mediaDir) sources.push({ dir: mediaDir, label: 'AI 生成', ai: true })
      if (photosDir && photosOn && photosDir !== mediaDir) sources.push({ dir: photosDir, label: '照片图库', ai: false })
      for (const f of folders) if (f !== mediaDir && f !== photosDir) sources.push({ dir: f, label: baseName(f), ai: false })
      const byPath = new Map<string, GItem>()
      for (const src of sources) {
        try {
          const raw = (await invoke('gallery_scan', { dir: src.dir })) as { path: string; size: number; mtime: number }[]
          for (const r of raw) {
            if (byPath.has(r.path)) continue
            const name = baseName(r.path)
            byPath.set(r.path, {
              path: r.path, name, size: r.size, mtime: r.mtime,
              kind: IMAGE_EXTS.has(extOf(name)) ? 'image' : 'video',
              source: src.label, ai: src.ai,
            })
          }
        } catch { /* 单个来源失败忽略 */ }
      }
      setItems([...byPath.values()].sort((a, b) => b.mtime - a.mtime))
    } finally { setScanning(false) }
  }, [folders, mediaDir, photosDir, photosOn])

  useEffect(() => { if (desktop) void scan() }, [desktop, scan])
  useEffect(() => {
    if (!desktop) return
    const invoke = getInvoke()
    if (!invoke) return
    void invoke('photos_library_dir').then(v => setPhotosDir(typeof v === 'string' ? v : null)).catch(() => {})
  }, [desktop])
  useEffect(() => { setLimit(300) }, [view])

  const filtered = useMemo(() => items.filter(i =>
    view === 'all' ? true : view === 'ai' ? i.ai : view === 'video' ? i.kind === 'video' : favs.has(i.path),
  ), [items, view, favs])
  const visible = filtered.slice(0, limit)
  const groups = useMemo(() => {
    const out: { key: string; label: string; entries: { item: GItem; idx: number }[] }[] = []
    visible.forEach(item => {
      const idx = filtered.indexOf(item)
      const key = dayKeyOf(item.mtime)
      const last = out[out.length - 1]
      if (last && last.key === key) last.entries.push({ item, idx })
      else out.push({ key, label: dayLabelOf(item.mtime), entries: [{ item, idx }] })
    })
    return out
  }, [visible, filtered])

  const ensureThumb = useCallback(async (path: string) => {
    if (thumbs.has(path) || thumbBusy.current.has(path)) return
    thumbBusy.current.add(path)
    try {
      const invoke = getInvoke()
      if (!invoke) return
      const url = (await invoke('media_thumb', { path })) as string
      if (url) setThumbs(prev => new Map(prev).set(path, url))
    } catch { /* 生成失败回落占位 */ } finally { thumbBusy.current.delete(path) }
  }, [thumbs])

  const ensureAssetUrl = useCallback(async (path: string) => {
    if (assetUrls.has(path) || assetBusy.current.has(path)) return
    assetBusy.current.add(path)
    try {
      const { convertFileSrc } = await import('@tauri-apps/api/core')
      setAssetUrls(prev => new Map(prev).set(path, convertFileSrc(path)))
    } catch { /* 非桌面端忽略 */ } finally { assetBusy.current.delete(path) }
  }, [assetUrls])

  const toggleFav = (path: string) => setFavs(prev => {
    const next = new Set(prev)
    if (next.has(path)) next.delete(path); else next.add(path)
    saveList(FAVS_KEY, [...next])
    return next
  })

  const addFolder = async () => {
    const invoke = getInvoke()
    if (!invoke) return
    try {
      const picked = (await invoke('choose_save_dir')) as string | null
      if (!picked || folders.includes(picked) || picked === mediaDir) return
      const next = [...folders, picked]
      setFolders(next)
      saveList(FOLDERS_KEY, next)
    } catch { /* 取消选择忽略 */ }
  }
  const removeFolder = (dir: string) => {
    const next = folders.filter(f => f !== dir)
    setFolders(next)
    saveList(FOLDERS_KEY, next)
  }

  const counts = useMemo(() => ({
    ai: items.filter(i => i.ai).length,
    all: items.length,
    video: items.filter(i => i.kind === 'video').length,
    fav: items.filter(i => favs.has(i.path)).length,
  }), [items, favs])

  if (!desktop) {
    return (
      <ToolShell title="AI 图库" desc="苹果照片式的本地图库：AI 生成与本地照片视频按日期浏览。" onBack={onBack}>
        <div className="ws-result">AI 图库看的是这台电脑上的本地文件，仅桌面端可用。</div>
      </ToolShell>
    )
  }

  const lbItem = lightbox !== null ? filtered[lightbox] : undefined

  return (
    <ToolShell title="AI 图库" desc="苹果照片式图库：默认看 AI 生成的图和视频，也能把任意本地文件夹加进来一起看。" onBack={onBack}>
      <div className="gal-wrap">
        <aside className="gal-side">
          {([
            { id: 'ai' as GalView, label: 'AI 生成', n: counts.ai },
            { id: 'all' as GalView, label: '全部媒体', n: counts.all },
            { id: 'video' as GalView, label: '视频', n: counts.video },
            { id: 'fav' as GalView, label: '收藏', n: counts.fav },
          ]).map(v => (
            <button key={v.id} className={`gal-side-it ${view === v.id ? 'on' : ''}`} onClick={() => setView(v.id)}>
              <span>{v.label}</span><span className="gal-side-n">{v.n}</span>
            </button>
          ))}
          <div className="gal-side-title">来源文件夹</div>
          {mediaDir
            ? <div className="gal-src"><span className="gal-dot ai" />生成保存目录<span className="gal-src-path">{mediaDir}</span></div>
            : <div className="gal-src-none">未设置生成保存目录（设置 → 数据存储），AI 生成视图暂为空</div>}
          {photosDir ? (
            <div className="gal-src">
              <span className="gal-dot" style={{ background: '#ff9500' }} />Mac 照片图库
              <button className={`gal-switch ${photosOn ? 'on' : ''}`} title={photosOn ? '点击关闭这个来源' : '点击启用这个来源'}
                onClick={() => { const next = !photosOn; setPhotosOn(next); try { localStorage.setItem(PHOTOS_ON_KEY, next ? '1' : '0') } catch { /* 忽略 */ } }}>
                <span className="gal-switch-dot" />
              </button>
              <span className="gal-src-path">{photosDir}</span>
            </div>
          ) : (
            <div className="gal-src-none">未找到 Mac 照片图库（图片文件夹下没有 .photoslibrary）</div>
          )}
          {folders.filter(f => f !== mediaDir).map(f => (
            <div key={f} className="gal-src">
              <span className="gal-dot" />{baseName(f)}
              <button className="gal-src-x" title="移除这个来源" onClick={() => removeFolder(f)}><X size={12} /></button>
              <span className="gal-src-path">{f}</span>
            </div>
          ))}
          <button className="btn sm ghost" style={{ alignSelf: 'flex-start', marginTop: 4 }} onClick={() => void addFolder()}>
            <FolderPlus size={13} /> 添加文件夹
          </button>
        </aside>

        <div className="gal-main">
          <div className="gal-bar">
            <span className="gal-bar-title">
              {view === 'ai' ? 'AI 生成' : view === 'all' ? '全部媒体' : view === 'video' ? '视频' : '收藏'}
              <small>{filtered.length} 项{scanning ? ' · 扫描中…' : ''}</small>
            </span>
            <span className="gal-zoom">
              {(['s', 'm', 'l'] as const).map(z => (
                <button key={z} className={zoom === z ? 'on' : ''} onClick={() => setZoom(z)}>{z === 's' ? '小' : z === 'm' ? '中' : '大'}</button>
              ))}
            </span>
          </div>

          {scanning && items.length === 0 && <div className="ws-result"><Loader2 size={16} className="spin" /> 正在扫描文件夹…</div>}
          {!scanning && filtered.length === 0 && (
            <div className="ws-result">
              {view === 'ai'
                ? '还没有 AI 生成保存下来的文件。生图/生视频后会自动存到生成保存目录，这里就会出现。'
                : view === 'fav' ? '还没有收藏。点开任意图片/视频，点爱心就能收进来。'
                  : '这个视图暂时是空的。点左侧「添加文件夹」把有照片视频的文件夹加进来。'}
            </div>
          )}

          {groups.map(g => (
            <div key={g.key}>
              <div className="gal-dhead">{g.label}<span>{g.entries.length} 项</span></div>
              <div className={`gal-grid z${zoom}`}>
                {g.entries.map(({ item, idx }) => (
                  <GalTile key={item.path} item={item} fav={favs.has(item.path)}
                    thumb={thumbs.get(item.path)} assetUrl={assetUrls.get(item.path)}
                    ensureThumb={ensureThumb} ensureAssetUrl={ensureAssetUrl}
                    onOpen={() => setLightbox(idx)}
                    onHoverVideo={(path, x, y) => {
                      if (hoverTimer.current) window.clearTimeout(hoverTimer.current)
                      hoverTimer.current = window.setTimeout(() => setHoverVideo({ path, x, y }), 200)
                    }}
                    onHoverEnd={() => {
                      if (hoverTimer.current) { window.clearTimeout(hoverTimer.current); hoverTimer.current = null }
                      setHoverVideo(null)
                    }} />
                ))}
              </div>
            </div>
          ))}
          {limit < filtered.length && (
            <button className="btn" style={{ alignSelf: 'center', marginTop: 14 }} onClick={() => setLimit(limit + 300)}>
              显示更多（已显示 {visible.length} / {filtered.length}）
            </button>
          )}
        </div>
      </div>

      {hoverVideo && assetUrls.get(hoverVideo.path) && (
        <video className="fm-hover-video" src={assetUrls.get(hoverVideo.path)} autoPlay muted loop playsInline
          style={{ left: hoverVideo.x, top: hoverVideo.y }} />
      )}

      {lbItem && (
        <GalLightbox item={lbItem} index={lightbox!} total={filtered.length} fav={favs.has(lbItem.path)}
          assetUrl={assetUrls.get(lbItem.path)} thumb={thumbs.get(lbItem.path)}
          ensureAssetUrl={ensureAssetUrl} ensureThumb={ensureThumb}
          onClose={() => setLightbox(null)}
          onNav={d => setLightbox(i => (i === null ? null : Math.min(filtered.length - 1, Math.max(0, i + d))))}
          onToggleFav={() => toggleFav(lbItem.path)}
          notify={notify} />
      )}
    </ToolShell>
  )
}

function GalTile({ item, fav, thumb, assetUrl, ensureThumb, ensureAssetUrl, onOpen, onHoverVideo, onHoverEnd }: {
  item: GItem
  fav: boolean
  thumb?: string
  assetUrl?: string
  ensureThumb: (p: string) => void
  ensureAssetUrl: (p: string) => void
  onOpen: () => void
  onHoverVideo: (path: string, x: number, y: number) => void
  onHoverEnd: () => void
}) {
  const [dur, setDur] = useState(0)
  const playable = item.kind === 'video' && PLAY_VIDEO_EXTS.has(extOf(item.name))
  useEffect(() => {
    if (item.kind === 'image' || !playable) ensureThumb(item.path)
    if (playable) ensureAssetUrl(item.path)
  }, [item.path, item.kind, playable, ensureThumb, ensureAssetUrl])

  return (
    <button className="gal-tile" onClick={onOpen}
      onMouseEnter={ev => {
        if (!playable) return
        ensureAssetUrl(item.path)
        const r = ev.currentTarget.getBoundingClientRect()
        onHoverVideo(item.path, Math.min(r.right + 10, window.innerWidth - 372), Math.max(8, r.top - 10))
      }}
      onMouseLeave={() => { if (playable) onHoverEnd() }}>
      {playable && assetUrl
        ? <video className="gal-media" src={assetUrl} preload="metadata" muted playsInline
            onLoadedMetadata={e => setDur(e.currentTarget.duration || 0)} />
        : thumb
          ? <img className="gal-media" src={thumb} alt={item.name} loading="lazy" />
          : <span className="gal-ph">{item.kind === 'video' ? <Film size={26} /> : <ImageIcon size={26} />}</span>}
      {item.kind === 'video' && (
        <span className="gal-bdg"><Play size={10} /> {dur > 0 ? fmtDur(dur) : '视频'}</span>
      )}
      {item.ai && <span className="gal-src-tag">AI</span>}
      {fav && <span className="gal-fav"><Heart size={12} fill="currentColor" /></span>}
    </button>
  )
}

function GalLightbox({ item, index, total, fav, assetUrl, thumb, ensureAssetUrl, ensureThumb, onClose, onNav, onToggleFav, notify }: {
  item: GItem
  index: number
  total: number
  fav: boolean
  assetUrl?: string
  thumb?: string
  ensureAssetUrl: (p: string) => void
  ensureThumb: (p: string) => void
  onClose: () => void
  onNav: (d: number) => void
  onToggleFav: () => void
  notify: (m: string) => void
}) {
  const playable = item.kind === 'video' && PLAY_VIDEO_EXTS.has(extOf(item.name))
  useEffect(() => {
    if (item.kind === 'image' || playable) ensureAssetUrl(item.path)
    else ensureThumb(item.path)
  }, [item.path, item.kind, playable, ensureAssetUrl, ensureThumb])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') onNav(-1)
      else if (e.key === 'ArrowRight') onNav(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onNav])

  const openExternal = async () => {
    const invoke = getInvoke()
    if (!invoke) return
    try { await invoke('open_external_path', { path: item.path }) } catch { notify('打开失败') }
  }

  return (
    <div className="gal-lb" onClick={onClose}>
      <div className="gal-lb-top" onClick={e => e.stopPropagation()}>
        <span>{index + 1} / {total} · {item.name}</span>
        <button className="gal-lb-x" onClick={onClose}><X size={18} /></button>
      </div>
      <button className="gal-lb-nav left" onClick={e => { e.stopPropagation(); onNav(-1) }} disabled={index <= 0}><ChevronLeft size={22} /></button>
      <div className="gal-lb-body" onClick={e => e.stopPropagation()}>
        {item.kind === 'image'
          ? (assetUrl
            ? <img className="gal-lb-media" src={assetUrl} alt={item.name} />
            : <div className="gal-lb-wait"><Loader2 size={20} className="spin" /> 加载中…</div>)
          : playable
            ? (assetUrl
              ? <video className="gal-lb-media" src={assetUrl} controls autoPlay />
              : <div className="gal-lb-wait"><Loader2 size={20} className="spin" /> 正在准备播放…</div>)
            : (thumb
              ? <img className="gal-lb-media" src={thumb} alt={item.name} />
              : <div className="gal-lb-wait">此格式应用内不能直接播放，点下方「打开」用系统播放器看</div>)}
      </div>
      <button className="gal-lb-nav right" onClick={e => { e.stopPropagation(); onNav(1) }} disabled={index >= total - 1}><ChevronRight size={22} /></button>
      <div className="gal-lb-bar" onClick={e => e.stopPropagation()}>
        <span className="gal-lb-info">
          {new Date(item.mtime * 1000).toLocaleString()} · {fmtSize(item.size)} · 来源：{item.source}
          <span className="gal-lb-path">{item.path}</span>
        </span>
        <span className="gal-lb-actions">
          <button className={`btn sm ${fav ? 'primary' : ''}`} onClick={onToggleFav}>
            <Heart size={13} fill={fav ? 'currentColor' : 'none'} /> {fav ? '已收藏' : '收藏'}
          </button>
          <button className="btn sm" onClick={() => void navigator.clipboard?.writeText(item.path).then(() => notify('路径已复制')).catch(() => {})}>
            <Copy size={13} /> 复制路径
          </button>
          <button className="btn sm" onClick={() => void openExternal()}><ExternalLink size={13} /> 打开</button>
        </span>
      </div>
    </div>
  )
}
