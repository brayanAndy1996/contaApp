-- 0014_invitacion_vigente_estudio (custom, spec 005, T10b). Ratificación (7) tras T10: `auth.invitacion_vigente`
-- devuelve también `tenant_id` (primera columna) para que el backend llame a `CupoUsuarios.alAceptar` con el
-- estudio en `/invitaciones/aceptar`. Cambia el tipo de retorno, así que `CREATE OR REPLACE` no basta:
-- DROP + CREATE con la misma firma de entrada (FUNCIONES_AUTH sigue en 15), mismo cuerpo que 0013, dueño,
-- `search_path` y ACL explícitos. 0013 no se edita; ninguna otra función cambia.
DROP FUNCTION IF EXISTS auth.invitacion_vigente(bytea);--> statement-breakpoint

-- Consulta sin efectos (antes de Argon2): estudio (id y nombre), correo, rol y si el correo ya tiene cuenta.
CREATE FUNCTION auth.invitacion_vigente(p_token_hash bytea)
  RETURNS TABLE (tenant_id uuid, estudio_nombre text, correo text, rol text, cuenta_existe boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT i.tenant_id, t.nombre, i.correo, i.rol,
         EXISTS (SELECT 1 FROM public.usuario u WHERE u.email = i.correo)
    FROM public.invitacion i
    JOIN public.tenant t ON t.id = i.tenant_id
   WHERE i.token_hash = p_token_hash AND i.aceptada_en IS NULL AND i.revocada_en IS NULL
     AND i.vence_en > now();
$$;--> statement-breakpoint

ALTER FUNCTION auth.invitacion_vigente(bytea) OWNER TO contapp_auth;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth.invitacion_vigente(bytea) FROM PUBLIC, contapp_worker, contapp_platform, contapp_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth.invitacion_vigente(bytea) TO contapp_backend;
