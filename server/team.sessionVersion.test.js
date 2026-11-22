/**
 * Contrats session_version pour updateTeamMember (sans Neon).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const teamSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'team.js'),
  'utf8',
)

describe('updateTeamMember — session_version (contrat source)', () => {
  it('10. branche password : même UPDATE incrémente session_version', () => {
    assert.match(
      teamSrc,
      /password_hash\s*=\s*\$\{passwordHash\},[\s\S]*?session_version\s*=\s*session_version\s*\+\s*1/,
    )
  })

  it('11. branche sans password : pas d’incrément session_version', () => {
    const noPasswordUpdate = teamSrc.match(
      /UPDATE users\s+SET nom = \$\{nextNom\}, role = \$\{nextRole\}[\s\S]*?RETURNING id, email, nom, role, created_at/,
    )
    assert.ok(noPasswordUpdate, 'UPDATE sans password introuvable')
    assert.doesNotMatch(noPasswordUpdate[0], /session_version/)
  })
})
