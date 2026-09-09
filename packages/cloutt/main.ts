import * as fs from 'node:fs'
import * as path from 'node:path'
import { App, YamlOutputType } from 'cdk8s'
import { KustomizationBase } from './kustomization/base'
import { RootKustomization } from './kustomization/root'

/**
 * Removes the dist directory if it exists
 */
function cleanupDist(directory: string): void {
  if (fs.existsSync(directory)) {
    console.log(`Cleaning up ${directory}...`)
    // Remove directory recursively
    fs.rmSync(directory, { recursive: true, force: true })
    console.log(`Removed ${directory}`)
  }
}

/**
 * Renames files to lowercase and removes "reviseur" from the names
 */
function renameFiles(directory: string): void {
  // Read all files and directories in the given directory
  const items = fs.readdirSync(directory)

  for (const item of items) {
    const fullPath = path.join(directory, item)
    const stats = fs.statSync(fullPath)

    if (stats.isDirectory()) {
      // Recursively process subdirectories
      renameFiles(fullPath)
    } else if (stats.isFile() && item.endsWith('.yaml')) {
      // Process only YAML files
      const newName = item
        .replace(/\.reviseur\.yaml$/i, '.yaml') // Remove 'reviseur' from the name
        .toLowerCase() // Convert to lowercase

      if (newName !== item) {
        const newPath = path.join(directory, newName)
        fs.renameSync(fullPath, newPath)
        console.log(`Renamed: ${fullPath} -> ${newPath}`)
      }
    }
  }
}

if (require.main === module) {
  const distDir = path.resolve(__dirname, 'dist')

  // Clean up dist directory before generating new files
  cleanupDist(distDir)

  const kustomizationManifest = new App({
    outputFileExtension: '.yaml',
    yamlOutputType: YamlOutputType.FILE_PER_RESOURCE,
  })

  const appName = 'reviseur'

  // Create root kustomization file, include overlays
  new RootKustomization(kustomizationManifest, 'root-kustomization', {
    overlays: ['overlays/dev'],
    name: appName,
  })
  kustomizationManifest.synth()

  // Add base overlay with its own kustomization file
  const overlays = new App({
    outdir: 'dist/base',
    outputFileExtension: '.yaml',
    yamlOutputType: YamlOutputType.FILE_PER_RESOURCE,
  })
  new KustomizationBase(overlays, 'base', {
    name: appName,
    replicas: 1,
    image: 'registry.ide-newton.ts.net/lab/reviseur',
    containerPort: 3000,
    cpuRequest: 100,
    cpuLimit: 1000,
    memoryRequest: 512,
    memoryLimit: 1024,
  })
  overlays.synth()

  // Create dev overlay in the separate directory
  const devOverlay = new App({
    outdir: 'dist/overlays/dev',
    outputFileExtension: '.yaml',
    yamlOutputType: YamlOutputType.FILE_PER_RESOURCE,
  })
  new KustomizationBase(devOverlay, 'dev', {
    name: appName,
    replicas: 1,
    image: 'registry.ide-newton.ts.net/lab/reviseur',
    containerPort: 3000,
    cpuRequest: 100,
    cpuLimit: 1000,
    memoryRequest: 512,
    memoryLimit: 1024,
  })
  devOverlay.synth()

  // Rename files in all generated directories
  console.log('Renaming manifest files...')
  renameFiles(distDir)
  console.log('File renaming complete')
}
