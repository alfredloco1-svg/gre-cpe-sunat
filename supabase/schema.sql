-- ============================================================
-- GRE + CPE SUNAT Pro — Schema seguro con RLS
-- Ejecutar en: Supabase → SQL Editor → New query → Run
-- ============================================================

-- Extensiones
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------- TABLA EMPRESAS ----------
CREATE TABLE IF NOT EXISTS public.empresas (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ruc           TEXT NOT NULL CHECK (ruc ~ '^\d{11}$'),
  nombre        TEXT NOT NULL DEFAULT '',
  usuario_sol   TEXT NOT NULL DEFAULT '',
  -- Secretos: solo accesibles por el dueño vía RLS. Ideal: rotar y no compartir.
  clave_sol     TEXT NOT NULL DEFAULT '',
  client_id     TEXT NOT NULL DEFAULT '',
  client_secret TEXT NOT NULL DEFAULT '',
  ambiente      TEXT NOT NULL DEFAULT 'PRODUCCION'
                  CHECK (ambiente IN ('PRODUCCION', 'PRUEBA')),
  ruta_descarga TEXT NOT NULL DEFAULT 'C:\GRE\',
  activa        BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, ruc)
);

CREATE INDEX IF NOT EXISTS idx_empresas_user ON public.empresas(user_id);
CREATE INDEX IF NOT EXISTS idx_empresas_activa ON public.empresas(user_id) WHERE activa = true;

-- ---------- TABLA TOKENS ----------
CREATE TABLE IF NOT EXISTS public.tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  empresa_id    UUID NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  access_token  TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (empresa_id)
);

CREATE INDEX IF NOT EXISTS idx_tokens_user ON public.tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_tokens_empresa ON public.tokens(empresa_id);

-- ---------- updated_at automático ----------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_empresas_updated ON public.empresas;
CREATE TRIGGER trg_empresas_updated
  BEFORE UPDATE ON public.empresas
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_tokens_updated ON public.tokens;
CREATE TRIGGER trg_tokens_updated
  BEFORE UPDATE ON public.tokens
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------- Solo una empresa activa por usuario ----------
CREATE OR REPLACE FUNCTION public.ensure_single_activa()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.activa = true THEN
    UPDATE public.empresas
    SET activa = false
    WHERE user_id = NEW.user_id
      AND id <> NEW.id
      AND activa = true;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_single_activa ON public.empresas;
CREATE TRIGGER trg_single_activa
  BEFORE INSERT OR UPDATE OF activa ON public.empresas
  FOR EACH ROW
  WHEN (NEW.activa = true)
  EXECUTE FUNCTION public.ensure_single_activa();

-- ============================================================
-- ROW LEVEL SECURITY (obligatorio)
-- Cada usuario solo ve / edita SUS filas. El rol anon no puede nada.
-- ============================================================

ALTER TABLE public.empresas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tokens ENABLE ROW LEVEL SECURITY;

-- Quitar políticas viejas si existen
DROP POLICY IF EXISTS "empresas_select_own" ON public.empresas;
DROP POLICY IF EXISTS "empresas_insert_own" ON public.empresas;
DROP POLICY IF EXISTS "empresas_update_own" ON public.empresas;
DROP POLICY IF EXISTS "empresas_delete_own" ON public.empresas;

DROP POLICY IF EXISTS "tokens_select_own" ON public.tokens;
DROP POLICY IF EXISTS "tokens_insert_own" ON public.tokens;
DROP POLICY IF EXISTS "tokens_update_own" ON public.tokens;
DROP POLICY IF EXISTS "tokens_delete_own" ON public.tokens;

-- EMPRESAS: solo dueño
CREATE POLICY "empresas_select_own" ON public.empresas
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "empresas_insert_own" ON public.empresas
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "empresas_update_own" ON public.empresas
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "empresas_delete_own" ON public.empresas
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- TOKENS: solo dueño
CREATE POLICY "tokens_select_own" ON public.tokens
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "tokens_insert_own" ON public.tokens
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "tokens_update_own" ON public.tokens
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "tokens_delete_own" ON public.tokens
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- Sin políticas para anon → anon no puede leer ni escribir nada

-- ============================================================
-- RECOMENDACIONES DE AUTH (hacer en el panel, no en SQL)
-- ============================================================
-- 1. Authentication → Providers → Google: activar
-- 2. Authentication → Providers → Email:
--      - Desactivar "Enable sign ups" (solo invitaciones)
-- 3. Authentication → Users → Add user → Send invitation
-- 4. Authentication → URL Configuration:
--      Site URL = tu dominio HTTPS
--      Redirect URLs = solo tus dominios (no * )
-- 5. Project Settings → API: nunca expongas service_role en el frontend
-- ============================================================
