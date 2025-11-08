export type JsonProperties = Record<string, unknown>

export interface GrafEntityRequest {
  readonly id?: string
  readonly label: string
  readonly properties?: JsonProperties
  readonly artifactId?: string
  readonly researchSource?: string
  readonly streamId?: string
}

export interface GrafEntityBatchRequest {
  readonly entities: GrafEntityRequest[]
}

export interface GrafRelationshipRequest {
  readonly id?: string
  readonly type: string
  readonly fromId: string
  readonly toId: string
  readonly properties?: JsonProperties
  readonly artifactId?: string
  readonly researchSource?: string
  readonly streamId?: string
}

export interface GrafRelationshipBatchRequest {
  readonly relationships: GrafRelationshipRequest[]
}

export interface GrafComplementRequest {
  readonly id: string
  readonly hints?: JsonProperties
  readonly artifactId?: string
}

export interface GrafCleanRequest {
  readonly artifactId?: string
  readonly olderThanHours?: number
}

export interface GrafResponse {
  readonly id: string
  readonly message: string
  readonly artifactId?: string
}

export interface GrafBatchResponse {
  readonly results: GrafResponse[]
}

export interface GrafComplementResponse {
  readonly id: string
  readonly message: string
  readonly artifactId?: string
}

export interface GrafCleanResponse {
  readonly affected: number
  readonly message: string
}
