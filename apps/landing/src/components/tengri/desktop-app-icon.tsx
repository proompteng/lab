import { useId } from 'react'

import type { TengriApp } from '@/lib/tengri/window-manager'
import { cn } from '@/lib/utils'

export function DesktopAppIcon({ app, className }: { app: TengriApp; className?: string }) {
  const id = useId()
  const background = `${id}-background`
  const foreground = `${id}-foreground`

  return (
    <svg
      aria-hidden="true"
      className={cn('size-12 shrink-0 overflow-visible drop-shadow-[0_3px_3px_rgba(0,0,0,0.25)]', className)}
      fill="none"
      viewBox="0 0 64 64"
    >
      <defs>
        <linearGradient id={background} x1="32" x2="32" y1="2" y2="62" gradientUnits="userSpaceOnUse">
          <stop stopColor={app === 'finder' ? '#59c7ff' : app === 'terminal' ? '#535557' : '#fafafa'} />
          <stop offset="1" stopColor={app === 'finder' ? '#087ae9' : app === 'terminal' ? '#292a2c' : '#bfc2c8'} />
        </linearGradient>
        <linearGradient id={foreground} x1="14" x2="51" y1="13" y2="54" gradientUnits="userSpaceOnUse">
          <stop stopColor={app === 'code' ? '#33b9f2' : '#f9fbff'} />
          <stop offset="1" stopColor={app === 'code' ? '#0877c0' : '#c9dfef'} />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="14" fill={`url(#${background})`} />
      {app === 'finder' ? (
        <>
          <path
            d="M34 2h14c9 0 14 5 14 14v32c0 9-5 14-14 14H34c-3-10-4-20-3-28h-8c1-12 4-23 11-32Z"
            fill={`url(#${foreground})`}
          />
          <path
            d="M18 20v6m27-6v6M14 39c9 9 27 9 36-1M32 34c-1 8 0 18 2 23"
            stroke="#172943"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
        </>
      ) : app === 'chrome' ? (
        <>
          <circle cx="32" cy="32" r="25" fill="#fbbc05" />
          <path d="M10.3 44.5A25 25 0 0 1 53.7 19.5H32c-10 0-14 10-10.8 18.7Z" fill="#ea4335" />
          <path d="M10.3 19.5 21.2 38.2c5 8.7 16 7.5 21.6 0L32 57a25 25 0 0 1-21.7-37.5Z" fill="#34a853" />
          <circle cx="32" cy="32" r="12" fill="#4285f4" stroke="#f5f5f5" strokeWidth="3" />
        </>
      ) : app === 'code' ? (
        <>
          <path d="m44 10 11 5v34l-11 5-25-23L9 39l-4-3V25l4-3 10 8Z" fill="#0877b9" />
          <path
            d="m44 10-25 20L9 22l-4 3 14 14 25-20v26L19 25 5 36l4 3 10-8 25 23 11-5V15Z"
            fill={`url(#${foreground})`}
          />
        </>
      ) : app === 'terminal' ? (
        <>
          <rect x="6" y="7" width="52" height="49" rx="8" fill="#131416" stroke="#93969b" />
          <path
            d="m15 20 10 8-10 8m16 1h15"
            stroke="#f1f1f1"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : (
        <g>
          <circle cx="32" cy="32" r="24" fill="#8c9199" stroke="#f2f3f6" strokeWidth="1.5" />
          {Array.from({ length: 12 }, (_, index) => (
            <rect
              key={index}
              x="29"
              y="9"
              width="6"
              height="10"
              rx="1"
              fill="#dce0e5"
              transform={`rotate(${index * 30} 32 32)`}
            />
          ))}
          <circle cx="32" cy="32" r="17" fill="#5b6069" stroke="#e6e8ec" strokeWidth="5" />
          <path d="M32 19v8m11.3 11.5-7-4M20.7 38.5l7-4" stroke="#e6e8ec" strokeWidth="4" />
          <circle cx="32" cy="32" r="7" fill="#8c9199" stroke="#e6e8ec" strokeWidth="3" />
        </g>
      )}
      <rect x="2.5" y="2.5" width="59" height="59" rx="13.5" stroke="white" strokeOpacity="0.2" />
    </svg>
  )
}
