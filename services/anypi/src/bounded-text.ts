// Bounded transcript accumulator for AnyPi
// Preserves the latest assistant output tail when truncation is needed
// without encoding the full transcript on every token or every append

export type BoundedTextOptions = {
  /**
   * Maximum size in bytes before truncation occurs
   * Default: 4 * 1024 * 1024 (4 MiB)
   * Hard limit: 16 * 1024 * 1024 (16 MiB)
   */
  maxSize?: number
}

/**
 * BoundedText accumulator that preserves the tail when truncation is needed
 */
export class BoundedText {
  private readonly maxSize: number
  private chunks: string[]
  private totalSize: number
  private tail: string
  private tailSize: number

  constructor(options: BoundedTextOptions = {}) {
    this.maxSize = options.maxSize ?? 4 * 1024 * 1024 // 4 MiB default
    // Hard limit: 16 MiB
    if (this.maxSize > 16 * 1024 * 1024) {
      throw new Error(`maxSize exceeds hard limit of 16 MiB: ${this.maxSize}`)
    }
    if (this.maxSize <= 0) {
      throw new Error(`maxSize must be positive: ${this.maxSize}`)
    }

    this.chunks = []
    this.totalSize = 0
    this.tail = ''
    this.tailSize = 0
  }

  /**
   * Append text to the accumulator
   * Truncates the oldest content if maxSize would be exceeded
   * @param text Text to append
   */
  append(text: string): void {
    if (!text) return

    const textBytes = encodeTextLength(text)
    this.chunks.push(text)
    this.totalSize += textBytes

    // Update tail with the newly appended text
    this.tail = text
    this.tailSize = textBytes

    // Truncate if over maxSize
    while (this.totalSize > this.maxSize && this.chunks.length > 1) {
      const oldest = this.chunks.shift()
      if (!oldest) break
      this.totalSize -= encodeTextLength(oldest)
    }

    // After truncation, rebuild tail from remaining chunks
    this.rebuildTail()
  }

  /**
   * Append text at the beginning (for prepend operations)
   * @param text Text to prepend
   */
  prepend(text: string): void {
    if (!text) return

    const textBytes = encodeTextLength(text)
    this.chunks.unshift(text)
    this.totalSize += textBytes

    // Update tail
    this.tail = text
    this.tailSize = textBytes

    // Truncate if over maxSize
    while (this.totalSize > this.maxSize && this.chunks.length > 1) {
      const newest = this.chunks.pop()
      if (!newest) break
      this.totalSize -= encodeTextLength(newest)
    }

    // After truncation, rebuild tail from remaining chunks
    this.rebuildTail()
  }

  /**
   * Get the current accumulated text
   * Uses tail when available for efficiency
   */
  toString(): string {
    if (this.chunks.length === 0) return ''
    if (this.chunks.length === 1) return this.chunks[0]
    // Only join when multiple chunks (should be rare after truncation)
    return this.chunks.join('')
  }

  /**
   * Get the current accumulated text length in bytes
   */
  size(): number {
    return this.totalSize
  }

  /**
   * Get the tail (last portion) of the accumulated text
   * This is efficient and doesn't require joining all chunks
   */
  getTail(): string {
    if (this.chunks.length === 0) return ''
    if (this.chunks.length === 1) return this.chunks[0]
    return this.tail
  }

  /**
   * Get the number of chunks stored
   */
  chunkCount(): number {
    return this.chunks.length
  }

  /**
   * Clear all accumulated text
   */
  clear(): void {
    this.chunks = []
    this.totalSize = 0
    this.tail = ''
    this.tailSize = 0
  }

  /**
   * Rebuild the tail from the current chunks
   * Called after truncation to ensure tail is accurate
   */
  private rebuildTail(): void {
    if (this.chunks.length === 0) {
      this.tail = ''
      this.tailSize = 0
      return
    }

    // Start from the end and find a reasonable tail
    // We want to keep the tail manageable in size
    let tailChunks: string[] = []
    let tailSize = 0
    const targetTailSize = Math.min(this.maxSize / 4, 256 * 1024) // Up to 256 KiB for tail

    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const chunk = this.chunks[i]
      const chunkSize = encodeTextLength(chunk)
      if (tailSize + chunkSize > targetTailSize && tailChunks.length > 0) {
        break
      }
      tailChunks.unshift(chunk)
      tailSize += chunkSize
    }

    this.tail = tailChunks.join('')
    this.tailSize = tailSize
  }
}

/**
 * Efficiently estimate the byte length of a string
 * Uses UTF-8 encoding without creating intermediate Buffer objects
 */
export function encodeTextLength(text: string): number {
  let length = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) {
      length += 1
    } else if (code < 0x800) {
      length += 2
    } else if (code < 0xd800 || code >= 0xe000) {
      length += 3
    } else {
      // Surrogate pair
      i++
      length += 4
    }
  }
  return length
}

/**
 * Create a bounded text accumulator with default 4 MiB limit
 */
export const createBoundedText = (options?: BoundedTextOptions): BoundedText => new BoundedText(options)

/**
 * Hard limit for bounded text size (16 MiB)
 */
export const BOUNDED_TEXT_HARD_LIMIT = 16 * 1024 * 1024

/**
 * Default bounded text size limit (4 MiB)
 */
export const BOUNDED_TEXT_DEFAULT_LIMIT = 4 * 1024 * 1024
