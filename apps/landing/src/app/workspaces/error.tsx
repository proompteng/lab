'use client'

import { Button } from '@proompteng/design/ui'

export default function WorkspaceError({ reset }: { reset: () => void }) {
  return (
    <main data-admin-console className="tengri-theme font-geist min-h-dvh bg-zinc-950 px-5 py-16 text-zinc-100">
      <section className="mx-auto max-w-md space-y-4" role="alert">
        <h1 className="text-xl font-semibold">Administration is unavailable</h1>
        <p className="text-sm leading-6 text-zinc-400">
          Your workspace could not be verified. Retry, or return to workspace selection. Reconcile any saved change on
          its original page.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button onClick={reset}>Retry</Button>
          <Button variant="outline" render={<a href="/workspaces" />}>
            Choose a workspace
          </Button>
        </div>
      </section>
    </main>
  )
}
