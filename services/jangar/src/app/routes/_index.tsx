import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_index')({
  component: OpenWebUI,
})

function OpenWebUI() {
  const openwebuiPort = import.meta.env.VITE_OPENWEBUI_PORT ?? '8080'
  const openwebuiUrl = import.meta.env.VITE_OPENWEBUI_URL ?? `http://localhost:${openwebuiPort}`

  return (
    <section className="flex flex-col gap-6" aria-label="OpenWebUI embed">
      <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-950/70 shadow-inner shadow-slate-900/60">
        <iframe
          title="OpenWebUI embedded session"
          src={openwebuiUrl}
          className="h-[85vh] min-h-[640px] w-full border-0 bg-slate-950"
          loading="lazy"
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-downloads"
        />
      </div>
    </section>
  )
}
