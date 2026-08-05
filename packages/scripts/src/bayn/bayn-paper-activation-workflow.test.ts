import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import { parse } from 'yaml'

import {
  assemblePaperActivationRequest,
  extractPaperActivationManifestPins,
  renderPaperActivationRequestTransition,
  verifyPaperActivationRequest,
} from './verify-paper-activation'

const workflow = readFileSync(
  new URL('../../../../.github/workflows/bayn-paper-activation.yml', import.meta.url),
  'utf8',
)
const qualificationWorkflow = readFileSync(
  new URL('../../../../.github/workflows/bayn-qualification.yml', import.meta.url),
  'utf8',
)
const parsed = parse(workflow) as Record<string, any>
const qualificationParsed = parse(qualificationWorkflow) as Record<string, any>
const deployment = readFileSync(
  new URL('../../../../argocd/applications/bayn/deployment.yaml', import.meta.url),
  'utf8',
)
const kustomization = readFileSync(
  new URL('../../../../argocd/applications/bayn/kustomization.yaml', import.meta.url),
  'utf8',
)
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

describe('Bayn paper activation workflow contract', () => {
  test('reacts only to completed scheduled qualification and has no pod control channel', () => {
    expect(Object.keys(parsed.on)).toEqual(['workflow_run'])
    expect(parsed.on.workflow_run).toEqual({
      workflows: ['bayn-qualification'],
      types: ['completed'],
      branches: ['main'],
    })
    expect(Object.keys(parsed.jobs)).toEqual(['verify-and-propose'])
    expect(workflow).not.toMatch(/kubectl\s+(exec|-n)/)
    expect(workflow).not.toContain('curl ')
    expect(workflow).not.toContain('activate-and-observe')
    expect(workflow).not.toContain('rollback-watchdog')
    expect(workflow).toContain('--mode assemble-request')
    expect(workflow).toContain('--mode verify-request')
    expect(workflow).toContain('--mode render-request-transition')
  })

  test('QUALIFIED terminal produces one verified bounded proposal and REJECTED produces none', () => {
    const pins = extractPaperActivationManifestPins(qualifiedDeployment, kustomization)
    const qualifiedTerminal = {
      schemaVersion: 'bayn.qualification-collector-terminal.v1',
      repository: 'proompteng/lab',
      currentMainSha: 'a'.repeat(40),
      sourceSha: 'a'.repeat(40),
      image: { repository: pins.deploymentImageRepository, digest: pins.deploymentImageDigest },
      terminal: {
        schemaVersion: 'bayn.qualification-execution.v1',
        runId: pins.qualificationRunId,
        lockId: 'b'.repeat(64),
        resultHash: 'c'.repeat(64),
        verdict: 'QUALIFIED',
      },
      audit: { contamination: { resultCommittedAt: '2026-08-02T07:00:00.000Z' } },
    }
    const request = assemblePaperActivationRequest({
      terminal: qualifiedTerminal,
      manifestPins: pins,
      repository: 'proompteng/lab',
      currentMainSha: pins.sourceSha,
      producerHeadSha: 'a'.repeat(40),
      now: '2026-08-02T07:30:00.000Z',
    })
    expect(request._tag).toBe('Success')
    if (request._tag === 'Failure') return
    expect(
      verifyPaperActivationRequest({
        request: request.value,
        manifestPins: pins,
        repository: 'proompteng/lab',
        currentMainSha: pins.sourceSha,
        producerHeadSha: 'a'.repeat(40),
        now: '2026-08-02T07:30:00.000Z',
      }),
    ).toMatchObject({ status: 'verified' })
    const proposal = renderPaperActivationRequestTransition(qualifiedDeployment, request.value)
    expect(proposal.requestDeployment).toContain('BAYN_PAPER_ACTIVATION_REQUEST')
    expect(proposal.requestDeployment).not.toContain('value: PAPER')
    expect(proposal.rollbackDeployment).not.toContain('BAYN_PAPER_ACTIVATION_REQUEST')

    expect(qualificationParsed.jobs.eligibility.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Upload exactly one qualified activation terminal',
          if: expect.stringContaining("steps.qualify.outputs.verdict == 'QUALIFIED'"),
        }),
      ]),
    )
    expect(qualificationWorkflow).toContain('bayn-qualification-terminal-${{ github.sha }}-${{ github.run_id }}')
  })
})
