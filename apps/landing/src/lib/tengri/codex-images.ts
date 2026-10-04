export const MAX_CODEX_IMAGES = 4
export const MAX_CODEX_IMAGE_BYTES = 4 * 1024 * 1024
export const MAX_CODEX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024
export const CODEX_IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export type TengriCodexImage = { mediaType: (typeof CODEX_IMAGE_MEDIA_TYPES)[number]; data: string }

export function codexImageMatchesMediaType(mediaType: string, bytes: Uint8Array): boolean {
  if (mediaType === 'image/png') {
    return [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
  }
  if (mediaType === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  if (mediaType === 'image/webp') {
    return (
      [82, 73, 70, 70].every((value, index) => bytes[index] === value) &&
      [87, 69, 66, 80].every((value, index) => bytes[index + 8] === value)
    )
  }
  return false
}

export async function readCodexImage(file: File): Promise<TengriCodexImage> {
  const mediaType = CODEX_IMAGE_MEDIA_TYPES.find((type) => type === file.type)
  if (!mediaType) throw new Error('Paste a PNG, JPEG, or WebP image.')
  if (!file.size || file.size > MAX_CODEX_IMAGE_BYTES) throw new Error('Each image must be at most 4 MiB.')
  if (!codexImageMatchesMediaType(mediaType, new Uint8Array(await file.slice(0, 16).arrayBuffer()))) {
    throw new Error('The pasted image does not match its image format.')
  }
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('The image could not be read. Paste it again.'))
    reader.onload = () =>
      typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('The image could not be read.'))
    reader.readAsDataURL(file)
  })
  return { mediaType, data: url.slice(url.indexOf(',') + 1) }
}

export function codexImageUrl(image: TengriCodexImage): string {
  return `data:${image.mediaType};base64,${image.data}`
}
