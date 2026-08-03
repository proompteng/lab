import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

import { parse } from 'yaml'

export type PaperActivationManifestPins = {
  readonly sourceSha: string
  readonly strategyBehaviorHash: string
  readonly strategyParameterHash: string
  readonly qualificationRunId: string
  readonly deploymentImageRepository: string
  readonly deploymentImageDigest: string
  readonly kustomizeImageRepository: string
  readonly kustomizeImageDigest: string
  readonly kustomizeImageTag: string
  readonly currentAuthorityGenerationHash: string
}

export type QualificationTerminalReference = {
  readonly repository: string
  readonly currentMainSha: string
  readonly sourceSha: string
  readonly imageRepository: string
  readonly imageDigest: string
  readonly terminalRunId: string
  readonly terminalLockId: string
  readonly terminalResultHash: string
  readonly verdict: 'QUALIFIED' | 'REJECTED'
  readonly resultCommittedAt: string
}

export type PaperActivationRequestMaterial = {
  readonly schemaVersion: 'bayn.paper-activation-request.v1'
  readonly qualification: {
    readonly runId: string
    readonly lockId: string
    readonly resultHash: string
    readonly sourceRevision: string
    readonly imageRepository: string
    readonly imageDigest: string
  }
  readonly activation: {
    readonly sourceRevision: string
    readonly imageRepository: string
    readonly imageDigest: string
  }
  readonly strategy: {
    readonly name: 'risk-balanced-trend'
    readonly behaviorHash: string
    readonly parameterHash: string
    readonly parameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v4'
    readonly protocolHash: string
  }
  readonly limits: {
    readonly maxOpenOrders: 0
    readonly maxPositions: 0
  }
  readonly cutoffAt: string
  readonly expiresAt: string
}

export type PaperActivationRequest = PaperActivationRequestMaterial & {
  readonly requestHash: string
}

export type RequestResult<Value> =
  | { readonly _tag: 'Success'; readonly value: Value }
  | { readonly _tag: 'Failure'; readonly code: string; readonly message: string }

export type PaperActivationTransition = {
  readonly requestDeployment: string
  readonly rollbackDeployment: string
}

export type PaperActivationRequestVerification =
  | { readonly status: 'verified'; readonly request: PaperActivationRequest }
  | { readonly status: 'hold'; readonly code: string; readonly message: string }

const maximumAuthorityDurationMs = 90 * 60 * 1_000
const isSha = (value: string): boolean => /^[0-9a-f]{40}$/.test(value)
const isHash = (value: string): boolean => /^[0-9a-f]{64}$/.test(value)
const isDigest = (value: string): boolean => /^sha256:[0-9a-f]{64}$/.test(value)

const success = <Value>(value: Value): RequestResult<Value> => ({ _tag: 'Success', value })
const failure = (code: string, message: string): RequestResult<never> => ({ _tag: 'Failure', code, message })

const invalidUnicodeSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}

const canonicalJsonV1 = (value: unknown, ancestors: readonly object[] = []): string => {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') {
    if (invalidUnicodeSurrogate(value)) throw new Error('canonical JSON contains an invalid Unicode surrogate')
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON contains a non-finite number')
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (typeof value !== 'object') throw new Error(`canonical JSON contains a non-JSON ${typeof value} value`)
  if (ancestors.includes(value)) throw new Error('canonical JSON contains a cycle')

  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value)
    if (
      keys.some(
        (key) =>
          key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length),
      )
    )
      throw new Error('canonical JSON array is sparse or has custom properties')
    return `[${value.map((entry) => canonicalJsonV1(entry, [...ancestors, value])).join(',')}]`
  }

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error('canonical JSON contains a non-plain object')
  const keys = Reflect.ownKeys(value)
  if (keys.some((key) => typeof key !== 'string')) throw new Error('canonical JSON contains a symbol key')
  const entries = (keys as readonly string[])
    .slice()
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((key) => {
      if (invalidUnicodeSurrogate(key)) throw new Error('canonical JSON contains an invalid Unicode key')
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor?.enumerable !== true || !('value' in descriptor))
        throw new Error('canonical JSON contains a non-data property')
      return `${JSON.stringify(key)}:${canonicalJsonV1(descriptor.value, [...ancestors, value])}`
    })
  return `{${entries.join(',')}}`
}

const canonicalHashV1 = (value: unknown): string => createHash('sha256').update(canonicalJsonV1(value)).digest('hex')

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const recordAt = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  return value
}

const arrayAt = (value: unknown, label: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}

const stringAt = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`)
  return value
}

const hashAt = (value: unknown, label: string): string => {
  const result = stringAt(value, label)
  if (!isHash(result)) throw new Error(`${label} must be a SHA-256 hash`)
  return result
}

const sourceAt = (value: unknown, label: string): string => {
  const result = stringAt(value, label)
  if (!isSha(result)) throw new Error(`${label} must be a Git source revision`)
  return result
}

const digestAt = (value: unknown, label: string): string => {
  const result = stringAt(value, label)
  if (!isDigest(result)) throw new Error(`${label} must be an image digest`)
  return result
}

const field = (record: Record<string, unknown>, name: string, label = name): unknown => {
  if (!Object.hasOwn(record, name)) throw new Error(`${label} is missing`)
  return record[name]
}

const environmentValue = (environment: readonly Record<string, unknown>[], name: string): string => {
  const matches = environment.filter((entry) => entry.name === name)
  if (matches.length !== 1) throw new Error(`deployment must contain exactly one ${name} value`)
  return stringAt(matches[0]?.value, name)
}

const exactKeys = (record: Record<string, unknown>, keys: readonly string[], label: string): void => {
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key)))
    throw new Error(`${label} must contain the exact schema`)
}

const parseDeployment = (contents: string) => {
  const deployment = recordAt(parse(contents), 'deployment')
  const spec = recordAt(field(deployment, 'spec'), 'deployment.spec')
  const template = recordAt(field(spec, 'template'), 'deployment.spec.template')
  const podSpec = recordAt(field(template, 'spec'), 'deployment.spec.template.spec')
  const containers = arrayAt(field(podSpec, 'containers'), 'deployment containers').map((value, index) =>
    recordAt(value, `deployment container ${index}`),
  )
  const baynContainers = containers.filter((container) => container.name === 'bayn')
  if (baynContainers.length !== 1) throw new Error('deployment must contain exactly one Bayn container')
  const bayn = baynContainers[0]
  if (bayn === undefined) throw new Error('Bayn container is missing')
  const environment = arrayAt(field(bayn, 'env'), 'Bayn environment').map((value, index) =>
    recordAt(value, `Bayn environment entry ${index}`),
  )
  return { bayn, environment }
}

const parseRenderedImage = (value: string): { readonly repository: string; readonly digest: string | undefined } => {
  const rendered = /^(?<repository>.+):(?<tag>[^:@/]+)@(?<digest>sha256:[0-9a-f]{64})$/.exec(value)
  return { repository: rendered?.groups?.repository ?? value, digest: rendered?.groups?.digest }
}

export const extractPaperActivationManifestPins = (
  deploymentContents: string,
  kustomizationContents: string,
): PaperActivationManifestPins => {
  const { bayn, environment } = parseDeployment(deploymentContents)
  const deploymentImage = stringAt(bayn.image, 'Bayn container image')
  const deploymentImageRepository = environmentValue(environment, 'BAYN_IMAGE_REPOSITORY')
  const deploymentImageDigest = digestAt(environmentValue(environment, 'BAYN_IMAGE_DIGEST'), 'BAYN_IMAGE_DIGEST')
  const renderedImage = parseRenderedImage(deploymentImage)
  if (
    renderedImage.repository !== deploymentImageRepository ||
    (renderedImage.digest !== undefined && renderedImage.digest !== deploymentImageDigest)
  )
    throw new Error('Bayn container image does not match its repository and digest pins')

  const kustomization = recordAt(parse(kustomizationContents), 'kustomization')
  const images = arrayAt(field(kustomization, 'images'), 'kustomization images').map((value, index) =>
    recordAt(value, `kustomization image ${index}`),
  )
  const matchingImages = images.filter((image) => image.name === deploymentImageRepository)
  if (matchingImages.length !== 1) throw new Error('kustomization must contain exactly one effective Bayn image')
  const image = matchingImages[0]
  if (image === undefined) throw new Error('effective Bayn image is missing')
  const kustomizeImageRepository = stringAt(field(image, 'newName'), 'kustomization Bayn newName')
  const kustomizeImageDigest = digestAt(field(image, 'digest'), 'kustomization Bayn digest')
  const sourceSha = sourceAt(environmentValue(environment, 'BAYN_CODE_REVISION'), 'BAYN_CODE_REVISION')
  const kustomizeImageTag = stringAt(field(image, 'newTag'), 'kustomization Bayn tag')
  if (
    kustomizeImageRepository !== deploymentImageRepository ||
    kustomizeImageDigest !== deploymentImageDigest ||
    kustomizeImageTag !== `sha-${sourceSha}`
  )
    throw new Error('effective Kustomize image is not bound to the deployment source and digest')

  return {
    sourceSha,
    strategyBehaviorHash: hashAt(
      environmentValue(environment, 'BAYN_STRATEGY_BEHAVIOR_HASH'),
      'strategy behavior hash',
    ),
    strategyParameterHash: hashAt(
      environmentValue(environment, 'BAYN_STRATEGY_PARAMETER_HASH'),
      'strategy parameter hash',
    ),
    qualificationRunId: hashAt(environmentValue(environment, 'BAYN_QUALIFICATION_RUN_ID'), 'qualification run ID'),
    deploymentImageRepository,
    deploymentImageDigest,
    kustomizeImageRepository,
    kustomizeImageDigest,
    kustomizeImageTag,
    currentAuthorityGenerationHash: hashAt(
      environmentValue(environment, 'BAYN_AUTHORITY_GENERATION_HASH'),
      'current OBSERVE authority generation hash',
    ),
  }
}

const decodeTerminal = (value: unknown): RequestResult<QualificationTerminalReference> => {
  try {
    const terminal = recordAt(value, 'qualification terminal')
    if (field(terminal, 'schemaVersion') !== 'bayn.qualification-collector-terminal.v1')
      return failure('terminal-schema', 'qualification terminal schema is unsupported')
    const execution = recordAt(field(terminal, 'terminal'), 'qualification execution')
    const audit = recordAt(field(terminal, 'audit'), 'qualification audit')
    const contamination = recordAt(field(audit, 'contamination'), 'qualification audit contamination')
    const image = recordAt(field(terminal, 'image'), 'qualification image')
    const verdict = field(execution, 'verdict')
    if (verdict !== 'QUALIFIED' && verdict !== 'REJECTED')
      return failure('terminal-verdict', 'qualification verdict is invalid')
    const reference = {
      repository: stringAt(field(terminal, 'repository'), 'qualification repository'),
      currentMainSha: sourceAt(field(terminal, 'currentMainSha'), 'qualification current main'),
      sourceSha: sourceAt(field(terminal, 'sourceSha'), 'qualification source'),
      imageRepository: stringAt(field(image, 'repository'), 'qualification image repository'),
      imageDigest: digestAt(field(image, 'digest'), 'qualification image digest'),
      terminalRunId: hashAt(field(execution, 'runId'), 'qualification run ID'),
      terminalLockId: hashAt(field(execution, 'lockId'), 'qualification lock ID'),
      terminalResultHash: hashAt(field(execution, 'resultHash'), 'qualification result hash'),
      verdict,
      resultCommittedAt: stringAt(field(contamination, 'resultCommittedAt'), 'qualification result timestamp'),
    } satisfies QualificationTerminalReference
    if (!Number.isFinite(Date.parse(reference.resultCommittedAt)))
      return failure('terminal-time', 'qualification result timestamp is invalid')
    return success(reference)
  } catch (cause) {
    return failure('terminal-schema', cause instanceof Error ? cause.message : 'qualification terminal is invalid')
  }
}

const decodeManifestPins = (value: unknown): RequestResult<PaperActivationManifestPins> => {
  try {
    const record = recordAt(value, 'manifest pins')
    const keys = [
      'sourceSha',
      'strategyBehaviorHash',
      'strategyParameterHash',
      'qualificationRunId',
      'deploymentImageRepository',
      'deploymentImageDigest',
      'kustomizeImageRepository',
      'kustomizeImageDigest',
      'kustomizeImageTag',
      'currentAuthorityGenerationHash',
    ] as const
    exactKeys(record, keys, 'manifest pins')
    return success({
      sourceSha: sourceAt(field(record, 'sourceSha'), 'manifest source'),
      strategyBehaviorHash: hashAt(field(record, 'strategyBehaviorHash'), 'manifest strategy behavior hash'),
      strategyParameterHash: hashAt(field(record, 'strategyParameterHash'), 'manifest strategy parameter hash'),
      qualificationRunId: hashAt(field(record, 'qualificationRunId'), 'manifest qualification run ID'),
      deploymentImageRepository: stringAt(field(record, 'deploymentImageRepository'), 'deployment image repository'),
      deploymentImageDigest: digestAt(field(record, 'deploymentImageDigest'), 'deployment image digest'),
      kustomizeImageRepository: stringAt(field(record, 'kustomizeImageRepository'), 'Kustomize image repository'),
      kustomizeImageDigest: digestAt(field(record, 'kustomizeImageDigest'), 'Kustomize image digest'),
      kustomizeImageTag: stringAt(field(record, 'kustomizeImageTag'), 'Kustomize image tag'),
      currentAuthorityGenerationHash: hashAt(
        field(record, 'currentAuthorityGenerationHash'),
        'current OBSERVE authority generation hash',
      ),
    })
  } catch (cause) {
    return failure('manifest-pins', cause instanceof Error ? cause.message : 'manifest pins are invalid')
  }
}

const strategyProtocolHash = (pins: PaperActivationManifestPins): string =>
  canonicalHashV1({
    schemaVersion: 'bayn.strategy-protocol.v1',
    name: 'risk-balanced-trend',
    behaviorHash: pins.strategyBehaviorHash,
    parameterHash: pins.strategyParameterHash,
    parameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v4',
  })

const requestMaterial = (
  terminal: QualificationTerminalReference,
  pins: PaperActivationManifestPins,
  cutoffAt: string,
  expiresAt: string,
): PaperActivationRequestMaterial => ({
  schemaVersion: 'bayn.paper-activation-request.v1',
  qualification: {
    runId: terminal.terminalRunId,
    lockId: terminal.terminalLockId,
    resultHash: terminal.terminalResultHash,
    sourceRevision: terminal.sourceSha,
    imageRepository: terminal.imageRepository,
    imageDigest: terminal.imageDigest,
  },
  activation: {
    sourceRevision: pins.sourceSha,
    imageRepository: pins.deploymentImageRepository,
    imageDigest: pins.deploymentImageDigest,
  },
  strategy: {
    name: 'risk-balanced-trend',
    behaviorHash: pins.strategyBehaviorHash,
    parameterHash: pins.strategyParameterHash,
    parameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v4',
    protocolHash: strategyProtocolHash(pins),
  },
  limits: { maxOpenOrders: 0, maxPositions: 0 },
  cutoffAt,
  expiresAt,
})

export const assemblePaperActivationRequest = (input: {
  readonly terminal: unknown
  readonly manifestPins: unknown
  readonly repository: string
  readonly currentMainSha: string
  readonly producerHeadSha: string
  readonly now: string
}): RequestResult<PaperActivationRequest> => {
  const terminal = decodeTerminal(input.terminal)
  if (terminal._tag === 'Failure') return terminal
  const manifestPins = decodeManifestPins(input.manifestPins)
  if (manifestPins._tag === 'Failure') return manifestPins
  const pins = manifestPins.value
  if (terminal.value.repository !== input.repository)
    return failure('repository-mismatch', 'qualification terminal belongs to another repository')
  if (terminal.value.verdict !== 'QUALIFIED')
    return failure('qualification-not-qualified', 'qualification terminal is not QUALIFIED')
  if (
    terminal.value.currentMainSha !== input.producerHeadSha ||
    terminal.value.sourceSha !== input.producerHeadSha ||
    !isSha(input.producerHeadSha)
  )
    return failure(
      'producer-head-mismatch',
      'qualification terminal is not bound to its immutable workflow producer head',
    )
  if (pins.sourceSha !== input.currentMainSha || !isSha(input.currentMainSha))
    return failure('activation-source-mismatch', 'activation pins are not bound to the exact current main')
  if (pins.qualificationRunId !== terminal.value.terminalRunId)
    return failure('qualification-run-mismatch', 'deployment qualification run does not match the terminal')
  if (
    pins.kustomizeImageRepository !== pins.deploymentImageRepository ||
    pins.kustomizeImageDigest !== pins.deploymentImageDigest ||
    pins.kustomizeImageTag !== `sha-${pins.sourceSha}`
  )
    return failure('image-binding-mismatch', 'deployment and Kustomize image pins differ')
  const nowEpoch = Date.parse(input.now)
  const committedEpoch = Date.parse(terminal.value.resultCommittedAt)
  if (!Number.isFinite(nowEpoch) || !Number.isFinite(committedEpoch))
    return failure('invalid-time', 'request time is invalid')
  const expiresEpoch = committedEpoch + maximumAuthorityDurationMs
  const cutoffEpoch = expiresEpoch - 60_000
  if (nowEpoch >= cutoffEpoch)
    return failure('qualification-cutoff', 'qualification is too close to its activation cutoff')
  const material = requestMaterial(
    terminal.value,
    pins,
    new Date(cutoffEpoch).toISOString(),
    new Date(expiresEpoch).toISOString(),
  )
  return success({ ...material, requestHash: canonicalHashV1(material) })
}

const decodeRequest = (value: unknown): RequestResult<PaperActivationRequest> => {
  try {
    const record = recordAt(value, 'paper activation request')
    const material = recordAt(record, 'paper activation request')
    const qualification = recordAt(field(material, 'qualification'), 'request qualification')
    const activation = recordAt(field(material, 'activation'), 'request activation')
    const strategy = recordAt(field(material, 'strategy'), 'request strategy')
    const limits = recordAt(field(material, 'limits'), 'request limits')
    if (field(material, 'schemaVersion') !== 'bayn.paper-activation-request.v1')
      return failure('request-schema', 'request schema is unsupported')
    exactKeys(
      record,
      ['schemaVersion', 'qualification', 'activation', 'strategy', 'limits', 'cutoffAt', 'expiresAt', 'requestHash'],
      'paper activation request',
    )
    exactKeys(
      qualification,
      ['runId', 'lockId', 'resultHash', 'sourceRevision', 'imageRepository', 'imageDigest'],
      'request qualification',
    )
    exactKeys(activation, ['sourceRevision', 'imageRepository', 'imageDigest'], 'request activation')
    exactKeys(
      strategy,
      ['name', 'behaviorHash', 'parameterHash', 'parameterSchemaVersion', 'protocolHash'],
      'request strategy',
    )
    exactKeys(limits, ['maxOpenOrders', 'maxPositions'], 'request limits')
    if (
      field(strategy, 'name') !== 'risk-balanced-trend' ||
      field(strategy, 'parameterSchemaVersion') !== 'bayn.risk-balanced-trend.protocol.v4'
    )
      return failure('request-strategy', 'request strategy is not the reviewed risk-balanced-trend protocol')
    if (field(limits, 'maxOpenOrders') !== 0 || field(limits, 'maxPositions') !== 0)
      return failure('request-limits', 'request limits must remain zero before runtime PREPARE')
    const decoded: PaperActivationRequest = {
      schemaVersion: 'bayn.paper-activation-request.v1',
      qualification: {
        runId: hashAt(field(qualification, 'runId'), 'request qualification run ID'),
        lockId: hashAt(field(qualification, 'lockId'), 'request qualification lock ID'),
        resultHash: hashAt(field(qualification, 'resultHash'), 'request qualification result hash'),
        sourceRevision: sourceAt(field(qualification, 'sourceRevision'), 'request qualification source'),
        imageRepository: stringAt(field(qualification, 'imageRepository'), 'request qualification image repository'),
        imageDigest: digestAt(field(qualification, 'imageDigest'), 'request qualification image digest'),
      },
      activation: {
        sourceRevision: sourceAt(field(activation, 'sourceRevision'), 'request activation source'),
        imageRepository: stringAt(field(activation, 'imageRepository'), 'request activation image repository'),
        imageDigest: digestAt(field(activation, 'imageDigest'), 'request activation image digest'),
      },
      strategy: {
        name: 'risk-balanced-trend',
        behaviorHash: hashAt(field(strategy, 'behaviorHash'), 'request strategy behavior hash'),
        parameterHash: hashAt(field(strategy, 'parameterHash'), 'request strategy parameter hash'),
        parameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v4',
        protocolHash: hashAt(field(strategy, 'protocolHash'), 'request strategy protocol hash'),
      },
      limits: { maxOpenOrders: 0, maxPositions: 0 },
      cutoffAt: stringAt(field(material, 'cutoffAt'), 'request cutoff'),
      expiresAt: stringAt(field(material, 'expiresAt'), 'request expiry'),
      requestHash: hashAt(field(material, 'requestHash'), 'request hash'),
    }
    if (!Number.isFinite(Date.parse(decoded.cutoffAt)) || !Number.isFinite(Date.parse(decoded.expiresAt)))
      return failure('request-time', 'request cutoff or expiry is invalid')
    if (decoded.expiresAt <= decoded.cutoffAt) return failure('request-time', 'request expiry must follow its cutoff')
    const { requestHash: _requestHash, ...withoutHash } = decoded
    if (decoded.requestHash !== canonicalHashV1(withoutHash))
      return failure('request-hash', 'request hash is not canonical')
    if (
      decoded.strategy.protocolHash !==
      strategyProtocolHash({
        sourceSha: decoded.activation.sourceRevision,
        strategyBehaviorHash: decoded.strategy.behaviorHash,
        strategyParameterHash: decoded.strategy.parameterHash,
        qualificationRunId: decoded.qualification.runId,
        deploymentImageRepository: decoded.activation.imageRepository,
        deploymentImageDigest: decoded.activation.imageDigest,
        kustomizeImageRepository: decoded.activation.imageRepository,
        kustomizeImageDigest: decoded.activation.imageDigest,
        kustomizeImageTag: `sha-${decoded.activation.sourceRevision}`,
        currentAuthorityGenerationHash: '0'.repeat(64),
      })
    )
      return failure('request-strategy', 'request protocol hash is not canonical')
    return success(decoded)
  } catch (cause) {
    return failure('request-schema', cause instanceof Error ? cause.message : 'paper activation request is invalid')
  }
}

export const verifyPaperActivationRequest = (input: {
  readonly request: unknown
  readonly manifestPins: unknown
  readonly repository: string
  readonly currentMainSha: string
  readonly producerHeadSha: string
  readonly now: string
}): PaperActivationRequestVerification => {
  const decoded = decodeRequest(input.request)
  if (decoded._tag === 'Failure') return { status: 'hold', code: decoded.code, message: decoded.message }
  const pins = decodeManifestPins(input.manifestPins)
  if (pins._tag === 'Failure') return { status: 'hold', code: pins.code, message: pins.message }
  const request = decoded.value
  if (input.repository.length === 0)
    return { status: 'hold', code: 'repository-mismatch', message: 'repository is required' }
  const now = Date.parse(input.now)
  const checks: readonly [boolean, string, string][] = [
    [
      isSha(input.currentMainSha) && request.activation.sourceRevision === input.currentMainSha,
      'activation-source-mismatch',
      'request activation source is not exact current main',
    ],
    [
      isSha(input.producerHeadSha) && request.qualification.sourceRevision === input.producerHeadSha,
      'producer-head-mismatch',
      'request qualification source is not its producer head',
    ],
    [
      request.qualification.runId === pins.value.qualificationRunId,
      'qualification-run-mismatch',
      'request qualification run is not the manifest run',
    ],
    [
      request.activation.imageRepository === pins.value.deploymentImageRepository &&
        request.activation.imageDigest === pins.value.deploymentImageDigest,
      'image-binding-mismatch',
      'request activation image is not the deployment image',
    ],
    [
      pins.value.deploymentImageRepository === pins.value.kustomizeImageRepository &&
        pins.value.deploymentImageDigest === pins.value.kustomizeImageDigest,
      'image-binding-mismatch',
      'deployment and Kustomize image pins differ',
    ],
    [
      request.strategy.behaviorHash === pins.value.strategyBehaviorHash &&
        request.strategy.parameterHash === pins.value.strategyParameterHash,
      'strategy-mismatch',
      'request strategy is not the checked-out strategy',
    ],
    [
      Number.isFinite(now) && input.now < request.cutoffAt && input.now < request.expiresAt,
      'request-expired',
      'request is past its immutable cutoff or expiry',
    ],
  ]
  const failed = checks.find(([condition]) => !condition)
  return failed === undefined
    ? { status: 'verified', request }
    : { status: 'hold', code: failed[1], message: failed[2] }
}

const replaceExactlyOnce = (source: string, expected: string, replacement: string, label: string): string => {
  if (source.split(expected).length !== 2) throw new Error(`${label} is missing or ambiguous`)
  return source.replace(expected, replacement)
}

export const renderPaperActivationRequestTransition = (
  sourceDeployment: string,
  request: PaperActivationRequest,
): PaperActivationTransition => {
  const { environment } = parseDeployment(sourceDeployment)
  const maximumObserve = '            - name: BAYN_MAXIMUM_AUTHORITY\n              value: OBSERVE\n'
  const requestMarker = '            - name: BAYN_PAPER_ACTIVATION_REQUEST\n'
  if (!sourceDeployment.includes(maximumObserve)) throw new Error('source deployment must remain OBSERVE')
  if (sourceDeployment.includes(requestMarker))
    throw new Error('source deployment already contains an activation request')
  const existingBrokerAccess = environment.filter((entry) => entry.name === 'BAYN_BROKER_ACCESS')
  const existingCapitalAuthority = environment.filter((entry) => entry.name === 'BAYN_CAPITAL_AUTHORITY')
  if (existingBrokerAccess.length > 0 || existingCapitalAuthority.length > 0)
    throw new Error('source deployment must not preconfigure mutation capability')
  const qualificationRunId = environmentValue(environment, 'BAYN_QUALIFICATION_RUN_ID')
  if (!isHash(qualificationRunId)) throw new Error('source qualification run ID is malformed')
  const requestValue = JSON.stringify(JSON.stringify(request))
  const requestBlock = `${requestMarker}              value: ${requestValue}\n`
  let requestDeployment = replaceExactlyOnce(
    sourceDeployment,
    maximumObserve,
    maximumObserve + requestBlock,
    'OBSERVE authority field',
  )
  const qualificationMarker = `            - name: BAYN_QUALIFICATION_RUN_ID\n              value: "${qualificationRunId}"\n`
  requestDeployment = replaceExactlyOnce(
    requestDeployment,
    qualificationMarker,
    `            - name: BAYN_QUALIFICATION_RUN_ID\n              value: "${request.qualification.runId}"\n`,
    'qualification run binding',
  )
  return { requestDeployment, rollbackDeployment: sourceDeployment }
}

const parseArguments = (arguments_: readonly string[]): Record<string, string> => {
  const result: Record<string, string> = {}
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index]
    const value = arguments_[index + 1]
    if (key === undefined || value === undefined || !key.startsWith('--'))
      throw new Error('arguments must be --key value pairs')
    result[key.slice(2)] = value
  }
  return result
}

const jsonFile = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8')) as unknown
const required = (args: Record<string, string>, key: string): string => {
  const value = args[key]
  if (value === undefined || value.length === 0) throw new Error(`--${key} is required`)
  return value
}

if (import.meta.main) {
  try {
    const args = parseArguments(process.argv.slice(2))
    if (args.mode === 'extract-manifest-pins') {
      writeFileSync(
        required(args, 'output'),
        `${JSON.stringify(extractPaperActivationManifestPins(readFileSync(required(args, 'deployment'), 'utf8'), readFileSync(required(args, 'kustomization'), 'utf8')), null, 2)}\n`,
      )
      console.log('BAYN_PAPER_ACTIVATION_MANIFEST_PINS_EXTRACTED')
    } else if (args.mode === 'assemble-request') {
      const request = assemblePaperActivationRequest({
        terminal: jsonFile(required(args, 'terminal')),
        manifestPins: jsonFile(required(args, 'manifest-pins')),
        repository: required(args, 'repository'),
        currentMainSha: required(args, 'current-main-sha'),
        producerHeadSha: required(args, 'producer-head-sha'),
        now: required(args, 'now'),
      })
      if (request._tag === 'Failure') throw new Error(`${request.code}: ${request.message}`)
      writeFileSync(required(args, 'output'), `${JSON.stringify(request.value, null, 2)}\n`)
      console.log(`BAYN_PAPER_ACTIVATION_REQUEST_ASSEMBLED ${request.value.requestHash}`)
    } else if (args.mode === 'verify-request') {
      const verification = verifyPaperActivationRequest({
        request: jsonFile(required(args, 'request')),
        manifestPins: jsonFile(required(args, 'manifest-pins')),
        repository: required(args, 'repository'),
        currentMainSha: required(args, 'current-main-sha'),
        producerHeadSha: required(args, 'producer-head-sha'),
        now: required(args, 'now'),
      })
      if (verification.status === 'hold') throw new Error(`${verification.code}: ${verification.message}`)
      console.log(`BAYN_PAPER_ACTIVATION_REQUEST_VERIFIED ${verification.request.requestHash}`)
    } else if (args.mode === 'render-request-transition') {
      const request = decodeRequest(jsonFile(required(args, 'request')))
      if (request._tag === 'Failure') throw new Error(`${request.code}: ${request.message}`)
      const rendered = renderPaperActivationRequestTransition(
        readFileSync(required(args, 'deployment'), 'utf8'),
        request.value,
      )
      writeFileSync(required(args, 'request-output'), rendered.requestDeployment)
      writeFileSync(required(args, 'rollback-output'), rendered.rollbackDeployment)
      console.log('BAYN_PAPER_ACTIVATION_REQUEST_TRANSITION_RENDERED')
    } else {
      throw new Error('unsupported mode')
    }
  } catch (error) {
    console.error(
      `BAYN_PAPER_ACTIVATION_HOLD verifier-error: ${error instanceof Error ? error.message : 'unknown error'}`,
    )
    process.exitCode = 1
  }
}
