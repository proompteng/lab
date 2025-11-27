import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_index')({
  component: OpenWebUI,
})

function OpenWebUI() {
  const openwebuiPort = import.meta.env.VITE_OPENWEBUI_PORT ?? '8080'
  const openwebuiUrl = import.meta.env.VITE_OPENWEBUI_URL ?? `http://localhost:${openwebuiPort}`

  return (
    <section className="flex flex-1 min-h-0 min-w-0 overflow-hidden" aria-label="OpenWebUI embed">
      <iframe
        title="OpenWebUI embedded session"
        src={openwebuiUrl}
        className="block h-full w-full flex-1 min-h-0 min-w-0 border-0"
        loading="lazy"
        sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-downloads"
      />
    </section>
  )
}
