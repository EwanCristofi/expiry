/**
 * L’accès SQL direct depuis le navigateur a été retiré pour le multi-tenant.
 * Toute la persistance passe par l’API serveur (`server/`) qui injecte
 * `app.pharmacy_id` et s’appuie sur le Row Level Security Neon.
 *
 * Conservé comme garde-fou pour éviter une réintroduction accidentelle.
 */
throw new Error(
  'src/lib/db.js ne doit plus être importé côté client. Utilisez /api via productService.',
)
