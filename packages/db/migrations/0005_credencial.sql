CREATE TABLE "auditoria_descifrado" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"credencial_id" uuid NOT NULL,
	"cliente_id" uuid,
	"tipo" text,
	"motivo" text NOT NULL,
	"resultado" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auditoria_descifrado_tipo_valido" CHECK ("auditoria_descifrado"."tipo" IS NULL OR "auditoria_descifrado"."tipo" IN ('sol', 'sire_api')),
	CONSTRAINT "auditoria_descifrado_motivo_formato" CHECK ("auditoria_descifrado"."motivo" ~ '^[A-Za-z0-9._:-]{1,120}$'),
	CONSTRAINT "auditoria_descifrado_resultado_valido" CHECK ("auditoria_descifrado"."resultado" IN ('ok', 'no_encontrada', 'integridad', 'formato', 'llave'))
);
--> statement-breakpoint
CREATE TABLE "credencial" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"cliente_id" uuid NOT NULL,
	"tipo" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"tag" "bytea" NOT NULL,
	"dek_envuelta" "bytea" NOT NULL,
	"kek_id" text NOT NULL,
	"version" smallint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credencial_tenant_cliente_tipo_unique" UNIQUE("tenant_id","cliente_id","tipo"),
	CONSTRAINT "credencial_tipo_valido" CHECK ("credencial"."tipo" IN ('sol', 'sire_api')),
	CONSTRAINT "credencial_ciphertext_largo" CHECK (octet_length("credencial"."ciphertext") BETWEEN 1 AND 1100),
	CONSTRAINT "credencial_nonce_12" CHECK (octet_length("credencial"."nonce") = 12),
	CONSTRAINT "credencial_tag_16" CHECK (octet_length("credencial"."tag") = 16),
	CONSTRAINT "credencial_dek_envuelta_largo" CHECK (octet_length("credencial"."dek_envuelta") BETWEEN 1 AND 1024),
	CONSTRAINT "credencial_kek_id_formato" CHECK ("credencial"."kek_id" ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
	CONSTRAINT "credencial_version_1" CHECK ("credencial"."version" = 1)
);
--> statement-breakpoint
ALTER TABLE "auditoria_descifrado" ADD CONSTRAINT "auditoria_descifrado_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credencial" ADD CONSTRAINT "credencial_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;