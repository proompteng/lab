import { performance } from 'node:perf_hooks'

export const wholeProcessCpuMicros = () => {
  const value = process.cpuUsage()
  return value.user + value.system
}

export const startCapacityCpuProfile = async () => {
  const { Session } = await import('node:inspector/promises')
  const session = new Session()
  session.connect()
  try {
    await session.post('Profiler.enable')
    await session.post('Profiler.setSamplingInterval', { interval: 1000 })
    await session.post('Profiler.start')
  } catch (error) {
    session.disconnect()
    throw error
  }
  const window = { startedAt: performance.now(), cpuStart: wholeProcessCpuMicros(), stoppedAt: null, cpuEnd: null }
  let completion
  let timer
  const stop = (reason) => {
    if (completion !== undefined) return completion
    window.stoppedAt = performance.now()
    window.cpuEnd = wholeProcessCpuMicros()
    clearTimeout(timer)
    completion = (async () => {
      try {
        const { profile } = await session.post('Profiler.stop')
        const samples = profile.samples ?? []
        const deltas = profile.timeDeltas ?? []
        const result = {
          instrumentedDiagnostic: true,
          profilerScope: 'main isolate samples',
          cpuScope: 'whole process including other threads and co-located fixture work',
          reason,
          requestedWindowMs: 1000,
          inputStartOffsetMs: window.inputStartOffsetMs ?? null,
          samplingIntervalUs: 1000,
          elapsedToStopRequestMs: window.stoppedAt - window.startedAt,
          timerOverrunMs: Math.max(0, window.stoppedAt - window.startedAt - 1000),
          profileDurationMs: (profile.endTime - profile.startTime) / 1000,
          wholeProcessCpuMs: (window.cpuEnd - window.cpuStart) / 1000,
          sampleCount: samples.length,
          nodeCount: profile.nodes.length,
        }
        if (samples.length > 4000 || profile.nodes.length > 65536 || deltas.length !== samples.length)
          return { ...result, diagnosticOverflow: true, topSelfCosts: [] }
        const nodes = new Map(profile.nodes.map((node) => [node.id, node.callFrame]))
        const costs = new Map()
        let sampledUs = 0
        for (let index = 0; index < samples.length; index++) {
          const frame = nodes.get(samples[index])
          if (frame === undefined) continue
          const key = `${frame.functionName}\0${frame.url}\0${frame.lineNumber}`
          const row = costs.get(key) ?? { frame, microseconds: 0, samples: 0 }
          row.microseconds += deltas[index]
          row.samples++
          sampledUs += deltas[index]
          costs.set(key, row)
        }
        const categoryUs = (name) =>
          [...costs.values()].reduce((sum, row) => sum + (row.frame.functionName === name ? row.microseconds : 0), 0)
        return {
          ...result,
          diagnosticOverflow: false,
          sampledMs: sampledUs / 1000,
          idleShare: sampledUs === 0 ? null : categoryUs('(idle)') / sampledUs,
          gcShare: sampledUs === 0 ? null : categoryUs('(garbage collector)') / sampledUs,
          topSelfCosts: [...costs.values()]
            .sort((a, b) => b.microseconds - a.microseconds)
            .slice(0, 20)
            .map((row) => ({
              function: row.frame.functionName.slice(0, 120),
              source: row.frame.url.slice(0, 240),
              line: row.frame.lineNumber + 1,
              selfMs: row.microseconds / 1000,
              samples: row.samples,
            })),
        }
      } catch (error) {
        return { instrumentedDiagnostic: true, error: String(error).slice(0, 500), reason }
      } finally {
        session.disconnect()
      }
    })()
    return completion
  }
  timer = setTimeout(() => void stop('timer'), 1000)
  timer.unref()
  return { window, stop }
}
