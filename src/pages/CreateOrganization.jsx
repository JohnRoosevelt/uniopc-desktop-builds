import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { ensureCloudOrganization } from '../lib/cloudWorkspace'
import { supabase } from '../lib/supabase'
import { ACTION, SURFACE, TEXT } from '../lib/theme'
import AppUpdateTitlebarControl from '../components/AppUpdateTitlebarControl'

function setupErrorMessage(error) {
  const message = String(error?.message || error || '')
  if (message.includes('imai_admin_account_revoked')) {
    return '该账号已被平台停用，请联系 Uniopc 平台管理员。'
  }
  if (message.includes('organization_type_not_found')) {
    return '代理提交的组织类型不可用，请联系 Uniopc 平台管理员调整后再试。'
  }
  if (message.includes('organization_type_required')) {
    return '服务端版本过旧，暂不支持直接创建组织，请联系 Uniopc 平台管理员。'
  }
  return message || '组织初始化失败'
}

export default function CreateOrganization() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [status, setStatus] = useState('running')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!user?.uid) return undefined
    let active = true

    async function initialize() {
      setStatus('running')
      setError('')
      try {
        // No organization type needed: agent-opened owners inherit the
        // approved opening request info, everyone else gets an organization
        // created directly. The name can be changed later in settings.
        await ensureCloudOrganization(supabase, user.uid)
        if (!active) return
        setStatus('done')
        navigate('/profiles/me/conversations', { replace: true })
        window.location.reload()
      } catch (err) {
        if (!active) return
        setStatus('failed')
        setError(setupErrorMessage(err))
      }
    }

    initialize()
    return () => {
      active = false
    }
  }, [navigate, user?.uid])

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-surface-base px-5 py-10">
      <AppUpdateTitlebarControl />
      <div className="w-full max-w-3xl">
        <div>
          <div className="text-xs font-medium uppercase tracking-[0.12em] text-tertiary">Organization Setup</div>
          <h1 className="mt-2 text-2xl font-semibold text-primary">准备组织空间</h1>
          <p className={`mt-2 max-w-2xl text-sm leading-6 ${TEXT.secondary}`}>
            正在为你创建组织空间，完成后会自动进入 Uniopc；组织名称后续可在设置里修改。
          </p>
        </div>

        <section className={`mt-6 ${SURFACE.panel} p-5`}>
          <div className="flex items-start gap-3">
            <div className={`mt-0.5 h-2.5 w-2.5 rounded-full ${status === 'failed' ? 'bg-rose-400' : status === 'done' ? 'bg-emerald-400' : 'bg-violet-300'}`} />
            <div>
              <div className="text-sm font-semibold text-primary">
                {status === 'failed' ? '初始化未完成' : status === 'done' ? '初始化完成' : '正在初始化'}
              </div>
              <div className="mt-2 text-sm leading-6 text-tertiary">
                {status === 'failed'
                  ? error
                  : '正在创建组织、默认 owner 成员和 Uniopc 引擎 profile。'}
              </div>
            </div>
          </div>

          {status === 'failed' && (
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                className={ACTION.primary}
                onClick={() => window.location.reload()}
              >
                重试
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
