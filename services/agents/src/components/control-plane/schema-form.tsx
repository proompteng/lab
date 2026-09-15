import YAML from 'yaml'
import { Controller, type FieldErrors, useForm } from 'react-hook-form'
import { BracesIcon, LoaderCircleIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { useMemo, useState } from 'react'

import { cn } from '@/lib/utils'
import type { ControlPlanePrimitiveRegistryEntry } from '../../control-plane/primitive-registry.generated'
import {
  buildSchemaFieldModels,
  getSpecSchema,
  schemaType,
  type JsonSchema,
  type SchemaFieldModel,
} from '../../control-plane/schema-form-model'
import { createPrimitiveResource } from '../../control-plane/api-client'
import { emptyPrimitiveManifest, materializePrimitiveManifest } from '../../control-plane/manifest'
import { Alert, AlertDescription } from '../ui/alert'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../ui/card'
import { Checkbox } from '../ui/checkbox'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '../ui/field'
import { Input } from '../ui/input'
import { ScrollArea } from '../ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'
import { Textarea } from '../ui/textarea'

type PrimitiveSchemaFormProps = {
  primitive: ControlPlanePrimitiveRegistryEntry
  onCreated: (resource: Record<string, unknown>) => void
}

type FormValues = Record<string, unknown>

const fieldName = (path: string[]) => path.join('.')

const enumValues = (schema: JsonSchema) =>
  Array.isArray(schema.enum) ? schema.enum.filter((value): value is string => typeof value === 'string') : []

const arrayItemSchema = (schema: JsonSchema) =>
  schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items) ? (schema.items as JsonSchema) : {}

const getErrorMessage = (errors: FieldErrors<FormValues>, path: string[]) => {
  let current: unknown = errors
  for (const segment of path) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  if (!current || typeof current !== 'object') return undefined
  const message = (current as { message?: unknown }).message
  return typeof message === 'string' ? message : undefined
}

const requiredRule = (field: SchemaFieldModel) =>
  field.required && field.kind !== 'boolean' ? { required: `${field.label} is required.` } : undefined

const isWideField = (field: SchemaFieldModel) =>
  field.kind === 'array' ||
  field.kind === 'object' ||
  field.kind === 'schemaless' ||
  Number(field.schema.maxLength ?? 0) > 512 ||
  Number(field.description?.length ?? 0) > 120

const fieldPlaceholder = (field: SchemaFieldModel) => {
  if (field.kind === 'number') return '0'
  if (field.kind === 'schemaless') return '{\n  \n}'
  return field.name
}

function RequiredBadge() {
  return (
    <Badge variant="outline" className="h-4 px-1.5 text-[0.65rem]">
      Required
    </Badge>
  )
}

function ArrayInput({ control, field }: { control: ReturnType<typeof useForm>['control']; field: SchemaFieldModel }) {
  const name = fieldName(field.path)
  const itemSchema = arrayItemSchema(field.schema)
  const itemType = schemaType(itemSchema)
  const itemEnums = enumValues(itemSchema)
  const itemLabel =
    itemType === 'object' ? 'object' : itemType === 'number' || itemType === 'integer' ? 'number' : 'item'

  return (
    <Controller
      control={control}
      name={name}
      rules={requiredRule(field)}
      render={({ field: controllerField }) => {
        const items = Array.isArray(controllerField.value) ? controllerField.value : []
        const update = (next: unknown[]) => controllerField.onChange(next)
        return (
          <div className="flex flex-col gap-3">
            {items.length === 0 ? (
              <div className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
                No items added.
              </div>
            ) : null}
            {items.map((item, index) => (
              <div className="rounded-md border bg-muted/20 p-2" key={index}>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <Badge variant="outline">Item {index + 1}</Badge>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => update(items.filter((_, itemIndex) => itemIndex !== index))}
                  >
                    <Trash2Icon />
                    <span className="sr-only">Remove item</span>
                  </Button>
                </div>
                {itemEnums.length > 0 ? (
                  <Select
                    value={typeof item === 'string' ? item : ''}
                    onValueChange={(value) =>
                      update(items.map((current, itemIndex) => (itemIndex === index ? value : current)))
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select value" />
                    </SelectTrigger>
                    <SelectContent>
                      {itemEnums.map((value) => (
                        <SelectItem key={value} value={value}>
                          {value}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : itemType === 'integer' || itemType === 'number' ? (
                  <Input
                    type="number"
                    value={typeof item === 'number' || typeof item === 'string' ? item : ''}
                    onChange={(event) =>
                      update(items.map((current, itemIndex) => (itemIndex === index ? event.target.value : current)))
                    }
                  />
                ) : itemType === 'object' ? (
                  <Textarea
                    className="min-h-28 font-mono text-xs"
                    value={typeof item === 'string' ? item : JSON.stringify(item ?? {}, null, 2)}
                    onChange={(event) =>
                      update(items.map((current, itemIndex) => (itemIndex === index ? event.target.value : current)))
                    }
                  />
                ) : (
                  <Input
                    value={typeof item === 'string' ? item : ''}
                    onChange={(event) =>
                      update(items.map((current, itemIndex) => (itemIndex === index ? event.target.value : current)))
                    }
                  />
                )}
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={() => update([...items, itemType === 'object' ? '{\n  \n}' : ''])}
            >
              <PlusIcon data-icon="inline-start" />
              Add {itemLabel}
            </Button>
          </div>
        )
      }}
    />
  )
}

function SchemaField({
  control,
  errors,
  field,
  register,
}: {
  control: ReturnType<typeof useForm>['control']
  errors: FieldErrors<FormValues>
  field: SchemaFieldModel
  register: ReturnType<typeof useForm>['register']
}) {
  const name = fieldName(field.path)
  const error = getErrorMessage(errors, field.path)
  const requiredLabel = field.required ? <RequiredBadge /> : null
  const wideClassName = isWideField(field) ? 'md:col-span-2' : undefined

  if (field.kind === 'object' && field.children) {
    return (
      <FieldSet className={cn('rounded-md border bg-muted/20 p-4', wideClassName)}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <FieldLegend variant="label">{field.label}</FieldLegend>
            {field.description ? <FieldDescription>{field.description}</FieldDescription> : null}
          </div>
          {requiredLabel}
        </div>
        <FieldGroup className="grid gap-4 md:grid-cols-2">
          {field.children.map((child) => (
            <SchemaField
              key={fieldName(child.path)}
              control={control}
              errors={errors}
              field={child}
              register={register}
            />
          ))}
        </FieldGroup>
      </FieldSet>
    )
  }

  if (field.kind === 'boolean') {
    return (
      <Field orientation="horizontal" className={wideClassName} data-invalid={error ? true : undefined}>
        <Controller
          control={control}
          name={name}
          render={({ field: controllerField }) => (
            <Checkbox id={name} checked={Boolean(controllerField.value)} onCheckedChange={controllerField.onChange} />
          )}
        />
        <FieldContent>
          <FieldLabel htmlFor={name}>
            {field.label}
            {requiredLabel}
          </FieldLabel>
          {field.description ? <FieldDescription>{field.description}</FieldDescription> : null}
          {error ? <FieldError>{error}</FieldError> : null}
        </FieldContent>
      </Field>
    )
  }

  return (
    <Field className={wideClassName} data-invalid={error ? true : undefined}>
      <FieldContent>
        <FieldLabel htmlFor={name}>
          {field.label}
          {requiredLabel}
        </FieldLabel>
        {field.description ? <FieldDescription>{field.description}</FieldDescription> : null}
      </FieldContent>
      {field.kind === 'enum' ? (
        <Controller
          control={control}
          name={name}
          rules={requiredRule(field)}
          render={({ field: controllerField }) => (
            <Select
              value={typeof controllerField.value === 'string' ? controllerField.value : ''}
              onValueChange={controllerField.onChange}
            >
              <SelectTrigger id={name} className="w-full" aria-invalid={error ? true : undefined}>
                <SelectValue placeholder="Select value" />
              </SelectTrigger>
              <SelectContent>
                {enumValues(field.schema).map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
      ) : field.kind === 'array' ? (
        <ArrayInput control={control} field={field} />
      ) : field.kind === 'schemaless' ? (
        <Textarea
          id={name}
          className="min-h-36 font-mono text-xs"
          placeholder={fieldPlaceholder(field)}
          aria-invalid={error ? true : undefined}
          {...register(name, requiredRule(field))}
        />
      ) : field.kind === 'number' ? (
        <Input
          id={name}
          type="number"
          placeholder={fieldPlaceholder(field)}
          aria-invalid={error ? true : undefined}
          {...register(name, requiredRule(field))}
        />
      ) : Number(field.schema.maxLength ?? 0) > 1024 ? (
        <Textarea
          id={name}
          className="min-h-32"
          placeholder={fieldPlaceholder(field)}
          aria-invalid={error ? true : undefined}
          {...register(name, requiredRule(field))}
        />
      ) : (
        <Input
          id={name}
          placeholder={fieldPlaceholder(field)}
          aria-invalid={error ? true : undefined}
          {...register(name, requiredRule(field))}
        />
      )}
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  )
}

export function PrimitiveSchemaForm({ primitive, onCreated }: PrimitiveSchemaFormProps) {
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const form = useForm<FormValues>({
    defaultValues: emptyPrimitiveManifest(primitive),
  })
  const fields = useMemo(
    () =>
      buildSchemaFieldModels(
        getSpecSchema(primitive.schema),
        ['spec'],
        new Set((getSpecSchema(primitive.schema).required as string[]) ?? []),
      ),
    [primitive],
  )
  const values = form.watch()
  const preview = useMemo(() => materializePrimitiveManifest(primitive, values), [primitive, values])
  const previewJson = useMemo(() => JSON.stringify(preview, null, 2), [preview])
  const previewYaml = useMemo(() => YAML.stringify(preview), [preview])
  const specRequiredCount = fields.filter((field) => field.required).length
  const nameError = getErrorMessage(form.formState.errors, ['metadata', 'name'])
  const namespaceError = getErrorMessage(form.formState.errors, ['metadata', 'namespace'])

  return (
    <form
      className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(22rem,30rem)]"
      onSubmit={form.handleSubmit(async (data) => {
        setSubmitting(true)
        setError(null)
        try {
          const response = await createPrimitiveResource(
            primitive.display.pathSegment,
            materializePrimitiveManifest(primitive, data),
          )
          onCreated(response.resource)
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setSubmitting(false)
        }
      })}
    >
      <div className="flex min-w-0 flex-col gap-4">
        <Card className="rounded-md">
          <CardHeader className="border-b">
            <CardTitle>Identity</CardTitle>
            <CardDescription>{primitive.apiVersion}</CardDescription>
            <CardAction>
              <Badge variant="outline">{primitive.scope}</Badge>
            </CardAction>
          </CardHeader>
          <CardContent>
            <FieldGroup className="grid gap-4 md:grid-cols-2">
              <Field data-invalid={nameError ? true : undefined}>
                <FieldContent>
                  <FieldLabel htmlFor="metadata.name">
                    Name
                    <RequiredBadge />
                  </FieldLabel>
                  <FieldDescription>Kubernetes resource name.</FieldDescription>
                </FieldContent>
                <Input
                  id="metadata.name"
                  autoComplete="off"
                  placeholder={`${primitive.display.pathSegment}-name`}
                  aria-invalid={nameError ? true : undefined}
                  {...form.register('metadata.name', {
                    required: 'Name is required.',
                    pattern: {
                      value: /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/,
                      message: 'Use lowercase letters, numbers, and hyphens.',
                    },
                  })}
                />
                {nameError ? <FieldError>{nameError}</FieldError> : null}
              </Field>
              {primitive.scope === 'Namespaced' ? (
                <Field data-invalid={namespaceError ? true : undefined}>
                  <FieldContent>
                    <FieldLabel htmlFor="metadata.namespace">
                      Namespace
                      <RequiredBadge />
                    </FieldLabel>
                    <FieldDescription>Target Kubernetes namespace.</FieldDescription>
                  </FieldContent>
                  <Input
                    id="metadata.namespace"
                    autoComplete="off"
                    placeholder="agents"
                    aria-invalid={namespaceError ? true : undefined}
                    {...form.register('metadata.namespace', {
                      required: 'Namespace is required.',
                    })}
                  />
                  {namespaceError ? <FieldError>{namespaceError}</FieldError> : null}
                </Field>
              ) : null}
            </FieldGroup>
          </CardContent>
        </Card>

        <Card className="rounded-md">
          <CardHeader className="border-b">
            <CardTitle>Spec</CardTitle>
            <CardDescription>
              {fields.length} schema fields
              {specRequiredCount > 0 ? `, ${specRequiredCount} required` : ''}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {fields.length > 0 ? (
              <FieldGroup className="grid gap-4 md:grid-cols-2">
                {fields.map((field) => (
                  <SchemaField
                    key={fieldName(field.path)}
                    control={form.control}
                    errors={form.formState.errors}
                    field={field}
                    register={form.register}
                  />
                ))}
              </FieldGroup>
            ) : (
              <div className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
                This primitive does not define spec fields.
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <aside className="flex min-w-0 flex-col gap-4 xl:sticky xl:top-16 xl:self-start">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <Card className="rounded-md">
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2">
              <BracesIcon />
              Manifest
            </CardTitle>
            <CardDescription>{primitive.kind}</CardDescription>
            <CardAction>
              <Badge variant="outline">{primitive.version}</Badge>
            </CardAction>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="json" className="w-full">
              <TabsList>
                <TabsTrigger value="json">JSON</TabsTrigger>
                <TabsTrigger value="yaml">YAML</TabsTrigger>
              </TabsList>
              <TabsContent value="json" className="mt-3">
                <ScrollArea className="h-[34rem] rounded-md border bg-muted/20">
                  <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed">
                    {previewJson}
                  </pre>
                </ScrollArea>
              </TabsContent>
              <TabsContent value="yaml" className="mt-3">
                <ScrollArea className="h-[34rem] rounded-md border bg-muted/20">
                  <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed">
                    {previewYaml}
                  </pre>
                </ScrollArea>
              </TabsContent>
            </Tabs>
          </CardContent>
          <CardFooter className="justify-end gap-3">
            <Button type="submit" disabled={submitting}>
              {submitting ? <LoaderCircleIcon data-icon="inline-start" className="animate-spin" /> : null}
              {submitting ? 'Creating' : 'Create'}
            </Button>
          </CardFooter>
        </Card>
      </aside>
    </form>
  )
}
