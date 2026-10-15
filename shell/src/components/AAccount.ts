/** WSOS-DIR-002: accept `user`, `user@domain` or `DOMAIN\user`. Returns an error message or null. */
export function validateAccountName(v: string): string | null {
  const s = v.trim()
  if (!s) return 'Enter a user name.'
  const part = /^[A-Za-z0-9._-]+$/
  if (s.includes('\\')) {
    const [dom, user, ...rest] = s.split('\\')
    return rest.length === 0 && /^[A-Za-z0-9.-]+$/.test(dom) && part.test(user) ? null : 'Use the form DOMAIN\\user.'
  }
  if (s.includes('@')) {
    const [user, dom, ...rest] = s.split('@')
    return rest.length === 0 && part.test(user) && /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(dom) ? null : 'Use the form user@domain.'
  }
  return part.test(s) ? null : 'User names may contain letters, numbers, dots, dashes and underscores.'
}
