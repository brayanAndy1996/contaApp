-- 0059_buzon_atencion (spec 024, D-5, D-12; CA-5, CA-9, CA-10, CA-13). Estado de atención del mensaje, historial de atención,
-- histórico decidido por la BD al insertar e índices de la bandeja. DDL de drizzle-kit (tabla, columnas, FK, CHECK e índices)
-- reescrito para ser REPETIBLE (db:migrate x2 y las pruebas la vuelven a ejecutar sobre la BD migrada): IF NOT EXISTS,
-- DROP ... IF EXISTS antes de cada ADD CONSTRAINT, CREATE OR REPLACE, y luego RLS, dueño y grants.
--   buzon_mensaje   suma historico (NOT NULL DEFAULT false), atendido_en y atendido_por (-> usuario, no a la membresía: quitar a
--                   un miembro no se impide) con CHECK (atendido_en IS NULL) = (atendido_por IS NULL). Ningún rol de la app
--                   recibe UPDATE de esas columnas: solo las cambia buzon_atencion_aplicar (0060).
--   buzon_atencion  historial (atendido | deshecho, comentario nulo o 1..500 sin controles salvo \n ni bidi, usuario, creado_en)
--                   con FK (tenant, cliente, mensaje) -> buzon_mensaje: un evento con el mensaje de otro cliente o estudio es
--                   imposible. RLS ENABLE + FORCE y tenant_isolation; backend solo SELECT; nadie INSERT/UPDATE/DELETE directo.
--   Trigger buzon_atencion_inmutable (SECURITY INVOKER): UPDATE siempre 42501; DELETE 42501 salvo superusuario (037).
--   Trigger buzon_mensaje_atencion_inicial (BEFORE INSERT, SECURITY DEFINER como buzon_mensaje_aviso_obligatorio de 0058): deja
--                   atendido_en/atendido_por en NULL y fija historico = cliente sin sincronizado_en AND fecha <= reloj - 30 días,
--                   sin importar lo que mande quien inserta (también la siembra del superusuario).
--   Reclasificación de lo guardado en 023: historico = fecha <= primera_captura_en - 30 días AND (sincronizado_en IS NULL OR
--                   primera_captura_en <= sincronizado_en) (en los críticos coincide con NOT avisado). Solo pasa filas a true:
--                   repetirla no deshace nada.
--   auditoria_accion_valida suma buzon.atendido y buzon.atencion_deshecha.
--   Índices (CA-9, tenant_id primero por la RLS; DESC = NULLS FIRST como el ORDER BY de la bandeja).

-- ---- Columnas de buzon_mensaje -------------------------------------------------------------------------------------------
ALTER TABLE "buzon_mensaje" ADD COLUMN IF NOT EXISTS "historico" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "buzon_mensaje" ADD COLUMN IF NOT EXISTS "atendido_en" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "buzon_mensaje" ADD COLUMN IF NOT EXISTS "atendido_por" uuid;--> statement-breakpoint
ALTER TABLE "buzon_mensaje" DROP CONSTRAINT IF EXISTS "buzon_mensaje_atendido_por_usuario_id_fk";--> statement-breakpoint
ALTER TABLE "buzon_mensaje" ADD CONSTRAINT "buzon_mensaje_atendido_por_usuario_id_fk" FOREIGN KEY ("atendido_por") REFERENCES "public"."usuario"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buzon_mensaje" DROP CONSTRAINT IF EXISTS "buzon_mensaje_atendido_coherente";--> statement-breakpoint
ALTER TABLE "buzon_mensaje" ADD CONSTRAINT "buzon_mensaje_atendido_coherente" CHECK (("buzon_mensaje"."atendido_en" IS NULL) = ("buzon_mensaje"."atendido_por" IS NULL));--> statement-breakpoint

-- ---- Historial de atención -----------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "buzon_atencion" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"cliente_id" uuid NOT NULL,
	"mensaje_id" uuid NOT NULL,
	"accion" text NOT NULL,
	"comentario" text,
	"usuario_id" uuid NOT NULL,
	"creado_en" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "buzon_atencion" DROP CONSTRAINT IF EXISTS "buzon_atencion_accion_valida";--> statement-breakpoint
ALTER TABLE "buzon_atencion" ADD CONSTRAINT "buzon_atencion_accion_valida" CHECK ("buzon_atencion"."accion" IN ('atendido', 'deshecho'));--> statement-breakpoint
ALTER TABLE "buzon_atencion" DROP CONSTRAINT IF EXISTS "buzon_atencion_comentario_valido";--> statement-breakpoint
ALTER TABLE "buzon_atencion" ADD CONSTRAINT "buzon_atencion_comentario_valido" CHECK ("buzon_atencion"."comentario" IS NULL OR (char_length("buzon_atencion"."comentario") BETWEEN 1 AND 500 AND "buzon_atencion"."comentario" !~ '[\u0001-\u0009\u000B-\u001F\u007F-\u009F‎‏؜‪-‮⁦-⁩]'));--> statement-breakpoint
ALTER TABLE "buzon_atencion" DROP CONSTRAINT IF EXISTS "buzon_atencion_tenant_id_tenant_id_fk";--> statement-breakpoint
ALTER TABLE "buzon_atencion" ADD CONSTRAINT "buzon_atencion_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buzon_atencion" DROP CONSTRAINT IF EXISTS "buzon_atencion_usuario_id_usuario_id_fk";--> statement-breakpoint
ALTER TABLE "buzon_atencion" ADD CONSTRAINT "buzon_atencion_usuario_id_usuario_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuario"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buzon_atencion" DROP CONSTRAINT IF EXISTS "buzon_atencion_mensaje_fk";--> statement-breakpoint
ALTER TABLE "buzon_atencion" ADD CONSTRAINT "buzon_atencion_mensaje_fk" FOREIGN KEY ("tenant_id","cliente_id","mensaje_id") REFERENCES "public"."buzon_mensaje"("tenant_id","cliente_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ---- Índices (CA-9) ------------------------------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "buzon_atencion_mensaje_idx" ON "buzon_atencion" USING btree ("tenant_id","mensaje_id","creado_en","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "buzon_mensaje_bandeja_idx" ON "buzon_mensaje" USING btree ("tenant_id","fecha" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "buzon_mensaje_pendiente_idx" ON "buzon_mensaje" USING btree ("tenant_id","fecha" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE "buzon_mensaje"."atendido_en" IS NULL AND NOT "buzon_mensaje"."historico";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "buzon_mensaje_critico_pendiente_idx" ON "buzon_mensaje" USING btree ("tenant_id","fecha" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE "buzon_mensaje"."critico" AND "buzon_mensaje"."atendido_en" IS NULL AND NOT "buzon_mensaje"."historico";--> statement-breakpoint
-- INCLUDE (critico): el agregado del indicador sale solo del índice (drizzle no lo expresa; el esquema lo declara sin INCLUDE).
CREATE INDEX IF NOT EXISTS "buzon_mensaje_cliente_pendiente_idx" ON "buzon_mensaje" USING btree ("tenant_id","cliente_id","fecha" DESC NULLS FIRST,"id" DESC NULLS FIRST) INCLUDE ("critico") WHERE "buzon_mensaje"."atendido_en" IS NULL AND NOT "buzon_mensaje"."historico";--> statement-breakpoint

-- ---- Acciones de auditoría -----------------------------------------------------------------------------------------------
ALTER TABLE "auditoria" DROP CONSTRAINT IF EXISTS "auditoria_accion_valida";--> statement-breakpoint
ALTER TABLE "auditoria" ADD CONSTRAINT "auditoria_accion_valida" CHECK ("auditoria"."accion" IN ('sesion.ingreso', 'invitacion.creada', 'invitacion.revocada', 'invitacion.modificada', 'miembro.alta', 'miembro.rol_cambiado', 'miembro.desactivado', 'miembro.reactivado', 'miembro.eliminado', 'asignacion.agregada', 'asignacion.quitada', 'asignacion.tipo_cambiado', 'cliente.creado', 'cliente.editado', 'cliente.archivado', 'cliente.reactivado', 'cliente.eliminado', 'credencial.guardada', 'credencial.verificada', 'credencial.invalidada', 'credencial.descifrada', 'propuesta.cargada', 'compra.operacion', 'venta.agregada', 'venta.excluida', 'venta.restaurada', 'venta.salto_justificado', 'xml.subido', 'periodo.estado_cambiado', 'archivo.generado', 'sunat.envio', 'regla.creada', 'regla.editada', 'regla.activada', 'regla.desactivada', 'regla.eliminada', 'estudio.regla_motor', 'estudio.aporte_catalogo', 'compra.historial', 'buzon.captura_solicitada', 'buzon.apertura_solicitada', 'buzon.contenido_visto', 'buzon.adjunto_descargado', 'buzon.contenido_obtenido', 'buzon.atendido', 'buzon.atencion_deshecha'));--> statement-breakpoint

-- ---- RLS, dueño y grants -------------------------------------------------------------------------------------------------
ALTER TABLE public.buzon_atencion OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.buzon_atencion ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.buzon_atencion FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.buzon_atencion;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.buzon_atencion FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
REVOKE ALL ON public.buzon_atencion
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT SELECT ON public.buzon_atencion TO contapp_backend;--> statement-breakpoint
-- El estado de atención no lo cambia nadie de la app directamente (el UPDATE del worker sigue siendo por columnas, 0054).
REVOKE UPDATE (historico, atendido_en, atendido_por) ON public.buzon_mensaje
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint

-- ---- Historial solo inserción --------------------------------------------------------------------------------------------
-- SECURITY INVOKER: current_user es quien escribe. Ni el dueño de la tabla (contapp_migrator) cambia ni borra un evento; solo un
-- superusuario borra (mantenimiento; la purga de 037 tendrá su propia función).
CREATE OR REPLACE FUNCTION public.buzon_atencion_inmutable() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND r.rolsuper) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'buzon_atencion: el historial no cambia';
END
$$;--> statement-breakpoint
ALTER FUNCTION public.buzon_atencion_inmutable() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.buzon_atencion_inmutable() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS buzon_atencion_inmutable ON public.buzon_atencion;--> statement-breakpoint
CREATE TRIGGER buzon_atencion_inmutable BEFORE UPDATE OR DELETE ON public.buzon_atencion
  FOR EACH ROW EXECUTE FUNCTION public.buzon_atencion_inmutable();--> statement-breakpoint

-- ---- Estado inicial de atención e histórico al insertar (D-12, CA-13) ----------------------------------------------------
-- Mismo reloj y misma regla que el aviso (0058): un mensaje de más de 30 días que llega en la primera sincronización del cliente
-- es histórico. Fija app.tenant_id al de la fila para leer el estado (RLS) y lo restaura.
CREATE OR REPLACE FUNCTION public.buzon_mensaje_atencion_inicial() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_previo text;
  v_sincronizado boolean;
BEGIN
  NEW.atendido_en := NULL;
  NEW.atendido_por := NULL;
  IF NEW.fecha IS NULL OR NEW.fecha > clock_timestamp() - interval '30 days' THEN
    NEW.historico := false;
    RETURN NEW;
  END IF;
  v_previo := current_setting('app.tenant_id', true);
  PERFORM set_config('app.tenant_id', NEW.tenant_id::text, true);
  SELECT e.sincronizado_en IS NOT NULL INTO v_sincronizado
    FROM public.buzon_estado_cliente e
   WHERE e.tenant_id = NEW.tenant_id AND e.cliente_id = NEW.cliente_id;
  PERFORM set_config('app.tenant_id', coalesce(v_previo, ''), true);
  NEW.historico := v_sincronizado IS NOT TRUE;
  RETURN NEW;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.buzon_mensaje_atencion_inicial() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.buzon_mensaje_atencion_inicial()
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
DROP TRIGGER IF EXISTS buzon_mensaje_atencion_inicial ON public.buzon_mensaje;--> statement-breakpoint
CREATE TRIGGER buzon_mensaje_atencion_inicial BEFORE INSERT ON public.buzon_mensaje
  FOR EACH ROW EXECUTE FUNCTION public.buzon_mensaje_atencion_inicial();--> statement-breakpoint

-- ---- Reclasificación de lo guardado en 023 -------------------------------------------------------------------------------
UPDATE public.buzon_mensaje m
   SET historico = true
  FROM public.buzon_mensaje x
  LEFT JOIN public.buzon_estado_cliente e ON e.tenant_id = x.tenant_id AND e.cliente_id = x.cliente_id
 WHERE x.id = m.id
   AND NOT m.historico
   AND x.fecha <= x.primera_captura_en - interval '30 days'
   AND (e.sincronizado_en IS NULL OR x.primera_captura_en <= e.sincronizado_en);
