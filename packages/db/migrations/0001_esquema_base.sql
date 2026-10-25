CREATE TABLE "membresia" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"usuario_id" uuid NOT NULL,
	"rol" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membresia_tenant_usuario_unique" UNIQUE("tenant_id","usuario_id")
);
--> statement-breakpoint
CREATE TABLE "cliente" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"ruc" char(11) NOT NULL,
	"razon_social" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cliente_tenant_ruc_unique" UNIQUE("tenant_id","ruc"),
	CONSTRAINT "cliente_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "cliente_ruc_11_digitos" CHECK ("cliente"."ruc" ~ '^[0-9]{11}$')
);
--> statement-breakpoint
CREATE TABLE "tenant" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"nombre" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usuario" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"email" text NOT NULL,
	"nombre" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usuario_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "membresia" ADD CONSTRAINT "membresia_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membresia" ADD CONSTRAINT "membresia_usuario_id_usuario_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuario"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cliente" ADD CONSTRAINT "cliente_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;