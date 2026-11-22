-- Quota mensuel de création de références dans le référentiel partagé parapharma_ref.
-- Idempotent. Ne modifie ni ne backfille les références historiques.
--
-- Règles :
-- - 100 créations / pharmacie / mois calendaire (Europe/Paris)
-- - Seule une insertion réellement réussie consomme une unité
-- - ON CONFLICT DO NOTHING → aucun quota consommé
-- - Attribution (ledger) uniquement pour les créations effectives
-- - Références préexistantes : aucune attribution rétroactive
--
-- Sécurité :
-- - Écritures ref/ledger : rôle propriétaire (DATABASE_URL), via try_create_parapharma_ref
-- - expiry_app : SELECT uniquement (pas d'INSERT/UPDATE ref, pas d'INSERT ledger, pas d'EXECUTE)
-- - Appel saveScan = connexion owner, hors withPharmacy → pas de dépendance à app.pharmacy_id

-- ---------------------------------------------------------------------------
-- Ledger d'attribution (1 GTIN global → 1 pharmacie créatrice)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.parapharma_ref_creations (
  gtin TEXT PRIMARY KEY,
  pharmacy_id UUID NOT NULL REFERENCES public.pharmacies (id) ON DELETE CASCADE,
  user_id UUID REFERENCES public.users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- FK vers parapharma_ref.gtin uniquement si les types sont compatibles (text/varchar).
DO $fk$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'parapharma_ref'
      AND column_name = 'gtin'
      AND data_type IN ('text', 'character varying')
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'parapharma_ref_creations_gtin_fkey'
  ) THEN
    ALTER TABLE public.parapharma_ref_creations
      ADD CONSTRAINT parapharma_ref_creations_gtin_fkey
      FOREIGN KEY (gtin) REFERENCES public.parapharma_ref (gtin) ON DELETE CASCADE;
  END IF;
END;
$fk$;

CREATE INDEX IF NOT EXISTS parapharma_ref_creations_pharmacy_month_idx
  ON public.parapharma_ref_creations (pharmacy_id, created_at);

COMMENT ON TABLE public.parapharma_ref_creations IS
  'Attribution des créations manuelles de parapharma_ref (quota mensuel par pharmacie). Pas de backfill historique.';

COMMENT ON COLUMN public.parapharma_ref_creations.gtin IS
  'GTIN créé ; PRIMARY KEY → une seule pharmacie attributaire par référence globale';

COMMENT ON COLUMN public.parapharma_ref_creations.pharmacy_id IS
  'Pharmacie dont l''insertion a effectivement créé la ligne parapharma_ref';

COMMENT ON COLUMN public.parapharma_ref_creations.user_id IS
  'Utilisateur ayant déclenché la création (nullable si compte supprimé)';

COMMENT ON COLUMN public.parapharma_ref_creations.created_at IS
  'Horodatage UTC de la création (filtrage mois via Europe/Paris côté fonction)';

-- ---------------------------------------------------------------------------
-- Permissions minimales
-- - expiry_app : lecture seule sur ref + ledger (aligné medicaments_ref)
-- - Écritures réservées au propriétaire (import admin + try_create INVOKER owner)
-- ---------------------------------------------------------------------------
REVOKE INSERT, UPDATE ON TABLE public.parapharma_ref FROM expiry_app;
GRANT SELECT ON TABLE public.parapharma_ref TO expiry_app;

GRANT SELECT ON TABLE public.parapharma_ref_creations TO expiry_app;

-- ---------------------------------------------------------------------------
-- Fonction atomique : verrou par pharmacie + insert ref + ledger
-- SECURITY INVOKER + search_path = pg_catalog + tables public.* qualifiées
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.try_create_parapharma_ref(
  p_gtin TEXT,
  p_nom_produit TEXT,
  p_pharmacy_id UUID,
  p_user_id UUID,
  p_monthly_limit INT DEFAULT 100
)
RETURNS TABLE (
  status TEXT,
  created BOOLEAN
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_exists BOOLEAN;
  v_count INT;
  v_inserted_gtin TEXT;
  v_month_start TIMESTAMPTZ;
  v_month_end TIMESTAMPTZ;
  -- Namespace applicatif pour pg_advisory_xact_lock (évite collisions avec d'autres locks).
  c_lock_ns CONSTANT INT := 87201401;
BEGIN
  IF p_gtin IS NULL OR length(trim(p_gtin)) = 0 THEN
    RAISE EXCEPTION 'gtin obligatoire';
  END IF;
  IF p_nom_produit IS NULL OR length(trim(p_nom_produit)) = 0 THEN
    RAISE EXCEPTION 'nom_produit obligatoire';
  END IF;
  IF p_pharmacy_id IS NULL THEN
    RAISE EXCEPTION 'pharmacy_id obligatoire';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id obligatoire';
  END IF;
  IF p_monthly_limit IS NULL OR p_monthly_limit < 1 THEN
    RAISE EXCEPTION 'monthly_limit invalide';
  END IF;

  -- Identité (sans app.pharmacy_id : saveScan appelle en owner hors withPharmacy).
  IF NOT EXISTS (
    SELECT 1 FROM public.pharmacies WHERE id = p_pharmacy_id
  ) THEN
    RAISE EXCEPTION 'pharmacy_id inconnu';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.users
    WHERE id = p_user_id
      AND pharmacy_id = p_pharmacy_id
  ) THEN
    RAISE EXCEPTION 'user_id n''appartient pas à pharmacy_id';
  END IF;

  -- 1) Sérialise les créations d'une même pharmacie (transaction-scoped).
  --    Deux pharmacies différentes ne se bloquent pas entre elles.
  PERFORM pg_advisory_xact_lock(c_lock_ns, hashtext(p_pharmacy_id::text));

  -- 2) GTIN déjà présent (historique ou concurrent) → aucun quota.
  SELECT EXISTS (
    SELECT 1 FROM public.parapharma_ref WHERE gtin = p_gtin
  ) INTO v_exists;

  IF v_exists THEN
    status := 'already_exists';
    created := FALSE;
    RETURN NEXT;
    RETURN;
  END IF;

  -- 3) Bornes du mois calendaire Europe/Paris (stockage created_at en timestamptz UTC).
  v_month_start :=
    (date_trunc('month', timezone('Europe/Paris', now()))
      AT TIME ZONE 'Europe/Paris');
  v_month_end :=
    ((date_trunc('month', timezone('Europe/Paris', now())) + INTERVAL '1 month')
      AT TIME ZONE 'Europe/Paris');

  SELECT COUNT(*)::int INTO v_count
  FROM public.parapharma_ref_creations
  WHERE pharmacy_id = p_pharmacy_id
    AND created_at >= v_month_start
    AND created_at < v_month_end;

  IF v_count >= p_monthly_limit THEN
    status := 'quota_exceeded';
    created := FALSE;
    RETURN NEXT;
    RETURN;
  END IF;

  -- 4) Insertion globale ; conflit concurrent (autre pharmacie) → pas de quota.
  INSERT INTO public.parapharma_ref (gtin, nom_produit)
  VALUES (p_gtin, p_nom_produit)
  ON CONFLICT (gtin) DO NOTHING
  RETURNING gtin INTO v_inserted_gtin;

  IF v_inserted_gtin IS NULL THEN
    status := 'already_exists';
    created := FALSE;
    RETURN NEXT;
    RETURN;
  END IF;

  -- 5) Attribution ledger — même transaction que l'INSERT ref.
  --    Si cet INSERT échoue, toute la fonction rollback (pas de ref orpheline).
  INSERT INTO public.parapharma_ref_creations (gtin, pharmacy_id, user_id, created_at)
  VALUES (v_inserted_gtin, p_pharmacy_id, p_user_id, NOW());

  status := 'created';
  created := TRUE;
  RETURN NEXT;
  RETURN;
END;
$fn$;

COMMENT ON FUNCTION public.try_create_parapharma_ref(TEXT, TEXT, UUID, UUID, INT) IS
  'Crée une entrée parapharma_ref sous quota mensuel (Europe/Paris), attribution ledger atomique. Appel attendu en rôle owner (saveScan / DATABASE_URL).';

-- EXECUTE : propriétaire de la fonction uniquement (rôle DATABASE_URL à la migration).
REVOKE ALL ON FUNCTION public.try_create_parapharma_ref(TEXT, TEXT, UUID, UUID, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.try_create_parapharma_ref(TEXT, TEXT, UUID, UUID, INT) FROM expiry_app;
