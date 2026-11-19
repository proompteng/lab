import { PgClient } from '@effect/sql-pg'
import { Effect, Schema } from 'effect'
import { researchCapitalGenerationIsBoundToBuildLineage } from '../execution/configuration'
import { makeAuthorityPostgres } from '../db/execution-store/authority-shared'
import { makeObserveAuthorityInterpreter } from '../db/execution-store/observe-authority'
import { BrokerEnvironment, BrokerIdentitySchema } from '../broker/identity'
import { canonicalHashV1Result } from '../hash'
import { Sha256Schema, StrictNonEmptyStringSchema } from '../schemas'
import { SystemAssessmentError } from './economics'
import { PolicyDefinitionSchema } from './policy'

export const readRegisteredFinancialIdentity = (definition: typeof PolicyDefinitionSchema.Type) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const rows = yield* Schema.decodeUnknownEffect(
      Schema.Array(
        Schema.Struct({
          identity: BrokerIdentitySchema,
          riskPolicyHash: Sha256Schema,
          sourceRevision: StrictNonEmptyStringSchema,
          imageDigest: StrictNonEmptyStringSchema,
          strategyHash: Sha256Schema,
          parametersHash: Sha256Schema,
          protocolHash: Sha256Schema,
        }),
      ),
    )(
      yield* sql`SELECT risk_policy_hash AS "riskPolicyHash",
        activation_source_revision AS "sourceRevision", activation_image_digest AS "imageDigest",
        strategy_behavior_hash AS "strategyHash", strategy_parameter_hash AS "parametersHash",
        strategy_protocol_hash AS "protocolHash", jsonb_build_object(
        'schemaVersion', broker_identity_schema_version, 'provider', broker_provider,
        'environment', broker_environment, 'accountId', account_id, 'identityHash', broker_identity_hash
      ) AS identity FROM authority_generations WHERE generation_hash = ${definition.authorityGenerationHash}`,
    )
    const row = rows[0]
    if (row === undefined) return null
    const accountBindingHash = yield* Effect.fromResult(
      canonicalHashV1Result({
        schemaVersion: 'bayn.inference-cost-account.v1',
        accountId: row.identity.accountId,
      }),
    )
    if (
      row.identity.environment !== BrokerEnvironment.Sandbox ||
      row.riskPolicyHash !== definition.riskPolicyHash ||
      row.strategyHash !== definition.strategyHash ||
      row.parametersHash !== definition.parametersHash ||
      row.protocolHash !== definition.protocolHash ||
      accountBindingHash !== definition.accountBindingHash
    )
      return yield* new SystemAssessmentError({
        message:
          'Financial capture account, environment, risk policy or generation provenance differs from registration',
      })
    const authoredBuildMatches =
      row.sourceRevision === definition.sourceRevision &&
      row.imageDigest.replace(/^sha256:/, '') === definition.imageDigest
    const binding = definition.capitalAuthorization
    if (!authoredBuildMatches && binding === undefined)
      return yield* new SystemAssessmentError({
        message: 'Different execution build requires registered capital lineage',
      })
    if (binding !== undefined) {
      const generation = yield* makeObserveAuthorityInterpreter(
        sql,
        makeAuthorityPostgres(sql),
        row.identity,
      ).readResearchAuthorityGeneration(definition.authorityGenerationHash)
      if (generation === undefined)
        return yield* new SystemAssessmentError({ message: 'Capture capital generation is missing' })
      if (
        (yield* Effect.fromResult(canonicalHashV1Result(generation))) !==
        (yield* Effect.fromResult(canonicalHashV1Result(binding.generation)))
      )
        return yield* new SystemAssessmentError({
          message: 'Registered capital generation differs from durable history',
        })
      yield* Effect.fromResult(
        researchCapitalGenerationIsBoundToBuildLineage(
          binding.buildLineage,
          binding.request,
          {
            sourceRevision: definition.sourceRevision,
            imageRepository: binding.buildLineage.activation.imageRepository,
            imageDigest: `sha256:${definition.imageDigest}`,
          },
          generation.previousGenerationHash,
          generation,
        ),
      ).pipe(Effect.mapError((message) => new SystemAssessmentError({ message })))
    }
    return row.identity
  })
