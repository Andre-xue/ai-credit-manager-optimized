// 工坊技能清单（单一数据源）——工坊页的工具卡片与 Agent 工作台 # 面板的「工坊技能」组都读这一份。
// name/desc 与工坊卡片展示文案一致；template 是派活给 Agent 时的任务模板前缀说明。

export interface WorkshopSkill { id: string; name: string; desc: string }

export const WORKSHOP_SKILLS: WorkshopSkill[] = [
  { id: 'files', name: '文件管家', desc: '访达式浏览你的文件夹，本地索引加持，一句话找到文件、读出内容、直接预览。' },
  { id: 'summary', name: '文档总结', desc: '丢进 PDF / Word / 长文，一键出摘要、要点清单和大纲。' },
  { id: 'docqa', name: '文档问答', desc: '导入文档建本地知识库，围绕文档内容提问，答案带出处。' },
  { id: 'translate', name: 'AI 翻译', desc: '整篇文档或粘贴文本翻译，保留段落结构，可双语对照。' },
  { id: 'polish', name: '文案润色', desc: '改写、扩写、缩写、换语气——把草稿变成能直接发的成稿。' },
  { id: 'image', name: 'AI 图像', desc: '云端生图，生成完自动存进你的文件夹（本地生图在侧边栏本地生成里）。' },
  { id: 'video', name: 'AI 视频', desc: '云端生视频，生成完自动存进你的文件夹（本地生视频在侧边栏本地生成里）。' },
  { id: 'gallery', name: 'AI 图库', desc: '苹果照片式图库：AI 生成与本地照片视频按日期成册，悬停播放、点开大图慢慢看。' },
  { id: 'voice', name: '语音转写', desc: '录音、会议音频转文字稿——本地 whisper 引擎制作中，下一批上架。' },
  { id: 'webcheck', name: '联网核查', desc: '给一句话或一条消息，AI 联网搜证核实真假并附来源。' },
  { id: 'table', name: '表格问答', desc: '把 CSV 丢进来，用问话查数、汇总、找异常，不用写公式。' },
  { id: 'dailycheckin', name: '每日签到', desc: 'WorkBuddy、MiniMax Code 每日积分签到：授权一次，每天点一下领积分。' },
  { id: 'freegames', name: '免费游戏', desc: 'Epic 每周喜加一自动领取：绑定一次，定时自动领入库。' },
  { id: 'steamdeals', name: 'Steam 迷你商城', desc: 'Steam 商店特惠与全目录搜索：折扣、现价、好评率，可按分类/平台筛选；绑定 Steam 账户还能看我的库、已拥有的标「已入库」。' },
  { id: 'watch', name: '看剧', desc: 'AI 找剧、热门推荐、直播、点播：App 内播放器直接看，直播多套源自动切换，点播带选集与续播；片单与追剧日历只存本机。' },
  { id: 'mail', name: '邮箱', desc: 'Gmail、Outlook、QQ、163、iCloud 等全部邮箱一个收件箱：验证码自动分类、实时同步、凭据只存本机。' },
  { id: 'translator', name: '翻译助手', desc: '在任何应用里划词、框选截图就能翻译：全局快捷键取词、本地 OCR、译文小窗可复制/替换/朗读，引擎用你现有模型与免费路线。' },
  { id: 'catalog', name: 'AI 工具大全', desc: '各平台 AI 工具目录与签到入口汇总，原侧边栏入口已并入工坊。' },
]

const BY_ID = new Map(WORKSHOP_SKILLS.map(s => [s.id, s]))

/** 工坊卡片按 id 取展示文案（name/desc 只在本文件维护一份） */
export function workshopSkillMeta(id: string): { name: string; desc: string } {
  const s = BY_ID.get(id)
  return { name: s?.name ?? id, desc: s?.desc ?? '' }
}

/** 技能派活模板：把工坊技能的定位说明包在用户任务外层，Agent 按技能口径执行 */
export function buildSkillTaskText(skill: WorkshopSkill, userText: string): string {
  return `【工坊技能 · ${skill.name}】${skill.desc}\n\n具体任务：${userText}`
}
