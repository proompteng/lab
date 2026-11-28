import { Skeleton } from '@proompteng/design/ui'

export default function LoadingWorkspace() {
  return (
    <main
      data-admin-console
      className="tengri-theme font-geist min-h-dvh space-y-6 bg-zinc-950 px-5 py-10 text-zinc-100 sm:px-10"
      aria-busy="true"
    >
      <p role="status" className="text-sm text-zinc-400">
        Loading workspace administration…
      </p>
      <Skeleton className="h-10 w-64" />
      <Skeleton className="h-64 w-full" />
    </main>
  )
}
