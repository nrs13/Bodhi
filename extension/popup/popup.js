let allLookups  = []
let expandedIdx = null
let kbActiveIdx = -1
let settings    = { enabled: true, autoDismiss: true, spellCheck: true, autoEnableCaptions: true }

/** Match content script retention: 30 days / 200 per video. */
const HISTORY_MAX_ENTRIES = 200
const HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

function pruneLookupEntries(entries) {
  const cutoff = Date.now() - HISTORY_MAX_AGE_MS
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => {
      if (!e || !e.word) return false
      const ts = e.timestamp || e.ts
      if (!ts) return true
      return ts >= cutoff
    })
    .sort((a, b) => (b.timestamp || b.ts || 0) - (a.timestamp || a.ts || 0))
    .slice(0, HISTORY_MAX_ENTRIES)
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

function applyResolvedTheme() {
  document.documentElement.setAttribute('data-bodhi-theme', resolveTheme())
}

function setThemePref(next) {
  if (next !== 'system' && next !== 'light' && next !== 'dark') return
  themePref = next
  chrome.storage.local.set({ bodhi_theme: themePref })
  applyResolvedTheme()
  syncThemeSeg()
  broadcastSetting('theme', themePref)
}

function syncThemeSeg() {
  const seg = document.getElementById('theme-seg')
  if (!seg) return
  seg.querySelectorAll('button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.theme === themePref)
  })
}

function methodIconSvg(source) {
  // Solid strokes in the recent list — dashed motif was reading as garbled fragments
  if (source === 'search') {
    return `<svg class="method-icon search" width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="6" cy="6" r="4.2" stroke="currentColor" stroke-width="1.1"
        stroke-linecap="round" fill="none"/>
      <line x1="9.3" y1="9.3" x2="12.8" y2="12.8" stroke="currentColor" stroke-width="1.1"
        stroke-linecap="round"/>
    </svg>`
  }
  return `<svg class="method-icon caption" width="13" height="11" viewBox="0 0 16 13" fill="none" aria-hidden="true">
    <rect x="1" y="1" width="14" height="11" rx="2.5" stroke="currentColor" stroke-width="1.1"
      stroke-linecap="round" fill="none"/>
    <line x1="5.5" y1="6.5" x2="10.5" y2="6.5" stroke="currentColor" stroke-width="1"
      stroke-linecap="round"/>
    <line x1="8" y1="4" x2="8" y2="9" stroke="currentColor" stroke-width="1"
      stroke-linecap="round"/>
  </svg>`
}

function emptyStateIconSvg() {
  return `<svg class="lookup-empty-icon" width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="7" stroke="currentColor" stroke-width="1.5"
      stroke-dasharray="2 2.8" stroke-linecap="round" fill="none"/>
    <line x1="17.2" y1="17.2" x2="22" y2="22" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`
}

function escHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function cleanDefinition(str = '') {
  return String(str)
    .replace(/\|+/g, ' ')
    .replace(/\s+([.!?,;:])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Nudge Chrome to recalculate popup window size after content toggles. */
function nudgePopupHeight() {
  void document.body.offsetHeight
}

function renderLookups() {
  const lookupList  = document.getElementById('lookup-list')
  const recentCount = document.getElementById('recent-count')
  const listScroll  = document.getElementById('lookup-list-scroll')
    || document.getElementById('lookup-list-wrap')

  if (!lookupList) return

  const total = allLookups.length
  if (recentCount) recentCount.textContent = total > 0 ? String(total) : ''

  if (total === 0) {
    const mod = navigator.platform.toUpperCase().includes('MAC') ? '⌘B' : 'Ctrl+B'
    lookupList.innerHTML = `
      <div class="lookup-empty">
        ${emptyStateIconSvg()}
        <span class="lookup-empty-line1">No lookups yet</span>
        <span class="lookup-empty-line2">Press ${mod} while a video plays</span>
      </div>`
    kbActiveIdx = -1
    nudgePopupHeight()
    return
  }

  if (kbActiveIdx >= total) kbActiveIdx = total - 1

  let html = ''
  allLookups.forEach((entry, i) => {
    const isExpanded = expandedIdx === i
    const isKb = kbActiveIdx === i
    const source = entry.source === 'search' ? 'search' : 'hotkey'
    const icon = methodIconSvg(source)
    const definition = cleanDefinition(entry.definition)
    const hasdef = !!definition

    const chevron = hasdef ? `
      <svg class="lookup-chevron${isExpanded ? ' open' : ''}"
        width="10" height="10" viewBox="0 0 24 24" fill="none">
        <polyline points="6 9 12 15 18 9"
          stroke="currentColor" stroke-width="1.8"
          stroke-linecap="round" stroke-linejoin="round"/>
      </svg>` : ''

    const tip = source === 'search' ? 'Found via search' : 'Found via captions'
    const rowClass = [
      'lookup-row',
      isExpanded ? 'is-expanded' : '',
      isKb ? 'is-stand' : '',
    ].filter(Boolean).join(' ')

    html += `
      <div class="${rowClass}" data-idx="${i}" role="option" aria-selected="${isKb}">
        <button type="button" class="lookup-item" data-idx="${i}">
          <div class="lookup-item-inner">
            <div class="lookup-item-left">
              <span class="method-tip" data-bodhi-tip="${tip}" aria-label="${tip}">${icon}</span>
              <span class="lookup-word">${escHtml(entry.word)}</span>
            </div>
            <div class="lookup-right">
              ${entry.pos ? `<span class="lookup-pos">${escHtml(entry.pos)}</span>` : ''}
              ${chevron}
            </div>
          </div>
        </button>
        ${hasdef ? `
          <div class="lookup-def${isExpanded ? ' open' : ''}" data-def-for="${i}">
            <p>${escHtml(definition)}</p>
          </div>` : ''}
      </div>
    `
  })

  lookupList.innerHTML = html

  lookupList.querySelectorAll('.lookup-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx, 10)
      kbActiveIdx = idx
      expandedIdx = expandedIdx === idx ? null : idx
      renderLookups()
      scrollKbIntoView()
    })
  })

  // Hover is CSS-only. Stand moves on click / ↑↓ only (standard listbox).

  if (listScroll && kbActiveIdx >= 0) scrollKbIntoView()
  nudgePopupHeight()
}

function scrollKbIntoView() {
  const listScroll = document.getElementById('lookup-list-scroll')
    || document.getElementById('lookup-list-wrap')
  const active = listScroll?.querySelector('.lookup-row.is-stand')
  if (active) active.scrollIntoView({ block: 'nearest' })
}

function applyToggle(btn, value) {
  if (!btn) return
  btn.classList.toggle('on', value)
  btn.setAttribute('aria-checked', String(value))
}

function persistSettings() {
  chrome.storage.local.set({
    bodhi_settings:            settings,
    bodhi_enabled:             settings.enabled,
    bodhi_autoDismiss:         settings.autoDismiss,
    bodhi_spellCheck:          settings.spellCheck,
    bodhi_autoEnableCaptions:  settings.autoEnableCaptions,
  })
}

function broadcastSetting(key, value) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs[0]?.id
    if (!tabId) return
    chrome.tabs.sendMessage(tabId, { type: 'BODHI_SETTING', key, value }).catch(() => {})
  })
}

function applyEnabledVisuals(value) {
  const headerCircle = document.getElementById('header-icon-circle')
  const headerLine   = document.getElementById('header-icon-line')
  const footerTagline = document.getElementById('footer-tagline')

  if (headerCircle) {
    headerCircle.style.animation = value ? 'bodhi-dash-orbit 3.5s linear infinite' : 'none'
    headerCircle.style.opacity   = value ? '1' : '0.45'
  }
  if (headerLine)     headerLine.style.opacity    = value ? '1' : '0.45'
  if (footerTagline)  footerTagline.style.opacity  = value ? '1' : '0.5'
}

function wireToggle(btnId, settingKey) {
  const btn = document.getElementById(btnId)
  if (!btn) return
  btn.addEventListener('click', () => {
    settings[settingKey] = !settings[settingKey]
    applyToggle(btn, settings[settingKey])
    persistSettings()
    broadcastSetting(settingKey, settings[settingKey])
    if (settingKey === 'enabled') applyEnabledVisuals(settings.enabled)
  })
}

function loadSettings() {
  chrome.storage.local.get(
    ['bodhi_settings', 'bodhi_enabled', 'bodhi_autoDismiss', 'bodhi_spellCheck', 'bodhi_autoEnableCaptions', 'bodhi_theme'],
    (result) => {
      if (result.bodhi_settings) {
        settings = { ...settings, ...result.bodhi_settings }
      } else {
        if ('bodhi_enabled'     in result) settings.enabled     = result.bodhi_enabled
        if ('bodhi_autoDismiss' in result) settings.autoDismiss = result.bodhi_autoDismiss
        if ('bodhi_spellCheck'  in result) settings.spellCheck  = result.bodhi_spellCheck
        if ('bodhi_autoEnableCaptions' in result) settings.autoEnableCaptions = result.bodhi_autoEnableCaptions
      }
      if ('bodhi_autoEnableCaptions' in result) {
        settings.autoEnableCaptions = result.bodhi_autoEnableCaptions
      }
      if (result.bodhi_theme === 'light' || result.bodhi_theme === 'dark' || result.bodhi_theme === 'system') {
        themePref = result.bodhi_theme
      }
      applyToggle(document.getElementById('toggle-enabled'),     settings.enabled)
      applyToggle(document.getElementById('toggle-autodismiss'), settings.autoDismiss)
      applyToggle(
        document.getElementById('toggle-autoenable-captions'),
        settings.autoEnableCaptions !== false,
      )
      applyEnabledVisuals(settings.enabled)
      applyResolvedTheme()
      syncThemeSeg()
    }
  )
}

function loadLookups() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const url   = tabs[0]?.url || ''
    let videoId = null
    try { videoId = new URL(url).searchParams.get('v') } catch {}

    if (videoId) {
      chrome.storage.local.get([`bodhi_history_${videoId}`], (result) => {
        // Durable per-video history (chrome.storage.local) — survives refresh
        allLookups = pruneLookupEntries(result[`bodhi_history_${videoId}`] || [])
        renderLookups()
      })
    } else {
      // bodhi_session_keys = durable index of video history keys (not tab-session)
      chrome.storage.local.get(['bodhi_session_keys'], (res) => {
        const sessionKeys = res.bodhi_session_keys || []
        if (sessionKeys.length === 0) { allLookups = []; renderLookups(); return }
        chrome.storage.local.get(sessionKeys, (data) => {
          const entries = []
          sessionKeys.forEach(k => {
            if (Array.isArray(data[k])) entries.push(...data[k])
          })
          allLookups = pruneLookupEntries(entries)
          renderLookups()
        })
      })
    }
  })
}

function setOsHotkeys() {
  const isMac = navigator.platform.toUpperCase().includes('MAC')
  const mod   = isMac ? '⌘' : 'Ctrl'
  const el1 = document.getElementById('key-mod')
  const el2 = document.getElementById('key-mod2')
  if (el1) el1.textContent = mod
  if (el2) el2.textContent = mod
}

document.addEventListener('DOMContentLoaded', () => {

  applyResolvedTheme()
  try {
    systemDarkMq = window.matchMedia('(prefers-color-scheme: dark)')
    const onScheme = () => {
      if (themePref === 'system') applyResolvedTheme()
    }
    if (systemDarkMq.addEventListener) systemDarkMq.addEventListener('change', onScheme)
    else if (systemDarkMq.addListener) systemDarkMq.addListener(onScheme)
  } catch { /* ignore */ }

  setOsHotkeys()
  loadSettings()
  loadLookups()

  wireToggle('toggle-enabled',     'enabled')
  wireToggle('toggle-autodismiss', 'autoDismiss')
  wireToggle('toggle-autoenable-captions', 'autoEnableCaptions')

  const themeSeg = document.getElementById('theme-seg')
  if (themeSeg) {
    themeSeg.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => setThemePref(btn.dataset.theme))
    })
  }

  function wireSection(headerId, bodyId) {
    const header = document.getElementById(headerId)
    const body   = document.getElementById(bodyId)
    if (!header || !body) return
    const chev = header.querySelector('.section-chevron')
    header.addEventListener('click', () => {
      const isOpen = body.classList.toggle('open')
      if (chev) chev.classList.toggle('open', isOpen)
      nudgePopupHeight()
    })
  }
  wireSection('shortcuts-header', 'shortcuts-body')
  wireSection('settings-header', 'settings-body')
  wireSection('recent-header', 'recent-body')

  document.addEventListener('keydown', (e) => {
    const total = allLookups.length
    if (total === 0) return

    const tag = (e.target && e.target.tagName) || ''
    if (tag === 'INPUT' || tag === 'TEXTAREA') return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      kbActiveIdx = kbActiveIdx < 0 ? 0 : Math.min(kbActiveIdx + 1, total - 1)
      renderLookups()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      kbActiveIdx = kbActiveIdx < 0 ? total - 1 : Math.max(kbActiveIdx - 1, 0)
      renderLookups()
    } else if (e.key === 'Enter' && kbActiveIdx >= 0) {
      e.preventDefault()
      const entry = allLookups[kbActiveIdx]
      if (!cleanDefinition(entry?.definition)) return
      expandedIdx = expandedIdx === kbActiveIdx ? null : kbActiveIdx
      renderLookups()
    }
  })

  chrome.storage.onChanged.addListener((changes) => {
    const historyChanged = Object.keys(changes).some(k => k.startsWith('bodhi_history_'))
    if (!historyChanged) return
    expandedIdx = null
    kbActiveIdx = -1
    loadLookups()
  })

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.body.classList.add('mounted')
    })
  })
})
