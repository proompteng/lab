import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/torghut/visuals')({
  beforeLoad: () => {
    throw redirect({ to: '/torghut/charts', replace: true })
  },
})
