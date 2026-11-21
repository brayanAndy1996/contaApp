-- 0061_reglas_importacion (spec 025, D-2, D-4 a D-7, D-11; CA-3 a CA-7). Tablas del aprendizaje de arranque y origen de las reglas.
-- DDL de drizzle-kit (tablas, columna, FK, CHECK e índices) reescrito para ser REPETIBLE: IF NOT EXISTS, DROP ... IF EXISTS antes de
-- cada ADD CONSTRAINT, CREATE OR REPLACE, y luego RLS, dueño y grants. Patrón de 0047-0049 y 0059.
--   regla_importacion  una por pedido de importación: cliente, periodos (char(6)[], 1..12), último periodo, trabajo, solicitante,
--                      estado en_curso | completada | fallida, resumen y motivo (los de trabajo de 008). Única parcial (tenant,
--                      cliente) WHERE en_curso: una sola en curso por cliente. FK (tenant, cliente) -> cliente.
--   regla_candidata    una por proveedor e importación (única (tenant, importacion, doc_tipo, doc_numero)): conteos enteros
--                      (n_total = suma), destino propuesto que cumple el umbral de U-2 (>= 2 y 5n >= 4t), estado pendiente |
--                      activada | descartada | reemplazada, destino elegido, regla y resolución (solo fuera de pendiente). Razón
--                      social nula o 1..200 sin controles ni marcas bidi (D-11). FK (tenant, cliente, importacion) -> importación
--                      (una candidata de otro cliente o estudio es imposible) y (tenant, regla) -> regla_aprendida.
--   Las dos: RLS ENABLE + FORCE y tenant_isolation; backend SELECT de ambas, worker SELECT solo de regla_importacion; ningún rol de
--   la app tiene INSERT, UPDATE ni DELETE: escriben solo las funciones acotadas de 0062. Trigger BEFORE DELETE (SECURITY INVOKER):
--   42501 salvo superusuario (037).
--   regla_aprendida.origen  text NOT NULL DEFAULT 'contador' CHECK (contador | importacion). El INSERT del backend pasa de la tabla a
--                      las columnas de «Recordar» (todas menos origen): solo reglas_candidatas_activar (0062) escribe 'importacion'.
--                      La captura regla.creada suma {origen} a sus datos.
--   estudio_regla_motor_codigo_valido suma R-STD; auditoria_accion_valida suma regla.historial_importado y regla.candidata_descartada.

-- ---- Tablas --------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "regla_importacion" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"cliente_id" uuid NOT NULL,
	"estado" text DEFAULT 'en_curso' NOT NULL,
	"periodos" char(6)[] NOT NULL,
	"periodo_hasta" char(6) NOT NULL,
	"trabajo_id" uuid,
	"solicitada_por" uuid NOT NULL,
	"solicitada_en" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"terminada_en" timestamp with time zone,
	"periodos_leidos" integer,
	"periodos_sin_datos" char(6)[],
	"candidatas" integer,
	"sin_criterio" integer,
	"motivo" text,
	CONSTRAINT "regla_importacion_cliente_id_unique" UNIQUE("tenant_id","cliente_id","id"),
	CONSTRAINT "regla_importacion_estado_valido" CHECK ("regla_importacion"."estado" IN ('en_curso', 'completada', 'fallida')),
	CONSTRAINT "regla_importacion_periodos_cantidad" CHECK (cardinality("regla_importacion"."periodos") BETWEEN 1 AND 12),
	CONSTRAINT "regla_importacion_periodo_hasta_formato" CHECK ("regla_importacion"."periodo_hasta" ~ '^[0-9]{4}(0[1-9]|1[0-2])$'),
	CONSTRAINT "regla_importacion_motivo_valido" CHECK ("regla_importacion"."motivo" IS NULL OR "regla_importacion"."motivo" IN ('sunat_no_responde', 'credencial_invalida', 'datos_invalidos', 'portal_cambio', 'interrumpido', 'acceso_retirado', 'cancelado_usuario', 'error_interno')),
	CONSTRAINT "regla_importacion_resumen_no_negativo" CHECK (coalesce("regla_importacion"."periodos_leidos", 0) >= 0 AND coalesce("regla_importacion"."candidatas", 0) >= 0 AND coalesce("regla_importacion"."sin_criterio", 0) >= 0 AND coalesce(cardinality("regla_importacion"."periodos_sin_datos"), 0) <= 12)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "regla_candidata" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"cliente_id" uuid NOT NULL,
	"importacion_id" uuid NOT NULL,
	"doc_tipo" text NOT NULL,
	"doc_numero" text NOT NULL,
	"razon_social" text,
	"destino_propuesto" text,
	"n_dg" integer DEFAULT 0 NOT NULL,
	"n_dgng" integer DEFAULT 0 NOT NULL,
	"n_dng" integer DEFAULT 0 NOT NULL,
	"n_mixto" integer DEFAULT 0 NOT NULL,
	"n_total" integer NOT NULL,
	"periodos_con_proveedor" integer NOT NULL,
	"estado" text DEFAULT 'pendiente' NOT NULL,
	"destino_elegido" text,
	"regla_id" uuid,
	"resuelta_por" uuid,
	"resuelta_en" timestamp with time zone,
	CONSTRAINT "regla_candidata_documento_unique" UNIQUE("tenant_id","importacion_id","doc_tipo","doc_numero"),
	CONSTRAINT "regla_candidata_estado_valido" CHECK ("regla_candidata"."estado" IN ('pendiente', 'activada', 'descartada', 'reemplazada')),
	CONSTRAINT "regla_candidata_destinos_validos" CHECK (("regla_candidata"."destino_propuesto" IS NULL OR "regla_candidata"."destino_propuesto" IN ('DG', 'DGNG', 'DNG')) AND ("regla_candidata"."destino_elegido" IS NULL OR "regla_candidata"."destino_elegido" IN ('DG', 'DGNG', 'DNG'))),
	CONSTRAINT "regla_candidata_documento_largo" CHECK (char_length("regla_candidata"."doc_tipo") BETWEEN 1 AND 2 AND char_length("regla_candidata"."doc_numero") BETWEEN 1 AND 20),
	CONSTRAINT "regla_candidata_conteos" CHECK ("regla_candidata"."n_dg" >= 0 AND "regla_candidata"."n_dgng" >= 0 AND "regla_candidata"."n_dng" >= 0 AND "regla_candidata"."n_mixto" >= 0 AND "regla_candidata"."n_total" = "regla_candidata"."n_dg" + "regla_candidata"."n_dgng" + "regla_candidata"."n_dng" + "regla_candidata"."n_mixto" AND "regla_candidata"."periodos_con_proveedor" >= 0),
	CONSTRAINT "regla_candidata_umbral" CHECK ("regla_candidata"."destino_propuesto" IS NULL OR (CASE "regla_candidata"."destino_propuesto" WHEN 'DG' THEN "regla_candidata"."n_dg" WHEN 'DGNG' THEN "regla_candidata"."n_dgng" ELSE "regla_candidata"."n_dng" END >= 2 AND 5 * CASE "regla_candidata"."destino_propuesto" WHEN 'DG' THEN "regla_candidata"."n_dg" WHEN 'DGNG' THEN "regla_candidata"."n_dgng" ELSE "regla_candidata"."n_dng" END >= 4 * "regla_candidata"."n_total")),
	CONSTRAINT "regla_candidata_resolucion_coherente" CHECK (CASE WHEN "regla_candidata"."estado" = 'pendiente' THEN "regla_candidata"."regla_id" IS NULL AND "regla_candidata"."resuelta_por" IS NULL AND "regla_candidata"."resuelta_en" IS NULL ELSE "regla_candidata"."resuelta_en" IS NOT NULL AND ("regla_candidata"."regla_id" IS NULL OR "regla_candidata"."estado" = 'activada') END),
	CONSTRAINT "regla_candidata_razon_social_valida" CHECK ("regla_candidata"."razon_social" IS NULL OR (char_length("regla_candidata"."razon_social") BETWEEN 1 AND 200 AND "regla_candidata"."razon_social" !~ '[\u0001-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]'))
);
--> statement-breakpoint
ALTER TABLE "regla_aprendida" ADD COLUMN IF NOT EXISTS "origen" text DEFAULT 'contador' NOT NULL;--> statement-breakpoint
ALTER TABLE "regla_aprendida" DROP CONSTRAINT IF EXISTS "regla_aprendida_origen_valido";--> statement-breakpoint
ALTER TABLE "regla_aprendida" ADD CONSTRAINT "regla_aprendida_origen_valido" CHECK ("regla_aprendida"."origen" IN ('contador', 'importacion'));--> statement-breakpoint
ALTER TABLE "regla_importacion" DROP CONSTRAINT IF EXISTS "regla_importacion_cliente_fk";--> statement-breakpoint
ALTER TABLE "regla_importacion" ADD CONSTRAINT "regla_importacion_cliente_fk" FOREIGN KEY ("tenant_id","cliente_id") REFERENCES "public"."cliente"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regla_importacion" DROP CONSTRAINT IF EXISTS "regla_importacion_solicitada_por_usuario_id_fk";--> statement-breakpoint
ALTER TABLE "regla_importacion" ADD CONSTRAINT "regla_importacion_solicitada_por_usuario_id_fk" FOREIGN KEY ("solicitada_por") REFERENCES "public"."usuario"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regla_importacion" DROP CONSTRAINT IF EXISTS "regla_importacion_tenant_id_tenant_id_fk";--> statement-breakpoint
ALTER TABLE "regla_importacion" ADD CONSTRAINT "regla_importacion_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regla_candidata" DROP CONSTRAINT IF EXISTS "regla_candidata_importacion_fk";--> statement-breakpoint
ALTER TABLE "regla_candidata" ADD CONSTRAINT "regla_candidata_importacion_fk" FOREIGN KEY ("tenant_id","cliente_id","importacion_id") REFERENCES "public"."regla_importacion"("tenant_id","cliente_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regla_candidata" DROP CONSTRAINT IF EXISTS "regla_candidata_regla_fk";--> statement-breakpoint
ALTER TABLE "regla_candidata" ADD CONSTRAINT "regla_candidata_regla_fk" FOREIGN KEY ("tenant_id","regla_id") REFERENCES "public"."regla_aprendida"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regla_candidata" DROP CONSTRAINT IF EXISTS "regla_candidata_resuelta_por_usuario_id_fk";--> statement-breakpoint
ALTER TABLE "regla_candidata" ADD CONSTRAINT "regla_candidata_resuelta_por_usuario_id_fk" FOREIGN KEY ("resuelta_por") REFERENCES "public"."usuario"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regla_candidata" DROP CONSTRAINT IF EXISTS "regla_candidata_tenant_id_tenant_id_fk";--> statement-breakpoint
ALTER TABLE "regla_candidata" ADD CONSTRAINT "regla_candidata_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ---- Índices -----------------------------------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "regla_candidata_cliente_idx" ON "regla_candidata" USING btree ("tenant_id","cliente_id","estado","doc_tipo","doc_numero");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "regla_importacion_en_curso_unique" ON "regla_importacion" USING btree ("tenant_id","cliente_id") WHERE "regla_importacion"."estado" = 'en_curso';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "regla_importacion_cliente_idx" ON "regla_importacion" USING btree ("tenant_id","cliente_id","solicitada_en");--> statement-breakpoint

-- ---- CHECK de códigos del motor y de acciones de auditoría -------------------------------------------------------------
ALTER TABLE "estudio_regla_motor" DROP CONSTRAINT IF EXISTS "estudio_regla_motor_codigo_valido";--> statement-breakpoint
ALTER TABLE "estudio_regla_motor" ADD CONSTRAINT "estudio_regla_motor_codigo_valido" CHECK ("estudio_regla_motor"."codigo" IN ('R-ISC', 'R-MIX', 'R-RED', 'R-NEW', 'R-GP', 'R-HIS', 'R-STD'));--> statement-breakpoint
ALTER TABLE "auditoria" DROP CONSTRAINT IF EXISTS "auditoria_accion_valida";--> statement-breakpoint
ALTER TABLE "auditoria" ADD CONSTRAINT "auditoria_accion_valida" CHECK ("auditoria"."accion" IN ('sesion.ingreso', 'invitacion.creada', 'invitacion.revocada', 'invitacion.modificada', 'miembro.alta', 'miembro.rol_cambiado', 'miembro.desactivado', 'miembro.reactivado', 'miembro.eliminado', 'asignacion.agregada', 'asignacion.quitada', 'asignacion.tipo_cambiado', 'cliente.creado', 'cliente.editado', 'cliente.archivado', 'cliente.reactivado', 'cliente.eliminado', 'credencial.guardada', 'credencial.verificada', 'credencial.invalidada', 'credencial.descifrada', 'propuesta.cargada', 'compra.operacion', 'venta.agregada', 'venta.excluida', 'venta.restaurada', 'venta.salto_justificado', 'xml.subido', 'periodo.estado_cambiado', 'archivo.generado', 'sunat.envio', 'regla.creada', 'regla.editada', 'regla.activada', 'regla.desactivada', 'regla.eliminada', 'estudio.regla_motor', 'estudio.aporte_catalogo', 'compra.historial', 'buzon.captura_solicitada', 'buzon.apertura_solicitada', 'buzon.contenido_visto', 'buzon.adjunto_descargado', 'buzon.contenido_obtenido', 'buzon.atendido', 'buzon.atencion_deshecha', 'regla.historial_importado', 'regla.candidata_descartada'));--> statement-breakpoint

-- ---- RLS, dueño y grants -------------------------------------------------------------------------------------------------
ALTER TABLE public.regla_importacion OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.regla_importacion ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.regla_importacion FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.regla_importacion;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.regla_importacion FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
REVOKE ALL ON public.regla_importacion
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT SELECT ON public.regla_importacion TO contapp_backend, contapp_worker;--> statement-breakpoint

ALTER TABLE public.regla_candidata OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.regla_candidata ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.regla_candidata FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.regla_candidata;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.regla_candidata FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
REVOKE ALL ON public.regla_candidata
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT SELECT ON public.regla_candidata TO contapp_backend;--> statement-breakpoint

-- regla_aprendida: el INSERT del backend pasa a ser por columnas, todas menos `origen` (0047 lo daba sobre la tabla entera).
REVOKE INSERT ON public.regla_aprendida FROM contapp_backend;--> statement-breakpoint
REVOKE INSERT (origen), UPDATE (origen) ON public.regla_aprendida
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT INSERT (id, tenant_id, cliente_id, doc_tipo, doc_numero, destino, activa, version, periodo_aprendido, creada_por, creada_en,
  actualizada_por, actualizada_en, eliminada_en, eliminada_por) ON public.regla_aprendida TO contapp_backend;--> statement-breakpoint

-- ---- Sin borrado (vale también para el dueño; solo un superusuario borra: mantenimiento y 037) ---------------------------
-- SECURITY INVOKER: current_user es quien borra.
CREATE OR REPLACE FUNCTION public.regla_importacion_sin_borrado() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND r.rolsuper) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'aprendizaje: las importaciones y candidatas no se borran';
END
$$;--> statement-breakpoint
ALTER FUNCTION public.regla_importacion_sin_borrado() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.regla_importacion_sin_borrado() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS regla_importacion_sin_borrado ON public.regla_importacion;--> statement-breakpoint
CREATE TRIGGER regla_importacion_sin_borrado BEFORE DELETE ON public.regla_importacion
  FOR EACH ROW EXECUTE FUNCTION public.regla_importacion_sin_borrado();--> statement-breakpoint
DROP TRIGGER IF EXISTS regla_candidata_sin_borrado ON public.regla_candidata;--> statement-breakpoint
CREATE TRIGGER regla_candidata_sin_borrado BEFORE DELETE ON public.regla_candidata
  FOR EACH ROW EXECUTE FUNCTION public.regla_importacion_sin_borrado();--> statement-breakpoint

-- ---- regla.creada con el origen (0047 + origen; el resto igual) -----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auditoria_capturar_regla() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.auditoria_registrar(NEW.tenant_id, 'regla.creada', NEW.cliente_id, 'regla_aprendida', NEW.id,
      jsonb_build_object('destino', NEW.destino, 'activa', NEW.activa, 'origen', NEW.origen));
    RETURN NULL;
  END IF;
  IF OLD.eliminada_en IS NULL AND NEW.eliminada_en IS NOT NULL THEN
    PERFORM public.auditoria_registrar(NEW.tenant_id, 'regla.eliminada', NEW.cliente_id, 'regla_aprendida', NEW.id,
      '{}'::jsonb);
    RETURN NULL;
  END IF;
  IF NEW.destino IS DISTINCT FROM OLD.destino OR NEW.periodo_aprendido IS DISTINCT FROM OLD.periodo_aprendido THEN
    PERFORM public.auditoria_registrar(NEW.tenant_id, 'regla.editada', NEW.cliente_id, 'regla_aprendida', NEW.id,
      jsonb_build_object('destino', jsonb_build_object('anterior', OLD.destino, 'nuevo', NEW.destino)));
  END IF;
  IF NEW.activa IS DISTINCT FROM OLD.activa THEN
    PERFORM public.auditoria_registrar(NEW.tenant_id,
      CASE WHEN NEW.activa THEN 'regla.activada' ELSE 'regla.desactivada' END,
      NEW.cliente_id, 'regla_aprendida', NEW.id, '{}'::jsonb);
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.auditoria_capturar_regla() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.auditoria_capturar_regla() FROM PUBLIC;
