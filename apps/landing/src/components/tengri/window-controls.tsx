'use client'

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function WindowControls({
  active,
  maximized = false,
  onClose,
  onMinimize,
  onToggleMaximize,
  title,
}: {
  active: boolean
  maximized?: boolean
  onClose?: () => void
  onMinimize?: () => void
  onToggleMaximize?: () => void
  title: string
}) {
  return (
    <div
      role="group"
      aria-label="Window controls"
      className="group/controls pointer-events-auto relative z-30 flex items-center"
    >
      <WindowControlButton active={active} kind="close" label={`Close ${title}`} onClick={onClose}>
        <span className="relative size-2 opacity-0 before:absolute before:inset-x-0 before:top-1/2 before:h-px before:-translate-y-1/2 before:rotate-45 before:bg-current after:absolute after:inset-x-0 after:top-1/2 after:h-px after:-translate-y-1/2 after:-rotate-45 after:bg-current group-hover/controls:opacity-100 group-focus-visible:opacity-100" />
      </WindowControlButton>
      <WindowControlButton active={active} kind="minimize" label={`Minimize ${title}`} onClick={onMinimize}>
        <span className="h-px w-2 bg-current opacity-0 group-hover/controls:opacity-100 group-focus-visible:opacity-100" />
      </WindowControlButton>
      <WindowControlButton
        active={active}
        kind="maximize"
        label={`${maximized ? 'Restore' : 'Maximize'} ${title}`}
        onClick={onToggleMaximize}
      >
        <span
          className={cn(
            'relative size-[7px] opacity-0 before:absolute before:size-[3px] before:bg-current before:[clip-path:polygon(0_0,100%_0,0_100%)] after:absolute after:size-[3px] after:bg-current after:[clip-path:polygon(100%_0,100%_100%,0_100%)] group-hover/controls:opacity-100 group-focus-visible:opacity-100',
            maximized
              ? 'before:right-0 before:bottom-0 after:top-0 after:left-0'
              : 'before:top-0 before:left-0 after:right-0 after:bottom-0',
          )}
        />
      </WindowControlButton>
    </div>
  )
}

const controlColors = {
  close: { active: 'bg-[#ff5f57]', inactive: 'bg-zinc-500/65 group-hover/controls:bg-[#ff5f57]' },
  minimize: { active: 'bg-[#febc2e]', inactive: 'bg-zinc-500/65 group-hover/controls:bg-[#febc2e]' },
  maximize: { active: 'bg-[#28c840]', inactive: 'bg-zinc-500/65 group-hover/controls:bg-[#28c840]' },
}

function WindowControlButton({
  active,
  children,
  kind,
  label,
  onClick,
}: {
  active: boolean
  children: ReactNode
  kind: keyof typeof controlColors
  label: string
  onClick: (() => void) | undefined
}) {
  const disabled = !onClick
  const colors = controlColors[kind]
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      className="group grid h-6 w-6 shrink-0 cursor-default place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-white/70"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onClick}
    >
      <span
        aria-hidden="true"
        className={cn(
          'grid size-3 place-items-center rounded-full border border-black/15 text-black/60',
          disabled ? 'bg-white/16' : [active ? colors.active : colors.inactive, 'group-active:brightness-90'],
        )}
      >
        {disabled ? null : children}
      </span>
    </button>
  )
}
