import nspell from 'nspell'
import transcriptManager from './transcriptManager.js'
import { predict } from './wordPredictor.js'
import { fetchDefinition, fetchDefinitionForSearch } from './definitionFetcher.js'

function isChromeContextValid() {
  try {
    // chrome.runtime.id throws after extension reload invalidates the content script
    return !!chrome.runtime?.id
  } catch {
    return false
  }
}

let spellChecker = null
let spellCheckerLoading = false
let spellCheckerCallbacks = []

let settings = {
  enabled: true,
  autoDismiss: true,
  spellCheck: true,
  autoEnableCaptions: true,
}

/** @type {'system' | 'light' | 'dark'} */
let themePref = 'system'
let systemDarkMq = null

function resolveTheme() {
  if (themePref === 'light' || themePref === 'dark') return themePref
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

function applyThemeToElement(el) {
  if (!el) return
  el.setAttribute('data-bodhi-theme', resolveTheme())
}

function applyThemeToOpenWidget() {
  if (widgetInstance) applyThemeToElement(widgetInstance)
}

function initThemeListeners() {
  chrome.storage.local.get(['bodhi_theme'], (res) => {
    if (res.bodhi_theme === 'light' || res.bodhi_theme === 'dark' || res.bodhi_theme === 'system') {
      themePref = res.bodhi_theme
    }
    applyThemeToOpenWidget()
  })
  try {
    systemDarkMq = window.matchMedia('(prefers-color-scheme: dark)')
    const onScheme = () => {
      if (themePref === 'system') applyThemeToOpenWidget()
    }
    if (systemDarkMq.addEventListener) systemDarkMq.addEventListener('change', onScheme)
    else if (systemDarkMq.addListener) systemDarkMq.addListener(onScheme)
  } catch { /* ignore */ }
}

function applyAutoEnableCaptionsSetting() {
  if (transcriptManager.setAutoEnableCaptions) {
    transcriptManager.setAutoEnableCaptions(settings.autoEnableCaptions !== false)
  }
}

function loadSettings() {
  chrome.storage.local.get(
    ['bodhi_enabled', 'bodhi_autoDismiss', 'bodhi_spellCheck', 'bodhi_autoEnableCaptions', 'bodhi_settings'],
    (res) => {
      if (res.bodhi_settings) {
        settings = { ...settings, ...res.bodhi_settings }
      }
      if ('bodhi_enabled' in res) settings.enabled = res.bodhi_enabled
      if ('bodhi_autoDismiss' in res) settings.autoDismiss = res.bodhi_autoDismiss
      if ('bodhi_spellCheck' in res) settings.spellCheck = res.bodhi_spellCheck
      if ('bodhi_autoEnableCaptions' in res) settings.autoEnableCaptions = res.bodhi_autoEnableCaptions
      applyAutoEnableCaptionsSetting()
    }
  );
}

chrome.storage.onChanged.addListener((changes) => {
  if (!isChromeContextValid()) return
  if (changes.bodhi_settings) {
    settings = { ...settings, ...changes.bodhi_settings.newValue }
    applyAutoEnableCaptionsSetting()
  }
  if (changes.bodhi_autoEnableCaptions) {
    settings.autoEnableCaptions = changes.bodhi_autoEnableCaptions.newValue
    applyAutoEnableCaptionsSetting()
  }
  if (changes.bodhi_theme) {
    const v = changes.bodhi_theme.newValue
    if (v === 'light' || v === 'dark' || v === 'system') {
      themePref = v
      applyThemeToOpenWidget()
    }
  }
})

chrome.runtime.onMessage.addListener((msg) => {
  if (!isChromeContextValid()) return
  if (msg.type !== 'BODHI_SETTING') return;
  switch (msg.key) {
    case 'enabled':     settings.enabled     = msg.value; break;
    case 'autoDismiss': settings.autoDismiss = msg.value; break;
    case 'spellCheck':  settings.spellCheck  = msg.value; break;
    case 'autoEnableCaptions':
      settings.autoEnableCaptions = msg.value
      applyAutoEnableCaptionsSetting()
      break
    case 'theme':
      if (msg.value === 'light' || msg.value === 'dark' || msg.value === 'system') {
        themePref = msg.value
        applyThemeToOpenWidget()
      }
      break
  }
});

function getVideoId() {
  try {
    const url = new URL(window.location.href)
    return url.searchParams.get('v') || null
  } catch { return null }
}

/** Per-video history lives in chrome.storage.local (survives refresh/restart). */
const HISTORY_MAX_ENTRIES_PER_VIDEO = 200
const HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

/**
 * `bodhi_session_keys` is a durable index of `bodhi_history_*` keys in
 * chrome.storage.local — not browser-session scoped. Name is historical.
 */
function pruneHistoryEntries(entries) {
  const cutoff = Date.now() - HISTORY_MAX_AGE_MS
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => {
      if (!e || !e.word) return false
      const ts = e.timestamp || e.ts
      // Legacy rows may lack ts — keep them (do not treat missing as expired)
      if (!ts) return true
      return ts >= cutoff
    })
    .sort((a, b) => (b.timestamp || b.ts || 0) - (a.timestamp || a.ts || 0))
    .slice(0, HISTORY_MAX_ENTRIES_PER_VIDEO)
}

async function pruneAllHistoryStorage() {
  if (!isChromeContextValid()) return
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (all) => {
      if (chrome.runtime.lastError || !all) { resolve(); return }
      const keys = Object.keys(all).filter((k) => k.startsWith('bodhi_history_'))
      // bodhi_session_keys index (durable; survives refresh)
      let sessionKeys = Array.isArray(all.bodhi_session_keys) ? [...all.bodhi_session_keys] : []
      const patch = {}
      let indexChanged = false

      const toRemove = []
      keys.forEach((k) => {
        const pruned = pruneHistoryEntries(all[k])
        if (pruned.length === 0) {
          toRemove.push(k)
          sessionKeys = sessionKeys.filter((sk) => sk !== k)
          indexChanged = true
        } else if (pruned.length !== (all[k]?.length || 0)) {
          patch[k] = pruned
        }
      })

      const nextKeys = sessionKeys.filter((sk) => all[sk] || patch[sk])
      if (JSON.stringify(nextKeys) !== JSON.stringify(all.bodhi_session_keys || [])) {
        indexChanged = true
        sessionKeys = nextKeys
      }
      if (indexChanged) patch.bodhi_session_keys = sessionKeys

      const finish = () => {
        if (Object.keys(patch).length === 0) { resolve(); return }
        chrome.storage.local.set(patch, resolve)
      }
      if (toRemove.length) {
        chrome.storage.local.remove(toRemove, finish)
      } else {
        finish()
      }
    })
  })
}

async function saveWordToHistory(entry) {
  if (!isChromeContextValid()) return
  const videoId = getVideoId()
  if (!videoId || !entry?.word) return

  return new Promise((resolve) => {
    const storageKey = `bodhi_history_${videoId}`
    chrome.storage.local.get([storageKey, 'bodhi_history_index', 'bodhi_session_keys'], (result) => {
      if (chrome.runtime.lastError) { resolve(); return }

      const existing = pruneHistoryEntries(result[storageKey] || [])
      const globalIndex = (result.bodhi_history_index || 0) + 1
      // Durable video-key index (not cleared on refresh)
      const sessionKeys = result.bodhi_session_keys || []

      const newEntry = {
        id: globalIndex,
        word: entry.word,
        pos: entry.pos || '',
        definition: entry.definition || '',
        source: entry.source, // 'hotkey' | 'search'
        videoId,
        timestamp: Date.now(),
      }

      if (existing.length > 0 && existing[0].word === newEntry.word && existing[0].source === newEntry.source) {
        // Still refresh timestamp/definition on repeat lookup
        const merged = [{ ...existing[0], ...newEntry, id: existing[0].id }, ...existing.slice(1)]
        chrome.storage.local.set({
          [storageKey]: merged,
          bodhi_last_word: merged[0],
        }, resolve)
        return
      }

      const updated = pruneHistoryEntries([newEntry, ...existing])

      if (!sessionKeys.includes(storageKey)) sessionKeys.push(storageKey)
      chrome.storage.local.set({
        [storageKey]: updated,
        bodhi_history_index: globalIndex,
        bodhi_last_word: newEntry,
        bodhi_session_keys: sessionKeys,
      }, resolve)
    })
  })
}

async function loadSpellChecker() {
  if (spellChecker || spellCheckerLoading) return
  spellCheckerLoading = true

  try {
    const affUrl = chrome.runtime.getURL('dict/index.aff')
    const dicUrl = chrome.runtime.getURL('dict/index.dic')

    const [affRes, dicRes] = await Promise.all([fetch(affUrl), fetch(dicUrl)])

    if (!affRes.ok || !dicRes.ok) {
      console.warn('Bodhi: Failed to load dictionary files')
      spellCheckerLoading = false
      return
    }

    const [aff, dic] = await Promise.all([affRes.text(), dicRes.text()])
    spellChecker = nspell(aff, dic)
    spellCheckerLoading = false

    spellCheckerCallbacks.forEach(cb => cb(spellChecker))
    spellCheckerCallbacks = []
  } catch (err) {
    console.warn('Bodhi: Failed to initialize spell checker', err)
    spellCheckerLoading = false
  }
}

function withSpellChecker(cb) {
  if (spellChecker) { cb(spellChecker); return }
  spellCheckerCallbacks.push(cb)
  loadSpellChecker()
}

function getSuggestions(query, callback) {
  if (!settings.spellCheck) { callback({ completions: [], corrections: [] }); return }
  const lower = query.toLowerCase().trim()
  if (!lower || lower.length < 2) { callback({ completions: [], corrections: [] }); return }

  withSpellChecker(checker => {
    const raw = checker.suggest(lower)
    const completions = raw.filter(w => w.toLowerCase().startsWith(lower)).slice(0, 5)
    const corrections = raw.filter(w => !w.toLowerCase().startsWith(lower)).slice(0, 4)
    callback({ completions, corrections })
  })
}

let widgetInstance = null
let isProcessing = false
let autoDismissTimer = null
let historyViewActive = false
let lastTextWindow = null

function cleanDefinition(str = '') {
  return String(str).replace(/\s*\|\|+\s*$/g, '').trim()
}

function escHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escAttr(str = '') {
  return escHtml(str).replace(/'/g, '&#39;')
}

function isHistoryViewOpen(widget = widgetInstance) {
  if (historyViewActive) return true
  const hv = widget?.querySelector?.('.bodhi-history-view')
  return !!(hv && !hv.classList.contains('is-hidden'))
}

function clearAutoDismiss() {
  if (autoDismissTimer) {
    clearTimeout(autoDismissTimer)
    autoDismissTimer = null
  }
}

function scheduleAutoDismiss(duration = 6500) {
  clearAutoDismiss()
  if (!settings.autoDismiss) return
  if (!widgetInstance) return
  if (isHistoryViewOpen(widgetInstance)) return
  const captured = widgetInstance
  autoDismissTimer = setTimeout(() => {
    if (widgetInstance === captured) hideWidget()
  }, duration)
}

function pauseAutoDismiss() {
  clearAutoDismiss()
}

function resumeAutoDismiss(duration = 6500) {
  if (!settings.autoDismiss) return
  if (!widgetInstance) return
  if (isHistoryViewOpen(widgetInstance)) return
  scheduleAutoDismiss(duration)
}

function wireAutoDismissGuards(widget) {
  if (!widget) return

  const pause = () => pauseAutoDismiss()
  const resume = () => {
    const duration = widget.querySelector('.bodhi-search-row') ? 8000 : 6500
    resumeAutoDismiss(duration)
  }

  widget.addEventListener('mouseenter', pause)
  widget.addEventListener('mouseleave', resume)
  widget.addEventListener('focusin', pause)
  widget.addEventListener('keydown', pause)
  widget.addEventListener('wheel', pause, { passive: true })

  const historyList = widget.querySelector('.bodhi-history-list')
  if (historyList) {
    historyList.addEventListener('scroll', pause, { passive: true })
  }
}

const MAX_CANDIDATES = 15

const session = {
  status: 'idle',
  rankedWords: [],
  currentIndex: 0,
}

function clearSession() {
  session.status = 'idle'
  session.rankedWords = []
  session.currentIndex = 0
  lastTextWindow = null
}

function startSession(rankedWords) {
  session.status = 'active'
  session.rankedWords = rankedWords
  session.currentIndex = 0
}

function hasMoreWords() {
  const next = session.currentIndex + 1
  return next < MAX_CANDIDATES && next < session.rankedWords.length
}

const UNAVAILABLE_COPY = {
  NO_CAPTIONS: {
    title: 'Captions unavailable',
    body: 'Enable CC on this video (or pick a video with captions) so Bodhi can listen.',
    actions: ['search'],
  },
  EMPTY_WINDOW: {
    title: 'Nothing in this moment',
    body: 'Captions are on, but the last few seconds were quiet or not ready yet. Try again shortly.',
    actions: ['retry', 'search'],
  },
  NO_HARD_WORD: {
    title: 'All clear',
    body: 'Nothing tricky in this stretch — keep watching.',
    actions: ['search'],
  },
  LOOKUP_FAILED: {
    title: "Couldn't fetch a definition",
    body: 'Network or dictionary issue — not a vocabulary win.',
    actions: ['retry', 'search'],
  },
}

function isMac() { return navigator.platform.toUpperCase().includes('MAC') }

function matchesHotkey(event) {
  if (event.key.toLowerCase() !== 'b') return false
  return isMac()
    ? event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
    : event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey
}

function matchesSearchHotkey(event) {
  if (event.key.toLowerCase() !== 'b') return false
  return isMac()
    ? event.metaKey && !event.ctrlKey && event.shiftKey && !event.altKey
    : event.ctrlKey && !event.metaKey && event.shiftKey && !event.altKey
}

function handleSearchHotkey() {
  if (widgetInstance) { hideWidget(); clearSession(); return }
  showSearchBox('still curious? search it.')
}

async function findNextWordWithDefinition() {
  while (true) {
    const next = session.currentIndex + 1
    const exhausted = next >= MAX_CANDIDATES || next >= session.rankedWords.length
    if (exhausted) return null
    session.currentIndex = next
    const word = session.rankedWords[session.currentIndex]
    const result = await fetchDefinition(word.word, lastTextWindow)
    if (result.definition) return result
  }
}

async function loadVideoHistory() {
  if (!isChromeContextValid()) return []
  const videoId = getVideoId()
  if (!videoId) return []

  return new Promise((resolve) => {
    const storageKey = `bodhi_history_${videoId}`
    chrome.storage.local.get([storageKey], (result) => {
      if (chrome.runtime.lastError) { resolve([]); return }
      const pruned = pruneHistoryEntries(result[storageKey] || [])
      // Persist prune so refresh always reloads the same durable list
      if (pruned.length !== (result[storageKey] || []).length) {
        chrome.storage.local.set({ [storageKey]: pruned }, () => resolve(pruned))
        return
      }
      resolve(pruned)
    })
  })
}

/** Solid strokes in dense lists — dashed motif reads as garbled “dots” next to words. */
function hotkeyIconSvg({ solid = false } = {}) {
  const dashBox = solid ? '' : ' stroke-dasharray="1.5 2.4"'
  const dashLine = solid ? '' : ' stroke-dasharray="1 1.8"'
  return `<svg class="bodhi-method-icon bodhi-method-caption" width="13" height="11" viewBox="0 0 16 13" fill="none" aria-hidden="true">
    <rect x="1" y="1" width="14" height="11" rx="2.5"
      stroke="currentColor" stroke-width="1.1"${dashBox}
      stroke-linecap="round" fill="none"/>
    <line x1="5.5" y1="6.5" x2="10.5" y2="6.5"
      stroke="currentColor" stroke-width="1" stroke-linecap="round"${dashLine}/>
    <line x1="8" y1="4" x2="8" y2="9"
      stroke="currentColor" stroke-width="1" stroke-linecap="round"${dashLine}/>
  </svg>`
}

function searchIconSvg({ solid = false } = {}) {
  const dashRing = solid ? '' : ' stroke-dasharray="1.5 2.4"'
  const dashHandle = solid ? '' : ' stroke-dasharray="1.2 2"'
  return `<svg class="bodhi-method-icon bodhi-method-search" width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <circle cx="6" cy="6" r="4.2"
      stroke="currentColor" stroke-width="1.1"${dashRing}
      stroke-linecap="round" fill="none"/>
    <line x1="9.3" y1="9.3" x2="12.8" y2="12.8"
      stroke="currentColor" stroke-width="1.1" stroke-linecap="round"${dashHandle}/>
  </svg>`
}

function historyClockSvg() {
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="8.5"
      stroke="currentColor" stroke-width="1.4"
      stroke-dasharray="2 3" stroke-linecap="round" fill="none"/>
    <polyline class="bodhi-clock-hands" points="12,8 12,12.5 15,14.8"
      stroke="currentColor" stroke-width="1.4"
      stroke-linecap="round" stroke-linejoin="round"
      stroke-dasharray="1.5 2.2"/>
  </svg>`
}

function methodBadgeHtml(source) {
  const isSearch = source === 'search'
  const title = isSearch ? 'Found via search' : 'Found via captions (⌘B)'
  const icon = isSearch ? searchIconSvg() : hotkeyIconSvg()
  // Compact chip stays inside the card — CSS tips were clipped to “Found via sea”
  const label = isSearch ? 'search' : 'captions'
  return `<span class="bodhi-method" aria-label="${title}" title="${title}">
    ${icon}<span class="bodhi-method-label">${label}</span>
  </span>`
}

function toolbarHtml({ showHistory = false, showBack = false, title = '' } = {}) {
  return `
    <div class="bodhi-toolbar">
      <div class="bodhi-toolbar-left">
        ${showBack ? `<button class="bodhi-back" aria-label="Back">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <polyline points="15,6 9,12 15,18"
              stroke="currentColor" stroke-width="1.5"
              stroke-linecap="round" stroke-linejoin="round"
              stroke-dasharray="2 2.5"/>
          </svg>
        </button>` : ''}
      </div>
      ${title
        ? `<div class="bodhi-toolbar-title">${title}</div>`
        : `<div class="bodhi-toolbar-spacer"></div>`}
      <div class="bodhi-toolbar-actions">
        ${showHistory ? `<button class="bodhi-history-btn" data-action="open-history" aria-label="Video history">
          ${historyClockSvg()}
        </button>` : ''}
        <button class="bodhi-close" aria-label="Close Bodhi">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
    </div>
  `
}

function historyViewHtml(history, currentWordId) {
  // Label matches persistence: per-video history in chrome.storage.local (not tab-session).
  return `
    <div class="bodhi-history-view is-hidden">
      ${toolbarHtml({ showBack: true, title: 'history' })}
      <div class="bodhi-divider" role="separator"></div>
      <div class="bodhi-history-list" role="listbox" aria-label="Video history">
        ${buildHistoryView(history || [], currentWordId)}
      </div>
    </div>
  `
}

function formatSearchHint(message) {
  const text = String(message || '')
  // Keep "search it." un-underlined even if host-page link styles leak in.
  if (text.includes('search it.')) {
    return text.replace(
      'search it.',
      '<span class="bodhi-search-hint-em">search it.</span>',
    )
  }
  return text
}

function setHistoryKeyboardFocus(list, index) {
  const rows = Array.from(list.querySelectorAll('.bodhi-history-row'))
  rows.forEach((row, i) => {
    const entry = row.querySelector('.bodhi-history-entry')
    const on = i === index
    entry?.classList.toggle('is-kb-focus', on)
    if (on) entry?.scrollIntoView({ block: 'nearest' })
  })
  return rows
}

function toggleHistoryRowExpand(row, list) {
  if (!row || !list) return
  const wasOpen = row.classList.contains('is-expanded')
  list.querySelectorAll('.bodhi-history-row.is-expanded').forEach((r) => {
    r.classList.remove('is-expanded')
    r.querySelector('.bodhi-history-entry')?.setAttribute('aria-expanded', 'false')
    r.querySelector('.bodhi-history-chevron')?.classList.remove('open')
  })
  if (!wasOpen) {
    row.classList.add('is-expanded')
    row.querySelector('.bodhi-history-entry')?.setAttribute('aria-expanded', 'true')
    row.querySelector('.bodhi-history-chevron')?.classList.add('open')
    row.scrollIntoView({ block: 'nearest' })
  }
}

function attachHistoryHandlers(widget) {
  widget.querySelectorAll('.bodhi-close').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      hideWidget()
      clearSession()
    })
  })

  // Scope to history view — recent refactors left back unwired / easy to miss
  const backBtn = widget.querySelector('.bodhi-history-view .bodhi-back')
  if (backBtn) {
    backBtn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      pauseAutoDismiss()
      historyViewActive = false
      const historyView = widget.querySelector('.bodhi-history-view')
      const mainView = widget.querySelector('.bodhi-main-view')
      if (!historyView || !mainView) return
      // Collapse any open inline defs before leaving
      historyView.querySelectorAll('.bodhi-history-row.is-expanded').forEach((r) => {
        r.classList.remove('is-expanded')
        r.querySelector('.bodhi-history-entry')?.setAttribute('aria-expanded', 'false')
        r.querySelector('.bodhi-history-chevron')?.classList.remove('open')
      })
      swapInnerViews(historyView, mainView)
      setTimeout(() => resumeAutoDismiss(8000), MOTION_FAST_MS + 20)
    })
  }

  const historyBtn = widget.querySelector('[data-action="open-history"]')
  if (historyBtn) {
    historyBtn.addEventListener('click', async (e) => {
      e.preventDefault()
      e.stopPropagation()
      pauseAutoDismiss()
      historyViewActive = true
      spinClockHands(historyBtn)
      // Always re-read durable storage so refresh/reopen never shows a stale empty shell
      const history = await loadVideoHistory()
      const historyList = widget.querySelector('.bodhi-history-list')
      const currentWord = widget.querySelector('.bodhi-word')?.textContent?.trim() || ''
      const currentWordId = history.find((h) => h.word === currentWord)?.id
        ?? (history[0]?.id ?? null)
      if (historyList) {
        historyList.innerHTML = buildHistoryView(history, currentWordId)
        bindHistoryListInteractions(widget, historyList)
      }
      swapInnerViews(
        widget.querySelector('.bodhi-main-view'),
        widget.querySelector('.bodhi-history-view'),
      )
      setTimeout(() => { historyList?.focus() }, 50)
    })
  }

  const historyList = widget.querySelector('.bodhi-history-list')
  if (!historyList) return
  bindHistoryListInteractions(widget, historyList)
}

function bindHistoryListInteractions(widget, historyList) {
  if (!historyList) return

  const backBtn = widget.querySelector('.bodhi-history-view .bodhi-back')
  historyList.setAttribute('tabindex', '0')

  // Delegate once — survives innerHTML refresh from storage
  if (historyList.dataset.bound === '1') return
  historyList.dataset.bound = '1'

  historyList.addEventListener('click', (e) => {
    const entry = e.target.closest?.('.bodhi-history-entry')
    if (!entry || !historyList.contains(entry)) return
    e.preventDefault()
    e.stopPropagation()
    pauseAutoDismiss()
    const row = entry.closest('.bodhi-history-row')
    toggleHistoryRowExpand(row, historyList)
    const rows = Array.from(historyList.querySelectorAll('.bodhi-history-row'))
    const idx = rows.indexOf(row)
    if (idx >= 0) setHistoryKeyboardFocus(historyList, idx)
  })

  let activeHistoryIdx = -1
  historyList.addEventListener('keydown', (e) => {
    const rows = Array.from(historyList.querySelectorAll('.bodhi-history-row'))
    if (!rows.length) return
    pauseAutoDismiss()
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      e.stopPropagation()
      activeHistoryIdx = Math.min(activeHistoryIdx + 1, rows.length - 1)
      setHistoryKeyboardFocus(historyList, activeHistoryIdx)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      activeHistoryIdx = Math.max(activeHistoryIdx - 1, 0)
      setHistoryKeyboardFocus(historyList, activeHistoryIdx)
    } else if (e.key === 'Enter' && activeHistoryIdx >= 0) {
      e.preventDefault()
      e.stopPropagation()
      toggleHistoryRowExpand(rows[activeHistoryIdx], historyList)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      backBtn?.click()
    }
  })
}

function spinClockHands(btn) {
  const hands = btn.querySelector('.bodhi-clock-hands')
  if (!hands) return
  hands.classList.remove('bodhi-history-hands-spin')
  void hands.getBoundingClientRect()
  hands.classList.add('bodhi-history-hands-spin')
  hands.addEventListener('animationend', () => {
    hands.classList.remove('bodhi-history-hands-spin')
  }, { once: true })
}

function buildSearchBoxHtml() {
  return `
    <div class="bodhi-search-wrap">
      <div class="bodhi-search-row">
        <input class="bodhi-search-input" type="text" placeholder="type a word..."
          autocomplete="off" spellcheck="false"/>
        <button class="bodhi-search-btn" aria-label="Search">
          <svg class="bodhi-search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none">
            <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.4"
              stroke-linecap="round" stroke-dasharray="1.8 2.8" fill="none"/>
            <line x1="16.5" y1="16.5" x2="21" y2="21"
              stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
      <div class="bodhi-suggestions-panel"></div>
    </div>
  `
}

function attachSearchHandlers(widget) {
  const input = widget.querySelector('.bodhi-search-input')
  const searchBtn = widget.querySelector('.bodhi-search-btn')
  const searchRow = widget.querySelector('.bodhi-search-row')
  const panel = widget.querySelector('.bodhi-suggestions-panel')

  let activeIdx = -1
  let allItems = []
  let debounceTimer = null
  let typedQuery = ''

  const updateIcon = (hasText) => {
    const icon = widget.querySelector('.bodhi-search-icon')
    const allParts = widget.querySelectorAll('.bodhi-search-icon circle, .bodhi-search-icon line')
    const width = hasText ? '1.8' : '1.4'
    allParts.forEach(el => {
      el.setAttribute('stroke', 'currentColor')
      el.setAttribute('stroke-width', width)
    })
    if (icon) {
      icon.style.color = hasText ? 'var(--bodhi-ink)' : 'var(--bodhi-ink-faint)'
    }
  }

  const resetIdleTimer = () => {
    pauseAutoDismiss()
    if (!settings.autoDismiss) return
    if (isHistoryViewOpen(widget)) return
    scheduleAutoDismiss(8000)
  }

  const hideSuggestions = () => {
    if (panel) panel.classList.remove('bodhi-suggestions-open')
    if (searchRow) searchRow.classList.remove('bodhi-search-focused')
    activeIdx = -1; allItems = []
  }

  const updateActiveRow = () => {
    const scrollContainer = panel?.querySelector('.bodhi-suggestions-scroll')
    panel?.querySelectorAll('.bodhi-suggestion-row').forEach((row, i) => {
      row.classList.toggle('bodhi-suggestion-active', i === activeIdx)
      if (i === activeIdx && scrollContainer) {
        const rowTop = row.offsetTop, rowBottom = rowTop + row.offsetHeight
        const containerTop = scrollContainer.scrollTop
        const containerBottom = containerTop + scrollContainer.clientHeight
        if (rowBottom > containerBottom) scrollContainer.scrollTop = rowBottom - scrollContainer.clientHeight
        else if (rowTop < containerTop) scrollContainer.scrollTop = rowTop
      }
    })
  }

  const renderSuggestions = (completions, corrections) => {
    if (!panel) return
    const merged = [
      ...completions.map(w => ({ word: w, type: 'completion' })),
      ...corrections.map(w => ({ word: w, type: 'correction' })),
    ]
    allItems = merged
    if (allItems.length === 0) { hideSuggestions(); return }

    panel.innerHTML = `
      <div class="bodhi-suggestions-section">
        <div class="bodhi-suggestions-label">
          <hr class="bodhi-suggestions-label-line correction"/>
          <span class="bodhi-suggestions-label-text correction">did you mean?</span>
          <hr class="bodhi-suggestions-label-line correction"/>
        </div>
        <div class="bodhi-suggestions-scroll">
          ${allItems.map((item, i) => `
            <button class="bodhi-suggestion-row" data-index="${i}">
              <svg class="bodhi-suggestion-icon" width="12" height="8" viewBox="0 0 20 12" fill="none" style="flex-shrink:0;">
                <path d="M2 6 Q5 1 8 6 Q11 11 14 6 Q17 1 20 6" stroke="#BB9999" stroke-width="1.6" stroke-linecap="round" fill="none" stroke-dasharray="1.6 2"/>
              </svg>
              <span class="bodhi-suggestion-word-correction">${item.word}</span>
            </button>
          `).join('')}
        </div>
      </div>
      <span class="bodhi-suggestions-hint">↑ ↓ navigate · enter select · esc close</span>
    `
    panel.classList.add('bodhi-suggestions-open')
    if (searchRow) searchRow.classList.add('bodhi-search-focused')
    activeIdx = -1

    panel.querySelectorAll('.bodhi-suggestion-row').forEach(row => {
      row.addEventListener('mouseenter', () => {
        resetIdleTimer(); activeIdx = parseInt(row.dataset.index); updateActiveRow()
      })
      row.addEventListener('mousedown', e => {
        resetIdleTimer(); e.preventDefault()
        const word = allItems[parseInt(row.dataset.index)]?.word
        if (word && input) { input.value = word; hideSuggestions(); handleSearch() }
      })
    })
  }

  const handleSearch = async () => {
    const query = input?.value?.trim()
    if (!query) return
    hideSuggestions()

    const btn = widget.querySelector('.bodhi-search-btn')
    if (btn) {
      btn.style.pointerEvents = 'none'
      btn.innerHTML = `<svg class="bodhi-dotted-spinner" width="18" height="18" viewBox="0 0 24 24" style="color:var(--bodhi-ink-soft)">
        <circle cx="12" cy="3" r="1.5" fill="currentColor" opacity="1"></circle>
        <circle cx="18.36" cy="5.64" r="1.5" fill="currentColor" opacity="0.8"></circle>
        <circle cx="21" cy="12" r="1.5" fill="currentColor" opacity="0.6"></circle>
        <circle cx="18.36" cy="18.36" r="1.5" fill="currentColor" opacity="0.4"></circle>
        <circle cx="12" cy="21" r="1.5" fill="currentColor" opacity="0.2"></circle>
        <circle cx="5.64" cy="18.36" r="1.5" fill="currentColor" opacity="0.15"></circle>
        <circle cx="3" cy="12" r="1.5" fill="currentColor" opacity="0.15"></circle>
        <circle cx="5.64" cy="5.64" r="1.5" fill="currentColor" opacity="0.15"></circle>
      </svg>`
    }

    const result = await fetchDefinitionForSearch(query)
    if (widgetInstance !== widget) return

    const searchIconHtml = `<svg class="bodhi-search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" style="color:var(--bodhi-ink-faint)">
      <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.4"
        stroke-linecap="round" stroke-dasharray="1.8 2.8" fill="none"/>
      <line x1="16.5" y1="16.5" x2="21" y2="21"
        stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
    </svg>`

    if (btn) { btn.style.pointerEvents = 'auto'; btn.innerHTML = searchIconHtml }

    if (result.definition) {
      await saveWordToHistory({ word: result.word, pos: result.partOfSpeech, definition: result.definition, source: 'search' })
      showSearchResult(result.word, result.partOfSpeech, result.definition)
      resetIdleTimer()
    } else {
      if (btn) { btn.innerHTML = searchIconHtml; btn.style.pointerEvents = 'auto' }
      if (input) { input.value = ''; input.placeholder = 'nothing found, try again...' }
      resetIdleTimer()
    }
  }

  resetIdleTimer()

  if (input) {
    input.addEventListener('input', () => {
      const val = input.value; typedQuery = val
      updateIcon(val.trim().length > 0); resetIdleTimer()
      clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        if (val.trim().length < 2) { hideSuggestions(); return }
        getSuggestions(val, ({ completions, corrections }) => {
          if (completions.length === 0 && corrections.length === 0) hideSuggestions()
          else renderSuggestions(completions, corrections)
        })
      }, 150)
    })

    input.addEventListener('focus', () => {
      resetIdleTimer()
      if (searchRow) searchRow.classList.add('bodhi-search-focused')
      if (input.value.trim().length >= 2) {
        getSuggestions(input.value, ({ completions, corrections }) => {
          if (completions.length > 0 || corrections.length > 0) renderSuggestions(completions, corrections)
        })
      }
    })

    input.addEventListener('blur', () => {
      if (searchRow) searchRow.classList.remove('bodhi-search-focused')
      setTimeout(hideSuggestions, 300)
    })

    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); resetIdleTimer()
      if (e.key === 'Enter') { e.preventDefault(); handleSearch() }
      else if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (allItems.length > 0) {
          activeIdx = Math.min(activeIdx + 1, allItems.length - 1)
          updateActiveRow(); if (input) input.value = allItems[activeIdx].word
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault(); activeIdx = Math.max(activeIdx - 1, -1); updateActiveRow()
        if (input) input.value = activeIdx >= 0 ? allItems[activeIdx].word : typedQuery
      } else if (e.key === 'Tab' && allItems.length > 0) {
        e.preventDefault()
        const word = allItems[activeIdx >= 0 ? activeIdx : 0]?.word
        if (word && input) { input.value = word; hideSuggestions() }
      } else if (e.key === 'Escape') {
        if (input) input.value = typedQuery; hideSuggestions()
      }
    })

    setTimeout(() => { if (input) input.focus() }, 50)
  }

  if (searchBtn) searchBtn.addEventListener('click', () => { resetIdleTimer(); handleSearch() })
}

function dotsRow(count, offsetIndex) {
  return `<div class="bodhi-skeleton-row">
    ${Array.from({ length: count }).map((_, i) =>
      `<div class="bodhi-skeleton-dot" style="animation-delay:${((offsetIndex * 4) + i) * 0.07}s"></div>`
    ).join('')}
  </div>`
}

function buildHistoryView(history, currentWordId) {
  const entries = history

  if (entries.length === 0) {
    return `<div class="bodhi-history-empty">no lookups yet this video</div>`
  }

  return entries.map((entry, i) => {
    const isCurrent = entry.id === currentWordId
    const source = entry.source === 'search' ? 'search' : 'hotkey'
    // Solid icons in the list — dashed strokes were reading as “garbled” fragments
    const icon = source === 'hotkey' ? hotkeyIconSvg({ solid: true }) : searchIconSvg({ solid: true })
    const definition = cleanDefinition(entry.definition || '')
    const defHtml = definition
      ? escHtml(definition)
      : '<span class="bodhi-history-def-missing">No definition saved for this word.</span>'

    const tip = source === 'hotkey' ? 'Looked up via ⌘B' : 'Looked up via search'
    const word = String(entry.word || '').trim()
    if (!word) return ''

    return `<div class="bodhi-history-row${isCurrent ? ' is-current' : ''}" data-history-idx="${i}">
      <button type="button" class="bodhi-history-entry${isCurrent ? ' is-current' : ''}"
        data-word="${escAttr(word)}"
        data-pos="${escAttr(entry.pos || '')}"
        data-source="${source}"
        aria-label="${escAttr(word)}${entry.pos ? `, ${escAttr(entry.pos)}` : ''}. ${tip}"
        aria-expanded="false">
        <span class="bodhi-history-entry-main">
          <span class="bodhi-method-tip" aria-hidden="true">${icon}</span>
          <span class="bodhi-history-word${isCurrent ? ' is-current' : ''}">${escHtml(word)}</span>
        </span>
        <span class="bodhi-history-entry-meta">
          ${entry.pos ? `<span class="bodhi-history-pos">${escHtml(entry.pos)}</span>` : ''}
          <svg class="bodhi-history-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <polyline points="6 9 12 15 18 9" stroke="currentColor" stroke-width="1.8"
              stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </span>
      </button>
      <div class="bodhi-history-def">
        <p>${defHtml}</p>
      </div>
    </div>`
  }).join('')
}

const MOTION_FAST_MS = 140
const MOTION_BASE_MS = 220
const MOTION_CLOSE_MS = 140

function mountWidget(widget) {
  applyThemeToElement(widget)
  widget.classList.add('bodhi-widget-enter')
  document.body.appendChild(widget)
  widgetInstance = widget
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      widget.classList.add('bodhi-widget-enter-active')
      widget.classList.remove('bodhi-widget-enter')
      setTimeout(() => {
        widget.classList.remove('bodhi-widget-enter-active')
      }, MOTION_BASE_MS)
    })
  })
}

function swapInnerViews(fromEl, toEl) {
  if (!fromEl || !toEl) return
  fromEl.classList.add('is-fading')
  setTimeout(() => {
    fromEl.classList.add('is-hidden')
    fromEl.classList.remove('is-fading')
    toEl.classList.remove('is-hidden')
    toEl.classList.add('is-fading')
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        toEl.classList.remove('is-fading')
      })
    })
  }, MOTION_FAST_MS)
}

async function showSkeleton() {
  clearAutoDismiss()
  await hideWidget()
  const widget = document.createElement('div')
  widget.className = 'bodhi-widget'
  const position = getStoredPosition() || getDefaultPosition()
  widget.style.top = position.top + 'px'
  widget.style.left = position.left + 'px'

  widget.innerHTML = `
    ${toolbarHtml()}
    <div class="bodhi-panel">
      <div class="bodhi-skeleton">
        ${dotsRow(10, 0)}
        ${dotsRow(5, 1)}
        ${dotsRow(14, 2)}
        ${dotsRow(11, 3)}
        ${dotsRow(8, 4)}
      </div>
    </div>
  `

  const closeBtn = widget.querySelector('.bodhi-close')
  if (closeBtn) {
    closeBtn.addEventListener('click', () => { hideWidget(); clearSession() })
  }

  makeDraggable(widget)
  mountWidget(widget)
}

async function showSearchResult(word, partOfSpeech, definition) {
  await hideWidget()
  const history = await loadVideoHistory()
  const showHistoryBtn = history.length > 0
  const currentWordId = history.length > 0 ? history[0].id : null
  const cleanDef = cleanDefinition(definition)

  const widget = document.createElement('div')
  widget.className = 'bodhi-widget'
  const position = getStoredPosition() || getDefaultPosition()
  widget.style.top = position.top + 'px'
  widget.style.left = position.left + 'px'

  widget.innerHTML = `
    <div class="bodhi-main-view">
      ${toolbarHtml({ showHistory: showHistoryBtn })}
      <div class="bodhi-panel">
        <div class="bodhi-word-row">
          <div class="bodhi-word"><span class="bodhi-selectable">${word}</span></div>
          ${methodBadgeHtml('search')}
        </div>
        ${partOfSpeech ? `<div class="bodhi-pos bodhi-selectable">${partOfSpeech}</div>` : ''}
        <div class="bodhi-definition bodhi-selectable">${cleanDef}</div>
        <div class="bodhi-footer-link">
          <button class="bodhi-search-link" data-action="search-another">search another →</button>
        </div>
      </div>
    </div>
    ${historyViewHtml(history, currentWordId)}
  `

  attachHistoryHandlers(widget)
  wireAutoDismissGuards(widget)
  const searchLink = widget.querySelector('[data-action="search-another"]')
  if (searchLink) searchLink.addEventListener('click', () => showSearchBox('still curious? search it.'))

  makeDraggable(widget)
  mountWidget(widget)
  scheduleAutoDismiss(8000)
}

async function showSearchBox(message) {
  session.status = 'search'
  await hideWidget()
  const history = await loadVideoHistory()
  const showHistoryBtn = history.length > 0

  const widget = document.createElement('div')
  widget.className = 'bodhi-widget bodhi-search-expanded'
  const position = getStoredPosition() || getDefaultPosition()
  widget.style.top = position.top + 'px'
  widget.style.left = position.left + 'px'

  widget.innerHTML = `
    <div class="bodhi-main-view">
      ${toolbarHtml({ showHistory: showHistoryBtn })}
      <div class="bodhi-panel">
        <p class="bodhi-search-hint">${formatSearchHint(message)}</p>
        ${buildSearchBoxHtml()}
      </div>
    </div>
    ${historyViewHtml(history, null)}
  `

  attachHistoryHandlers(widget)
  attachSearchHandlers(widget)
  wireAutoDismissGuards(widget)
  makeDraggable(widget)
  mountWidget(widget)
}

function buildUnavailableActions(actions) {
  const parts = []
  if (actions.includes('retry')) {
    parts.push(`<button class="bodhi-search-link" data-action="retry-hotkey"
      style="width:auto !important; padding:4px 0 !important; text-align:center !important;">
      try again
    </button>`)
  }
  if (actions.includes('search')) {
    parts.push(`<button class="bodhi-search-link" data-action="open-search"
      style="width:auto !important; padding:4px 0 !important; text-align:center !important;">
      search a word →
    </button>`)
  }
  return parts.join('')
}

function createWidget(word, partOfSpeech, definition, state, history, currentWordId, reason = null, source = 'hotkey') {
  const widget = document.createElement('div')
  widget.className = 'bodhi-widget'
  const position = getStoredPosition() || getDefaultPosition()
  widget.style.top = position.top + 'px'
  widget.style.left = position.left + 'px'

  const showHistoryBtn = history && history.length > 0 && state !== 'skeleton'

  const nextBtnHtml = `
    <button class="bodhi-thumb" data-feedback="next" aria-label="Next word">
      <svg class="bodhi-next-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M 21 12 A 9 9 0 1 1 17 4.5"
          stroke="currentColor" stroke-width="1.5"
          stroke-linecap="round" stroke-dasharray="2 2.8" fill="none"/>
        <polyline points="14,2 17.2,4.6 14.8,7.8"
          stroke="currentColor" stroke-width="1.5"
          stroke-linecap="round" stroke-linejoin="round"
          stroke-dasharray="1.6 2.4" fill="none"/>
      </svg>
    </button>
  `

  const cleanDef = cleanDefinition(definition)
  let content = ''

  if (state === 'unavailable') {
    const copy = UNAVAILABLE_COPY[reason] || UNAVAILABLE_COPY.LOOKUP_FAILED
    content = `
      ${toolbarHtml({ showHistory: showHistoryBtn })}
      <div class="bodhi-unavailable" data-reason="${reason || ''}">
        <p class="bodhi-unavailable-title">${copy.title}</p>
        <p class="bodhi-unavailable-body">
          ${copy.body}
        </p>
        <div class="bodhi-unavail-actions">
          ${buildUnavailableActions(copy.actions)}
        </div>
      </div>
    `
  } else {
    content = `
      ${toolbarHtml({ showHistory: showHistoryBtn })}
      <div class="bodhi-word-row">
        <div class="bodhi-word">
          <span class="bodhi-selectable">${word}</span>
        </div>
        ${methodBadgeHtml(source)}
      </div>
      ${partOfSpeech ? `<div class="bodhi-pos bodhi-selectable">${partOfSpeech}</div>` : ''}
      <div class="bodhi-definition bodhi-selectable">
        ${cleanDef}
      </div>
      <div class="bodhi-feedback">
        <div class="bodhi-divider" role="separator"></div>
        <div class="bodhi-action-row">
          ${hasMoreWords() ? `${nextBtnHtml}` : `<button class="bodhi-search-link" data-action="open-search">search a word →</button>`}
        </div>
      </div>
    `
  }

  const wrapper = document.createElement('div')
  wrapper.innerHTML = `<div class="bodhi-main-view">${content}</div>${historyViewHtml(history, currentWordId)}`
  while (wrapper.firstChild) widget.appendChild(wrapper.firstChild)

  attachHistoryHandlers(widget)
  wireAutoDismissGuards(widget)

  const nextBtn = widget.querySelector('[data-feedback="next"]')
  if (nextBtn) {
    nextBtn.addEventListener('click', async () => {
      if (nextBtn.dataset.spinning === 'true') return
      nextBtn.dataset.spinning = 'true'
      pauseAutoDismiss()

      const svg = nextBtn.querySelector('svg')
      if (svg) {
        svg.style.transition = 'none'; svg.style.transform = 'rotate(0deg)'
        svg.getBoundingClientRect()
        svg.style.transition = 'transform 0.5s ease'; svg.style.transform = 'rotate(360deg)'
        svg.querySelectorAll('path, polyline').forEach(el => el.setAttribute('stroke', 'currentColor'))
        setTimeout(() => {
          svg.querySelectorAll('path, polyline').forEach(el => el.setAttribute('stroke', 'currentColor'))
          nextBtn.dataset.spinning = 'false'
        }, 520)
      }

      const result = await findNextWordWithDefinition()
      if (result) {
        await saveWordToHistory({ word: result.word, pos: result.partOfSpeech, definition: result.definition, source: 'hotkey' })
        const updatedHistory = await loadVideoHistory()
        showWidget(result.word, result.partOfSpeech, result.definition, 'success', updatedHistory)
      } else {
        showSearchBox('still curious? search it.')
      }
    })
  }

  widget.querySelectorAll('[data-action="open-search"]').forEach((searchLink) => {
    searchLink.addEventListener('click', () => showSearchBox('still curious? search it.'))
  })
  widget.querySelectorAll('[data-action="retry-hotkey"]').forEach((retryBtn) => {
    retryBtn.addEventListener('click', () => {
      hideWidget()
      clearSession()
      handleHotkey()
    })
  })

  makeDraggable(widget)

  return widget
}

async function showWidget(word, partOfSpeech, definition, widgetState, history = [], currentWordId = null, reason = null, source = 'hotkey') {
  if (!settings.enabled) return;

  clearAutoDismiss()
  await hideWidget()
  const widget = createWidget(word, partOfSpeech, definition, widgetState, history, currentWordId, reason, source)
  mountWidget(widget)

  requestAnimationFrame(() => {
    const duration = widgetState === 'success'
      ? 6500
      : widgetState === 'unavailable'
        ? 10000
        : 6000
    scheduleAutoDismiss(duration)
  })
}

function hideWidget() {
  return new Promise((resolve) => {
    clearAutoDismiss()
    historyViewActive = false
    const el = widgetInstance
    if (!el) {
      resolve()
      return
    }
    widgetInstance = null
    el.classList.add('bodhi-widget-exit')
    setTimeout(() => {
      el.remove()
      resolve()
    }, MOTION_CLOSE_MS)
  })
}

async function handleHotkey() {
  if (!isChromeContextValid()) return
  if (!settings.enabled) return
  if (isProcessing) return
  isProcessing = true

  try {
    if (widgetInstance) { await hideWidget(); clearSession(); return }
    clearSession()

    if (!transcriptManager.isReady()) await transcriptManager.waitUntilReady()

    const status = transcriptManager.getStatus
      ? transcriptManager.getStatus()
      : { mode: transcriptManager.getMode(), ready: transcriptManager.isReady() }
    const mode = status.mode

    if (mode === 'unavailable') {
      const history = await loadVideoHistory()
      showWidget('', '', '', 'unavailable', history, null, 'NO_CAPTIONS')
      return
    }

    const snap = transcriptManager.getSnapshot
      ? transcriptManager.getSnapshot()
      : null
    const video = document.querySelector('video')
    const currentTime = snap?.t ?? (video ? video.currentTime : 0)
    const textWindow = snap?.text ?? transcriptManager.getTextWindow(currentTime)
    if (!textWindow) {
      const history = await loadVideoHistory()
      showWidget('', '', '', 'unavailable', history, null, 'EMPTY_WINDOW')
      return
    }

    const phrases = snap?.phrases?.length
      ? snap.phrases
      : (transcriptManager.getPhrasesInWindow
        ? transcriptManager.getPhrasesInWindow(currentTime - 3, currentTime)
        : [])
    lastTextWindow = textWindow

    const prediction = await predict(textWindow, phrases, currentTime)
    if (!prediction || prediction.length === 0) {
      const history = await loadVideoHistory()
      showWidget('', '', '', 'unavailable', history, null, 'NO_HARD_WORD')
      return
    }

    startSession(prediction)
    await showSkeleton()

    let result = null
    while (session.currentIndex < Math.min(MAX_CANDIDATES, session.rankedWords.length)) {
      const word = session.rankedWords[session.currentIndex]
      result = await fetchDefinition(word.word, lastTextWindow)
      if (result.definition) break
      session.currentIndex++
      result = null
    }

    if (!result || !result.definition) {
      const history = await loadVideoHistory()
      showWidget('', '', '', 'unavailable', history, null, 'LOOKUP_FAILED')
      clearSession(); return
    }

    await saveWordToHistory({ word: result.word, pos: result.partOfSpeech, definition: result.definition, source: 'hotkey' })
    const history = await loadVideoHistory()
    const currentWordId = history.length > 0 ? history[0].id : null

    showWidget(result.word, result.partOfSpeech, result.definition, 'success', history, currentWordId)

  } catch (err) {
    console.error('Bodhi error:', err)
    const history = await loadVideoHistory()
    showWidget('', '', '', 'unavailable', history, null, 'LOOKUP_FAILED')
    clearSession()
  } finally {
    isProcessing = false
  }
}

function handleKeydown(e) {
  if (matchesSearchHotkey(e)) {
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation()
    handleSearchHotkey(); return
  }
  if (!matchesHotkey(e)) return
  e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation()
  handleHotkey()
}

function addDragOverlay(element) {
  removeDragOverlay(element)
  const w = element.offsetWidth, h = element.offsetHeight
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.classList.add('bodhi-drag-overlay')
  svg.setAttribute('width', w); svg.setAttribute('height', h)
  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  rect.setAttribute('x', '1.5'); rect.setAttribute('y', '1.5')
  rect.setAttribute('width', w - 3); rect.setAttribute('height', h - 3)
  rect.setAttribute('rx', '14.5'); rect.setAttribute('ry', '14.5')
  rect.setAttribute('fill', 'none')
  rect.setAttribute('stroke', 'currentColor')
  rect.setAttribute('stroke-width', '1.5')
  rect.setAttribute('stroke-dasharray', '2 4.5')
  rect.setAttribute('stroke-linecap', 'round')
  svg.style.color = 'var(--bodhi-ink-faint)'
  svg.appendChild(rect); element.appendChild(svg)
}

function removeDragOverlay(element) {
  const existing = element.querySelector('.bodhi-drag-overlay')
  if (existing) existing.remove()
}

function makeDraggable(element) {
  let isDragging = false, startX, startY, initialLeft, initialTop

  element.addEventListener('mousedown', (e) => {
    if (
      e.target.closest('.bodhi-close') || e.target.closest('.bodhi-back') ||
      e.target.closest('.bodhi-thumb') || e.target.closest('.bodhi-history-btn') ||
      e.target.closest('.bodhi-search-row') || e.target.closest('.bodhi-search-link') ||
      e.target.closest('.bodhi-suggestions-scroll') || e.target.closest('.bodhi-history-list') ||
      e.target.closest('.bodhi-history-entry') || e.target.closest('.bodhi-history-row')
    ) return

    isDragging = true
    startX = e.clientX; startY = e.clientY
    initialLeft = element.offsetLeft; initialTop = element.offsetTop

    pauseAutoDismiss()

    element.classList.add('bodhi-widget-dragging')
    element.style.cursor = 'grabbing'
    element.style.willChange = 'transform'
    addDragOverlay(element)

    document.addEventListener('mousemove', drag)
    document.addEventListener('mouseup', stopDrag)
    e.preventDefault()
  })

  const drag = (e) => {
    if (!isDragging) return
    const padding = 8
    const newLeft = Math.max(padding, Math.min(initialLeft + e.clientX - startX, window.innerWidth - element.offsetWidth - padding))
    const newTop = Math.max(padding, Math.min(initialTop + e.clientY - startY, window.innerHeight - element.offsetHeight - padding))
    element.style.left = newLeft + 'px'; element.style.top = newTop + 'px'
  }

  const stopDrag = () => {
    if (!isDragging) return
    isDragging = false
    element.classList.remove('bodhi-widget-dragging')
    element.style.cursor = 'grab'
    removeDragOverlay(element)
    element.style.willChange = ''; element.style.boxShadow = ''; element.style.transform = ''
    storePosition(element.offsetLeft, element.offsetTop)
    document.removeEventListener('mousemove', drag)
    document.removeEventListener('mouseup', stopDrag)

    requestAnimationFrame(() => {
      if (widgetInstance && widgetInstance.querySelector('.bodhi-skeleton')) return
      const duration = widgetInstance?.querySelector('.bodhi-search-row') ? 8000 : 6000
      resumeAutoDismiss(duration)
    })
  }

  element.style.cursor = 'grab'
}

function getStoredPosition() {
  try { return JSON.parse(localStorage.getItem('bodhi_position')) } catch { return null }
}
function storePosition(left, top) {
  try { localStorage.setItem('bodhi_position', JSON.stringify({ left, top })) } catch {}
}
function getDefaultPosition() {
  return {
    left: Math.max(16, (window.innerWidth - 280) / 2),
    top: Math.max(16, window.innerHeight - 200 - 80)
  }
}

function onVideoChange() { hideWidget(); clearSession() }

function init() {
  loadSettings()
  initThemeListeners()
  loadSpellChecker()
  // Rolling retention: drop entries older than 30d / over the per-video cap
  pruneAllHistoryStorage()
  document.addEventListener('keydown', handleKeydown, true)
  transcriptManager.init()

  const titleEl = document.querySelector('title')
  if (titleEl) {
    new MutationObserver(() => onVideoChange()).observe(titleEl, { childList: true })
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}
