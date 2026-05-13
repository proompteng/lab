import postgres, { type Sql } from 'postgres'
import {
  createGatewayState,
  getGatewayState,
  replaceGatewayState,
  resetGatewayState,
  type GatewayState,
} from './gateway'

const stateKey = 'gateway'
let sql: Sql | null = null
let schemaReady = false

const databaseUrl = () => process.env.DATABASE_URL?.trim()

const getSql = () => {
  const url = databaseUrl()
  if (!url) return null
  sql ??= postgres(url, { max: 1, idle_timeout: 20 })
  return sql
}

const ensureSchema = async (client: Sql) => {
  if (schemaReady) return
  await client`
    create table if not exists sag_state (
      key text primary key,
      value jsonb not null,
      updated_at timestamptz not null default now()
    )
  `
  schemaReady = true
}

const normalizeState = (value: Partial<GatewayState> | null | undefined): GatewayState => ({
  sequence: Number(value?.sequence ?? 0),
  events: value?.events ?? [],
  approvals: value?.approvals ?? [],
  rules: value?.rules ?? createGatewayState().rules,
  agentRuns: value?.agentRuns ?? [],
  ruleMessages: value?.ruleMessages ?? [],
})

export const persistenceEnabled = () => Boolean(databaseUrl())

export const loadGatewayState = async () => {
  const client = getSql()
  if (!client) return getGatewayState()

  try {
    await ensureSchema(client)
    const rows = await client<{ value: GatewayState }[]>`
      select value
      from sag_state
      where key = ${stateKey}
      limit 1
    `
    if (rows[0]?.value) {
      return replaceGatewayState(normalizeState(rows[0].value))
    }

    const state = createGatewayState()
    await saveGatewayState(state)
    return replaceGatewayState(state)
  } catch (error) {
    console.error('sag.persistence.load_failed', error)
    return getGatewayState()
  }
}

export const saveGatewayState = async (state: GatewayState) => {
  const client = getSql()
  if (!client) return

  try {
    await ensureSchema(client)
    await client`
      insert into sag_state (key, value, updated_at)
      values (${stateKey}, ${client.json(state)}, now())
      on conflict (key) do update
      set value = excluded.value,
          updated_at = now()
    `
  } catch (error) {
    console.error('sag.persistence.save_failed', error)
  }
}

export const resetPersistentGatewayState = async () => {
  const state = resetGatewayState()
  await saveGatewayState(state)
  return state
}
