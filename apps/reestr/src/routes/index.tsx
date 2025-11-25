import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: Home,
})

function Home() {
  return (
    <div className="p-4">
      <h1 className="text-2xl font-bold">Reestr Registry Browser</h1>
      <p className="mt-2">Welcome to the container registry browser.</p>
    </div>
  )
}
