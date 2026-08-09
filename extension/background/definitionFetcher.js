import { MW_API_KEY, WORDNIK_API_KEY } from './secrets.js'

const memoryCache = new Map()
const FAILURE_TTL_MS = 60_000
const SUCCESS_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const STORAGE_PREFIX = 'bodhi_def_v2_'
const STORAGE_CAP = 500

function storageKey(word) {
  return `${STORAGE_PREFIX}${word.toLowerCase()}`
}

function readMemory(key) {
  if (!memoryCache.has(key)) return null
  const entry = memoryCache.get(key)
  if (entry._failedAt) {
    if (Date.now() - entry._failedAt < FAILURE_TTL_MS) {
      return { word: key, partOfSpeech: '', definition: null }
    }
    memoryCache.delete(key)
    return null
  }
  memoryCache.delete(key)
  memoryCache.set(key, entry)
  return entry
}

function writeMemorySuccess(key, result) {
  memoryCache.delete(key)
  memoryCache.set(key, result)
}

function writeMemoryFailure(key) {
  memoryCache.set(key, { _failedAt: Date.now() })
}

async function readStorage(key) {
  const sk = storageKey(key)
  try {
    const data = await chrome.storage.local.get(sk)
    const entry = data[sk]
    if (!entry || !entry.definition || !entry.ts) return null
    if (Date.now() - entry.ts > SUCCESS_TTL_MS) {
      chrome.storage.local.remove(sk)
      return null
    }
    return {
      word: entry.word || key,
      partOfSpeech: entry.partOfSpeech || '',
      definition: entry.definition,
      source: entry.source,
    }
  } catch {
    return null
  }
}

async function writeStorageSuccess(key, result) {
  const sk = storageKey(key)
  const record = {
    word: result.word,
    partOfSpeech: result.partOfSpeech || '',
    definition: result.definition,
    source: result.source,
    ts: Date.now(),
  }
  try {
    await chrome.storage.local.set({ [sk]: record })
    await evictStorageIfNeeded()
  } catch {
    // ignore quota errors
  }
}

async function evictStorageIfNeeded() {
  try {
    const all = await chrome.storage.local.get(null)
    const defKeys = Object.keys(all).filter((k) => k.startsWith(STORAGE_PREFIX))
    if (defKeys.length <= STORAGE_CAP) return
    const sorted = defKeys
      .map((k) => ({ k, ts: all[k]?.ts || 0 }))
      .sort((a, b) => a.ts - b.ts)
    const toRemove = sorted.slice(0, defKeys.length - STORAGE_CAP).map((x) => x.k)
    if (toRemove.length) await chrome.storage.local.remove(toRemove)
  } catch {
    // ignore
  }
}

function cleanDefinition(text) {
  if (!text) return null
  let cleaned = String(text)

  cleaned = cleaned.replace(/<[^>]+>/g, ' ')

  // Merriam-Webster brace tags → plain text
  cleaned = cleaned.replace(/\{\/[^}]+\}/g, '')
  cleaned = cleaned.replace(/\{[a-z_]+\|([^}]+)\}/g, '$1')
  cleaned = cleaned.replace(/\{[a-z_]+\}/g, ' ')

  cleaned = cleaned.replace(/\[[^\]]*\]/g, ' ')
  cleaned = cleaned.replace(/\|+/g, ' ')
  cleaned = cleaned.replace(/\s+([.!?,;:])/g, '$1')
  cleaned = cleaned.replace(/\s+/g, ' ').trim()
  if (!cleaned) return null

  cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
  if (!/[.!?]$/.test(cleaned)) cleaned = `${cleaned}.`

  return cleaned
}

function buildContextWords(context) {
  if (!context) return new Set()
  return new Set(
    context.toLowerCase()
      .replace(/[^a-z\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3)
  )
}

function scoreDefinitionForContext(definitionText, contextWords) {
  if (!definitionText || contextWords.size === 0) return 0
  const defWords = new Set(
    definitionText.toLowerCase()
      .replace(/[^a-z\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3)
  )
  let overlap = 0
  for (const w of contextWords) {
    if (defWords.has(w)) overlap++
  }
  return defWords.size > 0 ? overlap / defWords.size : 0
}

function selectBestDefinition(candidates, contextWords) {
  if (candidates.length === 0) return null
  if (contextWords.size === 0) return candidates[0]
  return candidates.reduce((best, candidate) => {
    const score = scoreDefinitionForContext(candidate.text, contextWords)
    return score > best.score ? { ...candidate, score } : best
  }, { ...candidates[0], score: scoreDefinitionForContext(candidates[0].text, contextWords) })
}

async function fetchFromMerriamWebster(word, contextWords) {
  if (!MW_API_KEY || MW_API_KEY === 'YOUR_MW_LEARNERS_KEY_HERE' || MW_API_KEY === '') return null

  try {
    const response = await Promise.race([
      fetch(`https://www.dictionaryapi.com/api/v3/references/learners/json/${encodeURIComponent(word)}?key=${MW_API_KEY}`),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
    ])
    if (!response.ok) return null

    const data = await response.json()
    if (!Array.isArray(data) || data.length === 0) return null
    if (typeof data[0] === 'string') return null

    const candidates = []

    function extractFromDt(dt, pos) {
      if (!Array.isArray(dt)) return
      for (const dtItem of dt) {
        if (!Array.isArray(dtItem)) continue
        if (dtItem[0] === 'text' && dtItem[1]) {
          candidates.push({ text: dtItem[1], pos })
        }
        if (dtItem[0] === 'uns' && Array.isArray(dtItem[1])) {
          for (const unGroup of dtItem[1]) {
            for (const unItem of unGroup) {
              if (Array.isArray(unItem) && unItem[0] === 'text' && unItem[1]) {
                candidates.push({ text: unItem[1], pos })
              }
            }
          }
        }
      }
    }

    function extractFromSense(senseData, pos) {
      if (!senseData || typeof senseData !== 'object') return
      if (senseData.dt) extractFromDt(senseData.dt, pos)
      if (senseData.sdsense?.dt) extractFromDt(senseData.sdsense.dt, pos)
    }

    for (const entry of data) {
      const pos = entry.fl || ''
      const defs = entry.def || []

      for (const defBlock of defs) {
        const sseqs = defBlock.sseq || []
        for (const sseq of sseqs) {
          for (const senseItem of sseq) {
            if (!Array.isArray(senseItem)) continue

            const senseType = senseItem[0]
            const senseData = senseItem[1]

            if (senseType === 'sense') {
              extractFromSense(senseData, pos)
            }

            if (senseType === 'bs' && senseData?.sense) {
              extractFromSense(senseData.sense, pos)
            }

            if (senseType === 'pseq' && Array.isArray(senseData)) {
              for (const pseudoSense of senseData) {
                if (Array.isArray(pseudoSense) && pseudoSense[0] === 'sense') {
                  extractFromSense(pseudoSense[1], pos)
                }
              }
            }
          }
        }
      }
    }

    if (candidates.length === 0) return null

    const best = selectBestDefinition(candidates, contextWords)
    const definition = cleanDefinition(best.text)
    if (!definition) return null

    return { word, partOfSpeech: best.pos, definition, source: 'merriam-webster' }
  } catch {
    return null
  }
}

async function fetchFromWordnik(word, contextWords) {
  if (!WORDNIK_API_KEY || WORDNIK_API_KEY === 'YOUR_WORDNIK_KEY_HERE') return null

  try {
    const response = await Promise.race([
      fetch(`https://api.wordnik.com/v4/word.json/${encodeURIComponent(word)}/definitions?limit=10&includeRelated=false&useCanonical=true&includeTags=false&api_key=${WORDNIK_API_KEY}`),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
    ])
    if (!response.ok) return null

    const data = await response.json()
    if (!Array.isArray(data) || data.length === 0) return null

    const candidates = data
      .filter(d => d.text)
      .map(d => ({ text: d.text, pos: d.partOfSpeech || '' }))

    if (candidates.length === 0) return null

    const best = selectBestDefinition(candidates, contextWords)
    const definition = cleanDefinition(best.text)
    if (!definition) return null

    return { word, partOfSpeech: best.pos, definition, source: 'wordnik' }
  } catch {
    return null
  }
}

async function fetchFromFreeDictionary(word, contextWords) {
  try {
    const response = await Promise.race([
      fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ])
    if (!response.ok) return null

    const data = await response.json()
    if (!Array.isArray(data) || data.length === 0) return null

    const candidates = []
    for (const entry of data) {
      for (const meaning of (entry.meanings || [])) {
        const pos = meaning.partOfSpeech || ''
        for (const def of (meaning.definitions || [])) {
          if (def.definition) candidates.push({ text: def.definition, pos })
        }
      }
    }

    if (candidates.length === 0) return null

    const best = selectBestDefinition(candidates, contextWords)
    const definition = cleanDefinition(best.text)
    if (!definition) return null

    return { word, partOfSpeech: best.pos, definition, source: 'freedictionary' }
  } catch {
    return null
  }
}

export async function fetchDefinition(word, context) {
  const key = String(word || '').trim()
  if (!key) return { word: '', partOfSpeech: '', definition: null }

  const mem = readMemory(key)
  if (mem) return mem

  const stored = await readStorage(key)
  if (stored?.definition) {
    writeMemorySuccess(key, stored)
    return stored
  }

  const contextWords = buildContextWords(context)

  const mw = await fetchFromMerriamWebster(key, contextWords)
  if (mw?.definition) {
    writeMemorySuccess(key, mw)
    await writeStorageSuccess(key, mw)
    return mw
  }

  const wordnik = await fetchFromWordnik(key, contextWords)
  if (wordnik?.definition) {
    writeMemorySuccess(key, wordnik)
    await writeStorageSuccess(key, wordnik)
    return wordnik
  }

  const free = await fetchFromFreeDictionary(key, contextWords)
  if (free?.definition) {
    writeMemorySuccess(key, free)
    await writeStorageSuccess(key, free)
    return free
  }

  writeMemoryFailure(key)
  return { word: key, partOfSpeech: '', definition: null }
}

