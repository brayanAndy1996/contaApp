ALTER TABLE "cliente" ADD COLUMN "estado_contribuyente" text;--> statement-breakpoint
ALTER TABLE "cliente" ADD COLUMN "condicion_contribuyente" text;--> statement-breakpoint
ALTER TABLE "cliente" ADD COLUMN "regimen" text;--> statement-breakpoint
ALTER TABLE "cliente" ADD COLUMN "zona" text DEFAULT 'general' NOT NULL;--> statement-breakpoint
ALTER TABLE "cliente" ADD COLUMN "ventas_exoneradas" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "cliente" ADD COLUMN "ventas_mixtas" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "cliente" ADD COLUMN "moneda_habitual" text DEFAULT 'PEN' NOT NULL;--> statement-breakpoint
ALTER TABLE "cliente" ADD COLUMN "archivado_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "cliente_tenant_activos_idx" ON "cliente" USING btree ("tenant_id") WHERE "cliente"."archivado_at" is null;--> statement-breakpoint
ALTER TABLE "cliente" ADD CONSTRAINT "cliente_razon_social_largo" CHECK (char_length("cliente"."razon_social") between 1 and 200);--> statement-breakpoint
ALTER TABLE "cliente" ADD CONSTRAINT "cliente_estado_contribuyente_largo" CHECK ("cliente"."estado_contribuyente" is null or char_length("cliente"."estado_contribuyente") between 1 and 50);--> statement-breakpoint
ALTER TABLE "cliente" ADD CONSTRAINT "cliente_condicion_contribuyente_largo" CHECK ("cliente"."condicion_contribuyente" is null or char_length("cliente"."condicion_contribuyente") between 1 and 50);--> statement-breakpoint
ALTER TABLE "cliente" ADD CONSTRAINT "cliente_regimen_valido" CHECK ("cliente"."regimen" is null or "cliente"."regimen" in ('rg','rmt','rer','nrus'));--> statement-breakpoint
ALTER TABLE "cliente" ADD CONSTRAINT "cliente_zona_valida" CHECK ("cliente"."zona" in ('general','amazonia'));--> statement-breakpoint
ALTER TABLE "cliente" ADD CONSTRAINT "cliente_moneda_habitual_valida" CHECK ("cliente"."moneda_habitual" in ('PEN','USD'));