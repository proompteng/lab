'use client'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@proompteng/design/ui'
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
    <AlertDialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <AlertDialogContent
        aria-busy={busy}
        className="tengri-panel z-[7001] w-[min(440px,calc(100vw-32px))] max-w-none gap-0 rounded-[24px] border border-white/18 bg-transparent p-6 text-white shadow-[0_40px_120px_rgba(0,0,0,0.58)] ring-0 backdrop-blur-3xl"
      >
        <AlertDialogHeader className="block text-left">
          <AlertDialogTitle className="text-lg font-semibold tracking-tight text-white/94">{title}</AlertDialogTitle>
          <AlertDialogDescription className="mt-2 text-sm leading-6 text-white/50">
            {description}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <p role="alert" className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-200">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter className="mt-6 flex-row justify-end">
          <AlertDialogCancel
            disabled={busy}
            className="rounded-xl border-white/10 bg-white/7 text-white/74 hover:bg-white/11 disabled:opacity-40"
          >
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            type="button"
            variant={destructive ? 'destructive' : 'default'}
            disabled={busy}
            aria-busy={busy}
            onClick={onConfirm}
            className={`inline-flex min-w-24 items-center justify-center gap-2 rounded-xl text-white shadow-lg disabled:opacity-45 ${
              destructive ? 'shadow-red-950/25' : 'bg-[#2574e8] shadow-[#2574e8]/20 hover:bg-[#3180ee]'
            }`}
          >
            {busy ? <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" /> : null}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
