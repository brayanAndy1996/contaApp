CREATE TABLE "config_sistema" (
	"cola" text PRIMARY KEY NOT NULL,
	"concurrencia_global" smallint NOT NULL,
	"concurrencia_tenant" smallint NOT NULL,
	"espera_ruc_ms" integer NOT NULL,
	"reintentos" smallint NOT NULL,
	"backoff_base_ms" integer NOT NULL,
	"max_pendientes_tenant" integer NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "config_sistema_cola_valida" CHECK ("config_sistema"."cola" IN ('sire', 'sol', 'xml', 'archivos', 'programados', 'notificaciones')),
	CONSTRAINT "config_sistema_concurrencia_global" CHECK ("config_sistema"."concurrencia_global" BETWEEN 1 AND 64),
	CONSTRAINT "config_sistema_concurrencia_tenant" CHECK ("config_sistema"."concurrencia_tenant" >= 1 AND "config_sistema"."concurrencia_tenant" <= greatest(1, "config_sistema"."concurrencia_global" / 2)),
	CONSTRAINT "config_sistema_espera_ruc" CHECK ("config_sistema"."espera_ruc_ms" BETWEEN 0 AND 600000),
	CONSTRAINT "config_sistema_reintentos" CHECK ("config_sistema"."reintentos" BETWEEN 0 AND 10),
	CONSTRAINT "config_sistema_backoff_base" CHECK ("config_sistema"."backoff_base_ms" BETWEEN 100 AND 600000),
	CONSTRAINT "config_sistema_max_pendientes" CHECK ("config_sistema"."max_pendientes_tenant" BETWEEN 1 AND 100000)
);
--> statement-breakpoint
CREATE TABLE "job_registro" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"cliente_id" uuid NOT NULL,
	"ruc" char(11) NOT NULL,
	"tipo" text NOT NULL,
	"cola" text NOT NULL,
	"canal" text NOT NULL,
	"prioridad" text NOT NULL,
	"estado" text DEFAULT 'en_cola' NOT NULL,
	"parametros" jsonb NOT NULL,
	"clave_dedupe" "bytea" NOT NULL,
	"creado_por" uuid,
	"intentos" smallint DEFAULT 0 NOT NULL,
	"max_intentos" smallint NOT NULL,
	"motivo" text,
	"resultado" jsonb,
	"disponible_desde" timestamp with time zone DEFAULT now() NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"iniciado_en" timestamp with time zone,
	"terminado_en" timestamp with time zone,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_registro_tipo_formato" CHECK ("job_registro"."tipo" ~ '^[a-z]+(\.[a-z_]+)+$'),
	CONSTRAINT "job_registro_cola_valida" CHECK ("job_registro"."cola" IN ('sire', 'sol', 'xml', 'archivos', 'programados', 'notificaciones')),
	CONSTRAINT "job_registro_canal_valido" CHECK ("job_registro"."canal" IN ('sire', 'sol', 'ninguno')),
	CONSTRAINT "job_registro_prioridad_valida" CHECK ("job_registro"."prioridad" IN ('interactivo', 'programado')),
	CONSTRAINT "job_registro_estado_valido" CHECK ("job_registro"."estado" IN ('en_cola', 'ejecutando', 'completado', 'error', 'cancelado')),
	CONSTRAINT "job_registro_motivo_valido" CHECK ("job_registro"."motivo" IS NULL OR "job_registro"."motivo" IN ('sunat_no_responde', 'credencial_invalida', 'datos_invalidos', 'portal_cambio', 'interrumpido', 'acceso_retirado', 'cancelado_usuario', 'error_interno')),
	CONSTRAINT "job_registro_ruc_11_digitos" CHECK ("job_registro"."ruc" ~ '^[0-9]{11}$'),
	CONSTRAINT "job_registro_parametros_tamano" CHECK (octet_length("job_registro"."parametros"::text) <= 4096),
	CONSTRAINT "job_registro_resultado_tamano" CHECK ("job_registro"."resultado" IS NULL OR octet_length("job_registro"."resultado"::text) <= 4096),
	CONSTRAINT "job_registro_clave_dedupe_32" CHECK (octet_length("job_registro"."clave_dedupe") = 32),
	CONSTRAINT "job_registro_intentos_no_negativos" CHECK ("job_registro"."intentos" >= 0),
	CONSTRAINT "job_registro_max_intentos_positivo" CHECK ("job_registro"."max_intentos" >= 1)
);
--> statement-breakpoint
ALTER TABLE "credencial" ADD COLUMN "estado" text DEFAULT 'configurada' NOT NULL;--> statement-breakpoint
ALTER TABLE "credencial" ADD COLUMN "estado_motivo" text;--> statement-breakpoint
ALTER TABLE "credencial" ADD COLUMN "estado_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_registro" ADD CONSTRAINT "job_registro_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_registro" ADD CONSTRAINT "job_registro_cliente_fk" FOREIGN KEY ("tenant_id","cliente_id") REFERENCES "public"."cliente"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_registro" ADD CONSTRAINT "job_registro_creado_por_fk" FOREIGN KEY ("tenant_id","creado_por") REFERENCES "public"."membresia"("tenant_id","usuario_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_registro_dedupe_vivo" ON "job_registro" USING btree ("tenant_id","clave_dedupe") WHERE "job_registro"."estado" IN ('en_cola', 'ejecutando');--> statement-breakpoint
CREATE INDEX "job_registro_despacho_idx" ON "job_registro" USING btree ("tenant_id","cola","estado","prioridad","creado_en");--> statement-breakpoint
CREATE INDEX "job_registro_cliente_idx" ON "job_registro" USING btree ("tenant_id","cliente_id","creado_en" DESC NULLS FIRST);