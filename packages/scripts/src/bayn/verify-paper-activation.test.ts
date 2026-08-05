import { describe, expect, test } from 'bun:test'

import {
  assemblePaperActivationRequest,
  extractPaperActivationManifestPins,
  renderPaperActivationRequestTransition,
  verifyPaperActivationRequest,
} from './verify-paper-activation'

const deploymentPath = new URL('../../../../argocd/applications/bayn/deployment.yaml', import.meta.url)
const kustomizationPath = new URL('../../../../argocd/applications/bayn/kustomization.yaml', import.meta.url)
const deployment = await Bun.file(deploymentPath).text()
const kustomization = await Bun.file(kustomizationPath).text()
const producerHeadSha = 'a'.repeat(40)
const terminalRunId = '1'.repeat(64)

const qualificationFixture = (researchDeployment: string): string => {
  const activationRequest = `            - name: BAYN_PAPER_ACTIVATION_REQUEST
              valueFrom:
                secretKeyRef:
                  name: bayn-alpaca-auth
                  key: paper-activation-request
`
  const qualificationRun = `            - name: BAYN_QUALIFICATION_RUN_ID
              value: "${terminalRunId}"
`
  if (!researchDeployment.includes(activationRequest)) throw new Error('research activation fixture is missing')
  return researchDeployment.replace(activationRequest, qualificationRun)
}

const qualifiedDeployment = qualificationFixture(deployment)
const manifestPins = extractPaperActivationManifestPins(qualifiedDeployment, kustomization)
const terminal = {
  schemaVersion: 'bayn.qualification-collector-terminal.v1',
  repository: 'proompteng/lab',
  currentMainSha: producerHeadSha,
  sourceSha: producerHeadSha,
  image: {
    repository: manifestPins.deploymentImageRepository,
    digest: manifestPins.deploymentImageDigest,
  },
  candidateOrdinal: 21,
  terminal: {
    schemaVersion: 'bayn.qualification-execution.v1',
    runId: terminalRunId,
    lockId: 'b'.repeat(64),
    resultHash: 'c'.repeat(64),
    verdict: 'QUALIFIED',
  },
  audit: {
    schemaVersion: 'bayn.qualification-audit.v2',
    contamination: { resultCommittedAt: '2026-08-02T07:00:00.000Z' },
  },
}

const requestResult = assemblePaperActivationRequest({
  terminal,
  manifestPins,
  repository: 'proompteng/lab',
  currentMainSha: manifestPins.sourceSha,
  producerHeadSha,
  now: '2026-08-02T07:30:00.000Z',
})

describe('Bayn PAPER activation request', () => {
  test('projects a qualified terminal into a canonical source-A to source-B request', () => {
    expect(requestResult._tag).toBe('Success')
    if (requestResult._tag === 'Failure') return
    const request = requestResult.value
    expect(request.qualification.sourceRevision).toBe(producerHeadSha)
    expect(request.activation.sourceRevision).toBe(manifestPins.sourceSha)
    expect(request.limits).toEqual({ maxOpenOrders: 0, maxPositions: 0 })
    expect(
      verifyPaperActivationRequest({
        request,
        manifestPins,
        repository: 'proompteng/lab',
        currentMainSha: manifestPins.sourceSha,
        producerHeadSha,
        now: '2026-08-02T07:30:00.000Z',
      }),
    ).toMatchObject({ status: 'verified' })
  })

  test('renders only the request and a rollback that restores OBSERVE', () => {
    expect(requestResult._tag).toBe('Success')
    if (requestResult._tag === 'Failure') return
    const rendered = renderPaperActivationRequestTransition(qualifiedDeployment, requestResult.value)
    expect(rendered.requestDeployment).toContain('BAYN_PAPER_ACTIVATION_REQUEST')
    expect(rendered.requestDeployment).toContain('value: OBSERVE')
    expect(rendered.requestDeployment).not.toContain('value: PAPER')
    expect(rendered.requestDeployment).not.toContain('value: mutation')
    expect(rendered.requestDeployment).not.toContain('value: sandbox-capital')
    expect(rendered.rollbackDeployment).toBe(qualifiedDeployment)
    expect(rendered.rollbackDeployment).not.toContain('BAYN_PAPER_ACTIVATION_REQUEST')
  })

  test('rejects REJECTED terminals before any request can be emitted', () => {
    const rejected = assemblePaperActivationRequest({
      terminal: { ...terminal, terminal: { ...terminal.terminal, verdict: 'REJECTED' } },
      manifestPins,
      repository: 'proompteng/lab',
      currentMainSha: manifestPins.sourceSha,
      producerHeadSha,
      now: '2026-08-02T07:30:00.000Z',
    })
    expect(rejected).toMatchObject({ _tag: 'Failure', code: 'qualification-not-qualified' })
  })

  test('fails closed for producer, source, image, run, and canonical-hash tampering', () => {
    expect(
      assemblePaperActivationRequest({
        terminal: { ...terminal, sourceSha: 'd'.repeat(40) },
        manifestPins,
        repository: 'proompteng/lab',
        currentMainSha: manifestPins.sourceSha,
        producerHeadSha,
        now: '2026-08-02T07:30:00.000Z',
      }),
    ).toMatchObject({ _tag: 'Failure', code: 'producer-head-mismatch' })
    expect(requestResult._tag).toBe('Success')
    if (requestResult._tag === 'Failure') return
    const request = requestResult.value
    expect(
      verifyPaperActivationRequest({
        request: { ...request, requestHash: 'f'.repeat(64) },
        manifestPins,
        repository: 'proompteng/lab',
        currentMainSha: manifestPins.sourceSha,
        producerHeadSha,
        now: '2026-08-02T07:30:00.000Z',
      }),
    ).toMatchObject({ status: 'hold', code: 'request-hash' })
    expect(
      verifyPaperActivationRequest({
        request,
        manifestPins: { ...manifestPins, deploymentImageDigest: `sha256:${'e'.repeat(64)}` },
        repository: 'proompteng/lab',
        currentMainSha: manifestPins.sourceSha,
        producerHeadSha,
        now: '2026-08-02T07:30:00.000Z',
      }),
    ).toMatchObject({ status: 'hold', code: 'image-binding-mismatch' })
  })

  test('accepts rendered Kubernetes tag plus digest image references', () => {
    const renderedImage = qualifiedDeployment.replace(
      `image: ${manifestPins.deploymentImageRepository}\n`,
      `image: ${manifestPins.deploymentImageRepository}:sha-${manifestPins.sourceSha}@${manifestPins.deploymentImageDigest}\n`,
    )
    expect(extractPaperActivationManifestPins(renderedImage, kustomization)).toEqual(manifestPins)
  })

  test('does not mistake a sealed research grant for qualification evidence', () => {
    expect(() => extractPaperActivationManifestPins(deployment, kustomization)).toThrow(
      'deployment must contain exactly one BAYN_QUALIFICATION_RUN_ID value',
    )
    expect(deployment).toContain('key: paper-activation-request')
    expect(deployment).not.toContain('BAYN_QUALIFICATION_RUN_ID')
  })
})
