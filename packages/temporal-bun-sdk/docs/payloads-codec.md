# Payload Codec & Data Conversion Guide

**Status Snapshot (27 Oct 2025)**  
- ✅ All client RPCs currently send plain JSON payloads (`args`, `memo`, `headers`, etc.) constructed in `src/client/serialization.ts`. The Zig bridge encodes the final Temporal protobuf structures.  
- ❌ No `DataConverter` abstraction exists yet. There is no pluggable codec registry comparable to Temporal’s `DefaultDataConverter`.  
- ❌ Activity/workflow failure payloads are passed through as-is from Temporal core; Bun does not yet encode/decode structured failures.  
- ⚠️ Docs and TODO markers reference a future payload codec module; work has not begun. This guide explains the desired end state while documenting the current behaviour so the mismatch is obvious.

---

## 1. Current Behaviour

- Workflow/activity arguments are forwarded as JSON-compatible values.  
- Signal/query payloads are stringified via `JSON.stringify` when required (see `computeSignalRequestId` and `buildSignalRequest`).  
- Temporal core performs payload encoding internally, so consumers see the same results as the upstream TypeScript SDK for simple JSON payloads.  
- Binary payloads, custom converters, and structured failure types are **not** supported yet; callers must manually encode base64 data if they need binary semantics today.

---

## 2. Target Architecture

Once we replace the ad-hoc JSON encoding, aim for a module layout like:

```
src/common/payloads/
  index.ts              // public exports
  converter.ts          // DataConverter implementation
  json-codec.ts         // default JSON codec (parity with upstream)
  binary-codec.ts       // optional protobuf codec (future)
  failure.ts            // error <-> failure payload helpers
```

Design goals:

- Match the TypeScript SDK’s `DataConverter` surface (`toPayloads`, `fromPayloads`, `toFailure`, `fromFailure`).  
- Allow users to register custom codecs without forking the SDK.  
- Preserve determinism by ensuring workflow replay sees identical payloads.  
- Keep Bun-specific dependencies (e.g. `Bun.Transpiler`) out of this module to facilitate reuse across worker/client code.

---

## 3. Incremental Plan

1. **Introduce JSON codec wrapper**  
   - Wrap the existing JSON behaviour in a `JsonPayloadCodec` class.  
   - Update client serialization helpers to rely on the codec for argument conversion.  
   - Add unit tests for round-trip encoding (`bun test`).

2. **Add converter entry point**  
   - Create `createDefaultDataConverter()` returning a converter with the JSON codec.  
   - Thread the converter through `createTemporalClient` options (without breaking current callers).  
   - Update signal/query tests to assert codec usage.

3. **Extend to failures**  
   - Implement `toFailure` / `fromFailure` mirroring the upstream `DefaultDataConverter`.  
   - Ensure activity/workflow failure payloads propagate correctly through the Zig bridge.

4. **Optional binary/protobuf support**  
   - Leverage `@temporalio/proto` already bundled in dependencies to support binary codecs.  
   - Provide documentation + samples on how to opt in.

5. **Worker integration**  
   - When the Bun-native worker arrives, share the same converter so workflows and activities respect custom codecs.

---

## 4. Testing Considerations

| Scenario | Tests |
|----------|-------|
| JSON round trip | `bun test` userland unit tests (primitives, objects, arrays, dates). |
| Failure conversion | Activity throws `ApplicationFailure`, verify payload fields survive round trip. |
| Binary codec (future) | Encode/decode `Uint8Array`, ensure encoding metadata present. |
| Integration | `tests/native.integration.test.ts` extended to run with custom converter once implemented. |

Ensure tests run under `TEMPORAL_TEST_SERVER=1` for integration coverage, and under plain unit tests for converter logic.

---

## 5. References

- Current serialization utilities: `src/client/serialization.ts`.  
- Temporal upstream documentation: [Data conversion](https://docs.temporal.io/visibility-and-data-conversion/data-conversion).  
- Upstream TypeScript source: `packages/common/src/converter/data-converter.ts` (Temporal repo).

Update this guide as soon as the codec module begins to take shape so contributors know the canonical plan and the current limitations.
