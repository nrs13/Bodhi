const PAGE_SIZE = 4

let allLookups  = []
let pageOffset  = 0
let expandedIdx = null
let settings    = { enabled: true, autoDismiss: true, spellCheck: true, autoEnableCaptions: true }

function wavyIconSvg(hovered) {
  const color = hovered ? '#AAAAAA' : '#DDDDDD'
  return `<svg width="14" height="8" viewBox="0 0 20 10" fill="none" style="flex-shrink:0;">
    <path d="M1 6 Q4 1 7 6 Q10 11 13 6 Q16 1 19 6"
      stroke="${color}" stroke-width="1.5" stroke-linecap="round"
      fill="none" stroke-dasharray="1.6 2"
      style="transition:stroke 0.12s ease;"/>
  </svg>`
}

function dottedDividerSvg() {
  return `<svg style="width:100%;display:block;" height="10" viewBox="0 0 300 10" preserveAspectRatio="none">
    <line x1="0" y1="5" x2="300" y2="5"
      stroke="#E8E8E8" stroke-width="1.5"
      stroke-linecap="round" stroke-dasharray="2 5.5"/>
  </svg>`
}

function escHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function renderLookups() {
  const lookupList  = document.getElementById('lookup-list')
  const lookupNav   = document.getElementById('recent-nav')
  const navUp       = document.getElementById('nav-up')
  const navDown     = document.getElementById('nav-down')
  const navCount    = document.getElementById('nav-hint')

  if (!lookupList) return

  const section = document.querySelector('.recent-section')
  if (section) section.style.flex = ''

  const total = allLookups.length

  if (total === 0) {
    lookupList.innerHTML = `
      <div class="lookup-empty">
        <span class="lookup-empty-icon">∿</span>
        <span class="lookup-empty-line1">no lookups yet</span>
        <span class="lookup-empty-line2">press ${navigator.platform.toUpperCase().includes('MAC') ? '⌘B' : 'Ctrl+B'} while a video plays</span>
      </div>`
    if (lookupNav)  lookupNav.style.display = 'none'
    if (section) section.style.flex = '0'
    return
  }

  const maxOffset = Math.max(0, total - PAGE_SIZE)
  if (pageOffset > maxOffset) pageOffset = maxOffset

  const page    = allLookups.slice(pageOffset, pageOffset + PAGE_SIZE)
  const hasMore = total > PAGE_SIZE

  if (lookupNav)  lookupNav.style.display = hasMore ? 'flex' : 'none'
  if (navUp)      navUp.disabled   = pageOffset === 0
  if (navDown)    navDown.disabled = pageOffset >= maxOffset
  if (navCount)   navCount.textContent = `${pageOffset + 1}–${Math.min(pageOffset + PAGE_SIZE, total)} of ${total}`

  let html = ''
  page.forEach((entry, i) => {
    const isExpanded = expandedIdx === i
    const icon = wavyIconSvg(false)
    const hasdef = !!entry.definition

    const chevron = hasdef ? `
      <svg class="lookup-chevron${isExpanded ? ' open' : ''}"
        width="10" height="10" viewBox="0 0 24 24" fill="none">
        <polyline points="6 9 12 15 18 9"
          stroke="#888888" stroke-width="1.8"
          stroke-linecap="round" stroke-linejoin="round"/>
      </svg>` : ''

    html += `
      <button class="lookup-item" data-page-idx="${i}">
        <div class="lookup-item-inner">
          <div class="lookup-item-left">
            ${icon}
            <span class="lookup-word">${escHtml(entry.word)}</span>
          </div>
          <div class="lookup-right">
            ${entry.pos ? `<span class="lookup-pos">${escHtml(entry.pos)}</span>` : ''}
            ${chevron}
          </div>
        </div>
      </button>
      ${hasdef ? `
        <div class="lookup-def${isExpanded ? ' open' : ''}">
          <p>${escHtml(entry.definition)}</p>
        </div>` : ''}
      ${i < page.length - 1 ? `<div class="lookup-divider">${dottedDividerSvg()}</div>` : ''}
    `
  })

  lookupList.innerHTML = html

  lookupList.querySelectorAll('.lookup-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.pageIdx)
      expandedIdx = expandedIdx === idx ? null : idx
      renderLookups()
    })
    btn.addEventListener('mouseenter', () => {
      const icon = btn.querySelector('svg path')
      if (icon) icon.setAttribute('stroke', '#AAAAAA')
    })
    btn.addEventListener('mouseleave', () => {
      const icon = btn.querySelector('svg path')
      if (icon) icon.setAttribute('stroke', '#DDDDDD')
    })
  })
}

function applyToggle(btn, value) {
  if (!btn) return
  btn.classList.toggle('on', value)
  btn.setAttribute('aria-checked', String(value))
}

function persistSettings() {
  // Write both formats: merged object (for content.js onChanged listener)
  // AND three separate keys (for content.js loadSettings fallback)
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
  const scannerDot   = document.getElementById('scanner-dot')
  const footerTagline = document.getElementById('footer-tagline')

  if (headerCircle) {
    headerCircle.style.animation = value ? 'bodhi-dash-orbit 3.5s linear infinite' : 'none'
    headerCircle.style.opacity   = value ? '1' : '0.45'
  }
  if (headerLine)     headerLine.style.opacity    = value ? '1' : '0.45'
  if (scannerDot)     scannerDot.classList.toggle('scanning', value)
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
    ['bodhi_settings', 'bodhi_enabled', 'bodhi_autoDismiss', 'bodhi_spellCheck', 'bodhi_autoEnableCaptions'],
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
      applyToggle(document.getElementById('toggle-enabled'),     settings.enabled)
      applyToggle(document.getElementById('toggle-autodismiss'), settings.autoDismiss)
      applyToggle(
        document.getElementById('toggle-autoenable-captions'),
        settings.autoEnableCaptions !== false,
      )
      applyEnabledVisuals(settings.enabled)
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
        allLookups = result[`bodhi_history_${videoId}`] || []
        renderLookups()
      })
    } else {
      chrome.storage.local.get(['bodhi_session_keys'], (res) => {
        const sessionKeys = res.bodhi_session_keys || []
        if (sessionKeys.length === 0) { allLookups = []; renderLookups(); return }
        chrome.storage.local.get(sessionKeys, (data) => {
          const entries = []
          sessionKeys.forEach(k => {
            if (Array.isArray(data[k])) entries.push(...data[k])
          })
          entries.sort((a, b) => (b.ts || b.timestamp || 0) - (a.ts || a.timestamp || 0))
          allLookups = entries
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

  setOsHotkeys()
  loadSettings()
  loadLookups()

  wireToggle('toggle-enabled',     'enabled')
  wireToggle('toggle-autodismiss', 'autoDismiss')
  wireToggle('toggle-autoenable-captions', 'autoEnableCaptions')

  function wireSection(headerId, bodyId) {
    const header = document.getElementById(headerId)
    const body   = document.getElementById(bodyId)
    if (!header || !body) return
    const chev = header.querySelector('.section-chevron')
    header.addEventListener('click', () => {
      const isOpen = body.classList.toggle('open')
      if (chev) chev.classList.toggle('open', isOpen)
    })
  }
  wireSection('shortcuts-header',  'shortcuts-body')
  wireSection('recent-header',     'recent-body')
  wireSection('settings-header',   'settings-body')

  const navUp   = document.getElementById('nav-up')
  const navDown = document.getElementById('nav-down')

  if (navUp) {
    navUp.addEventListener('click', () => {
      pageOffset  = Math.max(0, pageOffset - PAGE_SIZE)
      expandedIdx = null
      renderLookups()
    })
  }

  if (navDown) {
    navDown.addEventListener('click', () => {
      const maxOffset = Math.max(0, allLookups.length - PAGE_SIZE)
      pageOffset  = Math.min(maxOffset, pageOffset + PAGE_SIZE)
      expandedIdx = null
      renderLookups()
    })
  }

  const listWrap = document.querySelector('.lookup-list-wrap')
  if (listWrap) {
    let wheelCooldown = false
    listWrap.addEventListener('wheel', (e) => {
      const total = allLookups.length
      if (total <= PAGE_SIZE) return
      e.preventDefault()
      if (wheelCooldown) return
      wheelCooldown = true
      setTimeout(() => { wheelCooldown = false }, 150)
      const maxOffset = Math.max(0, total - PAGE_SIZE)
      if (e.deltaY > 0 && pageOffset < maxOffset) {
        pageOffset  = Math.min(maxOffset, pageOffset + 1)
        expandedIdx = null
        renderLookups()
      } else if (e.deltaY < 0 && pageOffset > 0) {
        pageOffset  = Math.max(0, pageOffset - 1)
        expandedIdx = null
        renderLookups()
      }
    }, { passive: false })
  }

  document.addEventListener('keydown', (e) => {
    const total = allLookups.length
    if (total === 0) return
    const maxOffset = Math.max(0, total - PAGE_SIZE)

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (pageOffset < maxOffset) {
        pageOffset  = Math.min(maxOffset, pageOffset + 1)
        expandedIdx = null
        renderLookups()
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (pageOffset > 0) {
        pageOffset  = Math.max(0, pageOffset - 1)
        expandedIdx = null
        renderLookups()
      }
    }
  })

  const bgSvg = document.querySelector('.header-bg-dots')
  if (bgSvg) {
    let dots = ''
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 9; col++) {
        dots += `<circle cx="${col * 14 + 7}" cy="${row * 13 + 6}" r="1.2" fill="#E0E0E0"/>`
      }
    }
    bgSvg.innerHTML = dots
  }

  chrome.storage.onChanged.addListener((changes) => {
    const historyChanged = Object.keys(changes).some(k => k.startsWith('bodhi_history_'))
    if (!historyChanged) return
    pageOffset  = 0
    expandedIdx = null
    loadLookups()
  })

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.body.classList.add('mounted')
    })
  })
})
