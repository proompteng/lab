import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { postgresAdapter } from '@payloadcms/db-postgres'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { buildConfig } from 'payload'
import sharp from 'sharp'

import { Media } from './collections/media'
import { Users } from './collections/users'
import Landing from './globals/landing'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)
const landingSiteUrl = process.env.LANDING_SITE_URL ?? 'http://localhost:3000'
const serverUrl = process.env.PAYLOAD_PUBLIC_SERVER_URL ?? 'http://localhost:3001'
const payloadSecret = process.env.PAYLOAD_SECRET

if (!payloadSecret) {
  throw new Error('PAYLOAD_SECRET is required to start the CMS.')
}

const allowedOrigins = Array.from(new Set([landingSiteUrl, serverUrl]))

export default buildConfig({
  admin: {
    user: Users.slug,
    importMap: {
      baseDir: path.resolve(dirname),
    },
  },
  collections: [Users, Media],
  globals: [Landing],
  editor: lexicalEditor(),
  secret: payloadSecret,
  serverURL: serverUrl,
  cors: allowedOrigins,
  csrf: allowedOrigins,
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
  db: postgresAdapter({
    pool: {
      connectionString: process.env.DATABASE_URL ?? '',
    },
  }),
  sharp,
  plugins: [],
})
