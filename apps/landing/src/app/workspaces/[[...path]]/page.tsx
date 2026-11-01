import { notFound } from 'next/navigation'
import { z } from 'zod'
import { AdminPage } from '@/components/platform/admin-page'
import { portalSections, type PortalSection } from '@/lib/platform/portal'
export const dynamic = 'force-dynamic'
export const metadata = { title: 'Workspace administration', robots: { index: false, follow: false } }
export default async function WorkspacePage({ params }: { params: Promise<{ path?: string[] }> }) {
  const path = (await params).path || []
  if (
    path.length > 2 ||
    (path[0] && !z.uuid().safeParse(path[0]).success) ||
    (path[1] && !portalSections.includes(path[1] as PortalSection))
  )
    notFound()
  return <AdminPage workspaceId={path[0]} section={(path[1] as PortalSection | undefined) || 'integrations'} />
}
