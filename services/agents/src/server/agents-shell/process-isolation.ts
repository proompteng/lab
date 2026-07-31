import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export type LinuxProcessStatus = {
  state: string | null
  uids: number[]
}

export type ProcessIsolationOptions = {
  procRoot?: string
  excludePids?: ReadonlySet<number>
  kill?: (pid: number, signal: NodeJS.Signals) => void
  settleMs?: number
  maxRounds?: number
}

const sleepSync = (milliseconds: number) => {
  if (milliseconds <= 0) return
  const state = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  Atomics.wait(state, 0, 0, milliseconds)
}

export const parseLinuxProcessStatus = (content: string): LinuxProcessStatus => {
  let state: string | null = null
  let uids: number[] = []
  for (const line of content.split('\n')) {
    if (line.startsWith('State:')) {
      state = line.slice('State:'.length).trim().split(/\s+/, 1)[0] ?? null
    } else if (line.startsWith('Uid:')) {
      uids = line
        .slice('Uid:'.length)
        .trim()
        .split(/\s+/)
        .map(Number)
        .filter((uid) => Number.isSafeInteger(uid) && uid >= 0)
    }
  }
  return { state, uids }
}

export const processIdsForUid = (
  uid: number,
  options: Pick<ProcessIsolationOptions, 'procRoot' | 'excludePids'> = {},
) => {
  const procRoot = options.procRoot ?? '/proc'
  const excludePids = options.excludePids ?? new Set<number>()
  const pids: number[] = []
  for (const entry of readdirSync(procRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
    const pid = Number(entry.name)
    if (!Number.isSafeInteger(pid) || pid < 2 || excludePids.has(pid)) continue
    try {
      const status = parseLinuxProcessStatus(readFileSync(join(procRoot, entry.name, 'status'), 'utf8'))
      if (status.state === 'Z' || !status.uids.includes(uid)) continue
      pids.push(pid)
    } catch {
      // Processes may exit between directory enumeration and status reads.
    }
  }
  return pids.sort((left, right) => left - right)
}

export const terminateProcessesForUid = (uid: number, options: ProcessIsolationOptions = {}) => {
  const procRoot = options.procRoot ?? '/proc'
  const excludePids = options.excludePids ?? new Set([process.pid, process.ppid])
  const kill = options.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal))
  const settleMs = options.settleMs ?? 10
  const maxRounds = options.maxRounds ?? 20
  const killed = new Set<number>()
  let emptyRounds = 0

  for (let round = 0; round < maxRounds; round += 1) {
    const pids = processIdsForUid(uid, { procRoot, excludePids })
    if (pids.length === 0) {
      emptyRounds += 1
      if (emptyRounds >= 2) return Array.from(killed).sort((left, right) => left - right)
      sleepSync(settleMs)
      continue
    }
    emptyRounds = 0
    for (const pid of pids) {
      try {
        kill(pid, 'SIGKILL')
        killed.add(pid)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ESRCH') throw error
      }
    }
    sleepSync(settleMs)
  }

  const remaining = processIdsForUid(uid, { procRoot, excludePids })
  if (remaining.length > 0) {
    throw new Error(`failed to terminate processes for lease UID ${uid}: ${remaining.join(',')}`)
  }
  return Array.from(killed).sort((left, right) => left - right)
}
