-- 0028_propuesta (spec 013, D1, D4, D5, D15). Encabezado inmutable de cada descarga o importación de un libro, común
-- a ventas y compras. Una migración por tabla (D15). RLS ENABLE + FORCE y grants mínimos: SELECT e INSERT para el
-- backend (importación) y el worker (descarga); ni UPDATE, ni DELETE, ni TRUNCATE (RNF-052). La única (tenant_id, id)
-- sirve a las FK compuestas de `propuesta_diferencia`, `venta` y (014) `compra`. Sin FK de trabajo_id: el worker purga
-- los trabajos terminados (0018) y el encabezado no se actualiza nunca.

CREATE TABLE "propuesta" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"cliente_id" uuid NOT NULL,
	"periodo" char(6) NOT NULL,
	"libro" text NOT NULL,
	"fuente" text NOT NULL,
	"hash" char(64) NOT NULL,
	"filas_recibidas" integer NOT NULL,
	"filas_nuevas" integer NOT NULL,
	"filas_iguales" integer NOT NULL,
	"filas_distintas" integer NOT NULL,
	"usuario_id" uuid NOT NULL,
	"trabajo_id" uuid,
	"creada_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "propuesta_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "propuesta_periodo_formato" CHECK ("propuesta"."periodo" ~ '^[0-9]{4}(0[1-9]|1[0-2])$'),
	CONSTRAINT "propuesta_libro_valido" CHECK ("propuesta"."libro" IN ('compras', 'ventas')),
	CONSTRAINT "propuesta_fuente_valida" CHECK ("propuesta"."fuente" IN ('api', 'importacion')),
	CONSTRAINT "propuesta_hash_formato" CHECK ("propuesta"."hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "propuesta_contadores_cuadran" CHECK ("propuesta"."filas_nuevas" >= 0 AND "propuesta"."filas_iguales" >= 0 AND "propuesta"."filas_distintas" >= 0 AND "propuesta"."filas_recibidas" = "propuesta"."filas_nuevas" + "propuesta"."filas_iguales" + "propuesta"."filas_distintas"),
	CONSTRAINT "propuesta_recibidas_tope" CHECK ("propuesta"."filas_recibidas" <= 20000)
);--> statement-breakpoint
ALTER TABLE "propuesta" ADD CONSTRAINT "propuesta_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "propuesta" ADD CONSTRAINT "propuesta_cliente_fk" FOREIGN KEY ("tenant_id","cliente_id") REFERENCES "public"."cliente"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "propuesta" ADD CONSTRAINT "propuesta_usuario_fk" FOREIGN KEY ("tenant_id","usuario_id") REFERENCES "public"."membresia"("tenant_id","usuario_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "propuesta_lectura_idx" ON "propuesta" USING btree ("cliente_id","periodo","libro","creada_en");--> statement-breakpoint

-- RLS ENABLE + FORCE y aislamiento por estudio (D5).
ALTER TABLE public.propuesta OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.propuesta ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.propuesta FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.propuesta;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.propuesta FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
REVOKE ALL ON public.propuesta FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app;--> statement-breakpoint
GRANT SELECT, INSERT ON public.propuesta TO contapp_backend, contapp_worker;
