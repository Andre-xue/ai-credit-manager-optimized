// API Key 存放文件（v0.1.298）：把全部账户的 Key 写成一个清单文件，
// 放到用户在「设置 → 数据存储」里选的文件夹，Key 增删改后自动保持最新。
// 格式可选 md / Excel(xlsx) / json / txt / html；内容可选密文（保险箱密文，
// 无需解锁）或明文（需保险箱已解锁/提供主密码）。桌面端专用（写本机文件）。

import type { AppState } from './types'
import { isLocalProvider } from './types'
import { PROVIDER_MAP } from '../data/providers'
import { buildKeyBackup } from './keyBackup'
import { storageDir, type StoragePrefs } from './storagePrefs'

export interface ApiKeyRow {
  platform: string
  label: string
  key: string
  apiUrl: string
  note: string
  updatedAt: string
}

/** 收集要写入文件的 Key 行。明文模式必须给主密码（buildKeyBackup 内部解密）。 */
export async function collectApiKeyRows(state: AppState, mode: 'cipher' | 'plain', pwd?: string): Promise<ApiKeyRow[]> {
  const ids = state.accounts.filter(a => !isLocalProvider(a.providerId)).map(a => a.id)
  if (ids.length === 0) return []
  const backup = await buildKeyBackup(state, ids, mode, pwd)
  return backup.accounts.map(item => {
    const a = item.account
    return {
      platform: PROVIDER_MAP[a.providerId]?.name ?? a.providerId,
      label: a.label,
      key: mode === 'plain' ? (item.apiKey ?? '') : (a.encryptedKey ?? ''),
      apiUrl: a.apiUrl ?? '',
      note: a.note ?? '',
      updatedAt: a.updatedAt ?? '',
    }
  })
}

const escMd = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function apiKeyFileName(format: StoragePrefs['apikey']['format']): string {
  return `apikeys.${format}`
}

/** 把 Key 行序列化为 md / json / txt / html 文本（xlsx 走二进制路径） */
export function serializeApiKeyRows(rows: ApiKeyRow[], mode: 'cipher' | 'plain', format: 'md' | 'json' | 'txt' | 'html', now = new Date()): string {
  const stamp = now.toLocaleString('zh-CN', { hour12: false })
  const modeLabel = mode === 'plain' ? '明文' : '密文（保险箱加密，未解锁不可读）'
  if (format === 'json') {
    return JSON.stringify({ app: 'AI 积分管家', kind: 'apikey-storage', mode, exportedAt: now.toISOString(), keys: rows }, null, 2)
  }
  if (format === 'md') {
    const lines = [
      '# API Key 清单',
      '',
      `> 由 AI 积分管家自动维护 · ${modeLabel} · 更新于 ${stamp}`,
      '',
      '| 平台 | 名称 | API Key | 接口地址 | 备注 |',
      '| --- | --- | --- | --- | --- |',
      ...rows.map(r => `| ${escMd(r.platform)} | ${escMd(r.label)} | ${escMd(r.key)} | ${escMd(r.apiUrl)} | ${escMd(r.note)} |`),
      '',
    ]
    return lines.join('\n')
  }
  if (format === 'txt') {
    const lines = [
      'API Key 清单（AI 积分管家自动维护）',
      `形式：${modeLabel}`,
      `更新于：${stamp}`,
      '',
    ]
    rows.forEach((r, i) => {
      lines.push(`[${i + 1}] ${r.platform} · ${r.label}`)
      lines.push(`    API Key：${r.key}`)
      if (r.apiUrl) lines.push(`    接口地址：${r.apiUrl}`)
      if (r.note) lines.push(`    备注：${r.note}`)
      lines.push('')
    })
    return lines.join('\n')
  }
  // html：可直接双击打开的独立页面
  const trs = rows.map(r => `<tr><td>${escHtml(r.platform)}</td><td>${escHtml(r.label)}</td><td class="k">${escHtml(r.key)}</td><td>${escHtml(r.apiUrl)}</td><td>${escHtml(r.note)}</td></tr>`).join('\n')
  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN"><head><meta charset="utf-8"><title>API Key 清单</title>',
    '<style>body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:32px;color:#1f2023}h1{font-size:20px}table{border-collapse:collapse;width:100%;margin-top:16px}th,td{border:1px solid #d9dce3;padding:8px 10px;font-size:13px;text-align:left;vertical-align:top}th{background:#f2f3f7}.k{font-family:ui-monospace,Menlo,monospace;word-break:break-all}.meta{color:#667085;font-size:12.5px}</style>',
    '</head><body>',
    '<h1>API Key 清单</h1>',
    `<p class="meta">由 AI 积分管家自动维护 · ${escHtml(modeLabel)} · 更新于 ${escHtml(stamp)}</p>`,
    '<table><thead><tr><th>平台</th><th>名称</th><th>API Key</th><th>接口地址</th><th>备注</th></tr></thead>',
    `<tbody>\n${trs}\n</tbody></table>`,
    '</body></html>',
  ].join('\n')
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(bin)
}

export interface WriteApiKeyResult { ok: boolean; path?: string; error?: string }

/** 把 Key 清单文件写进数据存储的 apikey 目录。未启用/未选目录时返回错误说明。 */
export async function writeApiKeyStorageFile(state: AppState, prefs: StoragePrefs, pwd?: string): Promise<WriteApiKeyResult> {
  const dir = storageDir('apikey', prefs)
  if (!dir) return { ok: false, error: '数据存储未开启或未选择 API Key 存放文件夹' }
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke?: (c: string, a?: Record<string, unknown>) => Promise<unknown> } }
  const invoke = w.__TAURI_INTERNALS__?.invoke
  if (!invoke) return { ok: false, error: '仅桌面端可写入本机文件夹' }
  const { mode, format } = prefs.apikey
  if (mode === 'plain' && !pwd) return { ok: false, error: 'locked' }
  try {
    const rows = await collectApiKeyRows(state, mode, pwd)
    const filename = apiKeyFileName(format)
    if (format === 'xlsx') {
      const XLSX = await import('xlsx')
      const ws = XLSX.utils.json_to_sheet(rows.map(r => ({
        '平台': r.platform, '名称': r.label, 'API Key': r.key, '接口地址': r.apiUrl, '备注': r.note, '更新时间': r.updatedAt,
      })))
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, 'API Keys')
      const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
      const path = await invoke('write_binary_to_dir', { dir, filename, content_base64: bytesToBase64(new Uint8Array(out)) }) as string
      return { ok: true, path }
    }
    const content = serializeApiKeyRows(rows, mode, format)
    const path = await invoke('write_file_to_dir', { dir, filename, content }) as string
    return { ok: true, path }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) }
  }
}
