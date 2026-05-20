import { describe, expect, it } from 'vitest'

import { buildRuntimeProofSurface, type AdmissionPassportStatus, type RuntimeKitStatus } from './runtime-admission'

const runtimeKit = {
  runtime_kit_id: 'runtime-kit:collaboration:abc123',
  kit_class: 'collaboration',
  subject_ref: 'agents:codex:nats-collaboration',
  image_ref:
    'registry.example/agents-codex-runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  workspace_contract_version: 'agents.proompteng.ai/runner/v1',
  component_digest: 'abc123',
  decision: 'blocked',
  observed_at: '2026-05-20T08:00:00.000Z',
  fresh_until: '2026-05-20T08:05:00.000Z',
  producer_revision: 'test',
  reason_codes: ['runtime_kit_component_missing:codex_nats_publish'],
  components: [
    {
      component_kind: 'binary',
      component_ref: 'codex-nats-publish',
      required: true,
      present: false,
      digest: null,
      reason_code: 'runtime_kit_component_missing:codex_nats_publish',
      evidence_ref: 'checked_paths=[]',
    },
  ],
} satisfies RuntimeKitStatus

const passport = {
  admission_passport_id: 'passport:swarm_implement:abc123',
  consumer_class: 'swarm_implement',
  authority_session_id: 'authority-session:abc123',
  recovery_case_set_digest: 'trust123',
  runtime_kit_set_digest: 'kit123',
  decision: 'block',
  reason_codes: ['runtime_kit_component_missing:codex_nats_publish'],
  required_subjects: [
    {
      subject_kind: 'runtime_kit',
      subject_ref: runtimeKit.runtime_kit_id,
      required: true,
      decision: 'block',
      evidence_ref: 'runtime_kit_component_missing:codex_nats_publish',
    },
  ],
  required_runtime_kits: [runtimeKit.runtime_kit_id],
  issued_at: '2026-05-20T08:00:00.000Z',
  fresh_until: '2026-05-20T08:05:00.000Z',
  producer_revision: 'test',
} satisfies AdmissionPassportStatus

describe('runtime admission proof surface', () => {
  it('projects runtime kit failures into proof cells, recovery warrants, and watermarks', () => {
    const surface = buildRuntimeProofSurface({
      runtimeKits: [runtimeKit],
      admissionPassports: [passport],
    })

    expect(surface.recoveryWarrants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          execution_class: 'implement',
          admission_passport_id: passport.admission_passport_id,
          status: 'broken',
          reason_codes: expect.arrayContaining(['runtime_kit_component_missing:codex_nats_publish']),
        }),
      ]),
    )
    expect(surface.runtimeProofCells).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          proof_kind: 'image_digest',
          proof_subject: 'collaboration:image',
          expected_ref: 'RUNTIME_IMAGE',
          status: 'healthy',
        }),
        expect.objectContaining({
          proof_kind: 'helper_asset',
          proof_subject: 'binary:codex-nats-publish',
          status: 'missing',
          required: true,
        }),
      ]),
    )
    expect(surface.projectionWatermarks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          consumer_key: 'control_plane_status',
          status: 'degraded',
        }),
      ]),
    )
  })
})
