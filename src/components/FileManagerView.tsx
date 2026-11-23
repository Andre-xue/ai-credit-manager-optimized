import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft, Folder, File as FileIcon, Loader2, Plug, RefreshCw, Search, Copy,
  LayoutGrid, List as ListIcon, ChevronRight, Database, Sparkles,
} from 'lucide-react'
import type { Account } from '../core/types'
import { loadMcpServers, getMcpConnection, connectMcpServer, callMcpTool, MCP_EVENT, type McpServerConfig } from '../core/mcp'
import { isDesktopApp } from '../core/openExternal'
import { fetchLocalModels } from '../core/localServices'
import { filterEmbeddingModels, embedText } from '../core/docQA'
import {
  TEXT_EXTS, extOf, loadFileRecords, upsertFileRecord, indexFileText, searchFileIndex, fileChunksForQa,
  type FileSearchHit,
} from '../core/fileIndex'
import { runWorkshopChat } from '../core/workshopChat'
import { useRouteData, RouteSelect } from './WorkshopView'

interface Entry { name: string; isDir: boolean }

function findFilesystemServer(): McpServerConfig | null {
  const list = loadMcpServers()
  return list.find(s => (s.args ?? []).some(a => a.includes('server-filesystem'))) ?? null
}

function parseAllowedDirs(text: string): string[] {
  return text.split('\n').map(l => l.trim()).filter(l => l.startsWith('/'))
}

function parseListDir(text: string): Entry[] {
  const out: Entry[] = []
  for (const line of text.split('\n')) {
    const m = line.match(/^\[(DIR|FILE)\]\s+(.+)$/)
    if (m) out.push({ isDir: m[1] === 'DIR', name: m[2].trim() })
  }
  return out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
}

const joinPath = (dir: string, name: string) => (dir.endsWith('/') ? dir + name : `${dir}/${name}`)

/** 探测本机 Ollama 的嵌入模型（与文档问答同口径）；没有则返回 null，走关键词模式 */
async function detectEmbedModel(): Promise<{ base: string; model: string } | null> {
  try {
    const r = await fetchLocalModels('ollama', 'http://127.0.0.1:11434')
    if (!r.ok) return null
    const em = filterEmbeddingModels(r.models)
    return em.length ? { base: 'http://127.0.0.1:11434', model: em[0] } : null
  } catch { return null }
}

export function FileManagerView({ accounts, sessionPwd, notify, onBack }: {
  accounts: Account[]
  sessionPwd: string
  notify: (m: string) => void
  onBack: () => void
}) {
  const desktop = isDesktopApp()
  const [server, setServer] = useState<McpServerConfig | null>(() => findFilesystemServer())
  const [, setTick] = useState(0)
  const [roots, setRoots] = useState<string[]>([])
  const [cwd, setCwd] = useState('')
  const [entries, setEntries] = useState<Entry[]>([])
  const [loadingDir, setLoadingDir] = useState(false)
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')
  const [selected, setSelected] = useState<string>('')
  const [preview, setPreview] = useState('')
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [hits, setHits] = useState<FileSearchHit[]>([])
  const [answer, setAnswer] = useState('')
  const [indexing, setIndexing] = useState('')
  const { data: routeData, route, routeKey, setRouteKey } = useRouteData(accounts)

  const conn = server ? getMcpConnection(server.id) : null
  const ready = conn?.status === 'ready'

  useEffect(() => {
    const on = () => { setServer(findFilesystemServer()); setTick(x => x + 1) }
    window.addEventListener(MCP_EVENT, on)
    return () => window.removeEventListener(MCP_EVENT, on)
  }, [])

  const loadDir = useCallback(async (srv: McpServerConfig, path: string) => {
    setLoadingDir(true)
    try {
      const r = await callMcpTool(srv.id, 'list_directory', { path })
      if (r.isError) throw new Error(r.text)
      setEntries(parseListDir(r.text))
      setCwd(path)
      setSelected('')
      setPreview('')
    } catch (e) { notify(e instanceof Error ? e.message : '读取目录失败') } finally { setLoadingDir(false) }
  }, [notify])

  useEffect(() => {
    if (!server || !ready) return
    let dead = false
    void (async () => {
      try {
        const r = await callMcpTool(server.id, 'list_allowed_directories', {})
        if (dead || r.isError) return
        const dirs = parseAllowedDirs(r.text)
        setRoots(dirs)
        if (dirs.length && !cwd) void loadDir(server, dirs[0])
      } catch { /* 未连接时忽略 */ }
    })()
    return () => { dead = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server?.id, ready])

  const crumbs = useMemo(() => {
    if (!cwd) return []
    const parts = cwd.split('/').filter(Boolean)
    return parts.map((p, i) => ({ label: p, path: '/' + parts.slice(0, i + 1).join('/') }))
  }, [cwd])

  const openEntry = (e: Entry) => {
    if (!server) return
    const p = joinPath(cwd, e.name)
    if (e.isDir) { void loadDir(server, p); return }
    setSelected(p)
    setPreview('')
    if (TEXT_EXTS.has(extOf(e.name))) {
      void callMcpTool(server.id, 'read_text_file', { path: p }).then(r => {
        if (!r.isError) setPreview(r.text.slice(0, 6000))
      }).catch(() => {})
    }
  }

  /** 建立/更新索引：遍历放行目录登记文件，文本文件读内容建索引（有嵌入模型走语义，否则关键词） */
  const buildIndex = async () => {
    if (!server || !ready) { notify('先连接 Filesystem 服务'); return }
    setIndexing('正在探测嵌入模型…')
    const embed = await detectEmbedModel()
    const embedBase = embed?.base ?? ''
    const embedModel = embed?.model ?? ''
    const maxText = embedModel ? 150 : 400
    let seen = 0
    let indexedCount = 0
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 6 || seen > 3000) return
      let list: Entry[] = []
      try {
        const r = await callMcpTool(server.id, 'list_directory', { path: dir })
        if (r.isError) return
        list = parseListDir(r.text)
      } catch { return }
      for (const e of list) {
        const p = joinPath(dir, e.name)
        if (e.isDir) { await walk(p, depth + 1); continue }
        seen++
        const ext = extOf(e.name)
        const isText = TEXT_EXTS.has(ext)
        if (!isText) {
          upsertFileRecord({ path: p, name: e.name, ext, indexed: false, chunkCount: 0, indexedAt: 0 })
          continue
        }
        if (indexedCount >= maxText) continue
        try {
          const r = await callMcpTool(server.id, 'read_text_file', { path: p })
          if (r.isError || !r.text.trim()) continue
          await indexFileText({ path: p, text: r.text.slice(0, 60000), embedBase: embedBase || undefined, embedModel: embedModel || undefined })
          indexedCount++
          setIndexing(`正在建索引… 已登记 ${seen} 个文件，已索引 ${indexedCount} 个文本文件${embedModel ? '（语义）' : '（关键词）'}`)
        } catch { /* 单个文件失败跳过 */ }
      }
    }
    try {
      for (const root of roots) await walk(root, 0)
      setIndexing('')
      notify(`索引完成：登记 ${seen} 个文件，内容索引 ${indexedCount} 个${embedModel ? '（语义模式）' : '（关键词模式，未探测到嵌入模型）'}`)
    } catch (e) {
      setIndexing('')
      notify(e instanceof Error ? e.message : '建索引失败')
    }
  }

  const ask = async () => {
    const q = question.trim()
    if (!q) { notify('先输入问题'); return }
    if (!server || !ready) { notify('先连接 Filesystem 服务'); return }
    setAsking(true); setHits([]); setAnswer('')
    try {
      // 1) 文件名搜索（Filesystem 实时搜）
      const found: FileSearchHit[] = []
      const token = q.replace(/[？?。！!，,\s]+/g, ' ').split(' ').filter(Boolean).sort((a, b) => b.length - a.length)[0] ?? q
      for (const root of roots) {
        try {
          const r = await callMcpTool(server.id, 'search_files', { path: root, pattern: `*${token}*` })
          if (!r.isError) {
            for (const line of r.text.split('\n').map(l => l.trim()).filter(l => l.startsWith('/'))) {
              found.push({ path: line, name: line.split('/').pop() ?? line, score: 0.9, snippet: '文件名命中（实时搜索）', via: '文件名' })
            }
          }
        } catch { /* 单根失败忽略 */ }
      }
      // 2) 内容索引搜索（语义/关键词）
      let queryVector: number[] | undefined
      const embed = await detectEmbedModel()
      if (embed) {
        try { queryVector = await embedText(embed.base, embed.model, q) } catch { /* 降级关键词 */ }
      }
      const idxHits = await searchFileIndex({ query: q, queryVector, topK: 8 }).catch(() => [] as FileSearchHit[])
      const merged = new Map<string, FileSearchHit>()
      for (const h of [...found, ...idxHits]) {
        const cur = merged.get(h.path)
        if (!cur || h.score > cur.score) merged.set(h.path, h)
      }
      const list = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, 10)
      setHits(list)
      // 3) 有内容命中则让 AI 依据原文回答
      const qaChunks = await fileChunksForQa(q).catch(() => [])
      if (qaChunks.length && route) {
        const ctx = qaChunks.map((c, i) => `[${i + 1}] 文件：${c.path}\n${c.text}`).join('\n\n')
        const out = await runWorkshopChat({
          route, freeOptions: routeData?.freeOptions ?? [], accounts, sessionPwd,
          system: `你是文件管家助手。下面是从用户本地文件索引中检索到的原文片段：\n\n${ctx}\n\n依据片段回答问题，并注明出自哪个文件；片段里没有的不要编造，明确说明没找到。`,
          user: q,
        })
        setAnswer(out)
      } else if (!list.length) {
        notify('没找到相关文件（可先点「建立索引」扩大内容搜索范围）')
      }
    } catch (e) { notify(e instanceof Error ? e.message : '搜索失败') } finally { setAsking(false) }
  }

  const indexedCount = useMemo(() => loadFileRecords().filter(r => r.indexed).length, [indexing, hits])

  return (
    <div className="ws-tool fm">
      <button className="btn sm ghost" onClick={onBack}><ArrowLeft size={14} /> 返回工坊</button>
      <h3 className="ws-tool-title">文件管家</h3>
      <p className="ws-tool-desc">访达式浏览 + AI 问答 · 通过插件页的 Filesystem 服务访问你放行的目录，索引只存本机。</p>

      {!desktop && <div className="fm-note">文件管家依赖本地文件服务，仅桌面端可用。</div>}
      {desktop && !server && (
        <div className="fm-note">还没添加 Filesystem 服务。去「插件」页点预设「Filesystem 文件系统」添加并连接，再回来用文件管家。</div>
      )}
      {desktop && server && !ready && (
        <div className="fm-note">
          Filesystem 服务未连接。
          <button className="btn sm primary" style={{ marginLeft: 10 }} disabled={conn?.status === 'connecting'}
            onClick={() => void connectMcpServer(server).catch(e => notify(e instanceof Error ? e.message : '连接失败'))}>
            <Plug size={13} /> {conn?.status === 'connecting' ? '连接中…' : '连接'}
          </button>
        </div>
      )}

      {ready && (
        <>
          <div className="fm-ask">
            <Sparkles size={17} className="fm-ask-icon" />
            <input className="input" placeholder="问文件：迅雷装哪了？那份报价单里海运多少钱？" value={question}
              onChange={e => setQuestion(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void ask() }} />
            <RouteSelect data={routeData} routeKey={routeKey} setRouteKey={setRouteKey} />
            <button className="btn primary" disabled={asking} onClick={() => void ask()}>
              {asking ? <Loader2 size={15} className="spin" /> : <Search size={15} />} 问文件
            </button>
          </div>

          {(answer || hits.length > 0) && (
            <div className="fm-answer">
              {answer && <div className="fm-answer-text">{answer}</div>}
              <div className="fm-hits">
                {hits.map(h => (
                  <div key={h.path} className="fm-hit">
                    <div className="fm-hit-name">{h.name} <span className="fm-hit-via">{h.via} · {Math.round(h.score * 100)}%</span></div>
                    <div className="fm-hit-path">{h.path}</div>
                    <div className="fm-hit-snip">{h.snippet}</div>
                    <button className="btn sm ghost" onClick={() => void navigator.clipboard?.writeText(h.path).catch(() => {})}><Copy size={12} /> 复制路径</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="fm-window">
            <div className="fm-titlebar">
              <span className="fm-lights"><i style={{ background: '#ff5f57' }} /><i style={{ background: '#febc2e' }} /><i style={{ background: '#28c840' }} /></span>
              <div className="fm-crumbs">
                {crumbs.map((c, i) => (
                  <span key={c.path}>
                    {i > 0 && <ChevronRight size={12} className="fm-crumb-sep" />}
                    <button className="fm-crumb" onClick={() => server && void loadDir(server, c.path)}>{c.label}</button>
                  </span>
                ))}
              </div>
              <div className="fm-seg">
                <button className={viewMode === 'grid' ? 'on' : ''} onClick={() => setViewMode('grid')}><LayoutGrid size={13} /> 图标</button>
                <button className={viewMode === 'list' ? 'on' : ''} onClick={() => setViewMode('list')}><ListIcon size={13} /> 列表</button>
              </div>
              <button className="btn sm ghost" onClick={() => server && cwd && void loadDir(server, cwd)}><RefreshCw size={13} /></button>
            </div>
            <div className="fm-body">
              <div className="fm-side">
                <div className="fm-side-title">放行目录</div>
                {roots.map(r => (
                  <button key={r} className={`fm-side-item ${cwd.startsWith(r) ? 'on' : ''}`} onClick={() => server && void loadDir(server, r)}>
                    <Folder size={14} /> <span>{r.split('/').pop() || r}</span>
                  </button>
                ))}
                <div className="fm-side-title" style={{ marginTop: 14 }}>本地索引</div>
                <div className="fm-side-meta">已索引 {indexedCount} 个文本文件</div>
                <button className="btn sm" disabled={!!indexing} onClick={() => void buildIndex()}>
                  <Database size={13} /> {indexing ? '建索引中…' : '建立 / 更新索引'}
                </button>
                {indexing && <div className="fm-side-meta">{indexing}</div>}
              </div>
              <div className="fm-main">
                {loadingDir ? <div className="fm-empty"><Loader2 size={16} className="spin" /> 读取中…</div>
                  : entries.length === 0 ? <div className="fm-empty">这个文件夹是空的</div>
                    : viewMode === 'grid' ? (
                      <div className="fm-grid">
                        {entries.map(e => (
                          <button key={e.name} className={`fm-file ${selected === joinPath(cwd, e.name) ? 'sel' : ''}`}
                            onClick={() => openEntry(e)} onDoubleClick={() => openEntry(e)}>
                            {e.isDir ? <Folder size={38} className="fm-folder-ico" /> : <FileIcon size={34} className="fm-file-ico" />}
                            <span>{e.name}</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="fm-list">
                        {entries.map(e => (
                          <button key={e.name} className={`fm-row ${selected === joinPath(cwd, e.name) ? 'sel' : ''}`}
                            onClick={() => openEntry(e)} onDoubleClick={() => openEntry(e)}>
                            {e.isDir ? <Folder size={16} className="fm-folder-ico" /> : <FileIcon size={15} className="fm-file-ico" />}
                            <span>{e.name}</span>
                          </button>
                        ))}
                      </div>
                    )}
              </div>
              {selected && (
                <div className="fm-preview">
                  <div className="fm-pv-name">{selected.split('/').pop()}</div>
                  <div className="fm-pv-path">{selected}</div>
                  {preview
                    ? <pre className="fm-pv-text">{preview}</pre>
                    : <div className="fm-pv-meta">{TEXT_EXTS.has(extOf(selected)) ? '正在读取…' : '此类型暂不支持内容预览（文本文件可预览）'}</div>}
                  <button className="btn sm" onClick={() => void navigator.clipboard?.writeText(selected).catch(() => {})}><Copy size={12} /> 复制路径</button>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
