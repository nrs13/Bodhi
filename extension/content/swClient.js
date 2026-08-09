export function sendToSw(message) {
  return new Promise((resolve, reject) => {
    if (!chrome?.runtime?.id) {
      reject(new Error('no_extension_context'))
      return
    }
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
        return
      }
      resolve(response)
    })
  })
}

export function nextRequestId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}
