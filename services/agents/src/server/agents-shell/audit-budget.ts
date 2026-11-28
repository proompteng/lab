// Admission is checked before masking, serialization or frame arrays allocate copies of a payload.
export const AUDIT_EVENT_BYTE_BUDGET = 8 * 1024 * 1024
export const AUDIT_EVENT_NODE_BUDGET = 65_536
export const AUDIT_EVENT_DEPTH_BUDGET = 64

export const auditPayloadBudget = (payload: unknown) => {
  let observedBytes = 0
  let visitedNodes = 0
  let inspectedKeyBytes = 0
  let reason: string | null = null
  const ancestors = new Set<object>()
  const add = (bytes: number) => {
    observedBytes += bytes
    if (observedBytes > AUDIT_EVENT_BYTE_BUDGET) reason = 'event_byte_budget_exceeded'
  }
  const string = (value: string) => {
    add(Buffer.byteLength(value) + 2)
    if (reason) return
    for (let i = 0; i < value.length && !reason; i += 1) {
      const code = value.charCodeAt(i)
      if (code === 34 || code === 92) add(1)
      else if (code < 32) add([8, 9, 10, 12, 13].includes(code) ? 1 : 5)
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(i + 1)
        if (next >= 0xdc00 && next <= 0xdfff) i += 1
        else add(3)
      } else if (code >= 0xdc00 && code <= 0xdfff) add(3)
    }
  }
  const visit = (value: unknown, depth: number) => {
    if (reason) return
    visitedNodes += 1
    if (visitedNodes > AUDIT_EVENT_NODE_BUDGET) {
      reason = 'event_node_budget_exceeded'
      return
    }
    if (depth > AUDIT_EVENT_DEPTH_BUDGET) {
      reason = 'event_depth_budget_exceeded'
      return
    }
    if (typeof value === 'string') {
      string(value)
      return
    }
    if (value === null || value === undefined) {
      add(4)
      return
    }
    if (typeof value === 'boolean') {
      add(value ? 4 : 5)
      return
    }
    if (typeof value === 'number') {
      add(String(Number.isFinite(value) ? value : null).length)
      return
    }
    if (typeof value !== 'object') {
      reason = 'unsupported_event_value'
      return
    }
    if (ancestors.has(value)) {
      reason = 'cyclic_event_value'
      return
    }
    ancestors.add(value)
    add(2)
    let first = true
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        reason = 'unsupported_event_prototype'
        return
      }
      for (let i = 0; i < value.length && !reason; i += 1) {
        if (!first) add(1)
        first = false
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i))
        if (descriptor && !('value' in descriptor)) {
          reason = 'unsupported_event_accessor'
          break
        }
        visit(descriptor?.value, depth + 1)
      }
    } else {
      const prototype = Object.getPrototypeOf(value)
      if (prototype !== null && prototype !== Object.prototype) {
        reason = 'unsupported_event_prototype'
        return
      }
      for (const key in value) {
        if (reason) break
        visitedNodes += 1
        if (visitedNodes > AUDIT_EVENT_NODE_BUDGET) {
          reason = 'event_node_budget_exceeded'
          break
        }
        if (!Object.hasOwn(value, key) || key === '_meta') continue
        inspectedKeyBytes += Buffer.byteLength(key)
        if (inspectedKeyBytes > AUDIT_EVENT_BYTE_BUDGET) {
          reason = 'event_key_budget_exceeded'
          break
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor || !('value' in descriptor)) {
          reason = 'unsupported_event_accessor'
          break
        }
        if (descriptor.value === undefined) {
          // It will be omitted by JSON, but inspecting/copying keys must still have a finite work budget.
          continue
        }
        if (!first) add(1)
        first = false
        string(key)
        add(1)
        visit(descriptor.value, depth + 1)
      }
    }
    ancestors.delete(value)
  }
  visit(payload, 0)
  return {
    accepted: reason === null,
    reason: reason as string | null,
    observedBytesLowerBound: observedBytes,
    visitedNodes,
    inspectedKeyBytes,
    byteBudget: AUDIT_EVENT_BYTE_BUDGET,
    nodeBudget: AUDIT_EVENT_NODE_BUDGET,
    depthBudget: AUDIT_EVENT_DEPTH_BUDGET,
  }
}
