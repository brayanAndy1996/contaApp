-- 0033_compra_hallazgo_periodo (spec 014, D-2, D-9). Hallazgos de las reglas por versión (solo inserción, clave
-- (compra_id, version_n, regla)) y estado del periodo de compras (abierto, revisado, generado; sin fila equivale a abierto).
--   compra_hallazgo  SELECT/INSERT a backend y worker; ningún UPDATE ni DELETE.
--   compra_periodo   SELECT/INSERT y UPDATE de (estado, marcado_por, marcado_en) a backend y worker: el compare-and-set del estado,
--                    012b marca `generado` desde el worker y `FOR SHARE` (acciones y descarga) exige UPDATE de alguna columna. Sin DELETE.
-- RLS ENABLE + FORCE y tenant_isolation en las dos.

CREATE TABLE "compra_hallazgo" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"compra_id" uuid NOT NULL,
	"version_n" integer NOT NULL,
	"regla" text NOT NULL,
	"sugerencia" jsonb,
	"lecturas" jsonb NOT NULL,
	"requiere_confirmacion" boolean NOT NULL,
	"creada_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compra_hallazgo_compra_version_regla_unique" UNIQUE("tenant_id","compra_id","version_n","regla"),
	CONSTRAINT "compra_hallazgo_version_positiva" CHECK ("compra_hallazgo"."version_n" >= 1)
);
--> statement-breakpoint
CREATE TABLE "compra_periodo" (
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"cliente_id" uuid NOT NULL,
	"periodo" char(6) NOT NULL,
	"estado" text NOT NULL,
	"marcado_por" uuid,
	"marcado_en" timestamp with time zone,
	CONSTRAINT "compra_periodo_pk" PRIMARY KEY("tenant_id","cliente_id","periodo"),
	CONSTRAINT "compra_periodo_periodo_formato" CHECK ("compra_periodo"."periodo" ~ '^[0-9]{4}(0[1-9]|1[0-2])$'),
	CONSTRAINT "compra_periodo_estado_valido" CHECK ("compra_periodo"."estado" IN ('abierto', 'revisado', 'generado'))
);
--> statement-breakpoint
ALTER TABLE "compra_hallazgo" ADD CONSTRAINT "compra_hallazgo_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compra_hallazgo" ADD CONSTRAINT "compra_hallazgo_compra_fk" FOREIGN KEY ("tenant_id","compra_id") REFERENCES "public"."compra"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compra_periodo" ADD CONSTRAINT "compra_periodo_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compra_periodo" ADD CONSTRAINT "compra_periodo_cliente_fk" FOREIGN KEY ("tenant_id","cliente_id") REFERENCES "public"."cliente"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compra_periodo" ADD CONSTRAINT "compra_periodo_marcado_por_fk" FOREIGN KEY ("tenant_id","marcado_por") REFERENCES "public"."membresia"("tenant_id","usuario_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

-- RLS, dueño y grants.
ALTER TABLE public.compra_hallazgo OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.compra_hallazgo ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.compra_hallazgo FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.compra_hallazgo;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.compra_hallazgo FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
REVOKE ALL ON public.compra_hallazgo FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app;--> statement-breakpoint
GRANT SELECT, INSERT ON public.compra_hallazgo TO contapp_backend, contapp_worker;--> statement-breakpoint

ALTER TABLE public.compra_periodo OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.compra_periodo ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.compra_periodo FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.compra_periodo;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.compra_periodo FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
REVOKE ALL ON public.compra_periodo FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app;--> statement-breakpoint
GRANT SELECT, INSERT ON public.compra_periodo TO contapp_backend, contapp_worker;--> statement-breakpoint
GRANT UPDATE (estado, marcado_por, marcado_en) ON public.compra_periodo TO contapp_backend, contapp_worker;
