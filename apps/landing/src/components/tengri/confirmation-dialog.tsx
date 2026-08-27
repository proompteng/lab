'use client'

import { LoaderCircle, Trash2 } from 'lucide-react'

import { useModalFocus } from './modal-focus'

export function ConfirmationDialog({
  busy,
  description,
  error,
  onCancel,
  onConfirm,
  open,
  title,
}: {
  busy: boolean
  description: string
  error: string
  onCancel: () => void
  onConfirm: () => void
  open: boolean
  title: string
}) {
  const modalFocus = useModalFocus<HTMLElement>(open)
  if (!open) return null

  return (
    <div className="fixed inset-0 z-[4000] grid place-items-center bg-black/45 p-5 backdrop-blur-md">
      <section
        ref={modalFocus.ref}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-agent-title"
        aria-describedby="delete-agent-description"
        aria-busy={busy}
        tabIndex={-1}
        className="w-full max-w-md overflow-hidden rounded-[24px] border border-white/18 bg-[rgba(29,31,39,0.94)] text-white shadow-[0_42px_120px_rgba(0,0,0,0.62),inset_0_1px_0_rgba(255,255,255,0.16)] backdrop-blur-3xl"
        onKeyDown={(event) => {
          modalFocus.onKeyDown(event)
          if (event.key === 'Escape' && !busy) onCancel()
        }}
      >
        <WindowTitleBar title="Tengri" />
        <div className="p-6">
          <div className="grid h-11 w-11 place-items-center rounded-2xl border border-red-300/15 bg-red-500/10">
            <Trash2 aria-hidden="true" className="h-5 w-5 text-red-200" />
          </div>
          <h2 id="delete-agent-title" className="mt-4 text-lg font-semibold tracking-tight text-white/95">
            {title}
          </h2>
          <p id="delete-agent-description" className="mt-2 text-sm leading-6 text-white/52">
            {description}
          </p>
          {error ? (
            <p
              role="alert"
              className="mt-4 rounded-xl border border-red-300/12 bg-red-500/8 px-3 py-2 text-xs text-red-100"
            >
              {error}
            </p>
          ) : null}
          <div className="mt-6 flex justify-end gap-2">
            <button
              type="button"
              disabled={busy}
              className="rounded-xl border border-white/12 bg-white/7 px-4 py-2 text-sm font-medium text-white/78 outline-none transition hover:bg-white/11 focus-visible:ring-2 focus-visible:ring-white/55 disabled:opacity-40"
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-xl bg-red-700 px-4 py-2 text-sm font-semibold text-white outline-none transition hover:bg-red-600 focus-visible:ring-2 focus-visible:ring-red-200 disabled:opacity-40"
              onClick={onConfirm}
            >
              {busy ? <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" /> : null}
              Delete Agent
            </button>
          </div>
        </div>
      </section>
    </div>
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
