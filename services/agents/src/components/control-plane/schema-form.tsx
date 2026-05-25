import { Controller, useForm } from 'react-hook-form'
import { BracesIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { useMemo, useState } from 'react'

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
import { Checkbox } from '../ui/checkbox'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldSet, FieldTitle } from '../ui/field'
import { Input } from '../ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Separator } from '../ui/separator'
import { Textarea } from '../ui/textarea'

type PrimitiveSchemaFormProps = {
  primitive: ControlPlanePrimitiveRegistryEntry
  onCreated: (resource: Record<string, unknown>) => void
}

const fieldName = (path: string[]) => path.join('.')

const enumValues = (schema: JsonSchema) =>
  Array.isArray(schema.enum) ? schema.enum.filter((value): value is string => typeof value === 'string') : []

const arrayItemSchema = (schema: JsonSchema) =>
  schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items) ? (schema.items as JsonSchema) : {}

function ArrayInput({ control, field }: { control: ReturnType<typeof useForm>['control']; field: SchemaFieldModel }) {
  const name = fieldName(field.path)
  const itemSchema = arrayItemSchema(field.schema)
  const itemType = schemaType(itemSchema)
  const itemEnums = enumValues(itemSchema)

  return (
    <Controller
      control={control}
      name={name}
      render={({ field: controllerField }) => {
        const items = Array.isArray(controllerField.value) ? controllerField.value : []
        const update = (next: unknown[]) => controllerField.onChange(next)
        return (
          <div className="flex flex-col gap-2">
            {items.map((item, index) => (
              <div className="flex items-start gap-2" key={index}>
                {itemEnums.length > 0 ? (
                  <Select
                    value={typeof item === 'string' ? item : ''}
                    onValueChange={(value) =>
                      update(items.map((current, itemIndex) => (itemIndex === index ? value : current)))
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
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
                    className="min-h-24 font-mono text-xs"
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
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => update(items.filter((_, itemIndex) => itemIndex !== index))}
                >
                  <Trash2Icon className="size-4" />
                  <span className="sr-only">Remove item</span>
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => update([...items, itemType === 'object' ? '{}' : ''])}
            >
              <PlusIcon className="size-4" />
              Add item
            </Button>
          </div>
        )
      }}
    />
  )
}

function SchemaField({
  control,
  field,
  register,
}: {
  control: ReturnType<typeof useForm>['control']
  field: SchemaFieldModel
  register: ReturnType<typeof useForm>['register']
}) {
  const name = fieldName(field.path)
  const requiredLabel = field.required ? <Badge variant="secondary">Required</Badge> : null

  if (field.kind === 'object' && field.children) {
    return (
      <FieldSet className="rounded-md border bg-background p-4">
        <FieldTitle className="text-sm">
          {field.label}
          {requiredLabel}
        </FieldTitle>
        {field.description ? <FieldDescription>{field.description}</FieldDescription> : null}
        <FieldGroup>
          {field.children.map((child) => (
            <SchemaField key={fieldName(child.path)} control={control} field={child} register={register} />
          ))}
        </FieldGroup>
      </FieldSet>
    )
  }

  return (
    <Field>
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
          render={({ field: controllerField }) => (
            <Select
              value={typeof controllerField.value === 'string' ? controllerField.value : ''}
              onValueChange={controllerField.onChange}
            >
              <SelectTrigger id={name} className="w-full">
                <SelectValue />
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
      ) : field.kind === 'boolean' ? (
        <Controller
          control={control}
          name={name}
          render={({ field: controllerField }) => (
            <Checkbox id={name} checked={Boolean(controllerField.value)} onCheckedChange={controllerField.onChange} />
          )}
        />
      ) : field.kind === 'array' ? (
        <ArrayInput control={control} field={field} />
      ) : field.kind === 'schemaless' ? (
        <Textarea id={name} className="min-h-32 font-mono text-xs" placeholder="{}" {...register(name)} />
      ) : field.kind === 'number' ? (
        <Input id={name} type="number" {...register(name)} />
      ) : Number(field.schema.maxLength ?? 0) > 1024 ? (
        <Textarea id={name} className="min-h-28" {...register(name)} />
      ) : (
        <Input id={name} {...register(name)} />
      )}
    </Field>
  )
}

export function PrimitiveSchemaForm({ primitive, onCreated }: PrimitiveSchemaFormProps) {
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const form = useForm<Record<string, unknown>>({
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

  return (
    <form
      className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(22rem,32rem)]"
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
      <div className="flex min-w-0 flex-col gap-6">
        <FieldGroup className="rounded-md border bg-background p-4">
          <Field>
            <FieldLabel htmlFor="metadata.name">Name</FieldLabel>
            <Input id="metadata.name" {...form.register('metadata.name')} />
          </Field>
          {primitive.scope === 'Namespaced' ? (
            <Field>
              <FieldLabel htmlFor="metadata.namespace">Namespace</FieldLabel>
              <Input id="metadata.namespace" {...form.register('metadata.namespace')} />
            </Field>
          ) : null}
        </FieldGroup>
        <FieldGroup>
          {fields.map((field) => (
            <SchemaField key={fieldName(field.path)} control={form.control} field={field} register={form.register} />
          ))}
        </FieldGroup>
      </div>
      <aside className="flex min-w-0 flex-col gap-4">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="rounded-md border bg-background">
          <div className="flex h-10 items-center gap-2 border-b px-3 text-sm font-medium">
            <BracesIcon className="size-4" />
            Manifest
          </div>
          <pre className="max-h-[52rem] overflow-auto p-3 text-xs leading-relaxed">
            {JSON.stringify(preview, null, 2)}
          </pre>
        </div>
        <Separator />
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Creating' : 'Create'}
        </Button>
      </aside>
    </form>
  )
}
