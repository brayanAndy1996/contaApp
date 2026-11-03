-- 0018_trabajos_rls (custom, spec 008). job_registro: dueño, RLS ENABLE + FORCE, tenant_isolation, una política
-- RESTRICTIVE de borrado para el worker (solo estados terminales) y grants por columna. config_sistema: filas por
-- defecto (D12) y solo lectura para la app. credencial.estado: CHECK, grants y trigger (D13). Rol contapp_enumerador y
-- esquema `sistema` (D18). auth.purgar (D16). Repetible: DROP ... IF EXISTS, CREATE OR REPLACE, ON CONFLICT DO NOTHING
-- y GRANT/REVOKE idempotentes. No redefine ninguna función de 0008.

-- ---- job_registro --------------------------------------------------------------------------------------------------
ALTER TABLE public.job_registro OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.job_registro ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.job_registro FORCE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation ON public.job_registro;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.job_registro FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- RESTRICTIVE: se combina con AND con tenant_isolation (una permisiva se combinaría con OR y dejaría borrar vivos).
-- Un DELETE del worker sobre en_cola/ejecutando afecta 0 filas, sin error.
DROP POLICY IF EXISTS job_registro_borrar_terminados ON public.job_registro;--> statement-breakpoint
CREATE POLICY job_registro_borrar_terminados ON public.job_registro AS RESTRICTIVE FOR DELETE TO contapp_worker
  USING (estado IN ('completado', 'error', 'cancelado'));--> statement-breakpoint

REVOKE ALL ON public.job_registro FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app;--> statement-breakpoint
REVOKE ALL (id, tenant_id, cliente_id, ruc, tipo, cola, canal, prioridad, estado, parametros, clave_dedupe, creado_por,
            intentos, max_intentos, motivo, resultado, disponible_desde, creado_en, iniciado_en, terminado_en, actualizado_en)
  ON public.job_registro FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app;--> statement-breakpoint

-- contapp_backend: lee, encola (tenant_id, intentos y fechas por DEFAULT) y solo cancela (D9).
GRANT SELECT ON public.job_registro TO contapp_backend;--> statement-breakpoint
GRANT INSERT (cliente_id, ruc, tipo, cola, canal, prioridad, estado, parametros, clave_dedupe, creado_por, max_intentos)
  ON public.job_registro TO contapp_backend;--> statement-breakpoint
GRANT UPDATE (estado, motivo, terminado_en, actualizado_en) ON public.job_registro TO contapp_backend;--> statement-breakpoint

-- contapp_worker: lee, ejecuta (8 columnas del ejecutor) y purga terminados (política de arriba). Sin INSERT.
GRANT SELECT, DELETE ON public.job_registro TO contapp_worker;--> statement-breakpoint
GRANT UPDATE (estado, intentos, motivo, resultado, disponible_desde, iniciado_en, terminado_en, actualizado_en)
  ON public.job_registro TO contapp_worker;--> statement-breakpoint

-- ---- config_sistema (sin tenant_id: tabla de plataforma, sin RLS) ---------------------------------------------------
ALTER TABLE public.config_sistema OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON public.config_sistema FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app;--> statement-breakpoint
GRANT SELECT ON public.config_sistema TO contapp_backend, contapp_worker;--> statement-breakpoint

-- D12/D19: valores por defecto. No pisa cambios hechos después por contapp_migrator.
INSERT INTO public.config_sistema
  (cola, concurrencia_global, concurrencia_tenant, espera_ruc_ms, reintentos, backoff_base_ms, max_pendientes_tenant)
VALUES
  ('sire', 4, 2, 2000, 3, 5000, 2000),
  ('sol', 2, 1, 2000, 3, 5000, 2000),
  ('xml', 8, 4, 2000, 3, 5000, 2000)
ON CONFLICT (cola) DO NOTHING;--> statement-breakpoint

-- ---- D17: el despachador (worker) revalida el alcance de quien encoló: lectura de asignacion bajo RLS ----------------
GRANT SELECT ON public.asignacion TO contapp_worker;--> statement-breakpoint

-- ---- credencial.estado (D13) ----------------------------------------------------------------------------------------
ALTER TABLE public.credencial DROP CONSTRAINT IF EXISTS credencial_estado_valido;--> statement-breakpoint
ALTER TABLE public.credencial ADD CONSTRAINT credencial_estado_valido
  CHECK (estado IN ('configurada', 'verificada', 'invalida'));--> statement-breakpoint
-- 007 amplía la lista de motivos con una migración nueva.
ALTER TABLE public.credencial DROP CONSTRAINT IF EXISTS credencial_estado_motivo_valido;--> statement-breakpoint
ALTER TABLE public.credencial ADD CONSTRAINT credencial_estado_motivo_valido
  CHECK (estado_motivo IS NULL OR estado_motivo IN ('credencial_invalida'));--> statement-breakpoint

REVOKE ALL (estado, estado_motivo, estado_at) ON public.credencial
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app;--> statement-breakpoint
GRANT SELECT (estado, estado_motivo, estado_at) ON public.credencial TO contapp_backend;--> statement-breakpoint
-- contapp_worker ya tiene SELECT de tabla (0006); aquí solo escribe el estado.
GRANT UPDATE (estado, estado_motivo, estado_at) ON public.credencial TO contapp_worker;--> statement-breakpoint

-- Reemplazar el sobre (UPDATE OF ciphertext, también desde el upsert del backend) desbloquea la credencial. Re-envolver la
-- DEK (dek_envuelta, kek_id) no la toca. SECURITY INVOKER y fuera de `auth`: corre con los permisos de quien actualiza.
CREATE OR REPLACE FUNCTION public.credencial_reinicia_estado() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.estado := 'configurada';
  NEW.estado_motivo := NULL;
  NEW.estado_at := now();
  RETURN NEW;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.credencial_reinicia_estado() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.credencial_reinicia_estado() FROM PUBLIC;--> statement-breakpoint

DROP TRIGGER IF EXISTS credencial_reinicia_estado ON public.credencial;--> statement-breakpoint
CREATE TRIGGER credencial_reinicia_estado BEFORE UPDATE OF ciphertext ON public.credencial
  FOR EACH ROW EXECUTE FUNCTION public.credencial_reinicia_estado();--> statement-breakpoint

-- ---- D18: rol contapp_enumerador y esquema `sistema` ----------------------------------------------------------------
-- NOLOGIN, sin miembros (nadie hace SET ROLE a él): su BYPASSRLS solo se usa dentro de las dos funciones de abajo,
-- que devuelven únicamente UUID. Ningún rol con login gana BYPASSRLS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'contapp_enumerador') THEN
    CREATE ROLE contapp_enumerador NOLOGIN BYPASSRLS NOINHERIT;
  END IF;
END
$$;--> statement-breakpoint
ALTER ROLE contapp_enumerador NOLOGIN NOSUPERUSER BYPASSRLS NOINHERIT NOCREATEROLE NOCREATEDB NOREPLICATION;--> statement-breakpoint

-- Solo las columnas que necesitan las funciones (sin CREATE en public).
GRANT USAGE ON SCHEMA public TO contapp_enumerador;--> statement-breakpoint
REVOKE ALL ON public.tenant FROM contapp_enumerador;--> statement-breakpoint
GRANT SELECT (id) ON public.tenant TO contapp_enumerador;--> statement-breakpoint
GRANT SELECT (tenant_id, estado, actualizado_en) ON public.job_registro TO contapp_enumerador;--> statement-breakpoint

CREATE SCHEMA IF NOT EXISTS sistema;--> statement-breakpoint
ALTER SCHEMA sistema OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON SCHEMA sistema FROM PUBLIC;--> statement-breakpoint
GRANT USAGE ON SCHEMA sistema TO contapp_worker;--> statement-breakpoint

CREATE OR REPLACE FUNCTION sistema.estudios_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT t.id FROM public.tenant t ORDER BY t.id
$$;--> statement-breakpoint

-- Estudios con algún trabajo en `estados` cuyo actualizado_en tiene al menos `antiguedad_seg` segundos (reconciliador).
CREATE OR REPLACE FUNCTION sistema.estudios_con_trabajos(estados text[], antiguedad_seg integer) RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT DISTINCT j.tenant_id FROM public.job_registro j
   WHERE j.estado = ANY (estados)
     AND j.actualizado_en <= now() - make_interval(secs => antiguedad_seg)
   ORDER BY j.tenant_id
$$;--> statement-breakpoint

ALTER FUNCTION sistema.estudios_ids() OWNER TO contapp_enumerador;--> statement-breakpoint
ALTER FUNCTION sistema.estudios_con_trabajos(text[], integer) OWNER TO contapp_enumerador;--> statement-breakpoint
REVOKE ALL ON FUNCTION sistema.estudios_ids() FROM PUBLIC, contapp_backend, contapp_platform, contapp_app;--> statement-breakpoint
REVOKE ALL ON FUNCTION sistema.estudios_con_trabajos(text[], integer)
  FROM PUBLIC, contapp_backend, contapp_platform, contapp_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION sistema.estudios_ids() TO contapp_worker;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION sistema.estudios_con_trabajos(text[], integer) TO contapp_worker;--> statement-breakpoint

-- ---- D16: auth.purgar ------------------------------------------------------------------------------------------------
-- Sin políticas ni grants nuevos para contapp_auth: tiene DELETE desde 0007 y las políticas auth_definer son FOR ALL.
-- Nunca borra una sesión sin revocar y sin vencer, ni un intento_login con bloqueo vigente. Retención < 1 día o NULL:
-- error (22023) sin borrar nada.
CREATE OR REPLACE FUNCTION auth.purgar(
  retencion_sesion interval,
  retencion_token interval,
  retencion_intento interval,
  retencion_limite interval
) RETURNS TABLE (sesiones integer, tokens integer, intentos integer, limites integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_ahora timestamptz := now();
BEGIN
  IF retencion_sesion IS NULL OR retencion_token IS NULL OR retencion_intento IS NULL OR retencion_limite IS NULL
     OR retencion_sesion < interval '1 day' OR retencion_token < interval '1 day'
     OR retencion_intento < interval '1 day' OR retencion_limite < interval '1 day' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'retencion invalida: minimo 1 dia';
  END IF;

  DELETE FROM auth.sesion x
   WHERE (x.revocada_en IS NOT NULL AND x.revocada_en < v_ahora - retencion_sesion)
      OR x.expira_absoluta < v_ahora - retencion_sesion;
  GET DIAGNOSTICS sesiones = ROW_COUNT;

  DELETE FROM auth.token_recuperacion x
   WHERE (x.usado_en IS NOT NULL AND x.usado_en < v_ahora - retencion_token)
      OR (x.invalidado_en IS NOT NULL AND x.invalidado_en < v_ahora - retencion_token)
      OR x.expira_en < v_ahora - retencion_token;
  GET DIAGNOSTICS tokens = ROW_COUNT;

  DELETE FROM auth.intento_login x
   WHERE x.ventana_inicio < v_ahora - retencion_intento
     AND (x.bloqueado_hasta IS NULL OR x.bloqueado_hasta <= v_ahora);
  GET DIAGNOSTICS intentos = ROW_COUNT;

  DELETE FROM auth.limite_tasa x
   WHERE x.ventana_inicio < v_ahora - retencion_limite;
  GET DIAGNOSTICS limites = ROW_COUNT;

  RETURN NEXT;
END
$$;--> statement-breakpoint
ALTER FUNCTION auth.purgar(interval, interval, interval, interval) OWNER TO contapp_auth;--> statement-breakpoint
-- 0008–0013 concedieron EXECUTE sobre todas las funciones de `auth` al backend: aquí se le quita explícitamente.
REVOKE ALL ON FUNCTION auth.purgar(interval, interval, interval, interval)
  FROM PUBLIC, contapp_backend, contapp_platform, contapp_app;--> statement-breakpoint
GRANT USAGE ON SCHEMA auth TO contapp_worker;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth.purgar(interval, interval, interval, interval) TO contapp_worker;
