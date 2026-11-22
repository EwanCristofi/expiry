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
  it('10. updateTeamMemberAtomic : bump calculé en SQL (password + désactivation effective)', () => {
    const atomic = teamSrc.match(
      /async function updateTeamMemberAtomic[\s\S]*?^}/m,
    )
    assert.ok(atomic, 'updateTeamMemberAtomic introuvable')
    assert.match(
      atomic[0],
      /session_version = u\.session_version\s*\+\s*CASE WHEN \$\{patch\.hasPasswordChange\}/,
    )
    assert.match(
      atomic[0],
      /hasActiveUpdate[\s\S]*nextActive[\s\S]*u\.is_active = true/,
    )
    assert.doesNotMatch(atomic[0], /sessionBump/)
  })

  it('11. pas de pré-calcul sessionBump côté JS (évite état stale)', () => {
    const updateFn = teamSrc.match(
      /export async function updateTeamMember[\s\S]*?^}/m,
    )
    assert.ok(updateFn, 'updateTeamMember introuvable')
    assert.doesNotMatch(updateFn[0], /sessionBump/)
    assert.doesNotMatch(updateFn[0], /deactivating\s*=/)
  })

  it('12. réactivation / is_active inchangé : branche SQL bump = 0 si déjà inactif ou nextActive true', () => {
    const atomic = teamSrc.match(
      /async function updateTeamMemberAtomic[\s\S]*?^}/m,
    )
    assert.ok(atomic)
    // Désactivation effective uniquement : nextActive=false ET u.is_active=true
    assert.match(
      atomic[0],
      /\$\{nextActive\}::boolean = false\s*\n\s*AND u\.is_active = true/,
    )
  })
})
