import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { getPlatformIdentity } from '@/lib/platform/auth'
import { isAdminPortal } from '@/lib/platform/admin'
import { AdminPortal } from './admin-portal'
import type { PortalSection } from '@/lib/platform/portal'
import { platformSession } from '@/lib/platform/auth'
import { ofzCall } from '@/lib/platform/ofz'
import { PlatformAuthorizationService } from '@/lib/tengri/generated/proompteng/authz/v1/platform_pb'

export async function AdminPage({ workspaceId, section }: { workspaceId?: string; section?: PortalSection } = {}) {
  if (!isAdminPortal()) notFound()
  const identity = await getPlatformIdentity(await headers())
  // Independent authenticated reads run on the server. Failed reads are retried through the BFF's error UI.
  const [directory, workspace] = identity
    ? await Promise.allSettled([
        ofzCall(PlatformAuthorizationService.method.listPlatformWorkspaces, {
          administrator: platformSession(identity),
        }),
        workspaceId
          ? ofzCall(PlatformAuthorizationService.method.getPlatformWorkspace, {
              administrator: platformSession(identity),
              workspaceId,
            })
          : Promise.resolve(undefined),
      ])
    : []
  return (
    <AdminPortal
      key={`${identity?.session.humanId}:${workspaceId}:${section}`}
      identity={identity ? { humanId: identity.session.humanId, name: identity.user.name } : null}
      workspaceId={workspaceId}
      section={section}
      initialWorkspaces={directory?.status === 'fulfilled' ? directory.value.workspaces : undefined}
      initialDetail={workspace?.status === 'fulfilled' ? workspace.value : undefined}
    />
  )
}
