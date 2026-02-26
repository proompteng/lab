import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/control-plane/torghut/quant/')({
  beforeLoad: () => {
    throw redirect({ to: '/torghut/control-plane', replace: true })
  },
})
