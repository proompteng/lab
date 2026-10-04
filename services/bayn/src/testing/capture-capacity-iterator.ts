export const observeConsumedRecords = <A>(
  source: AsyncIterable<A>,
  observed: (record: A) => void,
): AsyncIterable<A> => ({
  [Symbol.asyncIterator]() {
    const iterator = source[Symbol.asyncIterator]()
    let delivered: IteratorResult<A> | undefined
    return {
      next: async () => {
        const previous = delivered
        delivered = undefined
        if (previous !== undefined && previous.done !== true) observed(previous.value)
        delivered = await iterator.next()
        return delivered
      },
      return: () => {
        delivered = undefined
        return iterator.return?.() ?? Promise.resolve({ done: true, value: undefined })
      },
    }
  },
})
