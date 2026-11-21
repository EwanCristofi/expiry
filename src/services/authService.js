import { apiFetch, setStoredToken } from './api.js'

/**
 * @param {string} email
 * @param {string} password
 */
export async function login(email, password) {
  const data = await apiFetch('/api/auth/login', {
    method: 'POST',
    json: { email, password },
  })
  if (data?.token) setStoredToken(data.token)
  return data.user
}

/**
 * @param {{ nom: string, email: string, password: string, siret: string }} input
 */
export async function register(input) {
  const data = await apiFetch('/api/auth/register', {
    method: 'POST',
    json: {
      nom: input.nom,
      email: input.email,
      password: input.password,
      siret: input.siret,
    },
  })
  if (data?.token) setStoredToken(data.token)
  return data.user
}

export async function logout() {
  try {
    await apiFetch('/api/auth/logout', { method: 'POST' })
  } finally {
    setStoredToken(null)
  }
}

export async function fetchMe() {
  const data = await apiFetch('/api/auth/me')
  return data.user
}

/**
 * @param {string} email
 */
export async function requestPasswordReset(email) {
  return apiFetch('/api/auth/forgot-password', {
    method: 'POST',
    json: { email },
  })
}

/**
 * @param {string} token
 * @param {string} password
 */
export async function resetPassword(token, password) {
  return apiFetch('/api/auth/reset-password', {
    method: 'POST',
    json: { token, password },
  })
}
