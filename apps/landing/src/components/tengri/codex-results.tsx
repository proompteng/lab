'use client'

import { FileText, ExternalLink, Pin, PinOff } from 'lucide-react'
import { memo } from 'react'
import { CodexEventCard } from './codex-event-card'
import type { codexConversationResults } from './codex-results-model'
import { WorkspaceFileLink, useWorkspaceResources } from './workspace-file-link'

export const CodexResults = memo(function CodexResults({
  results,
}: {
  results: ReturnType<typeof codexConversationResults>
}) {
  const { pins, togglePin } = useWorkspaceResources()
  const files = results.references.filter((reference) => reference.file)
  const links = results.references.filter((reference) => !reference.file)
  return (
    <section
      aria-label="Conversation results"
      className="tengri-chat-scrollbar h-full overflow-auto px-4 py-4 @[540px]/agent:px-6"
    >
      <h2 className="text-heading-16 text-zinc-100">Results</h2>
      <p className="mt-1 text-copy-14 text-zinc-400">
        References and recorded changes from this conversation. Open a file to inspect its current contents.
      </p>
      {!files.length && !links.length && !results.diffs.length ? (
        <p className="mt-6 text-copy-14 text-zinc-400">
          Files, links, and changes will appear here when the agent reports them.
        </p>
      ) : null}
      {files.length ? (
        <section className="mt-5" aria-label="Referenced files">
          <h3 className="text-label-14 font-medium text-zinc-300">Files · {files.length}</h3>
          <ul className="mt-2 space-y-1">
            {files.map((reference) => {
              const file = reference.file!
              const pinned = pins.some((pin) => pin.path === file.path)
              return (
                <li
                  key={file.path}
                  className="flex min-w-0 items-center gap-2 rounded-md border border-zinc-800 px-3 py-2 text-copy-14"
                >
                  <FileText className="size-4 shrink-0 text-zinc-400" aria-hidden="true" />
                  <div className="min-w-0 flex-1 break-words">
                    <WorkspaceFileLink href={reference.href}>{reference.label}</WorkspaceFileLink>
                    <p className="mt-0.5 break-all text-label-12 text-zinc-500">{file.path}</p>
                  </div>
                  <button
                    type="button"
                    aria-label={`${pinned ? 'Unpin' : 'Pin'} ${file.path}`}
                    onClick={() => togglePin(file)}
                    className="grid size-8 shrink-0 place-items-center rounded text-zinc-400 outline-none hover:bg-white/[0.06] hover:text-zinc-100 focus-visible:ring-1 focus-visible:ring-blue-400"
                  >
                    {pinned ? (
                      <PinOff className="size-4" aria-hidden="true" />
                    ) : (
                      <Pin className="size-4" aria-hidden="true" />
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}
      {links.length ? (
        <section className="mt-5" aria-label="Referenced links">
          <h3 className="text-label-14 font-medium text-zinc-300">Links · {links.length}</h3>
          <ul className="mt-2 space-y-2">
            {links.map((reference) => (
              <li key={reference.href} className="flex min-w-0 items-start gap-2 break-words text-copy-14">
                <ExternalLink className="mt-0.5 size-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
                <WorkspaceFileLink href={reference.href}>{reference.label}</WorkspaceFileLink>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {results.diffs.length ? (
        <section className="mt-5" aria-label="Recorded changes">
          <h3 className="mb-2 text-label-14 font-medium text-zinc-300">Recorded changes · {results.diffs.length}</h3>
          <div className="space-y-2">
            {results.diffs.map((diff) => (
              <CodexEventCard key={diff.id} kind="file-diff" text={diff.text} />
            ))}
          </div>
        </section>
      ) : null}
    </section>
  )
})
