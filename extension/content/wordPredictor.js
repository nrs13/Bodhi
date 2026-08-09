import { nextRequestId, sendToSw } from './swClient.js'

export async function predict(textWindow, phrases, currentTime) {
  const requestId = nextRequestId()
  try {
    const response = await sendToSw({
      type: 'BODHI_RANK',
      requestId,
      textWindow,
      phrases: phrases || [],
      currentTime,
    })
    if (!response || !response.ok) return []
    return Array.isArray(response.candidates) ? response.candidates : []
  } catch {
    return []
  }
}
