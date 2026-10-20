import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import '@toeverything/theme/style.css'
import {
  cloudDocCrdtBodyDecodes,
  createCloudDocFromCrdt,
  createCloudPageEditor,
  encodeCloudDocCrdt,
  exportCloudDocMarkdown,
  setCloudDocReadonly,
  subscribeCloudDocUpdates,
} from '../lib/cloudBlocksuite'
import { parseBlockSuiteBody } from '../lib/blocksuiteFormat'

function validateBody(value) {
  try {
    parseBlockSuiteBody(value)
    return { body: value, error: '' }
  } catch (error) {
    return { body: null, error: error?.message || 'invalid_blocksuite_crdt_body' }
  }
}

function bodyKey(value) {
  return typeof value === 'string' ? value : JSON.stringify(value || null)
}

function formatError(error) {
  if (!error || typeof error !== 'object') return String(error || 'unknown_error')
  return [error.name, error.message, error.cause?.name, error.cause?.message].filter(Boolean).join(': ') || String(error)
}

const CloudBlockSuiteEditor = forwardRef(function CloudBlockSuiteEditor({
  value,
  title = 'Untitled',
  editable = true,
  onChange,
  className = '',
}, ref) {
  const sourceKey = bodyKey(value)
  const { body, error } = useMemo(() => validateBody(value), [sourceKey])
  const [mountError, setMountError] = useState('')
  const rootRef = useRef(null)
  const docRef = useRef(null)
  const editableRef = useRef(editable)
  const onChangeRef = useRef(onChange)
  const lastEmittedRef = useRef('')
  const changeTimerRef = useRef(null)
  const cleanupRef = useRef(() => {})
  const mountedRef = useRef(false)

  editableRef.current = editable
  onChangeRef.current = onChange

  function cleanup() {
    cleanupRef.current()
    cleanupRef.current = () => {}
  }

  async function flushCurrentDoc() {
    if (!editableRef.current || !docRef.current) return null
    if (changeTimerRef.current) {
      window.clearTimeout(changeTimerRef.current)
      changeTimerRef.current = null
    }
    try {
      const nextValue = encodeCloudDocCrdt(docRef.current)
      // 护栏:编出来的东西必须能解回来。一次坏编码若被写库,会把整篇文档变成
      // 打不开的字节(2026-07-26 有过一次,70KB 的转写稿被覆盖成 2KB 垃圾)。
      // 宁可这次不保存 —— 内存里的文档还在,下一次改动会重新触发。
      if (!cloudDocCrdtBodyDecodes(nextValue)) {
        console.error('refusing to emit an undecodable blocksuite body')
        return null
      }
      const markdown = await exportCloudDocMarkdown(docRef.current)
      if (!mountedRef.current) return null
      lastEmittedRef.current = nextValue
      onChangeRef.current?.(nextValue, { markdown })
      return { value: nextValue, markdown }
    } catch (changeError) {
      console.error('serialize cloud blocksuite document failed', changeError)
      return null
    }
  }

  useImperativeHandle(ref, () => ({
    flush: flushCurrentDoc,
  }), [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      cleanup()
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function mount() {
      if (!body || !rootRef.current) {
        cleanup()
        return
      }
      if (sourceKey === lastEmittedRef.current) return

      setMountError('')
      cleanup()

      const doc = await createCloudDocFromCrdt(body, title)
      if (cancelled || !rootRef.current) {
        doc.dispose?.()
        doc.collection?.dispose?.()
        return
      }

      setCloudDocReadonly(doc, !editableRef.current)
      const editor = createCloudPageEditor(doc)

      const scheduleChange = () => {
        if (changeTimerRef.current) window.clearTimeout(changeTimerRef.current)
        changeTimerRef.current = window.setTimeout(() => {
          if (!cancelled) flushCurrentDoc()
        }, 180)
      }

      const unsubscribe = subscribeCloudDocUpdates(doc, scheduleChange)
      docRef.current = doc
      rootRef.current.replaceChildren(editor)

      cleanupRef.current = () => {
        if (changeTimerRef.current) {
          window.clearTimeout(changeTimerRef.current)
          changeTimerRef.current = null
        }
        unsubscribe()
        editor.remove()
        doc.dispose?.()
        doc.collection?.dispose?.()
        docRef.current = null
      }
    }

    mount().catch(mountFailure => {
      if (!cancelled) {
        cleanup()
        setMountError(formatError(mountFailure))
        console.error('mount cloud blocksuite editor failed', mountFailure)
      }
    })

    return () => {
      cancelled = true
    }
  }, [body, sourceKey, title])

  useEffect(() => {
    if (docRef.current) setCloudDocReadonly(docRef.current, !editable)
  }, [editable])

  if (!body) {
    return (
      <div className={`uniopc-blocksuite-editor ${className}`}>
        <div className="rounded-lg border border-red-400/25 bg-red-500/10 px-5 py-4 text-sm leading-6 text-danger-text">
          当前云文档不是有效的 BlockSuite CRDT 正文，已停止编辑以避免覆盖数据。错误：{error}
        </div>
      </div>
    )
  }

  return (
    <div className={`uniopc-blocksuite-editor is-cloud ${editable ? 'is-editable' : 'is-readonly'} ${className}`}>
      {mountError ? (
        <div className="m-4 rounded-lg border border-red-400/25 bg-red-500/10 px-5 py-4 text-sm leading-6 text-danger-text">
          BlockSuite 编辑器挂载失败：{mountError}
        </div>
      ) : null}
      <div ref={rootRef} className="uniopc-blocksuite-editor__surface" />
    </div>
  )
})

export default CloudBlockSuiteEditor
