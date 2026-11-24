-- 0073_correo_tablas (spec 028, R-2, R-4, R-7, R-11, R-12, R-14, R-15, D-2, D-7; CA-1, CA-5, CA-8, CA-9). Tablas del correo de avisos y
-- del resumen diario. DDL de drizzle-kit (tablas, FK, CHECK e índices) reescrito para ser REPETIBLE (IF NOT EXISTS, DROP ... IF EXISTS antes
-- de cada ADD CONSTRAINT) y luego dueño, RLS, políticas, grants, la fila única de la programación y la cola `notificaciones`. Patrón de 0069.
--   Del estudio (tenant_id con app.tenant_id por defecto; RLS ENABLE + FORCE; política del estudio FOR ALL por app.tenant_id; nadie de la
--   app escribe directo: escriben `interno.notificar` (contapp_registrador, en la transacción del hecho) y las funciones acotadas de 0074):
--     correo_preferencia  PK (estudio, usuario, tipo); tipo de los 4 de TIPOS_CORREO; todos_clientes solo en `resumen`; FK a la membresía
--                         (en cascada: borrar la membresía borra sus preferencias). Sin fila rige la inicial por rol (R-15). El backend
--                         lee solo las suyas (RESTRICTIVE por app.user_id); el worker, las del estudio. contapp_auth (dueño de
--                         auth.correo_baja_aplicar) la lee, inserta y actualiza con app.tenant_id fijado al estudio del token, y solo
--                         puede dejarla apagada (RESTRICTIVE de UPDATE).
--     correo_envio        un correo: origen aviso | resumen | pendientes; estado pendiente | enviado | omitido | fallido con su motivo
--                         (R-3, R-9); clave única por estudio; el usuario, miembro del estudio (trigger, no FK: ver abajo); índice único parcial: un `pendiente` sin tomar por (usuario, tipo) de origen
--                         aviso (D-2). Sin destinatario, asunto ni texto (R-8). El backend lee solo los suyos (ultimoEnvioFallido).
--     correo_envio_aviso  una notificación de 017 que va por correo, unida a su envío o diferida por el tope (R-14); sigue a su notificación
--                         y a su envío (ON DELETE CASCADE: notificacion_purgar nunca falla por un aviso). Copia la lista blanca de la
--                         notificación (cliente, mensaje, categoría, recurso, umbral y su instante): el worker no lee `notificacion`.
--                         Solo el worker la lee.
--     correo_baja_token   hash SHA-256 (32 bytes) del token de cada correo, ligado a (estudio, usuario, tipo) por su envío; vence a los
--                         90 días. Sin grants para backend ni worker; solo contapp_auth lo lee (política SELECT propia, como el auth_definer de 004).
--   De plataforma: correo_programacion  fila única (id = 1): hora y días del resumen (07:00, lunes a viernes, U-6), ventana (10 min) y
--     tope diario (30) de D-2 y R-14, lote del encolado, candado del ciclo y el último día de Lima cerrado. RLS ENABLE sin políticas ni
--     privilegios para la app (como buzon_programacion): solo la leen sus funciones y contapp_registrador (ventana y tope).
--   notificacion: única (tenant_id, id) para la FK compuesta del aviso. job_registro: cliente_id y ruc admiten NULL solo en
--   `notificacion.enviar` (trabajo del estudio, sin cliente). auditoria_accion_valida suma `correo.preferencia_cambiada` (R-10).
--   config_sistema: fila de la cola `notificaciones` (2 reintentos = 3 intentos, U-14/R-9). auth.limite_tasa admite `correo_baja_ip`.

-- ---- Tablas (drizzle-kit, repetible) -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "correo_baja_token" (
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"hash" "bytea" PRIMARY KEY NOT NULL,
	"usuario_id" uuid NOT NULL,
	"tipo" text NOT NULL,
	"envio_id" uuid NOT NULL,
	"creado_en" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"vence_en" timestamp with time zone NOT NULL,
	CONSTRAINT "correo_baja_token_hash_32" CHECK (octet_length("correo_baja_token"."hash") = 32),
	CONSTRAINT "correo_baja_token_tipo_valido" CHECK ("correo_baja_token"."tipo" IN ('buzon_critico', 'credencial_invalida', 'plan_limite', 'resumen'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "correo_envio" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"usuario_id" uuid NOT NULL,
	"origen" text NOT NULL,
	"tipo" text NOT NULL,
	"estado" text DEFAULT 'pendiente' NOT NULL,
	"motivo" text,
	"clave" text NOT NULL,
	"programado_para" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"tomado_en" timestamp with time zone,
	"intentos" smallint DEFAULT 0 NOT NULL,
	"total_avisos" integer DEFAULT 0 NOT NULL,
	"dia_lima" date,
	"corte_hasta" timestamp with time zone,
	"creado_en" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"enviado_en" timestamp with time zone,
	CONSTRAINT "correo_envio_clave_unique" UNIQUE("tenant_id","clave"),
	CONSTRAINT "correo_envio_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "correo_envio_origen_valido" CHECK ("correo_envio"."origen" IN ('aviso', 'resumen', 'pendientes')),
	CONSTRAINT "correo_envio_tipo_valido" CHECK ("correo_envio"."tipo" IN ('buzon_critico', 'credencial_invalida', 'plan_limite', 'resumen')),
	CONSTRAINT "correo_envio_tipo_origen" CHECK (("correo_envio"."origen" = 'resumen') = ("correo_envio"."tipo" = 'resumen')),
	CONSTRAINT "correo_envio_estado_valido" CHECK ("correo_envio"."estado" IN ('pendiente', 'enviado', 'omitido', 'fallido')),
	CONSTRAINT "correo_envio_motivo_valido" CHECK (("correo_envio"."estado" IN ('pendiente', 'enviado') AND "correo_envio"."motivo" IS NULL) OR ("correo_envio"."estado" = 'omitido' AND "correo_envio"."motivo" IN ('membresia_inactiva', 'sin_correo', 'preferencia_apagada', 'sin_plan', 'sin_contenido', 'sin_novedades')) OR ("correo_envio"."estado" = 'fallido' AND "correo_envio"."motivo" = 'transporte')),
	CONSTRAINT "correo_envio_clave_largo" CHECK (char_length("correo_envio"."clave") BETWEEN 1 AND 200),
	CONSTRAINT "correo_envio_intentos_no_negativos" CHECK ("correo_envio"."intentos" >= 0),
	CONSTRAINT "correo_envio_total_no_negativo" CHECK ("correo_envio"."total_avisos" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "correo_envio_aviso" (
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"notificacion_id" uuid NOT NULL,
	"usuario_id" uuid NOT NULL,
	"tipo" text NOT NULL,
	"envio_id" uuid,
	"diferido_en" timestamp with time zone,
	"creado_en" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"cliente_id" uuid,
	"mensaje_id" uuid,
	"categoria" text,
	"recurso" text,
	"umbral" smallint,
	"notificada_en" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "correo_envio_aviso_pk" PRIMARY KEY("tenant_id","notificacion_id"),
	CONSTRAINT "correo_envio_aviso_tipo_valido" CHECK ("correo_envio_aviso"."tipo" IN ('buzon_critico', 'credencial_invalida', 'plan_limite')),
	CONSTRAINT "correo_envio_aviso_envio_o_diferido" CHECK ("correo_envio_aviso"."envio_id" IS NOT NULL OR "correo_envio_aviso"."diferido_en" IS NOT NULL),
	CONSTRAINT "correo_envio_aviso_categoria_formato" CHECK ("correo_envio_aviso"."categoria" IS NULL OR "correo_envio_aviso"."categoria" ~ '^[a-z_]{1,40}$'),
	CONSTRAINT "correo_envio_aviso_recurso_valido" CHECK ("correo_envio_aviso"."recurso" IS NULL OR "correo_envio_aviso"."recurso" IN ('rucs', 'usuarios')),
	CONSTRAINT "correo_envio_aviso_umbral_valido" CHECK ("correo_envio_aviso"."umbral" IS NULL OR "correo_envio_aviso"."umbral" IN (90, 100))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "correo_preferencia" (
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"usuario_id" uuid NOT NULL,
	"tipo" text NOT NULL,
	"activo" boolean NOT NULL,
	"todos_clientes" boolean DEFAULT false NOT NULL,
	"actualizada_en" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "correo_preferencia_pk" PRIMARY KEY("tenant_id","usuario_id","tipo"),
	CONSTRAINT "correo_preferencia_tipo_valido" CHECK ("correo_preferencia"."tipo" IN ('buzon_critico', 'credencial_invalida', 'plan_limite', 'resumen')),
	CONSTRAINT "correo_preferencia_todos_solo_resumen" CHECK (NOT "correo_preferencia"."todos_clientes" OR "correo_preferencia"."tipo" = 'resumen')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "correo_programacion" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"hora_resumen" time DEFAULT '07:00' NOT NULL,
	"dias_resumen" smallint[] DEFAULT '{1,2,3,4,5}'::smallint[] NOT NULL,
	"ventana_min" integer DEFAULT 10 NOT NULL,
	"tope_diario" integer DEFAULT 30 NOT NULL,
	"lote" integer DEFAULT 1000 NOT NULL,
	"ciclo_dueno" text,
	"ciclo_hasta" timestamp with time zone,
	"ultimo_ciclo_inicio" timestamp with time zone,
	"ultimo_ciclo_fin" timestamp with time zone,
	"resumen_cerrado" date,
	CONSTRAINT "correo_programacion_fila_unica" CHECK ("correo_programacion"."id" = 1),
	CONSTRAINT "correo_programacion_dias" CHECK (cardinality("correo_programacion"."dias_resumen") BETWEEN 1 AND 7 AND "correo_programacion"."dias_resumen" <@ '{1,2,3,4,5,6,7}'::smallint[] AND array_position("correo_programacion"."dias_resumen", NULL) IS NULL),
	CONSTRAINT "correo_programacion_ventana" CHECK ("correo_programacion"."ventana_min" BETWEEN 1 AND 60),
	CONSTRAINT "correo_programacion_tope" CHECK ("correo_programacion"."tope_diario" BETWEEN 1 AND 500),
	CONSTRAINT "correo_programacion_lote" CHECK ("correo_programacion"."lote" BETWEEN 1 AND 100000),
	CONSTRAINT "correo_programacion_dueno_largo" CHECK (char_length("correo_programacion"."ciclo_dueno") BETWEEN 1 AND 200)
);
--> statement-breakpoint
ALTER TABLE "notificacion" DROP CONSTRAINT IF EXISTS "notificacion_tenant_id_unique";--> statement-breakpoint
ALTER TABLE "notificacion" ADD CONSTRAINT "notificacion_tenant_id_unique" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "job_registro" ALTER COLUMN "cliente_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "job_registro" ALTER COLUMN "ruc" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "correo_baja_token" DROP CONSTRAINT IF EXISTS "correo_baja_token_tenant_id_tenant_id_fk";--> statement-breakpoint
ALTER TABLE "correo_baja_token" ADD CONSTRAINT "correo_baja_token_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correo_baja_token" DROP CONSTRAINT IF EXISTS "correo_baja_token_envio_fk";--> statement-breakpoint
ALTER TABLE "correo_baja_token" ADD CONSTRAINT "correo_baja_token_envio_fk" FOREIGN KEY ("tenant_id","envio_id") REFERENCES "public"."correo_envio"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correo_baja_token" DROP CONSTRAINT IF EXISTS "correo_baja_token_membresia_fk";--> statement-breakpoint
ALTER TABLE "correo_baja_token" ADD CONSTRAINT "correo_baja_token_membresia_fk" FOREIGN KEY ("tenant_id","usuario_id") REFERENCES "public"."membresia"("tenant_id","usuario_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correo_envio" DROP CONSTRAINT IF EXISTS "correo_envio_tenant_id_tenant_id_fk";--> statement-breakpoint
ALTER TABLE "correo_envio" ADD CONSTRAINT "correo_envio_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correo_envio_aviso" DROP CONSTRAINT IF EXISTS "correo_envio_aviso_tenant_id_tenant_id_fk";--> statement-breakpoint
ALTER TABLE "correo_envio_aviso" ADD CONSTRAINT "correo_envio_aviso_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correo_envio_aviso" DROP CONSTRAINT IF EXISTS "correo_envio_aviso_notificacion_fk";--> statement-breakpoint
ALTER TABLE "correo_envio_aviso" ADD CONSTRAINT "correo_envio_aviso_notificacion_fk" FOREIGN KEY ("tenant_id","notificacion_id") REFERENCES "public"."notificacion"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correo_envio_aviso" DROP CONSTRAINT IF EXISTS "correo_envio_aviso_envio_fk";--> statement-breakpoint
ALTER TABLE "correo_envio_aviso" ADD CONSTRAINT "correo_envio_aviso_envio_fk" FOREIGN KEY ("tenant_id","envio_id") REFERENCES "public"."correo_envio"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correo_preferencia" DROP CONSTRAINT IF EXISTS "correo_preferencia_tenant_id_tenant_id_fk";--> statement-breakpoint
ALTER TABLE "correo_preferencia" ADD CONSTRAINT "correo_preferencia_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correo_preferencia" DROP CONSTRAINT IF EXISTS "correo_preferencia_membresia_fk";--> statement-breakpoint
ALTER TABLE "correo_preferencia" ADD CONSTRAINT "correo_preferencia_membresia_fk" FOREIGN KEY ("tenant_id","usuario_id") REFERENCES "public"."membresia"("tenant_id","usuario_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "correo_baja_token_envio_idx" ON "correo_baja_token" USING btree ("tenant_id","envio_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "correo_baja_token_purga_idx" ON "correo_baja_token" USING btree ("tenant_id","creado_en");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "correo_envio_pendiente_unico" ON "correo_envio" USING btree ("tenant_id","usuario_id","tipo") WHERE "correo_envio"."origen" = 'aviso' AND "correo_envio"."estado" = 'pendiente' AND "correo_envio"."tomado_en" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "correo_envio_usuario_idx" ON "correo_envio" USING btree ("tenant_id","usuario_id","origen","creado_en");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "correo_envio_vencidos_idx" ON "correo_envio" USING btree ("tenant_id","programado_para") WHERE "correo_envio"."origen" = 'aviso' AND "correo_envio"."estado" = 'pendiente' AND "correo_envio"."tomado_en" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "correo_envio_purga_idx" ON "correo_envio" USING btree ("tenant_id","creado_en");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "correo_envio_aviso_envio_idx" ON "correo_envio_aviso" USING btree ("tenant_id","envio_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "correo_envio_aviso_diferido_idx" ON "correo_envio_aviso" USING btree ("tenant_id","usuario_id","tipo") WHERE "correo_envio_aviso"."envio_id" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "correo_envio_aviso_purga_idx" ON "correo_envio_aviso" USING btree ("tenant_id","creado_en");--> statement-breakpoint
ALTER TABLE "job_registro" DROP CONSTRAINT IF EXISTS "job_registro_cliente_requerido";--> statement-breakpoint
ALTER TABLE "job_registro" ADD CONSTRAINT "job_registro_cliente_requerido" CHECK (("job_registro"."cliente_id" IS NULL) = ("job_registro"."ruc" IS NULL) AND ("job_registro"."cliente_id" IS NOT NULL OR "job_registro"."tipo" = 'notificacion.enviar'));--> statement-breakpoint
ALTER TABLE "auditoria" DROP CONSTRAINT IF EXISTS "auditoria_accion_valida";--> statement-breakpoint
ALTER TABLE "auditoria" ADD CONSTRAINT "auditoria_accion_valida" CHECK ("auditoria"."accion" IN ('sesion.ingreso', 'invitacion.creada', 'invitacion.revocada', 'invitacion.modificada', 'miembro.alta', 'miembro.rol_cambiado', 'miembro.desactivado', 'miembro.reactivado', 'miembro.eliminado', 'asignacion.agregada', 'asignacion.quitada', 'asignacion.tipo_cambiado', 'cliente.creado', 'cliente.editado', 'cliente.archivado', 'cliente.reactivado', 'cliente.eliminado', 'credencial.guardada', 'credencial.verificada', 'credencial.invalidada', 'credencial.descifrada', 'propuesta.cargada', 'compra.operacion', 'venta.agregada', 'venta.excluida', 'venta.restaurada', 'venta.salto_justificado', 'xml.subido', 'periodo.estado_cambiado', 'archivo.generado', 'sunat.envio', 'regla.creada', 'regla.editada', 'regla.activada', 'regla.desactivada', 'regla.eliminada', 'estudio.regla_motor', 'estudio.aporte_catalogo', 'compra.historial', 'buzon.captura_solicitada', 'buzon.apertura_solicitada', 'buzon.contenido_visto', 'buzon.adjunto_descargado', 'buzon.contenido_obtenido', 'buzon.atendido', 'buzon.atencion_deshecha', 'regla.historial_importado', 'regla.candidata_descartada', 'prorrata.declaraciones_obtenidas', 'prorrata.mes_manual_guardado', 'prorrata.mes_manual_eliminado', 'prorrata.usada_guardada', 'gnd.palabra_agregada', 'gnd.palabra_desactivada', 'gnd.palabra_reactivada', 'gnd.palabra_aprendida', 'gnd.global_desactivada', 'gnd.global_reactivada', 'gnd.umbral_cambiado', 'gnd.categorias_cliente', 'correo.preferencia_cambiada'));
--> statement-breakpoint

-- ---- Dueño y RLS ---------------------------------------------------------------------------------------------------------
ALTER TABLE public.correo_preferencia OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.correo_envio OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.correo_envio_aviso OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.correo_baja_token OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.correo_programacion OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.correo_preferencia ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.correo_preferencia FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.correo_envio ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.correo_envio FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.correo_envio_aviso ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.correo_envio_aviso FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.correo_baja_token ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.correo_baja_token FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Sin FORCE: solo su dueño la toca, desde las funciones de 0074 (como buzon_programacion).
ALTER TABLE public.correo_programacion ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- ---- correo_envio: el usuario es miembro del estudio (23503), sin bloquear la fila de la membresía ---------------------------
-- Una FK compuesta a membresia tomaría FOR KEY SHARE de la fila del Dueño en la transacción del hecho (p. ej. el cruce del 90 % de RUCs
-- al importar, con el candado del cupo tomado) e interbloquearía con `bloquearMiembros` (FOR UPDATE) de una invitación en curso (006).
-- SECURITY INVOKER: corre con quien inserta (interno.notificar o las funciones de 0074; la app no tiene INSERT).
CREATE OR REPLACE FUNCTION public.correo_envio_miembro() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.membresia m WHERE m.tenant_id = NEW.tenant_id AND m.usuario_id = NEW.usuario_id) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'correo_envio: el usuario no es miembro del estudio';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.correo_envio_miembro() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.correo_envio_miembro() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS correo_envio_miembro ON public.correo_envio;--> statement-breakpoint
CREATE TRIGGER correo_envio_miembro BEFORE INSERT OR UPDATE OF tenant_id, usuario_id ON public.correo_envio
  FOR EACH ROW EXECUTE FUNCTION public.correo_envio_miembro();--> statement-breakpoint

-- ---- Políticas: todas atan a app.tenant_id -------------------------------------------------------------------------------
-- Permisiva del estudio (los grants deciden quién lee o escribe) y RESTRICTIVE para el backend: solo las filas del usuario de la sesión.
DROP POLICY IF EXISTS correo_preferencia_estudio ON public.correo_preferencia;--> statement-breakpoint
CREATE POLICY correo_preferencia_estudio ON public.correo_preferencia FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
DROP POLICY IF EXISTS correo_preferencia_propias ON public.correo_preferencia;--> statement-breakpoint
CREATE POLICY correo_preferencia_propias ON public.correo_preferencia AS RESTRICTIVE FOR SELECT TO contapp_backend
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
         AND usuario_id = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
-- La baja por enlace (contapp_auth) solo deja una preferencia apagada.
DROP POLICY IF EXISTS correo_preferencia_baja ON public.correo_preferencia;--> statement-breakpoint
CREATE POLICY correo_preferencia_baja ON public.correo_preferencia AS RESTRICTIVE FOR UPDATE TO contapp_auth
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid AND NOT activo);--> statement-breakpoint

DROP POLICY IF EXISTS correo_envio_estudio ON public.correo_envio;--> statement-breakpoint
CREATE POLICY correo_envio_estudio ON public.correo_envio FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
DROP POLICY IF EXISTS correo_envio_propios ON public.correo_envio;--> statement-breakpoint
CREATE POLICY correo_envio_propios ON public.correo_envio AS RESTRICTIVE FOR SELECT TO contapp_backend
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
         AND usuario_id = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint

DROP POLICY IF EXISTS correo_envio_aviso_estudio ON public.correo_envio_aviso;--> statement-breakpoint
CREATE POLICY correo_envio_aviso_estudio ON public.correo_envio_aviso FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- Tokens: solo las funciones del dueño (creación y purga, por estudio) y la lectura de la baja sin sesión (contapp_auth, por hash).
DROP POLICY IF EXISTS correo_baja_token_estudio ON public.correo_baja_token;--> statement-breakpoint
CREATE POLICY correo_baja_token_estudio ON public.correo_baja_token FOR ALL TO contapp_migrator
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
DROP POLICY IF EXISTS correo_baja_token_auth ON public.correo_baja_token;--> statement-breakpoint
CREATE POLICY correo_baja_token_auth ON public.correo_baja_token FOR SELECT TO contapp_auth USING (true);--> statement-breakpoint

-- ---- Grants --------------------------------------------------------------------------------------------------------------
REVOKE ALL ON public.correo_preferencia, public.correo_envio, public.correo_envio_aviso, public.correo_baja_token,
              public.correo_programacion
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador,
       contapp_registrador;--> statement-breakpoint
GRANT SELECT ON public.correo_preferencia, public.correo_envio TO contapp_backend, contapp_worker;--> statement-breakpoint
GRANT SELECT ON public.correo_envio_aviso TO contapp_worker;--> statement-breakpoint
-- interno.notificar (dueño contapp_registrador, BYPASSRLS): lee preferencias, programación, membresía y plan; registra envíos y avisos.
GRANT SELECT ON public.correo_preferencia, public.correo_programacion TO contapp_registrador;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.correo_envio, public.correo_envio_aviso TO contapp_registrador;--> statement-breakpoint
GRANT SELECT ON public.membresia, public.suscripcion, public.plan TO contapp_registrador;--> statement-breakpoint
-- auth.correo_baja_aplicar (dueño contapp_auth): lee el token y apaga la preferencia de su (estudio, usuario, tipo).
GRANT SELECT ON public.correo_baja_token TO contapp_auth;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.correo_preferencia TO contapp_auth;--> statement-breakpoint

-- ---- Fila única de la programación y cola de los envíos ------------------------------------------------------------------
INSERT INTO public.correo_programacion (id) VALUES (1) ON CONFLICT (id) DO NOTHING;--> statement-breakpoint
INSERT INTO public.config_sistema
  (cola, concurrencia_global, concurrencia_tenant, espera_ruc_ms, reintentos, backoff_base_ms, max_pendientes_tenant)
VALUES ('notificaciones', 4, 2, 0, 2, 5000, 100000)
ON CONFLICT (cola) DO NOTHING;--> statement-breakpoint

-- ---- Límite por IP de la baja sin sesión (004): `correo_baja_ip` (auth.limite_consumir de 0074) ---------------------------
ALTER TABLE auth.limite_tasa DROP CONSTRAINT IF EXISTS limite_tasa_tipo_valido;--> statement-breakpoint
ALTER TABLE auth.limite_tasa ADD CONSTRAINT limite_tasa_tipo_valido
  CHECK (tipo IN ('login_ip', 'recup_correo', 'recup_ip', 'restab_ip', 'registro_ip', 'registro_correo',
                  'registro_confirmar_ip', 'correo_baja_ip'));
