import { createFileRoute, Outlet } from '@tanstack/react-router'

export const Route = createFileRoute('/terminals/$sessionId')({
  component: TerminalSessionLayout,
})

function TerminalSessionLayout() {
  return <Outlet />
}
