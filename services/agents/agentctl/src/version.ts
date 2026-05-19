import pkg from '../package.json'

type PackageJson = {
  version?: string
}

const packageJson = pkg as PackageJson

export const PACKAGE_VERSION = packageJson.version ?? 'dev'
