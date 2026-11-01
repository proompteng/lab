import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AdminPortal } from './admin-portal'
import { portalSections } from '@/lib/platform/portal'
const parts = window.location.pathname.split('/')
function Fixture() {
  const [identity, setIdentity] = useState<Parameters<typeof AdminPortal>[0]['identity']>({
    humanId: 'a'.repeat(64),
    name: 'Alex',
  })
  useEffect(() => {
    const refresh = () => setIdentity(null)
    window.addEventListener('fixture-identity-refresh', refresh)
    return () => window.removeEventListener('fixture-identity-refresh', refresh)
  }, [])
  return (
    <AdminPortal
      identity={identity}
      workspaceId={parts[2]}
      section={portalSections.find((section) => section === parts[3]) || 'integrations'}
    />
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
