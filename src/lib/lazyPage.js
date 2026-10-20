import { createElement, lazy, Suspense } from 'react'

// Declare once at module scope. Loading starts only when the route is rendered,
// and the fallback stays inside the page so existing workspace chrome survives.
export function lazyPage(loader) {
  const Page = lazy(loader)
  return function DeferredPage(props) {
    return createElement(Suspense, {
      fallback: createElement('div', { role: 'status', className: 'p-6 text-sm text-gray-400' }, '正在加载页面…'),
    }, createElement(Page, props))
  }
}
