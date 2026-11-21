// ComfyUI 原生 API 适配：POST /prompt 提交工作流 → GET /history/{id} 查询结果 → GET /view 取图。
// ComfyUI 不提供 OpenAI 兼容 /v1/images/generations，必须走这套自己的协议。
// 桌面端通过 Rust comfyui_api 命令代理（绕 CORS + 二进制取图）；Web 端直连（可能受 CORS 限制）。

import type { ImageOptions } from './providerCall'

export interface ComfyResult {
  ok: boolean
  images: string[]   // data URL（本地取图后转）
  error?: string
  taskId?: string
}

export function isComfyUIBase(base: string): boolean {
  const b = base.toLowerCase()
  return /:8188\b|:8189\b|:8288\b|comfyui/.test(b)
}

/** UI 采样器显示名 → ComfyUI sampler_name 合法枚举值 */
export function comfySamplerName(sampler: string): string {
  const s = sampler.toLowerCase()
  if (s.includes('dpm++ 2m sde') || s.includes('dpmpp_2m_sde')) return 'dpmpp_2m_sde'
  if (s.includes('dpm++ 2m') || s.includes('dpmpp_2m')) return 'dpmpp_2m'
  if (s.includes('dpm++ sde')) return 'dpmpp_sde'
  if (s.includes('dpm')) return 'dpmpp_2m'
  if (s.includes('euler a') || s.includes('eulera')) return 'euler_ancestral'
  if (s.includes('euler')) return 'euler'
  if (s.includes('ddim')) return 'ddim'
  if (s.includes('unipc')) return 'uni_pc'
  if (s.includes('lms')) return 'lms'
  if (s.includes('heun')) return 'heun'
  return 'dpmpp_2m'
}

/** 构造一个标准的 SD txt2img 工作流（Checkpoint → CLIP 正负 → EmptyLatent → KSampler → VAE → SaveImage） */
export function buildTxt2ImgWorkflow(model: string, prompt: string, opts?: ImageOptions): Record<string, unknown> {
  const w = opts?.width ?? 1024
  const h = opts?.height ?? 1024
  const steps = opts?.steps ?? 20
  const cfg = opts?.cfgScale ?? 7
  const seed = opts?.seed ?? Math.floor(Math.random() * 4294967295)
  const sampler = opts?.sampler || 'DPM++ 2M Karras'
  const scheduler = /karras/i.test(sampler) ? 'karras' : 'normal'
  const samplerName = comfySamplerName(sampler)
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: model } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: opts?.negativePrompt ?? '', clip: ['1', 1] } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width: w, height: h, batch_size: opts?.n ?? 1 } },
    '5': {
      class_type: 'KSampler',
      inputs: {
        seed, steps, cfg, sampler_name: samplerName, scheduler,
        positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0], denoise: 1,
      },
    },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'acm_local' } },
  }
}

/** 构造 img2img 工作流（LoadImage → VAEEncode → KSampler denoise → VAEDecode → SaveImage）
 *  注意：源图需先通过 ComfyUI 的 /upload/image 上传，此处 base64 源图通过 data URI 传入由桥接处理。 */
export function buildImg2ImgWorkflow(model: string, prompt: string, imageName: string, opts?: ImageOptions): Record<string, unknown> {
  const wf = buildTxt2ImgWorkflow(model, prompt, opts) as Record<string, Record<string, unknown>>
  const steps = opts?.steps ?? 20
  const cfg = opts?.cfgScale ?? 7
  const seed = opts?.seed ?? Math.floor(Math.random() * 4294967295)
  const sampler = opts?.sampler || 'DPM++ 2M Karras'
  const scheduler = /karras/i.test(sampler) ? 'karras' : 'normal'
  const samplerName = comfySamplerName(sampler)
  return {
    '1': wf['1'], '2': wf['2'], '3': wf['3'],
    '4': { class_type: 'LoadImage', inputs: { image: imageName, upload: 'image' } },
    '5': { class_type: 'VAEEncode', inputs: { pixels: ['4', 0], vae: ['1', 2] } },
    '6': {
      class_type: 'KSampler',
      inputs: { seed, steps, cfg, sampler_name: samplerName, scheduler, positive: ['2', 0], negative: ['3', 0], latent_image: ['5', 0], denoise: opts?.strength ?? 0.7 },
    },
    '7': { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['1', 2] } },
    '8': { class_type: 'SaveImage', inputs: { images: ['7', 0], filename_prefix: 'acm_local_i2i' } },
  }
}

/** 调用桌面端 Rust comfyui_api 命令 */
async function invokeComfy(base: string, endpoint: string, method: string, body: unknown, wantImage: boolean): Promise<string> {
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<string> } }
  const invoke = w.__TAURI_INTERNALS__?.invoke
  if (!invoke) throw new Error('桌面接口不可用（ComfyUI 生图需在桌面客户端使用）')
  return invoke('comfyui_api', {
    baseUrl: base, endpoint, method,
    bodyJson: body ? JSON.stringify(body) : '', wantImage,
  })
}

/** Web 端直连 ComfyUI（localhost 通常允许，但跨域时可能失败） */
async function fetchComfy(base: string, endpoint: string, method: string, body: unknown, wantImage: boolean): Promise<string> {
  const res = await fetch(`${base.replace(/\/+$/, '')}/${endpoint.replace(/^\//, '')}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`ComfyUI 接口返回 ${res.status}`)
  if (wantImage) {
    const buf = await res.arrayBuffer()
    let bin = ''
    const bytes = new Uint8Array(buf)
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return `data:image/png;base64,${btoa(bin)}`
  }
  return res.text()
}

const isDesktop = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
const call = (base: string, endpoint: string, method: string, body: unknown, wantImage: boolean) =>
  isDesktop() ? invokeComfy(base, endpoint, method, body, wantImage) : fetchComfy(base, endpoint, method, body, wantImage)

/** 从 ComfyUI 实时 API 拉取可用 checkpoint 列表；失败返回空数组由调用方回退到扫目录 */
export async function fetchComfyCheckpoints(base: string): Promise<string[]> {
  try {
    const text = await call(base, 'object_info/CheckpointLoaderSimple', 'GET', undefined, false)
    const json = JSON.parse(text)
    const arr = json?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0]
    return Array.isArray(arr) ? arr.filter((x: unknown) => typeof x === 'string') : []
  } catch { return [] }
}

/** 提交工作流，返回 prompt_id */
export async function comfySubmit(base: string, workflow: Record<string, unknown>): Promise<string> {
  const clientId = `acm-${Date.now()}`
  const text = await call(base, 'prompt', 'POST', { prompt: workflow, client_id: clientId }, false)
  const json = JSON.parse(text)
  if (json.node_errors && Object.keys(json.node_errors).length) {
    const first = Object.values(json.node_errors)[0] as { errors?: { message?: string }[] }
    throw new Error(`工作流节点错误：${first?.errors?.[0]?.message ?? '参数不合法'}`)
  }
  const id = json.prompt_id
  if (!id) throw new Error(`ComfyUI 未返回任务 ID：${text.slice(0, 120)}`)
  return String(id)
}

/** 查询任务状态；完成时返回图片列表（data URL） */
export async function comfyPoll(base: string, promptId: string): Promise<{ done: boolean; images: string[]; status: string }> {
  const text = await call(base, `history/${encodeURIComponent(promptId)}`, 'GET', undefined, false)
  const json = JSON.parse(text)
  const entry = json[promptId]
  if (!entry) return { done: false, images: [], status: '排队中' }
  const status = String(entry.status?.status_str ?? entry.status ?? '')
  const outputs = entry.outputs ?? {}
  const images: string[] = []
  for (const node of Object.values(outputs) as { images?: { filename: string; subfolder?: string; type?: string }[] }[]) {
    for (const img of node.images ?? []) {
      const q = `view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder ?? '')}&type=${encodeURIComponent(img.type ?? 'output')}`
      const b64 = await call(base, q, 'GET', undefined, true)
      images.push(b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`)
    }
  }
  const done = /success|complete/i.test(status) || images.length > 0
  return { done, images, status: status || (images.length ? '完成' : '生成中') }
}

/** 上传图片到 ComfyUI（img2img 用），返回服务端文件名 */
export async function comfyUpload(base: string, dataUrl: string, name: string): Promise<string> {
  // ComfyUI /upload/image 需要 multipart/form-data；桌面端桥接目前只支持 JSON，
  // 因此这里在 Web 端用 FormData 直连；桌面端提示用户先手动上传。
  if (!dataUrl.startsWith('data:image/')) throw new Error('源图格式不正确')
  const blob = await (await fetch(dataUrl)).blob()
  const form = new FormData()
  form.append('image', blob, name)
  form.append('type', 'input')
  const res = await fetch(`${base.replace(/\/+$/, '')}/upload/image`, { method: 'POST', body: form })
  if (!res.ok) throw new Error(`上传源图失败（HTTP ${res.status}），桌面端请使用 OpenAI 兼容服务做图生图`)
  const json = await res.json()
  return String(json.name ?? name)
}

/** 一键生图：提交 → 轮询 → 取图。onProgress 回调用于驱动进度条。 */
export async function comfyGenerate(
  base: string, model: string, prompt: string, opts: ImageOptions | undefined,
  onProgress: (pct: number, label: string) => void,
  alive: () => boolean,
): Promise<ComfyResult> {
  try {
    let workflow: Record<string, unknown>
    if (opts?.sourceImage) {
      const name = await comfyUpload(base, opts.sourceImage, `acm_src_${Date.now()}.png`)
      workflow = buildImg2ImgWorkflow(model, prompt, name, opts)
    } else {
      workflow = buildTxt2ImgWorkflow(model, prompt, opts)
    }
    onProgress(25, '工作流已构造，正在提交…')
    const promptId = await comfySubmit(base, workflow)
    onProgress(40, '任务已提交，ComfyUI 排队中…')
    for (let i = 0; i < 60 && alive(); i++) {
      await new Promise(r => setTimeout(r, 2000))
      if (!alive()) return { ok: false, images: [], error: '已取消' }
      const r = await comfyPoll(base, promptId)
      if (r.images.length) return { ok: true, images: r.images, taskId: promptId }
      onProgress(Math.min(90, 40 + (i + 1) * 0.8), r.status || '生成中…')
      if (/error|fail|cancel/i.test(r.status)) return { ok: false, images: [], error: `ComfyUI 任务失败：${r.status}`, taskId: promptId }
      if (r.done && !r.images.length) return { ok: false, images: [], error: '任务完成但未找到输出图片（检查工作流 SaveImage 节点）', taskId: promptId }
    }
    return { ok: false, images: [], error: '等待超时（2 分钟），请到 ComfyUI 页面查看任务状态', taskId: promptId }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, images: [], error: `ComfyUI 调用失败：${msg}` }
  }
}
