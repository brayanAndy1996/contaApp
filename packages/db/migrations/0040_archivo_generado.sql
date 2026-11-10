-- 0040_archivo_generado (spec 012b, D3, D5, D6). Versiones generadas del archivo de reemplazo de cada libro (compras y ventas).
--   archivo_generado  backend SELECT; worker SELECT e INSERT; nadie actualiza ni borra (trigger BEFORE UPDATE OR DELETE -> 42501 para
--                     todos, también contapp_migrator y el superusuario; solo `session_replication_role = replica` lo salta).
--                     Trigger BEFORE INSERT -> 23514 si el periodo de ESE libro no está `generado` por `generado_por` o si la
--                     versión no es máx + 1 de (estudio, cliente, periodo, libro). Toma el periodo con FOR SHARE: un reabrir
--                     concurrente espera a que la versión se confirme.
-- RLS ENABLE + FORCE y tenant_isolation. Funciones SECURITY INVOKER de dueño contapp_migrator, search_path fijo, mensajes fijos y sin
-- EXECUTE para PUBLIC. Fila de la cola `archivos` en config_sistema (worker, 012b). La parte de funciones, triggers, RLS, grants y
-- config es repetible sentencia a sentencia (CREATE OR REPLACE, DROP ... IF EXISTS, GRANT/REVOKE, ON CONFLICT DO NOTHING).
CREATE TABLE "archivo_generado" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"cliente_id" uuid NOT NULL,
	"periodo" char(6) NOT NULL,
	"libro" text NOT NULL,
	"version" integer NOT NULL,
	"formato_id" text NOT NULL,
	"formato_version" text NOT NULL,
	"provisional" boolean NOT NULL,
	"nombre_txt" text NOT NULL,
	"nombre_zip" text NOT NULL,
	"sha256_txt" "bytea" NOT NULL,
	"sha256_zip" "bytea" NOT NULL,
	"bytes_zip" integer NOT NULL,
	"lineas" integer NOT NULL,
	"huella" text NOT NULL,
	"modificadas" integer NOT NULL,
	"excluidas" integer NOT NULL,
	"agregadas" integer NOT NULL,
	"impacto_igv_dg" numeric(14, 2),
	"impacto_igv_dgng" numeric(14, 2),
	"impacto_igv_dng" numeric(14, 2),
	"impacto_igv_total" numeric(14, 2) NOT NULL,
	"avisos" jsonb NOT NULL,
	"ruta" text NOT NULL,
	"trabajo_id" uuid NOT NULL,
	"generado_por" uuid NOT NULL,
	"generado_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "archivo_generado_version_unique" UNIQUE("tenant_id","cliente_id","periodo","libro","version"),
	CONSTRAINT "archivo_generado_trabajo_unique" UNIQUE("tenant_id","trabajo_id"),
	CONSTRAINT "archivo_generado_libro_valido" CHECK ("archivo_generado"."libro" IN ('compras', 'ventas')),
	CONSTRAINT "archivo_generado_periodo_formato" CHECK ("archivo_generado"."periodo" ~ '^[0-9]{4}(0[1-9]|1[0-2])$'),
	CONSTRAINT "archivo_generado_version_positiva" CHECK ("archivo_generado"."version" >= 1),
	CONSTRAINT "archivo_generado_formato_valido" CHECK (char_length("archivo_generado"."formato_id") BETWEEN 1 AND 64 AND char_length("archivo_generado"."formato_version") BETWEEN 1 AND 64),
	CONSTRAINT "archivo_generado_sha256_txt_largo" CHECK (octet_length("archivo_generado"."sha256_txt") = 32),
	CONSTRAINT "archivo_generado_sha256_zip_largo" CHECK (octet_length("archivo_generado"."sha256_zip") = 32),
	CONSTRAINT "archivo_generado_huella_formato" CHECK ("archivo_generado"."huella" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "archivo_generado_nombre_txt_formato" CHECK ("archivo_generado"."nombre_txt" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.txt$' AND position('..' in "archivo_generado"."nombre_txt") = 0),
	CONSTRAINT "archivo_generado_nombre_zip_formato" CHECK ("archivo_generado"."nombre_zip" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.zip$' AND position('..' in "archivo_generado"."nombre_zip") = 0),
	CONSTRAINT "archivo_generado_ruta_formato" CHECK ("archivo_generado"."ruta" = 'archivos/' || "archivo_generado"."tenant_id"::text || '/' || "archivo_generado"."cliente_id"::text || '/' || "archivo_generado"."id"::text || '.zip'),
	CONSTRAINT "archivo_generado_conteos_no_negativos" CHECK ("archivo_generado"."bytes_zip" >= 0 AND "archivo_generado"."lineas" >= 0 AND "archivo_generado"."modificadas" >= 0 AND "archivo_generado"."excluidas" >= 0 AND "archivo_generado"."agregadas" >= 0),
	CONSTRAINT "archivo_generado_impactos_segun_libro" CHECK (("archivo_generado"."libro" = 'ventas' AND "archivo_generado"."impacto_igv_dg" IS NULL AND "archivo_generado"."impacto_igv_dgng" IS NULL AND "archivo_generado"."impacto_igv_dng" IS NULL) OR ("archivo_generado"."libro" <> 'ventas' AND "archivo_generado"."impacto_igv_dg" IS NOT NULL AND "archivo_generado"."impacto_igv_dgng" IS NOT NULL AND "archivo_generado"."impacto_igv_dng" IS NOT NULL)),
	CONSTRAINT "archivo_generado_avisos_conteos" CHECK (jsonb_typeof("archivo_generado"."avisos") = 'object' AND octet_length("archivo_generado"."avisos"::text) <= 2048)
);
--> statement-breakpoint
ALTER TABLE "archivo_generado" ADD CONSTRAINT "archivo_generado_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archivo_generado" ADD CONSTRAINT "archivo_generado_cliente_fk" FOREIGN KEY ("tenant_id","cliente_id") REFERENCES "public"."cliente"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archivo_generado" ADD CONSTRAINT "archivo_generado_generado_por_fk" FOREIGN KEY ("tenant_id","generado_por") REFERENCES "public"."membresia"("tenant_id","usuario_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- RLS, dueño y grants.
ALTER TABLE public.archivo_generado OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.archivo_generado ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.archivo_generado FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.archivo_generado;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.archivo_generado FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
REVOKE ALL ON public.archivo_generado FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app;--> statement-breakpoint
GRANT SELECT ON public.archivo_generado TO contapp_backend;--> statement-breakpoint
GRANT SELECT, INSERT ON public.archivo_generado TO contapp_worker;--> statement-breakpoint

-- Inmutable para todos.
CREATE OR REPLACE FUNCTION public.archivo_generado_inmutable() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '42501',
    MESSAGE = 'archivo_generado: una version generada no se cambia ni se borra';
END
$$;--> statement-breakpoint
ALTER FUNCTION public.archivo_generado_inmutable() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.archivo_generado_inmutable() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS archivo_generado_inmutable ON public.archivo_generado;--> statement-breakpoint
CREATE TRIGGER archivo_generado_inmutable BEFORE UPDATE OR DELETE ON public.archivo_generado
  FOR EACH ROW EXECUTE FUNCTION public.archivo_generado_inmutable();--> statement-breakpoint

-- Al insertar: el periodo de ese libro está `generado` por quien genera y la versión es la siguiente de su serie. INVOKER: lee el
-- estado y las versiones con los permisos y la RLS de quien inserta (un periodo de otro estudio no se ve y se rechaza).
CREATE OR REPLACE FUNCTION public.archivo_generado_insertar() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_estado text;
  v_por uuid;
  v_max integer;
BEGIN
  IF NEW.libro = 'compras' THEN
    SELECT p.estado, p.marcado_por INTO v_estado, v_por FROM public.compra_periodo p
     WHERE p.tenant_id = NEW.tenant_id AND p.cliente_id = NEW.cliente_id AND p.periodo = NEW.periodo
     FOR SHARE;
  ELSIF NEW.libro = 'ventas' THEN
    SELECT p.estado, p.marcado_por INTO v_estado, v_por FROM public.venta_periodo p
     WHERE p.tenant_id = NEW.tenant_id AND p.cliente_id = NEW.cliente_id AND p.periodo = NEW.periodo
     FOR SHARE;
  END IF;
  IF v_estado IS DISTINCT FROM 'generado' OR v_por IS NULL OR v_por IS DISTINCT FROM NEW.generado_por THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'archivo_generado: el periodo del libro no esta generado por quien genera';
  END IF;
  SELECT coalesce(max(a.version), 0) INTO v_max FROM public.archivo_generado a
   WHERE a.tenant_id = NEW.tenant_id AND a.cliente_id = NEW.cliente_id AND a.periodo = NEW.periodo AND a.libro = NEW.libro;
  IF NEW.version IS DISTINCT FROM v_max + 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'archivo_generado: la version no es la siguiente';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.archivo_generado_insertar() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.archivo_generado_insertar() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS archivo_generado_insertar ON public.archivo_generado;--> statement-breakpoint
CREATE TRIGGER archivo_generado_insertar BEFORE INSERT ON public.archivo_generado
  FOR EACH ROW EXECUTE FUNCTION public.archivo_generado_insertar();--> statement-breakpoint

-- Cola `archivos` (D12/D19 de 008): sin SUNAT (espera 0). No pisa cambios hechos después por contapp_migrator.
INSERT INTO public.config_sistema
  (cola, concurrencia_global, concurrencia_tenant, espera_ruc_ms, reintentos, backoff_base_ms, max_pendientes_tenant)
VALUES
  ('archivos', 4, 2, 0, 3, 5000, 2000)
ON CONFLICT (cola) DO NOTHING;
