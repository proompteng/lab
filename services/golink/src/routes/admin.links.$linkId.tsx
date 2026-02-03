import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, notFound, Link as RouterLink, useNavigate } from '@tanstack/react-router'
import { Save } from 'lucide-react'
import { toast } from 'sonner'
import { LinkForm } from '../components/link-form'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@proompteng/design/ui'
import type { Link } from '../db/schema/links'
import { type LinkInput, serverFns } from '../server/links'

export const Route = createFileRoute('/admin/links/$linkId')({
  loader: async ({ params }) => {
    const id = Number(params.linkId)
    if (!Number.isInteger(id) || id <= 0) {
      throw notFound()
    }
    const record = await serverFns.getLinkById({ data: { id } })
    if (!record) {
      throw notFound()
    }
    return record
  },
  component: EditLinkRoute,
})

function EditLinkRoute() {
  const link = Route.useLoaderData() as Link
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const updateMutation = useMutation({
    mutationFn: (input: LinkInput) => serverFns.updateLink({ data: { ...input, id: link.id } }),
    onSuccess: async (result) => {
      if (!result.ok) {
        toast.error(result.message)
        return
      }
      toast.success('Link updated')
      await queryClient.invalidateQueries({ queryKey: ['links'] })
      navigate({ to: '/admin' })
    },
    onError: () => {
      toast.error('Unable to update link right now. Please try again.')
    },
  })

  return (
    <div className="grid gap-4">
      <div className="flex flex-col gap-3 rounded-sm glass-surface">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <RouterLink to="/">Home</RouterLink>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <RouterLink to="/admin">Admin</RouterLink>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <RouterLink to="/admin">Links</RouterLink>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{link.slug}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </div>

      <LinkForm
        heading={`Edit ${link.slug}`}
        description="Update the link details below."
        submitLabel="Save changes"
        submitIcon={<Save className="mr-2 h-4 w-4" />}
        busy={updateMutation.isPending}
        initialValues={{
          slug: link.slug,
          targetUrl: link.targetUrl,
          title: link.title ?? '',
          notes: link.notes ?? '',
        }}
        onSubmit={(values) => updateMutation.mutate(values)}
        onCancel={() => navigate({ to: '/admin' })}
      />
    </div>
  )
}
