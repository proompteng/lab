import type { JevProtocolMaterial } from './protocol'

export const entryJudgmentThresholds = { affirmativeAtLeast: 0.7, negativeAtMost: 0.3 } as const

export const chartPresenceIsAbsent = (protocol: Pick<JevProtocolMaterial, 'schemaVersion'>, probability: number) =>
  // Pre-v39 financial evidence must retain its original proposal and dispatch decisions.
  (protocol.schemaVersion === 'bayn.jev.protocol.v40' || protocol.schemaVersion === 'bayn.jev.protocol.v39') &&
  probability <= entryJudgmentThresholds.negativeAtMost
