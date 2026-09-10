import { describe, expect, it } from 'vitest'

import { loadConfig } from '@/config'

const baseEnv = {
  GITHUB_WEBHOOK_SECRET: 'secret',
  LINEAR_WEBHOOK_ENABLED: 'true',
  LINEAR_WEBHOOK_SECRET: 'linear-secret',
  KAFKA_BROKERS: 'broker1:9092,broker2:9093',
  KAFKA_USERNAME: 'user',
  KAFKA_PASSWORD: 'pass',
  KAFKA_TOPIC: 'raw-topic',
  KAFKA_DISCORD_COMMAND_TOPIC: 'discord.commands.incoming',
  KAFKA_LINEAR_WEBHOOK_TOPIC: 'linear.webhook.events',
  ATLAS_BASE_URL: 'http://jangar',
  DISCORD_PUBLIC_KEY: 'public-key',
}

describe('loadConfig', () => {
  it('parses brokers and returns defaults', () => {
    const config = loadConfig(baseEnv)

    expect(config.idempotency.ttlMs).toBe(10 * 60 * 1000)
    expect(config.idempotency.maxEntries).toBe(10_000)
    expect(config.kafka.brokers).toEqual(['broker1:9092', 'broker2:9093'])
    expect(config.agents.serviceBaseUrl).toBe('http://agents.agents.svc.cluster.local')
    expect(config.agents.serviceClientName).toBe('froussard')
    expect(config.agents.namespace).toBe('agents')
    expect(config.agents.agentName).toBe('codex-agent')
    expect(config.agents.linearAgentName).toBe('codex-linear-agent')
    expect(config.agents.vcsProviderName).toBe('github')
    expect(config.agents.serviceAccountName).toBe('agents-sa')
    expect(config.agents.secrets).toEqual(['github-token', 'codex-auth'])
    expect(config.agents.secretBindingRef).toBe('codex-github-token')
    expect(config.agents.ttlSecondsAfterFinished).toBe(86_400)
    expect(config.agents.goalTokenBudget).toBe(250_000)
    expect(config.codebase.baseBranch).toBe('main')
    expect(config.codebase.branchPrefix).toBe('codex/issue-')
    expect(config.codex.triggerLogins).toEqual(['gregkonush', 'tuslagch'])
    expect(config.codex.workflowLogin).toBe('github-actions[bot]')
    expect(config.codex.implementationTriggerPhrase).toBe('implement issue')
    expect(config.discord.publicKey).toBe('public-key')
    expect(config.discord.defaultResponse.ephemeral).toBe(true)
    expect(config.kafka.topics.linearRaw).toBe('linear.webhook.events')
    expect(config.linear).toEqual({
      enabled: true,
      triggerLabel: 'agentrun',
      repository: 'proompteng/lab',
      baseBranch: 'main',
      branchPrefix: 'codex/linear-',
      maxBodyBytes: 1024 * 1024,
      webhookToleranceMs: 60_000,
      agentsTimeoutMs: 3_000,
    })
  })

  it('allows overriding defaults via env', () => {
    const env = {
      ...baseEnv,
      CODEX_BASE_BRANCH: 'develop',
      CODEX_BRANCH_PREFIX: 'custom/',
      CODEX_TRIGGER_LOGINS: 'user-one, user-two',
      CODEX_WORKFLOW_LOGIN: 'Automation-Bot',
      CODEX_IMPLEMENTATION_TRIGGER: 'run it',
      GITHUB_ACK_REACTION: 'eyes',
      DISCORD_DEFAULT_EPHEMERAL: 'false',
      FROUSSARD_WEBHOOK_IDEMPOTENCY_TTL_MS: '30000',
      FROUSSARD_WEBHOOK_IDEMPOTENCY_MAX_ENTRIES: '250',
      AGENTS_SERVICE_BASE_URL: 'http://agents.override/',
      AGENTS_SERVICE_CLIENT_NAME: 'froussard-tests',
      AGENTS_NAMESPACE: 'agents-dev',
      AGENTS_CODEX_AGENT_NAME: 'codex-spark-agent',
      AGENTS_LINEAR_AGENT_NAME: 'codex-linear-dev',
      AGENTS_VCS_PROVIDER_NAME: 'github-dev',
      AGENTS_SERVICE_ACCOUNT_NAME: 'custom-sa',
      AGENTS_CODEX_SECRETS: 'codex-openai-key, codex-github-token',
      AGENTS_CODEX_SECRET_BINDING_REF: 'codex-github-token-dev',
      AGENTS_CODEX_TTL_SECONDS_AFTER_FINISHED: '600',
      AGENTS_CODEX_GOAL_TOKEN_BUDGET: '12345',
      LINEAR_TRIGGER_LABEL: 'AgentRun-Dev',
      LINEAR_REPOSITORY: 'owner/linear-target',
      LINEAR_BASE_BRANCH: 'develop',
      LINEAR_BRANCH_PREFIX: 'automation/linear-',
      LINEAR_MAX_BODY_BYTES: '2048',
      LINEAR_WEBHOOK_TOLERANCE_MS: '45000',
      LINEAR_AGENTS_TIMEOUT_MS: '2500',
    }

    const config = loadConfig(env)
    expect(config.idempotency.ttlMs).toBe(30000)
    expect(config.idempotency.maxEntries).toBe(250)
    expect(config.codebase.baseBranch).toBe('develop')
    expect(config.codebase.branchPrefix).toBe('custom/')
    expect(config.codex.triggerLogins).toEqual(['user-one', 'user-two'])
    expect(config.codex.workflowLogin).toBe('automation-bot')
    expect(config.codex.implementationTriggerPhrase).toBe('run it')
    expect(config.github.ackReaction).toBe('eyes')
    expect(config.discord.defaultResponse.ephemeral).toBe(false)
    expect(config.agents.serviceBaseUrl).toBe('http://agents.override')
    expect(config.agents.serviceClientName).toBe('froussard-tests')
    expect(config.agents.namespace).toBe('agents-dev')
    expect(config.agents.agentName).toBe('codex-spark-agent')
    expect(config.agents.linearAgentName).toBe('codex-linear-dev')
    expect(config.agents.vcsProviderName).toBe('github-dev')
    expect(config.agents.serviceAccountName).toBe('custom-sa')
    expect(config.agents.secrets).toEqual(['codex-openai-key', 'codex-github-token'])
    expect(config.agents.secretBindingRef).toBe('codex-github-token-dev')
    expect(config.agents.ttlSecondsAfterFinished).toBe(600)
    expect(config.agents.goalTokenBudget).toBe(12345)
    expect(config.linear).toEqual({
      enabled: true,
      triggerLabel: 'agentrun-dev',
      repository: 'owner/linear-target',
      baseBranch: 'develop',
      branchPrefix: 'automation/linear-',
      maxBodyBytes: 2048,
      webhookToleranceMs: 45_000,
      agentsTimeoutMs: 2_500,
    })
  })

  it('supports idempotency TTL seconds env', () => {
    const env = {
      ...baseEnv,
      FROUSSARD_WEBHOOK_IDEMPOTENCY_TTL_SECONDS: '45',
      FROUSSARD_WEBHOOK_IDEMPOTENCY_MAX_ENTRIES: '123',
    }

    const config = loadConfig(env)
    expect(config.idempotency.ttlMs).toBe(45_000)
    expect(config.idempotency.maxEntries).toBe(123)
  })

  it('falls back to CODEX_TRIGGER_LOGIN when list env is absent', () => {
    const env = {
      ...baseEnv,
      CODEX_TRIGGER_LOGIN: 'ServiceUser',
    }

    const config = loadConfig(env)
    expect(config.codex.triggerLogins).toEqual(['serviceuser'])
  })

  it('accepts the legacy JANGAR_BASE_URL alias for Atlas enrichment', () => {
    const env = {
      ...baseEnv,
      ATLAS_BASE_URL: undefined,
      JANGAR_BASE_URL: 'http://legacy-jangar/',
    }

    const config = loadConfig(env)
    expect(config.atlas.baseUrl).toBe('http://legacy-jangar')
  })

  it('throws when required env is missing', () => {
    expect(() => loadConfig({ ...baseEnv, KAFKA_BROKERS: '' })).toThrow()
    expect(() => loadConfig({ ...baseEnv, GITHUB_WEBHOOK_SECRET: undefined })).toThrow()
    expect(() => loadConfig({ ...baseEnv, LINEAR_WEBHOOK_SECRET: undefined })).toThrow()
    expect(() => loadConfig({ ...baseEnv, KAFKA_DISCORD_COMMAND_TOPIC: undefined })).toThrow()
    expect(() => loadConfig({ ...baseEnv, KAFKA_LINEAR_WEBHOOK_TOPIC: undefined })).toThrow()
    expect(() => loadConfig({ ...baseEnv, DISCORD_PUBLIC_KEY: undefined })).toThrow()
    expect(() => loadConfig({ ...baseEnv, ATLAS_BASE_URL: undefined, JANGAR_BASE_URL: undefined })).toThrow()
  })

  it('keeps Linear intake dormant without requiring Linear credentials', () => {
    const config = loadConfig({
      ...baseEnv,
      LINEAR_WEBHOOK_ENABLED: undefined,
      LINEAR_WEBHOOK_SECRET: undefined,
      KAFKA_LINEAR_WEBHOOK_TOPIC: undefined,
    })

    expect(config.linear.enabled).toBe(false)
    expect(config.linearWebhookSecret).toBe('')
    expect(config.kafka.topics.linearRaw).toBe('')
  })

  it('rejects an ambiguous Linear enablement value', () => {
    expect(() => loadConfig({ ...baseEnv, LINEAR_WEBHOOK_ENABLED: 'yes' })).toThrow(
      'LINEAR_WEBHOOK_ENABLED must be true or false',
    )
  })

  it('rejects a Linear Agents timeout that cannot meet the webhook deadline', () => {
    expect(() => loadConfig({ ...baseEnv, LINEAR_AGENTS_TIMEOUT_MS: '5000' })).toThrow(
      'LINEAR_AGENTS_TIMEOUT_MS must be a positive integer no greater than 4999',
    )
  })

  it('fails closed on invalid or unsafe Linear webhook limits', () => {
    expect(() => loadConfig({ ...baseEnv, LINEAR_MAX_BODY_BYTES: '1048577' })).toThrow(
      'LINEAR_MAX_BODY_BYTES must be a positive integer no greater than 1048576',
    )
    expect(() => loadConfig({ ...baseEnv, LINEAR_WEBHOOK_TOLERANCE_MS: '60001' })).toThrow(
      'LINEAR_WEBHOOK_TOLERANCE_MS must be a positive integer no greater than 60000',
    )
    expect(() => loadConfig({ ...baseEnv, LINEAR_AGENTS_TIMEOUT_MS: '3000ms' })).toThrow(
      'LINEAR_AGENTS_TIMEOUT_MS must be a positive integer no greater than 4999',
    )
    expect(() => loadConfig({ ...baseEnv, LINEAR_MAX_BODY_BYTES: '0' })).toThrow(
      'LINEAR_MAX_BODY_BYTES must be a positive integer no greater than 1048576',
    )
  })
})
