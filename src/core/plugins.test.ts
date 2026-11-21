import { describe, it, expect, beforeEach } from 'vitest'
import {
  validatePluginPackage, isHostAllowed, loadPlugins, installPlugin, uninstallPlugin,
  setPluginEnabled, pluginStorageGet, pluginStorageSet, type PluginPackage,
} from './plugins'

class MemStorage {
  private m = new Map<string, string>()
  get length() { return this.m.size }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  key(i: number) { return [...this.m.keys()][i] ?? null }
  clear() { this.m.clear() }
}

beforeEach(() => {
  ;(globalThis as Record<string, unknown>).localStorage = new MemStorage()
  ;(globalThis as Record<string, unknown>).window = { dispatchEvent: () => true, addEventListener() {}, removeEventListener() {} }
})

const validPkg: PluginPackage = {
  manifest: {
    id: 'demo-plugin', name: '演示插件', version: '1.0.0',
    provides: ['panel'], permissions: ['notify', 'storage'],
  },
  code: 'acm.notify("hi")',
}

describe('validatePluginPackage', () => {
  it('合法插件包通过', () => {
    expect(validatePluginPackage(validPkg)).toBeNull()
  })

  it('id 含非法字符被拒', () => {
    const bad = { ...validPkg, manifest: { ...validPkg.manifest, id: 'Bad_ID!' } }
    expect(validatePluginPackage(bad)).toContain('id')
  })

  it('声明 network 权限但没写 hosts 被拒', () => {
    const bad = { ...validPkg, manifest: { ...validPkg.manifest, permissions: ['network'] } }
    expect(validatePluginPackage(bad)).toContain('hosts')
    const ok = { ...validPkg, manifest: { ...validPkg.manifest, permissions: ['network'], hosts: ['api.example.com'] } }
    expect(validatePluginPackage(ok)).toBeNull()
  })

  it('进程插件没写 command 被拒', () => {
    const bad = { ...validPkg, manifest: { ...validPkg.manifest, provides: ['process'] } }
    expect(validatePluginPackage(bad)).toContain('command')
  })

  it('未知权限 / 空代码被拒', () => {
    const bad = { ...validPkg, manifest: { ...validPkg.manifest, permissions: ['root'] } }
    expect(validatePluginPackage(bad)).toContain('权限')
    expect(validatePluginPackage({ ...validPkg, code: '  ' })).toContain('代码')
  })
})

describe('isHostAllowed', () => {
  it('精确域名与子域名放行', () => {
    expect(isHostAllowed('https://api.example.com/v1', ['example.com'])).toBe(true)
    expect(isHostAllowed('https://example.com/v1', ['example.com'])).toBe(true)
  })
  it('相似域名与未声明域名拒绝', () => {
    expect(isHostAllowed('https://evil-example.com/', ['example.com'])).toBe(false)
    expect(isHostAllowed('https://other.com/', ['example.com'])).toBe(false)
    expect(isHostAllowed('not a url', ['example.com'])).toBe(false)
    expect(isHostAllowed('https://example.com/', [])).toBe(false)
    expect(isHostAllowed('https://example.com/', undefined)).toBe(false)
  })
})

describe('插件安装与私有存储', () => {
  it('安装 / 启停 / 卸载全流程，卸载清私有存储', () => {
    installPlugin(validPkg, 'editor')
    expect(loadPlugins()).toHaveLength(1)
    expect(loadPlugins()[0].enabled).toBe(true)
    setPluginEnabled('demo-plugin', false)
    expect(loadPlugins()[0].enabled).toBe(false)
    pluginStorageSet('demo-plugin', 'k', { v: 1 })
    expect(pluginStorageGet('demo-plugin', 'k')).toEqual({ v: 1 })
    expect(pluginStorageGet('other-plugin', 'k')).toBeNull()
    uninstallPlugin('demo-plugin')
    expect(loadPlugins()).toHaveLength(0)
    expect(pluginStorageGet('demo-plugin', 'k')).toBeNull()
  })

  it('同 id 重装保留启用状态并更新代码', () => {
    installPlugin(validPkg, 'editor')
    setPluginEnabled('demo-plugin', false)
    installPlugin({ ...validPkg, code: 'v2' }, 'file')
    const p = loadPlugins()[0]
    expect(p.code).toBe('v2')
    expect(p.enabled).toBe(false)
    expect(p.source).toBe('file')
  })
})
