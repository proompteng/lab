import { Result, Schema } from 'effect'

import { makeStrategyProtocolHashResult } from '../contracts'
import { ExecutionStrategyIdentitySchema } from '../execution/authority'
import { canonicalHashV1Result } from '../hash'
import { JevResearchPolicy } from '../jev/acceptance'
import { decisionsModel } from '../jev/decisions'
import { EntryAblationPolicySchema, entryAblationStrategyIdentity } from '../jev/entry-ablation-policy'
import { entryJudgmentPolicy } from '../jev/entry-questions'
import { jevPositionExitPolicy } from '../jev/exit-policy'
import { JevProtocolSchema, jevBehaviorHash, usesJevOnlyInference, type JevProtocol } from '../jev/protocol'
import { stagedChartQuestionPolicy } from '../jev/staged-chart-questions'
import { Sha256Schema, strictParseOptions } from '../schemas'
import {
  IntradayAlphaPolicySchema,
  intradayAlphaPromptPolicy,
  intradayAlphaStrategyIdentity,
} from '../strategy/intraday-alpha/policy'
import {
  RepeatedMomentumPolicySchema,
  repeatedMomentumPromptPolicy,
  repeatedMomentumStrategyIdentity,
} from '../strategy/repeated-momentum/policy'
import { SystemAssessmentError } from './economics'
import {
  frozenControlContinuation,
  frozenControlOrigin,
  frozenControlPrompts,
  frozenDeployedControlIdentity,
} from './frozen-control-identity'

/** Policy roles name economic comparisons; they never select an implementation. */
export enum ResearchStrategyEngine {
  Jev = 'JEV_V44',
  IntradayAlpha = 'INTRADAY_ALPHA_V2',
  EntryAblation = 'ENTRY_ABLATION_V1',
  RepeatedMomentum = 'REPEATED_MOMENTUM_V1',
  FrozenDeployed = 'FROZEN_DEPLOYED_V3',
}

const JevMaterialSchema = Schema.Struct({
  engine: Schema.Literal(ResearchStrategyEngine.Jev),
  parameters: JevProtocolSchema,
})
const AlphaMaterialSchema = Schema.Struct({
  engine: Schema.Literal(ResearchStrategyEngine.IntradayAlpha),
  parameters: IntradayAlphaPolicySchema,
})
const AblationMaterialSchema = Schema.Struct({
  engine: Schema.Literal(ResearchStrategyEngine.EntryAblation),
  parameters: EntryAblationPolicySchema,
})
const MomentumMaterialSchema = Schema.Struct({
  engine: Schema.Literal(ResearchStrategyEngine.RepeatedMomentum),
  parameters: RepeatedMomentumPolicySchema,
})
const FrozenMaterialSchema = Schema.Struct({
  engine: Schema.Literal(ResearchStrategyEngine.FrozenDeployed),
  // Preserve every original field. The full canonical hash must equal the pinned pre-Jev protocol.
  parameters: Schema.Record(Schema.String, Schema.Json),
})
const ResearchStrategyMaterialSchema = Schema.Union([
  JevMaterialSchema,
  AlphaMaterialSchema,
  AblationMaterialSchema,
  MomentumMaterialSchema,
  FrozenMaterialSchema,
])
export type ResearchStrategyMaterial = typeof ResearchStrategyMaterialSchema.Type

const bindingFields = {
  schemaVersion: Schema.Literal('bayn.research-strategy-binding.v1'),
  strategy: ExecutionStrategyIdentitySchema,
  protocolHash: Sha256Schema,
}
export const ServingResearchStrategyBindingSchema = Schema.Union([
  Schema.Struct({ ...bindingFields, ...JevMaterialSchema.fields }),
  Schema.Struct({ ...bindingFields, ...AlphaMaterialSchema.fields }),
])
export type ServingResearchStrategyBinding = typeof ServingResearchStrategyBindingSchema.Type
export const ResearchStrategyBindingSchema = Schema.Union([
  ServingResearchStrategyBindingSchema,
  Schema.Struct({ ...bindingFields, ...AblationMaterialSchema.fields }),
  Schema.Struct({ ...bindingFields, ...MomentumMaterialSchema.fields }),
  Schema.Struct({ ...bindingFields, ...FrozenMaterialSchema.fields }),
])
export type ResearchStrategyBinding = typeof ResearchStrategyBindingSchema.Type

const strategyIdentity = (material: ResearchStrategyMaterial) =>
  Result.gen(function* () {
    if (material.engine !== ResearchStrategyEngine.FrozenDeployed) {
      const protocol =
        material.engine === ResearchStrategyEngine.Jev ? material.parameters : material.parameters.sharedProtocol
      if (protocol.schemaVersion !== 'bayn.jev.protocol.v44')
        return yield* Result.fail(
          new SystemAssessmentError({
            message: 'This research engine requires its explicit v44 shared execution protocol',
          }),
        )
    }
    switch (material.engine) {
      case ResearchStrategyEngine.IntradayAlpha:
        return yield* intradayAlphaStrategyIdentity(material.parameters)
      case ResearchStrategyEngine.EntryAblation:
        return yield* entryAblationStrategyIdentity(material.parameters)
      case ResearchStrategyEngine.RepeatedMomentum:
        return yield* repeatedMomentumStrategyIdentity(material.parameters)
      case ResearchStrategyEngine.FrozenDeployed: {
        if (
          material.parameters['schemaVersion'] !== frozenControlOrigin.parameterSchemaVersion ||
          (yield* canonicalHashV1Result(material.parameters)) !== frozenDeployedControlIdentity.parametersHash
        )
          return yield* Result.fail(
            new SystemAssessmentError({ message: 'Frozen control requires its complete original protocol material' }),
          )
        return {
          strategy: {
            name: frozenControlOrigin.strategyName,
            behaviorHash: frozenDeployedControlIdentity.strategyHash,
            parameterHash: frozenDeployedControlIdentity.parametersHash,
            parameterSchemaVersion: frozenControlOrigin.parameterSchemaVersion,
          },
          protocolHash: frozenDeployedControlIdentity.protocolHash,
        }
      }
      case ResearchStrategyEngine.Jev: {
        const strategy = {
          name: 'jev' as const,
          behaviorHash: jevBehaviorHash,
          parameterHash: yield* canonicalHashV1Result(material.parameters),
          parameterSchemaVersion: material.parameters.schemaVersion,
        }
        return { strategy, protocolHash: yield* makeStrategyProtocolHashResult(strategy) }
      }
    }
  })

/** Explicit policy material is mandatory; the currently deployed strategy is never consulted. */
export const makeResearchStrategyBinding = (input: ResearchStrategyMaterial) =>
  Result.gen(function* () {
    const material = yield* Schema.decodeUnknownResult(ResearchStrategyMaterialSchema, strictParseOptions)(input)
    const identity = yield* strategyIdentity(material)
    return yield* Schema.decodeUnknownResult(
      ResearchStrategyBindingSchema,
      strictParseOptions,
    )({ schemaVersion: 'bayn.research-strategy-binding.v1', ...material, ...identity })
  }).pipe(
    Result.mapError((cause) => new SystemAssessmentError({ message: 'Research strategy material is invalid', cause })),
  )

export const validateResearchStrategyBinding = (input: unknown) =>
  Result.gen(function* () {
    const binding = yield* Schema.decodeUnknownResult(ResearchStrategyBindingSchema, strictParseOptions)(input)
    const identity = yield* strategyIdentity(binding)
    if (
      binding.protocolHash !== identity.protocolHash ||
      (yield* canonicalHashV1Result(binding.strategy)) !== (yield* canonicalHashV1Result(identity.strategy))
    )
      return yield* Result.fail(
        new SystemAssessmentError({ message: 'Research strategy identity differs from its complete engine policy' }),
      )
    return binding
  }).pipe(
    Result.mapError((cause) => new SystemAssessmentError({ message: 'Research strategy binding is invalid', cause })),
  )

export const researchStrategyEngineMatchesRole = (role: JevResearchPolicy, engine: ResearchStrategyEngine): boolean => {
  switch (role) {
    case JevResearchPolicy.Candidate:
    case JevResearchPolicy.Incumbent:
      return engine === ResearchStrategyEngine.Jev || engine === ResearchStrategyEngine.IntradayAlpha
    case JevResearchPolicy.Ablation:
      return engine === ResearchStrategyEngine.EntryAblation
    case JevResearchPolicy.Momentum:
      return engine === ResearchStrategyEngine.RepeatedMomentum
    case JevResearchPolicy.Deployed:
      return engine === ResearchStrategyEngine.FrozenDeployed
  }
}

export const researchStrategyProtocol = (binding: ResearchStrategyBinding): JevProtocol | null => {
  switch (binding.engine) {
    case ResearchStrategyEngine.FrozenDeployed:
      return null
    case ResearchStrategyEngine.Jev:
      return binding.parameters
    default:
      return binding.parameters.sharedProtocol
  }
}

/** A provider-free engine still requires complete actual cost and zero-call evidence. */
export const researchStrategyInferenceModels = (
  binding: ResearchStrategyBinding,
): readonly { readonly provider: string; readonly model: string }[] => {
  switch (binding.engine) {
    case ResearchStrategyEngine.FrozenDeployed:
    case ResearchStrategyEngine.RepeatedMomentum:
      return []
    case ResearchStrategyEngine.IntradayAlpha:
      return binding.parameters.catalystVeto.enabled
        ? [{ provider: 'typesafe', model: binding.parameters.catalystVeto.model }]
        : []
    case ResearchStrategyEngine.EntryAblation:
      return [
        usesJevOnlyInference(binding.parameters.sharedProtocol)
          ? { provider: 'typesafe', model: binding.parameters.sharedProtocol.model }
          : { provider: 'openai', model: decisionsModel },
      ]
    case ResearchStrategyEngine.Jev:
      return [
        { provider: 'typesafe', model: binding.parameters.model },
        ...(usesJevOnlyInference(binding.parameters) ? [] : [{ provider: 'openai', model: decisionsModel }]),
      ]
  }
}

/** The full alpha wrapper owns its phase exits; legacy native control material remains unchanged. */
export const researchStrategyPolicyMaterial = (binding: ResearchStrategyBinding) => {
  if (binding.engine === ResearchStrategyEngine.FrozenDeployed)
    return {
      prompts: frozenControlPrompts,
      continuationAndExits: frozenControlContinuation,
      executionModel: binding.parameters['executionModel'],
    }
  if (binding.engine === ResearchStrategyEngine.IntradayAlpha)
    return {
      prompts: intradayAlphaPromptPolicy,
      continuationAndExits: {
        schemaVersion: 'bayn.native-alpha-continuation-policy.v1' as const,
        policy: binding.parameters,
      },
      executionModel: binding.parameters.sharedProtocol.executionModel,
    }
  const protocol =
    binding.engine === ResearchStrategyEngine.Jev ? binding.parameters : binding.parameters.sharedProtocol
  const { plans: _plans, ...positionProtection } = jevPositionExitPolicy(protocol, {})
  return {
    prompts:
      binding.engine === ResearchStrategyEngine.RepeatedMomentum
        ? repeatedMomentumPromptPolicy
        : binding.engine === ResearchStrategyEngine.EntryAblation
          ? stagedChartQuestionPolicy
          : { chart: stagedChartQuestionPolicy, jev: entryJudgmentPolicy },
    continuationAndExits: {
      schemaVersion: 'bayn.native-continuation-policy.v1' as const,
      protocol,
      positionProtection,
      ...(binding.engine === ResearchStrategyEngine.RepeatedMomentum ? { momentum: binding.parameters } : {}),
    },
    executionModel: protocol.executionModel,
  }
}
