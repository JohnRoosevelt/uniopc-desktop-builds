import { useEffect, useState } from 'react'
import { avatarHueStyle, avatarInitial, deliberateEmoji } from '../lib/avatarIdentity'

const SIZES = {
  xs: 'h-5 w-5 text-2xs',
  sm: 'h-6 w-6 text-2xs',
  md: 'h-8 w-8 text-sm',
  lg: 'h-10 w-10 text-base',
}

const EMOJI_SIZES = {
  xs: 'text-2xs',
  sm: 'text-sm',
  md: 'text-lg',
  lg: 'text-xl',
}

// 形状即类别：人圆、AI 方（Slack/Teams/Discord 同款惯例，bot 方、人圆）。
// 用形状区分比用颜色更快被辨认，也不占额外视觉位。
// 这是产品级规则 —— 形状由 kind 决定，调用点不要再手传 rounded-*。
const SHAPE_BY_KIND = {
  human: 'rounded-full',
  ai: 'rounded-[9px]',   // 圆角方：够方以区别于人，又不至于生硬
}

/**
 * 全产品唯一的头像出口。优先级：
 *   头像图 → 用户主动设的 emoji → 按名字生成的首字母块
 *
 * kind 决定形状（human 圆 / ai 方），不再由调用点手传 rounded。
 * 注意这不是复活旧的 isAi 分叉 —— 三级渲染优先级对两类完全一致，
 * kind 只影响外框形状这一件事。
 *
 * 改这套之前列表里并存四种画法（AI 一律 🤖、设了 emoji 的用 emoji、
 * 人类一个通用紫渐变块、邮箱账号用邮箱首字符），9 位员工里 5 个长得一样。
 * emoji 是正式字段（员工表单里可编辑），所以保留；被当默认值写进数据的
 * 占位 🤖 在 lib/avatarIdentity 里视为"没设过"。
 */
export default function EmployeeAvatar({
  name,
  avatarUrl = '',
  emoji = '',
  size = 'md',
  kind = 'human',
  className = '',
}) {
  const [imageFailed, setImageFailed] = useState(false)
  const imageUrl = String(avatarUrl || '').trim()
  const chosenEmoji = deliberateEmoji(emoji)

  useEffect(() => {
    setImageFailed(false)
  }, [imageUrl])

  const shape = SHAPE_BY_KIND[kind] || SHAPE_BY_KIND.human
  const base = `${SIZES[size] || SIZES.md} ${shape} shrink-0 flex items-center justify-center ${className}`

  if (imageUrl && !imageFailed) {
    return (
      <img
        src={imageUrl}
        alt={name || '头像'}
        className={`${base} object-cover`}
        onError={() => setImageFailed(true)}
      />
    )
  }

  if (chosenEmoji) {
    return (
      <div className={`${base} border border-subtle bg-surface-overlay ${EMOJI_SIZES[size] || EMOJI_SIZES.md} leading-none`}>
        {chosenEmoji}
      </div>
    )
  }

  return (
    <div className={`${base} ui-avatar-generated font-semibold leading-none`} style={avatarHueStyle(name)}>
      {avatarInitial(name)}
    </div>
  )
}
