-- 0069_gnd_tablas (spec 027, D-2 a D-4, D-6; R-4, R-6, R-11 a R-14; CA-4, CA-7, CA-14, CA-16). Tablas de gastos no deducibles. DDL de
-- drizzle-kit (tablas, FK y CHECK) reescrito para ser REPETIBLE (IF NOT EXISTS, DROP ... IF EXISTS antes de cada ADD CONSTRAINT), y luego
-- dueño, RLS, grants, el trigger de solo inserción del historial global y la semilla (ON CONFLICT DO NOTHING). Patrón de 0065.
--   Plataforma (sin tenant_id ni RLS, como `plan`; los protegen los grants):
--     gnd_palabra_global    diccionario global: palabra única ^[a-z0-9]{3,40}$, una de las 6 categorías, <= 5 excepciones de 1 a 3
--                           palabras normalizadas, activa, version >= 1. La escriben solo las funciones `auth.gnd_global_*` (0070), de
--                           dueño contapp_auth: SELECT, INSERT y UPDATE para contapp_auth; nunca DELETE ni TRUNCATE.
--     gnd_global_historial  una fila por alta o edición del super-admin (accion agregada | editada, antes y despues jsonb, actor);
--                           solo inserción (trigger BEFORE UPDATE OR DELETE -> 42501 salvo superusuario); contapp_auth SELECT e INSERT.
--     Backend y worker: SELECT de las dos.
--   Estudio (tenant_id con app.tenant_id por defecto, RLS ENABLE + FORCE, tenant_isolation FOR ALL; backend y worker solo SELECT; nadie
--   escribe directo: escriben las funciones acotadas de 0070, SECURITY DEFINER de contapp_migrator):
--     gnd_palabra_estudio      propias del estudio (manual | aprendida; aprendida exige la compra de origen, FK compuesta a compra);
--                              única (tenant_id, palabra); creado_por -> usuario.
--     gnd_global_desactivada   globales desactivadas por el estudio; PK (tenant_id, palabra_global_id).
--     gnd_config               umbral 1..20 y su versión (sin fila: 3 y versión 0).
--     gnd_cliente_categorias   permitidas y quitadas por cliente (subconjuntos de las 6 y disjuntas); FK (tenant_id, cliente_id).
--     gnd_ciiu                 caché de CIIU por (estudio, RUC): ruc char(11) de 11 dígitos, ciiu char(4) de 4 dígitos o NULL («sin dato»).
--   auditoria_accion_valida suma las 8 acciones gnd.* (017, D-4).

-- ---- Tablas --------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "gnd_ciiu" (
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"ruc" char(11) NOT NULL,
	"ciiu" char(4),
	"consultado_en" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "gnd_ciiu_pk" PRIMARY KEY("tenant_id","ruc"),
	CONSTRAINT "gnd_ciiu_ruc_formato" CHECK ("gnd_ciiu"."ruc" ~ '^[0-9]{11}$'),
	CONSTRAINT "gnd_ciiu_ciiu_formato" CHECK ("gnd_ciiu"."ciiu" IS NULL OR "gnd_ciiu"."ciiu" ~ '^[0-9]{4}$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gnd_cliente_categorias" (
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"cliente_id" uuid NOT NULL,
	"permitidas" text[] DEFAULT '{}'::text[] NOT NULL,
	"quitadas" text[] DEFAULT '{}'::text[] NOT NULL,
	"version" integer NOT NULL,
	CONSTRAINT "gnd_cliente_categorias_pk" PRIMARY KEY("tenant_id","cliente_id"),
	CONSTRAINT "gnd_cliente_categorias_listas_validas" CHECK ("gnd_cliente_categorias"."permitidas" <@ ARRAY['calzado-ropa', 'juguetes', 'entretenimiento', 'alimentos-personales', 'cuidado-personal', 'utiles-escolares']::text[] AND "gnd_cliente_categorias"."quitadas" <@ ARRAY['calzado-ropa', 'juguetes', 'entretenimiento', 'alimentos-personales', 'cuidado-personal', 'utiles-escolares']::text[] AND NOT ("gnd_cliente_categorias"."permitidas" && "gnd_cliente_categorias"."quitadas")),
	CONSTRAINT "gnd_cliente_categorias_version_positiva" CHECK ("gnd_cliente_categorias"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gnd_config" (
	"tenant_id" uuid PRIMARY KEY DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"umbral" smallint NOT NULL,
	"version" integer NOT NULL,
	CONSTRAINT "gnd_config_umbral_rango" CHECK ("gnd_config"."umbral" BETWEEN 1 AND 20),
	CONSTRAINT "gnd_config_version_positiva" CHECK ("gnd_config"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gnd_global_desactivada" (
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"palabra_global_id" uuid NOT NULL,
	"usuario_id" uuid NOT NULL,
	"desactivada_en" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "gnd_global_desactivada_pk" PRIMARY KEY("tenant_id","palabra_global_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gnd_global_historial" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"palabra_global_id" uuid NOT NULL,
	"accion" text NOT NULL,
	"antes" jsonb,
	"despues" jsonb,
	"usuario_id" uuid NOT NULL,
	"ocurrida_en" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "gnd_global_historial_accion_valida" CHECK ("gnd_global_historial"."accion" IN ('agregada', 'editada'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gnd_palabra_estudio" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"palabra" text NOT NULL,
	"categoria" text NOT NULL,
	"excepciones" text[] DEFAULT '{}'::text[] NOT NULL,
	"origen" text NOT NULL,
	"activa" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"creado_por" uuid NOT NULL,
	"compra_origen_id" uuid,
	"creada_en" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"actualizada_en" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "gnd_palabra_estudio_palabra_unique" UNIQUE("tenant_id","palabra"),
	CONSTRAINT "gnd_palabra_estudio_palabra_valida" CHECK ("gnd_palabra_estudio"."palabra" ~ '^[a-z0-9]{3,40}$'),
	CONSTRAINT "gnd_palabra_estudio_categoria_valida" CHECK ("gnd_palabra_estudio"."categoria" IN ('calzado-ropa', 'juguetes', 'entretenimiento', 'alimentos-personales', 'cuidado-personal', 'utiles-escolares')),
	CONSTRAINT "gnd_palabra_estudio_excepciones_validas" CHECK (cardinality("gnd_palabra_estudio"."excepciones") <= 5 AND (cardinality("gnd_palabra_estudio"."excepciones") = 0 OR (array_ndims("gnd_palabra_estudio"."excepciones") = 1 AND array_to_string("gnd_palabra_estudio"."excepciones", '|', '') ~ '^[a-z0-9]+( [a-z0-9]+){0,2}(\|[a-z0-9]+( [a-z0-9]+){0,2})*$'))),
	CONSTRAINT "gnd_palabra_estudio_origen_valido" CHECK ("gnd_palabra_estudio"."origen" IN ('manual', 'aprendida')),
	CONSTRAINT "gnd_palabra_estudio_version_positiva" CHECK ("gnd_palabra_estudio"."version" >= 1),
	CONSTRAINT "gnd_palabra_estudio_compra_segun_origen" CHECK ("gnd_palabra_estudio"."origen" <> 'aprendida' OR "gnd_palabra_estudio"."compra_origen_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gnd_palabra_global" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"palabra" text NOT NULL,
	"categoria" text NOT NULL,
	"excepciones" text[] DEFAULT '{}'::text[] NOT NULL,
	"activa" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"actualizada_en" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "gnd_palabra_global_palabra_unique" UNIQUE("palabra"),
	CONSTRAINT "gnd_palabra_global_palabra_valida" CHECK ("gnd_palabra_global"."palabra" ~ '^[a-z0-9]{3,40}$'),
	CONSTRAINT "gnd_palabra_global_categoria_valida" CHECK ("gnd_palabra_global"."categoria" IN ('calzado-ropa', 'juguetes', 'entretenimiento', 'alimentos-personales', 'cuidado-personal', 'utiles-escolares')),
	CONSTRAINT "gnd_palabra_global_excepciones_validas" CHECK (cardinality("gnd_palabra_global"."excepciones") <= 5 AND (cardinality("gnd_palabra_global"."excepciones") = 0 OR (array_ndims("gnd_palabra_global"."excepciones") = 1 AND array_to_string("gnd_palabra_global"."excepciones", '|', '') ~ '^[a-z0-9]+( [a-z0-9]+){0,2}(\|[a-z0-9]+( [a-z0-9]+){0,2})*$'))),
	CONSTRAINT "gnd_palabra_global_version_positiva" CHECK ("gnd_palabra_global"."version" >= 1)
);
--> statement-breakpoint

-- ---- FK --------------------------------------------------------------------------------------------------------------------
ALTER TABLE "gnd_ciiu" DROP CONSTRAINT IF EXISTS "gnd_ciiu_tenant_id_tenant_id_fk";--> statement-breakpoint
ALTER TABLE "gnd_ciiu" ADD CONSTRAINT "gnd_ciiu_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gnd_cliente_categorias" DROP CONSTRAINT IF EXISTS "gnd_cliente_categorias_tenant_id_tenant_id_fk";--> statement-breakpoint
ALTER TABLE "gnd_cliente_categorias" ADD CONSTRAINT "gnd_cliente_categorias_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gnd_cliente_categorias" DROP CONSTRAINT IF EXISTS "gnd_cliente_categorias_cliente_fk";--> statement-breakpoint
ALTER TABLE "gnd_cliente_categorias" ADD CONSTRAINT "gnd_cliente_categorias_cliente_fk" FOREIGN KEY ("tenant_id","cliente_id") REFERENCES "public"."cliente"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gnd_config" DROP CONSTRAINT IF EXISTS "gnd_config_tenant_id_tenant_id_fk";--> statement-breakpoint
ALTER TABLE "gnd_config" ADD CONSTRAINT "gnd_config_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gnd_global_desactivada" DROP CONSTRAINT IF EXISTS "gnd_global_desactivada_tenant_id_tenant_id_fk";--> statement-breakpoint
ALTER TABLE "gnd_global_desactivada" ADD CONSTRAINT "gnd_global_desactivada_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gnd_global_desactivada" DROP CONSTRAINT IF EXISTS "gnd_global_desactivada_global_fk";--> statement-breakpoint
ALTER TABLE "gnd_global_desactivada" ADD CONSTRAINT "gnd_global_desactivada_global_fk" FOREIGN KEY ("palabra_global_id") REFERENCES "public"."gnd_palabra_global"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gnd_global_desactivada" DROP CONSTRAINT IF EXISTS "gnd_global_desactivada_usuario_id_usuario_id_fk";--> statement-breakpoint
ALTER TABLE "gnd_global_desactivada" ADD CONSTRAINT "gnd_global_desactivada_usuario_id_usuario_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuario"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gnd_global_historial" DROP CONSTRAINT IF EXISTS "gnd_global_historial_global_fk";--> statement-breakpoint
ALTER TABLE "gnd_global_historial" ADD CONSTRAINT "gnd_global_historial_global_fk" FOREIGN KEY ("palabra_global_id") REFERENCES "public"."gnd_palabra_global"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gnd_global_historial" DROP CONSTRAINT IF EXISTS "gnd_global_historial_usuario_id_usuario_id_fk";--> statement-breakpoint
ALTER TABLE "gnd_global_historial" ADD CONSTRAINT "gnd_global_historial_usuario_id_usuario_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuario"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gnd_palabra_estudio" DROP CONSTRAINT IF EXISTS "gnd_palabra_estudio_tenant_id_tenant_id_fk";--> statement-breakpoint
ALTER TABLE "gnd_palabra_estudio" ADD CONSTRAINT "gnd_palabra_estudio_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gnd_palabra_estudio" DROP CONSTRAINT IF EXISTS "gnd_palabra_estudio_creado_por_usuario_id_fk";--> statement-breakpoint
ALTER TABLE "gnd_palabra_estudio" ADD CONSTRAINT "gnd_palabra_estudio_creado_por_usuario_id_fk" FOREIGN KEY ("creado_por") REFERENCES "public"."usuario"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gnd_palabra_estudio" DROP CONSTRAINT IF EXISTS "gnd_palabra_estudio_compra_fk";--> statement-breakpoint
ALTER TABLE "gnd_palabra_estudio" ADD CONSTRAINT "gnd_palabra_estudio_compra_fk" FOREIGN KEY ("tenant_id","compra_origen_id") REFERENCES "public"."compra"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ---- CHECK de acciones de auditoría ----------------------------------------------------------------------------------------
ALTER TABLE "auditoria" DROP CONSTRAINT IF EXISTS "auditoria_accion_valida";--> statement-breakpoint
ALTER TABLE "auditoria" ADD CONSTRAINT "auditoria_accion_valida" CHECK ("auditoria"."accion" IN ('sesion.ingreso', 'invitacion.creada', 'invitacion.revocada', 'invitacion.modificada', 'miembro.alta', 'miembro.rol_cambiado', 'miembro.desactivado', 'miembro.reactivado', 'miembro.eliminado', 'asignacion.agregada', 'asignacion.quitada', 'asignacion.tipo_cambiado', 'cliente.creado', 'cliente.editado', 'cliente.archivado', 'cliente.reactivado', 'cliente.eliminado', 'credencial.guardada', 'credencial.verificada', 'credencial.invalidada', 'credencial.descifrada', 'propuesta.cargada', 'compra.operacion', 'venta.agregada', 'venta.excluida', 'venta.restaurada', 'venta.salto_justificado', 'xml.subido', 'periodo.estado_cambiado', 'archivo.generado', 'sunat.envio', 'regla.creada', 'regla.editada', 'regla.activada', 'regla.desactivada', 'regla.eliminada', 'estudio.regla_motor', 'estudio.aporte_catalogo', 'compra.historial', 'buzon.captura_solicitada', 'buzon.apertura_solicitada', 'buzon.contenido_visto', 'buzon.adjunto_descargado', 'buzon.contenido_obtenido', 'buzon.atendido', 'buzon.atencion_deshecha', 'regla.historial_importado', 'regla.candidata_descartada', 'prorrata.declaraciones_obtenidas', 'prorrata.mes_manual_guardado', 'prorrata.mes_manual_eliminado', 'prorrata.usada_guardada', 'gnd.palabra_agregada', 'gnd.palabra_desactivada', 'gnd.palabra_reactivada', 'gnd.palabra_aprendida', 'gnd.global_desactivada', 'gnd.global_reactivada', 'gnd.umbral_cambiado', 'gnd.categorias_cliente'));--> statement-breakpoint

-- ---- Dueño, RLS y grants -----------------------------------------------------------------------------------------------
ALTER TABLE public.gnd_palabra_global OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON public.gnd_palabra_global
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT SELECT ON public.gnd_palabra_global TO contapp_backend, contapp_worker;--> statement-breakpoint
ALTER TABLE public.gnd_global_historial OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON public.gnd_global_historial
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT SELECT ON public.gnd_global_historial TO contapp_backend, contapp_worker;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.gnd_palabra_global TO contapp_auth;--> statement-breakpoint
GRANT SELECT, INSERT ON public.gnd_global_historial TO contapp_auth;--> statement-breakpoint

ALTER TABLE public.gnd_palabra_estudio OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.gnd_palabra_estudio ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.gnd_palabra_estudio FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.gnd_palabra_estudio;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.gnd_palabra_estudio FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
REVOKE ALL ON public.gnd_palabra_estudio
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT SELECT ON public.gnd_palabra_estudio TO contapp_backend, contapp_worker;--> statement-breakpoint

ALTER TABLE public.gnd_global_desactivada OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.gnd_global_desactivada ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.gnd_global_desactivada FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.gnd_global_desactivada;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.gnd_global_desactivada FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
REVOKE ALL ON public.gnd_global_desactivada
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT SELECT ON public.gnd_global_desactivada TO contapp_backend, contapp_worker;--> statement-breakpoint

ALTER TABLE public.gnd_config OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.gnd_config ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.gnd_config FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.gnd_config;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.gnd_config FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
REVOKE ALL ON public.gnd_config
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT SELECT ON public.gnd_config TO contapp_backend, contapp_worker;--> statement-breakpoint

ALTER TABLE public.gnd_cliente_categorias OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.gnd_cliente_categorias ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.gnd_cliente_categorias FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.gnd_cliente_categorias;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.gnd_cliente_categorias FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
REVOKE ALL ON public.gnd_cliente_categorias
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT SELECT ON public.gnd_cliente_categorias TO contapp_backend, contapp_worker;--> statement-breakpoint

ALTER TABLE public.gnd_ciiu OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.gnd_ciiu ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.gnd_ciiu FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.gnd_ciiu;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.gnd_ciiu FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
REVOKE ALL ON public.gnd_ciiu
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT SELECT ON public.gnd_ciiu TO contapp_backend, contapp_worker;--> statement-breakpoint

-- ---- Historial global: solo inserción (vale también para el dueño; solo un superusuario actualiza o borra: mantenimiento) ------
-- SECURITY INVOKER: current_user es quien escribe. `session_replication_role = replica` (limpieza de las pruebas) no lo dispara.
CREATE OR REPLACE FUNCTION public.gnd_solo_insercion() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND r.rolsuper) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'gnd: el historial no se modifica ni se borra';
END
$$;--> statement-breakpoint
ALTER FUNCTION public.gnd_solo_insercion() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gnd_solo_insercion()
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
DROP TRIGGER IF EXISTS gnd_global_historial_solo_insercion ON public.gnd_global_historial;--> statement-breakpoint
CREATE TRIGGER gnd_global_historial_solo_insercion BEFORE UPDATE OR DELETE ON public.gnd_global_historial
  FOR EACH ROW EXECUTE FUNCTION public.gnd_solo_insercion();--> statement-breakpoint

-- ---- Semilla del diccionario global (plan 027, «Semilla»; 72 palabras normalizadas). No pisa lo que el super-admin ya cambió. ----
INSERT INTO public.gnd_palabra_global (palabra, categoria, excepciones) VALUES
  ('zapatilla', 'calzado-ropa', ARRAY['seguridad', 'punta de acero']::text[]),
  ('zapato', 'calzado-ropa', ARRAY['seguridad', 'punta de acero']::text[]),
  ('sandalia', 'calzado-ropa', '{}'::text[]),
  ('bota', 'calzado-ropa', ARRAY['seguridad', 'jebe', 'punta de acero']::text[]),
  ('polo', 'calzado-ropa', ARRAY['a tierra']::text[]),
  ('polera', 'calzado-ropa', '{}'::text[]),
  ('casaca', 'calzado-ropa', ARRAY['seguridad', 'reflectiva']::text[]),
  ('blusa', 'calzado-ropa', '{}'::text[]),
  ('vestido', 'calzado-ropa', '{}'::text[]),
  ('falda', 'calzado-ropa', '{}'::text[]),
  ('pantalon', 'calzado-ropa', '{}'::text[]),
  ('jean', 'calzado-ropa', '{}'::text[]),
  ('camisa', 'calzado-ropa', '{}'::text[]),
  ('chompa', 'calzado-ropa', '{}'::text[]),
  ('pijama', 'calzado-ropa', '{}'::text[]),
  ('juguete', 'juguetes', '{}'::text[]),
  ('peluche', 'juguetes', '{}'::text[]),
  ('muneca', 'juguetes', '{}'::text[]),
  ('lego', 'juguetes', '{}'::text[]),
  ('rompecabeza', 'juguetes', '{}'::text[]),
  ('pelota', 'juguetes', '{}'::text[]),
  ('triciclo', 'juguetes', '{}'::text[]),
  ('patineta', 'juguetes', '{}'::text[]),
  ('trompo', 'juguetes', '{}'::text[]),
  ('sonajero', 'juguetes', '{}'::text[]),
  ('videojuego', 'entretenimiento', '{}'::text[]),
  ('cine', 'entretenimiento', '{}'::text[]),
  ('concierto', 'entretenimiento', '{}'::text[]),
  ('playstation', 'entretenimiento', '{}'::text[]),
  ('nintendo', 'entretenimiento', '{}'::text[]),
  ('xbox', 'entretenimiento', '{}'::text[]),
  ('netflix', 'entretenimiento', '{}'::text[]),
  ('spotify', 'entretenimiento', '{}'::text[]),
  ('karaoke', 'entretenimiento', '{}'::text[]),
  ('teatro', 'entretenimiento', '{}'::text[]),
  ('boliche', 'entretenimiento', '{}'::text[]),
  ('golosina', 'alimentos-personales', '{}'::text[]),
  ('chocolate', 'alimentos-personales', '{}'::text[]),
  ('helado', 'alimentos-personales', '{}'::text[]),
  ('cerveza', 'alimentos-personales', '{}'::text[]),
  ('vino', 'alimentos-personales', '{}'::text[]),
  ('whisky', 'alimentos-personales', '{}'::text[]),
  ('pisco', 'alimentos-personales', '{}'::text[]),
  ('ron', 'alimentos-personales', '{}'::text[]),
  ('vodka', 'alimentos-personales', '{}'::text[]),
  ('licor', 'alimentos-personales', '{}'::text[]),
  ('cigarro', 'alimentos-personales', '{}'::text[]),
  ('cigarrillo', 'alimentos-personales', '{}'::text[]),
  ('snack', 'alimentos-personales', '{}'::text[]),
  ('caramelo', 'alimentos-personales', '{}'::text[]),
  ('perfume', 'cuidado-personal', '{}'::text[]),
  ('colonia', 'cuidado-personal', '{}'::text[]),
  ('maquillaje', 'cuidado-personal', '{}'::text[]),
  ('labial', 'cuidado-personal', '{}'::text[]),
  ('shampoo', 'cuidado-personal', '{}'::text[]),
  ('champu', 'cuidado-personal', '{}'::text[]),
  ('acondicionador', 'cuidado-personal', '{}'::text[]),
  ('desodorante', 'cuidado-personal', '{}'::text[]),
  ('rimel', 'cuidado-personal', '{}'::text[]),
  ('afeitadora', 'cuidado-personal', '{}'::text[]),
  ('depiladora', 'cuidado-personal', '{}'::text[]),
  ('cosmetico', 'cuidado-personal', '{}'::text[]),
  ('lonchera', 'utiles-escolares', '{}'::text[]),
  ('mochila', 'utiles-escolares', ARRAY['fumigadora']::text[]),
  ('plastilina', 'utiles-escolares', '{}'::text[]),
  ('crayola', 'utiles-escolares', '{}'::text[]),
  ('crayon', 'utiles-escolares', '{}'::text[]),
  ('tempera', 'utiles-escolares', '{}'::text[]),
  ('acuarela', 'utiles-escolares', '{}'::text[]),
  ('escolar', 'utiles-escolares', '{}'::text[]),
  ('cartuchera', 'utiles-escolares', '{}'::text[]),
  ('papelote', 'utiles-escolares', '{}'::text[])
ON CONFLICT (palabra) DO NOTHING;
