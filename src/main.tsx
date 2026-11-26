import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import './liquid-glass.css'
import './claude-ui.css'
import './motion-effects.css'
import './redesign.css'
import './liquid-global.css'

// 预览钩子：URL 带 ?preview=phone 时模拟 Capacitor 原生环境，便于在浏览器里预览手机端液态玻璃界面。
// 仅用于开发/验收，正常用户不会带此参数，对生产无影响。
if (typeof window !== 'undefined' && (new URLSearchParams(location.search).get('preview') === 'phone' || location.hash.includes('preview=phone'))) {
  const w = window as unknown as { Capacitor?: unknown }
  w.Capacitor = { isNative: true, getPlatform: () => 'android' }
}

// 手机端禁用双指/双击缩放，呈现原生 App 体验（viewport meta 之外的兜底）
if (typeof window !== 'undefined') {
  document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false })
  document.addEventListener('gesturechange', (e) => e.preventDefault(), { passive: false })
  // 阻止 iOS 双击缩放
  let lastTouch = 0
  document.addEventListener('touchend', (e) => {
    const now = Date.now()
    if (now - lastTouch < 300) e.preventDefault()
    lastTouch = now
  }, { passive: false })
}

/** 手机端：先从原生存储恢复数据，再渲染 App（确保更新/重装后数据不丢），最后定时镜像备份。 */
async function bootstrap() {
  // 桌面端菜单栏迷你窗是独立窗口（#/mini）：只读本机状态，不走主应用启动流程
  if (typeof window !== 'undefined' && location.hash.includes('/mini')) {
    const { MiniView } = await import('./components/MiniView')
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <MiniView />
      </React.StrictMode>,
    )
    return
  }
  // 翻译助手小窗 / 截图框选层也是独立窗口（v0.1.440）：只渲染各自轻量组件。
  // v0.1.451：框选层窗口必须真透明——index.html 的内联样式与全局 CSS 都给
  // html/body 涂了不透明底色（#f4f4f8 / var(--bg)），440 只清了 body，html 的
  // 底色仍铺满整个窗口，框选层实机就是一整块不透明灰幕。这里在首帧渲染前
  // 给 html 打标记（CSS 以 !important 兜底）并直接清掉 html/body 的内联底色。
  // v0.1.453：451 把小窗也一起打了 trs-window，实机小窗跟着透明——小窗改为
  // 单独的 trs-popwin 标记：页面底色不透明，卡片自带实心背景（见 styles.css）。
  if (typeof window !== 'undefined' && location.hash.includes('/translator-capture')) {
    document.documentElement.classList.add('trs-window')
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
  }
  if (typeof window !== 'undefined' && location.hash.includes('/translator-pop')) {
    document.documentElement.classList.add('trs-popwin')
  }
  if (typeof window !== 'undefined' && location.hash.includes('/translator-pop')) {
    const { TranslatorPop } = await import('./components/TranslatorPop')
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <TranslatorPop />
      </React.StrictMode>,
    )
    return
  }
  if (typeof window !== 'undefined' && location.hash.includes('/translator-capture')) {
    const { TranslatorCapture } = await import('./components/TranslatorCapture')
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <TranslatorCapture />
      </React.StrictMode>,
    )
    return
  }
  const { restoreFromNative, backupToNative } = await import('./core/persistence')
  await restoreFromNative()

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )

  // 启动后做一次备份，之后定期备份（页面隐藏时也备份，覆盖绝大多数更新场景）
  void backupToNative()
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void backupToNative()
    })
  }
  window.setInterval(() => void backupToNative(), 30_000)
}

void bootstrap()
