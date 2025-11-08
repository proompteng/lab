import { Effect } from 'effect'
import * as Schema from 'effect/Schema'

import { type GrafConfig, loadGrafConfig } from '../config'
import { createGrafClient, type GrafClient, type GrafRequestMetadata } from '../graf/client'
import type {
  GrafCleanRequest,
  GrafComplementRequest,
  GrafEntityBatchRequest,
  GrafRelationshipBatchRequest,
} from '../graf/types'
import { defineWorkflow } from '../workflow'

const JsonPropertiesSchema = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
})

const EntityInputSchema = Schema.Struct({
  label: Schema.String,
  properties: Schema.optional(JsonPropertiesSchema),
})

const RelationshipInputSchema = Schema.Struct({
  type: Schema.String,
  fromId: Schema.String,
  toId: Schema.String,
  properties: Schema.optional(JsonPropertiesSchema),
})

const ComplementInputSchema = Schema.Struct({
  id: Schema.String,
  hints: Schema.optional(JsonPropertiesSchema),
})

const CleanInputSchema = Schema.Struct({
  olderThanHours: Schema.optional(Schema.Number),
})

const ArtifactInputSchema = Schema.Struct({
  artifactId: Schema.String,
  streamId: Schema.String,
  confidence: Schema.Number,
  entities: Schema.Array(EntityInputSchema),
  relationships: Schema.Array(RelationshipInputSchema),
  complement: Schema.optional(ComplementInputSchema),
  clean: Schema.optional(CleanInputSchema),
})

const WorkflowInputSchema = Schema.Struct({
  artifact: ArtifactInputSchema,
})

export interface NvidiaArtifactEntityInput {
  readonly label: string
  readonly properties?: Record<string, unknown>
}

export interface NvidiaArtifactRelationshipInput {
  readonly type: string
  readonly fromId: string
  readonly toId: string
  readonly properties?: Record<string, unknown>
}

export interface NvidiaArtifactComplementInput {
  readonly id: string
  readonly hints?: Record<string, unknown>
}

export interface NvidiaArtifactCleanInput {
  readonly olderThanHours?: number
}

export interface NvidiaArtifactPayload {
  readonly artifactId: string
  readonly streamId: string
  readonly confidence: number
  readonly entities: ReadonlyArray<NvidiaArtifactEntityInput>
  readonly relationships: ReadonlyArray<NvidiaArtifactRelationshipInput>
  readonly complement?: NvidiaArtifactComplementInput
  readonly clean?: NvidiaArtifactCleanInput
}

export interface NvidiaSupplyChainWorkflowInput {
  readonly artifact: NvidiaArtifactPayload
}

export interface NvidiaSupplyChainWorkflowResult {
  readonly artifactId: string
  readonly workflowId: string
  readonly workflowRunId: string
  readonly status: 'skipped' | 'ingested'
  readonly detail?: string
}

export interface NvidiaSupplyChainWorkflowDependencies {
  readonly grafClient?: GrafClient
  readonly grafConfig?: GrafConfig
}

const entityBatchFromArtifact = (artifact: NvidiaArtifactPayload): GrafEntityBatchRequest => ({
  entities: artifact.entities.map((entity) => ({
    label: entity.label,
    properties: entity.properties,
  })),
})

const relationshipBatchFromArtifact = (artifact: NvidiaArtifactPayload): GrafRelationshipBatchRequest => ({
  relationships: artifact.relationships.map((relationship) => ({
    type: relationship.type,
    fromId: relationship.fromId,
    toId: relationship.toId,
    properties: relationship.properties,
  })),
})

const complementRequestFromArtifact = (artifact: NvidiaArtifactPayload): GrafComplementRequest | undefined =>
  artifact.complement
    ? {
        id: artifact.complement.id,
        hints: artifact.complement.hints,
      }
    : undefined

const cleanRequestFromArtifact = (artifact: NvidiaArtifactPayload): GrafCleanRequest | undefined =>
  artifact.clean
    ? {
        olderThanHours: artifact.clean.olderThanHours,
      }
    : undefined

const buildMetadata = (
  artifact: NvidiaArtifactPayload,
  workflowId: string,
  workflowRunId: string,
): GrafRequestMetadata => ({
  artifactId: artifact.artifactId,
  streamId: artifact.streamId,
  workflowId,
  workflowRunId,
})

export const createNvidiaSupplyChainWorkflow = (dependencies: NvidiaSupplyChainWorkflowDependencies = {}) => {
  const grafConfig = dependencies.grafConfig ?? loadGrafConfig()
  const grafClient = dependencies.grafClient ?? createGrafClient(grafConfig)

  return defineWorkflow('ingestCodexArtifact', WorkflowInputSchema, ({ input, info, determinism }) =>
    Effect.gen(function* ($) {
      const artifact = input.artifact
      const metadata = buildMetadata(artifact, info.workflowId, info.runId)

      if (artifact.confidence < grafConfig.confidenceThreshold) {
        return {
          artifactId: artifact.artifactId,
          workflowId: metadata.workflowId,
          workflowRunId: metadata.workflowRunId,
          status: 'skipped',
          detail: `confidence ${artifact.confidence.toFixed(2)} < ${grafConfig.confidenceThreshold.toFixed(2)}`,
        }
      }

      yield* $(Effect.promise(() => grafClient.persistEntities(entityBatchFromArtifact(artifact), metadata)))

      yield* $(Effect.promise(() => grafClient.persistRelationships(relationshipBatchFromArtifact(artifact), metadata)))

      const complementRequest = complementRequestFromArtifact(artifact)
      if (complementRequest) {
        yield* $(Effect.promise(() => grafClient.complement(complementRequest, metadata)))
      }

      const cleanRequest = cleanRequestFromArtifact(artifact)
      if (cleanRequest) {
        yield* $(Effect.promise(() => grafClient.clean(cleanRequest, metadata)))
      }

      return {
        artifactId: artifact.artifactId,
        workflowId: metadata.workflowId,
        workflowRunId: metadata.workflowRunId,
        status: 'ingested',
        detail: new Date(determinism.now()).toISOString(),
      }
    }),
  )
}

export const nvidiaSupplyChainWorkflow = createNvidiaSupplyChainWorkflow()
