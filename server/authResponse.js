/**
 * Corps JSON des réponses login/register (sans JWT).
 *
 * @param {{
 *   id: string,
 *   email: string,
 *   nom: string,
 *   role: string,
 *   pharmacy_id: string,
 *   pharmacy: unknown,
 * }} user
 * @param {(session: { userId: string, email: string }) => boolean} isPlatformAdmin
 */
export function buildSessionAuthJson(user, isPlatformAdmin) {
  return {
    user: {
      id: user.id,
      email: user.email,
      nom: user.nom,
      role: user.role,
      pharmacy_id: user.pharmacy_id,
      pharmacy: user.pharmacy,
      is_platform_admin: isPlatformAdmin({
        userId: user.id,
        email: user.email,
      }),
    },
  }
}
