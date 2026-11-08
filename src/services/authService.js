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
