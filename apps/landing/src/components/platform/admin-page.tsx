import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { getPlatformIdentity } from '@/lib/platform/auth'
import { isAdminPortal } from '@/lib/platform/admin'
import { AdminPortal } from './admin-portal'
import type { PortalSection } from '@/lib/platform/portal'

export async function AdminPage({ workspaceId, section }: { workspaceId?: string; section?: PortalSection } = {}) {
  if (!isAdminPortal()) notFound()
  const identity = await getPlatformIdentity(await headers())
  return (
    <AdminPortal
      identity={identity ? { humanId: identity.session.humanId, name: identity.user.name } : null}
      workspaceId={workspaceId}
      section={section}
    />
  )
}
