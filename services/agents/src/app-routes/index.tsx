import { createFileRoute } from '@tanstack/react-router'

import { ControlPlaneDashboard } from '../components/control-plane/control-plane-dashboard'

export const Route = createFileRoute('/')({
  component: ControlPlaneDashboard,
})
