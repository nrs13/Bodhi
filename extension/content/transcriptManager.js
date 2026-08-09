const state = {
  mode: null,
  transcript: [],
  buffer: [],
  videoId: null,
  ready: false,
  observer: null,
  readyAt: null,
}

// Rolling snapshot of the past-3s caption window (updated on video timeupdate)
let snapshot = { text: null, phrases: [], t: 0, updatedAt: 0 }

let urlPollIntervalId = null
let timeupdateHandler = null
let timeupdateVideo = null
let snapshotThrottleId = null
let readyResolve = null
let readyPromise = null

// Incremented on every video change — any async op that captured
// an older initId knows its results are stale and must be discarded
let currentInitId = 0

function createReadyPromise() {
  readyPromise = new Promise(resolve => {
    readyResolve = resolve
  })
}

function stopSnapshotLoop() {
  if (snapshotThrottleId != null) {
    clearTimeout(snapshotThrottleId)
    snapshotThrottleId = null
  }
  if (timeupdateVideo && timeupdateHandler) {
    timeupdateVideo.removeEventListener('timeupdate', timeupdateHandler)
  }
  timeupdateVideo = null
  timeupdateHandler = null
  snapshot = { text: null, phrases: [], t: 0, updatedAt: 0 }
}

function refreshSnapshot() {
  if (!state.ready || !state.mode || state.mode === 'unavailable') {
    snapshot = { text: null, phrases: [], t: 0, updatedAt: Date.now() }
    return
  }
  const video = document.querySelector('video')
  const t = video ? video.currentTime : 0
  const text = getTextWindow(t)
  const phrases = getPhrasesInWindow(t - 3, t)
  snapshot = { text, phrases, t, updatedAt: Date.now() }
}

function startSnapshotLoop() {
  stopSnapshotLoop()
  const video = document.querySelector('video')
  if (!video) return

  timeupdateVideo = video
  timeupdateHandler = () => {
    if (snapshotThrottleId != null) return
    snapshotThrottleId = setTimeout(() => {
      snapshotThrottleId = null
      refreshSnapshot()
    }, 250)
  }
  video.addEventListener('timeupdate', timeupdateHandler)
  refreshSnapshot()
}

function resetState() {
  if (state.observer) {
    state.observer.disconnect()
    state.observer = null
  }
  stopSnapshotLoop()
  state.mode = null
  state.transcript = []
  state.buffer = []
  state.videoId = null
  state.ready = false
  state.readyAt = null
  currentInitId++
  createReadyPromise()
}

function getVideoIdFromUrl(url) {
  try {
    const u = new URL(url)
    if (u.hostname.includes('youtu.be')) {
      return u.pathname.replace('/', '') || null
    }
    if (u.searchParams.has('v')) return u.searchParams.get('v')
    const match = u.pathname.match(/\/embed\/([^/?]+)/)
    if (match) return match[1]
    return null
  } catch {
    return null
  }
}

function parseTimedtextJson(json) {
  if (!json) return []
  const events = json.events || []
  const entries = []

  for (const ev of events) {
    const startMs = ev.tStartMs
    const durMs = ev.dDurationMs ?? ev.d ?? 0
    const texts = ev.segs?.map(s => s.utf8).join(' ')

    if (typeof startMs !== 'number' || !texts?.trim()) continue

    const startTime = startMs / 1000
    const endTime = (startMs + durMs) / 1000
    entries.push({
      text: texts.replace(/\s+/g, ' ').trim(),
      startTime,
      endTime: Number.isFinite(endTime) && endTime > startTime
        ? endTime
        : startTime + 0.5,
    })
  }

  return entries
}

// Transcript is sorted by startTime; find first entry with endTime >= windowStart
function binarySearchTranscript(transcript, windowStart) {
  let lo = 0
  let hi = transcript.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (transcript[mid].endTime < windowStart) {
      lo = mid + 1
    } else {
      hi = mid
    }
  }
  return lo
}

async function fetchTimedtext(videoId) {
  const urls = [
    `https://www.youtube.com/api/timedtext?lang=en&v=${videoId}&fmt=json3`,
    `https://www.youtube.com/api/timedtext?lang=en-US&v=${videoId}&fmt=json3`,
    `https://www.youtube.com/api/timedtext?lang=en&v=${videoId}&kind=asr&fmt=json3`,
    `https://www.youtube.com/api/timedtext?lang=en&v=${videoId}`,
  ]

  for (const url of urls) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      const response = await fetch(url, { signal: controller.signal })
      clearTimeout(timeout)
      if (!response.ok) continue
      const json = await response.json()
      if (!json) continue
      const parsed = parseTimedtextJson(json)
      if (parsed && parsed.length > 0) return parsed
    } catch {
      continue
    }
  }
  return null
}

const CAPTION_SELECTORS = [
  '.ytp-caption-segment',
  '.captions-text',
  '[class*="caption-visual-line"] span',
  '.ytp-caption-window-container span',
]

let autoEnableCaptions = true

function setAutoEnableCaptions(value) {
  autoEnableCaptions = value !== false
}

function ensureCaptionsEnabled() {
  if (!autoEnableCaptions) return
  const btn = document.querySelector('.ytp-subtitles-button')
  if (btn && btn.getAttribute('aria-pressed') !== 'true') btn.click()
}

function startDOMScraper() {
  ensureCaptionsEnabled()
  const initId = currentInitId

  setTimeout(() => {
    if (initId !== currentInitId) return

    const video = document.querySelector('video')
    if (!video) {
      state.mode = 'unavailable'
      state.ready = true
      readyResolve()
      return
    }

    let debounceTimer = null

    const observer = new MutationObserver(() => {
      if (debounceTimer) return
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        processCaptions()
      }, 150)
    })

    function processCaptions() {
      if (initId !== currentInitId) {
        observer.disconnect()
        return
      }

      const vid = document.querySelector('video')
      const seen = new Set()
      let text = ''

      for (const selector of CAPTION_SELECTORS) {
        for (const el of document.querySelectorAll(selector)) {
          if (seen.has(el)) continue
          seen.add(el)
          const t = el.textContent?.trim()
          if (t) text += t + ' '
        }
      }

      text = text.replace(/\s+/g, ' ').trim()
      if (!text) return

      const timestamp = vid ? vid.currentTime : 0
      state.buffer.push({ text, timestamp })

      const cutoff = timestamp - 4
      state.buffer = state.buffer.filter(e => e.timestamp >= cutoff)

      if (!state.ready) state.ready = true
    }

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    })

    state.observer = observer
    state.mode = 'dom-scraping'

    setTimeout(() => {
      if (initId !== currentInitId) return
      if (state.buffer.length === 0) state.mode = 'unavailable'
      state.ready = true
      state.readyAt = Date.now()
      readyResolve()
      if (state.mode !== 'unavailable') startSnapshotLoop()
    }, 3000)

  }, 800)
}

async function initializeForVideo(videoId) {
  const initId = currentInitId

  try {
    const transcript = await fetchTimedtext(videoId)

    // Video changed while fetching — discard results entirely
    if (initId !== currentInitId) return

    if (transcript && transcript.length > 0) {
      state.transcript = transcript
      state.mode = 'timedtext'
      state.ready = true
      state.readyAt = Date.now()
      readyResolve()
      startSnapshotLoop()
    } else {
      startDOMScraper()
    }
  } catch {
    if (initId !== currentInitId) return
    startDOMScraper()
  }
}

function getPhrasesInWindow(windowStart, windowEnd) {
  if (state.mode !== 'timedtext' || !state.transcript.length) return []
  const startIdx = binarySearchTranscript(state.transcript, windowStart)
  const phrases = []
  for (let i = startIdx; i < state.transcript.length; i++) {
    const e = state.transcript[i]
    if (e.startTime > windowEnd) break
    if (e.endTime >= windowStart && e.startTime <= windowEnd) {
      phrases.push(e)
    }
  }
  return phrases
}

function getTextWindow(currentTime) {
  if (!state.ready) return null
  if (!state.mode || state.mode === 'unavailable') return null

  const time = typeof currentTime === 'number' ? currentTime : 0

  // Past 3 seconds only — never use future captions
  const windowStart = time - 3
  const windowEnd = time

  if (state.mode === 'timedtext') {
    const startIdx = binarySearchTranscript(state.transcript, windowStart)
    const pieces = []
    for (let i = startIdx; i < state.transcript.length; i++) {
      const e = state.transcript[i]
      if (e.startTime > windowEnd) break
      if (e.endTime >= windowStart && e.startTime <= windowEnd) {
        pieces.push(e.text)
      }
    }
    return pieces.join(' ').trim() || null
  }

  if (state.mode === 'dom-scraping') {
    const pieces = state.buffer
      .filter(e => e.timestamp >= windowStart && e.timestamp <= windowEnd)
      .map(e => e.text)
    return pieces.join(' ').trim() || null
  }

  return null
}

function handleVideoChange(newVideoId) {
  resetState()
  state.videoId = newVideoId
  initializeForVideo(newVideoId)
}

function detectVideoChange() {
  let lastVideoId = getVideoIdFromUrl(window.location.href)

  const titleEl = document.querySelector('title')
  if (titleEl) {
    new MutationObserver(() => {
      const currentId = getVideoIdFromUrl(window.location.href)
      if (currentId && currentId !== lastVideoId) {
        handleVideoChange(currentId)
        lastVideoId = currentId
      }
    }).observe(titleEl, { childList: true })
  }

  urlPollIntervalId = window.setInterval(() => {
    const currentId = getVideoIdFromUrl(window.location.href)
    if (currentId && currentId !== lastVideoId) {
      handleVideoChange(currentId)
      lastVideoId = currentId
    }
  }, 1000)
}

async function init() {
  resetState()
  const videoId = getVideoIdFromUrl(window.location.href)
  if (!videoId) {
    state.mode = 'unavailable'
    state.ready = true
    readyResolve()
    detectVideoChange()
    return
  }
  state.videoId = videoId
  await initializeForVideo(videoId)
  detectVideoChange()
}

function getMode() { return state.mode }
function isReady() { return state.ready }
async function waitUntilReady() { return readyPromise }

function getStatus() {
  return {
    mode: state.mode,
    ready: state.ready,
    bufferAgeMs: state.readyAt ? Date.now() - state.readyAt : null,
  }
}

function getSnapshot() {
  // Prefer live snapshot; refresh once if stale (>500ms) so ⌘B stays current
  if (Date.now() - (snapshot.updatedAt || 0) > 500) {
    refreshSnapshot()
  }
  return snapshot
}

function destroy() {
  if (state.observer) { state.observer.disconnect(); state.observer = null }
  if (urlPollIntervalId != null) { clearInterval(urlPollIntervalId); urlPollIntervalId = null }
  stopSnapshotLoop()
  resetState()
}

export default {
  init, getTextWindow, getPhrasesInWindow, getMode, isReady,
  getStatus, getSnapshot, setAutoEnableCaptions,
  waitUntilReady, destroy, detectVideoChange, handleVideoChange,
}
