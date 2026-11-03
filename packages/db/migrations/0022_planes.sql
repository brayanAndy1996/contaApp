CREATE TABLE "admin_plataforma" (
	"usuario_id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"codigo" text NOT NULL,
	"nombre" text NOT NULL,
	"precio_mensual" numeric(14, 2) NOT NULL,
	"precio_anual" numeric(14, 2),
	"max_rucs" integer NOT NULL,
	"max_usuarios" integer,
	"precio_ruc_extra" numeric(14, 2) DEFAULT '0' NOT NULL,
	"max_rucs_extra" integer DEFAULT 0 NOT NULL,
	"frecuencia_buzon_min" integer NOT NULL,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"activo" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_codigo_unique" UNIQUE("codigo"),
	CONSTRAINT "plan_precio_mensual_no_negativo" CHECK ("plan"."precio_mensual" >= 0),
	CONSTRAINT "plan_precio_anual_no_negativo" CHECK ("plan"."precio_anual" >= 0),
	CONSTRAINT "plan_max_rucs_positivo" CHECK ("plan"."max_rucs" >= 1),
	CONSTRAINT "plan_max_usuarios_positivo" CHECK ("plan"."max_usuarios" >= 1),
	CONSTRAINT "plan_precio_ruc_extra_no_negativo" CHECK ("plan"."precio_ruc_extra" >= 0),
	CONSTRAINT "plan_max_rucs_extra_tope" CHECK ("plan"."max_rucs_extra" >= 0 AND "plan"."max_rucs_extra" * 5 <= "plan"."max_rucs"),
	CONSTRAINT "plan_frecuencia_buzon_positiva" CHECK ("plan"."frecuencia_buzon_min" >= 1),
	CONSTRAINT "plan_features_objeto" CHECK (jsonb_typeof("plan"."features") = 'object')
);
--> statement-breakpoint
CREATE TABLE "suscripcion" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"estado" text NOT NULL,
	"prueba_vence_en" timestamp with time zone,
	"rucs_extra_contratados" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suscripcion_tenant_unique" UNIQUE("tenant_id"),
	CONSTRAINT "suscripcion_estado_valido" CHECK ("suscripcion"."estado" IN ('prueba', 'activa')),
	CONSTRAINT "suscripcion_prueba_vence" CHECK ("suscripcion"."estado" <> 'prueba' OR "suscripcion"."prueba_vence_en" IS NOT NULL),
	CONSTRAINT "suscripcion_rucs_extra_no_negativo" CHECK ("suscripcion"."rucs_extra_contratados" >= 0)
);
--> statement-breakpoint
ALTER TABLE "tenant" ADD COLUMN "ruc_estudio" text;--> statement-breakpoint
ALTER TABLE "admin_plataforma" ADD CONSTRAINT "admin_plataforma_usuario_id_usuario_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuario"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suscripcion" ADD CONSTRAINT "suscripcion_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suscripcion" ADD CONSTRAINT "suscripcion_plan_id_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant" ADD CONSTRAINT "tenant_ruc_estudio_11_digitos" CHECK ("tenant"."ruc_estudio" ~ '^[0-9]{11}$');--> statement-breakpoint
-- Spec 006 (D1, 01 §3): los 5 planes sembrados (datos que el super-admin edita después; "600+" y el precio
-- "desde" de Corporativo son textos comerciales, aquí 600 RUCs y usuarios sin límite). Repetible por `codigo`.
INSERT INTO "plan" ("codigo", "nombre", "precio_mensual", "precio_anual", "max_rucs", "max_usuarios",
                    "precio_ruc_extra", "max_rucs_extra", "frecuencia_buzon_min")
VALUES ('prueba', 'Prueba', 0, NULL, 5, 1, 0, 0, 1440),
       ('independiente', 'Independiente', 99, 990, 30, 2, 4, 6, 1440),
       ('estudio', 'Estudio', 249, 2490, 100, 5, 4, 20, 720),
       ('estudio_pro', 'Estudio Pro', 599, 5990, 300, 15, 4, 60, 240),
       ('corporativo', 'Corporativo', 1200, NULL, 600, NULL, 4, 120, 60)
ON CONFLICT ("codigo") DO NOTHING;--> statement-breakpoint
-- D2: backfill. Todo estudio existente (solo datos de desarrollo y pruebas) queda en Corporativo activa.
INSERT INTO "suscripcion" ("tenant_id", "plan_id", "estado")
SELECT t."id", p."id", 'activa' FROM "tenant" t CROSS JOIN "plan" p WHERE p."codigo" = 'corporativo'
ON CONFLICT ("tenant_id") DO NOTHING;
