function normalized(value) {
  return String(value || '').trim()
}

function workspaceValue(workspaceProfile = null, camelKey, snakeKey = '') {
  return normalized(workspaceProfile?.[camelKey] || (snakeKey ? workspaceProfile?.[snakeKey] : ''))
}

// 单 Owner 工作台直接从对话开始。插件、AI 员工和自动化都从这里被调用；
// 文档是个人资产，不再要求先创建项目作为容器。
export function hostWorkspaceHomePath(workspaceProfile = null) {
  const role = workspaceValue(workspaceProfile, 'memberRole', 'member_role')
  if (role === 'owner' || role === 'admin' || role === 'member') return '/profiles/me/conversations'
  return '/setup/organization'
}
