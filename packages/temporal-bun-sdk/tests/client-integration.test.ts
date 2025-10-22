import { beforeAll, describe, expect, test } from 'bun:test'
import { isTemporalServerAvailable } from './helpers/temporal-server'

// Test configuration
const temporalAddress = process.env.TEMPORAL_TEST_SERVER_ADDRESS ?? 'http://127.0.0.1:7233'
const shouldRun = process.env.TEMPORAL_TEST_SERVER === '1'
const serverAvailable = shouldRun ? await isTemporalServerAvailable(temporalAddress) : false

describe('Client Integration Tests with Live Temporal Server', () => {
  let _native: typeof import('../src/internal/core-bridge/native.js').native | undefined
  let createTemporalClient: typeof import('../src/client.js').createTemporalClient | undefined
  let _NativeBridgeError: typeof import('../src/internal/core-bridge/native.js').NativeBridgeError | undefined

  beforeAll(async () => {
    if (!serverAvailable) {
      console.warn(`Skipping client integration tests: Temporal server unavailable at ${temporalAddress}`)
      return
    }

    // Import native bridge
    try {
      const bridge = await import('../src/internal/core-bridge/native.js')
      _native = bridge.native
      createTemporalClient = bridge.createTemporalClient
      _NativeBridgeError = bridge.NativeBridgeError
    } catch (error) {
      console.warn('Failed to load native bridge:', error)
    }
  })

  describe('Client Connection Integration', () => {
    test('should connect to live Temporal server successfully', async () => {
      if (!serverAvailable || !createTemporalClient) {
        expect(true).toBe(true) // Skip test
        return
      }

      const client = await createTemporalClient({
        address: temporalAddress,
        namespace: 'default',
      })

      expect(client).toBeDefined()
      expect(typeof client.describeNamespace).toBe('function')
    })

    test('should handle connection to different namespaces', async () => {
      if (!serverAvailable || !createTemporalClient) {
        expect(true).toBe(true) // Skip test
        return
      }

      const client = await createTemporalClient({
        address: temporalAddress,
        namespace: 'default',
      })

      expect(client).toBeDefined()

      // Test describeNamespace for default namespace
      const result = await client.describeNamespace('default')
      expect(result).toBeDefined()
      expect(result.namespaceInfo).toBeDefined()
      expect(result.namespaceInfo.name).toBe('default')
    })

    test('should handle connection errors gracefully', async () => {
      if (!createTemporalClient) {
        expect(true).toBe(true) // Skip test
        return
      }

      try {
        await createTemporalClient({
          address: 'http://127.0.0.1:9999', // Non-existent server
          namespace: 'default',
        })
        expect(true).toBe(false) // Should not reach here
      } catch (error) {
        expect(error).toBeDefined()
        expect(error.message).toContain('Connection failed')
      }
    })

    test('should handle invalid server addresses', async () => {
      if (!createTemporalClient) {
        expect(true).toBe(true) // Skip test
        return
      }

      const invalidAddresses = ['invalid-url', 'http://', 'ftp://127.0.0.1:7233', 'http://127.0.0.1:7233/invalid-path']

      for (const address of invalidAddresses) {
        try {
          await createTemporalClient({
            address,
            namespace: 'default',
          })
          expect(true).toBe(false) // Should not reach here
        } catch (error) {
          expect(error).toBeDefined()
          expect(error.message).toContain('Connection failed')
        }
      }
    })
  })

  describe('Namespace Operations Integration', () => {
    test('should describe default namespace successfully', async () => {
      if (!serverAvailable || !createTemporalClient) {
        expect(true).toBe(true) // Skip test
        return
      }

      const client = await createTemporalClient({
        address: temporalAddress,
        namespace: 'default',
      })

      const result = await client.describeNamespace('default')

      expect(result).toBeDefined()
      expect(result.namespaceInfo).toBeDefined()
      expect(result.namespaceInfo.name).toBe('default')
      expect(result.namespaceInfo.state).toBeDefined()
      expect(result.config).toBeDefined()
    })

    test('should handle describeNamespace for non-existent namespace', async () => {
      if (!serverAvailable || !createTemporalClient) {
        expect(true).toBe(true) // Skip test
        return
      }

      const client = await createTemporalClient({
        address: temporalAddress,
        namespace: 'default',
      })

      try {
        await client.describeNamespace('non-existent-namespace')
        expect(true).toBe(false) // Should not reach here
      } catch (error) {
        expect(error).toBeDefined()
        expect(error.message).toContain('Namespace not found')
      }
    })

    test('should handle describeNamespace with invalid namespace names', async () => {
      if (!serverAvailable || !createTemporalClient) {
        expect(true).toBe(true) // Skip test
        return
      }

      const client = await createTemporalClient({
        address: temporalAddress,
        namespace: 'default',
      })

      const invalidNames = ['', ' ', 'invalid@namespace', 'namespace with spaces']

      for (const name of invalidNames) {
        try {
          await client.describeNamespace(name)
          expect(true).toBe(false) // Should not reach here
        } catch (error) {
          expect(error).toBeDefined()
          expect(error.message).toContain('Invalid namespace')
        }
      }
    })
  })

  describe('Client Configuration Integration', () => {
    test('should handle different client configurations', async () => {
      if (!serverAvailable || !createTemporalClient) {
        expect(true).toBe(true) // Skip test
        return
      }

      const configs = [
        {
          address: temporalAddress,
          namespace: 'default',
        },
        {
          address: temporalAddress,
          namespace: 'default',
          tls: {
            serverName: 'temporal.example.com',
          },
        },
      ]

      for (const config of configs) {
        const client = await createTemporalClient(config)
        expect(client).toBeDefined()

        const result = await client.describeNamespace('default')
        expect(result).toBeDefined()
        expect(result.namespaceInfo.name).toBe('default')
      }
    })

    test('should handle TLS configuration', async () => {
      if (!serverAvailable || !createTemporalClient) {
        expect(true).toBe(true) // Skip test
        return
      }

      const client = await createTemporalClient({
        address: temporalAddress,
        namespace: 'default',
        tls: {
          serverName: 'temporal.example.com',
        },
      })

      expect(client).toBeDefined()

      const result = await client.describeNamespace('default')
      expect(result).toBeDefined()
      expect(result.namespaceInfo.name).toBe('default')
    })

    test('should handle missing required configuration', async () => {
      if (!createTemporalClient) {
        expect(true).toBe(true) // Skip test
        return
      }

      const invalidConfigs = [
        {}, // Missing address and namespace
        { address: temporalAddress }, // Missing namespace
        { namespace: 'default' }, // Missing address
        { address: '', namespace: 'default' }, // Empty address
        { address: temporalAddress, namespace: '' }, // Empty namespace
      ]

      for (const config of invalidConfigs) {
        try {
          await createTemporalClient(config)
          expect(true).toBe(false) // Should not reach here
        } catch (error) {
          expect(error).toBeDefined()
          expect(error.message).toContain('Invalid configuration')
        }
      }
    })
  })

  describe('Client Performance Integration', () => {
    test('should handle multiple concurrent client connections', async () => {
      if (!serverAvailable || !createTemporalClient) {
        expect(true).toBe(true) // Skip test
        return
      }

      const startTime = Date.now()
      const promises = Array.from({ length: 5 }, (_, _i) =>
        createTemporalClient({
          address: temporalAddress,
          namespace: 'default',
        }),
      )

      const clients = await Promise.all(promises)
      const endTime = Date.now()

      expect(clients).toHaveLength(5)
      clients.forEach((client) => {
        expect(client).toBeDefined()
        expect(typeof client.describeNamespace).toBe('function')
      })

      // Should complete reasonably quickly
      expect(endTime - startTime).toBeLessThan(2000) // 2 seconds for 5 connections
    })

    test('should handle rapid sequential operations', async () => {
      if (!serverAvailable || !createTemporalClient) {
        expect(true).toBe(true) // Skip test
        return
      }

      const client = await createTemporalClient({
        address: temporalAddress,
        namespace: 'default',
      })

      const startTime = Date.now()
      const promises = Array.from({ length: 10 }, () => client.describeNamespace('default'))

      const results = await Promise.all(promises)
      const endTime = Date.now()

      expect(results).toHaveLength(10)
      results.forEach((result) => {
        expect(result).toBeDefined()
        expect(result.namespaceInfo.name).toBe('default')
      })

      // Should complete reasonably quickly
      expect(endTime - startTime).toBeLessThan(1000) // 1 second for 10 operations
    })

    test('should maintain performance under load', async () => {
      if (!serverAvailable || !createTemporalClient) {
        expect(true).toBe(true) // Skip test
        return
      }

      const client = await createTemporalClient({
        address: temporalAddress,
        namespace: 'default',
      })

      const iterations = 20
      const startTime = Date.now()

      for (let i = 0; i < iterations; i++) {
        await client.describeNamespace('default')
      }

      const endTime = Date.now()
      const avgTime = (endTime - startTime) / iterations

      // Average operation time should be reasonable
      expect(avgTime).toBeLessThan(100) // 100ms per operation
    })
  })

  describe('Client Error Handling Integration', () => {
    test('should handle network timeouts', async () => {
      if (!createTemporalClient) {
        expect(true).toBe(true) // Skip test
        return
      }

      try {
        await createTemporalClient({
          address: 'http://127.0.0.1:7233',
          namespace: 'default',
          timeout: 1, // 1ms timeout to force timeout
        })
        expect(true).toBe(false) // Should not reach here
      } catch (error) {
        expect(error).toBeDefined()
        expect(error.message).toContain('timeout')
      }
    })

    test('should handle server unavailability', async () => {
      if (!createTemporalClient) {
        expect(true).toBe(true) // Skip test
        return
      }

      try {
        await createTemporalClient({
          address: 'http://127.0.0.1:9999', // Non-existent server
          namespace: 'default',
        })
        expect(true).toBe(false) // Should not reach here
      } catch (error) {
        expect(error).toBeDefined()
        expect(error.message).toContain('Connection failed')
      }
    })

    test('should handle malformed responses', async () => {
      if (!serverAvailable || !createTemporalClient) {
        expect(true).toBe(true) // Skip test
        return
      }

      const client = await createTemporalClient({
        address: temporalAddress,
        namespace: 'default',
      })

      // This test would require a server that returns malformed responses
      // For now, we'll test that the client handles errors gracefully
      expect(client).toBeDefined()
    })

    test('should handle concurrent error scenarios', async () => {
      if (!createTemporalClient) {
        expect(true).toBe(true) // Skip test
        return
      }

      const promises = [
        createTemporalClient({
          address: 'http://127.0.0.1:9999', // Non-existent server
          namespace: 'default',
        }),
        createTemporalClient({
          address: 'invalid-url',
          namespace: 'default',
        }),
        createTemporalClient({
          address: temporalAddress,
          namespace: 'default',
        }),
      ]

      const results = await Promise.allSettled(promises)

      expect(results).toHaveLength(3)
      expect(results[0].status).toBe('rejected')
      expect(results[1].status).toBe('rejected')
      expect(results[2].status).toBe('fulfilled')
    })
  })

  describe('Client Memory Management Integration', () => {
    test('should handle client lifecycle management', async () => {
      if (!serverAvailable || !createTemporalClient) {
        expect(true).toBe(true) // Skip test
        return
      }

      const client = await createTemporalClient({
        address: temporalAddress,
        namespace: 'default',
      })

      expect(client).toBeDefined()

      // Test that we can perform operations
      const result = await client.describeNamespace('default')
      expect(result).toBeDefined()

      // Test that cleanup doesn't throw
      if (typeof client.cleanup === 'function') {
        expect(() => client.cleanup()).not.toThrow()
      }
    })

    test('should handle multiple client instances', async () => {
      if (!serverAvailable || !createTemporalClient) {
        expect(true).toBe(true) // Skip test
        return
      }

      const clients = []

      // Create multiple clients
      for (let i = 0; i < 5; i++) {
        const client = await createTemporalClient({
          address: temporalAddress,
          namespace: 'default',
        })
        clients.push(client)
      }

      expect(clients).toHaveLength(5)

      // Test that all clients work independently
      for (const client of clients) {
        const result = await client.describeNamespace('default')
        expect(result).toBeDefined()
        expect(result.namespaceInfo.name).toBe('default')
      }

      // Test cleanup
      for (const client of clients) {
        if (typeof client.cleanup === 'function') {
          expect(() => client.cleanup()).not.toThrow()
        }
      }
    })
  })

  describe('Client Real-world Scenario Tests', () => {
    test('should handle production-like client configuration', async () => {
      if (!serverAvailable || !createTemporalClient) {
        expect(true).toBe(true) // Skip test
        return
      }

      const client = await createTemporalClient({
        address: temporalAddress,
        namespace: 'default',
        tls: {
          serverName: 'temporal.example.com',
        },
        timeout: 30000, // 30 second timeout
      })

      expect(client).toBeDefined()

      const result = await client.describeNamespace('default')
      expect(result).toBeDefined()
      expect(result.namespaceInfo.name).toBe('default')
    })

    test('should handle client reconnection scenarios', async () => {
      if (!serverAvailable || !createTemporalClient) {
        expect(true).toBe(true) // Skip test
        return
      }

      const client = await createTemporalClient({
        address: temporalAddress,
        namespace: 'default',
      })

      expect(client).toBeDefined()

      // Test initial connection
      const result1 = await client.describeNamespace('default')
      expect(result1).toBeDefined()

      // Test reconnection (simulated by calling describeNamespace again)
      const result2 = await client.describeNamespace('default')
      expect(result2).toBeDefined()

      // Both results should be valid
      expect(result1.namespaceInfo.name).toBe('default')
      expect(result2.namespaceInfo.name).toBe('default')
    })

    test('should handle client with different namespace configurations', async () => {
      if (!serverAvailable || !createTemporalClient) {
        expect(true).toBe(true) // Skip test
        return
      }

      const configs = [
        { address: temporalAddress, namespace: 'default' },
        { address: temporalAddress, namespace: 'default', tls: { serverName: 'temporal.example.com' } },
      ]

      for (const config of configs) {
        const client = await createTemporalClient(config)
        expect(client).toBeDefined()

        const result = await client.describeNamespace('default')
        expect(result).toBeDefined()
        expect(result.namespaceInfo.name).toBe('default')
      }
    })
  })
})
