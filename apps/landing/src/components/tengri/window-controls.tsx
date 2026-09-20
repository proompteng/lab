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
      className="group/controls pointer-events-auto relative z-30 flex translate-x-px items-center"
    >
      <WindowControlButton active={active} kind="close" label={`Close ${title}`} onClick={onClose}>
        <span className="relative size-2 opacity-0 before:absolute before:inset-x-0 before:top-1/2 before:h-0.5 before:-translate-y-1/2 before:rotate-45 before:rounded-full before:bg-current after:absolute after:inset-x-0 after:top-1/2 after:h-0.5 after:-translate-y-1/2 after:-rotate-45 after:rounded-full after:bg-current group-hover/controls:opacity-100 group-focus-visible:opacity-100" />
      </WindowControlButton>
      <WindowControlButton active={active} kind="minimize" label={`Minimize ${title}`} onClick={onMinimize}>
        <span className="h-0.5 w-2 rounded-full bg-current opacity-0 group-hover/controls:opacity-100 group-focus-visible:opacity-100" />
      </WindowControlButton>
      <WindowControlButton
        active={active}
        kind="maximize"
        label={`${maximized ? 'Restore' : 'Maximize'} ${title}`}
        onClick={onToggleMaximize}
      >
        <span
          className={cn(
            'relative opacity-0 before:absolute before:bg-current before:[clip-path:polygon(0_0,100%_0,0_100%)] after:absolute after:bg-current after:[clip-path:polygon(100%_0,100%_100%,0_100%)] group-hover/controls:opacity-100 group-focus-visible:opacity-100',
            maximized
              ? 'size-[7px] before:right-0 before:bottom-0 before:size-[3px] after:top-0 after:left-0 after:size-[3px]'
              : 'size-1.5 before:top-0 before:left-0 before:size-[5px] before:rounded-tl-[0.75px] after:right-0 after:bottom-0 after:size-[5px] after:rounded-br-[0.75px]',
          )}
        />
      </WindowControlButton>
    </div>
  )
}

const controlAppearance = {
  close: {
    active: 'bg-[#ff5c60]',
    inactive: 'bg-zinc-500/65 group-hover/controls:bg-[#ff5c60]',
    position: 'translate-x-0.5',
  },
  minimize: {
    active: 'bg-[#fac800]',
    inactive: 'bg-zinc-500/65 group-hover/controls:bg-[#fac800]',
    position: 'translate-x-px',
  },
  maximize: {
    active: 'bg-[#35c759]',
    inactive: 'bg-zinc-500/65 group-hover/controls:bg-[#35c759]',
    position: '',
  },
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
  kind: keyof typeof controlAppearance
  label: string
  onClick: (() => void) | undefined
}) {
  const disabled = !onClick
  const appearance = controlAppearance[kind]
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
          'grid size-3.5 place-items-center rounded-full text-black/40',
          appearance.position,
          disabled ? 'bg-white/16' : [active ? appearance.active : appearance.inactive, 'group-active:brightness-90'],
        )}
      >
        {disabled ? null : children}
      </span>
    </button>
  )
}
