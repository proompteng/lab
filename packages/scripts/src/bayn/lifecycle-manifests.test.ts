import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import YAML from 'yaml'

import {
  advanceBaynLifecycleManifests,
  baynLifecycleOtlpTracesEndpoint,
  baynLifecycleRegistrationActiveDeadlineSeconds,
  baynLifecycleIsActive,
  parseBaynLifecycleCurrent,
  parseBaynLifecyclePrevious,
  renderBaynLifecycleCurrent,
  renderBaynLifecyclePrevious,
  validateBaynLifecycleActivation,
  validateBaynLifecyclePromotion,
  validateBaynLifecycleCommandPort,
  validateBaynLifecycleOperationTimeout,
  validateBaynServiceLinksDisabled,
  type BaynLifecycleImagePin,
} from './lifecycle-manifests'

const pin = (character: string): BaynLifecycleImagePin => {
  const sourceSha = character.repeat(40)
  return {
    sourceSha,
    tag: `sha-${sourceSha}`,
    digest: `sha256:${character.repeat(64)}`,
  }
}

const inactiveKustomization = 'resources:\n  - deployment.yaml\n'
const activeKustomization = `${inactiveKustomization}  - lifecycle-current.yaml\n  - lifecycle-previous.yaml\n`
const occurrences = (source: string, value: string): number => source.split(value).length - 1

describe('Bayn lifecycle release manifests', () => {
  test('renders canonical source-versioned current and empty previous endpoints', () => {
    const current = renderBaynLifecycleCurrent(pin('a'))

    expect(parseBaynLifecycleCurrent(current)).toEqual(pin('a'))
    expect(parseBaynLifecyclePrevious(renderBaynLifecyclePrevious(null))).toBeNull()
    expect(current).toContain('name: bayn-lifecycle-aaaaaaaaaaaa')
    expect(current).toContain(`image: registry.ide-newton.ts.net/lab/bayn:${pin('a').tag}@${pin('a').digest}`)
    expect(current).toContain('argocd.argoproj.io/hook: Sync')
    expect(current).not.toContain('argocd.argoproj.io/hook: PostSync')
    expect(current).toContain('name: bayn-lifecycle-command')
    expect(current).toContain('name: bayn-lifecycle-worker')
    expect(current).toContain('name: bayn-lifecycle-register')
    expect(current).toContain('serviceAccountName: bayn-lifecycle')
    expect(current).toContain('audience: bayn.proompteng.ai/lifecycle-command')
    expect(current).toContain('name: bayn-lifecycle-token-reviewer')
    expect(current).toContain('- tokenreviews')
    expect(current).toContain('cidr: 10.96.0.1/32')
    expect(current.match(/name: BAYN_OPERATION_TIMEOUT_MS/g)).toHaveLength(2)
    expect(occurrences(current, baynLifecycleOtlpTracesEndpoint)).toBe(2)
    expect(current.match(/name: POD_NAMESPACE/g)).toHaveLength(2)
    expect(current.match(/kubernetes\.io\/metadata\.name: observability/g)).toHaveLength(2)
    expect(current.match(/app\.kubernetes\.io\/component: distributor/g)).toHaveLength(2)
    expect(current.match(/port: 4318/g)).toHaveLength(2)
    expect(current).toContain(`activeDeadlineSeconds: ${baynLifecycleRegistrationActiveDeadlineSeconds.toString()}`)
    expect(current.match(/enableServiceLinks: false/g)).toHaveLength(2)
    expect(current).not.toContain('secretKeyRef:')
    expect(current).not.toContain('BAYN_ALPACA_')
    expect(current).not.toContain('DATABASE_URL')

    const previous = renderBaynLifecyclePrevious(pin('a'))
    expect(occurrences(previous, baynLifecycleOtlpTracesEndpoint)).toBe(1)
    expect(previous.match(/name: POD_NAMESPACE/g)).toHaveLength(1)
  })

  test('keeps the retired Restate endpoints canonical but inactive', () => {
    const current = readFileSync(
      new URL('../../../../argocd/applications/bayn/lifecycle-current.yaml', import.meta.url),
      'utf8',
    )
    const previous = readFileSync(
      new URL('../../../../argocd/applications/bayn/lifecycle-previous.yaml', import.meta.url),
      'utf8',
    )
    const kustomization = readFileSync(
      new URL('../../../../argocd/applications/bayn/kustomization.yaml', import.meta.url),
      'utf8',
    )
    const deployment = readFileSync(
      new URL('../../../../argocd/applications/bayn/deployment.yaml', import.meta.url),
      'utf8',
    )
    const restateNetworkPolicy = readFileSync(
      new URL('../../../../argocd/applications/restate/networkpolicy.yaml', import.meta.url),
      'utf8',
    )
    const readme = readFileSync(new URL('../../../../argocd/applications/bayn/README.md', import.meta.url), 'utf8')
    const cleanupManifest = new URL(
      '../../../../argocd/applications/bayn/restate-registration-cleanup.yaml',
      import.meta.url,
    )
    const hookGc = YAML.parseAllDocuments(
      readFileSync(
        new URL('../../../../argocd/applications/bayn/restate-retirement-hook-gc.yaml', import.meta.url),
        'utf8',
      ),
    ).map((document) => document.toJSON() as Record<string, any>)
    const hookGcNetworkPolicy = hookGc.find((document) => document.kind === 'NetworkPolicy')!
    const hookGcJob = hookGc.find((document) => document.kind === 'Job')!
    const hookGcContainer = hookGcJob.spec.template.spec.containers[0]

    expect(parseBaynLifecycleCurrent(current)).toEqual({
      sourceSha: '2e6a1cbf1dce6737f6c96e25c097d214366af48d',
      tag: 'sha-2e6a1cbf1dce6737f6c96e25c097d214366af48d',
      digest: 'sha256:ebe9ffea6582ae356b2ea870da1873ef74f46d064d60ca58b3fd8e27f535d3a3',
    })
    expect(parseBaynLifecyclePrevious(previous)).toEqual({
      sourceSha: 'bf16e466d98825d889a71675bcc8ba9458ab12b6',
      tag: 'sha-bf16e466d98825d889a71675bcc8ba9458ab12b6',
      digest: 'sha256:a0b49f9c5a7a1ee7011dca5fa3ee8799d36924f4ec3e131397d108a1ddf35908',
    })
    expect(baynLifecycleIsActive(kustomization)).toBeFalse()
    expect(kustomization).not.toContain('restate-registration-cleanup.yaml')
    expect(existsSync(cleanupManifest)).toBeFalse()
    expect(restateNetworkPolicy).not.toContain('app.kubernetes.io/name: bayn-lifecycle-register')
    expect(kustomization).toContain('restate-retirement-hook-gc.yaml')
    expect(hookGcNetworkPolicy.spec).toEqual({
      podSelector: { matchLabels: { 'app.kubernetes.io/name': 'bayn-retirement-hook-gc' } },
      policyTypes: ['Ingress', 'Egress'],
      ingress: [],
      egress: [],
    })
    expect(hookGcJob.metadata.name).toBe('bayn-restate-registration-final-retirement')
    expect(hookGcJob.metadata.annotations).toEqual({
      'argocd.argoproj.io/hook': 'PostSync',
      'argocd.argoproj.io/hook-delete-policy': 'BeforeHookCreation,HookSucceeded',
      'argocd.argoproj.io/sync-wave': '2',
    })
    expect(hookGcJob.spec.backoffLimit).toBe(0)
    expect(hookGcJob.spec.template.spec).toMatchObject({
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      restartPolicy: 'Never',
    })
    expect(hookGcContainer.image).toBe(
      'docker.restate.dev/restatedev/restate-cli:1.7.2@sha256:6905cd107840658f8ef0338c95e3c691dba3da450e9e0fb12066d00fd57e69f9',
    )
    expect(hookGcContainer.command).toEqual(['/bin/sh', '-eu', '-c'])
    expect(hookGcContainer.args).toEqual(['exit 0'])
    expect(hookGcContainer.env).toBeUndefined()
    expect(readme).toContain(
      'The legacy `BaynLifecycle`/`BaynLifecycleBootstrap` Restate registration set is fully retired.',
    )
    expect(() => validateBaynLifecycleCommandPort(deployment)).toThrow(
      'Bayn deployment must expose exactly one lifecycle-cmd container port on TCP 8081',
    )
    expect(() => validateBaynServiceLinksDisabled(deployment)).not.toThrow()
    expect(() => validateBaynLifecycleOperationTimeout(deployment)).not.toThrow()
    expect(() => validateBaynLifecycleActivation(deployment, kustomization)).not.toThrow()
    expect(() => validateBaynServiceLinksDisabled(deployment.replace('      enableServiceLinks: false\n', ''))).toThrow(
      'Bayn deployment must disable Kubernetes service-link environment injection',
    )
    expect(() =>
      validateBaynLifecycleOperationTimeout(
        deployment.replace(
          `            - name: BAYN_OPERATION_TIMEOUT_MS\n              value: "30000"\n`,
          `            - name: BAYN_OPERATION_TIMEOUT_MS\n              value: "60000"\n`,
        ),
      ),
    ).toThrow('Bayn and Restate lifecycle must share BAYN_OPERATION_TIMEOUT_MS=30000')
  })

  test('switches lifecycle resources and ownership as one activation boundary', () => {
    const processOwnedDeployment = readFileSync(
      new URL('../../../../argocd/applications/bayn/deployment.yaml', import.meta.url),
      'utf8',
    )
    const restateOwnedDeployment = processOwnedDeployment.replace(
      '            - name: BAYN_CODE_REVISION\n',
      '            - name: BAYN_LIFECYCLE_OWNER\n              value: RESTATE\n            - name: BAYN_CODE_REVISION\n',
    )

    expect(() => validateBaynLifecycleActivation(processOwnedDeployment, activeKustomization)).toThrow(
      'active Bayn lifecycle resources require BAYN_LIFECYCLE_OWNER=RESTATE',
    )
    expect(() => validateBaynLifecycleActivation(restateOwnedDeployment, inactiveKustomization)).toThrow(
      'BAYN_LIFECYCLE_OWNER=RESTATE requires active Bayn lifecycle resources',
    )
    expect(() => validateBaynLifecycleActivation(restateOwnedDeployment, activeKustomization)).not.toThrow()
  })

  test('updates only the dormant current endpoint before activation', () => {
    const base = {
      current: renderBaynLifecycleCurrent(pin('a')),
      previous: renderBaynLifecyclePrevious(null),
    }

    expect(advanceBaynLifecycleManifests({ base, kustomization: inactiveKustomization, next: pin('b') })).toEqual({
      current: renderBaynLifecycleCurrent(pin('b')),
      previous: renderBaynLifecyclePrevious(null),
    })
  })

  test('retains exactly one prior immutable endpoint after activation', () => {
    const base = {
      current: renderBaynLifecycleCurrent(pin('b')),
      previous: renderBaynLifecyclePrevious(pin('a')),
    }
    const head = advanceBaynLifecycleManifests({ base, kustomization: activeKustomization, next: pin('c') })

    expect(parseBaynLifecycleCurrent(head.current)).toEqual(pin('c'))
    expect(parseBaynLifecyclePrevious(head.previous)).toEqual(pin('b'))
    expect(validateBaynLifecyclePromotion({ base, head, baseKustomization: activeKustomization, next: pin('c') })).toBe(
      null,
    )
  })

  test('rejects partial activation and noncanonical endpoint changes', () => {
    expect(() => baynLifecycleIsActive('resources:\n  - lifecycle-current.yaml\n')).toThrow(
      'current and previous resources must be activated together',
    )
    expect(() => parseBaynLifecycleCurrent(`${renderBaynLifecycleCurrent(pin('a'))}# unexpected\n`)).toThrow(
      'not canonical',
    )
  })
})
