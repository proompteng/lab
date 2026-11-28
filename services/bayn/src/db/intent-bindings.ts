import { PgClient } from '@effect/sql-pg'
import { Effect, Schema } from 'effect'

import { NativeProtectionSchema, type NativeProtection } from '../execution/contracts'
import { Sha256Schema as Sha256, StrictNonEmptyStringSchema as NonEmptyString, strictParseOptions } from '../schemas'

export interface IntentBinding {
  readonly intentId: string
  readonly clientOrderId: string
  readonly symbol?: string
  readonly quantityAtoms?: string
  readonly protection?: NativeProtection
}

const IntentBindingRow = Schema.Struct({
  intent_id: Sha256,
  client_order_id: NonEmptyString,
  symbol: Schema.String,
  quantity_atoms: Schema.String,
  protection: Schema.NullOr(NativeProtectionSchema),
})

const decodeBindings = Schema.decodeUnknownEffect(Schema.Array(IntentBindingRow), strictParseOptions)

export const readIntentBindings = (sql: PgClient.PgClient, accountId: string) =>
  sql<Record<string, unknown>>`
    SELECT intent_id, client_order_id, symbol, quantity_atoms::text, protection
    FROM intents
    WHERE account_id = ${accountId}
    ORDER BY client_order_id COLLATE "C"
  `.pipe(
    Effect.flatMap(decodeBindings),
    Effect.map((rows) =>
      rows.map((row) => ({
        intentId: row.intent_id,
        clientOrderId: row.client_order_id,
        symbol: row.symbol,
        quantityAtoms: row.quantity_atoms,
        ...(row.protection === null ? {} : { protection: row.protection }),
      })),
    ),
  )
