import { useEffect, useId, useRef } from 'react'

/**
 * Modal — unified modal shell.
 *
 * Props:
 *   open: boolean
 *   onClose: () => void
 *   title: string (optional header title)
 *   description: string (optional header description)
 *   header: custom header node
 *   size: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl'
 *   panelClassName: optional class names for the modal shell
 *   bodyClassName: optional class names for the scrollable body
 *   children: modal body content
 *   footer: optional footer (typically action buttons)
 */
const SIZES = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-2xl',
  '2xl': 'max-w-3xl',
  '3xl': 'max-w-4xl',
}

const FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export default function Modal({
  open,
  onClose,
  title,
  description,
  header,
  size = 'md',
  panelClassName = '',
  bodyClassName = '',
  children,
  footer,
}) {
  const titleId = useId()
  const dialogRef = useRef(null)
  const previousFocusRef = useRef(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    previousFocusRef.current = document.activeElement
    const focusDialog = () => {
      const dialog = dialogRef.current
      if (!dialog) return
      const focusable = dialog.querySelectorAll(FOCUSABLE_SELECTOR)
      ;(focusable[0] || dialog).focus()
    }
    const frame = requestAnimationFrame(focusDialog)
    const onKey = (e) => {
      if (e.key === 'Escape') {
        onCloseRef.current?.()
        return
      }
      if (e.key !== 'Tab') return
      const dialog = dialogRef.current
      if (!dialog) return
      const focusable = [...dialog.querySelectorAll(FOCUSABLE_SELECTOR)]
      if (focusable.length === 0) {
        e.preventDefault()
        dialog.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!dialog.contains(document.activeElement)) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
        return
      }
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKey)
      previousFocusRef.current?.focus?.()
    }
  }, [open])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-scrim px-4 py-5 backdrop-blur-sm sm:px-6 sm:py-8"
      onClick={e => e.target === e.currentTarget && onClose?.()}
    >
      <div className="flex min-h-full items-center justify-center">
        <div
          ref={dialogRef}
          className={`ui-modal animate-slideIn flex max-h-[calc(100vh-2.5rem)] w-full flex-col ${
            SIZES[size] || SIZES.md
          } ${panelClassName}`.trim()}
          role="dialog"
          aria-modal="true"
          aria-labelledby={title ? titleId : undefined}
          aria-label={title ? undefined : '对话框'}
          tabIndex={-1}
          onClick={e => e.stopPropagation()}
        >
          {header || title ? (
            <div className="shrink-0 border-b border-subtle px-5 py-4 sm:px-6">
              {header || (
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 id={titleId} className="text-lg font-semibold text-primary">{title}</h3>
                    {description && (
                      <p className="mt-1.5 text-sm leading-6 text-secondary">{description}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={onClose}
                    className="flex h-8 w-8 items-center justify-center rounded-xl border border-default bg-surface-raised text-secondary transition-colors hover:bg-state-hover hover:text-primary"
                    aria-label="关闭"
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              )}
            </div>
          ) : null}
          <div className={`min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6 ${bodyClassName}`.trim()}>
            {children}
          </div>
          {footer && (
            <div className="shrink-0 border-t border-subtle px-5 py-4 sm:px-6">
              {footer}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
