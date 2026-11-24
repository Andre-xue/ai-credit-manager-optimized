// 工坊 · Steam 降价（v0.1.399）：Steam 商店当前打折游戏，按折扣排序。
// 数据来源：Steam 商店公开接口（免 Key），价格以 Steam 返回的为准，不编造；
// 拉不到时明确显示原因，不静默兜底。样式沿用免费游戏卡片（fg-card 系）与看剧 chips。
import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, Gamepad2, Loader2, RefreshCw, TriangleAlert } from 'lucide-react'
import { ToolShell } from './WorkshopView'
import { Pager } from './Pager'
import {
  loadSteamCache, isSteamCacheFresh, loadSteamDeals, loadMoreSteamDeals,
  sortSteamDeals,
  type SteamDeal, type SteamDealsCache, type SteamSort,
} from '../core/steamDeals'
import { openExternal } from '../core/openExternal'

const PAGE_SIZE = 12

const SORTS: { key: SteamSort; label: string }[] = [
  { key: 'discount', label: '折扣最高' },
  { key: 'review', label: '好评最高' },
  { key: 'price', label: '价格最低' },
]

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function DealCard({ deal }: { deal: SteamDeal }) {
  const [imgOk, setImgOk] = useState(true)
  return (
    <div className="sd-card" role="button" tabIndex={0} title="点击直达 Steam 商店页面"
      onClick={() => void openExternal(deal.url)}
      onKeyDown={e => { if (e.key === 'Enter') void openExternal(deal.url) }}>
      <div className="sd-cover">
        {deal.imageUrl && imgOk
          ? <img src={deal.imageUrl} alt={deal.title} loading="lazy" onError={() => setImgOk(false)} />
          : <span className="sd-cover-fallback"><Gamepad2 size={26} /></span>}
        <span className="sd-badge">-{deal.discountPct}%</span>
      </div>
      <div className="sd-card-body">
        <div className="sd-card-title">{deal.title}</div>
        <div className="sd-card-meta">
          {deal.originalPrice && <s>{deal.originalPrice}</s>} <b className="sd-price">{deal.finalPrice}</b>
        </div>
        <div className="sd-card-meta">
          {deal.reviewPct !== undefined
            ? <span>好评率 {deal.reviewPct}%{deal.reviewLabel ? ` · ${deal.reviewLabel}` : ''}{deal.reviewCount !== undefined ? `（${deal.reviewCount.toLocaleString('zh-CN')} 篇评测）` : ''}</span>
            : <span>暂无评价</span>}
          {deal.released && <span> · {deal.released} 发售</span>}
        </div>
        <div className="sd-card-foot">
          <span className="fg-open"><ExternalLink size={12} /> 直达 Steam 商店</span>
        </div>
      </div>
    </div>
  )
}

export function SteamDealsTool({ notify, onBack }: {
  notify: (m: string, kind?: 'ok' | 'err') => void
  onBack: () => void
}) {
  const [cache, setCache] = useState<SteamDealsCache | null>(() => loadSteamCache())
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sort, setSort] = useState<SteamSort>('discount')
  const [page, setPage] = useState(1)

  const refresh = async (force = false) => {
    setLoading(true)
    setError(null)
    try {
      const c = await loadSteamDeals(force)
      setCache(c)
      setPage(1)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      notify(msg, 'err')
    } finally {
      setLoading(false)
    }
  }

  // 首屏：缓存新鲜（1 小时内）直接用，否则拉第一页
  useEffect(() => {
    const cached = loadSteamCache()
    if (cached && isSteamCacheFresh(cached)) return
    void refresh(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sorted = useMemo(() => (cache ? sortSteamDeals(cache.items, sort) : []), [cache, sort])
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount)
  const pageItems = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)
  const hasMore = !!cache && cache.items.length < cache.total

  const loadMore = async () => {
    setLoadingMore(true)
    try {
      const c = await loadMoreSteamDeals()
      setCache(c)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      notify(msg, 'err')
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <ToolShell title="Steam 降价" desc="Steam 商店当前打折游戏：折扣、现价、原价、好评率，按折扣排序；大促期间列表更长，平时也有常驻折扣。" onBack={onBack}>
      <div className="sd-bar">
        <div className="wt-chips" role="tablist" aria-label="排序">
          {SORTS.map(s => (
            <button key={s.key} className={`wt-chip ${sort === s.key ? 'on' : ''}`}
              onClick={() => { setSort(s.key); setPage(1) }}>{s.label}</button>
          ))}
        </div>
        <button className="btn sm ghost" disabled={loading} onClick={() => void refresh(true)}>
          {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} 刷新
        </button>
      </div>

      {cache && (
        <div className="sd-source">
          数据来源：Steam 商店公开接口（免 Key）· 更新于 {fmtTime(cache.at)}
          · Steam 当前共 {cache.total.toLocaleString('zh-CN')} 款打折中，已拉 {cache.items.length} 款
        </div>
      )}

      {loading && !cache && (
        <div className="fg-empty"><Loader2 size={14} className="spin" /> 正在拉 Steam 打折列表…</div>
      )}

      {error && !cache && (
        <div className="fg-empty" style={{ borderColor: 'rgba(220,38,38,.4)' }}>
          <TriangleAlert size={14} color="#dc2626" />
          <span>{error}</span>
          <button className="btn sm primary" disabled={loading} onClick={() => void refresh(true)}>重试</button>
        </div>
      )}

      {error && cache && (
        <div className="fg-empty" style={{ borderColor: 'rgba(220,38,38,.4)' }}>
          <TriangleAlert size={14} color="#dc2626" />
          <span>刷新失败，显示的是上次拉到的数据：{error}</span>
        </div>
      )}

      {cache && pageItems.length === 0 && !loading && (
        <div className="fg-empty">Steam 当前没有打折游戏（或返回为空），过会儿再刷新看看。</div>
      )}

      {pageItems.length > 0 && (
        <div className="sd-grid">
          {pageItems.map(d => <DealCard key={d.appid} deal={d} />)}
        </div>
      )}

      {cache && sorted.length > PAGE_SIZE && (
        <Pager page={safePage} pageCount={pageCount} total={sorted.length} unit="款" onPage={setPage} />
      )}

      {cache && hasMore && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 10 }}>
          <button className="btn" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? <Loader2 size={14} className="spin" /> : null} 加载更多（已拉 {cache.items.length} / {cache.total.toLocaleString('zh-CN')} 款）
          </button>
        </div>
      )}
    </ToolShell>
  )
}
