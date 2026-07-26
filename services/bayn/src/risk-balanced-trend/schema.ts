import { Result, Schema } from 'effect'

import { InputManifestArtifactSchema } from '../evidence-contracts'
import { ExecutionSessionBindingSchema, type ExecutionSessionBinding } from '../execution-session'
import { strictParseOptions } from '../schemas'
import type { InputManifest, Protocol } from '../types'
import type { RiskBalancedTrendFailure } from './model'

const decodeManifestResult = Schema.decodeUnknownResult(InputManifestArtifactSchema, strictParseOptions)
const decodeCycleBindingResult = Schema.decodeUnknownResult(ExecutionSessionBindingSchema, strictParseOptions)

export const decodeCurrentDecisionCycleBinding = (
  input: unknown,
): Result.Result<ExecutionSessionBinding, RiskBalancedTrendFailure> => {
  const decoded = decodeCycleBindingResult(input)
  return Result.isFailure(decoded)
    ? Result.fail({ _tag: 'CurrentDecisionBindingDecodeFailed', cause: decoded.failure })
    : Result.succeed(decoded.success)
}

export const parseMatchingManifest = (
  input: unknown,
  protocol: Protocol,
): Result.Result<InputManifest, RiskBalancedTrendFailure> => {
  const decoded = decodeManifestResult(input)
  if (Result.isFailure(decoded)) {
    return Result.fail({ _tag: 'ManifestDecodeFailed', cause: decoded.failure })
  }
  const manifest = decoded.success
  const snapshot = manifest.finalizedSnapshot
  if (
    snapshot.universeId !== protocol.universeId ||
    snapshot.universeSymbolHash !== protocol.universeSymbolHash ||
    snapshot.symbols.some((symbol, index) => symbol !== protocol.universe.at(index)) ||
    snapshot.symbols.length !== protocol.universe.length
  ) {
    return Result.fail({
      _tag: 'ManifestUniverseMismatch',
      expectedId: protocol.universeId,
      observedId: snapshot.universeId,
      expectedSymbolHash: protocol.universeSymbolHash,
      observedSymbolHash: snapshot.universeSymbolHash,
      expectedSymbols: protocol.universe,
      observedSymbols: snapshot.symbols,
    })
  }
  if (
    manifest.firstSession !== snapshot.firstSession ||
    manifest.lastSession !== snapshot.lastSession ||
    manifest.rowCount !== snapshot.rowCount ||
    manifest.sessionCount !== snapshot.sessionCount
  ) {
    return Result.fail({
      _tag: 'ManifestSnapshotBoundsMismatch',
      manifestFirst: manifest.firstSession,
      snapshotFirst: snapshot.firstSession,
      manifestLast: manifest.lastSession,
      snapshotLast: snapshot.lastSession,
      manifestRows: manifest.rowCount,
      snapshotRows: snapshot.rowCount,
      manifestSessions: manifest.sessionCount,
      snapshotSessions: snapshot.sessionCount,
    })
  }
  return Result.succeed(manifest)
}
