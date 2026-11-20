-- 0054_buzon_tablas (spec 023, D-3, D-4, P-10; CA-9, CA-13). Buzón SOL: estado de captura por cliente, metadatos de cada mensaje
-- y adjuntos (solo al abrir). Parte generada por drizzle-kit (tablas, FK compuestas, CHECK y el CHECK de acciones de auditoría con
-- las 5 del buzón); lo que sigue a las tablas es repetible: DROP ... IF EXISTS, CREATE OR REPLACE, GRANT/REVOKE.
--   Las tres con RLS ENABLE + FORCE y tenant_isolation FOR ALL; dueño contapp_migrator. Nadie de la app borra (retención, P-10:
--   archivar el cliente conserva todo; la purga es de 037).
--   buzon_estado_cliente  backend: SELECT y UPDATE (ultima_solicitud_en). worker: SELECT, INSERT y UPDATE (ultima_captura_en,
--                         sincronizado_en, cursor_pendiente). ultima_programada_en solo la fija encolar_buzon_programados (0055).
--   buzon_mensaje         backend: SELECT. worker: SELECT, INSERT y UPDATE (leido_sunat, ultima_captura_en, contenido_ruta,
--                         contenido_bytes, contenido_obtenido_en). Única (tenant, cliente, id_sunat): la captura inserta con
--                         ON CONFLICT DO NOTHING. avisado -> critico.
--   buzon_adjunto         backend: SELECT. worker: SELECT, INSERT. FK (tenant, cliente, mensaje) -> buzon_mensaje(tenant, cliente,
--                         id): un adjunto con el mensaje de otro cliente o estudio es imposible. Guardado u omitido, nunca ambos.
--   Rutas de storage ('buzon/{tenant}/{cliente}/{uuid}.{ext}') con el estudio y el cliente de la propia fila (CHECK).
--   Trigger buzon_mensaje_inmutable (SECURITY INVOKER): salvo un superusuario (reclasificación manual), nadie cambia la identidad,
--   el asunto, la fecha, la clasificación ni el aviso de un mensaje guardado, y el contenido se fija una sola vez (42501).
CREATE TABLE "buzon_adjunto" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"cliente_id" uuid NOT NULL,
	"mensaje_id" uuid NOT NULL,
	"id_sunat" text NOT NULL,
	"nombre" text NOT NULL,
	"mime" text,
	"tamano" bigint,
	"sha256" "bytea",
	"ruta" text,
	"omitido" text,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "buzon_adjunto_id_sunat_unique" UNIQUE("tenant_id","mensaje_id","id_sunat"),
	CONSTRAINT "buzon_adjunto_id_sunat_largo" CHECK (char_length("buzon_adjunto"."id_sunat") BETWEEN 1 AND 64),
	CONSTRAINT "buzon_adjunto_nombre_largo" CHECK (char_length("buzon_adjunto"."nombre") BETWEEN 1 AND 255),
	CONSTRAINT "buzon_adjunto_mime_largo" CHECK (char_length("buzon_adjunto"."mime") BETWEEN 1 AND 100),
	CONSTRAINT "buzon_adjunto_omitido_valido" CHECK ("buzon_adjunto"."omitido" IN ('mime', 'tamano', 'tope_mensaje')),
	CONSTRAINT "buzon_adjunto_guardado_u_omitido" CHECK (("buzon_adjunto"."omitido" IS NULL AND "buzon_adjunto"."ruta" IS NOT NULL AND "buzon_adjunto"."mime" IS NOT NULL AND "buzon_adjunto"."tamano" IS NOT NULL AND "buzon_adjunto"."sha256" IS NOT NULL) OR ("buzon_adjunto"."omitido" IS NOT NULL AND "buzon_adjunto"."ruta" IS NULL AND "buzon_adjunto"."mime" IS NULL AND "buzon_adjunto"."tamano" IS NULL AND "buzon_adjunto"."sha256" IS NULL)),
	CONSTRAINT "buzon_adjunto_tamano_no_negativo" CHECK ("buzon_adjunto"."tamano" >= 0),
	CONSTRAINT "buzon_adjunto_sha256_largo" CHECK (octet_length("buzon_adjunto"."sha256") = 32),
	CONSTRAINT "buzon_adjunto_ruta" CHECK ("buzon_adjunto"."ruta" ~ ('^buzon/' || "buzon_adjunto"."tenant_id"::text || '/' || "buzon_adjunto"."cliente_id"::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.][a-z0-9]{1,10}$'))
);
--> statement-breakpoint
CREATE TABLE "buzon_estado_cliente" (
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"cliente_id" uuid NOT NULL,
	"ultima_programada_en" timestamp with time zone,
	"ultima_solicitud_en" timestamp with time zone,
	"ultima_captura_en" timestamp with time zone,
	"sincronizado_en" timestamp with time zone,
	"cursor_pendiente" text,
	CONSTRAINT "buzon_estado_cliente_pk" PRIMARY KEY("tenant_id","cliente_id"),
	CONSTRAINT "buzon_estado_cliente_cursor_largo" CHECK (char_length("buzon_estado_cliente"."cursor_pendiente") <= 200)
);
--> statement-breakpoint
CREATE TABLE "buzon_mensaje" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"cliente_id" uuid NOT NULL,
	"id_sunat" text NOT NULL,
	"asunto" text NOT NULL,
	"remitente" text NOT NULL,
	"fecha" timestamp with time zone NOT NULL,
	"codigo_tipo" text,
	"categoria" text NOT NULL,
	"critico" boolean NOT NULL,
	"motivo_critico" text,
	"version_catalogo" integer NOT NULL,
	"avisado" boolean DEFAULT false NOT NULL,
	"leido_sunat" boolean DEFAULT false NOT NULL,
	"primera_captura_en" timestamp with time zone DEFAULT now() NOT NULL,
	"ultima_captura_en" timestamp with time zone DEFAULT now() NOT NULL,
	"adjuntos_declarados" smallint DEFAULT 0 NOT NULL,
	"contenido_ruta" text,
	"contenido_bytes" integer,
	"contenido_obtenido_en" timestamp with time zone,
	CONSTRAINT "buzon_mensaje_id_sunat_unique" UNIQUE("tenant_id","cliente_id","id_sunat"),
	CONSTRAINT "buzon_mensaje_cliente_id_unique" UNIQUE("tenant_id","cliente_id","id"),
	CONSTRAINT "buzon_mensaje_id_sunat_largo" CHECK (char_length("buzon_mensaje"."id_sunat") BETWEEN 1 AND 64),
	CONSTRAINT "buzon_mensaje_asunto_largo" CHECK (char_length("buzon_mensaje"."asunto") <= 500),
	CONSTRAINT "buzon_mensaje_remitente_largo" CHECK (char_length("buzon_mensaje"."remitente") <= 200),
	CONSTRAINT "buzon_mensaje_codigo_tipo_largo" CHECK (char_length("buzon_mensaje"."codigo_tipo") <= 32),
	CONSTRAINT "buzon_mensaje_categoria_valida" CHECK ("buzon_mensaje"."categoria" IN ('coactiva', 'resolucion_determinacion', 'resolucion_multa', 'requerimiento_fiscalizacion', 'otro')),
	CONSTRAINT "buzon_mensaje_motivo_valido" CHECK ("buzon_mensaje"."motivo_critico" IN ('codigo', 'asunto', 'duda')),
	CONSTRAINT "buzon_mensaje_avisado_critico" CHECK (NOT "buzon_mensaje"."avisado" OR "buzon_mensaje"."critico"),
	CONSTRAINT "buzon_mensaje_version_positiva" CHECK ("buzon_mensaje"."version_catalogo" >= 1),
	CONSTRAINT "buzon_mensaje_adjuntos_no_negativo" CHECK ("buzon_mensaje"."adjuntos_declarados" >= 0),
	CONSTRAINT "buzon_mensaje_contenido_coherente" CHECK (("buzon_mensaje"."contenido_ruta" IS NULL) = ("buzon_mensaje"."contenido_bytes" IS NULL) AND ("buzon_mensaje"."contenido_ruta" IS NULL) = ("buzon_mensaje"."contenido_obtenido_en" IS NULL) AND ("buzon_mensaje"."contenido_bytes" IS NULL OR "buzon_mensaje"."contenido_bytes" >= 0)),
	CONSTRAINT "buzon_mensaje_contenido_ruta" CHECK ("buzon_mensaje"."contenido_ruta" ~ ('^buzon/' || "buzon_mensaje"."tenant_id"::text || '/' || "buzon_mensaje"."cliente_id"::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.][a-z0-9]{1,10}$'))
);
--> statement-breakpoint
ALTER TABLE "auditoria" DROP CONSTRAINT "auditoria_accion_valida";--> statement-breakpoint
ALTER TABLE "buzon_adjunto" ADD CONSTRAINT "buzon_adjunto_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buzon_adjunto" ADD CONSTRAINT "buzon_adjunto_mensaje_fk" FOREIGN KEY ("tenant_id","cliente_id","mensaje_id") REFERENCES "public"."buzon_mensaje"("tenant_id","cliente_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buzon_adjunto" ADD CONSTRAINT "buzon_adjunto_cliente_fk" FOREIGN KEY ("tenant_id","cliente_id") REFERENCES "public"."cliente"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buzon_estado_cliente" ADD CONSTRAINT "buzon_estado_cliente_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buzon_estado_cliente" ADD CONSTRAINT "buzon_estado_cliente_cliente_fk" FOREIGN KEY ("tenant_id","cliente_id") REFERENCES "public"."cliente"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buzon_mensaje" ADD CONSTRAINT "buzon_mensaje_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buzon_mensaje" ADD CONSTRAINT "buzon_mensaje_cliente_fk" FOREIGN KEY ("tenant_id","cliente_id") REFERENCES "public"."cliente"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "buzon_mensaje_lista_idx" ON "buzon_mensaje" USING btree ("tenant_id","cliente_id","fecha" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "auditoria" ADD CONSTRAINT "auditoria_accion_valida" CHECK ("auditoria"."accion" IN ('sesion.ingreso', 'invitacion.creada', 'invitacion.revocada', 'invitacion.modificada', 'miembro.alta', 'miembro.rol_cambiado', 'miembro.desactivado', 'miembro.reactivado', 'miembro.eliminado', 'asignacion.agregada', 'asignacion.quitada', 'asignacion.tipo_cambiado', 'cliente.creado', 'cliente.editado', 'cliente.archivado', 'cliente.reactivado', 'cliente.eliminado', 'credencial.guardada', 'credencial.verificada', 'credencial.invalidada', 'credencial.descifrada', 'propuesta.cargada', 'compra.operacion', 'venta.agregada', 'venta.excluida', 'venta.restaurada', 'venta.salto_justificado', 'xml.subido', 'periodo.estado_cambiado', 'archivo.generado', 'sunat.envio', 'regla.creada', 'regla.editada', 'regla.activada', 'regla.desactivada', 'regla.eliminada', 'estudio.regla_motor', 'estudio.aporte_catalogo', 'compra.historial', 'buzon.captura_solicitada', 'buzon.apertura_solicitada', 'buzon.contenido_visto', 'buzon.adjunto_descargado', 'buzon.contenido_obtenido'));--> statement-breakpoint

-- ---- RLS, dueño y grants -------------------------------------------------------------------------------------------------
ALTER TABLE public.buzon_estado_cliente OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.buzon_estado_cliente ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.buzon_estado_cliente FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.buzon_estado_cliente;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.buzon_estado_cliente FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
REVOKE ALL ON public.buzon_estado_cliente
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT SELECT ON public.buzon_estado_cliente TO contapp_backend, contapp_worker;--> statement-breakpoint
GRANT UPDATE (ultima_solicitud_en) ON public.buzon_estado_cliente TO contapp_backend;--> statement-breakpoint
GRANT INSERT ON public.buzon_estado_cliente TO contapp_worker;--> statement-breakpoint
GRANT UPDATE (ultima_captura_en, sincronizado_en, cursor_pendiente) ON public.buzon_estado_cliente TO contapp_worker;--> statement-breakpoint

ALTER TABLE public.buzon_mensaje OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.buzon_mensaje ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.buzon_mensaje FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.buzon_mensaje;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.buzon_mensaje FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
REVOKE ALL ON public.buzon_mensaje
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT SELECT ON public.buzon_mensaje TO contapp_backend, contapp_worker;--> statement-breakpoint
GRANT INSERT ON public.buzon_mensaje TO contapp_worker;--> statement-breakpoint
GRANT UPDATE (leido_sunat, ultima_captura_en, contenido_ruta, contenido_bytes, contenido_obtenido_en)
  ON public.buzon_mensaje TO contapp_worker;--> statement-breakpoint

ALTER TABLE public.buzon_adjunto OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.buzon_adjunto ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.buzon_adjunto FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.buzon_adjunto;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.buzon_adjunto FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
REVOKE ALL ON public.buzon_adjunto
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT SELECT ON public.buzon_adjunto TO contapp_backend, contapp_worker;--> statement-breakpoint
GRANT INSERT ON public.buzon_adjunto TO contapp_worker;--> statement-breakpoint

-- ---- Inmutabilidad del mensaje -------------------------------------------------------------------------------------------
-- SECURITY INVOKER: current_user es quien escribe. Un superusuario puede reclasificar a mano (sin volver a avisar: el aviso es
-- solo del INSERT, 0056); cualquier otro rol (el worker por sus grants de columna) solo cambia leido_sunat, ultima_captura_en y
-- fija el contenido una vez (NULL -> valor, con sus bytes y su instante).
CREATE OR REPLACE FUNCTION public.buzon_mensaje_inmutable() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND r.rolsuper) THEN
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.cliente_id, NEW.id_sunat, NEW.asunto, NEW.remitente, NEW.fecha, NEW.codigo_tipo, NEW.categoria,
      NEW.critico, NEW.motivo_critico, NEW.version_catalogo, NEW.avisado, NEW.primera_captura_en, NEW.adjuntos_declarados)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.cliente_id, OLD.id_sunat, OLD.asunto, OLD.remitente, OLD.fecha, OLD.codigo_tipo, OLD.categoria,
      OLD.critico, OLD.motivo_critico, OLD.version_catalogo, OLD.avisado, OLD.primera_captura_en, OLD.adjuntos_declarados)
     OR (OLD.contenido_ruta IS NOT NULL
         AND (NEW.contenido_ruta, NEW.contenido_bytes, NEW.contenido_obtenido_en)
             IS DISTINCT FROM (OLD.contenido_ruta, OLD.contenido_bytes, OLD.contenido_obtenido_en))
  THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'buzon_mensaje: lo guardado no cambia';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.buzon_mensaje_inmutable() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.buzon_mensaje_inmutable() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS buzon_mensaje_inmutable ON public.buzon_mensaje;--> statement-breakpoint
CREATE TRIGGER buzon_mensaje_inmutable BEFORE UPDATE ON public.buzon_mensaje
  FOR EACH ROW EXECUTE FUNCTION public.buzon_mensaje_inmutable();
