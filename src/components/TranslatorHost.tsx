import { useEffect, useRef } from 'react'
import type { Account } from '../core/types'
import { isDesktopApp } from '../core/openExternal'
import {
  loadTranslatorSettings, applyTranslatorShortcuts, getSelectedText, showTranslatorPop,
  updateTranslatorPop, showTranslatorInput, openTranslatorSettings,
  noteTranslatorDiag, humanizeTranslateError,
  preprocessText, translateWithRoutes, translateToTarget, sourceLangLabel, writeClipboard,
  TRANSLATOR_SETTINGS_EVENT, type PopProviderArgs,
} from '../core/translator'
import {
  loadTranslatorProviders, enabledProviderSummaries, pickTranslatorEngine,
  loadTranslatorEngineKey, saveTranslatorEngineKey, saveProviderPref, saveProviderModelPref,
} from '../core/translatorProviders'

/**
 * 翻译助手主窗口宿主（v0.1.440）：常驻主窗口，负责——
 * ① 启动与设置变化时把快捷键配置下发 Rust 注册；
 * ② 接 Rust 发来的全局事件（快捷键触发 / 截图 OCR 文本 / 原生错误），
 *    在主窗口上下文里跑翻译（账户与保险箱密码都在这里），再让 Rust 弹小窗。
 * v0.1.473 不变量：每个 hotkey-fired 必须终结于一个可见窗口或一个可见
 * 报错——selection 走取词+小窗、screenshot 走框选+小窗、input 走
 * translator_show_input 输入小窗；三条链每段都落 diag 面包屑。
 */
export function TranslatorHost({ accounts, sessionPwd, notify }: {
  accounts: Account[]
  sessionPwd: string
  notify: (m: string) => void
}) {
  const ctxRef = useRef({ accounts, sessionPwd, notify })
  ctxRef.current = { accounts, sessionPwd, notify }

  useEffect(() => {
    if (!isDesktopApp()) return
    let dead = false
    const unlistens: (() => void)[] = []

    // v0.1.462 面包屑：启动下发结果落盘，与打开翻译页时的 tool-apply 对照——
    // 启动这行 ok、开页后死在 apply，就能把范围缩到「第二次下发」的差异上。
    const applyShortcuts = () => {
      void applyTranslatorShortcuts(loadTranslatorSettings())
        .then(err => noteTranslatorDiag(err ? 'host-apply-err' : 'host-apply-ok'))
    }
    applyShortcuts()
    const onSettings = () => applyShortcuts()
    window.addEventListener(TRANSLATOR_SETTINGS_EVENT, onSettings)

    // 小窗最近一次弹出位置：小窗里切换语言重译时原地刷新，不跳位
    const lastPos = { x: 120, y: 120 }

    // v0.1.477 服务商上下文：小窗下拉只列已启用服务商（带实测耗时），
    // providerKey 为当前翻译引擎。算一次要读路线（可能含网络拉取），
    // 调用方按需决定等不等它（先行弹窗只等 400ms，见 translateAndShow）。
    const popCtx = async (): Promise<PopProviderArgs> => {
      try {
        const { providers } = await loadTranslatorProviders(ctxRef.current.accounts)
        const engine = pickTranslatorEngine(providers, loadTranslatorEngineKey())
        return {
          providersJson: JSON.stringify(enabledProviderSummaries(providers)),
          providerKey: engine?.key ?? '',
        }
      } catch { return {} }
    }
    // 零启用服务商时不弹错误窗、改弹小窗的提示态（带「打开翻译设置」入口）
    const showNoProviders = (x: number, y: number) => {
      const s = loadTranslatorSettings()
      lastPos.x = x + s.offsetX; lastPos.y = y + s.offsetY
      void noteTranslatorDiag('pop-no-providers')
      void showTranslatorPop({
        source: '', translated: '', targetLang: s.targetLang, error: null,
        ops: s.opsDisplay, x: lastPos.x, y: lastPos.y,
        providersJson: '[]', providerKey: '',
      }).catch(() => { ctxRef.current.notify('还没有启用的翻译服务商：请到翻译助手设置里启用至少一家') })
    }
    const isNoProvidersError = (msg: string) => msg.includes('还没有启用的翻译服务商')
    const showError = (message: string, x: number, y: number, sourceText = '') => {
      const s = loadTranslatorSettings()
      lastPos.x = x + s.offsetX; lastPos.y = y + s.offsetY
      // v0.1.465 流水线面包屑：错误小窗已请求弹出；连错误小窗都弹失败时
      // 退回主窗口 toast，绝不让失败静默无结果
      void noteTranslatorDiag('pop-error-show')
      // v0.1.480：报错并入新小窗错误态——error 只放人话标题，原文进
      // errorDetail 供展开；同时带上服务商上下文（已启用列表 + 当前引擎），
      // 小窗里能直接换一家重试。原文一并带上，重试就用它。
      const human = humanizeTranslateError(message)
      void popCtx().then(ctx => showTranslatorPop({
        source: sourceText, translated: '', targetLang: s.targetLang,
        error: human.title, errorDetail: human.detail, errorHint: human.hint,
        ops: s.opsDisplay, x: lastPos.x, y: lastPos.y, ...ctx,
      })).catch(() => { ctxRef.current.notify(message) })
    }
    // v0.1.480：真实翻译耗时回填——服务商级（小窗下拉/设置页摘要）与逐
    // 模型（设置页模型行）各记一份
    const recordElapsed = (providerKey: string, modelId: string, ms: number) => {
      saveProviderPref(providerKey, { ms })
      if (modelId) saveProviderModelPref(providerKey, modelId, { ms })
    }

    const translateAndShow = async (rawText: string, x: number, y: number) => {
      const { accounts: acc, sessionPwd: pwd, notify: nf } = ctxRef.current
      const s = loadTranslatorSettings()
      const text = preprocessText(rawText, s.preprocess)
      if (!text.trim()) { showError('没有可翻译的文本', x, y); return }
      // v0.1.473 分段计时起点：与 Rust 侧 timing-capture / timing-ocr 及
      // 本函数的 timing pop-first / translate-first / translate-ok 拼成
      // 全链路耗时，供录屏对数验收（实机基线：OCR 热态约 1s、翻译约 6s）
      const t0 = performance.now()
      // v0.1.465 流水线面包屑（translate-start / ok / fail 与 Rust 侧
      // capture-* / ocr-* / pop-show 拼成完整时间线）
      void noteTranslatorDiag(`translate-start chars=${text.length}`)
      lastPos.x = x + s.offsetX; lastPos.y = y + s.offsetY
      const srcLabel = sourceLangLabel(text)
      // v0.1.473 弹窗先行：原文一到手就把小窗亮出来（streaming 态），译文
      // 随后填入——不再等整段翻译返回才弹窗（468 实机松手到弹窗约 7 秒，
      // 其中翻译接口约占 6 秒）。先行弹窗失败不中断翻译，最终结果再试一次。
      // v0.1.477：服务商上下文与先行弹窗并行算，只等 400ms——不能为了下拉
      // 数据拖慢弹窗先行（473 不变量）；没算完就先不带，最终更新再补齐
      const ctxP = popCtx()
      const ctxFirst = await Promise.race([
        ctxP, new Promise<null>(res => { window.setTimeout(() => res(null), 400) }),
      ])
      let popShown = false
      if (s.popEnabled) {
        try {
          await showTranslatorPop({
            source: text, translated: '', targetLang: s.targetLang,
            sourceLang: srcLabel, error: null,
            ops: s.opsDisplay, x: lastPos.x, y: lastPos.y, streaming: true,
            ...(ctxFirst ?? {}),
          })
          popShown = true
          void noteTranslatorDiag(`timing pop-first=${Math.round(performance.now() - t0)}ms`)
        } catch { void noteTranslatorDiag('pop-first-fail') }
      }
      // 流式增量：首个增量落 translate-first 计时；增量更新节流 150ms，
      // 只换载荷不抢焦点（updateTranslatorPop）。非流式路线不回调，走
      // 整段返回——弹窗已经先行，体感由「等 6 秒出窗」变「出窗等译文」。
      let firstPartialAt: number | null = null
      let lastPushAt = 0
      const pushPartial = (full: string, force: boolean) => {
        if (!popShown || !full) return
        const now = performance.now()
        if (!force && now - lastPushAt < 150) return
        lastPushAt = now
        void updateTranslatorPop({
          source: text, translated: full, targetLang: s.targetLang,
          sourceLang: srcLabel, error: null, ops: s.opsDisplay, streaming: true,
        }).catch(() => { /* 增量丢一帧不影响最终结果 */ })
      }
      const onPartial = (full: string) => {
        if (firstPartialAt === null) {
          firstPartialAt = performance.now()
          void noteTranslatorDiag(`timing translate-first=${Math.round(firstPartialAt - t0)}ms`)
        }
        pushPartial(full, false)
      }
      try {
        // 45 秒硬超时：引擎调用（尤其免费通道）挂死时不许静默无结果——
        // 超时按失败处理、走错误小窗并落面包屑
        // v0.1.477：耗时只量翻译调用本身（不含 OCR/弹窗），译完回填该
        // 服务商的「最近实测」并随最终载荷进小窗（按钮下方小字展示）
        const tCall = performance.now()
        const out = await Promise.race([
          translateWithRoutes({
            accounts: acc, sessionPwd: pwd, text, settings: s,
            onChainNote: msg => nf(msg),
            onPartial,
          }),
          new Promise<never>((_res, rej) => {
            window.setTimeout(() => rej(new Error('翻译超时：模型通道 45 秒没有响应，换个模型或稍后重试')), 45_000)
          }),
        ])
        const elapsedMs = Math.round(performance.now() - tCall)
        recordElapsed(out.providerKey, out.modelId, elapsedMs)
        void noteTranslatorDiag(`translate-ok ms=${Math.round(performance.now() - t0)}`)
        // 最终载荷的服务商上下文重算一次，让下拉里的耗时与刚回填的实测一致
        const ctx = await popCtx()
        if (s.popEnabled) {
          try {
            if (popShown) {
              await updateTranslatorPop({
                source: text, translated: out.translated, targetLang: out.targetLang,
                sourceLang: srcLabel, error: null, ops: s.opsDisplay, streaming: false,
                ...ctx, providerKey: out.providerKey, elapsedMs, usedLabel: out.usedLabel,
              })
            } else {
              await showTranslatorPop({
                source: text, translated: out.translated, targetLang: out.targetLang,
                sourceLang: srcLabel, error: null,
                ops: s.opsDisplay, x: lastPos.x, y: lastPos.y,
                ...ctx, providerKey: out.providerKey, elapsedMs, usedLabel: out.usedLabel,
              })
            }
            void noteTranslatorDiag('pop-show-ok')
          } catch (e) {
            void noteTranslatorDiag('pop-show-fail')
            nf(`翻译已完成，但小窗弹出失败：${e instanceof Error ? e.message : '未知错误'}`)
          }
        } else {
          await writeClipboard(out.translated)
          nf('译文已复制到剪贴板')
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : '翻译失败'
        void noteTranslatorDiag(`translate-fail ${msg}`)
        if (isNoProvidersError(msg)) showNoProviders(x, y)
        else showError(msg, x, y, text)
      }
    }

    // 小窗内重译（切换语言/服务商、改原文后点翻译按钮）
    const doRetranslate = async (p: { source: string; targetLang: string; sourceLang?: string; providerKey?: string }) => {
      const { accounts: acc, sessionPwd: pwd, notify: nf } = ctxRef.current
      const s = loadTranslatorSettings()
      const text = (p.source ?? '').slice(0, 8000)
      if (!text.trim()) return
      // 小窗里刚选的服务商先落盘，翻译引擎解析以它为准
      if (p.providerKey) saveTranslatorEngineKey(p.providerKey)
      try {
        const tCall = performance.now()
        const out = await translateToTarget({
          accounts: acc, sessionPwd: pwd, text,
          targetLang: p.targetLang || s.targetLang,
          sourceLangName: p.sourceLang,
          onChainNote: msg => nf(msg),
        })
        const elapsedMs = Math.round(performance.now() - tCall)
        recordElapsed(out.providerKey, out.modelId, elapsedMs)
        await showTranslatorPop({
          source: text, translated: out.translated, targetLang: out.targetLang,
          sourceLang: p.sourceLang || sourceLangLabel(text), error: null,
          ops: s.opsDisplay, x: lastPos.x, y: lastPos.y,
          ...(await popCtx()), providerKey: out.providerKey, elapsedMs, usedLabel: out.usedLabel,
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : '翻译失败'
        if (isNoProvidersError(msg)) showNoProviders(lastPos.x - s.offsetX, lastPos.y - s.offsetY)
        else showError(msg, lastPos.x - s.offsetX, lastPos.y - s.offsetY, text)
      }
    }

    const doSelection = async () => {
      const s = loadTranslatorSettings()
      if (!s.selectionEnabled) return
      const outcome = await getSelectedText()
      if (outcome.error || !outcome.text) {
        // 取词失败明确报错（弹到鼠标旁），不假装成功
        showError(outcome.error ?? '没有取到选中文本：先在其他应用里选中文字再按快捷键', outcome.x, outcome.y)
        return
      }
      await translateAndShow(outcome.text, outcome.x, outcome.y)
    }

    // 输入翻译（v0.1.473 打通）：Alt+E → Rust 开置顶输入小窗（与译文小窗
    // 同层级、鼠标旁、自动聚焦）。旧链（440–472）只把主窗口在后台切到
    // 工坊页，用户在其他应用里按键毫无动静且全程无日志——本链每段落盘：
    // input-open（宿主收到）→ Rust input-show（窗口已显）→ input-submit
    // （小窗提交）→ 结果/错误小窗。开窗失败必须转错误小窗 + toast，不许静默。
    const doInput = async () => {
      const s = loadTranslatorSettings()
      void noteTranslatorDiag('input-open')
      try {
        const [px, py] = await showTranslatorInput(s.offsetX, s.offsetY, await popCtx())
        lastPos.x = px; lastPos.y = py
        void noteTranslatorDiag('input-show-ok')
      } catch (e) {
        const msg = `输入翻译窗口打开失败：${e instanceof Error ? e.message : '未知错误'}`
        void noteTranslatorDiag(`input-show-fail ${msg}`)
        showError(msg, lastPos.x - s.offsetX, lastPos.y - s.offsetY)
        ctxRef.current.notify(msg)
      }
    }

    // 输入小窗提交：小窗经 translator-input-submit 事件把文本发来，宿主翻译
    // 后在同位置把小窗换成结果（showTranslatorPop），失败走错误小窗。
    const doInputSubmit = async (p: { text: string; targetLang?: string; providerKey?: string }) => {
      const { accounts: acc, sessionPwd: pwd, notify: nf } = ctxRef.current
      const s = loadTranslatorSettings()
      const text = preprocessText((p.text ?? '').slice(0, 8000), s.preprocess)
      if (!text.trim()) return
      if (p.providerKey) saveTranslatorEngineKey(p.providerKey)
      void noteTranslatorDiag(`input-submit chars=${text.length}`)
      try {
        const tCall = performance.now()
        const out = await Promise.race([
          translateToTarget({
            accounts: acc, sessionPwd: pwd, text,
            targetLang: p.targetLang || s.targetLang,
            onChainNote: msg => nf(msg),
          }),
          new Promise<never>((_res, rej) => {
            window.setTimeout(() => rej(new Error('翻译超时：模型通道 45 秒没有响应，换个模型或稍后重试')), 45_000)
          }),
        ])
        const elapsedMs = Math.round(performance.now() - tCall)
        recordElapsed(out.providerKey, out.modelId, elapsedMs)
        await showTranslatorPop({
          source: text, translated: out.translated, targetLang: out.targetLang,
          sourceLang: sourceLangLabel(text), error: null,
          ops: s.opsDisplay, x: lastPos.x, y: lastPos.y,
          ...(await popCtx()), providerKey: out.providerKey, elapsedMs, usedLabel: out.usedLabel,
        })
        void noteTranslatorDiag('input-result-ok')
      } catch (e) {
        const msg = e instanceof Error ? e.message : '翻译失败'
        void noteTranslatorDiag(`input-result-fail ${msg}`)
        if (isNoProvidersError(msg)) showNoProviders(lastPos.x - s.offsetX, lastPos.y - s.offsetY)
        else showError(msg, lastPos.x - s.offsetX, lastPos.y - s.offsetY, text)
      }
    }

    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        if (dead) return
        unlistens.push(await listen<{ action: string }>('translator-hotkey', e => {
          if (e.payload.action === 'selection') void doSelection()
          else if (e.payload.action === 'input') void doInput()
        }))
        unlistens.push(await listen<{ text: string; targetLang?: string; providerKey?: string }>('translator-input-submit', e => {
          void doInputSubmit(e.payload)
        }))
        unlistens.push(await listen('translator-open-settings', () => {
          void openTranslatorSettings()
        }))
        unlistens.push(await listen<{ text: string; x: number; y: number }>('translator-shot-text', e => {
          // v0.1.465：OCR 文本到达宿主的到达回执——日志有 ocr-ok 没这行，
          // 就是事件没送到主窗口；有这行没 translate-ok，就是死在翻译段
          void noteTranslatorDiag(`shot-text-received chars=${e.payload.text.length}`)
          void translateAndShow(e.payload.text, e.payload.x, e.payload.y)
        }))
        unlistens.push(await listen<{ message: string; x?: number; y?: number }>('translator-error', e => {
          void noteTranslatorDiag('rust-error-event')
          if (typeof e.payload.x === 'number' && typeof e.payload.y === 'number') showError(e.payload.message, e.payload.x, e.payload.y)
          else ctxRef.current.notify(e.payload.message)
        }))
        unlistens.push(await listen<{ source: string; targetLang: string; sourceLang?: string; providerKey?: string }>('translator-retranslate', e => {
          void doRetranslate(e.payload)
        }))
      } catch { /* 非 Tauri 环境忽略 */ }
    })()

    return () => {
      dead = true
      window.removeEventListener(TRANSLATOR_SETTINGS_EVENT, onSettings)
      unlistens.forEach(u => u())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return null
}
