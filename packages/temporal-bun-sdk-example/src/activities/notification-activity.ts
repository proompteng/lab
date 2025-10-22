// Notification activity using @proompteng/temporal-bun-sdk
type PushNotificationInput = {
  userId: string
  title: string
  body: string
  data?: Record<string, unknown>
}

type SmsInput = {
  phoneNumber: string
  message: string
}

type WebhookInput = {
  url: string
  payload: unknown
  headers?: Record<string, string>
}

type SlackMessageInput = {
  channel: string
  text: string
  attachments?: unknown[]
}

export async function sendPushNotification(input: PushNotificationInput) {
  console.log('📱 Sending push notification:', input)

  const { userId, title, body, data = {} } = input

  if (!userId) {
    throw new Error('User ID is required')
  }

  if (!title || !body) {
    throw new Error('Title and body are required')
  }

  // Simulate push notification sending
  await Bun.sleep(75)

  // Simulate occasional failures
  if (Math.random() < 0.05) {
    // 5% failure rate
    throw new Error('Push notification service temporarily unavailable')
  }

  const result = {
    success: true,
    notificationId: `push_${Date.now()}`,
    userId,
    title,
    body,
    data,
    sentAt: new Date().toISOString(),
    bunVersion: Bun.version,
    runtime: 'bun',
  }

  console.log('✅ Push notification sent successfully:', result.notificationId)
  return result
}

export async function sendSMS(input: SmsInput) {
  console.log('📱 Sending SMS:', input)

  const { phoneNumber, message } = input

  if (!phoneNumber) {
    throw new Error('Phone number is required')
  }

  if (!message) {
    throw new Error('Message is required')
  }

  // Validate phone number format
  const phoneRegex = /^\+?[\d\s\-()]+$/
  if (!phoneRegex.test(phoneNumber)) {
    throw new Error('Invalid phone number format')
  }

  // Simulate SMS sending
  await Bun.sleep(100)

  // Simulate occasional failures
  if (Math.random() < 0.08) {
    // 8% failure rate
    throw new Error('SMS service temporarily unavailable')
  }

  const result = {
    success: true,
    messageId: `sms_${Date.now()}`,
    phoneNumber,
    message,
    sentAt: new Date().toISOString(),
    bunVersion: Bun.version,
    runtime: 'bun',
  }

  console.log('✅ SMS sent successfully:', result.messageId)
  return result
}

export async function sendWebhook(input: WebhookInput) {
  console.log('🔗 Sending webhook:', input)

  const { url, payload, headers = {} } = input

  if (!url) {
    throw new Error('Webhook URL is required')
  }

  if (!payload) {
    throw new Error('Webhook payload is required')
  }

  // Validate URL format
  try {
    new URL(url)
  } catch {
    throw new Error('Invalid webhook URL format')
  }

  // Simulate webhook sending
  await Bun.sleep(125)

  // Simulate occasional failures
  if (Math.random() < 0.1) {
    // 10% failure rate
    throw new Error('Webhook service temporarily unavailable')
  }

  // Simulate HTTP status codes
  const statusCodes = [200, 201, 202, 400, 401, 403, 404, 500, 502, 503]
  const statusCode = statusCodes[Math.floor(Math.random() * statusCodes.length)]

  if (statusCode >= 400) {
    throw new Error(`Webhook failed with status ${statusCode}`)
  }

  const result = {
    success: true,
    webhookId: `webhook_${Date.now()}`,
    url,
    payload,
    headers,
    statusCode,
    sentAt: new Date().toISOString(),
    bunVersion: Bun.version,
    runtime: 'bun',
  }

  console.log('✅ Webhook sent successfully:', result.webhookId)
  return result
}

export async function sendSlackMessage(input: SlackMessageInput) {
  console.log('💬 Sending Slack message:', input)

  const { channel, text, attachments = [] } = input

  if (!channel) {
    throw new Error('Slack channel is required')
  }

  if (!text) {
    throw new Error('Message text is required')
  }

  // Simulate Slack message sending
  await Bun.sleep(80)

  // Simulate occasional failures
  if (Math.random() < 0.03) {
    // 3% failure rate
    throw new Error('Slack service temporarily unavailable')
  }

  const result = {
    success: true,
    messageId: `slack_${Date.now()}`,
    channel,
    text,
    attachments,
    sentAt: new Date().toISOString(),
    bunVersion: Bun.version,
    runtime: 'bun',
  }

  console.log('✅ Slack message sent successfully:', result.messageId)
  return result
}
