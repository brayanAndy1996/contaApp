-- 0019_sesion_consultar (custom, spec 008, D22). El stream de trabajos no cuenta como actividad (004 D3):
-- `auth.sesion_consultar` valida la sesión igual que la `auth.sesion_validar` vigente (0013) y devuelve las mismas
-- columnas, pero sin escrituras: no renueva `ultimo_uso` ni limpia `tenant_activo` (si la membresía del estudio ya no
-- está activa informa `estudio_revocado` y devuelve `tenant_activo` NULL, sin tocar la fila). No redefine
-- `sesion_validar` ni ninguna función de 0008. Repetible: CREATE OR REPLACE, ALTER OWNER y GRANT/REVOKE idempotentes.
CREATE OR REPLACE FUNCTION auth.sesion_consultar(p_token_hash bytea)
  RETURNS TABLE (sesion_id uuid, usuario_id uuid, tenant_activo uuid, estudio_revocado boolean,
                 expira_absoluta timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  s auth.sesion%ROWTYPE;
  v_revocado boolean := false;
BEGIN
  SELECT * INTO s FROM auth.sesion x
   WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours';
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF s.tenant_activo IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.membresia m
     WHERE m.tenant_id = s.tenant_activo AND m.usuario_id = s.usuario_id AND m.desactivada_en IS NULL
  ) THEN
    s.tenant_activo := NULL;
    v_revocado := true;
  END IF;
  RETURN QUERY SELECT s.id, s.usuario_id, s.tenant_activo, v_revocado, s.expira_absoluta;
END
$$;--> statement-breakpoint

-- Dueño contapp_auth; EXECUTE solo para contapp_backend (ni PUBLIC, ni worker, ni platform, ni contapp_app).
ALTER FUNCTION auth.sesion_consultar(bytea) OWNER TO contapp_auth;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth.sesion_consultar(bytea)
  FROM PUBLIC, contapp_worker, contapp_platform, contapp_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth.sesion_consultar(bytea) TO contapp_backend;
