import { performance } from 'node:perf_hooks'

// Frozen before collection: no capacity conclusion or quantum change can follow from this diagnostic.
export const yieldObservationContract = Object.freeze({
  windowMs: 1000,
  cutoff: 'earlier of first invalidation and input + 1000ms',
  maximumPairs: 16,
  maximumEvents: 32,
  maximumEventBytes: 8192,
  maximumObserverMs: 1,
  maximumCallbackMs: 0.1,
  minimumNonoverlappingGaps: 4,
  minimumGapMs: 5,
  minimumSupportingGaps: 3,
  minimumNoYieldFraction: 0.75,
  minimumRecords: 64,
  minimumMainThreadCpuFraction: 0.8,
  maximumEventLoopIdleFraction: 0.05,
})

export const assessYieldGaps = ({ http, events, inputAt, cutoffAt, failure }) => {
  const inconclusive = (reason) => ({ outcome: 'INCONCLUSIVE', reason, gaps: [] })
  if (failure !== null) return inconclusive(failure)
  if (inputAt === null || cutoffAt === null) return inconclusive('Observation window incomplete')
  const pairs = []
  for (let i = 0; i < events.length; i += 2) {
    const before = events[i],
      after = events[i + 1]
    if (
      !after ||
      before.boundary !== 'before' ||
      after.boundary !== 'after' ||
      before.epoch !== after.epoch ||
      before.consumerSequence !== after.consumerSequence ||
      after.at < before.at ||
      before.at < inputAt ||
      after.at >= cutoffAt
    )
      return inconclusive('Incomplete or inconsistent yield pair')
    if (i > 0 && before.at < events[i - 1].at) return inconclusive('Yield clock regressed')
    pairs.push({ before, after })
  }
  const candidates = []
  for (const row of http) {
    if (!row.resources) continue
    for (const [start, end] of [
      ['requestStart', 'serverRequest'],
      ['serverFinish', 'responseCallback'],
    ]) {
      const a = row.resources[start],
        b = row.resources[end]
      if (!a || !b) return inconclusive('Incomplete HTTP resource pair')
      // Identity is observed after each existing counter sample. No additional resource read is made.
      const left = a.consumer,
        right = b.consumer
      if (!left || !right) return inconclusive('Missing native consumer identity')
      if (
        left.at < inputAt ||
        right.at >= cutoffAt ||
        a.phase !== 'input-before-invalidation' ||
        b.phase !== 'input-before-invalidation'
      )
        continue
      if (
        left.epoch !== right.epoch ||
        right.consumerSequence < left.consumerSequence ||
        right.deliveredRecords < left.deliveredRecords
      )
        return inconclusive('Consumer epoch or counter changed')
      // Both cursors are read synchronously after their resource sample: consumption cannot advance inside it.
      // Restrict the common interval to after the left cursor and before the right sampler starts.
      const rightBoundary = { ...right, at: b.sampledAt }
      const uncertaintyMs = left.at - a.sampledAt + (right.at - b.sampledAt)
      if (left.at < a.sampledAt || right.at < b.sampledAt || !Number.isFinite(uncertaintyMs))
        return inconclusive('Unsupported sample-to-cursor interval')
      const elapsedMs = rightBoundary.at - left.at
      if (elapsedMs < 5) continue
      const counterMs = b.sampledAt - a.sampledAt
      const mainCpuMs = (b.threadUserUs + b.threadSystemUs - a.threadUserUs - a.threadSystemUs) / 1000
      const idleMs = b.eventLoopIdleMs - a.eventLoopIdleMs
      if (!(counterMs > 0) || mainCpuMs < 0 || idleMs < 0) return inconclusive('Unsupported resource interval')
      let anchor = left,
        longest = 0,
        records = 0
      for (const pair of pairs) {
        if (pair.after.at <= left.at || pair.before.at >= rightBoundary.at) continue
        if (pair.before.epoch !== left.epoch) return inconclusive('Yield epoch changed within HTTP gap')
        if (pair.before.at >= anchor.at) {
          const count = pair.before.consumerSequence - anchor.consumerSequence
          if (count >= 64 && pair.before.at - anchor.at > longest) {
            longest = pair.before.at - anchor.at
            records = count
          }
        }
        anchor = pair.after
      }
      if (anchor.at <= rightBoundary.at) {
        const count = rightBoundary.consumerSequence - anchor.consumerSequence
        if (count >= 64 && rightBoundary.at - anchor.at > longest) {
          longest = rightBoundary.at - anchor.at
          records = count
        }
      }
      // Counter reads are not simultaneous. Charge all endpoint uncertainty against supporting evidence.
      const mainThreadCpuFraction = Math.max(0, mainCpuMs - uncertaintyMs) / elapsedMs,
        idleFraction = (idleMs + uncertaintyMs) / elapsedMs
      candidates.push({
        requestOrdinal: row.ordinal,
        boundary: end,
        startAt: left.at,
        endAt: rightBoundary.at,
        elapsedMs,
        endpointUncertaintyMs: uncertaintyMs,
        noYieldMs: longest,
        noYieldRecords: records,
        noYieldFraction: longest / elapsedMs,
        mainThreadCpuFraction,
        idleFraction,
        supports: longest / elapsedMs >= 0.75 && records >= 64 && mainThreadCpuFraction >= 0.8 && idleFraction <= 0.05,
      })
    }
  }
  // Greedy earliest-finish selection is deterministic and maximizes the count of disjoint intervals.
  const gaps = []
  for (const gap of candidates.sort(
    (a, b) =>
      a.endAt - b.endAt ||
      a.startAt - b.startAt ||
      a.requestOrdinal - b.requestOrdinal ||
      a.boundary.localeCompare(b.boundary),
  )) {
    if (gaps.length === 0 || gap.startAt >= gaps.at(-1).endAt) gaps.push(gap)
  }
  if (gaps.length < 4)
    return { outcome: 'INCONCLUSIVE', reason: 'Fewer than four complete nonoverlapping eligible gaps', gaps }
  const supportingGaps = gaps.filter((gap) => gap.supports).length
  return { outcome: supportingGaps >= 3 ? 'SUPPORTS_FUTURE_QUANTUM_TEST' : 'UNSUPPORTED', supportingGaps, gaps }
}

export const observeCapacityYields = ({ readConsumer, now = () => performance.now() }) => {
  const events = []
  let inputAt = null,
    cutoffAt = null,
    stopped = false,
    pending = false,
    failure = null
  let observerMs = 0,
    maximumCallbackMs = 0,
    callbacks = 0,
    snapshots = 0
  const fail = (reason) => {
    failure ??= String(reason).slice(0, 160)
  }
  const checked = (epoch, consumerSequence, deliveredRecords) => {
    if (
      typeof epoch !== 'string' ||
      epoch.length < 1 ||
      epoch.length > 64 ||
      !Number.isSafeInteger(consumerSequence) ||
      consumerSequence < 0 ||
      !Number.isSafeInteger(deliveredRecords) ||
      deliveredRecords < 0
    )
      throw new Error('Invalid native consumer identity')
  }
  const measure = (operation, began = now()) => {
    try {
      return operation(began)
    } catch (error) {
      fail(error)
      return undefined
    } finally {
      const elapsed = now() - began
      callbacks++
      observerMs += elapsed
      maximumCallbackMs = Math.max(maximumCallbackMs, elapsed)
      if (elapsed < 0 || elapsed > 0.1 || observerMs > 1) fail('Observer overhead exceeded frozen budget')
    }
  }
  const stop = (at) => {
    cutoffAt = inputAt === null ? at : Math.min(cutoffAt ?? inputAt + 1000, at, inputAt + 1000)
    stopped = true
    if (pending) fail('Yield pair crossed observation cutoff')
  }
  return {
    startInput: (at) => {
      inputAt = at
      cutoffAt = at + 1000
    },
    invalidate: (at = now()) => stop(at),
    close: () => {
      const at = now()
      if (!stopped && (inputAt === null || at < cutoffAt)) fail('Observation ended before its frozen cutoff')
      stop(at)
    },
    boundary: (boundary, epoch, consumerSequence) => {
      if (inputAt === null || stopped) return
      measure((at) => {
        if (at >= cutoffAt) {
          stop(cutoffAt)
          return
        }
        checked(epoch, consumerSequence, 0)
        if ((boundary !== 'before' && boundary !== 'after') || (boundary === 'before') === pending)
          return fail('Unpaired yield observation')
        if (events.length >= 32) {
          fail('Yield event overflow')
          stopped = true
          return
        }
        events.push({ boundary, at, epoch, consumerSequence })
        pending = boundary === 'before'
      })
    },
    snapshot: (sampledAt = now()) => {
      // Called only alongside the existing first-eight-request resource snapshots, including late completions.
      if (++snapshots > 32) {
        fail('Consumer snapshot overflow')
        return undefined
      }
      return measure(() => {
        const { epoch, consumerSequence, deliveredRecords } = readConsumer()
        checked(epoch, consumerSequence, deliveredRecords)
        return { at: now(), epoch, consumerSequence, deliveredRecords }
      }, sampledAt)
    },
    report: (http, ioFailure = null) => {
      if (pending) fail('Incomplete yield pair')
      const eventBytes = Buffer.byteLength(JSON.stringify(events))
      if (eventBytes > 8192) fail('Yield event bytes exceeded 8 KiB')
      return {
        contract: yieldObservationContract,
        inputAt,
        cutoffAt,
        failure,
        observerMs,
        maximumCallbackMs,
        callbacks,
        snapshots,
        eventBytes,
        events: eventBytes <= 8192 ? events : [],
        assessment: assessYieldGaps({
          http,
          events,
          inputAt,
          cutoffAt,
          failure: failure ?? ioFailure ?? (!stopped ? 'Observation window not closed' : null),
        }),
        limitations:
          'Only explicit existing Effect.yieldNow boundaries are observed. HTTP gaps exclude both endpoint resource samples; CPU fractions are conservative lower bounds and idle fractions upper bounds after endpoint clock uncertainty. Observer cost includes the existing resource sampler and post-sample consumer read. A no-explicit-yield span may include implicit runtime scheduling, native work or other callbacks; this can support only a future controlled quantum test, never establish causation or capacity qualification.',
      }
    },
  }
}
