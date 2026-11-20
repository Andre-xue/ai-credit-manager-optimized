// 云服务客户端：全端共享一个实例（Web / 桌面 Tauri / 安卓 Capacitor WebView）。
// publicConfig 为面向客户端的公开配置（publishableKey 本身不含权限，服务端按来源域名校验）。
// 端点与 Key 只能来自开通云服务时返回的配置，切勿硬编码其他值。

import { createWorkBuddyCloud, type CloudUser } from '@tencent-ai/workbuddy-cloud-sdk'

export const PUBLIC_CONFIG = {
  endpoint: 'https://wbapp-uxzyxkkqofad4mwe1lca5e.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_uxZyXKKqOfad4mWe1LCa5E_eay4EyhsGD7Qb3o46G1JqqvdU5VGfd7q',
}
/** 供桌面端 Rust 代理转发 LLM 请求（公开配置，非密钥） */
export const LLM_PROXY_CONFIG = {
  endpoint: PUBLIC_CONFIG.endpoint,
  publishableKey: PUBLIC_CONFIG.publishableKey,
}

/**
 * 稳定的本机设备标识（与同步层 clientId 同源，localStorage 持久化）。
 * 云网关按客户端区分会话：同一账号多端登录时，若请求不带设备标识，网关会把
 * 会话判为「issued for another client」并拒绝数据请求（实测：桌面端正常、
 * 安卓端登录成功但拉取/推送被拒）。网关的 CORS 允许头里明确包含 X-Device-Id，
 * 故所有云请求统一带上它，让每台设备拥有独立会话。
 */
export function getCloudDeviceId(): string {
  const KEY = 'acm.sync.clientId'
  try {
    let id = localStorage.getItem(KEY)
    if (!id) {
      id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
      localStorage.setItem(KEY, id)
    }
    return id
  } catch {
    return 'unknown-device'
  }
}

const cloudFetch: typeof fetch = (input, init) => {
  try {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    if (url && url.startsWith(PUBLIC_CONFIG.endpoint)) {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      if (!headers.has('X-Device-Id')) headers.set('X-Device-Id', getCloudDeviceId())
      if (input instanceof Request && !init) return fetch(new Request(input, { headers }))
      return fetch(input, { ...init, headers })
    }
  } catch { /* 标识注入失败不阻断请求 */ }
  return fetch(input, init)
}

export const cloud = createWorkBuddyCloud({
  endpoint: PUBLIC_CONFIG.endpoint,
  oauthRelayBaseUrl: PUBLIC_CONFIG.oauthRelayBaseUrl,
  publishableKey: PUBLIC_CONFIG.publishableKey,
  fetch: cloudFetch,
})

export type { CloudUser }
