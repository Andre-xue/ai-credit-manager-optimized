import { useEffect, useRef, useState } from 'react'
import {
  FolderCog, FileText, Languages, PenLine, Image as ImageIcon, SearchCheck, Table2, Mic,
  ArrowLeft, Copy, Loader2, Upload, Hammer, ChevronRight, LayoutGrid,
} from 'lucide-react'
import type { Account } from '../core/types'
import { loadWorkshopRoutes, runWorkshopChat, type WorkshopRoute, type WorkshopRouteData } from '../core/workshopChat'
import { buildSearchContextCached } from '../core/webSearch'
import { needsBinaryParse, parseBinaryDocument } from '../core/documentParse'
import { FileManagerView } from './FileManagerView'

type ToolId = 'hub' | 'files' | 'summary' | 'polish' | 'webcheck' | 'table'

/** 工具页共用：加载可选对话路线（免费模型 + 自有账户） */
export function useRouteData(accounts: Account[]) {
  const [data, setData] = useState<WorkshopRouteData | null>(null)
  const [routeKey, setRouteKey] = useState('')
  useEffect(() => {
    let dead = false
    void loadWorkshopRoutes(accounts).then(d => {
      if (dead) return
      setData(d)
      setRouteKey(prev => (d.routes.some(r => r.key === prev) ? prev : d.routes[0]?.key ?? ''))
    })
    return () => { dead = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts.length])
  const route: WorkshopRoute | null = data?.routes.find(r => r.key === routeKey) ?? null
  return { data, route, routeKey, setRouteKey }
}

export function RouteSelect({ data, routeKey, setRouteKey }: { data: WorkshopRouteData | null; routeKey: string; setRouteKey: (k: string) => void }) {
  return (
    <label className="ws-route">
      <span>使用模型</span>
      <select className="select" value={routeKey} onChange={e => setRouteKey(e.target.value)} disabled={!data || data.routes.length === 0}>
        {!data && <option value="">加载中…</option>}
        {data && data.routes.length === 0 && <option value="">无可用模型（先在 AI 助手登录云账号或添加账户）</option>}
        {data?.routes.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
      </select>
    </label>
  )
}

function ToolShell({ title, desc, onBack, children }: { title: string; desc: string; onBack: () => void; children: React.ReactNode }) {
  return (
    <div className="ws-tool">
      <button className="btn sm ghost" onClick={onBack}><ArrowLeft size={14} /> 返回工坊</button>
      <h3 className="ws-tool-title">{title}</h3>
      <p className="ws-tool-desc">{desc}</p>
      {children}
    </div>
  )
}

function ResultBox({ text, busy }: { text: string; busy: boolean }) {
  if (busy) return <div className="ws-result"><Loader2 size={16} className="spin" /> 正在生成…</div>
  if (!text) return null
  return (
    <div className="ws-result">
      <div className="ws-result-head">
        <span>结果</span>
        <button className="btn sm ghost" onClick={() => void navigator.clipboard?.writeText(text).catch(() => {})}><Copy size={13} /> 复制</button>
      </div>
      <div className="ws-result-text">{text}</div>
    </div>
  )
}

async function readDocFile(file: File): Promise<string> {
  if (needsBinaryParse(file.name)) {
    const parsed = await parseBinaryDocument(file.name, await file.arrayBuffer())
    return parsed.text
  }
  return await file.text()
}

// ---------------- 文档总结 ----------------
function SummaryTool({ accounts, sessionPwd, notify, onBack }: ToolProps) {
  const { data, route, routeKey, setRouteKey } = useRouteData(accounts)
  const [docName, setDocName] = useState('')
  const [docText, setDocText] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const run = async () => {
    if (!route) { notify('先选一个可用模型'); return }
    if (!docText.trim()) { notify('先上传文档或粘贴文本'); return }
    setBusy(true); setResult('')
    try {
      const out = await runWorkshopChat({
        route, freeOptions: data?.freeOptions ?? [], accounts, sessionPwd,
        system: '你是文档总结助手。输出结构：一、摘要（3-5 句）；二、要点清单（条目式）；三、大纲（层级标题）。只依据文档内容，不编造。',
        user: `文档《${docName || '粘贴文本'}》内容如下：\n\n${docText.slice(0, 16000)}`,
      })
      setResult(out)
    } catch (e) { notify(e instanceof Error ? e.message : '生成失败') } finally { setBusy(false) }
  }

  return (
    <ToolShell title="文档总结" desc="上传 PDF / Word / 文本或直接粘贴长文，一键出摘要、要点和大纲。" onBack={onBack}>
      <RouteSelect data={data} routeKey={routeKey} setRouteKey={setRouteKey} />
      <div className="ws-actions">
        <button className="btn" onClick={() => fileRef.current?.click()}><Upload size={14} /> 上传文档</button>
        {docName && <span className="ws-fname">{docName}（{docText.length} 字）</span>}
        <input ref={fileRef} type="file" hidden accept=".pdf,.docx,.txt,.md,.csv" onChange={async e => {
          const f = e.target.files?.[0]; e.target.value = ''
          if (!f) return
          try { setDocText(await readDocFile(f)); setDocName(f.name) } catch { notify('文档解析失败') }
        }} />
      </div>
      <textarea className="input ws-textarea" rows={7} placeholder="或把文本粘贴到这里…" value={docName ? docText.slice(0, 4000) : docText} onChange={e => { setDocText(e.target.value); setDocName('') }} />
      <button className="btn primary" disabled={busy} onClick={() => void run()}>{busy ? <Loader2 size={15} className="spin" /> : <FileText size={15} />} 生成总结</button>
      <ResultBox text={result} busy={false} />
      {busy && <div className="ws-result"><Loader2 size={16} className="spin" /> 正在生成…</div>}
    </ToolShell>
  )
}

// ---------------- 文案润色 ----------------
const POLISH_MODES = ['润色改写', '扩写', '缩写', '更正式', '更口语', '纠错'] as const
function PolishTool({ accounts, sessionPwd, notify, onBack }: ToolProps) {
  const { data, route, routeKey, setRouteKey } = useRouteData(accounts)
  const [mode, setMode] = useState<(typeof POLISH_MODES)[number]>('润色改写')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')
  const run = async () => {
    if (!route) { notify('先选一个可用模型'); return }
    if (!text.trim()) { notify('先输入要处理的文案'); return }
    setBusy(true); setResult('')
    try {
      const out = await runWorkshopChat({
        route, freeOptions: data?.freeOptions ?? [], accounts, sessionPwd,
        system: '你是中文文案编辑。按用户要求处理文本，只输出处理后的正文，不要解释、不要加引号。',
        user: `处理方式：${mode}\n\n原文：\n${text.slice(0, 8000)}`,
      })
      setResult(out)
    } catch (e) { notify(e instanceof Error ? e.message : '处理失败') } finally { setBusy(false) }
  }
  return (
    <ToolShell title="文案润色" desc="改写、扩写、缩写、换语气、纠错——把草稿变成能直接发的成稿。" onBack={onBack}>
      <RouteSelect data={data} routeKey={routeKey} setRouteKey={setRouteKey} />
      <div className="ws-chips">
        {POLISH_MODES.map(m => <button key={m} className={`chip-btn ${mode === m ? 'on' : ''}`} onClick={() => setMode(m)}>{m}</button>)}
      </div>
      <textarea className="input ws-textarea" rows={7} placeholder="把草稿粘贴到这里…" value={text} onChange={e => setText(e.target.value)} />
      <button className="btn primary" disabled={busy} onClick={() => void run()}>{busy ? <Loader2 size={15} className="spin" /> : <PenLine size={15} />} 开始处理</button>
      <ResultBox text={result} busy={false} />
      {busy && <div className="ws-result"><Loader2 size={16} className="spin" /> 正在处理…</div>}
    </ToolShell>
  )
}

// ---------------- 联网核查 ----------------
function WebCheckTool({ accounts, sessionPwd, notify, onBack }: ToolProps) {
  const { data, route, routeKey, setRouteKey } = useRouteData(accounts)
  const [claim, setClaim] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')
  const [sources, setSources] = useState<{ title: string; url: string }[]>([])
  const run = async () => {
    if (!route) { notify('先选一个可用模型'); return }
    if (!claim.trim()) { notify('先输入要核查的说法'); return }
    setBusy(true); setResult(''); setSources([])
    try {
      const ctx = await buildSearchContextCached(claim.trim())
      if (!ctx) { notify('没搜到相关资料，换个说法试试'); return }
      setSources(ctx.sources)
      const out = await runWorkshopChat({
        route, freeOptions: data?.freeOptions ?? [], accounts, sessionPwd,
        system: `你是事实核查员。下面是联网搜索到的资料：\n\n${ctx.block}\n\n核查要求：只依据资料判断，给出结论（属实 / 不实 / 证据不足），引用资料编号说明依据；资料没有提到的明确说证据不足，不许猜测。`,
        user: `核查这句话：${claim.trim()}`,
      })
      setResult(out)
    } catch (e) { notify(e instanceof Error ? e.message : '核查失败') } finally { setBusy(false) }
  }
  return (
    <ToolShell title="联网核查" desc="给一句话或一条消息，AI 联网搜证核实真假并附来源——聊天里联网搜索的独立版。" onBack={onBack}>
      <RouteSelect data={data} routeKey={routeKey} setRouteKey={setRouteKey} />
      <textarea className="input ws-textarea" rows={3} placeholder="例如：小米 SU8 汽车下个月上市，起售价 19 万" value={claim} onChange={e => setClaim(e.target.value)} />
      <button className="btn primary" disabled={busy} onClick={() => void run()}>{busy ? <Loader2 size={15} className="spin" /> : <SearchCheck size={15} />} 开始核查</button>
      <ResultBox text={result} busy={false} />
      {busy && <div className="ws-result"><Loader2 size={16} className="spin" /> 正在联网核查…</div>}
      {sources.length > 0 && (
        <div className="ws-sources">
          <div>📎 信息来源</div>
          {sources.map((s, i) => <div key={i}>[{i + 1}] {s.title}</div>)}
        </div>
      )}
    </ToolShell>
  )
}

// ---------------- 表格问答 ----------------
function TableTool({ accounts, sessionPwd, notify, onBack }: ToolProps) {
  const { data, route, routeKey, setRouteKey } = useRouteData(accounts)
  const [tableName, setTableName] = useState('')
  const [tableText, setTableText] = useState('')
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const run = async () => {
    if (!route) { notify('先选一个可用模型'); return }
    if (!tableText.trim()) { notify('先上传表格文件'); return }
    if (!question.trim()) { notify('先输入问题'); return }
    setBusy(true); setResult('')
    try {
      const out = await runWorkshopChat({
        route, freeOptions: data?.freeOptions ?? [], accounts, sessionPwd,
        system: '你是表格数据分析助手。只依据给出的表格数据回答，给出具体数字与计算过程；数据里没有的明确说明。',
        user: `表格《${tableName}》内容（CSV/文本）：\n\n${tableText.slice(0, 14000)}\n\n问题：${question.trim()}`,
      })
      setResult(out)
    } catch (e) { notify(e instanceof Error ? e.message : '回答失败') } finally { setBusy(false) }
  }
  return (
    <ToolShell title="表格问答" desc="把 CSV / 文本表格丢进来，用问话查数、汇总、找异常，不用写公式。" onBack={onBack}>
      <RouteSelect data={data} routeKey={routeKey} setRouteKey={setRouteKey} />
      <div className="ws-actions">
        <button className="btn" onClick={() => fileRef.current?.click()}><Upload size={14} /> 上传表格（CSV / TXT）</button>
        {tableName && <span className="ws-fname">{tableName}（{tableText.length} 字）</span>}
        <input ref={fileRef} type="file" hidden accept=".csv,.txt,.tsv,.md" onChange={async e => {
          const f = e.target.files?.[0]; e.target.value = ''
          if (!f) return
          try { setTableText(await f.text()); setTableName(f.name) } catch { notify('读取失败') }
        }} />
      </div>
      <input className="input" placeholder="例如：哪个月销售额最高？华东区合计多少？" value={question} onChange={e => setQuestion(e.target.value)} />
      <button className="btn primary" disabled={busy} onClick={() => void run()}>{busy ? <Loader2 size={15} className="spin" /> : <Table2 size={15} />} 提问</button>
      <ResultBox text={result} busy={false} />
      {busy && <div className="ws-result"><Loader2 size={16} className="spin" /> 正在分析…</div>}
    </ToolShell>
  )
}

interface ToolProps {
  accounts: Account[]
  sessionPwd: string
  notify: (m: string) => void
  onBack: () => void
}

// ---------------- 工坊主页 ----------------
export function WorkshopView({ accounts, sessionPwd, notify, onOpenTab }: {
  accounts: Account[]
  sessionPwd: string
  notify: (m: string) => void
  onOpenTab: (tab: string) => void
}) {
  const [tool, setTool] = useState<ToolId>('hub')
  const back = () => setTool('hub')
  const toolProps: ToolProps = { accounts, sessionPwd, notify, onBack: back }

  if (tool === 'files') return <FileManagerView accounts={accounts} sessionPwd={sessionPwd} notify={notify} onBack={back} />
  if (tool === 'summary') return <SummaryTool {...toolProps} />
  if (tool === 'polish') return <PolishTool {...toolProps} />
  if (tool === 'webcheck') return <WebCheckTool {...toolProps} />
  if (tool === 'table') return <TableTool {...toolProps} />

  const groups: { title: string; sub: string; cards: { id: string; name: string; desc: string; tag: string; tagClass?: string; grad: string; icon: React.ReactNode; action: () => void; isNew?: boolean }[] }[] = [
    {
      title: '文档与文件', sub: '找、读、理',
      cards: [
        { id: 'files', name: '文件管家', desc: '访达式浏览你的文件夹，本地索引加持，一句话找到文件、读出内容、直接预览。', tag: '本地索引', tagClass: 'local', grad: 'g1', icon: <FolderCog size={21} />, action: () => setTool('files'), isNew: true },
        { id: 'summary', name: '文档总结', desc: '丢进 PDF / Word / 长文，一键出摘要、要点清单和大纲。', tag: '文档解析', grad: 'g2', icon: <FileText size={21} />, action: () => setTool('summary') },
        { id: 'translate', name: '全文翻译', desc: '整篇文档或粘贴文本翻译，保留段落结构，可双语对照。', tag: '已有能力', grad: 'g5', icon: <Languages size={21} />, action: () => onOpenTab('benefits') },
      ],
    },
    {
      title: '创作生成', sub: '写、画、说',
      cards: [
        { id: 'polish', name: '文案润色', desc: '改写、扩写、缩写、换语气——把草稿变成能直接发的成稿。', tag: '免费模型可用', tagClass: 'free', grad: 'g3', icon: <PenLine size={21} />, action: () => setTool('polish') },
        { id: 'image', name: 'AI 绘画', desc: '云端与本地 ComfyUI 生图都在这里，生成完自动存进你的文件夹。', tag: '已有能力', grad: 'g6', icon: <ImageIcon size={21} />, action: () => onOpenTab('image') },
        { id: 'voice', name: '语音转写', desc: '录音、会议音频转文字稿——本地 whisper 引擎制作中，下一批上架。', tag: '第二批', grad: 'g4', icon: <Mic size={21} />, action: () => notify('语音转写在第二批：本地 whisper 引擎接入中') },
      ],
    },
    {
      title: '效率助理', sub: '杂活自动化',
      cards: [
        { id: 'webcheck', name: '联网核查', desc: '给一句话或一条消息，AI 联网搜证核实真假并附来源。', tag: '免 Key 搜索', tagClass: 'free', grad: 'g2', icon: <SearchCheck size={21} />, action: () => setTool('webcheck') },
        { id: 'table', name: '表格问答', desc: '把 CSV 丢进来，用问话查数、汇总、找异常，不用写公式。', tag: '文档解析', grad: 'g1', icon: <Table2 size={21} />, action: () => setTool('table') },
        { id: 'catalog', name: 'AI 工具大全', desc: '各平台 AI 工具目录与签到入口汇总，原侧边栏入口已并入工坊。', tag: '导航目录', grad: 'g4', icon: <LayoutGrid size={21} />, action: () => onOpenTab('checkin') },
      ],
    },
  ]

  return (
    <div className="ws-hub">
      <div className="ws-head">
        <div className="ws-title"><span className="ws-logo"><Hammer size={18} /></span>AI 工坊</div>
        <p className="ws-subtitle">每个工具一个独立页面，点开即用 · 用的都是你已配置的模型与账户</p>
      </div>
      {groups.map(g => (
        <div key={g.title}>
          <div className="ws-group-title">{g.title} <small>{g.sub}</small></div>
          <div className="ws-grid">
            {g.cards.map(c => (
              <button key={c.id} className="ws-card" onClick={c.action}>
                {c.isNew && <span className="ws-new">NEW</span>}
                <span className={`ws-tico ${c.grad}`}>{c.icon}</span>
                <span className="ws-tname">{c.name}</span>
                <span className="ws-tdesc">{c.desc}</span>
                <span className="ws-tfoot">
                  <span className={`ws-tag ${c.tagClass ?? ''}`}>{c.tag}</span>
                  <span className="ws-open">打开 <ChevronRight size={13} /></span>
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
