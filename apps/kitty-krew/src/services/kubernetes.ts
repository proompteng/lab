import { promises as fsPromises } from 'node:fs'
import * as k8s from '@kubernetes/client-node'
import type { Pod } from '~/common/schemas/pod.ts'
import { logger } from '~/utils/logger.ts'

/**
 * Loads and configures the self-signed certificate for the Kubernetes client
 * @param kc The KubeConfig instance to configure
 */
async function configureSelfSignedCertificate(kc: k8s.KubeConfig): Promise<void> {
  const certPath = process.env.K8S_CERT_PATH || '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt'

  try {
    logger.info(`Checking for certificate at ${certPath}`)
    await fsPromises.access(certPath)
  } catch (_err) {
    logger.warn(`Certificate file not found at ${certPath}`)
    return
  }

  logger.info(`Certificate file found at ${certPath}`)
  const cluster = kc.getCurrentCluster()
  if (!cluster) {
    logger.warn('No current cluster found in KubeConfig')
    return
  }

  cluster.caFile = certPath

  try {
    const cert = await fsPromises.readFile(certPath, 'utf8')
    logger.info('Certificate loaded successfully')

    const currentContext = kc.getCurrentContext()
    const contextObject = kc.getContextObject(currentContext)

    if (!contextObject?.cluster) {
      logger.warn('No cluster found in current context')
      return
    }

    const existingCluster = kc.getCluster(contextObject.cluster)
    if (!existingCluster) {
      logger.warn(`Cluster ${contextObject.cluster} not found in KubeConfig`)
      return
    }

    // Create a new cluster config with the updated CA data
    const updatedCluster = {
      ...existingCluster,
      caData: cert,
    }

    // Remove the existing cluster and add the updated one
    kc.clusters = kc.clusters.filter((c) => c.name !== contextObject.cluster)
    kc.addCluster(updatedCluster)
    logger.info(`Updated CA data for cluster: ${contextObject.cluster}`)
  } catch (err) {
    logger.error(`Failed to read certificate from ${certPath}:`, err)
    // Continue with existing configuration
  }
}

/**
 * Creates and configures a Kubernetes API client
 * @returns A configured Kubernetes CoreV1Api client
 */
export async function createK8sClient(): Promise<k8s.CoreV1Api> {
  const kc = new k8s.KubeConfig()

  try {
    // Check environment to use appropriate config loading
    if (process.env.NODE_ENV === 'production') {
      logger.info('Loading Kubernetes config from cluster')
      kc.loadFromCluster()

      // Configure self-signed certificate if available
      await configureSelfSignedCertificate(kc)
    } else {
      logger.info('Loading Kubernetes config from default settings')
      kc.loadFromDefault()
    }

    logger.info('Creating Kubernetes API client')
    return kc.makeApiClient(k8s.CoreV1Api)
  } catch (error) {
    logger.error('Failed to create Kubernetes client:', error)
    throw error
  }
}

/**
 * Transforms a Kubernetes pod object to our application's schema format
 * @param pod The Kubernetes pod object
 * @returns A transformed pod object matching our schema
 */
export function transformPodData(pod: k8s.V1Pod): Pod {
  // Process the creation timestamp to match our schema
  let creationTimestamp: Date | undefined
  if (pod.metadata?.creationTimestamp) {
    creationTimestamp = new Date(pod.metadata.creationTimestamp)
  }

  return {
    metadata: {
      name: pod.metadata?.name || '',
      namespace: pod.metadata?.namespace || '',
      uid: pod.metadata?.uid || '',
      creationTimestamp,
    },
    status: {
      phase: pod.status?.phase || '',
      podIp: pod.status?.podIP || '',
      hostIp: pod.status?.hostIP || '',
    },
    spec: {
      nodeName: pod.spec?.nodeName || '',
      containers:
        pod.spec?.containers?.map((container) => ({
          name: container.name,
          image: container.image || '',
          ports: container.ports?.map((port) => ({
            containerPort: port.containerPort,
            protocol: port.protocol,
          })),
        })) || [],
    },
  }
}
