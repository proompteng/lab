import { describe, expect, it } from 'vitest'

import { loadConfig } from '@/config'

const baseEnv = {
  GITHUB_WEBHOOK_SECRET: 'secret',
  KAFKA_BROKERS: 'broker1:9092,broker2:9093',
  KAFKA_USERNAME: 'user',
  KAFKA_PASSWORD: 'pass',
  KAFKA_TOPIC: 'raw-topic',
  KAFKA_CODEX_TOPIC_STRUCTURED: 'github.issues.codex.tasks',
  KAFKA_CODEX_JUDGE_TOPIC: 'github.webhook.codex.judge',
  KAFKA_DISCORD_COMMAND_TOPIC: 'discord.commands.incoming',
  JANGAR_BASE_URL: 'http://jangar',
  DISCORD_PUBLIC_KEY: 'public-key',
}

describe('loadConfig', () => {
  it('parses brokers and returns defaults', () => {
    const config = loadConfig(baseEnv)

    expect(config.idempotency.ttlMs).toBe(10 * 60 * 1000)
    expect(config.idempotency.maxEntries).toBe(10_000)
    expect(config.kafka.brokers).toEqual(['broker1:9092', 'broker2:9093'])
    expect(config.kafka.topics.codexStructured).toBe('github.issues.codex.tasks')
    expect(config.kafka.topics.codexJudge).toBe('github.webhook.codex.judge')
    expect(config.codebase.baseBranch).toBe('main')
    expect(config.codebase.branchPrefix).toBe('codex/issue-')
    expect(config.codex.triggerLogins).toEqual(['gregkonush', 'tuslagch'])
    expect(config.codex.workflowLogin).toBe('github-actions[bot]')
    expect(config.codex.implementationTriggerPhrase).toBe('implement issue')
    expect(config.discord.publicKey).toBe('public-key')
    expect(config.discord.defaultResponse.ephemeral).toBe(true)
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
  })

  it('falls back to CODEX_TRIGGER_LOGIN when list env is absent', () => {
    const env = {
      ...baseEnv,
      CODEX_TRIGGER_LOGIN: 'ServiceUser',
    }

    const config = loadConfig(env)
    expect(config.codex.triggerLogins).toEqual(['serviceuser'])
  })

  it('throws when required env is missing', () => {
    expect(() => loadConfig({ ...baseEnv, KAFKA_BROKERS: '' })).toThrow()
    expect(() => loadConfig({ ...baseEnv, GITHUB_WEBHOOK_SECRET: undefined })).toThrow()
    expect(() => loadConfig({ ...baseEnv, KAFKA_CODEX_TOPIC_STRUCTURED: undefined })).toThrow()
    expect(() => loadConfig({ ...baseEnv, KAFKA_CODEX_JUDGE_TOPIC: undefined })).toThrow()
    expect(() => loadConfig({ ...baseEnv, KAFKA_DISCORD_COMMAND_TOPIC: undefined })).toThrow()
    expect(() => loadConfig({ ...baseEnv, DISCORD_PUBLIC_KEY: undefined })).toThrow()
    expect(() => loadConfig({ ...baseEnv, JANGAR_BASE_URL: undefined })).toThrow()
  })
})
