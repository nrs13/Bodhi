export const HISTORY_MAX_ENTRIES = 200
export const HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export function pruneHistoryEntries(entries, maxEntries = HISTORY_MAX_ENTRIES) {
  const cutoff = Date.now() - HISTORY_MAX_AGE_MS
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => {
      if (!e || !e.word) return false
      const ts = e.timestamp || e.ts
      if (!ts) return true
      return ts >= cutoff
    })
    .sort((a, b) => (b.timestamp || b.ts || 0) - (a.timestamp || a.ts || 0))
    .slice(0, maxEntries)
}
