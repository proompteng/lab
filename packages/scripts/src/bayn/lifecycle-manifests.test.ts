import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import {
  advanceBaynLifecycleManifests,
  baynLifecycleIsActive,
  parseBaynLifecycleCurrent,
  parseBaynLifecyclePrevious,
  renderBaynLifecycleCurrent,
  renderBaynLifecyclePrevious,
  validateBaynLifecycleActivation,
  validateBaynLifecyclePromotion,
  validateBaynLifecycleCommandAuthentication,
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
    expect(current).toContain('name: BAYN_OPERATION_TIMEOUT_MS')
    expect(current.match(/enableServiceLinks: false/g)).toHaveLength(2)
    expect(current).not.toContain('secretKeyRef:')
    expect(current).not.toContain('BAYN_ALPACA_')
    expect(current).not.toContain('DATABASE_URL')
  })

  test('keeps the checked-in initial Restate endpoint canonical and atomically active', () => {
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

    expect(parseBaynLifecycleCurrent(current)).toEqual({
      sourceSha: 'f024ca5775cde0310175e8551cdbaf84def2e238',
      tag: 'sha-f024ca5775cde0310175e8551cdbaf84def2e238',
      digest: 'sha256:82b47bf00fc404d88524c6c2ae36737c8eb35a2184bef4ee872f0dbf8738ad98',
    })
    expect(parseBaynLifecyclePrevious(previous)).toEqual({
      sourceSha: 'c20d5ebb8bb43c04ff93bd8887846133f9d12738',
      tag: 'sha-c20d5ebb8bb43c04ff93bd8887846133f9d12738',
      digest: 'sha256:6972179b63adf43d545e134ad475188b99ab20a4261aa61fd21ec42434fd9d5d',
    })
    expect(baynLifecycleIsActive(kustomization)).toBeTrue()
    expect(() => validateBaynLifecycleCommandPort(deployment)).not.toThrow()
    expect(() => validateBaynServiceLinksDisabled(deployment)).not.toThrow()
    expect(() => validateBaynLifecycleCommandAuthentication(deployment)).not.toThrow()
    expect(() => validateBaynLifecycleOperationTimeout(deployment)).not.toThrow()
    expect(() => validateBaynLifecycleActivation(deployment, kustomization)).not.toThrow()
    expect(() =>
      validateBaynLifecycleCommandPort(
        deployment.replace(
          `            - name: lifecycle-cmd\n              containerPort: 8081\n              protocol: TCP\n`,
          '',
        ),
      ),
    ).toThrow('Bayn deployment must expose exactly one lifecycle-cmd container port on TCP 8081')
    expect(() =>
      validateBaynLifecycleCommandPort(deployment.replace('name: lifecycle-cmd', 'name: lifecycle-command')),
    ).toThrow('Bayn deployment must expose exactly one lifecycle-cmd container port on TCP 8081')
    expect(() => validateBaynServiceLinksDisabled(deployment.replace('      enableServiceLinks: false\n', ''))).toThrow(
      'Bayn deployment must disable Kubernetes service-link environment injection',
    )
    expect(() =>
      validateBaynLifecycleCommandAuthentication(
        deployment.replace(
          `            - name: bayn-lifecycle-reviewer\n              mountPath: /var/run/secrets/bayn-lifecycle-reviewer\n              readOnly: true\n`,
          '',
        ),
      ),
    ).toThrow('Bayn deployment must mount exactly one read-only lifecycle TokenReview identity')
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
    const restateOwnedDeployment = readFileSync(
      new URL('../../../../argocd/applications/bayn/deployment.yaml', import.meta.url),
      'utf8',
    )
    const processOwnedDeployment = restateOwnedDeployment.replace(
      '            - name: BAYN_LIFECYCLE_OWNER\n              value: RESTATE\n',
      '',
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
