export type JsonSchema = Record<string, unknown>

export type SchemaFieldKind = 'array' | 'boolean' | 'enum' | 'number' | 'object' | 'schemaless' | 'string'

export type SchemaFieldModel = {
  kind: SchemaFieldKind
  path: string[]
  name: string
  label: string
  required: boolean
  description?: string
  schema: JsonSchema
  children?: SchemaFieldModel[]
}

const asRecord = (value: unknown): JsonSchema | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonSchema) : null

export const schemaProperties = (schema: JsonSchema) => asRecord(schema.properties) ?? {}

export const schemaRequired = (schema: JsonSchema) => {
  const required = Array.isArray(schema.required) ? schema.required : []
  return new Set(required.filter((value): value is string => typeof value === 'string'))
}

export const schemaDescription = (schema: JsonSchema) =>
  typeof schema.description === 'string' && schema.description.trim() ? schema.description.trim() : undefined

export const schemaType = (schema: JsonSchema) => {
  const rawType = schema.type
  if (Array.isArray(rawType)) return rawType.find((value): value is string => typeof value === 'string') ?? null
  return typeof rawType === 'string' ? rawType : null
}

export const isSchemalessObjectSchema = (schema: JsonSchema) => {
  if (schema['x-kubernetes-preserve-unknown-fields'] === true) return true
  if (schemaType(schema) !== 'object') return false
  return Object.keys(schemaProperties(schema)).length === 0
}

export const classifySchema = (schema: JsonSchema): SchemaFieldKind => {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return 'enum'

  const type = schemaType(schema)
  if (type === 'boolean') return 'boolean'
  if (type === 'integer' || type === 'number') return 'number'
  if (type === 'array') return 'array'
  if (type === 'object') {
    if (isSchemalessObjectSchema(schema)) return 'schemaless'
    return 'object'
  }
  return 'string'
}

export const humanizeFieldName = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (value) => value.toUpperCase())

export const buildSchemaFieldModels = (
  schema: JsonSchema,
  parentPath: string[] = [],
  requiredNames = new Set<string>(),
): SchemaFieldModel[] => {
  const properties = schemaProperties(schema)
  const names = Object.keys(properties).sort((left, right) => {
    const leftRequired = requiredNames.has(left)
    const rightRequired = requiredNames.has(right)
    if (leftRequired !== rightRequired) return leftRequired ? -1 : 1
    return left.localeCompare(right)
  })

  return names.map((name) => {
    const childSchema = asRecord(properties[name]) ?? {}
    const path = [...parentPath, name]
    const kind = classifySchema(childSchema)
    const required = requiredNames.has(name)
    const field: SchemaFieldModel = {
      kind,
      path,
      name,
      label: humanizeFieldName(name),
      required,
      description: schemaDescription(childSchema),
      schema: childSchema,
    }
    if (kind === 'object') {
      field.children = buildSchemaFieldModels(childSchema, path, schemaRequired(childSchema))
    }
    return field
  })
}

export const getSpecSchema = (schema: JsonSchema) => {
  const properties = schemaProperties(schema)
  return asRecord(properties.spec) ?? {}
}
