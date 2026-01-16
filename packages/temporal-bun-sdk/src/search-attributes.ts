import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { decodeSearchAttributes, encodeSearchAttributes } from './client/serialization'
import type { DataConverter } from './common/payloads'
import type { SearchAttributes } from './proto/temporal/api/common/v1/message_pb'

export type SearchAttributeSchema = Schema.Schema<unknown>

export type SearchAttributeSchemaMap = Record<string, SearchAttributeSchema>

export const defineSearchAttributes = <T extends SearchAttributeSchemaMap>(fields: T) => Schema.Struct(fields)

export interface TypedSearchAttributes<T> {
  readonly schema: Schema.Schema<T>
  readonly encode: (input: T) => Promise<SearchAttributes | undefined>
  readonly decode: (attributes?: SearchAttributes | null) => Promise<T | undefined>
}

export const createTypedSearchAttributes = <T>(
  schema: Schema.Schema<T>,
  dataConverter: DataConverter,
): TypedSearchAttributes<T> => {
  const encode = async (input: T): Promise<SearchAttributes | undefined> => {
    const parsed = await Effect.runPromise(Schema.decodeUnknown(schema)(input))
    return encodeSearchAttributes(dataConverter, parsed as Record<string, unknown>)
  }

  const decode = async (attributes?: SearchAttributes | null): Promise<T | undefined> => {
    const decoded = await decodeSearchAttributes(dataConverter, attributes)
    if (!decoded) {
      return undefined
    }
    return Effect.runPromise(Schema.decodeUnknown(schema)(decoded))
  }

  return {
    schema,
    encode,
    decode,
  }
}
