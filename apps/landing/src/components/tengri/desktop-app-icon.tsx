import Image from 'next/image'

import type { TengriApp } from '@/lib/tengri/window-manager'
import { cn } from '@/lib/utils'

const APP_ICONS: Record<TengriApp, string> = {
  finder: '/tengri/icons/finder.png',
  chrome: '/tengri/icons/chrome.png',
  code: '/tengri/icons/code.png',
  terminal: '/tengri/icons/terminal.png',
  settings: '/tengri/icons/settings.png',
}

export function DesktopAppIcon({ app, className }: { app: TengriApp; className?: string }) {
  return (
    <Image
      alt=""
      aria-hidden="true"
      className={cn('pointer-events-none size-12 shrink-0 select-none object-contain', className)}
      draggable={false}
      height={56}
      loading="eager"
      sizes="56px"
      src={APP_ICONS[app]}
      width={56}
    />
  )
}
