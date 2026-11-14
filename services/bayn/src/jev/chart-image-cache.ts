export interface ChartImage {
  readonly pngHash: string
  readonly image: string
}

/** Bound retained string storage and entry overhead independently of source history length. */
export class ChartImageCache {
  readonly #images = new Map<string, { readonly value: ChartImage; readonly bytes: number }>()
  #retainedBytes = 0

  constructor(
    readonly maximumEntries: number,
    readonly maximumStringBytes: number,
  ) {
    if (
      !Number.isSafeInteger(maximumEntries) ||
      maximumEntries < 1 ||
      !Number.isSafeInteger(maximumStringBytes) ||
      maximumStringBytes < 1
    )
      throw new RangeError('Chart cache bounds must be positive safe integers')
  }

  get(key: string): ChartImage | undefined {
    return this.#images.get(key)?.value
  }

  set(key: string, value: ChartImage): void {
    const existing = this.#images.get(key)
    if (existing !== undefined) {
      this.#retainedBytes -= existing.bytes
      this.#images.delete(key)
    }
    // Two bytes per character conservatively charges UTF-16 string content; the entry cap bounds map overhead.
    const bytes = 2 * (key.length + value.pngHash.length + value.image.length)
    if (bytes > this.maximumStringBytes) return
    while (this.#images.size >= this.maximumEntries || this.#retainedBytes + bytes > this.maximumStringBytes) {
      const oldest = this.#images.entries().next().value
      if (oldest === undefined) break
      this.#images.delete(oldest[0])
      this.#retainedBytes -= oldest[1].bytes
    }
    this.#images.set(key, { value: Object.freeze({ ...value }), bytes })
    this.#retainedBytes += bytes
  }
}
