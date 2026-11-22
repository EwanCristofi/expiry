/**
 * Admin plateforme Expiry (pas le rôle `admin` d’une officine).
 * Configuré via ADMIN_EMAIL et/ou ADMIN_USER_ID.
 * Compare l’identité issue de la DB (resolveAuthSession / login), pas les claims JWT.
 *
 * @param {{ userId?: string, email?: string } | null | undefined} session
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {boolean}
 */
export function isPlatformAdmin(session, env = process.env) {
  if (!session) return false
  const adminUserId = String(env.ADMIN_USER_ID || '').trim()
  const adminEmail = String(env.ADMIN_EMAIL || '')
    .trim()
    .toLowerCase()
  if (adminUserId && String(session.userId) === adminUserId) return true
  if (
    adminEmail &&
    String(session.email || '')
      .trim()
      .toLowerCase() === adminEmail
  ) {
    return true
  }
  return false
}
