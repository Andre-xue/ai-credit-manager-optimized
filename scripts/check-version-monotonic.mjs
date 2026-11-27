#!/usr/bin/env node
/**
 * 版本单调校验（v0.1.495 起的发版硬闸，Release Installers 的 version-guard job 调用）。
 *
 * 背景：2026-11-27 的更新误报——版本号曾在排队时预定、制作顺序与号序不一致，
 * 小号版本（0.1.470）晚于大号（0.1.484）发布，更新器按数字比大小，把装了
 * 更新内容的用户告知「已是最新」。编号纪律已改为按制作顺序递增，这里再加
 * 一道代码级兜底：新版本号必须严格大于 GitHub 上最新已发布 release 的版本号，
 * 否则直接失败，绝不允许小号或同号版本发出去。
 *
 * 用法：node scripts/check-version-monotonic.mjs <新版本号> [已发布 tag ...]
 *   - 新版本号可带或不带 v 前缀（如 0.1.495 或 v0.1.495）。
 *   - 已发布 tag 列表由 workflow 用 gh api 拉取后逐个传入（仅非 draft）。
 *   - 与新版本号同名的 tag 会被排除（同一版本的 CI 重跑/移动 tag 重发不算误发）。
 *   - 无任何已发布版本时直接通过。
 * 退出码：0 = 通过；1 = 拦截（新版本号 ≤ 最新已发布版本号，或入参无法解析）。
 */
function parseVersion(raw) {
  if (typeof raw !== 'string') return null
  const m = raw.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}
function cmp(a, b) {
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1 }
  return 0
}
function fmt(v) { return `v${v[0]}.${v[1]}.${v[2]}` }

const [newRaw, ...tagRaws] = process.argv.slice(2)
const newVer = parseVersion(newRaw ?? '')
if (!newVer) {
  console.error(`::error::版本单调校验：新版本号「${newRaw ?? ''}」无法解析为 x.y.z，终止发布`)
  process.exit(1)
}
let latest = null
for (const t of tagRaws) {
  const v = parseVersion(t)
  if (!v) { console.log(`（忽略无法解析的已发布 tag：${t}）`); continue }
  if (cmp(v, newVer) === 0) continue // 同名 tag = 本版本自己的 release，重跑不拦截
  if (!latest || cmp(v, latest) > 0) latest = v
}
if (!latest) {
  console.log(`✅ 版本单调校验通过：${fmt(newVer)}，此前无其他已发布版本`)
  process.exit(0)
}
if (cmp(newVer, latest) <= 0) {
  console.error(`::error::版本单调校验拦截：新版本 ${fmt(newVer)} 不大于最新已发布版本 ${fmt(latest)}。小号/同号版本会让更新器误报「已是最新」（0.1.470 晚于 0.1.484 发布的教训）。请递增到大于 ${fmt(latest)} 的版本号后重新打 tag。`)
  process.exit(1)
}
console.log(`✅ 版本单调校验通过：${fmt(newVer)} > 最新已发布 ${fmt(latest)}`)
