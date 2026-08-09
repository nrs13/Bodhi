// Message protocol: BODHI_DEFINE / BODHI_RANK (requestId + payload) → *_RESULT.

import { fetchDefinition } from './definitionFetcher.js'
import { predict } from './wordPredictor.js'

function handleDefine(msg, sendResponse) {
  const { requestId, word, context } = msg
  fetchDefinition(word, context)
    .then((result) => {
      const ok = !!result?.definition
      sendResponse({
        type: 'BODHI_DEFINE_RESULT',
        requestId,
        ok,
        word: result?.word || String(word || '').trim(),
        partOfSpeech: result?.partOfSpeech || '',
        definition: result?.definition || null,
        source: result?.source,
        errorCode: ok ? undefined : 'LOOKUP_FAILED',
      })
    })
    .catch(() => {
      sendResponse({
        type: 'BODHI_DEFINE_RESULT',
        requestId,
        ok: false,
        word: String(word || '').trim(),
        partOfSpeech: '',
        definition: null,
        errorCode: 'LOOKUP_FAILED',
      })
    })
}

function handleRank(msg, sendResponse) {
  const { requestId, textWindow, phrases, currentTime } = msg
  try {
    const candidates = predict(textWindow, phrases, currentTime) || []
    sendResponse({
      type: 'BODHI_RANK_RESULT',
      requestId,
      ok: true,
      candidates,
    })
  } catch {
    sendResponse({
      type: 'BODHI_RANK_RESULT',
      requestId,
      ok: false,
      candidates: [],
    })
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return false

  switch (msg.type) {
    case 'BODHI_DEFINE':
      handleDefine(msg, sendResponse)
      return true
    case 'BODHI_RANK':
      handleRank(msg, sendResponse)
      return true
    default:
      return false
  }
})
