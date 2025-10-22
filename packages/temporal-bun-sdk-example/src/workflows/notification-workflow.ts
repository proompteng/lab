// Notification workflow using @proompteng/temporal-bun-sdk
type NotificationChannel = {
  type: 'email' | 'sms' | 'push' | 'webhook'
  config?: Record<string, unknown>
}

type NotificationWorkflowInput = {
  userId: string
  message: string
  channels: NotificationChannel[]
  priority?: 'low' | 'normal' | 'high'
}

type NotificationResult = {
  messageId: string
  channel: NotificationChannel['type']
  sentAt: string
}

type NotificationOutcome = {
  channel: NotificationChannel['type']
  success: boolean
  result: NotificationResult
}

type NotificationError = {
  channel: NotificationChannel['type']
  error: string
}

export default async function notificationWorkflow(input: NotificationWorkflowInput) {
  console.log('📢 Notification workflow started')
  console.log('Input:', input)

  const { userId, message, channels, priority } = input

  // Step 1: Validate input
  console.log('✅ Validating notification input...')
  await Bun.sleep(25)

  if (!userId || !message || !channels || !Array.isArray(channels)) {
    throw new Error('Invalid notification: missing required fields')
  }

  // Step 2: Process notification for each channel
  console.log('📱 Processing notifications for channels:', channels)
  await Bun.sleep(50)

  const results = []
  const errors = []

  for (const channel of channels) {
    try {
      console.log(`📤 Sending notification via ${channel.type}...`)
      const result = await sendNotification({
        userId,
        message,
        channel,
        priority,
      })

      results.push({
        channel: channel.type,
        success: true,
        result,
      })

      await Bun.sleep(25) // Simulate processing time
    } catch (error) {
      console.error(`❌ Failed to send notification via ${channel.type}:`, error)
      errors.push({
        channel: channel.type,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // Step 3: Update notification status
  console.log('📊 Updating notification status...')
  await Bun.sleep(50)

  const statusResult = await updateNotificationStatus({
    userId,
    message,
    channels,
    results,
    errors,
  })

  const result = {
    success: errors.length === 0,
    userId,
    message,
    channels,
    priority,
    results,
    errors,
    totalChannels: channels.length,
    successfulChannels: results.length,
    failedChannels: errors.length,
    statusUpdated: statusResult.success,
    processedAt: new Date().toISOString(),
    bunVersion: Bun.version,
    runtime: 'bun',
  }

  console.log('✅ Notification workflow completed')
  return result
}

// Mock activity functions
async function sendNotification(notification: {
  userId: string
  message: string
  channel: NotificationChannel
  priority?: 'low' | 'normal' | 'high'
}): Promise<NotificationResult> {
  await Bun.sleep(25)

  // Simulate different success rates based on channel type
  const successRate = {
    email: 0.95,
    sms: 0.9,
    push: 0.85,
    webhook: 0.8,
  }

  const rate = successRate[notification.channel.type as keyof typeof successRate] || 0.9

  if (Math.random() > rate) {
    throw new Error(`Failed to send ${notification.channel.type} notification`)
  }

  return {
    messageId: `msg_${Date.now()}_${notification.channel.type}`,
    channel: notification.channel.type,
    sentAt: new Date().toISOString(),
  }
}

async function updateNotificationStatus(_status: {
  userId: string
  message: string
  channels: NotificationChannel[]
  results: NotificationOutcome[]
  errors: NotificationError[]
}): Promise<{ success: true; statusId: string; updatedAt: string }> {
  await Bun.sleep(50)
  return {
    success: true,
    statusId: `status_${Date.now()}`,
    updatedAt: new Date().toISOString(),
  }
}
