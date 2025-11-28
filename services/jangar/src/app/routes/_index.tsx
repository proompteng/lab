import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_index')({
  component: OpenWebUILink,
})

function OpenWebUILink() {
  const openwebuiHost = import.meta.env.VITE_OPENWEBUI_EXTERNAL_URL ?? 'http://openwebui'

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-xl rounded-lg border border-slate-800 bg-slate-900/50 p-6 text-center shadow-sm">
        <h1 className="text-lg font-semibold text-slate-50">OpenWebUI is now served separately</h1>
        <p className="mt-3 text-sm text-slate-300">
          Use the dedicated hostname to access the console. Your chats will still call Jangar for models and
          completions.
        </p>
        <a
          className="mt-5 inline-flex items-center justify-center rounded-md bg-blue-500 px-4 py-2 text-sm font-medium text-white shadow hover:bg-blue-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-300"
          href={openwebuiHost}
          target="_blank"
          rel="noreferrer"
        >
          Open OpenWebUI
        </a>
      </div>
    </main>
  )
}
