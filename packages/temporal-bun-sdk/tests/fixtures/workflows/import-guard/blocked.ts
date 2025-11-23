import fs from 'node:fs'
import './nested/crypto-import'

export const listFiles = () => fs.readdirSync('.')
