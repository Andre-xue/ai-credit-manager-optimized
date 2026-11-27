import { useState } from 'react'
import { KeyRound } from 'lucide-react'
import { hasLegacyOperationalCreds } from '../core/credMigration'

/**
 * 一次性迁移提示（v0.1.470）：保险箱锁定、且本机还有 470 前用主密码加密的
 * 运营凭据没迁时才出现。文案写明原因——这不是恢复日常门槛：解锁这一次，
 * App 会把旧凭据静默换成本机加密（App 的解锁 effect 触发 migrateAll），
 * 迁完横条永久消失、相关功能从此不再需要密码。没有旧凭据时渲染为空。
 */
export function LegacyMigrationBanner({ sessionPwd, onUnlock }: {
  sessionPwd: string
  onUnlock: (pwd: string) => void
}) {
  const [pwdInput, setPwdInput] = useState('')
  if (sessionPwd || !hasLegacyOperationalCreds()) return null
  return (
    <div className="legacy-mig-banner">
      <KeyRound size={14} />
      <span>有旧版加密的凭据需要迁移：解锁这一次把它们换成本机加密，之后这些功能不再需要密码。</span>
      <input className="input" type="password" placeholder="输入主密码完成一次性迁移" value={pwdInput}
        onChange={e => setPwdInput(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && pwdInput) { onUnlock(pwdInput); setPwdInput('') } }} />
      <button className="btn sm" disabled={!pwdInput}
        onClick={() => { onUnlock(pwdInput); setPwdInput('') }}>解锁并迁移</button>
    </div>
  )
}
