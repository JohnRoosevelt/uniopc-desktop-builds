const FORWARDED_SPECIAL_KEYS = new Set([
  'Enter', 'Tab', 'Backspace', 'Escape', 'ArrowUp', 'ArrowDown',
  'ArrowLeft', 'ArrowRight', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
])

/** Pure input-method/key transition used by the conversation Browser Runtime dock. */
export function browserDockKeyboardTransition(composing, event) {
  const state = typeof composing === 'object'
    ? {
      composing: Boolean(composing.composing),
      suppressNextCommitKey: Boolean(composing.suppressNextCommitKey),
      suppressCompositionInput: typeof composing.suppressCompositionInput === 'string' ? composing.suppressCompositionInput : '',
    }
    : { composing: Boolean(composing), suppressNextCommitKey: false, suppressCompositionInput: '' }
  switch (event.type) {
    case 'compositionstart':
      return { composing: true, suppressNextCommitKey: false, suppressCompositionInput: '', action: null }
    case 'compositionupdate':
      return { ...state, composing: true, action: null }
    case 'compositionend':
      return {
        composing: false,
        // WKWebView may deliver the IME's Enter/Tab after compositionend.
        // Keep a one-key marker; the caller expires it on the next task.
        suppressNextCommitKey: true,
        suppressCompositionInput: typeof event.data === 'string' ? event.data : '',
        action: typeof event.data === 'string' && event.data.length > 0
          ? { type: 'text', text: event.data }
          : null,
      }
    case 'commit-window-expired':
      return { ...state, suppressNextCommitKey: false, suppressCompositionInput: '', action: null }
    case 'input': {
      if (state.composing) return { ...state, action: null }
      const text = typeof event.data === 'string' && event.data.length > 0
        ? event.data
        : typeof event.value === 'string' ? event.value : ''
      if (state.suppressCompositionInput && (!text || text === state.suppressCompositionInput)) {
        return { ...state, suppressCompositionInput: '', action: null }
      }
      return {
        ...state,
        suppressCompositionInput: '',
        action: text && (!event.inputType || event.inputType === 'insertText' || event.inputType === 'insertReplacementText' || event.inputType === 'insertCompositionText')
          ? { type: 'text', text }
          : null,
      }
    }
    case 'keydown': {
      if (state.composing || event.isComposing || event.keyCode === 229 || event.key === 'Process' || event.key === 'Unidentified') {
        return { ...state, action: null }
      }
      const commitKey = event.key === 'Enter' || event.key === 'Tab' || event.key === ' '
      if (state.suppressNextCommitKey && commitKey) {
        return { ...state, suppressNextCommitKey: false, suppressKey: true, action: null }
      }
      if (event.key === 'Control' || event.key === 'Meta' || event.key === 'Alt' || event.key === 'Shift') {
        return { ...state, action: null }
      }
      if (event.ctrlKey || event.metaKey || event.altKey) {
        return {
          ...state,
          composing: false,
          suppressNextCommitKey: false,
          // CDP modifier bits: Alt=1, Ctrl=2, Meta=4, Shift=8.
          action: { type: 'key', key: event.key, modifiers: (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0) },
        }
      }
      if (typeof event.key === 'string' && event.key.length === 1) {
        return { ...state, composing: false, suppressNextCommitKey: false, action: { type: 'text', text: event.key } }
      }
      if (FORWARDED_SPECIAL_KEYS.has(event.key)) {
        return { ...state, composing: false, suppressNextCommitKey: false, action: { type: 'key', key: event.key } }
      }
      return { ...state, composing: false, suppressNextCommitKey: false, action: null }
    }
    default:
      return { ...state, action: null }
  }
}
