import { Result, Schema } from 'effect'

import { Sha256Schema as Sha256, strictParseOptions as StrictParseOptions } from '../schemas'

export enum BrokerEnvironment {
  Sandbox = 'sandbox',
  Live = 'live',
}

export enum ExecutionAccess {
  ReadOnly = 'read-only',
  SubmitOrders = 'submit-orders',
}

export const BrokerEnvironmentSchema = Schema.Enum(BrokerEnvironment)
export const ExecutionAccessSchema = Schema.Enum(ExecutionAccess)
export const CapitalPolicyIdentitySchema = Sha256
export type CapitalPolicyIdentity = typeof CapitalPolicyIdentitySchema.Type

export enum CapitalAccessState {
  Disabled = 'Disabled',
  Enabled = 'Enabled',
}

export interface DisabledCapitalAccess {
  readonly _tag: CapitalAccessState.Disabled
}

export interface EnabledCapitalAccess {
  readonly _tag: CapitalAccessState.Enabled
  readonly policyIdentity: CapitalPolicyIdentity
}

export type CapitalAccess = DisabledCapitalAccess | EnabledCapitalAccess

export interface ExecutionAuthority {
  readonly brokerEnvironment: BrokerEnvironment
  readonly executionAccess: ExecutionAccess
  readonly capitalAccess: CapitalAccess
}

export const disabledCapitalAccess: DisabledCapitalAccess = {
  _tag: CapitalAccessState.Disabled,
}

export const enabledCapitalAccess = (policyIdentity: CapitalPolicyIdentity): EnabledCapitalAccess => ({
  _tag: CapitalAccessState.Enabled,
  policyIdentity,
})

export const makeExecutionAuthority = (
  brokerEnvironment: BrokerEnvironment,
  executionAccess: ExecutionAccess,
  capitalAccess: CapitalAccess,
): ExecutionAuthority => ({
  brokerEnvironment,
  executionAccess,
  capitalAccess,
})

export const CapitalAccessSchema = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal(CapitalAccessState.Disabled),
  }),
  Schema.Struct({
    _tag: Schema.Literal(CapitalAccessState.Enabled),
    policyIdentity: CapitalPolicyIdentitySchema,
  }),
])

export const ExecutionAuthoritySchema = Schema.Struct({
  brokerEnvironment: BrokerEnvironmentSchema,
  executionAccess: ExecutionAccessSchema,
  capitalAccess: CapitalAccessSchema,
})

const decodeExecutionAuthorityResult = Schema.decodeUnknownResult(ExecutionAuthoritySchema, StrictParseOptions)

export const decodeExecutionAuthority = (input: unknown): Result.Result<ExecutionAuthority, Schema.SchemaError> =>
  decodeExecutionAuthorityResult(input)
