CREATE TABLE "asignacion" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"cliente_id" uuid NOT NULL,
	"usuario_id" uuid NOT NULL,
	"tipo" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asignacion_tenant_cliente_usuario_unique" UNIQUE("tenant_id","cliente_id","usuario_id"),
	CONSTRAINT "asignacion_tipo_valido" CHECK ("asignacion"."tipo" IN ('responsable', 'colaborador'))
);
--> statement-breakpoint
CREATE TABLE "invitacion" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"correo" text NOT NULL,
	"rol" text NOT NULL,
	"invitado_por" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"creada_en" timestamp with time zone DEFAULT now() NOT NULL,
	"vence_en" timestamp with time zone NOT NULL,
	"aceptada_en" timestamp with time zone,
	"aceptada_por" uuid,
	"revocada_en" timestamp with time zone,
	CONSTRAINT "invitacion_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "invitacion_rol_valido" CHECK ("invitacion"."rol" IN ('dueno', 'admin', 'contador', 'asistente', 'lectura')),
	CONSTRAINT "invitacion_correo_normalizado" CHECK ("invitacion"."correo" = btrim("invitacion"."correo") AND "invitacion"."correo" = lower("invitacion"."correo") AND "invitacion"."correo" IS NFC NORMALIZED AND octet_length("invitacion"."correo") = char_length("invitacion"."correo")),
	CONSTRAINT "invitacion_token_hash_32" CHECK (octet_length("invitacion"."token_hash") = 32)
);
--> statement-breakpoint
ALTER TABLE "membresia" ADD COLUMN "desactivada_en" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "asignacion" ADD CONSTRAINT "asignacion_cliente_fk" FOREIGN KEY ("tenant_id","cliente_id") REFERENCES "public"."cliente"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asignacion" ADD CONSTRAINT "asignacion_membresia_fk" FOREIGN KEY ("tenant_id","usuario_id") REFERENCES "public"."membresia"("tenant_id","usuario_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitacion" ADD CONSTRAINT "invitacion_aceptada_por_usuario_id_fk" FOREIGN KEY ("aceptada_por") REFERENCES "public"."usuario"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitacion" ADD CONSTRAINT "invitacion_invitado_por_fk" FOREIGN KEY ("tenant_id","invitado_por") REFERENCES "public"."membresia"("tenant_id","usuario_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "asignacion_responsable_unico" ON "asignacion" USING btree ("tenant_id","cliente_id") WHERE "asignacion"."tipo" = 'responsable';--> statement-breakpoint
CREATE INDEX "asignacion_tenant_usuario_idx" ON "asignacion" USING btree ("tenant_id","usuario_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invitacion_pendiente_correo_unique" ON "invitacion" USING btree ("tenant_id","correo") WHERE "invitacion"."aceptada_en" IS NULL AND "invitacion"."revocada_en" IS NULL;--> statement-breakpoint
-- Spec 005 (D1, editado antes de aplicarse): el admin más antiguo (created_at, id) de cada estudio pasa a Dueño
-- antes del CHECK de rol, para que todo estudio con miembros tenga un Dueño (seed: uA y uB).
UPDATE "membresia" m SET "rol" = 'dueno'
 WHERE m."id" IN (
   SELECT DISTINCT ON (x."tenant_id") x."id" FROM "membresia" x
    WHERE x."rol" = 'admin'
    ORDER BY x."tenant_id", x."created_at", x."id"
 );--> statement-breakpoint
ALTER TABLE "membresia" ADD CONSTRAINT "membresia_rol_valido" CHECK ("membresia"."rol" IN ('dueno', 'admin', 'contador', 'asistente', 'lectura'));
