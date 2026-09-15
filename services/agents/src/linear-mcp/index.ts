import { sql } from 'kysely'

import { getDb } from '../server/db'
import { ensureMigrations } from '../server/kysely-migrations'
import {
  recordLinearMcpContractDrift,
  recordLinearMcpIndeterminateWrite,
  recordLinearMcpOAuthRefresh,
  recordLinearMcpPolicyDenial,
  recordLinearMcpRequestDurationMs,
  recordLinearMcpUpstreamError,
  renderAgentsPrometheusMetrics,
} from '../server/metrics'

import { resolveLinearMcpGatewayConfig } from './config'
import { createKubernetesTokenReviewer, createLinearMcpIdentityVerifier } from './identity'
import { createLinearOAuthFetch, LinearOAuthTokenProvider } from './oauth'
import { createLinearMcpPolicyService } from './policy'
import { createLinearMutationReceiptStore } from './receipts'
import { createLinearMcpGatewayHandler } from './server'
import { createLinearUpstream, LinearUpstreamError } from './upstream'

const config = resolveLinearMcpGatewayConfig()
const db = getDb()
if (!db) throw new Error('Agents database is required for the Linear MCP gateway')

const oauth = new LinearOAuthTokenProvider(config.oauth, {
  timeoutMs: config.upstreamTimeoutMs,
  metrics: { recordRefresh: (outcome) => recordLinearMcpOAuthRefresh(outcome) },
})
const upstream = createLinearUpstream({
  url: config.upstreamUrl,
  fetch: createLinearOAuthFetch(oauth),
  timeoutMs: config.upstreamTimeoutMs,
})
const verifier = createLinearMcpIdentityVerifier({
  config,
  tokenReviewer: createKubernetesTokenReviewer(),
})
const receipts = createLinearMutationReceiptStore(db)
const policy = createLinearMcpPolicyService({
  upstream,
  receipts,
  triggerLabel: config.triggerLabel,
  actorId: config.oauth.actorId,
  onPolicyDenial: (code, tool) => recordLinearMcpPolicyDenial(code, tool),
  onUpstreamError: (operation) => recordLinearMcpUpstreamError(operation),
  onIndeterminateWrite: (tool) => recordLinearMcpIndeterminateWrite(tool),
})

let readinessCache: { expiresAt: number; value: { ok: boolean; reason?: string } } | null = null
const checkReady = async () => {
  const now = Date.now()
  if (readinessCache && readinessCache.expiresAt > now) return readinessCache.value
  let value: { ok: boolean; reason?: string }
  try {
    await ensureMigrations(db)
    await sql`SELECT 1`.execute(db)
    await upstream.checkContract()
    value = { ok: true }
  } catch (error) {
    if (error instanceof LinearUpstreamError && error.code === 'contract_drift') {
      recordLinearMcpContractDrift()
    } else {
      recordLinearMcpUpstreamError('readiness')
    }
    value = {
      ok: false,
      reason: error instanceof LinearUpstreamError ? error.code : 'dependency_unavailable',
    }
  }
  readinessCache = { expiresAt: now + config.readinessCacheMs, value }
  return value
}

const handler = createLinearMcpGatewayHandler({
  verifier,
  policy,
  maxRequestBytes: config.maxRequestBytes,
  checkReady,
  renderMetrics: renderAgentsPrometheusMetrics,
  recordPolicyDenial: recordLinearMcpPolicyDenial,
  recordRequestDurationMs: recordLinearMcpRequestDurationMs,
})

const server = Bun.serve({ port: config.port, fetch: handler })
console.info('[agents-linear-mcp] gateway started', { port: server.port })

let stopping = false
const stop = async () => {
  if (stopping) return
  stopping = true
  await server.stop(false)
  await upstream.close().catch(() => undefined)
  await db.destroy().catch(() => undefined)
}

process.once('SIGTERM', () => void stop())
process.once('SIGINT', () => void stop())
