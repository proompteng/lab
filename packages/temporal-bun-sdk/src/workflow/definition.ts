import type { Effect } from 'effect'
import * as Schema from 'effect/Schema'

import type { WorkflowContext } from './context'
import type { WorkflowQueryHandle, WorkflowSignalHandle } from './inbound'

export type WorkflowSchema<I> = Schema.Schema<I>

const defaultWorkflowSchema = Schema.Array(Schema.Unknown) as Schema.Schema<readonly unknown[]>

export type WorkflowHandler<I, O> = (context: WorkflowContext<I>) => Effect.Effect<O, unknown, never>

export type WorkflowUpdateHandler<I, O> = (context: WorkflowContext<I>, input: I) => Effect.Effect<O, unknown, never>

export type WorkflowUpdateValidator<I> = (input: I) => void

export interface WorkflowUpdateDefinition<I, O> {
  readonly name: string
  readonly input: Schema.Schema<I>
  readonly handler: WorkflowUpdateHandler<I, O>
  readonly validator?: WorkflowUpdateValidator<I>
}

export type WorkflowUpdateDefinitions = ReadonlyArray<WorkflowUpdateDefinition<unknown, unknown>>

export interface WorkflowDefinitionExtras {
  readonly updates?: WorkflowUpdateDefinitions
}

export interface WorkflowDefinition<I, O, S = undefined, Q = undefined> {
  readonly name: string
  readonly schema: WorkflowSchema<I>
  readonly handler: WorkflowHandler<I, O>
  readonly decodeArgumentsAsArray: boolean
  readonly signals?: S
  readonly queries?: Q
  readonly updates?: WorkflowUpdateDefinitions
}

export interface DefineWorkflowConfig<
  I,
  O,
  S extends Record<string, WorkflowSignalHandle<unknown>> | undefined = undefined,
  Q extends Record<string, WorkflowQueryHandle<unknown, unknown>> | undefined = undefined,
> {
  readonly name: string
  readonly schema?: WorkflowSchema<I>
  readonly signals?: S
  readonly queries?: Q
  readonly updates?: WorkflowUpdateDefinitions
  readonly handler: WorkflowHandler<I, O>
}
export function defineWorkflow<
  I,
  O,
  S extends Record<string, WorkflowSignalHandle<unknown>> | undefined,
  Q extends Record<string, WorkflowQueryHandle<unknown, unknown>> | undefined,
>(config: DefineWorkflowConfig<I, O, S, Q>): WorkflowDefinition<I, O, S, Q>
export function defineWorkflow<I, O>(
  name: string,
  handler: WorkflowHandler<I, O>,
  extras?: WorkflowDefinitionExtras,
): WorkflowDefinition<I, O, undefined, undefined>
export function defineWorkflow<I, O>(
  name: string,
  schema: WorkflowSchema<I>,
  handler: WorkflowHandler<I, O>,
  extras?: WorkflowDefinitionExtras,
): WorkflowDefinition<I, O, undefined, undefined>
export function defineWorkflow<
  I,
  O,
  S extends Record<string, WorkflowSignalHandle<unknown>> | undefined = undefined,
  Q extends Record<string, WorkflowQueryHandle<unknown, unknown>> | undefined = undefined,
>(
  nameOrConfig: string | DefineWorkflowConfig<I, O, S, Q>,
  schemaOrHandler?: WorkflowSchema<I> | WorkflowHandler<I, O>,
  maybeHandler?: WorkflowHandler<I, O> | WorkflowDefinitionExtras,
  maybeExtras?: WorkflowDefinitionExtras,
): WorkflowDefinition<I, O, S, Q> {
  if (typeof nameOrConfig === 'object') {
    const config = nameOrConfig
    const schema = config.schema ?? (defaultWorkflowSchema as unknown as WorkflowSchema<I>)
    const decodeArgumentsAsArray = config.schema
      ? config.schema.ast._tag === 'TupleType'
      : schema.ast._tag === 'TupleType'
    if (typeof config.handler !== 'function') {
      throw new Error(`Workflow "${config.name}" must provide a handler`)
    }
    return {
      name: config.name,
      schema,
      handler: config.handler,
      decodeArgumentsAsArray,
      ...(config.signals ? { signals: config.signals } : {}),
      ...(config.queries ? { queries: config.queries } : {}),
      ...(config.updates ? { updates: config.updates } : {}),
    } as WorkflowDefinition<I, O, S, Q>
  }
  const schema = Schema.isSchema(schemaOrHandler)
    ? (schemaOrHandler as WorkflowSchema<I>)
    : (defaultWorkflowSchema as unknown as WorkflowSchema<I>)
  const handler = Schema.isSchema(schemaOrHandler)
    ? (maybeHandler as WorkflowHandler<I, O> | undefined)
    : (schemaOrHandler as WorkflowHandler<I, O>)
  const extras = Schema.isSchema(schemaOrHandler)
    ? (maybeExtras ?? (typeof maybeHandler === 'object' ? (maybeHandler as WorkflowDefinitionExtras) : undefined))
    : (maybeHandler as WorkflowDefinitionExtras | undefined)
  const decodeArgumentsAsArray = Schema.isSchema(schemaOrHandler) ? schema.ast._tag === 'TupleType' : true
  if (typeof handler !== 'function') {
    throw new Error(`Workflow "${nameOrConfig}" must provide a handler`)
  }
  return {
    name: nameOrConfig,
    schema,
    handler,
    decodeArgumentsAsArray,
    ...(extras?.updates ? { updates: extras.updates } : {}),
  } as WorkflowDefinition<I, O, S, Q>
}

export type WorkflowDefinitions = ReadonlyArray<WorkflowDefinition<unknown, unknown>>

export const defineWorkflowUpdates = <T extends WorkflowUpdateDefinitions>(definitions: T): T => definitions
