export const frozenLatencyHooksPath = 'services/bayn/frozen-latency-hooks.ts'

export const frozenLatencyHooks = String.raw`
import { Clock, Effect, Schema } from 'effect'
import { ReplayBrokerFailure } from './src/intraday-replay/broker'
import { canonicalHashV1Result } from './src/hash'
let floorMs: number | undefined
let active: { issuedAt: number; startedAt: number; advanceTo: (ms:number)=>Effect.Effect<void,ReplayBrokerFailure> } | undefined
const receipts: {kind: 'DECISION' | 'CLOSE'; decisionHash:string; decisionAt:string; commandIssuedAt:string; completedAt:string; releaseFloorAt:string; releasedAt:string}[]=[]
let opening: {createdAt:string; state:unknown} | undefined
export const recordOpening=(state:unknown)=>Effect.gen(function*(){
 if(opening!==undefined) return yield* new ReplayBrokerFailure({message:'Frozen broker cannot be constructed twice'})
 opening={createdAt:new Date(yield* Clock.currentTimeMillis).toISOString(),state}
})
export const configure = (value: unknown) => Effect.gen(function*(){
 if(floorMs!==undefined) return yield* new ReplayBrokerFailure({message:'Frozen calibration cannot be replaced'})
 const input=yield* Schema.decodeUnknownEffect(Schema.Struct({p95FullBatchMs:Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))}))(value)
 floorMs=input.p95FullBatchMs
})
export const command = <A,E,R>(work:Effect.Effect<A,E,R>, issuedAt:number,advanceTo:(ms:number)=>Effect.Effect<void,ReplayBrokerFailure>)=>Effect.gen(function*(){
 if(floorMs===undefined||active!==undefined) return yield* new ReplayBrokerFailure({message:'Frozen latency command has no calibration or overlaps another command'})
 active={issuedAt,startedAt:performance.now(),advanceTo}
 return yield* work.pipe(Effect.ensuring(Effect.sync(()=>{active=undefined})))
})
export const release = (kind:'DECISION'|'CLOSE',decisionHash:string,decisionAt:string)=>Effect.gen(function*(){
 const context=active
 if(context===undefined||floorMs===undefined) return yield* new ReplayBrokerFailure({message:'Frozen decision has no original command'})
 const now=yield* Clock.currentTimeMillis
 const actualCompletedAt=Math.max(now,context.issuedAt+Math.ceil(performance.now()-context.startedAt))
 const releaseFloorAt=context.issuedAt+floorMs
 const releasedAt=Math.max(actualCompletedAt,releaseFloorAt)
 if(!Number.isSafeInteger(releasedAt))return yield* new ReplayBrokerFailure({message:'Frozen decision latency exceeds safe clock bounds'})
 yield* context.advanceTo(releasedAt)
 receipts.push({kind,decisionHash,decisionAt,commandIssuedAt:new Date(context.issuedAt).toISOString(),completedAt:new Date(actualCompletedAt).toISOString(),releaseFloorAt:new Date(releaseFloorAt).toISOString(),releasedAt:new Date(releasedAt).toISOString()})
})
export const evidence=()=>({p95FullBatchMs:floorMs,receipts,opening})
`
export const instrumentFrozenControlModule = (path: string, raw: string) => {
  const one = (before: string, after: string) => {
    if (raw.split(before).length !== 2) throw Error('Frozen hook anchor mismatch: ' + path + ' ' + before)
    raw = raw.replace(before, after)
  }
  if (path === 'services/bayn/src/cycle/store/postgres.ts') {
    one('export const withWriterFenceCycleStore =', 'const originalWithWriterFenceCycleStore =')
    raw += `\nimport { release as releaseFrozen } from '/bayn-frozen-control/${frozenLatencyHooksPath}'\nexport const withWriterFenceCycleStore=(store:CycleStoreShape,fence:WriterFenceService):CycleStoreShape=>{const fenced=originalWithWriterFenceCycleStore(store,fence);return {...fenced,bindDecision:(...args)=>fenced.bindDecision(...args).pipe(Effect.tap(()=>releaseFrozen('DECISION',args[1].contentHash,args[1].createdAt).pipe(Effect.mapError(cause=>cycleStoreError({operation:'bind-decision',failure:'query',message:'Frozen latency release failed',cause})))))} }\n`
  }
  if (path === 'services/bayn/src/db/execution-cycle-closure-postgres.ts') {
    one(
      '  return store\n',
      "  return {...store, bind:(closure)=>store.bind(closure).pipe(Effect.tap(()=>releaseFrozen('CLOSE',closure.contentHash,closure.createdAt).pipe(Effect.mapError(cause=>storeError('bind','query','Frozen latency release failed',cause))))), bindReplan:(closure)=>store.bindReplan(closure).pipe(Effect.tap(()=>releaseFrozen('CLOSE',closure.contentHash,closure.createdAt).pipe(Effect.mapError(cause=>storeError('bind-replan','query','Frozen latency release failed',cause)))))}\n",
    )
    raw += `\nimport { release as releaseFrozen } from '/bayn-frozen-control/${frozenLatencyHooksPath}'\n`
  }
  if (path === 'services/bayn/src/intraday-replay/session.ts') {
    one(
      '      yield* advanceTo(scheduledAtMs)\n      const pass = yield* runtime.advance',
      '      const pass = yield* frozenCommand(advanceTo(scheduledAtMs).pipe(Effect.andThen(runtime.advance)),scheduledAtMs,advanceTo)',
    )
    raw += `\nimport { command as frozenCommand } from '/bayn-frozen-control/${frozenLatencyHooksPath}'\n`
  }
  if (path === 'services/bayn/src/intraday-replay/broker.ts') {
    one(
      '    const retentionFailure = yield* Ref.make<ReplayBrokerFailure | undefined>(undefined)',
      '    yield* recordFrozenOpening(yield* SynchronizedRef.get(state))\n    const retentionFailure = yield* Ref.make<ReplayBrokerFailure | undefined>(undefined)',
    )
    raw += `\nimport { recordOpening as recordFrozenOpening } from '/bayn-frozen-control/${frozenLatencyHooksPath}'\n`
  }
  if (path === 'services/bayn/src/backtest-command.ts') {
    one("'Usage: bayn-backtest", "'Usage: bayn-frozen-control-backtest")
    one(
      '    const prepared = yield* Effect.fromResult(prepareBacktest(parsed, sourceReceipt))',
      "    const bound=validateFrozenRequest(parsed,sourceReceiptText,args.sourceReceiptHash)\n    if(!bound.ok) return yield* new BacktestCommandFailure({message:bound.message})\n    const envelope=bound.value\n    yield* configureFrozen(envelope.input.latencyStress)\n    const prepared = yield* Effect.fromResult(prepareBacktest(envelope.input.backtest, sourceReceipt))\n    if(prepared.runId!==envelope.engineRunId) return yield* new BacktestCommandFailure({message:'Original engine input identity differs from registered replay'})",
    )
    one(
      '      operationTimeoutMs: 30_000,',
      '      operationTimeoutMs: envelope.stress.registration.obligations.configuration.operationTimeoutMs,',
    )
    one(
      '      ...reportBody,',
      "      ...reportBody,\n      schemaVersion:'bayn.frozen-control-latency-report.v1',\n      engineRunId:prepared.runId,\n      runId:envelope.runId,\n      executableSha256:sha256(yield* fs.readFile(fileURLToPath(import.meta.url))),\n      frozenProtocol: prepared.protocol,\n      frozenLatency: frozenEvidence(),\n      frozenRequest: parsed,",
    )
    raw += `\nimport { configure as configureFrozen, evidence as frozenEvidence } from '/bayn-frozen-control/${frozenLatencyHooksPath}'\n`
    raw += `\nimport {fileURLToPath} from 'node:url'\nimport {validateFrozenRequest} from '/bayn-current-frozen-boundary'\n`
  }
  return raw
}
