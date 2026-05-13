import type { StageClearancePacket } from '~/data/agents-control-plane'
import type {
  TorghutConsumerEvidenceResolution,
  TorghutConsumerEvidenceStatus,
} from '~/server/control-plane-torghut-consumer-evidence'

export type TorghutStageCustodyAttachmentResult = {
  resolution: TorghutConsumerEvidenceResolution
  attached: boolean
}

const paperActionStates = new Set(['allow', 'allowed', 'current', 'paper_canary', 'paper_candidate', 'ready'])

const STAGE_CUSTODY_PACKET_PREFERENCE: Array<StageClearancePacket['action_class']> = [
  'paper_canary',
  'torghut_observe',
  'live_micro_canary',
  'live_scale',
]

const parseTimestampMs = (value: string | null | undefined) => {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

const findTorghutStageCustodyPacket = (packets: StageClearancePacket[]) => {
  for (const actionClass of STAGE_CUSTODY_PACKET_PREFERENCE) {
    const packet = packets.find((entry) => entry.stage === 'torghut' && entry.action_class === actionClass)
    if (packet) return packet
  }
  return null
}

const stageCustodyStatusFromPacket = (packet: StageClearancePacket, now: Date) => {
  const freshUntilMs = parseTimestampMs(packet.fresh_until)
  if (!freshUntilMs) {
    return {
      status: 'stale',
      reasonCodes: ['evidence_clock_custody_fresh_until_missing'],
    }
  }
  if (freshUntilMs <= now.getTime()) {
    return {
      status: 'stale',
      reasonCodes: ['evidence_clock_custody_stale'],
    }
  }
  if (paperActionStates.has(packet.decision)) {
    return {
      status: 'current',
      reasonCodes: [],
    }
  }
  return {
    status: 'blocked',
    reasonCodes: [`evidence_clock_custody_stage_clearance_${packet.decision}`],
  }
}

const custodyFieldsChanged = (status: TorghutConsumerEvidenceStatus, nextStatus: string, nextRef: string) =>
  status.evidence_clock_custody_status !== nextStatus || status.evidence_clock_custody_ref !== nextRef

const isLocalTorghutStageCustodyRef = (ref: string | null | undefined) => ref?.startsWith('stage-clearance:torghut:')

export const attachStageClearanceCustodyToTorghutEvidence = (
  resolution: TorghutConsumerEvidenceResolution,
  packets: StageClearancePacket[],
  now = new Date(),
): TorghutStageCustodyAttachmentResult => {
  const status = resolution.status
  const localStageCustodyRef = isLocalTorghutStageCustodyRef(status.evidence_clock_custody_ref)
  if (
    !status.evidence_clock_arbiter_id ||
    (status.evidence_clock_custody_status === 'current' && !localStageCustodyRef)
  ) {
    return { resolution, attached: false }
  }
  if (
    status.evidence_clock_custody_ref &&
    status.evidence_clock_custody_status !== 'missing' &&
    !localStageCustodyRef
  ) {
    return { resolution, attached: false }
  }

  const packet = findTorghutStageCustodyPacket(packets)
  if (!packet) return { resolution, attached: false }

  const custody = stageCustodyStatusFromPacket(packet, now)
  const packetRef = packet.packet_id
  if (!custodyFieldsChanged(status, custody.status, packetRef)) {
    return { resolution, attached: false }
  }

  return {
    attached: true,
    resolution: {
      status: {
        ...status,
        evidence_clock_custody_status: custody.status,
        evidence_clock_custody_ref: packetRef,
      },
      negativeEvidence: resolution.negativeEvidence
        ? {
            ...resolution.negativeEvidence,
            evidence_clock_custody_status: custody.status,
            evidence_clock_custody_ref: packetRef,
            evidence_clock_custody_reason_codes: custody.reasonCodes,
          }
        : undefined,
    },
  }
}
