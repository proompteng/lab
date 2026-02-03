import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link as RouterLink, useNavigate } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
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
import { type LinkInput, serverFns } from '../server/links'

export const Route = createFileRoute('/admin/links/create')({
  component: CreateLinkRoute,
})

function CreateLinkRoute() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const createMutation = useMutation({
    mutationFn: (input: LinkInput) => serverFns.createLink({ data: input }),
    onSuccess: async (result) => {
      if (!result.ok) {
        toast.error(result.message)
        return
      }
      toast.success('Link created')
      await queryClient.invalidateQueries({ queryKey: ['links'] })
      navigate({ to: '/admin' })
    },
    onError: () => {
      toast.error('Unable to create link right now. Please try again.')
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
              <BreadcrumbPage>Create</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </div>

      <LinkForm
        heading="Add a new short link"
        description="Fill out the details below and save to publish immediately."
        submitLabel="Save link"
        submitIcon={<Plus className="mr-2 h-4 w-4" />}
        busy={createMutation.isPending}
        onSubmit={(values) => createMutation.mutate(values)}
        onCancel={() => navigate({ to: '/admin' })}
      />
    </div>
  )
}
