import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ArrowUpDown, Loader2, Plus, RefreshCw, Save, Trash2 } from 'lucide-react'
import { useId, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '../components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { Textarea } from '../components/ui/textarea'
import type { Link } from '../db/schema/links'
import { cn } from '../lib/utils'
import {
  type LinkInput,
  type LinkUpdateInput,
  linkInputSchema,
  linkUpdateSchema,
  listFiltersSchema,
  serverFns,
} from '../server/links'

export const Route = createFileRoute('/admin')({
  component: Admin,
})

type Filters = {
  search?: string
  sort?: 'createdAt' | 'slug' | 'title'
  direction?: 'asc' | 'desc'
}

type FormState = LinkInput & { id?: number }

const defaultFilters: Filters = { sort: 'createdAt', direction: 'desc' }
const defaultForm: FormState = { slug: '', targetUrl: '', title: '', notes: '' }

function Admin() {
  const [filters, setFilters] = useState<Filters>(defaultFilters)
  const [form, setForm] = useState<FormState>(defaultForm)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const slugId = useId()
  const targetUrlId = useId()
  const titleId = useId()
  const notesId = useId()
  const searchId = useId()

  const queryClient = useQueryClient()
  const queryKey = useMemo(
    () => ['links', filters.search ?? '', filters.sort ?? 'createdAt', filters.direction ?? 'desc'] as const,
    [filters],
  )

  const linksQuery = useQuery<Link[]>({
    queryKey,
    queryFn: async () => (await serverFns.listLinks({ data: filters })) as Link[],
  })

  const onValidationError = (message: string, field?: string) => {
    if (field) {
      setErrors((prev) => ({ ...prev, [field]: message }))
    }
    toast.error(message)
  }

  const buildRollback = (previous?: Link[]) => () => {
    if (previous) {
      queryClient.setQueryData(queryKey, previous)
    }
  }

  const createMutation = useMutation({
    mutationFn: (input: LinkInput) => serverFns.createLink({ data: input }),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey })
      const previous = queryClient.getQueryData<Link[]>(queryKey) ?? []
      const optimistic: Link = {
        id: Date.now() * -1,
        slug: input.slug,
        targetUrl: input.targetUrl,
        title: input.title,
        notes: input.notes,
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      queryClient.setQueryData(queryKey, [optimistic, ...previous])
      setForm(defaultForm)
      return { previous, optimisticId: optimistic.id }
    },
    onError: (_error, _input, context) => {
      buildRollback(context?.previous)()
    },
    onSuccess: (result, _input, context) => {
      if (!result.ok) {
        buildRollback(context?.previous)()
        return toast.error(result.message)
      }

      queryClient.setQueryData<Link[]>(queryKey, (current = []) => {
        const filtered = current.filter((item) => item.id !== context?.optimisticId)
        return [result.link, ...filtered]
      })
      toast.success('Link created')
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  })

  const updateMutation = useMutation({
    mutationFn: (input: LinkUpdateInput) => serverFns.updateLink({ data: input }),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey })
      const previous = queryClient.getQueryData<Link[]>(queryKey) ?? []
      queryClient.setQueryData<Link[]>(queryKey, (current = []) =>
        current.map((link) => (link.id === input.id ? { ...link, ...input, updatedAt: new Date() } : link)),
      )
      return { previous }
    },
    onError: (_error, _input, context) => buildRollback(context?.previous)(),
    onSuccess: (result, input, context) => {
      if (!result.ok) {
        buildRollback(context?.previous)()
        return toast.error(result.message)
      }
      queryClient.setQueryData<Link[]>(queryKey, (current = []) =>
        current.map((link) => (link.id === input.id ? result.link : link)),
      )
      setEditingId(null)
      toast.success('Link updated')
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  })

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

  const isBusy = createMutation.isPending || updateMutation.isPending || deleteMutation.isPending

  const validateForm = (draft: FormState, isUpdate = false) => {
    const schema = isUpdate ? linkUpdateSchema : linkInputSchema
    const parsed = schema.safeParse(draft)
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {}
      parsed.error.errors.forEach((err) => {
        const field = err.path[0]
        if (typeof field === 'string') {
          fieldErrors[field] = err.message
        }
      })
      setErrors(fieldErrors)
      const first = parsed.error.errors[0]
      onValidationError(first.message, typeof first.path[0] === 'string' ? (first.path[0] as string) : undefined)
      return null
    }
    setErrors({})
    return parsed.data
  }

  const submitCreate = () => {
    const parsed = validateForm(form)
    if (!parsed) return
    createMutation.mutate(parsed)
  }

  const submitUpdate = (draft: FormState) => {
    const parsed = validateForm(draft as FormState, true)
    if (!parsed) return
    updateMutation.mutate(parsed as LinkUpdateInput)
  }

  const handleEdit = (link: Link) => {
    setEditingId(link.id)
    setForm({ ...link })
    setErrors({})
  }

  const renderRow = (link: Link) => {
    const isEditing = editingId === link.id
    const draft = isEditing ? form : link

    return (
      <TableRow key={link.id} className="align-top">
        <TableCell className="font-mono text-sm text-cyan-200">{link.slug}</TableCell>
        <TableCell>
          {isEditing ? (
            <Input
              value={draft.targetUrl}
              onChange={(e) => setForm((prev) => ({ ...prev, targetUrl: e.target.value }))}
              autoFocus
              className={cn(errors.targetUrl && 'ring-2 ring-destructive')}
              aria-invalid={Boolean(errors.targetUrl)}
            />
          ) : (
            <a
              href={link.targetUrl}
              className="truncate text-cyan-200 hover:underline"
              target="_blank"
              rel="noreferrer"
            >
              {link.targetUrl}
            </a>
          )}
          {isEditing && errors.targetUrl && <p className="mt-1 text-xs text-rose-300">{errors.targetUrl}</p>}
        </TableCell>
        <TableCell>
          {isEditing ? (
            <Input
              value={draft.title}
              onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
              className={cn(errors.title && 'ring-2 ring-destructive')}
              aria-invalid={Boolean(errors.title)}
            />
          ) : (
            <p className="font-medium text-white">{link.title}</p>
          )}
          {isEditing && errors.title && <p className="mt-1 text-xs text-rose-300">{errors.title}</p>}
        </TableCell>
        <TableCell className="max-w-xs">
          {isEditing ? (
            <Textarea
              value={draft.notes ?? ''}
              onChange={(e) => setForm((prev) => ({ ...prev, notes: e.target.value }))}
              className="min-h-[80px]"
            />
          ) : (
            <p className="text-sm text-slate-300 line-clamp-3">{link.notes ?? '—'}</p>
          )}
        </TableCell>
        <TableCell className="whitespace-nowrap text-sm text-slate-400">
          {new Date(link.updatedAt ?? link.createdAt).toLocaleString()}
        </TableCell>
        <TableCell className="w-[170px] text-right">
          {isEditing ? (
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={isBusy}
                onClick={() => {
                  setEditingId(null)
                  setErrors({})
                  setForm(defaultForm)
                }}
              >
                Cancel
              </Button>
              <Button size="sm" onClick={() => submitUpdate({ ...draft, id: link.id })} disabled={isBusy}>
                <Save className="mr-1 h-4 w-4" /> Save
              </Button>
            </div>
          ) : (
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="secondary" onClick={() => handleEdit(link)} className="hover:border-white/30">
                Edit
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => deleteMutation.mutate(link.id)}
                disabled={isBusy}
                className="hover:bg-rose-500"
              >
                <Trash2 className="mr-1 h-4 w-4" />
                Delete
              </Button>
            </div>
          )}
        </TableCell>
      </TableRow>
    )
  }

  const submitOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      submitCreate()
    }
  }

  const parsedFilters = listFiltersSchema.parse(filters ?? {})

  return (
    <div className="grid gap-6">
      <div className="flex flex-col gap-3 rounded-2xl border border-white/5 bg-slate-900/60 p-5 glass-surface">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.15em] text-cyan-300">Admin</p>
            <h1 className="text-2xl font-semibold text-white">Manage go links</h1>
            <p className="text-sm text-slate-300">Create, edit, or delete slugs. Changes apply immediately.</p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => linksQuery.refetch()} disabled={linksQuery.isFetching}>
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
        </div>
        <div className="grid gap-3 rounded-xl border border-white/10 bg-slate-900/40 p-4 shadow-inner">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-2">
              <Label htmlFor={slugId}>Slug</Label>
              <Input
                id={slugId}
                name="slug"
                placeholder="docs"
                value={form.slug}
                onChange={(e) => setForm((prev) => ({ ...prev, slug: e.target.value }))}
                onKeyDown={submitOnEnter}
                autoComplete="off"
                aria-invalid={Boolean(errors.slug)}
                className={cn(errors.slug && 'ring-2 ring-destructive')}
              />
              {errors.slug && <p className="text-xs text-rose-300">{errors.slug}</p>}
            </div>
            <div className="space-y-2 md:col-span-2 lg:col-span-2">
              <Label htmlFor={targetUrlId}>Target URL</Label>
              <Input
                id={targetUrlId}
                name="targetUrl"
                placeholder="https://..."
                value={form.targetUrl}
                onChange={(e) => setForm((prev) => ({ ...prev, targetUrl: e.target.value }))}
                onKeyDown={submitOnEnter}
                autoComplete="off"
                aria-invalid={Boolean(errors.targetUrl)}
                className={cn(errors.targetUrl && 'ring-2 ring-destructive')}
              />
              {errors.targetUrl && <p className="text-xs text-rose-300">{errors.targetUrl}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor={titleId}>Title</Label>
              <Input
                id={titleId}
                name="title"
                placeholder="Team handbook"
                value={form.title}
                onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
                onKeyDown={submitOnEnter}
                aria-invalid={Boolean(errors.title)}
                className={cn(errors.title && 'ring-2 ring-destructive')}
              />
              {errors.title && <p className="text-xs text-rose-300">{errors.title}</p>}
            </div>
            <div className="space-y-2 md:col-span-2 lg:col-span-1">
              <Label htmlFor={notesId}>Notes</Label>
              <Input
                id={notesId}
                name="notes"
                placeholder="Optional context"
                value={form.notes ?? ''}
                onChange={(e) => setForm((prev) => ({ ...prev, notes: e.target.value }))}
                onKeyDown={submitOnEnter}
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Label className="text-sm text-slate-300" htmlFor={searchId}>
                Filter
              </Label>
              <Input
                id={searchId}
                placeholder="Search slug, title, or URL"
                value={filters.search ?? ''}
                onChange={(e) => setFilters((prev) => ({ ...prev, search: e.target.value }))}
                className="max-w-sm"
              />
              {filters.search && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setFilters((prev) => ({ ...prev, search: '' }))}
                  className="text-slate-300"
                >
                  Clear
                </Button>
              )}
            </div>
            <Button onClick={submitCreate} disabled={isBusy} className="px-4">
              {createMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Plus className="mr-2 h-4 w-4" />
              )}
              Save link
            </Button>
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-white/5 bg-slate-950/60 shadow-xl">
        <Table>
          <TableHeader>
            <TableRow className="border-white/5">
              <TableHead className="w-32 text-slate-300">Slug</TableHead>
              <TableHead className="min-w-[240px] text-slate-300">Target</TableHead>
              <TableHead className="w-48 text-slate-300">Title</TableHead>
              <TableHead className="text-slate-300">Notes</TableHead>
              <TableHead className="w-48 text-slate-300">Updated</TableHead>
              <TableHead className="w-40 text-right text-slate-300">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {linksQuery.isLoading && (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-slate-300">
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
                <TableCell colSpan={6} className="py-12 text-center text-slate-300">
                  No links yet. Add one above to get started.
                </TableCell>
              </TableRow>
            )}
            {linksQuery.data?.map((link) => renderRow(link))}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-wrap gap-3 text-xs text-slate-400">
        <span className="rounded-full bg-white/5 px-3 py-1">Sort: {parsedFilters.sort ?? 'createdAt'}</span>
        <span className="rounded-full bg-white/5 px-3 py-1">Direction: {parsedFilters.direction ?? 'desc'}</span>
        {filters.search && <span className="rounded-full bg-white/5 px-3 py-1">Filter: {filters.search}</span>}
      </div>
    </div>
  )
}
