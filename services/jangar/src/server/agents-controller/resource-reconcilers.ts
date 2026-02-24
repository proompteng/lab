import { asRecord, asString, readNested } from '~/server/primitives-http'

import { normalizeConditions, upsertCondition } from './conditions'

type KubeClient = {
  get: (kind: string, name: string, namespace: string) => Promise<Record<string, unknown> | null>
}

type ConditionWarning = {
  reason: string
  message: string
}

type VcsAuthValidation = {
  ok: boolean
  reason?: string
  message?: string
  warnings?: ConditionWarning[]
}

export const createResourceReconcilers = (deps: {
  setStatus: (kube: unknown, resource: Record<string, unknown>, status: Record<string, unknown>) => Promise<void>
  nowIso: () => string
  implementationTextLimit: number
  resolveVcsAuthMethod: (auth: Record<string, unknown>) => string
  validateVcsAuthConfig: (providerType: string, auth: Record<string, unknown>) => VcsAuthValidation
  parseIntOrString: (value: unknown) => string | null
  secretHasKey: (secret: Record<string, unknown>, key: string) => boolean
}) => {
  const buildConditions = (resource: Record<string, unknown>) =>
    normalizeConditions(readNested(resource, ['status', 'conditions']))

  const reconcileAgent = async (
    kube: unknown,
    agent: Record<string, unknown>,
    namespace: string,
    providers: Record<string, unknown>[],
    memories: Record<string, unknown>[],
  ) => {
    const conditions = buildConditions(agent)
    const providerName = asString(readNested(agent, ['spec', 'providerRef', 'name']))
    let updated = conditions

    if (!providerName) {
      updated = upsertCondition(updated, {
        type: 'InvalidSpec',
        status: 'True',
        reason: 'MissingProviderRef',
        message: 'spec.providerRef.name is required',
      })
    } else {
      const provider = providers.find((item) => asString(readNested(item, ['metadata', 'name'])) === providerName)
      if (!provider) {
        updated = upsertCondition(updated, {
          type: 'InvalidSpec',
          status: 'True',
          reason: 'MissingProvider',
          message: `agent provider ${providerName} not found`,
        })
      } else {
        updated = upsertCondition(updated, { type: 'Ready', status: 'True', reason: 'ValidSpec' })
      }
    }

    const memoryRef = asString(readNested(agent, ['spec', 'memoryRef', 'name']))
    if (memoryRef) {
      const memory = memories.find((item) => asString(readNested(item, ['metadata', 'name'])) === memoryRef)
      if (!memory) {
        updated = upsertCondition(updated, {
          type: 'InvalidSpec',
          status: 'True',
          reason: 'MissingMemory',
          message: `memory ${memoryRef} not found in ${namespace}`,
        })
      }
    }

    await deps.setStatus(kube, agent, {
      observedGeneration: asRecord(agent.metadata)?.generation ?? 0,
      conditions: updated,
    })
  }

  const reconcileAgentProvider = async (kube: unknown, provider: Record<string, unknown>) => {
    const spec = asRecord(provider.spec) ?? {}
    const conditions = buildConditions(provider)
    const binary = asString(spec.binary)
    let updated = conditions
    if (!binary) {
      updated = upsertCondition(updated, {
        type: 'InvalidSpec',
        status: 'True',
        reason: 'MissingBinary',
        message: 'spec.binary is required',
      })
    } else {
      updated = upsertCondition(updated, { type: 'Ready', status: 'True', reason: 'ValidSpec' })
    }
    await deps.setStatus(kube, provider, {
      observedGeneration: asRecord(provider.metadata)?.generation ?? 0,
      conditions: updated,
    })
  }

  const reconcileImplementationSpec = async (kube: unknown, impl: Record<string, unknown>) => {
    const spec = asRecord(impl.spec) ?? {}
    const conditions = buildConditions(impl)
    const text = asString(spec.text) ?? ''
    const summary = asString(spec.summary) ?? ''
    const description = asString(spec.description) ?? ''
    const acceptanceCriteria = Array.isArray(spec.acceptanceCriteria) ? spec.acceptanceCriteria : []
    const contract = asRecord(spec.contract) ?? {}
    const requiredKeys = Array.isArray(contract.requiredKeys) ? contract.requiredKeys : []
    const mappings = Array.isArray(contract.mappings) ? contract.mappings : []
    let updated = conditions
    if (!text) {
      updated = upsertCondition(updated, {
        type: 'InvalidSpec',
        status: 'True',
        reason: 'MissingText',
        message: 'spec.text is required',
      })
    } else if (text.length > 131072) {
      updated = upsertCondition(updated, {
        type: 'InvalidSpec',
        status: 'True',
        reason: 'TextTooLarge',
        message: 'spec.text exceeds 128KB',
      })
    } else if (summary && summary.length > 256) {
      updated = upsertCondition(updated, {
        type: 'InvalidSpec',
        status: 'True',
        reason: 'SummaryTooLong',
        message: 'spec.summary exceeds 256 characters',
      })
    } else if (description && description.length > deps.implementationTextLimit) {
      updated = upsertCondition(updated, {
        type: 'InvalidSpec',
        status: 'True',
        reason: 'DescriptionTooLarge',
        message: 'spec.description exceeds 128KB',
      })
    } else if (acceptanceCriteria.length > 50) {
      updated = upsertCondition(updated, {
        type: 'InvalidSpec',
        status: 'True',
        reason: 'AcceptanceCriteriaTooLong',
        message: 'spec.acceptanceCriteria exceeds 50 entries',
      })
    } else if (requiredKeys.some((key) => typeof key !== 'string' || key.trim().length === 0)) {
      updated = upsertCondition(updated, {
        type: 'InvalidSpec',
        status: 'True',
        reason: 'InvalidContract',
        message: 'spec.contract.requiredKeys must be non-empty strings',
      })
    } else if (
      mappings.some((entry) => {
        const record = asRecord(entry)
        if (!record) return true
        const from = asString(record.from)?.trim()
        const to = asString(record.to)?.trim()
        return !from || !to
      })
    ) {
      updated = upsertCondition(updated, {
        type: 'InvalidSpec',
        status: 'True',
        reason: 'InvalidContract',
        message: 'spec.contract.mappings entries must include non-empty from and to',
      })
    } else {
      updated = upsertCondition(updated, { type: 'Ready', status: 'True', reason: 'ValidSpec' })
    }

    await deps.setStatus(kube, impl, {
      observedGeneration: asRecord(impl.metadata)?.generation ?? 0,
      syncedAt: asString(readNested(impl, ['status', 'syncedAt'])) ?? deps.nowIso(),
      sourceVersion: asString(readNested(impl, ['status', 'sourceVersion'])) ?? undefined,
      conditions: updated,
    })
  }

  const reconcileImplementationSource = async (
    kube: KubeClient,
    source: Record<string, unknown>,
    namespace: string,
  ) => {
    const conditions = buildConditions(source)
    const provider = asString(readNested(source, ['spec', 'provider']))
    const secretRef = asRecord(readNested(source, ['spec', 'auth', 'secretRef']))
    const secretName = asString(secretRef?.name)
    const secretKey = asString(secretRef?.key) ?? 'token'
    const webhookEnabled = readNested(source, ['spec', 'webhook', 'enabled']) === true
    let updated = conditions

    if (!provider) {
      updated = upsertCondition(updated, {
        type: 'InvalidSpec',
        status: 'True',
        reason: 'MissingProvider',
        message: 'spec.provider is required',
      })
    } else if (provider !== 'github' && provider !== 'linear') {
      updated = upsertCondition(updated, {
        type: 'InvalidSpec',
        status: 'True',
        reason: 'UnsupportedProvider',
        message: `unsupported provider ${provider}`,
      })
    } else if (!secretName) {
      updated = upsertCondition(updated, {
        type: 'InvalidSpec',
        status: 'True',
        reason: 'MissingSecretRef',
        message: 'spec.auth.secretRef.name is required',
      })
    } else if (!webhookEnabled) {
      updated = upsertCondition(updated, {
        type: 'Ready',
        status: 'False',
        reason: 'WebhookDisabled',
        message: 'spec.webhook.enabled must be true for webhook-only ingestion',
      })
    } else {
      const secret = await kube.get('secret', secretName, namespace)
      if (!secret) {
        updated = upsertCondition(updated, {
          type: 'Unreachable',
          status: 'True',
          reason: 'SecretNotFound',
          message: `secret ${secretName} not found`,
        })
      } else {
        const data = asRecord(secret.data) ?? {}
        const stringData = asRecord(secret.stringData) ?? {}
        if (secretKey && !(secretKey in data) && !(secretKey in stringData)) {
          updated = upsertCondition(updated, {
            type: 'InvalidSpec',
            status: 'True',
            reason: 'SecretKeyMissing',
            message: `secret ${secretName} missing key ${secretKey}`,
          })
        } else {
          updated = upsertCondition(updated, { type: 'Ready', status: 'True', reason: 'WebhookReady' })
        }
      }
    }

    await deps.setStatus(kube, source, {
      observedGeneration: asRecord(source.metadata)?.generation ?? 0,
      lastSyncedAt: asString(readNested(source, ['status', 'lastSyncedAt'])) ?? undefined,
      conditions: updated,
    })
  }

  const reconcileVersionControlProvider = async (
    kube: KubeClient,
    provider: Record<string, unknown>,
    namespace: string,
  ) => {
    const conditions = buildConditions(provider)
    const spec = asRecord(provider.spec) ?? {}
    const providerType = asString(spec.provider)
    const auth = asRecord(spec.auth) ?? {}
    const method = deps.resolveVcsAuthMethod(auth)
    let updated = conditions
    const warnings: ConditionWarning[] = []
    const markHealthy = () => {
      updated = upsertCondition(updated, { type: 'InvalidSpec', status: 'False', reason: 'Reconciled' })
      updated = upsertCondition(updated, { type: 'Unreachable', status: 'False', reason: 'Reconciled' })
    }

    if (!providerType) {
      updated = upsertCondition(updated, {
        type: 'InvalidSpec',
        status: 'True',
        reason: 'MissingProvider',
        message: 'spec.provider is required',
      })
    } else if (!['github', 'gitlab', 'bitbucket', 'gitea', 'generic'].includes(providerType)) {
      updated = upsertCondition(updated, {
        type: 'InvalidSpec',
        status: 'True',
        reason: 'UnsupportedProvider',
        message: `unsupported provider ${providerType}`,
      })
    } else {
      const authValidation = deps.validateVcsAuthConfig(providerType, auth)
      if (!authValidation.ok) {
        updated = upsertCondition(updated, {
          type: 'InvalidSpec',
          status: 'True',
          reason: authValidation.reason,
          message: authValidation.message,
        })
      } else {
        warnings.push(...(authValidation.warnings ?? []))
        if (method === 'token') {
          const tokenRef = asRecord(readNested(auth, ['token', 'secretRef'])) ?? {}
          const secretName = asString(tokenRef.name)
          const secretKey = asString(tokenRef.key) ?? 'token'
          if (!secretName) {
            updated = upsertCondition(updated, {
              type: 'InvalidSpec',
              status: 'True',
              reason: 'MissingSecretRef',
              message: 'spec.auth.token.secretRef.name is required',
            })
          } else {
            const secret = await kube.get('secret', secretName, namespace)
            if (!secret) {
              updated = upsertCondition(updated, {
                type: 'Unreachable',
                status: 'True',
                reason: 'SecretNotFound',
                message: `secret ${secretName} not found`,
              })
            } else if (!deps.secretHasKey(secret, secretKey)) {
              updated = upsertCondition(updated, {
                type: 'InvalidSpec',
                status: 'True',
                reason: 'SecretKeyMissing',
                message: `secret ${secretName} missing key ${secretKey}`,
              })
            } else {
              updated = upsertCondition(updated, { type: 'Ready', status: 'True', reason: 'AuthReady' })
              markHealthy()
            }
          }
        } else if (method === 'app') {
          const appSpec = asRecord(readNested(auth, ['app'])) ?? {}
          const appId = deps.parseIntOrString(appSpec.appId)
          const installationId = deps.parseIntOrString(appSpec.installationId)
          const secretRef = asRecord(appSpec.privateKeySecretRef) ?? {}
          const secretName = asString(secretRef.name)
          const secretKey = asString(secretRef.key) ?? 'privateKey'
          if (!appId || !installationId || !secretName) {
            updated = upsertCondition(updated, {
              type: 'InvalidSpec',
              status: 'True',
              reason: 'MissingAppAuth',
              message: 'spec.auth.app.appId, installationId, and privateKeySecretRef.name are required',
            })
          } else {
            const secret = await kube.get('secret', secretName, namespace)
            if (!secret) {
              updated = upsertCondition(updated, {
                type: 'Unreachable',
                status: 'True',
                reason: 'SecretNotFound',
                message: `secret ${secretName} not found`,
              })
            } else if (!deps.secretHasKey(secret, secretKey)) {
              updated = upsertCondition(updated, {
                type: 'InvalidSpec',
                status: 'True',
                reason: 'SecretKeyMissing',
                message: `secret ${secretName} missing key ${secretKey}`,
              })
            } else {
              updated = upsertCondition(updated, { type: 'Ready', status: 'True', reason: 'AuthReady' })
              markHealthy()
            }
          }
        } else if (method === 'ssh') {
          const sshSpec = asRecord(readNested(auth, ['ssh'])) ?? {}
          const secretRef = asRecord(sshSpec.privateKeySecretRef) ?? {}
          const secretName = asString(secretRef.name)
          const secretKey = asString(secretRef.key) ?? 'privateKey'
          const knownHostsRef = asRecord(sshSpec.knownHostsConfigMapRef) ?? {}
          const knownHostsName = asString(knownHostsRef.name)
          const knownHostsKey = asString(knownHostsRef.key) ?? 'known_hosts'
          if (!secretName) {
            updated = upsertCondition(updated, {
              type: 'InvalidSpec',
              status: 'True',
              reason: 'MissingSecretRef',
              message: 'spec.auth.ssh.privateKeySecretRef.name is required',
            })
          } else {
            const secret = await kube.get('secret', secretName, namespace)
            if (!secret) {
              updated = upsertCondition(updated, {
                type: 'Unreachable',
                status: 'True',
                reason: 'SecretNotFound',
                message: `secret ${secretName} not found`,
              })
            } else if (!deps.secretHasKey(secret, secretKey)) {
              updated = upsertCondition(updated, {
                type: 'InvalidSpec',
                status: 'True',
                reason: 'SecretKeyMissing',
                message: `secret ${secretName} missing key ${secretKey}`,
              })
            } else {
              updated = upsertCondition(updated, { type: 'Ready', status: 'True', reason: 'AuthReady' })
              markHealthy()
            }
          }
          if (knownHostsName) {
            const configMap = await kube.get('configmap', knownHostsName, namespace)
            if (!configMap) {
              updated = upsertCondition(updated, {
                type: 'Unreachable',
                status: 'True',
                reason: 'ConfigMapNotFound',
                message: `configmap ${knownHostsName} not found`,
              })
            } else if (knownHostsKey) {
              const data = asRecord(configMap.data) ?? {}
              if (!(knownHostsKey in data)) {
                updated = upsertCondition(updated, {
                  type: 'InvalidSpec',
                  status: 'True',
                  reason: 'ConfigMapKeyMissing',
                  message: `configmap ${knownHostsName} missing key ${knownHostsKey}`,
                })
              }
            }
          }
        } else if (method === 'none') {
          updated = upsertCondition(updated, { type: 'Ready', status: 'True', reason: 'NoAuth' })
          markHealthy()
        } else {
          updated = upsertCondition(updated, {
            type: 'InvalidSpec',
            status: 'True',
            reason: 'UnsupportedAuth',
            message: `unsupported auth method ${method}`,
          })
        }
      }
    }

    if (warnings.length > 0) {
      updated = upsertCondition(updated, {
        type: 'Warning',
        status: 'True',
        reason: warnings[0]?.reason ?? 'Warning',
        message: warnings.map((warning) => warning.message).join('; '),
      })
    } else {
      updated = upsertCondition(updated, { type: 'Warning', status: 'False', reason: 'None', message: '' })
    }

    await deps.setStatus(kube, provider, {
      observedGeneration: asRecord(provider.metadata)?.generation ?? 0,
      lastValidatedAt: deps.nowIso(),
      conditions: updated,
    })
  }

  const reconcileMemory = async (kube: KubeClient, memory: Record<string, unknown>, namespace: string) => {
    const conditions = buildConditions(memory)
    const memoryType = asString(readNested(memory, ['spec', 'type']))
    const secretName = asString(readNested(memory, ['spec', 'connection', 'secretRef', 'name']))
    const secretKey = asString(readNested(memory, ['spec', 'connection', 'secretRef', 'key']))
    let updated = conditions
    if (!memoryType) {
      updated = upsertCondition(updated, {
        type: 'InvalidSpec',
        status: 'True',
        reason: 'MissingType',
        message: 'spec.type is required',
      })
    } else if (!secretName) {
      updated = upsertCondition(updated, {
        type: 'InvalidSpec',
        status: 'True',
        reason: 'MissingSecretRef',
        message: 'spec.connection.secretRef.name is required',
      })
    } else {
      const secret = await kube.get('secret', secretName, namespace)
      if (!secret) {
        updated = upsertCondition(updated, {
          type: 'Unreachable',
          status: 'True',
          reason: 'SecretNotFound',
          message: `secret ${secretName} not found`,
        })
      } else if (secretKey) {
        const data = asRecord(secret.data) ?? {}
        const stringData = asRecord(secret.stringData) ?? {}
        if (!(secretKey in data) && !(secretKey in stringData)) {
          updated = upsertCondition(updated, {
            type: 'InvalidSpec',
            status: 'True',
            reason: 'SecretKeyMissing',
            message: `secret ${secretName} missing key ${secretKey}`,
          })
        } else {
          updated = upsertCondition(updated, { type: 'Ready', status: 'True', reason: 'SecretResolved' })
        }
      } else {
        updated = upsertCondition(updated, { type: 'Ready', status: 'True', reason: 'SecretResolved' })
      }
    }
    await deps.setStatus(kube, memory, {
      observedGeneration: asRecord(memory.metadata)?.generation ?? 0,
      lastCheckedAt: deps.nowIso(),
      conditions: updated,
    })
  }

  return {
    reconcileAgent,
    reconcileAgentProvider,
    reconcileImplementationSpec,
    reconcileImplementationSource,
    reconcileVersionControlProvider,
    reconcileMemory,
  }
}
