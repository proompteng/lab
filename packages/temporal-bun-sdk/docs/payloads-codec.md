# Payload Codec & Data Conversion Guide

**Status Snapshot (30 Oct 2025)**  
- DONE: Data conversion now ships with the Bun SDK via `src/common/payloads` and is re-exported from `src/index.ts`.  
- DONE: The client, workflow runtime, and worker runtime all accept a shared `dataConverter`, defaulting to Temporal's JSON converter when none is provided.  
- DONE: Payload metadata is tunnelled through the existing Zig bridge JSON surfaces using `__temporal_bun_payload__` envelopes so codec metadata is preserved without native changes.  
- TODO: optional binary/protobuf codecs and replay tooling that exercises non-JSON payloads at scale remain outstanding.

---

## 1. Module Overview

The Bun SDK mirrors the upstream Temporal TypeScript SDK's `DataConverter` contract. The module lives under `src/common/payloads` and provides:

- `createDataConverter`, `createDefaultDataConverter`: instantiate a `LoadedDataConverter` backed by Temporal's `DefaultPayloadConverter` and `DefaultFailureConverter` with optional codec overrides.
- JSON helpers (`encodeValuesToJson`, `decodeJsonToValues`, `encodeMapToJson`, `decodeJsonToMap`) that adapt converter payloads to the Zig bridge's current JSON expectations.
- Failure helpers `encodeFailurePayloads` / `decodeFailurePayloads` for round-tripping `temporal.api.failure.v1.Failure` protos through the converter.
- Pure JSON utilities (`jsonToPayload`, `payloadToJson`, `jsonToPayloads`, `payloadsToJson`) used by tests and adapters.

All exports are surfaced via `src/common/index.ts` and therefore publicly available from `@proompteng/temporal-bun-sdk/common`.

---

## 2. Default Converter Behaviour

`createDefaultDataConverter()` wraps Temporal's upstream defaults:

```ts
import { createDefaultDataConverter } from '@proompteng/temporal-bun-sdk/common'

const converter = createDefaultDataConverter()
const payloads = await converter.payloadConverter.toPayloads(['hello', { key: 1 }])
```

The surrounding helpers take care of:

- Returning `undefined` when no values are provided (matching Temporal's `encodeToPayloads` behaviour).
- Normalising empty maps to `{}` so the Zig bridge still receives an object, preserving backwards compatibility.
- Applying codec pipelines (`payloadConverter` -> `payloadCodecs`) automatically; custom codecs can be appended via the optional `payloadCodecs` array.

---

## 3. JSON Tunnel Compatibility

The Zig native bridge today still expects JSON payloads. To avoid losing metadata when non-JSON codecs run, the Bun SDK wraps encoded payloads in a tiny JSON tunnel structure:

```json
{
  "__temporal_bun_payload__": {
    "v": 1,
    "metadata": {
      "encoding": "anNvbi9wbGFpbg=="
    },
    "data": "eyJhIjoxfQ=="
  }
}
```

Key points:

- The sentinel property name is `__temporal_bun_payload__` (`PAYLOAD_TUNNEL_FIELD`).
- Metadata values and payload bytes are base64-encoded so the envelope remains plain JSON.
- When a payload uses `encoding=json/plain` and parses successfully as JSON, we pass the decoded value through directly (no tunnel) for parity with today's behaviour.
- On decode, the helper detects the envelope shape and reconstructs `temporal.api.common.v1.Payload` objects before handing control back to the converter.

This strategy keeps compatibility with the existing Zig layer while enabling deterministic hashing (the tunnel structure is what feeds into `computeSignalRequestId`).

---

## 4. API Cheatsheet

| Helper | Purpose |
|--------|---------|
| `encodeValuesToPayloads(converter, values)` | Wraps `converter.payloadConverter.toPayloads` and normalises empty lists. |
| `decodePayloadsToValues(converter, payloads)` | Inverse helper that returns decoded JS values or `[]`. |
| `encodeMapValuesToPayloads(converter, record)` | Converts string-keyed maps to payload maps, returning `{}` for empty maps. |
| `decodePayloadMapToValues(converter, payloadMap)` | Inverse helper that returns `undefined` for `null` payload maps. |
| `encodeValuesToJson(converter, values)` | Produces JSON-ready structures for the Zig bridge by encoding then tunnelling payload data. |
| `decodeJsonToValues(converter, values)` | Reverses `encodeValuesToJson`; useful for deterministic hashing and tests. |
| `encodeFailurePayloads(converter, failure)` | Ensures activity/workflow failures reuse the shared converter. |
| `decodeFailurePayloads(converter, failure)` | Converts Temporal failure payloads back into decoded JS values. |

See `src/common/payloads/converter.ts` and `failure.ts` for the full implementation.

---

## 5. Integration Points

- **Client**: `createTemporalClient` accepts an optional `dataConverter`. All request builders (`buildStartWorkflowRequest`, `buildSignalRequest`, `buildQueryRequest`, etc.) call `encodeValuesToJson` / `encodeMapToJson`. Query responses and signal IDs decode via the same converter.
- **Workflow runtime**: `WorkflowEnvironment` stores the converter per run. Workflow completions, continue-as-new commands, headers, memo, and search attributes are re-encoded before returning to the worker.
- **Worker runtime**: Activity inputs, heartbeats, and completions flow through converter helpers so custom codecs see the same payloads as workflows.
- **Native bridge**: `native.queryWorkflow` now surfaces raw payload bytes; the Bun layer is responsible for decoding them with the configured converter.

These touch-points mean providing a custom converter once (client or worker factory) is enough to keep payload semantics consistent across the stack.

---

## 6. Custom Codec Example

The tests include a `JsonEnvelopeCodec` that wraps payloads in an additional layer before handing them to Temporal core. To use a similar codec in production:

```ts
import { createDataConverter } from '@proompteng/temporal-bun-sdk/common'
import type { PayloadCodec } from '@temporalio/common'

class JsonEnvelopeCodec implements PayloadCodec {
  async encode(payloads) {
    const encoder = new TextEncoder()
    return payloads.map((payload) => ({
      metadata: {
        ...payload.metadata,
        encoding: encoder.encode('binary/custom'),
      },
      data: encoder.encode(JSON.stringify(payload)),
    }))
  }

  async decode(payloads) {
    const decoder = new TextDecoder()
    return payloads.map((payload) => {
      const encoding = payload.metadata?.encoding
        ? decoder.decode(payload.metadata.encoding)
        : undefined
      if (encoding !== 'binary/custom') {
        return payload
      }
      const raw = payload.data ? decoder.decode(payload.data) : 'null'
      return JSON.parse(raw)
    })
  }
}

const dataConverter = createDataConverter({
  payloadCodecs: [new JsonEnvelopeCodec()],
})

const { client } = await createTemporalClient({ dataConverter })
```

Because the converter is threaded through both the workflow runtime and the worker, activities, signals, and queries all observe the codec.

---

## 7. Failure Handling

`failure.ts` mirrors the upstream SDK's `DefaultFailureConverter` helpers so structured failures retain payload metadata:

- `encodeFailurePayloads` walks nested `Failure` protos (including activity and child workflow failures) to call `encodeValuesToPayloads` on each payload.
- `decodeFailurePayloads` does the reverse when failures are received from Temporal core.

Tests under `tests/payloads/failure.test.ts` confirm round-trips for application and activity failures, including tunneled metadata.

---

## 8. Testing Coverage

| Suite | Scenario |
|-------|----------|
| `tests/payloads/json-codec.test.ts` | JSON tunnel encode/decode parity, base64 metadata preservation. |
| `tests/payloads/converter.test.ts` | `encodeValuesToPayloads`, map helpers, and failure conversion helpers. |
| `tests/client.test.ts` | Deterministic `computeSignalRequestId` hashing against tunneled payloads. |
| `tests/worker.runtime.workflow.test.ts` | Workflow completions and continue-as-new commands re-encoding payloads via the converter. |
| `tests/native.integration.test.ts` | Full custom codec round trip against the Temporal dev server (requires `TEMPORAL_TEST_SERVER=1`). |

Run `pnpm exec biome check packages/temporal-bun-sdk/src packages/temporal-bun-sdk/tests packages/temporal-bun-sdk/docs` followed by `pnpm --filter @proompteng/temporal-bun-sdk test` to exercise the suites.

---

## 9. Follow-Ups

- Add binary/protobuf codecs once we settle on packaging for large payload types.  
- Build replay/determinism harness coverage for tunneled payloads to ensure history replays remain deterministic.  
- Investigate whether the Zig bridge can accept raw payload bytes in a future iteration, which would allow us to drop the JSON tunnel entirely.
