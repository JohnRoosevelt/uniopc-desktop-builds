// Failure attribution for the App Center install pipeline
// (uniopc-supabase/docs/plugin-system-v2.md §3): map a failed step's raw error
// to a human conclusion + suggested action, rendered inline under the failed
// step with a retry button. Rules are ordered — specific matches first, the
// generic network bucket near the end, unknown falls through to a default.
const ATTRIBUTION_RULES = [
  {
    match: /plugin_not_entitled|没有该插件权限/i,
    title: '当前组织没有该插件的使用权限',
    detail: '安装授权在云端被拒绝，组织未开通该插件。',
    action: '请联系管理员在管理后台为组织开通该插件后重试。',
  },
  {
    match: /sha256|checksum|校验不一致|校验失败/i,
    title: '安装包完整性校验失败',
    detail: '下载的制品与云端登记的 sha256 不一致，可能是下载不完整或制品已被替换。',
    action: '请重试下载；若持续失败，请联系管理员重新发布该插件制品。',
  },
  {
    match: /登录状态已过期|invalid_authorization|not_authenticated/i,
    title: '登录状态已过期',
    detail: '云端拒绝了当前会话的授权请求。',
    action: '请重新登录后再重试安装。',
  },
  {
    match: /host[ _]?credential/i,
    title: '官方云凭证异常',
    detail: '插件的 Cloud Agent Host Credential 已失效或与云端不一致。',
    action: '在插件详情中点击「重新授权」重签凭证后重试。',
  },
  {
    match: /ENOSPC|no space|磁盘空间/i,
    title: '本机磁盘空间不足',
    detail: '下载或解压插件时磁盘空间不够。',
    action: '清理磁盘空间后重试。',
  },
  {
    match: /超时|timeout|timed out/i,
    title: '操作超时',
    detail: '下载或引擎写入超过时限，可能是网络缓慢或引擎正忙。',
    action: '稍等片刻后重试；若引擎尚未就绪，请先等待引擎启动完成。',
  },
  {
    match: /failed to fetch|fetcherror|network|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|网络|502|504/i,
    title: '网络无法完成安装',
    detail: '与云端或下载源的连接失败。国内网络开启 VPN 时可能因绕道导致云端下载失败。',
    action: '检查网络（必要时关闭 VPN 使用国内直连）后重试。',
  },
  {
    match: /plugins install|plugin not found|manifest/i,
    title: '引擎安装命令失败',
    detail: '官方 CLI 安装返回错误，可能是引擎未就绪或插件包结构异常。',
    action: '确认引擎运行正常后重试；持续失败可尝试重启引擎。',
  },
]

export function attributeInstallFailure(stepLabel, error) {
  const text = String(error?.message || error || '').trim()
  const rule = ATTRIBUTION_RULES.find(item => item.match.test(text))
  if (rule) {
    return { stepLabel, title: rule.title, detail: rule.detail, action: rule.action }
  }
  return {
    stepLabel,
    title: '安装未完成',
    detail: text || '未知错误。',
    action: '请重试；持续失败请联系管理员并附上此错误信息。',
  }
}
