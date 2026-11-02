import { Button } from '@proompteng/design/ui'

export default function WorkspaceNotFound() {
  return (
    <main data-admin-console className="tengri-theme font-geist min-h-dvh bg-zinc-950 px-5 py-16 text-zinc-100">
      <section className="mx-auto max-w-md space-y-4">
        <h1 className="text-xl font-semibold">Page not found</h1>
        <p className="text-sm leading-6 text-zinc-400">
          This administration link is not valid. Choose a workspace to continue.
        </p>
        <Button render={<a href="/workspaces" />}>Choose a workspace</Button>
      </section>
    </main>
  )
}
