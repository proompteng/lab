import type { ControlPlaneStatus } from '~/server/control-plane-status-types'

export type ControlPlaneStatusView = 'full' | 'schedule-runner'

export const resolveControlPlaneStatusView = (value: string | null | undefined): ControlPlaneStatusView => {
  const normalized = value?.trim().toLowerCase()
  return normalized === 'schedule-runner' || normalized === 'schedule_runner' || normalized === 'runner'
    ? 'schedule-runner'
    : 'full'
}

export const projectControlPlaneStatus = (
  status: ControlPlaneStatus,
  view: ControlPlaneStatusView | string | null | undefined,
) => {
  if (resolveControlPlaneStatusView(view) !== 'schedule-runner') return status

  return {
    service: status.service,
    generated_at: status.generated_at,
    runtime_kits: status.runtime_kits,
    admission_passports: status.admission_passports,
    serving_passport_id: status.serving_passport_id,
    recovery_warrants: status.recovery_warrants,
    runtime_proof_cells: status.runtime_proof_cells,
    stage_clearance_packets: status.stage_clearance_packets,
    stage_credit_ledger: status.stage_credit_ledger,
    evidence_pressure_ledger: status.evidence_pressure_ledger,
    clearance_market_ledger: status.clearance_market_ledger,
    material_reentry_clearinghouse: status.material_reentry_clearinghouse,
  }
}
