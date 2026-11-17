-- 0049_regla_confirmacion (spec 021, D-3, D-8, P-1, P-4, P-9, P-10, CA-6, CA-7). Aceptaciones y confirmaciones para el catalogo,
-- y el CHECK de acciones de auditoria con las 8 de 021.
--   regla_aceptacion    una por regla_aplicacion (PK): la fila «Segun historial» seguia en el destino de la regla al pasar el
--                       periodo a `revisado`. Solo insercion; ningun rol de la app escribe y contapp_backend la lee (contador
--                       «aceptada», P-4). Congeladas: reabrir y volver a revisar solo suma las que falten (ON CONFLICT DO NOTHING).
--   regla_confirmacion  solo insercion y sin lectura para ningun rol de la app (D-3, CA-6): INSERT solo a contapp_backend
--                       (`recordar`, en la transaccion de recordarRegla); `aceptada` la inserta el trigger de revisado. Solo RUC 20
--                       (doc_tipo 6) con el aporte del estudio encendido (P-10). Sin usuario, montos ni razon social. Lleva
--                       regla_id: la lectura de 033 excluye las de reglas eliminadas sin borrar filas (P-9).
--   Las dos con RLS ENABLE + FORCE y tenant_isolation; se revoca todo a cada rol de la app antes de conceder (el worker no recibe
--   nada aunque los privilegios por defecto de un despliegue le dieran SELECT).
--   regla_aceptar_periodo  trigger AFTER UPDATE OF estado de compra_periodo, solo al pasar a `revisado`. SECURITY DEFINER de
--                       contapp_migrator (sin BYPASSRLS): fija app.tenant_id al estudio de la fila mientras escribe y lo devuelve.
--                       Por cada regla_aplicacion del cliente y periodo cuya compra viva tiene en la version vigente los BI e IGV
--                       de los otros dos destinos en 0, inserta la aceptacion y, si es nueva, la confirmacion `aceptada`.
-- Repetible salvo las tablas y el cambio de CHECK generado por drizzle: CREATE OR REPLACE, DROP ... IF EXISTS, GRANT/REVOKE.
CREATE TABLE "regla_aceptacion" (
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"regla_aplicacion_id" uuid PRIMARY KEY NOT NULL,
	"regla_id" uuid NOT NULL,
	"periodo" char(6) NOT NULL,
	"creada_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regla_confirmacion" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"regla_id" uuid NOT NULL,
	"cliente_id" uuid NOT NULL,
	"ruc_proveedor" text NOT NULL,
	"destino" text NOT NULL,
	"origen" text NOT NULL,
	"creada_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "regla_confirmacion_origen_valido" CHECK ("regla_confirmacion"."origen" IN ('recordar', 'aceptada')),
	CONSTRAINT "regla_confirmacion_destino_valido" CHECK ("regla_confirmacion"."destino" IN ('DG', 'DGNG', 'DNG')),
	CONSTRAINT "regla_confirmacion_ruc_20" CHECK ("regla_confirmacion"."ruc_proveedor" ~ '^20[0-9]{9}$')
);
--> statement-breakpoint
ALTER TABLE "auditoria" DROP CONSTRAINT "auditoria_accion_valida";--> statement-breakpoint
ALTER TABLE "regla_aceptacion" ADD CONSTRAINT "regla_aceptacion_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regla_aceptacion" ADD CONSTRAINT "regla_aceptacion_aplicacion_fk" FOREIGN KEY ("tenant_id","regla_aplicacion_id") REFERENCES "public"."regla_aplicacion"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regla_aceptacion" ADD CONSTRAINT "regla_aceptacion_regla_fk" FOREIGN KEY ("tenant_id","regla_id") REFERENCES "public"."regla_aprendida"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regla_confirmacion" ADD CONSTRAINT "regla_confirmacion_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regla_confirmacion" ADD CONSTRAINT "regla_confirmacion_regla_fk" FOREIGN KEY ("tenant_id","regla_id") REFERENCES "public"."regla_aprendida"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regla_confirmacion" ADD CONSTRAINT "regla_confirmacion_cliente_fk" FOREIGN KEY ("tenant_id","cliente_id") REFERENCES "public"."cliente"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "regla_aceptacion_regla_idx" ON "regla_aceptacion" USING btree ("tenant_id","regla_id");--> statement-breakpoint
CREATE INDEX "regla_confirmacion_regla_idx" ON "regla_confirmacion" USING btree ("tenant_id","regla_id");--> statement-breakpoint
ALTER TABLE "auditoria" ADD CONSTRAINT "auditoria_accion_valida" CHECK ("auditoria"."accion" IN ('sesion.ingreso', 'invitacion.creada', 'invitacion.revocada', 'invitacion.modificada', 'miembro.alta', 'miembro.rol_cambiado', 'miembro.desactivado', 'miembro.reactivado', 'miembro.eliminado', 'asignacion.agregada', 'asignacion.quitada', 'asignacion.tipo_cambiado', 'cliente.creado', 'cliente.editado', 'cliente.archivado', 'cliente.reactivado', 'cliente.eliminado', 'credencial.guardada', 'credencial.verificada', 'credencial.invalidada', 'credencial.descifrada', 'propuesta.cargada', 'compra.operacion', 'venta.agregada', 'venta.excluida', 'venta.restaurada', 'venta.salto_justificado', 'xml.subido', 'periodo.estado_cambiado', 'archivo.generado', 'sunat.envio', 'regla.creada', 'regla.editada', 'regla.activada', 'regla.desactivada', 'regla.eliminada', 'estudio.regla_motor', 'estudio.aporte_catalogo', 'compra.historial'));
--> statement-breakpoint

-- ---- RLS, dueño y grants -------------------------------------------------------------------------------------------------
ALTER TABLE public.regla_aceptacion OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.regla_aceptacion ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.regla_aceptacion FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.regla_aceptacion;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.regla_aceptacion FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
REVOKE ALL ON public.regla_aceptacion
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT SELECT ON public.regla_aceptacion TO contapp_backend;--> statement-breakpoint

ALTER TABLE public.regla_confirmacion OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.regla_confirmacion ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.regla_confirmacion FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.regla_confirmacion;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.regla_confirmacion FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
REVOKE ALL ON public.regla_confirmacion
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT INSERT ON public.regla_confirmacion TO contapp_backend;--> statement-breakpoint

-- ---- Aceptaciones y confirmaciones al pasar a revisado (P-1, P-4, P-10) -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.regla_aceptar_periodo() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_previo text := current_setting('app.tenant_id', true);
  v_aportar boolean;
BEGIN
  PERFORM set_config('app.tenant_id', NEW.tenant_id::text, true);
  SELECT coalesce((SELECT k.aportar_catalogo FROM public.estudio_reglas_config k WHERE k.tenant_id = NEW.tenant_id), true)
    INTO v_aportar;
  WITH candidatas AS (
    SELECT a.id, a.regla_id, a.periodo
      FROM public.regla_aplicacion a
      JOIN public.compra c ON c.tenant_id = a.tenant_id AND c.id = a.compra_id
      JOIN public.compra_version v ON v.tenant_id = c.tenant_id AND v.compra_id = c.id AND v.n = c.version_vigente
      JOIN public.regla_aprendida r ON r.tenant_id = a.tenant_id AND r.id = a.regla_id
     WHERE a.tenant_id = NEW.tenant_id AND c.cliente_id = NEW.cliente_id AND c.periodo = NEW.periodo
       AND c.descartada_en IS NULL
       AND CASE r.destino
             WHEN 'DG' THEN v.bi_dgng = 0 AND v.igv_dgng = 0 AND v.bi_dng = 0 AND v.igv_dng = 0
             WHEN 'DGNG' THEN v.bi_dg = 0 AND v.igv_dg = 0 AND v.bi_dng = 0 AND v.igv_dng = 0
             WHEN 'DNG' THEN v.bi_dg = 0 AND v.igv_dg = 0 AND v.bi_dgng = 0 AND v.igv_dgng = 0
             ELSE false
           END
  ), nuevas AS (
    INSERT INTO public.regla_aceptacion (tenant_id, regla_aplicacion_id, regla_id, periodo)
    SELECT NEW.tenant_id, x.id, x.regla_id, x.periodo FROM candidatas x ORDER BY x.id
    ON CONFLICT (regla_aplicacion_id) DO NOTHING
    RETURNING regla_aceptacion.regla_aplicacion_id, regla_aceptacion.regla_id
  )
  INSERT INTO public.regla_confirmacion (tenant_id, regla_id, cliente_id, ruc_proveedor, destino, origen)
  SELECT NEW.tenant_id, r.id, r.cliente_id, r.doc_numero, r.destino, 'aceptada'
    FROM nuevas n JOIN public.regla_aprendida r ON r.tenant_id = NEW.tenant_id AND r.id = n.regla_id
   WHERE v_aportar AND r.doc_tipo = '6' AND r.doc_numero ~ '^20[0-9]{9}$'
   ORDER BY n.regla_aplicacion_id;
  PERFORM set_config('app.tenant_id', coalesce(v_previo, ''), true);
  RETURN NULL;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.regla_aceptar_periodo() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.regla_aceptar_periodo() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS regla_aceptar_periodo ON public.compra_periodo;--> statement-breakpoint
CREATE TRIGGER regla_aceptar_periodo AFTER UPDATE OF estado ON public.compra_periodo
  FOR EACH ROW WHEN (NEW.estado = 'revisado' AND OLD.estado IS DISTINCT FROM 'revisado')
  EXECUTE FUNCTION public.regla_aceptar_periodo();
