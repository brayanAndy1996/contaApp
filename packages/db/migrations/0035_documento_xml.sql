-- 0035_documento_xml (spec 016, D-4, D-10). El XML de cada comprobante y su estado de obtención:
--   documento_xml            SELECT/INSERT a backend y worker; ni UPDATE ni DELETE (solo inserción: el vigente es el de mayor n, P-6).
--   documento_xml_obtencion  SELECT/INSERT y UPDATE de (estado, intentos, actualizado_en) a backend y worker; sin DELETE. Es la
--                            única tabla de 016 que se actualiza (una fila por comprobante).
-- RLS ENABLE + FORCE y tenant_isolation (D5 de 013) en las dos. Identidad normalizada como la `clave` de 014 (serie en mayúsculas,
-- número sin ceros a la izquierda); la normaliza `packages/db/src/xml`.

CREATE TABLE "documento_xml" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"cliente_id" uuid NOT NULL,
	"ruc_emisor" text NOT NULL,
	"tipo" char(2) NOT NULL,
	"serie" text NOT NULL,
	"numero" text NOT NULL,
	"n" integer NOT NULL,
	"origen" text NOT NULL,
	"ruta" text NOT NULL,
	"sha256" "bytea" NOT NULL,
	"tamano" integer NOT NULL,
	"detalle" jsonb NOT NULL,
	"subido_por" uuid,
	"creada_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documento_xml_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "documento_xml_comprobante_n_unique" UNIQUE("tenant_id","cliente_id","ruc_emisor","tipo","serie","numero","n"),
	CONSTRAINT "documento_xml_identidad_larga" CHECK (char_length("documento_xml"."ruc_emisor") BETWEEN 1 AND 20 AND char_length("documento_xml"."serie") BETWEEN 1 AND 4 AND char_length("documento_xml"."numero") BETWEEN 1 AND 20),
	CONSTRAINT "documento_xml_origen_valido" CHECK ("documento_xml"."origen" IN ('simulado', 'real', 'subido')),
	CONSTRAINT "documento_xml_subido_por_segun_origen" CHECK (("documento_xml"."origen" = 'subido') = ("documento_xml"."subido_por" IS NOT NULL)),
	CONSTRAINT "documento_xml_tamano_valido" CHECK ("documento_xml"."tamano" >= 1 AND "documento_xml"."tamano" <= 1048576),
	CONSTRAINT "documento_xml_n_positivo" CHECK ("documento_xml"."n" >= 1),
	CONSTRAINT "documento_xml_sha256_largo" CHECK (octet_length("documento_xml"."sha256") = 32),
	CONSTRAINT "documento_xml_ruta_formato" CHECK ("documento_xml"."ruta" ~ '^xml/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.xml$')
);
--> statement-breakpoint
CREATE TABLE "documento_xml_obtencion" (
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"cliente_id" uuid NOT NULL,
	"ruc_emisor" text NOT NULL,
	"tipo" char(2) NOT NULL,
	"serie" text NOT NULL,
	"numero" text NOT NULL,
	"estado" text NOT NULL,
	"intentos" integer DEFAULT 0 NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documento_xml_obtencion_pk" PRIMARY KEY("tenant_id","cliente_id","ruc_emisor","tipo","serie","numero"),
	CONSTRAINT "documento_xml_obtencion_identidad_larga" CHECK (char_length("documento_xml_obtencion"."ruc_emisor") BETWEEN 1 AND 20 AND char_length("documento_xml_obtencion"."serie") BETWEEN 1 AND 4 AND char_length("documento_xml_obtencion"."numero") BETWEEN 1 AND 20),
	CONSTRAINT "documento_xml_obtencion_estado_valido" CHECK ("documento_xml_obtencion"."estado" IN ('pendiente', 'no_encontrado', 'credencial', 'transitorio')),
	CONSTRAINT "documento_xml_obtencion_intentos_validos" CHECK ("documento_xml_obtencion"."intentos" >= 0)
);
--> statement-breakpoint
ALTER TABLE "documento_xml" ADD CONSTRAINT "documento_xml_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documento_xml" ADD CONSTRAINT "documento_xml_cliente_fk" FOREIGN KEY ("tenant_id","cliente_id") REFERENCES "public"."cliente"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documento_xml" ADD CONSTRAINT "documento_xml_subido_por_fk" FOREIGN KEY ("tenant_id","subido_por") REFERENCES "public"."membresia"("tenant_id","usuario_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documento_xml_obtencion" ADD CONSTRAINT "documento_xml_obtencion_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documento_xml_obtencion" ADD CONSTRAINT "documento_xml_obtencion_cliente_fk" FOREIGN KEY ("tenant_id","cliente_id") REFERENCES "public"."cliente"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

-- RLS, dueño y grants.
ALTER TABLE public.documento_xml OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.documento_xml ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.documento_xml FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.documento_xml;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.documento_xml FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
REVOKE ALL ON public.documento_xml FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app;--> statement-breakpoint
GRANT SELECT, INSERT ON public.documento_xml TO contapp_backend, contapp_worker;--> statement-breakpoint

ALTER TABLE public.documento_xml_obtencion OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.documento_xml_obtencion ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.documento_xml_obtencion FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.documento_xml_obtencion;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.documento_xml_obtencion FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
REVOKE ALL ON public.documento_xml_obtencion FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app;--> statement-breakpoint
GRANT SELECT, INSERT ON public.documento_xml_obtencion TO contapp_backend, contapp_worker;--> statement-breakpoint
GRANT UPDATE (estado, intentos, actualizado_en) ON public.documento_xml_obtencion TO contapp_backend, contapp_worker;
