export function verifyDesktopPrerequisites({ platform = process.platform, execFileSync } = {}) {
  if (platform !== 'win32') return []
  try {
    execFileSync('where.exe', ['perl'], { stdio: 'ignore' })
    return []
  } catch {
    throw new Error('Rust cold builds require perl.exe for vendored OpenSSL. Install Strawberry Perl and reopen the terminal.')
  }
}
