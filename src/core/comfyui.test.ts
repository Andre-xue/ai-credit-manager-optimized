import { describe, expect, it } from 'vitest'
import { isComfyUIBase, buildTxt2ImgWorkflow, buildImg2ImgWorkflow, buildAnimateDiffWorkflow } from './comfyui'

describe('ComfyUI 原生协议适配', () => {
  it('按地址识别 ComfyUI（8188 端口或域名含 comfyui）', () => {
    expect(isComfyUIBase('http://127.0.0.1:8188')).toBe(true)
    expect(isComfyUIBase('http://localhost:8188/')).toBe(true)
    expect(isComfyUIBase('http://192.168.1.5:8188/comfyui')).toBe(true)
    expect(isComfyUIBase('http://127.0.0.1:11434')).toBe(false)
    expect(isComfyUIBase('http://127.0.0.1:8080')).toBe(false)
  })

  it('txt2img 工作流包含完整节点链与正确参数', () => {
    const wf = buildTxt2ImgWorkflow('v1-5.safetensors', 'a cat', {
      width: 768, height: 512, steps: 25, cfgScale: 8, seed: 123,
      sampler: 'DPM++ 2M Karras', negativePrompt: 'blurry', n: 2,
    }) as Record<string, { class_type: string; inputs: Record<string, unknown> }>
    expect(wf['1'].class_type).toBe('CheckpointLoaderSimple')
    expect(wf['1'].inputs.ckpt_name).toBe('v1-5.safetensors')
    expect(wf['2'].inputs.text).toBe('a cat')
    expect(wf['3'].inputs.text).toBe('blurry')
    expect(wf['4'].inputs).toMatchObject({ width: 768, height: 512, batch_size: 2 })
    expect(wf['5'].inputs).toMatchObject({ seed: 123, steps: 25, cfg: 8, sampler_name: 'dpmpp_2m', scheduler: 'karras' })
    expect(wf['5'].inputs.positive).toEqual(['2', 0])
    expect(wf['6'].class_type).toBe('VAEDecode')
    expect(wf['7'].class_type).toBe('SaveImage')
  })

  it('Euler 采样器去掉 Karras 后缀并用 normal 调度', () => {
    const wf = buildTxt2ImgWorkflow('m.safetensors', 'x', { sampler: 'Euler' }) as Record<string, { inputs: Record<string, unknown> }>
    expect(wf['5'].inputs.sampler_name).toBe('euler')
    expect(wf['5'].inputs.scheduler).toBe('normal')
  })

  it('img2img 工作流用 LoadImage + VAEEncode + denoise 强度', () => {
    const wf = buildImg2ImgWorkflow('m.safetensors', 'a cat', 'src.png', { strength: 0.55, seed: 9 }) as Record<string, { class_type: string; inputs: Record<string, unknown> }>
    expect(wf['4'].class_type).toBe('LoadImage')
    expect(wf['4'].inputs.image).toBe('src.png')
    expect(wf['5'].class_type).toBe('VAEEncode')
    expect(wf['6'].inputs.denoise).toBe(0.55)
    expect(wf['6'].inputs.seed).toBe(9)
    expect(wf['8'].class_type).toBe('SaveImage')
  })
})

describe('AnimateDiff 工作流构造', () => {
  const wf = buildAnimateDiffWorkflow('checkpoints/AnythingV5V3.safetensors', 'mm_sd_v15_v2.ckpt', 'a cat running', {
    negativePrompt: 'blurry', width: 768, height: 432, steps: 20, cfgScale: 7, seed: 42, frames: 16, fps: 8,
  }) as Record<string, { class_type: string; inputs: Record<string, unknown> }>

  it('底模与运动模块正确接线', () => {
    expect(wf['1'].class_type).toBe('CheckpointLoaderSimple')
    expect(wf['1'].inputs.ckpt_name).toBe('checkpoints/AnythingV5V3.safetensors')
    expect(wf['8'].class_type).toBe('ADE_LoadAnimateDiffModel')
    expect(wf['8'].inputs.model_name).toBe('mm_sd_v15_v2.ckpt')
    expect(wf['9'].class_type).toBe('ADE_ApplyAnimateDiffModel')
    expect(wf['9'].inputs.model).toEqual(['1', 0])
    expect(wf['9'].inputs.motion_model).toEqual(['8', 0])
    expect(wf['10'].class_type).toBe('ADE_UseEvolvedSampling')
    expect(wf['10'].inputs.m_models).toEqual(['9', 0])
  })

  it('采样器吃进化采样后的模型，帧数走 batch_size', () => {
    expect(wf['5'].class_type).toBe('KSampler')
    expect(wf['5'].inputs.model).toEqual(['10', 0])
    expect(wf['5'].inputs.sampler_name).toBe('euler_ancestral')
    expect(wf['4'].inputs.batch_size).toBe(16)
    expect(wf['4'].inputs.width).toBe(768)
    expect(wf['4'].inputs.height).toBe(432)
  })

  it('VHS 合成 mp4 输出', () => {
    expect(wf['7'].class_type).toBe('VHS_VideoCombine')
    expect(wf['7'].inputs.images).toEqual(['6', 0])
    expect(wf['7'].inputs.format).toBe('video/h264-mp4')
    expect(wf['7'].inputs.frame_rate).toBe(8)
  })
})
