-- 0029_propuesta_diferencia (spec 013, D1, D16). Lo que el SIRE trajo distinto de lo ya guardado: campos que difieren
-- y valores del SIRE (cadenas). Inmutable: solo SELECT e INSERT para backend y worker.

CREATE TABLE "propuesta_diferencia" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"propuesta_id" uuid NOT NULL,
	"clave" text NOT NULL,
	"tipo" text NOT NULL,
	"serie" text NOT NULL,
	"numero" text NOT NULL,
	"origen_existente" text NOT NULL,
	"campos" text[] NOT NULL,
	"valores_sire" jsonb NOT NULL,
	CONSTRAINT "propuesta_diferencia_origen_valido" CHECK ("propuesta_diferencia"."origen_existente" IN ('sire', 'manual')),
	CONSTRAINT "propuesta_diferencia_campos_no_vacio" CHECK (cardinality("propuesta_diferencia"."campos") >= 1),
	CONSTRAINT "propuesta_diferencia_valores_objeto" CHECK (jsonb_typeof("propuesta_diferencia"."valores_sire") = 'object')
);--> statement-breakpoint
ALTER TABLE "propuesta_diferencia" ADD CONSTRAINT "propuesta_diferencia_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "propuesta_diferencia" ADD CONSTRAINT "propuesta_diferencia_propuesta_fk" FOREIGN KEY ("tenant_id","propuesta_id") REFERENCES "public"."propuesta"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "propuesta_diferencia_propuesta_idx" ON "propuesta_diferencia" USING btree ("tenant_id","propuesta_id","clave");--> statement-breakpoint

-- RLS ENABLE + FORCE y aislamiento por estudio (D5).
ALTER TABLE public.propuesta_diferencia OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.propuesta_diferencia ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.propuesta_diferencia FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.propuesta_diferencia;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.propuesta_diferencia FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
REVOKE ALL ON public.propuesta_diferencia FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app;--> statement-breakpoint
GRANT SELECT, INSERT ON public.propuesta_diferencia TO contapp_backend, contapp_worker;
