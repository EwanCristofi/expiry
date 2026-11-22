import { apiFetch } from './api.js'

export async function listTeamUsers() {
  const data = await apiFetch('/api/team/users')
  return data.users ?? []
}

/**
 * @param {{ email: string, nom: string, role: string, password?: string }} input
 */
export async function createTeamUser(input) {
  return apiFetch('/api/team/users', {
    method: 'POST',
    json: {
      email: input.email,
      nom: input.nom,
      role: input.role,
      password: input.password || undefined,
    },
  })
}

/**
 * @param {string} id
 * @param {{ nom?: string, role?: string, password?: string, is_active?: boolean }} input
 */
export async function updateTeamUser(id, input) {
  const data = await apiFetch(`/api/team/users/${id}`, {
    method: 'PATCH',
    json: input,
  })
  return data.user
}

/**
 * @param {string} id
 * @param {boolean} isActive
 */
export async function setTeamUserActive(id, isActive) {
  return updateTeamUser(id, { is_active: isActive })
}

/**
 * @param {string} id
 */
export async function deleteTeamUser(id) {
  await apiFetch(`/api/team/users/${id}`, { method: 'DELETE' })
}
