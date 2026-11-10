-- 0036_compra_evaluacion (spec 016, D-5, D-10, P-2). Evaluación numerada: re-evaluar la misma versión (llega o cambia el XML) ya no
-- choca con la única de `compra_hallazgo`, sin crear versión ni hacer UPDATE/DELETE.
--   compra_evaluacion  SELECT/INSERT a backend y worker; ni UPDATE ni DELETE. Única (tenant, compra, version_n, n); FK compuestas a
--                      compra_version y a documento_xml (el XML vigente con el que se evaluó; nulo = sin XML).
--   compra             UPDATE (version_vigente) también al worker: `reevaluarCompra` (worker, `xml.obtener`) bloquea la fila con
--                      FOR UPDATE como toda escritura de 014, y PostgreSQL exige UPDATE de alguna columna para bloquear (mismo caso
--                      que compra_periodo en 0033). El trigger de 0034 sigue acotando el puntero (solo avanza, a una versión que
--                      existe); el worker no gana descartada_en ni ninguna columna de identidad.
--   compra_hallazgo    + evaluacion_n NOT NULL: se agrega con DEFAULT 1 para las filas existentes y se quita el default. La única
--                      pasa a (tenant, compra, version_n, evaluacion_n, regla) y gana la FK compuesta a compra_evaluacion (la FK
--                      a compra se conserva).
-- Backfill (corre con el rol de migración, que no pasa por RLS): una evaluación n = 1 sin XML por cada compra_version existente,
-- ANTES de la FK de los hallazgos. Los hallazgos existentes quedan en la evaluación 1 de su versión.
CREATE TABLE "compra_evaluacion" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"compra_id" uuid NOT NULL,
	"version_n" integer NOT NULL,
	"n" integer NOT NULL,
	"documento_xml_id" uuid,
	"creada_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compra_evaluacion_version_n_unique" UNIQUE("tenant_id","compra_id","version_n","n"),
	CONSTRAINT "compra_evaluacion_n_positivo" CHECK ("compra_evaluacion"."n" >= 1)
);
--> statement-breakpoint
ALTER TABLE "compra_evaluacion" ADD CONSTRAINT "compra_evaluacion_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compra_evaluacion" ADD CONSTRAINT "compra_evaluacion_version_fk" FOREIGN KEY ("tenant_id","compra_id","version_n") REFERENCES "public"."compra_version"("tenant_id","compra_id","n") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compra_evaluacion" ADD CONSTRAINT "compra_evaluacion_documento_xml_fk" FOREIGN KEY ("tenant_id","documento_xml_id") REFERENCES "public"."documento_xml"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- Backfill: la evaluación 1 (sin XML) de cada versión existente, antes de la FK de los hallazgos.
INSERT INTO "compra_evaluacion" ("tenant_id", "compra_id", "version_n", "n", "documento_xml_id")
  SELECT v."tenant_id", v."compra_id", v."n", 1, NULL FROM "compra_version" v
  ON CONFLICT ("tenant_id", "compra_id", "version_n", "n") DO NOTHING;--> statement-breakpoint

-- compra_hallazgo: la columna nueva (las filas existentes quedan en la evaluación 1), sin default después.
ALTER TABLE "compra_hallazgo" ADD COLUMN "evaluacion_n" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "compra_hallazgo" ALTER COLUMN "evaluacion_n" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "compra_hallazgo" DROP CONSTRAINT "compra_hallazgo_compra_version_regla_unique";--> statement-breakpoint
ALTER TABLE "compra_hallazgo" ADD CONSTRAINT "compra_hallazgo_evaluacion_regla_unique" UNIQUE("tenant_id","compra_id","version_n","evaluacion_n","regla");--> statement-breakpoint
ALTER TABLE "compra_hallazgo" ADD CONSTRAINT "compra_hallazgo_evaluacion_positiva" CHECK ("compra_hallazgo"."evaluacion_n" >= 1);--> statement-breakpoint
ALTER TABLE "compra_hallazgo" ADD CONSTRAINT "compra_hallazgo_evaluacion_fk" FOREIGN KEY ("tenant_id","compra_id","version_n","evaluacion_n") REFERENCES "public"."compra_evaluacion"("tenant_id","compra_id","version_n","n") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

-- RLS, dueño y grants.
ALTER TABLE public.compra_evaluacion OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.compra_evaluacion ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.compra_evaluacion FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.compra_evaluacion;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.compra_evaluacion FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
REVOKE ALL ON public.compra_evaluacion FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app;--> statement-breakpoint
GRANT SELECT, INSERT ON public.compra_evaluacion TO contapp_backend, contapp_worker;--> statement-breakpoint

GRANT UPDATE (version_vigente) ON public.compra TO contapp_worker;
