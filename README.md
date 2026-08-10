# Bodhi

Vocabulary from video.

A Chrome extension that looks up harder words while you watch YouTube. Captions stay on. The video keeps playing.

## Features

**Caption lookup**  
Press ⌘B (Mac) or Ctrl+B (Windows). Bodhi finds a harder word from recent captions and shows the meaning on a floating card.

**Next word**  
Use Next on the card to try another hard word from the same caption window.

**Search**  
Press ⌘⇧B (Mac) or Ctrl+Shift+B (Windows). Type any word. Spelling suggestions appear as you type.

**Drag**  
Drag the card anywhere on the page. Bodhi remembers where you left it.

**History**  
Open History on the card to see lookups for this video. Click a row to show the definition. Use ↑ ↓ and Enter to move and open rows.

**Recent**  
Open the Bodhi popup in Chrome to see recent lookups for the current video. Same click and keyboard controls.

**Source label**  
Each word shows whether it came from captions or search.

**Settings**  
In the popup you can turn Bodhi on or off, auto-dismiss the card, auto-enable YouTube captions, and set appearance to Auto, Light, or Dark.

## Requirements

Chrome (or another Chromium browser) and Node.js to build.

API keys are optional but recommended. Get free keys at dictionaryapi.com (Merriam-Webster Learner’s) and developer.wordnik.com (Wordnik). Without keys, Bodhi uses a public dictionary fallback.

## Setup

```bash
git clone https://github.com/nrs13/Bodhi.git
cd Bodhi/extension
cp background/secrets.example.js background/secrets.js
```

Add your keys in `background/secrets.js`. This file stays local and is not committed.

```bash
npm install
npm run build
```

## Load In Chrome

1. Open `chrome://extensions`
2. Turn on Developer mode
3. Click Load unpacked
4. Select the `extension/dist` folder

## Shortcuts

On a YouTube watch page with captions:

Mac: ⌘B caption lookup. ⌘⇧B search.  
Windows: Ctrl+B caption lookup. Ctrl+Shift+B search.

## Project Layout

`extension/background` dictionary APIs and service worker  
`extension/content` YouTube page script and widget  
`extension/popup` toolbar popup  
`extension/styles` widget styles  
`extension/icons` brand mark and icons  
`extension/dist` build output to load in Chrome
