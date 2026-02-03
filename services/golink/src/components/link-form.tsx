import { Loader2 } from 'lucide-react'
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react'
import { toast } from 'sonner'
import { cn } from '../lib/utils'
import { type LinkInput, linkInputSchema } from '../server/links'
import { Button, Input, Label, Textarea } from '@proompteng/design/ui'

type FormState = {
  slug: string
  targetUrl: string
  title: string
  notes: string
}

type FieldErrors = Partial<Record<keyof FormState, string>>

type LinkFormProps = {
  heading: string
  description?: string
  submitLabel?: string
  cancelLabel?: string
  submitIcon?: ReactNode
  busy?: boolean
  initialValues?: Partial<LinkInput>
  onSubmit: (values: LinkInput) => void | Promise<void>
  onCancel?: () => void
}

const mapInitialValues = (values?: Partial<LinkInput>): FormState => ({
  slug: values?.slug ?? '',
  targetUrl: values?.targetUrl ?? '',
  title: values?.title ?? '',
  notes: values?.notes ?? '',
})

const normalizeForm = (state: FormState): LinkInput => ({
  slug: state.slug.trim(),
  targetUrl: state.targetUrl.trim(),
  title: state.title.trim() === '' ? undefined : state.title.trim(),
  notes: state.notes.trim() === '' ? undefined : state.notes.trim(),
})

export function LinkForm({
  heading,
  description,
  submitLabel = 'Save link',
  cancelLabel = 'Cancel',
  submitIcon,
  busy = false,
  initialValues,
  onSubmit,
  onCancel,
}: LinkFormProps) {
  const [form, setForm] = useState<FormState>(() => mapInitialValues(initialValues))
  const [errors, setErrors] = useState<FieldErrors>({})
  const baseId = useId()
  const fieldIds = {
    slug: `${baseId}-slug`,
    target: `${baseId}-target`,
    title: `${baseId}-title`,
    notes: `${baseId}-notes`,
  }

  useEffect(() => {
    setForm(mapInitialValues(initialValues))
  }, [initialValues])

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const parsed = validate()
    if (!parsed) return
    await onSubmit(parsed)
  }

  const validate = () => {
    const parsed = linkInputSchema.safeParse(normalizeForm(form))
    if (!parsed.success) {
      const fieldErrors: FieldErrors = {}
      parsed.error.errors.forEach((err) => {
        const field = err.path[0]
        if (typeof field === 'string') {
          fieldErrors[field as keyof FormState] = err.message
        }
      })
      setErrors(fieldErrors)
      const first = parsed.error.errors[0]
      toast.error(first?.message ?? 'Please fix the highlighted fields and try again.')
      return null
    }
    setErrors({})
    return parsed.data
  }

  const setField = (field: keyof FormState) => (value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  return (
    <div className="space-y-6 rounded-sm border border-white/10 bg-zinc-950/80 p-6 shadow-2xl shadow-black/30">
      <div>
        <h1 className="mt-2 text-2xl font-semibold text-white">{heading}</h1>
        {description && <p className="mt-1 text-sm text-zinc-400">{description}</p>}
      </div>

      <form className="space-y-6" onSubmit={handleSubmit} noValidate>
        <div className="space-y-2">
          <Label htmlFor={fieldIds.slug}>Slug</Label>
          <Input
            id={fieldIds.slug}
            value={form.slug}
            onChange={(event) => setField('slug')(event.target.value)}
            autoFocus
            placeholder="standup"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={Boolean(errors.slug)}
            className={cn(errors.slug && 'ring-2 ring-destructive')}
          />
          {errors.slug && <p className="text-xs text-rose-300">{errors.slug}</p>}
        </div>

        <div className="space-y-2">
          <Label htmlFor={fieldIds.target}>Target URL</Label>
          <Input
            id={fieldIds.target}
            type="url"
            inputMode="url"
            value={form.targetUrl}
            onChange={(event) => setField('targetUrl')(event.target.value)}
            placeholder="https://example.com/notes"
            autoComplete="url"
            aria-invalid={Boolean(errors.targetUrl)}
            className={cn(errors.targetUrl && 'ring-2 ring-destructive')}
          />
          {errors.targetUrl && <p className="text-xs text-rose-300">{errors.targetUrl}</p>}
        </div>

        <div className="space-y-2">
          <Label htmlFor={fieldIds.title}>Title (optional)</Label>
          <Input
            id={fieldIds.title}
            value={form.title}
            onChange={(event) => setField('title')(event.target.value)}
            placeholder="Daily standup agenda"
            autoComplete="off"
            aria-invalid={Boolean(errors.title)}
            className={cn(errors.title && 'ring-2 ring-destructive')}
          />
          {errors.title && <p className="text-xs text-rose-300">{errors.title}</p>}
        </div>

        <div className="space-y-2">
          <Label htmlFor={fieldIds.notes}>Notes (optional)</Label>
          <Textarea
            id={fieldIds.notes}
            value={form.notes}
            onChange={(event) => setField('notes')(event.target.value)}
            placeholder="Visible to other admins only"
            rows={4}
            autoComplete="off"
          />
          {errors.notes && <p className="text-xs text-rose-300">{errors.notes}</p>}
        </div>

        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={busy} className="min-w-[140px]">
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : submitIcon}
            {submitLabel}
          </Button>
          {onCancel && (
            <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>
              {cancelLabel}
            </Button>
          )}
        </div>
      </form>
    </div>
  )
}
