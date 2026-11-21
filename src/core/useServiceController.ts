// 本地服务控制 Hook：把 App 层的服务开关状态与启停逻辑集中管理，
// 供设置页、AI 翻译、AI 图像、AI 视频等多处共用，保证开关状态联动。
// 状态源单一：settings.localServices（持久化）；运行时状态（服务是否真在跑）由本机探测得到。

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppSettings, LocalServiceKey, MemoryTier } from './types'
import {
  checkLocalService, startLocalService, stopServiceByPort, comfyLaunchDesktopEnabled,
} from './localServices'
import {
  LOCAL_SERVICE_KEYS, isServiceEnabled, planServiceToggle, notifyLocalServiceChanged,
} from './localServicesSettings'

export interface ServiceController {
  /** 某服务在 App 内是否启用（来自 settings） */
  enabled: (key: LocalServiceKey) => boolean
  /** 某服务本机是否真的在运行（返回地址或 null） */
  status: Partial<Record<LocalServiceKey, string | null>>
  /** 正在切换的服务 key */
  busyKey: LocalServiceKey | null
  /** 切换服务开关（含启停进程、8G 限制） */
  toggle: (key: LocalServiceKey) => Promise<void>
  /** 刷新运行时状态 */
  refresh: () => void
}

/**
 * @param settings 当前 AppSettings（只读）
 * @param patchSettings 更新 settings 的回调（写入 localServices）
 * @param memTier 内存档位
 * @param notify 提示回调
 */
export function useServiceController(
  settings: AppSettings | undefined,
  patchSettings: (patch: Partial<AppSettings>) => void,
  memTier: MemoryTier,
  notify: (msg: string) => void,
): ServiceController {
  const [status, setStatus] = useState<Partial<Record<LocalServiceKey, string | null>>>({})
  const [busyKey, setBusyKey] = useState<LocalServiceKey | null>(null)

  const autoStartedRef = useRef<Partial<Record<LocalServiceKey, boolean>>>({})
  const refresh = useCallback(() => {
    void Promise.all(LOCAL_SERVICE_KEYS.map(async k => [k, await checkLocalService(k)] as const))
      .then(rows => {
        const map = Object.fromEntries(rows) as Partial<Record<LocalServiceKey, string | null>>
        setStatus(map)
        // 自愈：Ollama 开关已开但服务实际没跑（如 App 重启后遗留状态）→ 自动拉起一次。
        // 仅 ollama（轻量、用户开着开关即代表想用）；不自动拉 ComfyUI/LM Studio，且每次会话只尝试一次。
        const k: LocalServiceKey = 'ollama'
        if (settings && isServiceEnabled(settings, k) && !map[k] && !autoStartedRef.current[k]) {
          autoStartedRef.current[k] = true
          void startLocalService(k).then(r => {
            if (r.ok) {
              let n = 0
              const timer = window.setInterval(() => {
                void checkLocalService(k).then(addr => {
                  if (addr) { setStatus(prev => ({ ...prev, [k]: addr })); window.clearInterval(timer) }
                  else if (++n >= 15) window.clearInterval(timer)
                })
              }, 2000)
            }
          })
        }
      })
  }, [settings])
  useEffect(() => { refresh() }, [refresh])

  const enabled = useCallback((key: LocalServiceKey) => isServiceEnabled(settings, key), [settings])

  const toggle = useCallback(async (key: LocalServiceKey) => {
    if (busyKey) return
    const plan = planServiceToggle(settings, key, memTier)
    if (!plan) return
    const { next, stopKeys, enabled: willEnable } = plan
    setBusyKey(key)
    patchSettings({ localServices: next })
    const name = key === 'ollama' ? 'Ollama' : key === 'comfyui' ? 'ComfyUI' : 'LM Studio'
    try {
      // 互斥：先停掉被挤掉的其他服务（关自己留给下方 else 统一处理）
      for (const oldKey of stopKeys) {
        if (oldKey === key) continue
        const r = await stopServiceByPort(oldKey)
        setStatus(prev => ({ ...prev, [oldKey]: '' }))
        notifyLocalServiceChanged(oldKey, false)
        const oldName = oldKey === 'ollama' ? 'Ollama' : oldKey === 'comfyui' ? 'ComfyUI' : 'LM Studio'
        if (r.ok) notify(`已关闭 ${oldName} 以释放内存（${r.message}）`)
      }
      if (willEnable) {
        const already = await checkLocalService(key)
        if (already) {
          setStatus(prev => ({ ...prev, [key]: already }))
          notify(`${name} 已在运行，已直接启用`)
        } else if (key !== 'lmstudio') {
          const r = await startLocalService(key)
          notify(`${name}：${r.message}`)
          if (r.ok) {
            let tries = 0
            const poll = window.setInterval(() => {
              void checkLocalService(key).then(addr => {
                if (addr) { setStatus(prev => ({ ...prev, [key]: addr })); window.clearInterval(poll) }
                else if (++tries >= 15) {
                  window.clearInterval(poll)
                  if (key === 'comfyui' && comfyLaunchDesktopEnabled()) {
                    // Desktop 拉起模式：应用已打开但实例还没由用户点开，不算失败——
                    // 不回滚开关，等实例启动后探测会自动识别（状态刷新/进页面时会更新）
                    notify('已打开 Comfy Desktop，请在其中打开你的实例，启动后会自动识别')
                  } else {
                    // 启动命令返回成功但服务始终没起来 → 回滚开关，避免"已开启却连不上"的状态脱节
                    patchSettings({ localServices: { ...(settings?.localServices ?? {}), [key]: false } })
                    setStatus(prev => ({ ...prev, [key]: null }))
                    notifyLocalServiceChanged(key, false)
                    notify(`${name} 启动后未能正常监听端口，已自动关闭开关。请确认本机 ${key} 可正常运行后重试`)
                  }
                }
              })
            }, 2000)
          } else {
            // 启动命令直接失败 → 回滚开关
            patchSettings({ localServices: { ...(settings?.localServices ?? {}), [key]: false } })
            notifyLocalServiceChanged(key, false)
          }
        } else {
          notify(`${name} 请在 LM Studio 应用内手动开启本地服务器`)
        }
      } else {
        const r = await stopServiceByPort(key)
        notify(`${name}：${r.ok ? r.message : `停止失败：${r.message}`}`)
        setStatus(prev => ({ ...prev, [key]: '' }))
      }
      notifyLocalServiceChanged(key, willEnable)
    } finally { setBusyKey(null) }
  }, [settings, memTier, busyKey, patchSettings, notify])

  return { enabled, status, busyKey, toggle, refresh }
}
