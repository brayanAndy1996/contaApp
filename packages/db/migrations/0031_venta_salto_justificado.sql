-- 0031_venta_salto_justificado (spec 013, D8). Salto de numeración justificado por el contador. Solo SELECT e INSERT,
-- y UPDATE únicamente de las columnas `revertido_*` (revertir deja el registro con quién y cuándo, sin borrar). Nadie borra.

CREATE TABLE "venta_salto_justificado" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"cliente_id" uuid NOT NULL,
	"periodo" char(6) NOT NULL,
	"tipo" char(2) NOT NULL,
	"serie" varchar(4) NOT NULL,
	"desde" integer NOT NULL,
	"hasta" integer NOT NULL,
	"comentario" text NOT NULL,
	"usuario_id" uuid NOT NULL,
	"creada_en" timestamp with time zone DEFAULT now() NOT NULL,
	"revertido_por" uuid,
	"revertido_en" timestamp with time zone,
	CONSTRAINT "venta_salto_justificado_periodo_formato" CHECK ("venta_salto_justificado"."periodo" ~ '^[0-9]{4}(0[1-9]|1[0-2])$'),
	CONSTRAINT "venta_salto_justificado_rango_valido" CHECK ("venta_salto_justificado"."desde" BETWEEN 1 AND 99999999 AND "venta_salto_justificado"."hasta" BETWEEN 1 AND 99999999 AND "venta_salto_justificado"."desde" <= "venta_salto_justificado"."hasta"),
	CONSTRAINT "venta_salto_justificado_comentario_largo" CHECK (char_length("venta_salto_justificado"."comentario") BETWEEN 1 AND 500),
	CONSTRAINT "venta_salto_justificado_reversion_completa" CHECK (("venta_salto_justificado"."revertido_por" IS NULL) = ("venta_salto_justificado"."revertido_en" IS NULL))
);--> statement-breakpoint
ALTER TABLE "venta_salto_justificado" ADD CONSTRAINT "venta_salto_justificado_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venta_salto_justificado" ADD CONSTRAINT "venta_salto_justificado_cliente_fk" FOREIGN KEY ("tenant_id","cliente_id") REFERENCES "public"."cliente"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venta_salto_justificado" ADD CONSTRAINT "venta_salto_justificado_usuario_fk" FOREIGN KEY ("tenant_id","usuario_id") REFERENCES "public"."membresia"("tenant_id","usuario_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venta_salto_justificado" ADD CONSTRAINT "venta_salto_justificado_revertido_por_fk" FOREIGN KEY ("tenant_id","revertido_por") REFERENCES "public"."membresia"("tenant_id","usuario_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "venta_salto_justificado_vigente_unique" ON "venta_salto_justificado" USING btree ("tenant_id","cliente_id","periodo","tipo","serie","desde","hasta") WHERE "venta_salto_justificado"."revertido_en" IS NULL;--> statement-breakpoint

-- RLS ENABLE + FORCE y aislamiento por estudio (D5).
ALTER TABLE public.venta_salto_justificado OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.venta_salto_justificado ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.venta_salto_justificado FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.venta_salto_justificado;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.venta_salto_justificado FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
REVOKE ALL ON public.venta_salto_justificado FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app;--> statement-breakpoint
GRANT SELECT, INSERT ON public.venta_salto_justificado TO contapp_backend;--> statement-breakpoint
GRANT UPDATE (revertido_por, revertido_en) ON public.venta_salto_justificado TO contapp_backend;
