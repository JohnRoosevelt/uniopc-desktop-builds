function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function renderInlineMarkdown(text) {
  const placeholders = []
  let next = escapeHtml(text)

  next = next.replace(/`([^`]+)`/g, (_, code) => {
    const token = `__CODE_${placeholders.length}__`
    placeholders.push(`<code class="rounded bg-surface-overlay px-1.5 py-0.5 text-[0.92em] text-accent-text">${escapeHtml(code)}</code>`)
    return token
  })

  next = next.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, href) => {
    const token = `__LINK_${placeholders.length}__`
    placeholders.push(
      `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer" class="text-accent-text underline decoration-violet-400/40 underline-offset-4 hover:text-accent-text">${escapeHtml(label)}</a>`,
    )
    return token
  })

  next = next
    .replace(/\*\*([^*]+)\*\*/g, '<strong class="font-semibold text-primary">$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em class="italic text-primary">$1</em>')
    .replace(/~~([^~]+)~~/g, '<del class="line-through opacity-70">$1</del>')

  placeholders.forEach((value, index) => {
    next = next.replaceAll(`__CODE_${index}__`, value).replaceAll(`__LINK_${index}__`, value)
  })

  return next
}

export function renderMarkdownToHtml(source) {
  const lines = String(source || '').replace(/\r\n/g, '\n').split('\n')
  const html = []
  let paragraph = []
  let listItems = []
  let listType = null
  let quoteLines = []
  let inCodeBlock = false
  let codeLines = []

  function flushParagraph() {
    if (!paragraph.length) return
    html.push(`<p class="my-4 leading-8 text-primary">${renderInlineMarkdown(paragraph.join(' '))}</p>`)
    paragraph = []
  }

  function flushList() {
    if (!listItems.length) return
    const tag = listType === 'ol' ? 'ol' : 'ul'
    const marker = listType === 'ol' ? 'list-decimal' : 'list-disc'
    html.push(
      `<${tag} class="my-4 ml-6 ${marker} space-y-2 text-primary">${listItems
        .map(item => `<li>${renderInlineMarkdown(item)}</li>`)
        .join('')}</${tag}>`,
    )
    listItems = []
    listType = null
  }

  function flushQuote() {
    if (!quoteLines.length) return
    const content = quoteLines
      .map(line => `<p class="leading-7 ${line ? 'text-primary' : 'text-transparent'}">${line ? renderInlineMarkdown(line) : '&nbsp;'}</p>`)
      .join('')
    html.push(`<blockquote class="my-5 border-l-2 border-violet-400/40 pl-4 text-primary">${content}</blockquote>`)
    quoteLines = []
  }

  function flushCodeBlock() {
    if (!inCodeBlock) return
    html.push(
      `<pre class="my-5 overflow-x-auto rounded-2xl border border-subtle bg-surface-base px-4 py-4 text-sm leading-7 text-primary"><code>${escapeHtml(
        codeLines.join('\n'),
      )}</code></pre>`,
    )
    inCodeBlock = false
    codeLines = []
  }

  for (const rawLine of lines) {
    const line = rawLine ?? ''

    if (line.trim().startsWith('```')) {
      flushParagraph()
      flushList()
      flushQuote()
      if (inCodeBlock) {
        flushCodeBlock()
      } else {
        inCodeBlock = true
      }
      continue
    }

    if (inCodeBlock) {
      codeLines.push(line)
      continue
    }

    if (!line.trim()) {
      flushParagraph()
      flushList()
      flushQuote()
      continue
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/)
    if (headingMatch) {
      flushParagraph()
      flushList()
      flushQuote()
      const level = headingMatch[1].length
      const sizes = {
        1: 'text-4xl',
        2: 'text-3xl',
        3: 'text-2xl',
        4: 'text-xl',
        5: 'text-lg',
        6: 'text-base',
      }
      html.push(
        `<h${level} class="mt-${level <= 2 ? '8' : '6'} mb-3 font-semibold tracking-[-0.02em] text-primary ${sizes[level]}">${renderInlineMarkdown(
          headingMatch[2],
        )}</h${level}>`,
      )
      continue
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushParagraph()
      flushList()
      flushQuote()
      html.push('<hr class="my-6 border-subtle" />')
      continue
    }

    const quoteMatch = line.match(/^>\s?(.*)$/)
    if (quoteMatch) {
      flushParagraph()
      flushList()
      quoteLines.push(quoteMatch[1])
      continue
    }

    const orderedMatch = line.match(/^\d+\.\s+(.*)$/)
    if (orderedMatch) {
      flushParagraph()
      flushQuote()
      if (listType && listType !== 'ol') flushList()
      listType = 'ol'
      listItems.push(orderedMatch[1])
      continue
    }

    const unorderedMatch = line.match(/^[-*]\s+(.*)$/)
    if (unorderedMatch) {
      flushParagraph()
      flushQuote()
      if (listType && listType !== 'ul') flushList()
      listType = 'ul'
      listItems.push(unorderedMatch[1])
      continue
    }

    flushList()
    flushQuote()
    paragraph.push(line.trim())
  }

  flushParagraph()
  flushList()
  flushQuote()
  flushCodeBlock()

  return html.join('')
}
