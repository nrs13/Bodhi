export function escHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function escAttr(str = '') {
  return escHtml(str).replace(/'/g, '&#39;')
}

export function cleanDefinition(str = '') {
  return String(str)
    .replace(/\|+/g, ' ')
    .replace(/\s+([.!?,;:])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}
