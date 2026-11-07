-- 0030_venta (spec 013, D1, D4, D14b, D17). Fila de venta del RVIE, montos NUMERIC(14,2). Inmutable por trigger: ningún
-- UPDATE y DELETE solo de filas `manual` (también para el superusuario). Grants: SELECT/INSERT a backend y worker, DELETE
-- solo al backend (quitar una agregada a mano); TRUNCATE a nadie (no pasa por triggers).

CREATE TABLE "venta" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"cliente_id" uuid NOT NULL,
	"periodo" char(6) NOT NULL,
	"propuesta_id" uuid,
	"origen" text NOT NULL,
	"clave" text NOT NULL,
	"tipo" char(2) NOT NULL,
	"serie" varchar(4) NOT NULL,
	"numero" varchar(20) NOT NULL,
	"numero_n" integer,
	"fecha" date NOT NULL,
	"tipo_doc_contraparte" text NOT NULL,
	"doc_contraparte" text NOT NULL,
	"moneda" text NOT NULL,
	"tipo_cambio" numeric(7, 3),
	"base_gravada" numeric(14, 2) NOT NULL,
	"igv" numeric(14, 2) NOT NULL,
	"exonerada" numeric(14, 2) NOT NULL,
	"inafecta" numeric(14, 2) NOT NULL,
	"isc" numeric(14, 2) NOT NULL,
	"icbper" numeric(14, 2) NOT NULL,
	"otros" numeric(14, 2) NOT NULL,
	"total" numeric(14, 2) NOT NULL,
	"creada_por" uuid,
	"creada_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "venta_cliente_periodo_clave_unique" UNIQUE("tenant_id","cliente_id","periodo","clave"),
	CONSTRAINT "venta_periodo_formato" CHECK ("venta"."periodo" ~ '^[0-9]{4}(0[1-9]|1[0-2])$'),
	CONSTRAINT "venta_origen_valido" CHECK ("venta"."origen" IN ('sire', 'manual')),
	CONSTRAINT "venta_moneda_valida" CHECK ("venta"."moneda" IN ('PEN', 'USD')),
	CONSTRAINT "venta_propuesta_segun_origen" CHECK (("venta"."origen" = 'manual' AND "venta"."propuesta_id" IS NULL) OR ("venta"."origen" = 'sire' AND "venta"."propuesta_id" IS NOT NULL)),
	CONSTRAINT "venta_tipo_cambio_valido" CHECK ("venta"."tipo_cambio" IS NULL OR ("venta"."moneda" = 'USD' AND "venta"."tipo_cambio" > 0)),
	CONSTRAINT "venta_numero_n_coherente" CHECK (CASE WHEN "venta"."numero" ~ '^[0-9]{1,8}$' THEN "venta"."numero_n" IS NULL OR "venta"."numero_n" = "venta"."numero"::integer ELSE "venta"."numero_n" IS NULL END)
);--> statement-breakpoint
ALTER TABLE "venta" ADD CONSTRAINT "venta_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venta" ADD CONSTRAINT "venta_cliente_fk" FOREIGN KEY ("tenant_id","cliente_id") REFERENCES "public"."cliente"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venta" ADD CONSTRAINT "venta_propuesta_fk" FOREIGN KEY ("tenant_id","propuesta_id") REFERENCES "public"."propuesta"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venta" ADD CONSTRAINT "venta_creada_por_fk" FOREIGN KEY ("tenant_id","creada_por") REFERENCES "public"."membresia"("tenant_id","usuario_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "venta_lectura_idx" ON "venta" USING btree ("cliente_id","periodo","tipo","serie","numero_n");--> statement-breakpoint

-- RLS ENABLE + FORCE y aislamiento por estudio (D5).
ALTER TABLE public.venta OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.venta ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.venta FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.venta;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.venta FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
REVOKE ALL ON public.venta FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app;--> statement-breakpoint
GRANT SELECT, INSERT ON public.venta TO contapp_backend, contapp_worker;--> statement-breakpoint
GRANT DELETE ON public.venta TO contapp_backend;--> statement-breakpoint

-- Trigger de inmutabilidad. SECURITY INVOKER y fuera de `auth`: corre con los permisos de quien modifica la fila. Los
-- mensajes son fijos (no repiten datos de la fila).
CREATE OR REPLACE FUNCTION public.venta_inmutable() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'venta: las filas no se modifican';
  END IF;
  IF OLD.origen <> 'manual' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'venta: solo se pueden quitar las filas agregadas a mano';
  END IF;
  RETURN OLD;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.venta_inmutable() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.venta_inmutable() FROM PUBLIC;--> statement-breakpoint

DROP TRIGGER IF EXISTS venta_inmutable ON public.venta;--> statement-breakpoint
CREATE TRIGGER venta_inmutable BEFORE UPDATE OR DELETE ON public.venta
  FOR EACH ROW EXECUTE FUNCTION public.venta_inmutable();
