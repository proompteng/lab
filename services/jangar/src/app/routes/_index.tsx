import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_index')({
  component: Welcome,
})

function Welcome() {
  return (
    <main className="flex flex-1 items-center justify-center p-10">
      <div className="max-w-2xl space-y-3 text-center">
        <h1 className="text-2xl font-semibold text-slate-50">Welcome to Jangar</h1>
        <p className="text-sm text-slate-300">
          Jangar now runs the conversational stack and orchestrates attached UIs. Use the navigation to access consoles
          or tools configured for this environment.
        </p>
      </div>
    </main>
  )
}
