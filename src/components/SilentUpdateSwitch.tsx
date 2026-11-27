// 「静默更新」双色果冻开关（v0.1.495，Ethan 2026-11-27 看预览定版）：
// 开=整轨绿、圆钮带绿 ✓；关=红轨、圆钮带红 ✕。刻意不用常规灰→绿开关——
// 红/绿一眼可辨当前会不会自动更新。更新弹窗底部与设置页签共用同一组件、
// 同一偏好（acm.update.autoEnabled.v1）。
import { Check, X } from 'lucide-react'

export function SilentUpdateSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label="静默更新"
      className={`silent-switch${checked ? ' on' : ' off'}`}
      onClick={() => onChange(!checked)}
    >
      <span className="silent-switch-knob">
        {checked ? <Check size={12} strokeWidth={3.5} color="#16a34a" /> : <X size={12} strokeWidth={3.5} color="#dc2626" />}
      </span>
    </button>
  )
}
