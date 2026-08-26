'use client'

import * as AlertDialog from '@radix-ui/react-alert-dialog'
import { LoaderCircle } from 'lucide-react'

export function ConfirmationDialog({
  busy = false,
  confirmLabel,
  destructive = true,
  description,
  error,
  onConfirm,
  onOpenChange,
  open,
  title,
}: {
  busy?: boolean
  confirmLabel: string
  destructive?: boolean
  description: string
  error?: string
  onConfirm: () => void
  onOpenChange: (open: boolean) => void
  open: boolean
  title: string
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-[7000] bg-black/45 backdrop-blur-sm data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out data-[state=open]:fade-in" />
        <AlertDialog.Content
          className="tengri-panel fixed top-1/2 left-1/2 z-[7001] w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-[24px] border border-white/18 p-6 shadow-[0_40px_120px_rgba(0,0,0,0.58)] outline-none backdrop-blur-3xl"
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault()
          }}
        >
          <AlertDialog.Title className="text-lg font-semibold tracking-tight text-white/94">{title}</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm leading-6 text-white/50">
            {description}
          </AlertDialog.Description>
          {error ? (
            <p role="alert" className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-200">
              {error}
            </p>
          ) : null}
          <div className="mt-6 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <button
                type="button"
                disabled={busy}
                className="rounded-xl border border-white/10 bg-white/7 px-4 py-2 text-sm font-medium text-white/74 hover:bg-white/11 disabled:opacity-40"
              >
                Cancel
              </button>
            </AlertDialog.Cancel>
            <button
              type="button"
              disabled={busy}
              aria-busy={busy}
              onClick={onConfirm}
              className={`inline-flex min-w-24 items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold text-white shadow-lg disabled:opacity-45 ${
                destructive
                  ? 'bg-red-500/85 shadow-red-950/25 hover:bg-red-500'
                  : 'bg-[#2574e8] shadow-[#2574e8]/20 hover:bg-[#3180ee]'
              }`}
            >
              {busy ? <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" /> : null}
              {confirmLabel}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
