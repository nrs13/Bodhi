import { nextRequestId, sendToSw } from './swClient.js'

export async function fetchDefinition(word, context) {
  const requestId = nextRequestId()
  try {
    const result = await sendToSw({
      type: 'BODHI_DEFINE',
      requestId,
      word,
      context: context || null,
    })
    return {
      word: result?.word || String(word || '').trim(),
      partOfSpeech: result?.partOfSpeech || '',
      definition: result?.definition || null,
      source: result?.source,
      errorCode: result?.errorCode,
    }
  } catch {
    return {
      word: String(word || '').trim(),
      partOfSpeech: '',
      definition: null,
      errorCode: 'LOOKUP_FAILED',
    }
  }
}

export async function fetchDefinitionForSearch(word) {
  return fetchDefinition(word, null)
}
