-- 0004_ronda2_lo_y_usuario (custom). Correcciones de la ronda adversarial 2 (T11, spec 002).
-- Sentencias repetibles: REVOKE es idempotente y la política se recrea con DROP ... IF EXISTS.

-- H10: los objetos grandes (pg_largeobject) son un almacén persistente fuera de RLS y de CA-3: un LO
-- creado dentro de withTenant(A) se lee desde withTenant(B) (mismo dueño, OID secuencial). Ningún rol
-- de la app los necesita, así que se quita EXECUTE a PUBLIC en las funciones de LO del servidor (la
-- interfaz fast-path de libpq comprueba el mismo permiso). lo_import/lo_export ya vienen restringidas
-- al superusuario. lo_compat_privileges es SUSET: los roles de la app no pueden activarlo.
REVOKE EXECUTE ON FUNCTION
  pg_catalog.lo_creat(integer),
  pg_catalog.lo_create(oid),
  pg_catalog.lo_from_bytea(oid, bytea),
  pg_catalog.lo_open(oid, integer),
  pg_catalog.lo_close(integer),
  pg_catalog.loread(integer, integer),
  pg_catalog.lowrite(integer, bytea),
  pg_catalog.lo_get(oid),
  pg_catalog.lo_get(oid, bigint, integer),
  pg_catalog.lo_put(oid, bigint, bytea),
  pg_catalog.lo_lseek(integer, integer, integer),
  pg_catalog.lo_lseek64(integer, bigint, integer),
  pg_catalog.lo_tell(integer),
  pg_catalog.lo_tell64(integer),
  pg_catalog.lo_truncate(integer, integer),
  pg_catalog.lo_truncate64(integer, bigint),
  pg_catalog.lo_unlink(oid)
FROM PUBLIC;--> statement-breakpoint

-- H13 (D9): dentro de withTenant solo se ven los usuarios con membresía en el estudio actual, aunque
-- app.user_id apunte a alguien que no es miembro; sin tenant (withUsuario, P7) solo la propia fila.
DROP POLICY IF EXISTS tenant_isolation ON public.usuario;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.usuario FOR SELECT
  USING (
    CASE
      WHEN nullif(current_setting('app.tenant_id', true), '') IS NULL
        THEN id = nullif(current_setting('app.user_id', true), '')::uuid
      ELSE EXISTS (
        SELECT 1 FROM public.membresia m
         WHERE m.usuario_id = usuario.id
           AND m.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      )
    END
  );
