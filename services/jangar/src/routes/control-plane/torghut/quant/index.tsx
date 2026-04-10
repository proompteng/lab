import { createFileRoute } from '@tanstack/react-router'

import { ControlPlaneTorghutQuantPage } from '@/components/agents-control-plane-redirect'

export const Route = createFileRoute('/control-plane/torghut/quant/')({
  component: ControlPlaneTorghutQuantPage,
})
