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
   * When a single chunk exceeds maxSize, retains the tail of that chunk
   * @param text Text to append
   */
  append(text: string): void {
    if (!text) return

    const textBytes = encodeTextLength(text)
    this.chunks.push(text)
    this.totalSize += textBytes

    // If a single chunk exceeds maxSize, truncate it to keep the tail
    if (textBytes > this.maxSize) {
      this.chunks = [text]
      this.totalSize = this.maxSize
      // Keep the tail of the chunk (last maxSize bytes worth of characters)
      this.chunks[0] = this.truncateTextToSize(text, this.maxSize)
    }

    // Truncate if still over maxSize (handles multiple chunks case)
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

    // If a single chunk exceeds maxSize, truncate it to keep the tail
    if (textBytes > this.maxSize) {
      this.chunks = [text]
      this.totalSize = this.maxSize
      // Keep the tail of the chunk (last maxSize bytes worth of characters)
      this.chunks[0] = this.truncateTextToSize(text, this.maxSize)
    }

    // Truncate if still over maxSize (handles multiple chunks case)
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
   * Uses full retained text when within maxSize for accuracy
   * Uses tail when available for efficiency when joining is needed
   */
  toString(): string {
    if (this.chunks.length === 0) return ''
    if (this.chunks.length === 1) return this.chunks[0]
    // For multiple chunks, return the full text for accuracy
    // Tail is handled separately via getTail() which is used for PR/status updates
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
   * When retained text is within maxSize, returns the full accumulated text
   * When truncation has occurred, returns an efficient representation
   * This avoids joining all chunks on every token append
   */
  getTail(): string {
    // If text is within maxSize, return full retained text for accuracy
    if (this.totalSize <= this.maxSize) {
      if (this.chunks.length === 0) return ''
      if (this.chunks.length === 1) return this.chunks[0]
      return this.chunks.join('')
    }
    // When truncated, use the efficient tail
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
   * Truncate text to fit within a byte size limit
   * Keeps the tail of the text (last portion)
   */
  private truncateTextToSize(text: string, maxBytes: number): string {
    // Calculate total byte size
    const totalBytes = encodeTextLength(text)

    // If already within limit, return as-is
    if (totalBytes <= maxBytes) {
      return text
    }

    // Find the starting index for the tail that fits
    let byteCount = 0
    let startIndex = 0

    for (let i = text.length - 1; i >= 0; i--) {
      const code = text.charCodeAt(i)
      let charBytes: number
      if (code < 0x80) {
        charBytes = 1
      } else if (code < 0x800) {
        charBytes = 2
      } else if (code < 0xd800 || code >= 0xe000) {
        charBytes = 3
      } else {
        // Surrogate pair - need to skip the lead surrogate
        if (
          i > 0 &&
          code >= 0xd800 &&
          code < 0xdc00 &&
          text.charCodeAt(i - 1) >= 0xdc00 &&
          text.charCodeAt(i - 1) < 0xe000
        ) {
          i--
          charBytes = 4
        } else {
          charBytes = 3
        }
      }

      if (byteCount + charBytes > maxBytes) {
        break
      }
      byteCount += charBytes
      startIndex = i
    }

    return text.substring(startIndex)
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
