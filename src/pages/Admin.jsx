import { useEffect, useMemo, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useActiveOpenClawProfile } from '../hooks/useActiveOpenClawProfile'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../lib/supabase'
import { profileWorkspacePath } from '../lib/profileWorkspace'
import {
  listCloudOrganizationMembers,
} from '../lib/cloudWorkspace'

function roleLabel(role) {
  if (role === 'owner') return 'Owner'
  if (role === 'admin') return 'Admin'
  return 'Member'
}

function normalizeRuntimeMode(value = '') {
  return 'member_local'
}

function runtimeModeLabel(value = '') {
  return '本机运行'
}

function statusClass(status) {
  if (status === 'active' || status === 'registered') return 'border-emerald-400/20 bg-emerald-400/10 text-success-text'
  if (status === 'suspended') return 'border-amber-400/24 bg-amber-400/12 text-warning-text'
  return 'border-default bg-surface-raised text-secondary'
}

function memberInitial(member) {
  const source = String(member?.displayName || member?.memberEmail || '?').trim()
  return source.slice(0, 1).toUpperCase() || '?'
}

export default function Admin() {
  const { user } = useAuth()
  const workspace = useActiveOpenClawProfile()
  const navigate = useNavigate()
  const [members, setMembers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const stats = useMemo(() => {
    const profiles = members.filter(member => member.openclawProfile && member.profileStatus === 'active').length
    const pending = members.filter(member => member.inviteStatus !== 'registered').length
    return { members: members.length, profiles, pending }
  }, [members])
  const organizationName =
    workspace.workspaceProfile?.organizationName
    || members.find(member => member.organizationName)?.organizationName
    || '当前组织'

  useEffect(() => {
    if (!user?.uid || !workspace.isAdmin) {
      setMembers([])
      setLoading(false)
      return
    }
    loadMembers()
  }, [user?.uid, workspace.isAdmin])

  if (!workspace.loading && workspace.workspaceProfile && !workspace.isAdmin) {
    return <Navigate to="/profiles/me/environment" replace />
  }

  async function loadMembers(options = {}) {
    if (!user?.uid) return
    setLoading(true)
    setError('')
    try {
      const rows = await listCloudOrganizationMembers(supabase, user.uid)
      setMembers(rows)
    } catch (err) {
      setError(String(err?.message || err || '读取组织成员失败'))
      setMembers([])
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mx-auto flex h-full max-w-[1180px] flex-col overflow-hidden">
      <div className="flex shrink-0 flex-col gap-4 pb-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-400/12 text-sm font-semibold text-accent-text">
              {organizationName.slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-2xl font-semibold tracking-[-0.02em] text-primary">{organizationName}</h1>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-tertiary">
                <span>{stats.members} 位成员</span>
                <span>{stats.profiles} 个 Profile</span>
                <span>{stats.pending} 个待注册</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div className="mt-4 rounded-xl border border-rose-400/20 bg-rose-500/10 px-4 py-3 text-sm text-danger-text">
          {error}
        </div>
      )}
      {!workspace.workspaceProfile && !workspace.loading && (
        <div className="mt-4 rounded-xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-sm leading-6 text-warning-text">
          {workspace.error || '组织管理 RPC 尚不可用。请先应用组织/profile migration，应用后 owner/admin 才能进入这里管理成员。'}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-subtle bg-surface-raised">
        <div className="flex items-center justify-between gap-3 border-b border-subtle px-4 py-2.5">
          <div className="text-sm font-medium text-secondary">Your teams</div>
          <div className="text-xs text-tertiary">Uniopc 引擎 workspace controls</div>
        </div>
        <div className="h-full overflow-y-auto">
          {loading || workspace.loading ? (
            <div className="flex h-56 items-center justify-center text-sm text-tertiary">正在读取团队成员...</div>
          ) : members.length === 0 ? (
            <div className="flex h-56 items-center justify-center px-6 text-center text-sm text-tertiary">当前组织仅保留 Owner。</div>
          ) : members.map(member => {
            return (
              <div key={member.memberId} className="border-b border-subtle last:border-b-0">
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(profileWorkspacePath({ ...member, isCurrentMember: true }, `team/member/${member.memberId}`))}
                  onKeyDown={event => {
                    if (event.currentTarget !== event.target) return
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      navigate(profileWorkspacePath({ ...member, isCurrentMember: true }, `team/member/${member.memberId}`))
                    }
                  }}
                  className="grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3 transition-colors hover:bg-state-hover"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-400/12 text-xs font-semibold text-accent-text">
                      {memberInitial(member)}
                    </div>
                    <div className="min-w-0">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="truncate text-base font-medium text-primary">{member.displayName}</span>
                        <span className="rounded-md border border-default bg-surface-overlay px-2 py-0.5 text-2xs text-secondary">
                          {roleLabel(member.memberRole)}
                        </span>
                        <span className={`rounded-md border px-2 py-0.5 text-2xs ${statusClass(member.inviteStatus)}`}>
                          {member.statusLabel}
                        </span>
                        <span className="rounded-md border border-default bg-surface-overlay px-2 py-0.5 text-2xs text-secondary">
                          {runtimeModeLabel(member.runtimeMode || member.runtime_mode)}
                        </span>
                      </div>
                      <div className="mt-1 truncate text-xs text-tertiary">{member.memberEmail}</div>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <div className="hidden min-w-[220px] text-right md:block">
                      <div className="truncate font-mono text-xs text-secondary">
                        {member.openclawProfile || '未创建 Uniopc 引擎 Profile'}
                      </div>
                    </div>
                    <span className="flex h-6 w-6 items-center justify-center rounded-md text-tertiary">
                      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="m9 5 7 7-7 7" />
                      </svg>
                    </span>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
