// Repairs the still-streaming tail of a markdown string so half-typed syntax
// does not flash broken layout (an unclosed ``` fence swallowing the rest of
// the message, a dangling ** bolding everything, ...). Mirrors the approach
// used by mainstream AI chat clients: close what the model has not finished
// typing yet, purely for display — the underlying content is never mutated.

const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/

// Scans every line and tracks fenced-code state. Fenced blocks can span
// blank lines, so this has to look at the whole text, not just the tail.
export function openFenceMarker(text) {
  const value = String(text || '')
  let openMarker = ''
  for (const line of value.split('\n')) {
    const match = line.match(FENCE_PATTERN)
    if (!match) continue
    const marker = match[1]
    if (!openMarker) {
      openMarker = marker
    } else if (marker[0] === openMarker[0] && marker.length >= openMarker.length) {
      openMarker = ''
    }
  }
  return openMarker
}

function countOccurrences(value, token) {
  let count = 0
  let index = value.indexOf(token)
  while (index !== -1) {
    count += 1
    index = value.indexOf(token, index + token.length)
  }
  return count
}

// Counts single backticks that are not part of a longer backtick run.
function countInlineBackticks(value) {
  let count = 0
  for (const match of value.matchAll(/`+/g)) {
    if (match[0].length === 1) count += 1
  }
  return count
}

export function repairStreamingMarkdownTail(text) {
  const value = String(text || '')
  if (!value) return value

  const fenceMarker = openFenceMarker(value)
  if (fenceMarker) {
    // Inside an unfinished code block: closing inline pairs would corrupt the
    // code text, so only the fence itself gets closed.
    return `${value}\n${fenceMarker}`
  }

  // Inline pairs only matter in the paragraph still being typed; earlier
  // paragraphs are complete. (Same trick as Accio: repair after the last \n\n.)
  const tailStart = value.lastIndexOf('\n\n')
  const tail = tailStart === -1 ? value : value.slice(tailStart + 2)
  if (!tail.trim()) return value

  let suffix = ''
  if (countInlineBackticks(tail) % 2 === 1) suffix += '`'
  if (countOccurrences(tail, '**') % 2 === 1) suffix += '**'
  if (countOccurrences(tail, '~~') % 2 === 1) suffix += '~~'
  // Single-star italic is intentionally left alone: a lone `*` is far more
  // often an in-progress bullet ("* item") than an unclosed emphasis.
  return suffix ? value + suffix : value
}
