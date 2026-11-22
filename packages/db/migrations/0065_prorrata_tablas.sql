-- 0065_prorrata_tablas (spec 026, D-3, D-4, D-6; R-5, R-8; CA-1, CA-3, CA-4, CA-6, CA-8). Tablas de la prorrata. DDL de drizzle-kit
-- (tablas, FK, CHECK e índices) reescrito para ser REPETIBLE: IF NOT EXISTS, DROP ... IF EXISTS antes de cada ADD CONSTRAINT, CREATE OR
-- REPLACE, y luego RLS, dueño, grants y el trigger de solo inserción. Patrón de 0061.
--   prorrata_obtencion     una por llamada del worker (también la repetida, con nuevas 0): periodo_hasta, trabajo, periodos leídos
--                          (<= 12) y sin declaración, nuevas >= 0. Única (tenant, cliente, id) para la FK compuesta de las declaraciones.
--   declaracion_mensual    una por presentación del PDT 621 (original y rectificatorias); única (tenant, cliente, periodo,
--                          numero_orden > 0, NUMERIC(15,0)); montos NUMERIC(14,2) NOT NULL; prorrata_usada NUMERIC(5,2) NULL o 0..100.
--                          FK (tenant, cliente, obtencion) -> obtención: una presentación de otro cliente o estudio es imposible.
--   prorrata_mes_manual    versiones del mes ingresado a mano: única (tenant, cliente, periodo, version >= 1); accion guardado (tres
--                          montos NOT NULL) | eliminado (tres NULL); motivo 1..500 sin controles ni bidi; autor -> usuario.
--   prorrata_usada_manual  versiones de la prorrata usada ingresada: única (tenant, cliente, periodo, version >= 1); porcentaje NULL o
--                          0..100; autor -> usuario.
--   Las cuatro: FK (tenant, cliente) -> cliente, RLS ENABLE + FORCE y tenant_isolation; el backend solo SELECT; el worker nada; ningún
--   rol de la app tiene INSERT, UPDATE ni DELETE: escriben solo las funciones acotadas de 0066. Solo inserción: trigger BEFORE UPDATE
--   OR DELETE (SECURITY INVOKER) que da 42501 a todos salvo al superusuario (mantenimiento y 037), también al dueño.
--   auditoria_accion_valida suma prorrata.declaraciones_obtenidas, prorrata.mes_manual_guardado, prorrata.mes_manual_eliminado y
--   prorrata.usada_guardada.

-- ---- Tablas --------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "declaracion_mensual" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"cliente_id" uuid NOT NULL,
	"periodo" char(6) NOT NULL,
	"numero_orden" numeric(15, 0) NOT NULL,
	"fecha_presentacion" date NOT NULL,
	"tipo" text NOT NULL,
	"ventas_gravadas_base" numeric(14, 2) NOT NULL,
	"ventas_gravadas_igv" numeric(14, 2) NOT NULL,
	"exportaciones" numeric(14, 2) NOT NULL,
	"no_gravadas" numeric(14, 2) NOT NULL,
	"igv_adq_dg" numeric(14, 2) NOT NULL,
	"igv_adq_dgng" numeric(14, 2) NOT NULL,
	"prorrata_usada" numeric(5, 2),
	"obtencion_id" uuid NOT NULL,
	CONSTRAINT "declaracion_mensual_orden_unique" UNIQUE("tenant_id","cliente_id","periodo","numero_orden"),
	CONSTRAINT "declaracion_mensual_periodo_formato" CHECK ("declaracion_mensual"."periodo" ~ '^[0-9]{4}(0[1-9]|1[0-2])$'),
	CONSTRAINT "declaracion_mensual_numero_orden_positivo" CHECK ("declaracion_mensual"."numero_orden" > 0),
	CONSTRAINT "declaracion_mensual_tipo_valido" CHECK ("declaracion_mensual"."tipo" IN ('original', 'rectificatoria')),
	CONSTRAINT "declaracion_mensual_prorrata_usada_rango" CHECK ("declaracion_mensual"."prorrata_usada" IS NULL OR "declaracion_mensual"."prorrata_usada" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "prorrata_mes_manual" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"cliente_id" uuid NOT NULL,
	"periodo" char(6) NOT NULL,
	"version" integer NOT NULL,
	"accion" text NOT NULL,
	"gravadas" numeric(14, 2),
	"exportaciones" numeric(14, 2),
	"no_gravadas" numeric(14, 2),
	"motivo" text NOT NULL,
	"autor" uuid NOT NULL,
	"creado_en" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "prorrata_mes_manual_version_unique" UNIQUE("tenant_id","cliente_id","periodo","version"),
	CONSTRAINT "prorrata_mes_manual_periodo_formato" CHECK ("prorrata_mes_manual"."periodo" ~ '^[0-9]{4}(0[1-9]|1[0-2])$'),
	CONSTRAINT "prorrata_mes_manual_version_positiva" CHECK ("prorrata_mes_manual"."version" >= 1),
	CONSTRAINT "prorrata_mes_manual_accion_valida" CHECK ("prorrata_mes_manual"."accion" IN ('guardado', 'eliminado')),
	CONSTRAINT "prorrata_mes_manual_montos_coherentes" CHECK (CASE WHEN "prorrata_mes_manual"."accion" = 'guardado' THEN "prorrata_mes_manual"."gravadas" IS NOT NULL AND "prorrata_mes_manual"."exportaciones" IS NOT NULL AND "prorrata_mes_manual"."no_gravadas" IS NOT NULL ELSE "prorrata_mes_manual"."gravadas" IS NULL AND "prorrata_mes_manual"."exportaciones" IS NULL AND "prorrata_mes_manual"."no_gravadas" IS NULL END),
	CONSTRAINT "prorrata_mes_manual_motivo_valido" CHECK (char_length("prorrata_mes_manual"."motivo") BETWEEN 1 AND 500 AND "prorrata_mes_manual"."motivo" !~ '[\u0001-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "prorrata_obtencion" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"cliente_id" uuid NOT NULL,
	"periodo_hasta" char(6) NOT NULL,
	"trabajo_id" uuid,
	"periodos_leidos" char(6)[] NOT NULL,
	"periodos_sin_declaracion" char(6)[] DEFAULT '{}'::char(6)[] NOT NULL,
	"nuevas" integer DEFAULT 0 NOT NULL,
	"obtenida_en" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "prorrata_obtencion_cliente_id_unique" UNIQUE("tenant_id","cliente_id","id"),
	CONSTRAINT "prorrata_obtencion_periodo_hasta_formato" CHECK ("prorrata_obtencion"."periodo_hasta" ~ '^[0-9]{4}(0[1-9]|1[0-2])$'),
	CONSTRAINT "prorrata_obtencion_periodos_cantidad" CHECK (cardinality("prorrata_obtencion"."periodos_leidos") <= 12 AND cardinality("prorrata_obtencion"."periodos_sin_declaracion") <= 12),
	CONSTRAINT "prorrata_obtencion_nuevas_no_negativa" CHECK ("prorrata_obtencion"."nuevas" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "prorrata_usada_manual" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"cliente_id" uuid NOT NULL,
	"periodo" char(6) NOT NULL,
	"version" integer NOT NULL,
	"porcentaje" numeric(5, 2),
	"autor" uuid NOT NULL,
	"creado_en" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "prorrata_usada_manual_version_unique" UNIQUE("tenant_id","cliente_id","periodo","version"),
	CONSTRAINT "prorrata_usada_manual_periodo_formato" CHECK ("prorrata_usada_manual"."periodo" ~ '^[0-9]{4}(0[1-9]|1[0-2])$'),
	CONSTRAINT "prorrata_usada_manual_version_positiva" CHECK ("prorrata_usada_manual"."version" >= 1),
	CONSTRAINT "prorrata_usada_manual_porcentaje_rango" CHECK ("prorrata_usada_manual"."porcentaje" IS NULL OR "prorrata_usada_manual"."porcentaje" BETWEEN 0 AND 100)
);
--> statement-breakpoint

-- ---- FK ------------------------------------------------------------------------------------------------------------------
ALTER TABLE "declaracion_mensual" DROP CONSTRAINT IF EXISTS "declaracion_mensual_tenant_id_tenant_id_fk";--> statement-breakpoint
ALTER TABLE "declaracion_mensual" ADD CONSTRAINT "declaracion_mensual_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "declaracion_mensual" DROP CONSTRAINT IF EXISTS "declaracion_mensual_cliente_fk";--> statement-breakpoint
ALTER TABLE "declaracion_mensual" ADD CONSTRAINT "declaracion_mensual_cliente_fk" FOREIGN KEY ("tenant_id","cliente_id") REFERENCES "public"."cliente"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "declaracion_mensual" DROP CONSTRAINT IF EXISTS "declaracion_mensual_obtencion_fk";--> statement-breakpoint
ALTER TABLE "declaracion_mensual" ADD CONSTRAINT "declaracion_mensual_obtencion_fk" FOREIGN KEY ("tenant_id","cliente_id","obtencion_id") REFERENCES "public"."prorrata_obtencion"("tenant_id","cliente_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prorrata_mes_manual" DROP CONSTRAINT IF EXISTS "prorrata_mes_manual_tenant_id_tenant_id_fk";--> statement-breakpoint
ALTER TABLE "prorrata_mes_manual" ADD CONSTRAINT "prorrata_mes_manual_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prorrata_mes_manual" DROP CONSTRAINT IF EXISTS "prorrata_mes_manual_autor_usuario_id_fk";--> statement-breakpoint
ALTER TABLE "prorrata_mes_manual" ADD CONSTRAINT "prorrata_mes_manual_autor_usuario_id_fk" FOREIGN KEY ("autor") REFERENCES "public"."usuario"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prorrata_mes_manual" DROP CONSTRAINT IF EXISTS "prorrata_mes_manual_cliente_fk";--> statement-breakpoint
ALTER TABLE "prorrata_mes_manual" ADD CONSTRAINT "prorrata_mes_manual_cliente_fk" FOREIGN KEY ("tenant_id","cliente_id") REFERENCES "public"."cliente"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prorrata_obtencion" DROP CONSTRAINT IF EXISTS "prorrata_obtencion_tenant_id_tenant_id_fk";--> statement-breakpoint
ALTER TABLE "prorrata_obtencion" ADD CONSTRAINT "prorrata_obtencion_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prorrata_obtencion" DROP CONSTRAINT IF EXISTS "prorrata_obtencion_cliente_fk";--> statement-breakpoint
ALTER TABLE "prorrata_obtencion" ADD CONSTRAINT "prorrata_obtencion_cliente_fk" FOREIGN KEY ("tenant_id","cliente_id") REFERENCES "public"."cliente"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prorrata_usada_manual" DROP CONSTRAINT IF EXISTS "prorrata_usada_manual_tenant_id_tenant_id_fk";--> statement-breakpoint
ALTER TABLE "prorrata_usada_manual" ADD CONSTRAINT "prorrata_usada_manual_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prorrata_usada_manual" DROP CONSTRAINT IF EXISTS "prorrata_usada_manual_autor_usuario_id_fk";--> statement-breakpoint
ALTER TABLE "prorrata_usada_manual" ADD CONSTRAINT "prorrata_usada_manual_autor_usuario_id_fk" FOREIGN KEY ("autor") REFERENCES "public"."usuario"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prorrata_usada_manual" DROP CONSTRAINT IF EXISTS "prorrata_usada_manual_cliente_fk";--> statement-breakpoint
ALTER TABLE "prorrata_usada_manual" ADD CONSTRAINT "prorrata_usada_manual_cliente_fk" FOREIGN KEY ("tenant_id","cliente_id") REFERENCES "public"."cliente"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ---- Índices (las únicas cubren (tenant, cliente, periodo)) --------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "declaracion_mensual_obtencion_idx" ON "declaracion_mensual" USING btree ("tenant_id","cliente_id","obtencion_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prorrata_obtencion_cliente_idx" ON "prorrata_obtencion" USING btree ("tenant_id","cliente_id","periodo_hasta","obtenida_en");--> statement-breakpoint

-- ---- CHECK de acciones de auditoría ----------------------------------------------------------------------------------------
ALTER TABLE "auditoria" DROP CONSTRAINT IF EXISTS "auditoria_accion_valida";--> statement-breakpoint
ALTER TABLE "auditoria" ADD CONSTRAINT "auditoria_accion_valida" CHECK ("auditoria"."accion" IN ('sesion.ingreso', 'invitacion.creada', 'invitacion.revocada', 'invitacion.modificada', 'miembro.alta', 'miembro.rol_cambiado', 'miembro.desactivado', 'miembro.reactivado', 'miembro.eliminado', 'asignacion.agregada', 'asignacion.quitada', 'asignacion.tipo_cambiado', 'cliente.creado', 'cliente.editado', 'cliente.archivado', 'cliente.reactivado', 'cliente.eliminado', 'credencial.guardada', 'credencial.verificada', 'credencial.invalidada', 'credencial.descifrada', 'propuesta.cargada', 'compra.operacion', 'venta.agregada', 'venta.excluida', 'venta.restaurada', 'venta.salto_justificado', 'xml.subido', 'periodo.estado_cambiado', 'archivo.generado', 'sunat.envio', 'regla.creada', 'regla.editada', 'regla.activada', 'regla.desactivada', 'regla.eliminada', 'estudio.regla_motor', 'estudio.aporte_catalogo', 'compra.historial', 'buzon.captura_solicitada', 'buzon.apertura_solicitada', 'buzon.contenido_visto', 'buzon.adjunto_descargado', 'buzon.contenido_obtenido', 'buzon.atendido', 'buzon.atencion_deshecha', 'regla.historial_importado', 'regla.candidata_descartada', 'prorrata.declaraciones_obtenidas', 'prorrata.mes_manual_guardado', 'prorrata.mes_manual_eliminado', 'prorrata.usada_guardada'));--> statement-breakpoint

-- ---- RLS, dueño y grants (backend SELECT; worker y el resto nada) ---------------------------------------------------------
ALTER TABLE public.prorrata_obtencion OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.prorrata_obtencion ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.prorrata_obtencion FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.prorrata_obtencion;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.prorrata_obtencion FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
REVOKE ALL ON public.prorrata_obtencion
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT SELECT ON public.prorrata_obtencion TO contapp_backend;--> statement-breakpoint

ALTER TABLE public.declaracion_mensual OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.declaracion_mensual ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.declaracion_mensual FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.declaracion_mensual;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.declaracion_mensual FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
REVOKE ALL ON public.declaracion_mensual
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT SELECT ON public.declaracion_mensual TO contapp_backend;--> statement-breakpoint

ALTER TABLE public.prorrata_mes_manual OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.prorrata_mes_manual ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.prorrata_mes_manual FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.prorrata_mes_manual;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.prorrata_mes_manual FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
REVOKE ALL ON public.prorrata_mes_manual
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT SELECT ON public.prorrata_mes_manual TO contapp_backend;--> statement-breakpoint

ALTER TABLE public.prorrata_usada_manual OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.prorrata_usada_manual ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.prorrata_usada_manual FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.prorrata_usada_manual;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.prorrata_usada_manual FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
REVOKE ALL ON public.prorrata_usada_manual
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT SELECT ON public.prorrata_usada_manual TO contapp_backend;--> statement-breakpoint

-- ---- Solo inserción (vale también para el dueño; solo un superusuario actualiza o borra: mantenimiento y 037) ------------------
-- SECURITY INVOKER: current_user es quien escribe.
CREATE OR REPLACE FUNCTION public.prorrata_solo_insercion() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND r.rolsuper) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'prorrata: las filas no se modifican ni se borran';
END
$$;--> statement-breakpoint
ALTER FUNCTION public.prorrata_solo_insercion() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.prorrata_solo_insercion()
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
DROP TRIGGER IF EXISTS prorrata_obtencion_solo_insercion ON public.prorrata_obtencion;--> statement-breakpoint
CREATE TRIGGER prorrata_obtencion_solo_insercion BEFORE UPDATE OR DELETE ON public.prorrata_obtencion
  FOR EACH ROW EXECUTE FUNCTION public.prorrata_solo_insercion();--> statement-breakpoint
DROP TRIGGER IF EXISTS declaracion_mensual_solo_insercion ON public.declaracion_mensual;--> statement-breakpoint
CREATE TRIGGER declaracion_mensual_solo_insercion BEFORE UPDATE OR DELETE ON public.declaracion_mensual
  FOR EACH ROW EXECUTE FUNCTION public.prorrata_solo_insercion();--> statement-breakpoint
DROP TRIGGER IF EXISTS prorrata_mes_manual_solo_insercion ON public.prorrata_mes_manual;--> statement-breakpoint
CREATE TRIGGER prorrata_mes_manual_solo_insercion BEFORE UPDATE OR DELETE ON public.prorrata_mes_manual
  FOR EACH ROW EXECUTE FUNCTION public.prorrata_solo_insercion();--> statement-breakpoint
DROP TRIGGER IF EXISTS prorrata_usada_manual_solo_insercion ON public.prorrata_usada_manual;--> statement-breakpoint
CREATE TRIGGER prorrata_usada_manual_solo_insercion BEFORE UPDATE OR DELETE ON public.prorrata_usada_manual
  FOR EACH ROW EXECUTE FUNCTION public.prorrata_solo_insercion();
