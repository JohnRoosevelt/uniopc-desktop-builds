function normalizeText(value) {
  return String(value ?? '').trim()
}

// Single backend predicate: registration_gate_allows(p_email, p_phone) -> boolean.
// When the platform registration gate is OFF it returns true for everyone; when
// ON it returns true only for platform staff, opened/approved owners, and
// invited members.
export const REGISTRATION_GATE_RPC = 'registration_gate_allows'

export function registrationGateRpcName() {
  return REGISTRATION_GATE_RPC
}

export function registrationGateRpcNames() {
  return [REGISTRATION_GATE_RPC]
}

export function registrationDeniedMessage() {
  return '该账号尚未开通注册权限，请联系您的服务商开通后再试。'
}

export function registrationIdentityInvalidMessage() {
  return '请输入有效手机号。'
}

// Client-side pre-check for a friendlier message. The database trigger
// (handle_new_user) is the real, un-bypassable gate. New accounts are
// phone-only; if this RPC check fails, the database trigger still decides.
export async function assertPhoneRegistrationAllowed(client, phone) {
  const normalizedPhone = normalizeText(phone)

  if (!normalizedPhone) {
    const err = new Error(registrationIdentityInvalidMessage())
    err.code = 'registration_identity_invalid'
    throw err
  }

  let allowed = true
  try {
    const { data, error } = await client.rpc(REGISTRATION_GATE_RPC, {
      p_email: null,
      p_phone: normalizedPhone || null,
    })
    if (!error && data === false) {
      allowed = false
    }
  } catch {
    allowed = true // fail open — the trigger is the real gate
  }

  if (!allowed) {
    const err = new Error(registrationDeniedMessage())
    err.code = 'registration_gate_closed'
    throw err
  }

  return true
}
