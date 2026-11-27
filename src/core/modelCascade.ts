// ============================================================
// AI 助手三段选择器（分类 / 平台 / 模型）的级联分组纯逻辑（v0.1.496）。
// 第二段「平台」是对当前分类下选项的一层分组视图，不改变选项本身的
// 选择/存储语义：
// - 自有账户：每个账户自成一个平台，平台名 = 服务商简称（PROVIDER_MAP
//   shortName）；同分类里出现同名平台（同服务商多账户）时回退用账户
//   备注名区分，避免两行同名无法分辨。
// - 云端免费模型（WorkBuddy 云端清单）：归「WorkBuddy」平台。
// - 内置免费通道：按来源归「Zen」/「Kilo」平台；APIsFreeLLM 单独成平台。
// - 本地 Ollama 模型：归「Ollama」平台。
// 第三段「模型」：自有账户平台下是该账户的引擎列表（在 AIView 里处理）；
// 其余平台下就是平台内的选项本身，展示名去掉标签里的来源后缀。
// ============================================================
import { PROVIDER_MAP } from '../data/providers'
import { UPSTREAM_LABEL, type UpstreamSource } from './upstreamFree'

export interface CascadeOptionLike {
  key: string
  label: string
  account?: { id: string; providerId: string; label: string } | null
  upstream?: UpstreamSource | undefined
  apisFree?: boolean | undefined
  localModel?: string | undefined
}

export interface PlatformGroup<T extends CascadeOptionLike> {
  platformKey: string
  platformName: string
  options: T[]
}

/** 选项所属平台的唯一键（同一平台的多个模型共享同一键） */
export function platformKeyOf(o: CascadeOptionLike): string {
  if (o.account) return `own:${o.account.id}`
  if (o.upstream) return `up:${o.upstream}`
  if (o.apisFree) return 'apisfree'
  if (o.localModel) return 'ollama'
  return 'workbuddy'
}

/** 平台显示名：只给平台名，不带分类标签、不带模型名 */
export function platformNameOf(o: CascadeOptionLike): string {
  if (o.account) return PROVIDER_MAP[o.account.providerId]?.shortName ?? o.account.label
  if (o.upstream) return UPSTREAM_LABEL[o.upstream]
  if (o.apisFree) return 'APIsFreeLLM'
  if (o.localModel) return 'Ollama'
  return 'WorkBuddy'
}

/** 选项作为「模型」展示的名字：去掉标签里的来源后缀，只留模型名 */
export function modelNameOf(o: CascadeOptionLike): string {
  if (o.upstream) {
    const suffix = ` · ${UPSTREAM_LABEL[o.upstream]}`
    return o.label.endsWith(suffix) ? o.label.slice(0, -suffix.length) : o.label
  }
  if (o.apisFree) return o.label.split(' · ')[0]
  return o.label
}

/** 模型名是否为「免费版」命名：以 -free 或 :free 结尾（不分大小写），如 deepseek-v4.1-flash-1017-free、nemotron-…:free（v0.1.513） */
export function isFreeModelName(name: string): boolean {
  const n = name.trim().toLowerCase()
  return n.endsWith('-free') || n.endsWith(':free')
}

/** 稳定分区：免费命名的排前面，组内保持原有相对顺序——只做组内重排，不打乱上游已排好的顺序（如探测排名）（v0.1.513） */
export function freeModelsFirst<T>(items: readonly T[], isFree: (item: T) => boolean): T[] {
  const free: T[] = []
  const rest: T[] = []
  for (const it of items) (isFree(it) ? free : rest).push(it)
  return [...free, ...rest]
}

/** 搜索过滤：按名字子串、不分大小写；查询为空时返回原列表副本（v0.1.513） */
export function filterModelsByQuery<T>(items: readonly T[], query: string, nameOf: (item: T) => string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...items]
  return items.filter(it => nameOf(it).toLowerCase().includes(q))
}

/** 把当前分类的选项按平台分组（保持选项与平台的首次出现顺序） */
export function groupOptionsByPlatform<T extends CascadeOptionLike>(options: readonly T[]): PlatformGroup<T>[] {
  const groups: PlatformGroup<T>[] = []
  const byKey = new Map<string, PlatformGroup<T>>()
  for (const o of options) {
    const key = platformKeyOf(o)
    let g = byKey.get(key)
    if (!g) {
      g = { platformKey: key, platformName: platformNameOf(o), options: [] }
      byKey.set(key, g)
      groups.push(g)
    }
    g.options.push(o)
  }
  // 同名平台消歧：仅自有账户平台之间同名（同服务商多账户）时，回退用账户备注名
  const nameCount = new Map<string, number>()
  for (const g of groups) nameCount.set(g.platformName, (nameCount.get(g.platformName) ?? 0) + 1)
  for (const g of groups) {
    const first = g.options[0]
    if (first?.account && (nameCount.get(g.platformName) ?? 0) > 1) {
      g.platformName = first.account.label
    }
  }
  return groups
}
