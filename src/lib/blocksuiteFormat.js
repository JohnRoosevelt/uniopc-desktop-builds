export const BLOCKSUITE_BODY_FORMAT = 'blocksuite_crdt'
export const INVALID_BLOCKSUITE_BODY_ERROR = 'invalid_blocksuite_crdt_body'

function decodeBase64(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(INVALID_BLOCKSUITE_BODY_ERROR)
  }

  try {
    const binary = atob(value.trim())
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    if (!bytes.length) {
      throw new Error(INVALID_BLOCKSUITE_BODY_ERROR)
    }
    const firstNonWhitespace = bytes.find(byte => ![9, 10, 13, 32].includes(byte))
    if (firstNonWhitespace === 123 || firstNonWhitespace === 91) {
      throw new Error(INVALID_BLOCKSUITE_BODY_ERROR)
    }
    return bytes
  } catch {
    throw new Error(INVALID_BLOCKSUITE_BODY_ERROR)
  }
}

export function stringifyBlockSuiteCrdtBody(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new Error(INVALID_BLOCKSUITE_BODY_ERROR)
  }

  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

export function isBlockSuiteCrdtBody(value) {
  try {
    decodeBase64(value)
    return true
  } catch {
    return false
  }
}

export function parseBlockSuiteBody(value) {
  return {
    kind: 'crdt',
    bytes: decodeBase64(value),
  }
}
