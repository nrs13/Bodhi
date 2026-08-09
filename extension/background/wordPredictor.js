import { getFrequencyRank } from '../data/frequencyList.js'

const STOP_WORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being',
  'have','has','had','do','does','did','will','would','could',
  'should','may','might','shall','can','it','its','this','that',
  'these','those','they','them','their','he','she','we','you',
  'i','me','my','your','yours','ours','and','or','but','in',
  'on','at','to','for','of','with','by','from','up','about',
  'into','through','during','before','after','above','below',
  'over','under','again','further','then','once','here','there',
  'when','where','why','how','all','any','both','each','few',
  'more','most','other','some','such','no','nor','not','only',
  'own','same','so','than','too','very','just','because','as',
  'if','while','until','though','yet','ever','never','also',
  'much','many','lot','lots','thing','things','something',
  'anything','nothing','everyone','everybody','someone',
  'somebody','nobody',
])

// Raised to 5000 — filters out common conjugated forms like
// "playing", "described", "running" unless window has no harder words
const MIN_RANK_FOR_SUGGESTION = 5000
const UNKNOWN_RANK = 99999
const MAX_RANK = 100000
const LAMBDA = 0.4

const scoreCache = new Map()
const SCORE_CACHE_MAX = 500

function getCachedZipfScore(word) {
  if (scoreCache.has(word)) {
    const val = scoreCache.get(word)
    scoreCache.delete(word)
    scoreCache.set(word, val)
    return val
  }

  const rank = getFrequencyRank(word)

  if (rank === UNKNOWN_RANK) {
    cacheScore(word, null)
    return null
  }

  const zipf = Math.log(rank) / Math.log(MAX_RANK)
  cacheScore(word, zipf)
  return zipf
}

function cacheScore(word, value) {
  if (scoreCache.size >= SCORE_CACHE_MAX) {
    scoreCache.delete(scoreCache.keys().next().value)
  }
  scoreCache.set(word, value)
}

function tokenize(text) {
  if (!text) return []
  return text
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, '')
    .split(/\s+/)
    .filter(Boolean)
}

function isNumberToken(token) {
  return /^\d+([\d.,]*\d+)?$/.test(token)
}

function isRepeatedChars(word) {
  if (!word) return false
  return new Set(word.toLowerCase().split('')).size === 1
}

function temporalWeight(wordTime, currentTime) {
  if (typeof wordTime !== 'number' || typeof currentTime !== 'number') return 1
  const delta = Math.max(0, currentTime - wordTime)
  return Math.exp(-LAMBDA * delta)
}

function estimateWordTime(phraseStartTime, phraseEndTime, wordIndex, totalWords) {
  if (totalWords <= 1) return phraseStartTime
  const duration = phraseEndTime - phraseStartTime
  return phraseStartTime + (wordIndex / (totalWords - 1)) * duration
}

function buildWordTimeMap(phrases) {
  const map = new Map()
  if (!Array.isArray(phrases) || phrases.length === 0) return map
  let globalIdx = 0
  for (const phrase of phrases) {
    const phraseTokens = tokenize(phrase.text)
    const total = phraseTokens.length
    const endTime = phrase.endTime ?? phrase.startTime + 0.5
    for (let wi = 0; wi < total; wi++) {
      map.set(globalIdx, estimateWordTime(phrase.startTime, endTime, wi, total))
      globalIdx++
    }
  }
  return map
}

export function predict(textWindow, phrases, currentTime) {
  if (!textWindow) return []

  const originalTokens = String(textWindow).split(/\s+/).filter(Boolean)
  const normalizedTokens = tokenize(textWindow)
  if (normalizedTokens.length === 0) return []

  const normToOriginal = new Map()
  let normIdx = 0
  for (
    let origIdx = 0;
    origIdx < originalTokens.length && normIdx < normalizedTokens.length;
    origIdx++
  ) {
    const origLower = originalTokens[origIdx]
      .toLowerCase()
      .replace(/[^a-z\s'-]/g, '')
      .trim()
    if (origLower === normalizedTokens[normIdx]) {
      normToOriginal.set(normalizedTokens[normIdx] + '_' + normIdx, originalTokens[origIdx])
      normIdx++
    }
  }

  const wordTimeMap = buildWordTimeMap(phrases)
  const results = []
  const seen = new Set()

  for (let i = 0; i < normalizedTokens.length; i++) {
    const word = normalizedTokens[i]
    const original = normToOriginal.get(word + '_' + i) ?? word

    if (seen.has(word)) continue
    seen.add(word)

    if (STOP_WORDS.has(word)) continue
    if (word.length < 4) continue
    if (isNumberToken(original)) continue
    if (isRepeatedChars(word)) continue

    const zipf = getCachedZipfScore(word)
    if (zipf === null) continue

    const minZipf = Math.log(MIN_RANK_FOR_SUGGESTION) / Math.log(MAX_RANK)
    if (zipf < minZipf) continue

    const wordTime = wordTimeMap.get(i)
    const tWeight = (wordTime !== undefined && typeof currentTime === 'number')
      ? temporalWeight(wordTime, currentTime)
      : 1

    results.push({ word, score: zipf * tWeight })
  }

  results.sort((a, b) => b.score - a.score)
  return results
}

