import { PgClient } from '@effect/sql-pg'
import { Effect, Layer } from 'effect'

import { makeCycleBindingPrograms } from './binding-program'
import { makeCycleLifecyclePrograms } from './lifecycle-program'
import { CycleStore, type CycleStoreShape } from './model'
import { makeCycleMutationPrimitives } from './mutations'
import { makeCycleQueries } from './queries'
import { makeCycleReadPrograms } from './read-program'

const makeCycleStore = Effect.map(PgClient.PgClient, (sql) => {
  const queries = makeCycleQueries(sql)
  const mutations = makeCycleMutationPrimitives(sql, queries)

  return {
    ...makeCycleReadPrograms(queries),
    ...makeCycleLifecyclePrograms(sql, queries, mutations),
    ...makeCycleBindingPrograms(sql, queries, mutations),
  } satisfies CycleStoreShape
})

export const CycleStoreLive = Layer.effect(CycleStore, makeCycleStore)
