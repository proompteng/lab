const frozen = new WeakSet<object>()

export const freezeEvidence = <A>(value: A): A => {
  if (typeof value === 'object' && value !== null && !frozen.has(value)) {
    for (const item of Object.values(value)) freezeEvidence(item)
    Object.freeze(value)
    frozen.add(value)
  }
  return value
}
