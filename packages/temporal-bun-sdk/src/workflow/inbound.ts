import type { Effect } from 'effect'
import * as Schema from 'effect/Schema'

const defaultSignalSchema: Schema.Schema<unknown> = Schema.Unknown
const defaultQueryInputSchema: Schema.Schema<unknown> = Schema.Unknown
const defaultQueryOutputSchema: Schema.Schema<unknown> = Schema.Unknown

export const CHILD_WORKFLOW_COMPLETED_SIGNAL = '__childWorkflowCompleted'

const shouldDecodeAsArray = (schema: Schema.Schema<unknown>): boolean => schema.ast._tag === 'TupleType'

type RecordValue<T> = Schema.Schema<T> | { schema?: Schema.Schema<T>; description?: string }

export interface WorkflowSignalHandle<I> {
  readonly kind: 'workflow-signal'
  readonly name: string
  readonly schema: Schema.Schema<I>
  readonly decodeArgumentsAsArray: boolean
  readonly description?: string
}

export type WorkflowSignalsDefinition<T extends Record<string, RecordValue<unknown>>> = {
  readonly [K in keyof T]: WorkflowSignalHandle<Schema.Schema.Type<ExtractSignalSchema<T[K]>>>
}

type ExtractSignalSchema<T> =
  T extends Schema.Schema<infer I>
    ? Schema.Schema<I>
    : T extends { schema?: Schema.Schema<infer I> }
      ? Schema.Schema<I>
      : typeof defaultSignalSchema

export const defineWorkflowSignals = <T extends Record<string, RecordValue<unknown>>>(
  definitions: T,
): WorkflowSignalsDefinition<T> => {
  const handles: Record<string, WorkflowSignalHandle<unknown>> = {}

  for (const [name, value] of Object.entries(definitions)) {
    const schema = Schema.isSchema(value) ? value : (value.schema ?? defaultSignalSchema)
    const description = Schema.isSchema(value) ? undefined : value.description
    const decodeArgumentsAsArray = Schema.isSchema(value) || value.schema ? shouldDecodeAsArray(schema) : true
    handles[name] = {
      kind: 'workflow-signal',
      name,
      schema,
      decodeArgumentsAsArray,
      ...(description ? { description } : {}),
    }
  }

  return handles as WorkflowSignalsDefinition<T>
}

export interface WorkflowSignalMetadata {
  readonly eventId?: string | null
  readonly workflowTaskCompletedEventId?: string | null
  readonly identity?: string | null
  readonly timestamp?: string | null
}

export interface WorkflowSignalDelivery<T> {
  readonly payload: T
  readonly metadata: WorkflowSignalMetadata
}

export interface WorkflowSignalDeliveryInput {
  readonly name: string
  readonly args: readonly unknown[]
  readonly metadata?: WorkflowSignalMetadata
}

export type WorkflowSignalHandler<I, A = void> = (
  payload: I,
  metadata: WorkflowSignalMetadata,
) => Effect.Effect<A, unknown, never>

export interface WorkflowSignalHandlerOptions {
  readonly name?: string
}

type QueryRecordValue<I, O> =
  | Schema.Schema<I>
  | {
      readonly input?: Schema.Schema<I>
      readonly output?: Schema.Schema<O>
      readonly description?: string
    }

export interface WorkflowQueryHandle<I, O> {
  readonly kind: 'workflow-query'
  readonly name: string
  readonly inputSchema: Schema.Schema<I>
  readonly outputSchema: Schema.Schema<O>
  readonly decodeInputAsArray: boolean
  readonly description?: string
}

export type WorkflowQueriesDefinition<T extends Record<string, QueryRecordValue<unknown, unknown>>> = {
  readonly [K in keyof T]: WorkflowQueryHandle<
    Schema.Schema.Type<ExtractQueryInputSchema<T[K]>>,
    Schema.Schema.Type<ExtractQueryOutputSchema<T[K]>>
  >
}

type ExtractQueryInputSchema<T> =
  T extends Schema.Schema<infer I>
    ? Schema.Schema<I>
    : T extends { input?: Schema.Schema<infer I> }
      ? Schema.Schema<I>
      : typeof defaultQueryInputSchema

type ExtractQueryOutputSchema<T> = T extends { output?: Schema.Schema<infer O> }
  ? Schema.Schema<O>
  : typeof defaultQueryOutputSchema

export const defineWorkflowQueries = <T extends Record<string, QueryRecordValue<unknown, unknown>>>(
  definitions: T,
): WorkflowQueriesDefinition<T> => {
  const handles: Record<string, WorkflowQueryHandle<unknown, unknown>> = {}

  for (const [name, value] of Object.entries(definitions)) {
    if (Schema.isSchema(value)) {
      handles[name] = {
        kind: 'workflow-query',
        name,
        inputSchema: value,
        outputSchema: defaultQueryOutputSchema,
        decodeInputAsArray: shouldDecodeAsArray(value),
      }
      continue
    }
    const inputSchema = value.input ?? defaultQueryInputSchema
    const outputSchema = value.output ?? defaultQueryOutputSchema
    const decodeInputAsArray = value.input ? shouldDecodeAsArray(inputSchema) : true
    handles[name] = {
      kind: 'workflow-query',
      name,
      inputSchema,
      outputSchema,
      decodeInputAsArray,
      ...(value.description ? { description: value.description } : {}),
    }
  }

  return handles as WorkflowQueriesDefinition<T>
}

export interface WorkflowQueryMetadata {
  readonly id?: string
  readonly identity?: string | null
  readonly header?: Record<string, unknown>
}

export interface WorkflowQueryRequest {
  readonly id?: string
  readonly name: string
  readonly args: readonly unknown[]
  readonly metadata?: WorkflowQueryMetadata
  readonly source: 'legacy' | 'multi'
}

export type WorkflowQueryResolver<I, O> = (
  input: I,
  metadata: WorkflowQueryMetadata,
) => Effect.Effect<O, unknown, never>

export interface WorkflowQueryHandlerOptions {
  readonly name?: string
}

export const normalizeInboundArguments = (raw: readonly unknown[] | undefined, decodeAsArray: boolean): unknown => {
  if (decodeAsArray) {
    return raw ?? []
  }
  const values = raw ?? []
  if (!Array.isArray(values)) {
    return values
  }
  if (values.length === 0) {
    return undefined
  }
  if (values.length === 1) {
    return values[0]
  }
  return values
}
