'use client'

import { LoaderCircle, Trash2 } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@proompteng/design/ui'

export function ConfirmationDialog({
  busy,
  confirmLabel = 'Delete Agent',
  description,
  error,
  onCancel,
  onConfirm,
  open,
  title,
}: {
  busy: boolean
  confirmLabel?: string
  description: string
  error: string
  onCancel: () => void
  onConfirm: () => void
  open: boolean
  title: string
}) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !busy) onCancel()
      }}
    >
      <AlertDialogContent
        aria-busy={busy}
        overlayClassName="z-[4000] bg-black/45 backdrop-blur-md"
        className="font-inter z-[4001] w-[calc(100%-2.5rem)] max-w-md gap-0 overflow-hidden rounded-[24px] border border-white/18 bg-[rgba(29,31,39,0.94)] p-0 text-white shadow-[0_42px_120px_rgba(0,0,0,0.62),inset_0_1px_0_rgba(255,255,255,0.16)] ring-0 backdrop-blur-3xl sm:max-w-md"
      >
        <WindowTitleBar title="Tengri" />
        <div className="p-6">
          <AlertDialogHeader className="block text-left">
            <AlertDialogMedia className="mb-0 grid h-11 w-11 place-items-center rounded-2xl border border-red-300/15 bg-red-500/10">
              <Trash2 aria-hidden="true" className="h-5 w-5 text-red-200" />
            </AlertDialogMedia>
            <AlertDialogTitle className="mt-4 text-lg font-semibold tracking-tight text-white/95">
              {title}
            </AlertDialogTitle>
            <AlertDialogDescription className="mt-2 text-sm leading-6 text-white/52">
              {description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? (
            <p
              role="alert"
              className="mt-4 rounded-xl border border-red-300/12 bg-red-500/8 px-3 py-2 text-xs text-red-100"
            >
              {error}
            </p>
          ) : null}
          <AlertDialogFooter className="mt-6 flex-row justify-end">
            <AlertDialogCancel
              disabled={busy}
              className="rounded-xl border border-white/12 bg-white/7 px-4 py-2 text-sm font-medium text-white/78 outline-none transition hover:bg-white/11 focus-visible:ring-2 focus-visible:ring-white/55 disabled:opacity-40"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              type="button"
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-xl bg-red-700 px-4 py-2 text-sm font-semibold text-white outline-none transition hover:bg-red-600 focus-visible:ring-2 focus-visible:ring-red-200 disabled:opacity-40"
              onClick={onConfirm}
            >
              {busy ? <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" /> : null}
              {confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function WindowTitleBar({ title }: { title: string }) {
  return (
    <div className="relative flex h-11 items-center border-b border-white/9 bg-white/[0.035] px-4">
      <div aria-hidden="true" className="flex gap-2">
        <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
        <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
        <span className="h-3 w-3 rounded-full bg-[#28c840]" />
      </div>
      <span className="pointer-events-none absolute inset-x-24 truncate text-center text-xs font-semibold text-white/54">
        {title}
      </span>
    </div>
  )
}
