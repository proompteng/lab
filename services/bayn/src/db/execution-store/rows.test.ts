import { describe, expect, test } from 'bun:test'

import { Result, Schema } from 'effect'

import { Authority } from '../../execution/contracts'
import { strictParseOptions } from '../../schemas'
import { AuthorityGenerationRow } from './rows'

describe('execution-store row compatibility', () => {
  test('decodes persisted intraday-momentum v1 authority history', () => {
    const decoded = Schema.decodeUnknownResult(
      AuthorityGenerationRow,
      strictParseOptions,
    )({
      generation_hash: '1'.repeat(64),
      activation_schema_version: 'bayn.paper-authority-generation.v3',
      previous_generation_hash: null,
      maximum: Authority.Execution,
      authority_version: '1',
      broker_identity_schema_version: 'bayn.broker-identity.v2',
      broker_identity_hash: '2'.repeat(64),
      broker_provider: 'alpaca',
      broker_environment: 'sandbox',
      qualification_run_id: null,
      qualification_lock_id: null,
      qualification_result_hash: null,
      protocol_hash: '3'.repeat(64),
      qualification_execution_policy_hash: null,
      qualification_source_revision: null,
      qualification_image_repository: null,
      qualification_image_digest: null,
      activation_source_revision: '4'.repeat(40),
      activation_image_repository: 'registry.example/bayn',
      activation_image_digest: `sha256:${'5'.repeat(64)}`,
      strategy_name: 'intraday-momentum',
      strategy_behavior_hash: '6'.repeat(64),
      strategy_parameter_hash: '7'.repeat(64),
      strategy_parameter_schema_version: 'bayn.intraday-momentum.protocol.v1',
      account_id: 'sandbox-account',
      risk_policy_hash: '8'.repeat(64),
      proof_plan_hash: null,
      reconciliation_id: '9'.repeat(64),
      reconciliation_content_hash: 'a'.repeat(64),
      research_plan_hash: 'b'.repeat(64),
      strategy_protocol_hash: 'c'.repeat(64),
      activated_at: new Date('2026-08-01T00:00:00.000Z'),
    })

    expect(Result.isSuccess(decoded)).toBe(true)
  })
})
