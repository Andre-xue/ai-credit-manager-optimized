import { useEffect, useRef, useState } from 'react'

/** 果冻开关（与全 App 既有 jelly-toggle 同款动效，Agent 工作台共用） */
export function JellyToggle({ checked, onChange, disabled }: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  const [anim, setAnim] = useState<'on' | 'off' | null>(null)
  const prev = useRef(checked)
  useEffect(() => {
    if (prev.current !== checked) {
      setAnim(checked ? 'on' : 'off')
      prev.current = checked
      const t = window.setTimeout(() => setAnim(null), 360)
      return () => window.clearTimeout(t)
    }
  }, [checked])
  return (
    <button role="switch" aria-checked={checked} disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`jelly-toggle ${checked ? 'is-on' : ''}`} aria-label={checked ? '关闭' : '开启'}
      style={disabled ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}>
      <span className={`jelly-dot ${anim ? `anim-${anim}` : (checked ? 'static-on' : 'static-off')}`} />
    </button>
  )
}
