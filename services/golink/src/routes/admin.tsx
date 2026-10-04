import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@proompteng/design/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Outlet, Link as RouterLink, useRouterState } from '@tanstack/react-router'
import { ArrowUpDown, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { Link } from '../db/schema/links'
import { cn } from '../lib/utils'
import { serverFns } from '../server/links'

export const Route = createFileRoute('/admin')({
  component: Admin,
})

type Filters = {
  sort?: 'createdAt' | 'slug' | 'title'
  direction?: 'asc' | 'desc'
}

const defaultFilters: Filters = { sort: 'createdAt', direction: 'desc' }
function Admin() {
  const { location } = useRouterState()
  const isAdminRoot = location.pathname === '/admin'
  const [filters, setFilters] = useState<Filters>(defaultFilters)

  const queryClient = useQueryClient()
  const queryKey = useMemo(
    () => ['links', filters.sort ?? 'createdAt', filters.direction ?? 'desc'] as const,
    [filters],
  )

  const linksQuery = useQuery<Link[]>({
    queryKey,
    queryFn: async () => (await serverFns.listLinks({ data: filters })) as Link[],
    enabled: isAdminRoot,
  })

  const buildRollback = (previous?: Link[]) => () => {
    if (previous) {
      queryClient.setQueryData(queryKey, previous)
    }
  }

  const deleteMutation = useMutation({
    mutationFn: (id: number) => serverFns.deleteLink({ data: { id } }),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey })
      const previous = queryClient.getQueryData<Link[]>(queryKey) ?? []
      queryClient.setQueryData<Link[]>(queryKey, (current = []) => current.filter((link) => link.id !== id))
      return { previous }
    },
    onError: (_error, _input, context) => buildRollback(context?.previous)(),
    onSuccess: (result, _input, context) => {
      if (!result.ok) {
        buildRollback(context?.previous)()
        return toast.error(result.message)
      }
      toast.success('Link deleted')
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  })

  const isBusy = deleteMutation.isPending
  const pendingDeleteId = deleteMutation.variables

  const renderRow = (link: Link) => {
    return (
      <TableRow key={link.id} className="align-top">
        <TableCell className="font-mono text-sm">
          <RouterLink
            to="/admin/links/$linkId"
            params={{ linkId: String(link.id) }}
            className="text-cyan-200 underline decoration-dotted underline-offset-4 hover:text-cyan-100"
          >
            {link.slug}
          </RouterLink>
        </TableCell>
        <TableCell>
          <a href={link.targetUrl} className="truncate text-cyan-200" target="_blank" rel="noreferrer">
            {link.targetUrl}
          </a>
        </TableCell>
        <TableCell>
          <p className="font-medium text-white">{link.title ?? '—'}</p>
        </TableCell>
        <TableCell className="max-w-xs">
          <p className="text-sm text-zinc-300 line-clamp-3">{link.notes ?? '—'}</p>
        </TableCell>
        <TableCell className="whitespace-nowrap text-sm text-zinc-400">
          {new Date(link.updatedAt ?? link.createdAt).toLocaleString()}
        </TableCell>
        <TableCell className="w-[170px] text-right">
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" asChild>
              <RouterLink to="/admin/links/$linkId" params={{ linkId: String(link.id) }}>
                Edit
              </RouterLink>
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="destructive" disabled={isBusy && pendingDeleteId === link.id}>
                  <Trash2 className="mr-1 h-4 w-4" />
                  Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete “{link.slug}”?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This action removes the short link immediately. Existing redirects will stop working and cannot be
                    undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={isBusy && pendingDeleteId === link.id}>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive text-white hover:bg-destructive/90"
                    disabled={isBusy && pendingDeleteId === link.id}
                    onClick={() => deleteMutation.mutate(link.id)}
                  >
                    Confirm delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </TableCell>
      </TableRow>
    )
  }

  if (!isAdminRoot) {
    return <Outlet />
  }

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
              <BreadcrumbPage>Links</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex gap-4">
            <Button variant="outline" size="sm" onClick={() => linksQuery.refetch()} disabled={linksQuery.isFetching}>
              <RefreshCw className={cn('mr-2 h-4 w-4', linksQuery.isFetching && 'animate-spin')} />
              Refresh
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" className="border-white/10">
                  <ArrowUpDown className="mr-2 h-4 w-4" /> Sort
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Sort by</DropdownMenuLabel>
                <DropdownMenuItem onClick={() => setFilters((f) => ({ ...f, sort: 'createdAt' }))}>
                  Recent first
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setFilters((f) => ({ ...f, sort: 'slug' }))}>Slug</DropdownMenuItem>
                <DropdownMenuItem onClick={() => setFilters((f) => ({ ...f, sort: 'title' }))}>Title</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setFilters((f) => ({ ...f, direction: 'asc' }))}>
                  Ascending
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setFilters((f) => ({ ...f, direction: 'desc' }))}>
                  Descending
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <Button size="sm" className="px-3" asChild>
            <RouterLink to="/admin/links/create" className="inline-flex items-center">
              <Plus className="mr-2 h-4 w-4" /> Create link
            </RouterLink>
          </Button>
        </div>
      </div>

      <div className="overflow-hidden rounded-sm border border-white/5 bg-zinc-950/60">
        <Table>
          <TableHeader>
            <TableRow className="border-white/5">
              <TableHead className="w-32 text-zinc-300">Slug</TableHead>
              <TableHead className="min-w-60 text-zinc-300">Target</TableHead>
              <TableHead className="w-48 text-zinc-300">Title</TableHead>
              <TableHead className="text-zinc-300">Notes</TableHead>
              <TableHead className="w-48 text-zinc-300">Updated</TableHead>
              <TableHead className="w-40 text-right text-zinc-300">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {linksQuery.isLoading && (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-zinc-300">
                  <Loader2 className="mr-2 inline-block h-4 w-4 animate-spin" /> Loading links…
                </TableCell>
              </TableRow>
            )}
            {linksQuery.isError && (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-rose-300">
                  Unable to load links.{' '}
                  {linksQuery.error instanceof Error ? linksQuery.error.message : String(linksQuery.error)}
                </TableCell>
              </TableRow>
            )}
            {linksQuery.data?.length === 0 && !linksQuery.isLoading && (
              <TableRow>
                <TableCell colSpan={6} className="py-12 text-center text-zinc-300">
                  No links yet. Use the Create link button to add your first entry.
                </TableCell>
              </TableRow>
            )}
            {linksQuery.data?.map((link) => renderRow(link))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
