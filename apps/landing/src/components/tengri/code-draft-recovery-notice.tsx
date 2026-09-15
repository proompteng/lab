'use client'

import { Download } from 'lucide-react'
import { useSyncExternalStore } from 'react'

import {
  codeDraftStorageKeyForId,
  getVolatileCodeDrafts,
  subscribeVolatileCodeDrafts,
  type CodeDraft,
} from './code-editor-draft-storage'

const emptyDrafts: readonly CodeDraft[] = []
const getServerDrafts = () => emptyDrafts

export function CodeDraftRecoveryNotice({
  ownerId,
  placement = 'floating',
}: {
  ownerId: string | undefined
  placement?: 'floating' | 'inline'
}) {
  const drafts = useSyncExternalStore(subscribeVolatileCodeDrafts, getVolatileCodeDrafts, getServerDrafts)
  const ownedDrafts = ownerId
    ? drafts.filter((draft) => draft.ownerId === ownerId).sort((left, right) => right.updatedAt - left.updatedAt)
    : []
  if (ownedDrafts.length === 0) return null

  return (
    <aside
      aria-label="Unsaved draft recovery"
      className={`font-system rounded-xl border border-amber-400/50 bg-zinc-950 p-4 text-sm text-zinc-100 shadow-2xl ${placement === 'inline' ? 'mx-4 mb-4' : 'fixed inset-x-3 bottom-3 z-[1000] mx-auto max-w-lg'}`}
    >
      <p className="font-semibold" role="alert">
        Keep a copy of your unsaved edits
      </p>
      <p className="mt-1 text-zinc-300">
        Browser storage is unavailable or full. These drafts are only in this tab, including while your agent is
        sleeping. Download them before reloading or closing it.
      </p>
      <ul className="mt-3 max-h-48 space-y-2 overflow-y-auto">
        {ownedDrafts.map((draft) => (
          <li className="flex items-center justify-between gap-3" key={codeDraftStorageKeyForId(draft, draft.draftId)}>
            <span className="min-w-0 break-all text-xs text-zinc-300">
              {draft.path}
              <span className="mt-0.5 block text-zinc-400">Edited {new Date(draft.updatedAt).toLocaleString()}</span>
            </span>
            <button
              aria-label={`Download draft for ${draft.path}`}
              className="flex shrink-0 items-center gap-1.5 rounded-md border border-zinc-600 bg-zinc-800 px-2.5 py-1.5 text-xs hover:bg-zinc-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300"
              onClick={() => downloadDraft(draft)}
              type="button"
            >
              <Download aria-hidden="true" className="size-3.5" />
              Download
            </button>
          </li>
        ))}
      </ul>
    </aside>
  )
}

function downloadDraft(draft: CodeDraft) {
  const url = URL.createObjectURL(new Blob([draft.content], { type: draft.contentType || 'text/plain;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = draft.path.split('/').pop() || 'tengri-draft.txt'
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}
