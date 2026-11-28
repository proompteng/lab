'use client'

import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'

import { cn } from '@/lib/utils'

export function CodexCopyButton({
  className,
  label,
  value,
}: {
  className?: string
  label: string
  value: string | (() => string)
}) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (status === 'idle') return
    const resetTimer = setTimeout(() => setStatus('idle'), 2_500)
    return () => clearTimeout(resetTimer)
  }, [status])

  async function copy() {
    setStatus('idle')
    try {
      await navigator.clipboard.writeText(typeof value === 'function' ? value() : value)
      setStatus('copied')
    } catch {
      setStatus('failed')
    }
  }

  return (
    <button
      type="button"
      aria-label={label}
      title={status === 'failed' ? 'Clipboard unavailable. Select and copy the text.' : label}
      onClick={() => void copy()}
      className={cn(
        'inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-xs text-zinc-400 outline-none transition-colors hover:bg-zinc-700/50 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-blue-400 motion-reduce:transition-none',
        status === 'failed' && 'text-amber-200',
        className,
      )}
    >
      {status === 'copied' ? (
        <Check className="size-3.5" aria-hidden="true" />
      ) : (
        <Copy className="size-3.5" aria-hidden="true" />
      )}
      <span aria-live="polite">{status === 'copied' ? 'Copied' : status === 'failed' ? 'Copy failed' : 'Copy'}</span>
    </button>
  )
}
