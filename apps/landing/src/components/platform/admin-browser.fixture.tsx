import { createRoot } from 'react-dom/client'
import { AdminPortal } from './admin-portal'
import type { PortalSection } from '@/lib/platform/portal'
const parts = window.location.pathname.split('/')
createRoot(document.getElementById('root')!).render(
  <AdminPortal
    identity={{ humanId: 'a'.repeat(64), name: 'Alex' }}
    workspaceId={parts[2]}
    section={(parts[3] as PortalSection) || 'integrations'}
  />,
)
