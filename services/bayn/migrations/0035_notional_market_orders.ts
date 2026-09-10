import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    ALTER TABLE orders
      DROP CONSTRAINT orders_schema_version_check,
      DROP CONSTRAINT orders_quantity_micros_check,
      DROP CONSTRAINT orders_check,
      DROP CONSTRAINT orders_check1,
      DROP CONSTRAINT orders_check2,
      ADD COLUMN notional_micros numeric(39, 0),
      ALTER COLUMN quantity_micros DROP NOT NULL,
      ADD CONSTRAINT orders_schema_version_check CHECK (
        schema_version IN ('bayn.paper-order.v1', 'bayn.paper-order.v2')
      ),
      ADD CONSTRAINT orders_quantity_micros_check CHECK (
        quantity_micros IS NULL
        OR (
          quantity_micros > 0
          AND quantity_micros <= 340282366920938463463374607431768211455
        )
      ),
      ADD CONSTRAINT orders_notional_micros_check CHECK (
        notional_micros IS NULL
        OR (
          notional_micros > 0
          AND notional_micros <= 340282366920938463463374607431768211455
        )
      ),
      ADD CONSTRAINT orders_filled_quantity_micros_check CHECK (
        filled_quantity_micros >= 0
        AND filled_quantity_micros <= 340282366920938463463374607431768211455
      ),
      ADD CONSTRAINT orders_request_representation_check CHECK (
        (
          schema_version = 'bayn.paper-order.v1'
          AND quantity_micros IS NOT NULL
          AND notional_micros IS NULL
        )
        OR (
          schema_version = 'bayn.paper-order.v2'
          AND (quantity_micros IS NULL) <> (notional_micros IS NULL)
        )
      ),
      ADD CONSTRAINT orders_type_price_check CHECK (
        (
          order_type = 'LIMIT'
          AND limit_price_micros IS NOT NULL
          AND notional_micros IS NULL
        )
        OR (order_type = 'MARKET' AND limit_price_micros IS NULL)
      ),
      ADD CONSTRAINT orders_status_quantity_check CHECK (
        (
          quantity_micros IS NOT NULL
          AND (
            (status = 'FILLED' AND filled_quantity_micros = quantity_micros)
            OR (
              status = 'PARTIALLY_FILLED'
              AND filled_quantity_micros > 0
              AND filled_quantity_micros < quantity_micros
            )
            OR (status IN ('NEW', 'PENDING') AND filled_quantity_micros = 0)
            OR (
              status IN ('CANCELED', 'EXPIRED', 'REJECTED')
              AND filled_quantity_micros < quantity_micros
            )
          )
        )
        OR (
          notional_micros IS NOT NULL
          AND (
            (status IN ('FILLED', 'PARTIALLY_FILLED') AND filled_quantity_micros > 0)
            OR (status IN ('NEW', 'PENDING') AND filled_quantity_micros = 0)
            OR status IN ('CANCELED', 'EXPIRED', 'REJECTED')
          )
        )
      )
  `
})
