import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, type BigIntStats } from 'node:fs'
import { resolve } from 'node:path'

import { isInsidePath } from './workspace-policy'

export const FILE_PAGE_LIMIT = 200_000
const EVIDENCE_LIMIT = 64 * 1024 * 1024
const LOG_LIMIT = 32 * 1024 * 1024
const LINE_LIMIT = 1024 * 1024
const RECORD_LIMIT = 250_000

type FileIdentity = { path: string; version: string; sizeBytes: number; modifiedAt: string }
type FileAuthorizer = (openedPath: string) => void
export type FileRangeInput = { path: string; offset?: number; maxBytes?: number; expectedVersion?: string }
export type EvidenceInput = { path: string; format: 'json' | 'ndjson' | 'json-stream'; expectedSha256?: string }
export type PostgresLogInput = { path: string; startAt: string; endAt: string; expectedSha256?: string }

const versionOf = (path: string, stat: BigIntStats) =>
  createHash('sha256')
    .update([path, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join('\0'))
    .digest('hex')

const integerInRange = (value: number, name: string, minimum: number, maximum: number) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

const withWorkspaceFile = <T>(
  root: string,
  inputPath: string,
  read: (fd: number, identity: FileIdentity) => T,
  authorize?: FileAuthorizer,
): T => {
  const canonicalRoot = realpathSync(root)
  const lexicalPath = resolve(canonicalRoot, inputPath)
  if (!isInsidePath(canonicalRoot, lexicalPath)) throw new Error('File must stay inside the workspace')
  const path = realpathSync(lexicalPath)
  if (!isInsidePath(canonicalRoot, path)) throw new Error('File must stay inside the workspace')
  if (process.platform !== 'linux') throw new Error('Diagnostic file reads require Linux descriptor verification')

  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd, { bigint: true })
    if (!stat.isFile() || stat.nlink !== 1n) throw new Error('Diagnostic input must be a regular, unshared file')
    const openedPath = realpathSync(`/proc/self/fd/${fd}`)
    if (openedPath !== path || !isInsidePath(canonicalRoot, openedPath)) {
      throw new Error('Opened file does not match the workspace path')
    }
    authorize?.(openedPath)
    const sizeBytes = integerInRange(Number(stat.size), 'file size', 0, Number.MAX_SAFE_INTEGER)
    const version = versionOf(path, stat)
    const result = read(fd, {
      path,
      version,
      sizeBytes,
      modifiedAt: new Date(Number(stat.mtimeMs)).toISOString(),
    })
    if (versionOf(path, fstatSync(fd, { bigint: true })) !== version) throw new Error('File changed during the read')
    return result
  } finally {
    closeSync(fd)
  }
}

const readBytes = (fd: number, offset: number, length: number) => {
  const buffer = Buffer.alloc(length)
  let read = 0
  while (read < length) {
    const count = readSync(fd, buffer, read, length - read, offset + read)
    if (count === 0) throw new Error('File changed during the read')
    read += count
  }
  return buffer
}

const decodeUtf8 = (buffer: Buffer, streaming = false) => {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer, { stream: streaming })
  } catch {
    throw new Error('Input is not valid UTF-8 at the requested boundary')
  }
}

export const readFileRange = (root: string, input: FileRangeInput, authorize?: FileAuthorizer) => {
  const offset = integerInRange(input.offset ?? 0, 'offset', 0, Number.MAX_SAFE_INTEGER)
  const maxBytes = integerInRange(input.maxBytes ?? 20_000, 'maxBytes', 1, FILE_PAGE_LIMIT)
  return withWorkspaceFile(
    root,
    input.path,
    (fd, identity) => {
      if (input.expectedVersion !== undefined && input.expectedVersion !== identity.version) {
        throw new Error('File changed since the previous read')
      }
      if (offset > identity.sizeBytes) throw new Error('offset is past the end of the file')
      const buffer = readBytes(fd, offset, Math.min(maxBytes, identity.sizeBytes - offset))
      const content = decodeUtf8(buffer, offset + buffer.length < identity.sizeBytes)
      const readLength = Buffer.byteLength(content)
      if (buffer.length > 0 && readLength === 0) throw new Error('maxBytes cannot contain the next UTF-8 character')
      return {
        ...identity,
        offset,
        nextOffset: offset + readLength,
        endOfFile: offset + readLength === identity.sizeBytes,
        content,
      }
    },
    authorize,
  )
}

const readCompleteFile = <T>(
  root: string,
  input: { path: string; expectedSha256?: string },
  limit: number,
  inspect: (buffer: Buffer) => T,
  authorize?: FileAuthorizer,
) =>
  withWorkspaceFile(
    root,
    input.path,
    (fd, identity) => {
      if (identity.sizeBytes > limit) throw new Error(`Input exceeds the ${limit}-byte diagnostic limit`)
      const buffer = readBytes(fd, 0, identity.sizeBytes)
      const sha256 = createHash('sha256').update(buffer).digest('hex')
      if (input.expectedSha256 !== undefined && input.expectedSha256 !== sha256)
        throw new Error('Evidence hash mismatch')
      return { ...identity, sha256, completeFile: true as const, ...inspect(buffer) }
    },
    authorize,
  )

const forEachLine = (buffer: Buffer, consume: (line: string, lineNumber: number) => void) => {
  let offset = 0
  let lineNumber = 0
  while (offset < buffer.length) {
    lineNumber += 1
    if (lineNumber > RECORD_LIMIT) throw new Error(`Input exceeds the ${RECORD_LIMIT}-line diagnostic limit`)
    const newline = buffer.indexOf(10, offset)
    const end = newline < 0 ? buffer.length : newline
    if (end - offset > LINE_LIMIT) throw new Error(`Line ${lineNumber} exceeds the diagnostic line limit`)
    consume(decodeUtf8(buffer.subarray(offset, end)), lineNumber)
    offset = end + 1
  }
  return lineNumber
}

const jsonWhitespace = (character: string) =>
  character === ' ' || character === '\t' || character === '\n' || character === '\r'

const forEachJsonDocument = (text: string, consume: (document: string, lineNumber: number) => void) => {
  let offset = 0
  let lineNumber = 1
  while (offset < text.length) {
    while (offset < text.length && jsonWhitespace(text[offset])) {
      if (text[offset] === '\n') lineNumber += 1
      offset += 1
    }
    if (offset === text.length) break
    const start = offset
    const startLine = lineNumber
    let depth = 0
    let quoted = false
    let escaped = false
    for (; offset < text.length; offset += 1) {
      const character = text[offset]
      if (quoted) {
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === '"') quoted = false
      } else if (character === '"') quoted = true
      else if (character === '{' || character === '[') depth += 1
      else if (character === '}' || character === ']') depth -= 1
      else if (depth === 0 && jsonWhitespace(character)) break
      if (character === '\n') lineNumber += 1
    }
    consume(text.slice(start, offset), startLine)
  }
}

export const inspectEvidence = (root: string, input: EvidenceInput, authorize?: FileAuthorizer) => {
  if (!['json', 'ndjson', 'json-stream'].includes(input.format)) throw new Error('Unsupported evidence format')
  return readCompleteFile(
    root,
    input,
    EVIDENCE_LIMIT,
    (buffer) => {
      const counts = {
        format: input.format,
        documentCount: 0,
        objectDocuments: 0,
        arrayDocuments: 0,
        scalarDocuments: 0,
        topLevelArrayElements: 0,
        blankLines: 0,
      }
      const consume = (text: string, lineNumber: number) => {
        let value: unknown
        try {
          value = JSON.parse(text)
        } catch {
          throw new Error(`Invalid JSON at line ${lineNumber}`)
        }
        counts.documentCount += 1
        if (counts.documentCount > RECORD_LIMIT) throw new Error('Evidence exceeds the diagnostic document limit')
        if (Array.isArray(value)) {
          if (value.length > RECORD_LIMIT) throw new Error('Array exceeds the diagnostic record limit')
          counts.arrayDocuments += 1
          counts.topLevelArrayElements += value.length
        } else if (value !== null && typeof value === 'object') {
          counts.objectDocuments += 1
        } else {
          counts.scalarDocuments += 1
        }
      }
      if (input.format === 'json') {
        consume(decodeUtf8(buffer), 1)
      } else if (input.format === 'json-stream') {
        forEachJsonDocument(decodeUtf8(buffer), consume)
        if (counts.documentCount === 0) throw new Error('JSON stream evidence is empty')
      } else {
        forEachLine(buffer, (line, lineNumber) => {
          if (line.trim() === '') counts.blankLines += 1
          else consume(line, lineNumber)
        })
        if (counts.documentCount === 0) throw new Error('NDJSON evidence is empty')
      }
      return counts
    },
    authorize,
  )
}

const timestamp = (value: unknown) => {
  if (typeof value !== 'string') return null
  const iso = value.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?) UTC$/, '$1T$2Z')
  const match = iso.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/)
  if (!match) return null
  const wholeSecond = Date.parse(`${match[1]}Z`)
  if (!Number.isFinite(wholeSecond) || new Date(wholeSecond).toISOString().slice(0, 19) !== match[1]) return null
  return BigInt(wholeSecond) * 1_000_000n + BigInt((match[2] ?? '').padEnd(9, '0'))
}

const timestampIso = (nanoseconds: bigint) => {
  let seconds = nanoseconds / 1_000_000_000n
  let fraction = nanoseconds % 1_000_000_000n
  if (fraction < 0n) {
    seconds -= 1n
    fraction += 1_000_000_000n
  }
  const wholeSecond = new Date(Number(seconds * 1000n)).toISOString().slice(0, 19)
  const decimal = fraction.toString().padStart(9, '0').replace(/0+$/, '').padEnd(3, '0')
  return `${wholeSecond}.${decimal}Z`
}

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

const durationSummary = (values: number[]) => {
  values.sort((a, b) => a - b)
  return {
    count: values.length,
    minimum: values[0] ?? null,
    maximum: values.at(-1) ?? null,
    p50: values[Math.ceil(values.length * 0.5) - 1] ?? null,
    p95: values[Math.ceil(values.length * 0.95) - 1] ?? null,
    total: values.length === 0 ? null : values.reduce((total, value) => total + value, 0),
  }
}

export const summarizePostgresLog = (root: string, input: PostgresLogInput, authorize?: FileAuthorizer) => {
  const start = timestamp(input.startAt)
  const end = timestamp(input.endAt)
  if (start === null || end === null) throw new Error('A valid UTC timestamp is required for each interval bound')
  if (end <= start) throw new Error('The requested interval must have positive duration')
  if (end - start > 86_400_000_000_000n) throw new Error('The requested interval cannot exceed 24 hours')

  return readCompleteFile(
    root,
    input,
    LOG_LIMIT,
    (buffer) => {
      const counts = {
        inRangeRecords: 0,
        outOfRangeRecords: 0,
        malformedLines: 0,
        unrecognizedRecords: 0,
        recordsWithoutTimestamp: 0,
        invalidNumericRecords: 0,
        blankLines: 0,
        replicationTimeouts: 0,
        slowCommitsOverOneSecond: 0,
      }
      const severities = { DEBUG: 0, INFO: 0, LOG: 0, NOTICE: 0, WARNING: 0, ERROR: 0, FATAL: 0, PANIC: 0, UNKNOWN: 0 }
      const statements: number[] = []
      const commits: number[] = []
      const checkpoints: number[] = []
      const restartpoints: number[] = []
      let first: bigint | null = null
      let last: bigint | null = null
      let firstInRange: bigint | null = null
      let lastInRange: bigint | null = null
      const addDuration = (raw: string, scale: number, values: number[]) => {
        const value = Number(raw) * scale
        if (!Number.isFinite(value) || value > Number.MAX_SAFE_INTEGER / RECORD_LIMIT) {
          counts.invalidNumericRecords += 1
          return null
        }
        values.push(value)
        return value
      }
      const linesRead = forEachLine(buffer, (line) => {
        if (line.trim() === '') {
          counts.blankLines += 1
          return
        }
        const prefix = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z) /)
        let row: Record<string, unknown> | null
        try {
          row = object(JSON.parse(prefix ? line.slice(prefix[0].length) : line))
        } catch {
          counts.malformedLines += 1
          return
        }
        const record = object(row?.record) ?? row
        if (!record || typeof record.message !== 'string') {
          counts.unrecognizedRecords += 1
          return
        }
        const time =
          record.log_time !== undefined ? timestamp(record.log_time) : (timestamp(row?.ts) ?? timestamp(prefix?.[1]))
        if (time === null) {
          counts.recordsWithoutTimestamp += 1
          return
        }
        if (first === null || time < first) first = time
        if (last === null || time > last) last = time
        if (time < start || time >= end) {
          counts.outOfRangeRecords += 1
          return
        }
        if (firstInRange === null || time < firstInRange) firstInRange = time
        if (lastInRange === null || time > lastInRange) lastInRange = time
        counts.inRangeRecords += 1
        const severityValue = record.error_severity ?? row?.level
        const severity = typeof severityValue === 'string' ? severityValue.toUpperCase() : 'UNKNOWN'
        if (Object.hasOwn(severities, severity)) severities[severity as keyof typeof severities] += 1
        else severities.UNKNOWN += 1
        const message = record.message
        const duration = message.match(/^duration:\s+(\d+(?:\.\d+)?)\s+ms\b/)
        if (duration) {
          const value = addDuration(duration[1], 1, statements)
          if (
            value !== null &&
            /^duration:\s+\d+(?:\.\d+)?\s+ms\s+(?:statement|execute [^:]*):\s*COMMIT(?:\s+(?:WORK|TRANSACTION))?\s*;?\s*$/i.test(
              message,
            )
          ) {
            commits.push(value)
            if (value > 1000) counts.slowCommitsOverOneSecond += 1
          }
        }
        const sync = message.match(/\bsync=(\d+(?:\.\d+)?)\s*s\b/)
        if (sync && message.startsWith('checkpoint complete:')) addDuration(sync[1], 1000, checkpoints)
        if (sync && message.startsWith('restartpoint complete:')) addDuration(sync[1], 1000, restartpoints)
        if (
          /terminating walsender process due to replication timeout|could not receive data from WAL stream:.*timed out/.test(
            message,
          )
        ) {
          counts.replicationTimeouts += 1
        }
      })
      const iso = (value: bigint | null) => (value === null ? null : timestampIso(value))
      return {
        startAt: timestampIso(start),
        endAt: timestampIso(end),
        sessionCoverage: 'not_proven' as const,
        firstObservedAt: iso(first),
        lastObservedAt: iso(last),
        firstInRangeAt: iso(firstInRange),
        lastInRangeAt: iso(lastInRange),
        linesRead,
        ...counts,
        severities,
        quantileMethod: 'nearest_rank' as const,
        statementDurationMs: durationSummary(statements),
        commitDurationMs: durationSummary(commits),
        checkpointSyncMs: durationSummary(checkpoints),
        restartpointSyncMs: durationSummary(restartpoints),
      }
    },
    authorize,
  )
}
