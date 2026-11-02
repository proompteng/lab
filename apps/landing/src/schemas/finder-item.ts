import { z } from 'zod'

const utf8Encoder = new TextEncoder()

export const finderItemFormSchema = z.strictObject({
  name: z
    .string()
    .refine((value) => value.trim().length > 0, 'Enter a name')
    .refine((value) => value !== '.' && value !== '..', 'Use a different name')
    .refine(
      (value) => !value.includes('/') && !value.includes('\0') && !value.includes('\r') && !value.includes('\n'),
      'Names cannot contain “/” or line breaks',
    )
    .refine((value) => utf8Encoder.encode(value).byteLength <= 255, 'Use a name no longer than 255 UTF-8 bytes'),
})

export type FinderItemFormValues = z.infer<typeof finderItemFormSchema>
