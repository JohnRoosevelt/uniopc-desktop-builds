export function skillStatus(skill = {}) {
  if (skill.disabled) {
    return {
      key: 'disabled',
      label: '已禁用',
      tone: 'muted',
      className: 'border-stone-500/20 bg-stone-500/10 text-tertiary',
    }
  }
  if (!skill.eligible) {
    return {
      key: 'missing',
      label: '缺依赖',
      tone: 'warning',
      className: 'border-amber-400/25 bg-amber-400/10 text-amber-500',
    }
  }
  return {
    key: 'available',
    label: '可用',
    tone: 'success',
    className: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-500',
  }
}

export function sourceLabel(skill = {}) {
  if (skill.bundled) return '内置'
  return skill.source || '扩展'
}

export function isSkillAssignable(skill = {}) {
  return Boolean(skill.name) && !skill.disabled && skill.eligible
}

export function normalizeSkillList(skills = []) {
  const out = []
  for (const skill of Array.isArray(skills) ? skills : []) {
    const name = String(skill || '').trim()
    if (name && !out.includes(name)) out.push(name)
  }
  return out
}

export function getAgentSkillNames(agent = {}) {
  return normalizeSkillList(agent.skills)
}

export function buildSkillAssignmentIndex(agents = []) {
  const index = new Map()
  for (const agent of Array.isArray(agents) ? agents : []) {
    for (const skillName of getAgentSkillNames(agent)) {
      if (!index.has(skillName)) index.set(skillName, [])
      index.get(skillName).push(agent)
    }
  }
  return index
}

export function skillAssignedAgents(skillName, agents = []) {
  const target = String(skillName || '').trim()
  if (!target) return []
  return (Array.isArray(agents) ? agents : []).filter(agent => getAgentSkillNames(agent).includes(target))
}

export function setSkillPresence(skills = [], skillName, enabled) {
  const normalized = normalizeSkillList(skills)
  const target = String(skillName || '').trim()
  if (!target) return normalized
  const exists = normalized.includes(target)
  if (enabled && !exists) return [...normalized, target]
  if (!enabled && exists) return normalized.filter(item => item !== target)
  return normalized
}

export function knownSkillMap(skills = []) {
  const map = new Map()
  for (const skill of Array.isArray(skills) ? skills : []) {
    if (skill?.name) map.set(skill.name, skill)
  }
  return map
}

export function describeSkillAssignment(skillName, agents = []) {
  const assignedAgents = skillAssignedAgents(skillName, agents)
  const total = Array.isArray(agents) ? agents.length : 0
  const assigned = assignedAgents.length
  const allAssigned = total > 0 && assigned === total
  if (allAssigned) return { assigned, total, label: '全部员工', allAssigned }
  if (assigned > 0) return { assigned, total, label: `${assigned} 位员工`, allAssigned }
  return { assigned, total, label: '未分配', allAssigned }
}
