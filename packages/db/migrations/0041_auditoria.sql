-- 0041_auditoria (spec 017, D-1, D-2, D-6, D-13). Registro de auditoria de solo agregado.
--   auditoria  RLS ENABLE + FORCE con UNA politica FOR SELECT por app.tenant_id; GRANT SELECT solo a contapp_backend. Ningun rol de
--              la app tiene INSERT, UPDATE, DELETE ni TRUNCATE. Triggers BEFORE UPDATE OR DELETE (fila y sentencia) y BEFORE
--              TRUNCATE -> 42501 para todos, tambien el dueño y el superusuario; solo `session_replication_role = replica` los salta.
--   contapp_registrador  rol interno NOLOGIN, NOINHERIT, BYPASSRLS y sin miembros (precedente: contapp_enumerador de 0018). Con
--              FORCE y sin politica de escritura, ni el dueño (contapp_migrator, sin BYPASSRLS) puede insertar: el INSERT pasa por
--              interno.auditoria_insertar, de dueño contapp_registrador, que solo ejecuta contapp_migrator (dueño de las capturas).
--              Sus unicos privilegios de tabla son sobre las tablas nuevas de 017 (auditoria, notificacion, plan_aviso).
--   interno    esquema de las funciones auxiliares de 017 (dueño contapp_migrator; USAGE solo a contapp_registrador).
--   auditoria_registrar  SECURITY DEFINER de contapp_migrator; EXECUTE solo para contapp_auth (y su dueño). Calcula el actor del
--              contexto, nunca de un parametro de la app: (1) rol contapp_worker con app.trabajo_id -> `trabajo` con creado_por del
--              trabajo leido por id y estudio (inexistente o ajeno: 42501 y la accion se revierte); (2) app.user_id -> `usuario`;
--              (3) p_usuario_fila (solo auth: sesion, alta por invitacion o registro) -> `usuario`; (4) `sistema`.
--   auditoria_descifrado_listar  SECURITY DEFINER de contapp_migrator; EXECUTE solo contapp_backend. Lee auditoria_descifrado (003,
--              sin cambios) del app.tenant_id actual; fechas truncadas a milisegundos (el cursor viaja como Date).
-- Funciones con search_path fijo y sin EXECUTE para PUBLIC. Lo que sigue a la tabla es repetible sentencia a sentencia.
CREATE TABLE "auditoria" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"ocurrida_en" timestamp with time zone DEFAULT date_trunc('milliseconds', clock_timestamp()) NOT NULL,
	"actor_tipo" text NOT NULL,
	"usuario_id" uuid,
	"trabajo_id" uuid,
	"accion" text NOT NULL,
	"cliente_id" uuid,
	"entidad" text NOT NULL,
	"entidad_id" uuid,
	"datos" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "auditoria_actor_coherente" CHECK (("auditoria"."actor_tipo" = 'usuario' AND "auditoria"."usuario_id" IS NOT NULL AND "auditoria"."trabajo_id" IS NULL) OR ("auditoria"."actor_tipo" = 'trabajo' AND "auditoria"."trabajo_id" IS NOT NULL) OR ("auditoria"."actor_tipo" = 'sistema' AND "auditoria"."usuario_id" IS NULL AND "auditoria"."trabajo_id" IS NULL)),
	CONSTRAINT "auditoria_accion_valida" CHECK ("auditoria"."accion" IN ('sesion.ingreso', 'invitacion.creada', 'invitacion.revocada', 'miembro.alta', 'miembro.rol_cambiado', 'miembro.desactivado', 'miembro.reactivado', 'asignacion.agregada', 'asignacion.quitada', 'cliente.creado', 'cliente.editado', 'cliente.archivado', 'cliente.reactivado', 'credencial.guardada', 'credencial.verificada', 'credencial.invalidada', 'credencial.descifrada', 'propuesta.cargada', 'compra.operacion', 'venta.agregada', 'venta.excluida', 'venta.restaurada', 'venta.salto_justificado', 'xml.subido', 'periodo.estado_cambiado', 'archivo.generado', 'sunat.envio')),
	CONSTRAINT "auditoria_entidad_formato" CHECK ("auditoria"."entidad" ~ '^[a-z][a-z_]{0,62}$'),
	CONSTRAINT "auditoria_datos_objeto" CHECK (jsonb_typeof("auditoria"."datos") = 'object' AND pg_column_size("auditoria"."datos") <= 4096)
);
--> statement-breakpoint
ALTER TABLE "auditoria" ADD CONSTRAINT "auditoria_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auditoria_fecha_idx" ON "auditoria" USING btree ("tenant_id","ocurrida_en" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "auditoria_cliente_idx" ON "auditoria" USING btree ("tenant_id","cliente_id","ocurrida_en" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint

-- ---- Rol interno con BYPASSRLS (solo dentro de las funciones de interno.* y de las de 0043) ------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'contapp_registrador') THEN
    CREATE ROLE contapp_registrador NOLOGIN BYPASSRLS NOINHERIT;
  END IF;
END
$$;--> statement-breakpoint
ALTER ROLE contapp_registrador NOLOGIN NOSUPERUSER BYPASSRLS NOINHERIT NOCREATEROLE NOCREATEDB NOREPLICATION;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO contapp_registrador;--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS interno;--> statement-breakpoint
ALTER SCHEMA interno OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON SCHEMA interno FROM PUBLIC;--> statement-breakpoint
GRANT USAGE ON SCHEMA interno TO contapp_registrador;--> statement-breakpoint

-- ---- RLS, dueño y grants -------------------------------------------------------------------------------------------------
ALTER TABLE public.auditoria OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.auditoria ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.auditoria FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS auditoria_lectura ON public.auditoria;--> statement-breakpoint
CREATE POLICY auditoria_lectura ON public.auditoria FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
REVOKE ALL ON public.auditoria
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT SELECT ON public.auditoria TO contapp_backend;--> statement-breakpoint
GRANT INSERT ON public.auditoria TO contapp_registrador;--> statement-breakpoint

-- ---- Inmutable para todos -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auditoria_inmutable() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'auditoria: un registro no se cambia ni se borra';
END
$$;--> statement-breakpoint
ALTER FUNCTION public.auditoria_inmutable() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.auditoria_inmutable() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS auditoria_inmutable ON public.auditoria;--> statement-breakpoint
CREATE TRIGGER auditoria_inmutable BEFORE UPDATE OR DELETE ON public.auditoria
  FOR EACH ROW EXECUTE FUNCTION public.auditoria_inmutable();--> statement-breakpoint
-- Por sentencia: rechaza aunque la RLS deje 0 filas visibles (el dueño no tiene politica de escritura) y cubre TRUNCATE.
DROP TRIGGER IF EXISTS auditoria_inmutable_sentencia ON public.auditoria;--> statement-breakpoint
CREATE TRIGGER auditoria_inmutable_sentencia BEFORE UPDATE OR DELETE OR TRUNCATE ON public.auditoria
  FOR EACH STATEMENT EXECUTE FUNCTION public.auditoria_inmutable();--> statement-breakpoint

-- ---- INSERT de bajo nivel (dueño contapp_registrador) -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION interno.auditoria_insertar(
  p_tenant uuid, p_actor text, p_usuario uuid, p_trabajo uuid, p_accion text, p_cliente uuid, p_entidad text,
  p_entidad_id uuid, p_datos jsonb
) RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  INSERT INTO public.auditoria (tenant_id, actor_tipo, usuario_id, trabajo_id, accion, cliente_id, entidad, entidad_id, datos)
  VALUES (p_tenant, p_actor, p_usuario, p_trabajo, p_accion, p_cliente, p_entidad, p_entidad_id, coalesce(p_datos, '{}'::jsonb))
$$;--> statement-breakpoint
ALTER FUNCTION interno.auditoria_insertar(uuid, text, uuid, uuid, text, uuid, text, uuid, jsonb) OWNER TO contapp_registrador;--> statement-breakpoint
REVOKE ALL ON FUNCTION interno.auditoria_insertar(uuid, text, uuid, uuid, text, uuid, text, uuid, jsonb) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION interno.auditoria_insertar(uuid, text, uuid, uuid, text, uuid, text, uuid, jsonb) TO contapp_migrator;--> statement-breakpoint

-- ---- auditoria_registrar ----------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auditoria_registrar(
  p_tenant uuid, p_accion text, p_cliente uuid, p_entidad text, p_entidad_id uuid, p_datos jsonb, p_usuario_fila uuid DEFAULT NULL
) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_ctx text := nullif(current_setting('app.tenant_id', true), '');
  v_trabajo_ctx text := nullif(current_setting('app.trabajo_id', true), '');
  v_usuario_ctx text := nullif(current_setting('app.user_id', true), '');
  v_actor text;
  v_usuario uuid;
  v_trabajo uuid;
BEGIN
  IF p_tenant IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'auditoria: sin estudio';
  END IF;
  IF v_ctx IS NOT NULL AND v_ctx::uuid IS DISTINCT FROM p_tenant THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'auditoria: el estudio no coincide con el contexto';
  END IF;
  IF current_setting('role', true) = 'contapp_worker' AND v_trabajo_ctx IS NOT NULL THEN
    v_trabajo := v_trabajo_ctx::uuid;
    SELECT j.creado_por INTO v_usuario FROM public.job_registro j WHERE j.id = v_trabajo AND j.tenant_id = p_tenant;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'auditoria: trabajo desconocido';
    END IF;
    v_actor := 'trabajo';
  ELSIF v_usuario_ctx IS NOT NULL THEN
    v_actor := 'usuario';
    v_usuario := v_usuario_ctx::uuid;
  ELSIF p_usuario_fila IS NOT NULL THEN
    v_actor := 'usuario';
    v_usuario := p_usuario_fila;
  ELSE
    v_actor := 'sistema';
  END IF;
  PERFORM interno.auditoria_insertar(p_tenant, v_actor, v_usuario, v_trabajo, p_accion, p_cliente, p_entidad, p_entidad_id, p_datos);
END
$$;--> statement-breakpoint
ALTER FUNCTION public.auditoria_registrar(uuid, text, uuid, text, uuid, jsonb, uuid) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.auditoria_registrar(uuid, text, uuid, text, uuid, jsonb, uuid)
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.auditoria_registrar(uuid, text, uuid, text, uuid, jsonb, uuid) TO contapp_auth;--> statement-breakpoint

-- ---- Descifrados de 003 para la consulta (sin SELECT sobre auditoria_descifrado) ------------------------------------------
CREATE OR REPLACE FUNCTION public.auditoria_descifrado_listar(p_antes timestamptz, p_antes_id uuid, p_limite integer)
  RETURNS TABLE (id uuid, cliente_id uuid, tipo text, motivo text, resultado text, created_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT d.id, d.cliente_id, d.tipo, d.motivo, d.resultado, date_trunc('milliseconds', d.created_at)
    FROM public.auditoria_descifrado d
   WHERE d.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
     AND (p_antes IS NULL
          OR date_trunc('milliseconds', d.created_at) < p_antes
          OR (date_trunc('milliseconds', d.created_at) = p_antes AND p_antes_id IS NOT NULL AND d.id < p_antes_id))
   ORDER BY date_trunc('milliseconds', d.created_at) DESC, d.id DESC
   LIMIT least(greatest(coalesce(p_limite, 50), 0), 50)
$$;--> statement-breakpoint
ALTER FUNCTION public.auditoria_descifrado_listar(timestamptz, uuid, integer) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.auditoria_descifrado_listar(timestamptz, uuid, integer)
  FROM PUBLIC, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.auditoria_descifrado_listar(timestamptz, uuid, integer) TO contapp_backend;
