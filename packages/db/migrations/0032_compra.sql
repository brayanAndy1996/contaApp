-- 0032_compra (spec 014, D-1, D-2, D-7, RNF-052). Compras del RCE: `compra` (identidad), `compra_version` (cada edición, inmutable)
-- y `compra_operacion` (pila de deshacer). Montos NUMERIC(14,2). Grants mínimos y sin DELETE ni TRUNCATE para nadie:
--   compra            SELECT/INSERT a backend y worker; UPDATE de (version_vigente, descartada_en) solo al backend; trigger de identidad.
--   compra_version    SELECT/INSERT a backend y worker; ningún UPDATE ni DELETE (la versión 1 es el original, para siempre).
--   compra_operacion  SELECT/INSERT al backend, SELECT al worker; UPDATE de (estado, deshecha_en) solo al backend.
-- RLS ENABLE + FORCE y tenant_isolation (D5 de 013) en las tres.

CREATE TABLE "compra" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"cliente_id" uuid NOT NULL,
	"periodo" char(6) NOT NULL,
	"propuesta_id" uuid,
	"clave" text NOT NULL,
	"tipo_doc" char(2) NOT NULL,
	"serie" varchar(4) NOT NULL,
	"numero" varchar(20) NOT NULL,
	"doc_tipo" text NOT NULL,
	"doc_numero" text NOT NULL,
	"razon_social" text,
	"fecha" date NOT NULL,
	"moneda" text NOT NULL,
	"tipo_cambio" numeric(7, 3),
	"origen" text NOT NULL,
	"version_vigente" integer NOT NULL,
	"descartada_en" timestamp with time zone,
	"creada_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compra_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "compra_periodo_formato" CHECK ("compra"."periodo" ~ '^[0-9]{4}(0[1-9]|1[0-2])$'),
	CONSTRAINT "compra_origen_valido" CHECK ("compra"."origen" IN ('sire', 'agregada')),
	CONSTRAINT "compra_moneda_valida" CHECK ("compra"."moneda" IN ('PEN', 'USD')),
	CONSTRAINT "compra_propuesta_segun_origen" CHECK (("compra"."origen" = 'agregada' AND "compra"."propuesta_id" IS NULL) OR ("compra"."origen" = 'sire' AND "compra"."propuesta_id" IS NOT NULL)),
	CONSTRAINT "compra_tipo_cambio_valido" CHECK ("compra"."tipo_cambio" IS NULL OR ("compra"."moneda" = 'USD' AND "compra"."tipo_cambio" > 0)),
	CONSTRAINT "compra_version_vigente_positiva" CHECK ("compra"."version_vigente" >= 1),
	CONSTRAINT "compra_razon_social_larga" CHECK ("compra"."razon_social" IS NULL OR char_length("compra"."razon_social") <= 200)
);
--> statement-breakpoint
CREATE TABLE "compra_operacion" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"cliente_id" uuid NOT NULL,
	"periodo" char(6) NOT NULL,
	"usuario_id" uuid NOT NULL,
	"tipo" text NOT NULL,
	"estado" text NOT NULL,
	"referencia_id" uuid,
	"creada_en" timestamp with time zone DEFAULT now() NOT NULL,
	"deshecha_en" timestamp with time zone,
	CONSTRAINT "compra_operacion_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "compra_operacion_periodo_formato" CHECK ("compra_operacion"."periodo" ~ '^[0-9]{4}(0[1-9]|1[0-2])$'),
	CONSTRAINT "compra_operacion_estado_valido" CHECK ("compra_operacion"."estado" IN ('vigente', 'deshecha', 'caducada'))
);
--> statement-breakpoint
CREATE TABLE "compra_version" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"compra_id" uuid NOT NULL,
	"n" integer NOT NULL,
	"bi_dg" numeric(14, 2) NOT NULL,
	"igv_dg" numeric(14, 2) NOT NULL,
	"bi_dgng" numeric(14, 2) NOT NULL,
	"igv_dgng" numeric(14, 2) NOT NULL,
	"bi_dng" numeric(14, 2) NOT NULL,
	"igv_dng" numeric(14, 2) NOT NULL,
	"no_gravado" numeric(14, 2) NOT NULL,
	"isc" numeric(14, 2) NOT NULL,
	"icbper" numeric(14, 2) NOT NULL,
	"otros_tributos" numeric(14, 2) NOT NULL,
	"total" numeric(14, 2) NOT NULL,
	"excluida" boolean DEFAULT false NOT NULL,
	"motivo" varchar(200),
	"clasificada" boolean DEFAULT false NOT NULL,
	"accion" text NOT NULL,
	"operacion_id" uuid,
	"usuario_id" uuid,
	"creada_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compra_version_compra_n_unique" UNIQUE("tenant_id","compra_id","n"),
	CONSTRAINT "compra_version_n_positivo" CHECK ("compra_version"."n" >= 1)
);
--> statement-breakpoint
ALTER TABLE "compra" ADD CONSTRAINT "compra_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compra" ADD CONSTRAINT "compra_cliente_fk" FOREIGN KEY ("tenant_id","cliente_id") REFERENCES "public"."cliente"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compra" ADD CONSTRAINT "compra_propuesta_fk" FOREIGN KEY ("tenant_id","propuesta_id") REFERENCES "public"."propuesta"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compra_operacion" ADD CONSTRAINT "compra_operacion_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compra_operacion" ADD CONSTRAINT "compra_operacion_cliente_fk" FOREIGN KEY ("tenant_id","cliente_id") REFERENCES "public"."cliente"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compra_operacion" ADD CONSTRAINT "compra_operacion_usuario_fk" FOREIGN KEY ("tenant_id","usuario_id") REFERENCES "public"."membresia"("tenant_id","usuario_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compra_version" ADD CONSTRAINT "compra_version_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compra_version" ADD CONSTRAINT "compra_version_compra_fk" FOREIGN KEY ("tenant_id","compra_id") REFERENCES "public"."compra"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compra_version" ADD CONSTRAINT "compra_version_operacion_fk" FOREIGN KEY ("tenant_id","operacion_id") REFERENCES "public"."compra_operacion"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compra_version" ADD CONSTRAINT "compra_version_usuario_fk" FOREIGN KEY ("tenant_id","usuario_id") REFERENCES "public"."membresia"("tenant_id","usuario_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "compra_clave_viva_unique" ON "compra" USING btree ("tenant_id","cliente_id","periodo","clave") WHERE "compra"."descartada_en" IS NULL;--> statement-breakpoint
CREATE INDEX "compra_lectura_idx" ON "compra" USING btree ("cliente_id","periodo","serie","numero");--> statement-breakpoint
CREATE INDEX "compra_operacion_pila_idx" ON "compra_operacion" USING btree ("tenant_id","cliente_id","periodo","usuario_id","creada_en");--> statement-breakpoint
CREATE INDEX "compra_version_operacion_idx" ON "compra_version" USING btree ("tenant_id","operacion_id");
--> statement-breakpoint

-- RLS, dueño y grants.
ALTER TABLE public.compra OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.compra ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.compra FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.compra;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.compra FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
REVOKE ALL ON public.compra FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app;--> statement-breakpoint
GRANT SELECT, INSERT ON public.compra TO contapp_backend, contapp_worker;--> statement-breakpoint
GRANT UPDATE (version_vigente, descartada_en) ON public.compra TO contapp_backend;--> statement-breakpoint

ALTER TABLE public.compra_version OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.compra_version ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.compra_version FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.compra_version;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.compra_version FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
REVOKE ALL ON public.compra_version FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app;--> statement-breakpoint
GRANT SELECT, INSERT ON public.compra_version TO contapp_backend, contapp_worker;--> statement-breakpoint

ALTER TABLE public.compra_operacion OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.compra_operacion ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.compra_operacion FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.compra_operacion;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.compra_operacion FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
REVOKE ALL ON public.compra_operacion FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app;--> statement-breakpoint
GRANT SELECT, INSERT ON public.compra_operacion TO contapp_backend;--> statement-breakpoint
GRANT SELECT ON public.compra_operacion TO contapp_worker;--> statement-breakpoint
GRANT UPDATE (estado, deshecha_en) ON public.compra_operacion TO contapp_backend;--> statement-breakpoint

-- Trigger de identidad de `compra`: solo `version_vigente` (el puntero) y `descartada_en` (de NULL a una fecha, una sola vez) son
-- mutables; vale también para el superusuario y para quien tuviera UPDATE por error. SECURITY INVOKER y fuera de `auth`.
-- Mensaje fijo: no repite datos de la fila.
CREATE OR REPLACE FUNCTION public.compra_identidad_inmutable() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.cliente_id IS DISTINCT FROM OLD.cliente_id
     OR NEW.periodo IS DISTINCT FROM OLD.periodo
     OR NEW.propuesta_id IS DISTINCT FROM OLD.propuesta_id
     OR NEW.clave IS DISTINCT FROM OLD.clave
     OR NEW.tipo_doc IS DISTINCT FROM OLD.tipo_doc
     OR NEW.serie IS DISTINCT FROM OLD.serie
     OR NEW.numero IS DISTINCT FROM OLD.numero
     OR NEW.doc_tipo IS DISTINCT FROM OLD.doc_tipo
     OR NEW.doc_numero IS DISTINCT FROM OLD.doc_numero
     OR NEW.razon_social IS DISTINCT FROM OLD.razon_social
     OR NEW.fecha IS DISTINCT FROM OLD.fecha
     OR NEW.moneda IS DISTINCT FROM OLD.moneda
     OR NEW.tipo_cambio IS DISTINCT FROM OLD.tipo_cambio
     OR NEW.origen IS DISTINCT FROM OLD.origen
     OR NEW.creada_en IS DISTINCT FROM OLD.creada_en THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'compra: la identidad de la fila no se modifica';
  END IF;
  IF OLD.descartada_en IS NOT NULL AND NEW.descartada_en IS DISTINCT FROM OLD.descartada_en THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'compra: una compra descartada no se reabre ni cambia de fecha';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.compra_identidad_inmutable() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.compra_identidad_inmutable() FROM PUBLIC;--> statement-breakpoint

DROP TRIGGER IF EXISTS compra_identidad_inmutable ON public.compra;--> statement-breakpoint
CREATE TRIGGER compra_identidad_inmutable BEFORE UPDATE ON public.compra
  FOR EACH ROW EXECUTE FUNCTION public.compra_identidad_inmutable();
