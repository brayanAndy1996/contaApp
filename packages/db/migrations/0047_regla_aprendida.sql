-- 0047_regla_aprendida (spec 021, D-2, D-5, P-8, P-9, P-10). Reglas aprendidas por cliente y proveedor, interruptores del motor del
-- estudio y aporte al catalogo. Las tres tablas con RLS ENABLE + FORCE y tenant_isolation FOR ALL; dueño contapp_migrator.
--   regla_aprendida        contapp_backend: SELECT, INSERT y UPDATE solo de (destino, activa, version, periodo_aprendido,
--                          actualizada_*, eliminada_*); nunca borra (baja logica con eliminada_en). El worker y el resto de los roles
--                          de la app no tienen ningun privilegio: el worker la lee por reglas_historial_vigentes (0048). Se revoca
--                          explicitamente a cada rol (los privilegios por defecto de un despliegue le darian SELECT al worker).
--                          Unica parcial (tenant, cliente, doc_tipo, doc_numero) WHERE eliminada_en IS NULL: eliminar y volver a crear.
--                          Trigger BEFORE UPDATE: la identidad no cambia y una regla eliminada ya no cambia (42501, mensaje fijo).
--   estudio_regla_motor    sin fila = encendida. SELECT a backend y worker; INSERT y UPDATE (activa, actualizada_*) solo al backend.
--   estudio_reglas_config  sin fila = aportar. SELECT a backend y worker; INSERT y UPDATE (aportar_catalogo) solo al backend.
-- Auditoria por triggers (patron de 0042, todo pasa por auditoria_registrar; el CHECK de acciones se amplia en 0049): regla.creada
-- {destino, activa}, regla.editada {destino: {anterior, nuevo}} (cambio de destino o de periodo aprendido), regla.activada,
-- regla.desactivada, regla.eliminada, estudio.regla_motor {codigo, activa} y estudio.aporte_catalogo {aportar}. Los datos nunca
-- llevan RUC, razon social ni montos. Lo que sigue a las tablas es repetible: CREATE OR REPLACE, DROP ... IF EXISTS, GRANT/REVOKE.
CREATE TABLE "estudio_regla_motor" (
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"codigo" text NOT NULL,
	"activa" boolean DEFAULT true NOT NULL,
	"actualizada_por" uuid NOT NULL,
	"actualizada_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "estudio_regla_motor_pk" PRIMARY KEY("tenant_id","codigo"),
	CONSTRAINT "estudio_regla_motor_codigo_valido" CHECK ("estudio_regla_motor"."codigo" IN ('R-ISC', 'R-MIX', 'R-RED', 'R-NEW', 'R-GP', 'R-HIS'))
);
--> statement-breakpoint
CREATE TABLE "estudio_reglas_config" (
	"tenant_id" uuid PRIMARY KEY DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"aportar_catalogo" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regla_aprendida" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"cliente_id" uuid NOT NULL,
	"doc_tipo" text NOT NULL,
	"doc_numero" text NOT NULL,
	"destino" text NOT NULL,
	"activa" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"periodo_aprendido" char(6) NOT NULL,
	"creada_por" uuid NOT NULL,
	"creada_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizada_por" uuid NOT NULL,
	"actualizada_en" timestamp with time zone DEFAULT now() NOT NULL,
	"eliminada_en" timestamp with time zone,
	"eliminada_por" uuid,
	CONSTRAINT "regla_aprendida_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "regla_aprendida_destino_valido" CHECK ("regla_aprendida"."destino" IN ('DG', 'DGNG', 'DNG')),
	CONSTRAINT "regla_aprendida_version_positiva" CHECK ("regla_aprendida"."version" >= 1),
	CONSTRAINT "regla_aprendida_periodo_formato" CHECK ("regla_aprendida"."periodo_aprendido" ~ '^[0-9]{4}(0[1-9]|1[0-2])$'),
	CONSTRAINT "regla_aprendida_documento_largo" CHECK (char_length("regla_aprendida"."doc_tipo") BETWEEN 1 AND 2 AND char_length("regla_aprendida"."doc_numero") BETWEEN 1 AND 20),
	CONSTRAINT "regla_aprendida_baja_coherente" CHECK (("regla_aprendida"."eliminada_en" IS NULL) = ("regla_aprendida"."eliminada_por" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "estudio_regla_motor" ADD CONSTRAINT "estudio_regla_motor_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estudio_reglas_config" ADD CONSTRAINT "estudio_reglas_config_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regla_aprendida" ADD CONSTRAINT "regla_aprendida_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regla_aprendida" ADD CONSTRAINT "regla_aprendida_cliente_fk" FOREIGN KEY ("tenant_id","cliente_id") REFERENCES "public"."cliente"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "regla_aprendida_viva_unique" ON "regla_aprendida" USING btree ("tenant_id","cliente_id","doc_tipo","doc_numero") WHERE "regla_aprendida"."eliminada_en" IS NULL;
--> statement-breakpoint

-- ---- RLS, dueño y grants -------------------------------------------------------------------------------------------------
ALTER TABLE public.regla_aprendida OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.regla_aprendida ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.regla_aprendida FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.regla_aprendida;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.regla_aprendida FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
REVOKE ALL ON public.regla_aprendida
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT SELECT, INSERT ON public.regla_aprendida TO contapp_backend;--> statement-breakpoint
GRANT UPDATE (destino, activa, version, periodo_aprendido, actualizada_por, actualizada_en, eliminada_en, eliminada_por)
  ON public.regla_aprendida TO contapp_backend;--> statement-breakpoint

ALTER TABLE public.estudio_regla_motor OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.estudio_regla_motor ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.estudio_regla_motor FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.estudio_regla_motor;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.estudio_regla_motor FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
REVOKE ALL ON public.estudio_regla_motor
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT SELECT ON public.estudio_regla_motor TO contapp_backend, contapp_worker;--> statement-breakpoint
GRANT INSERT ON public.estudio_regla_motor TO contapp_backend;--> statement-breakpoint
GRANT UPDATE (activa, actualizada_por, actualizada_en) ON public.estudio_regla_motor TO contapp_backend;--> statement-breakpoint

ALTER TABLE public.estudio_reglas_config OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.estudio_reglas_config ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.estudio_reglas_config FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.estudio_reglas_config;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.estudio_reglas_config FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
REVOKE ALL ON public.estudio_reglas_config
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT SELECT ON public.estudio_reglas_config TO contapp_backend, contapp_worker;--> statement-breakpoint
GRANT INSERT ON public.estudio_reglas_config TO contapp_backend;--> statement-breakpoint
GRANT UPDATE (aportar_catalogo) ON public.estudio_reglas_config TO contapp_backend;--> statement-breakpoint

-- ---- regla_aprendida: identidad inmutable y baja definitiva (vale tambien para el dueño y el superusuario) -----------------
CREATE OR REPLACE FUNCTION public.regla_aprendida_inmutable() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.cliente_id, NEW.doc_tipo, NEW.doc_numero, NEW.creada_por, NEW.creada_en)
     IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.cliente_id, OLD.doc_tipo, OLD.doc_numero, OLD.creada_por, OLD.creada_en) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'regla_aprendida: la identidad de la regla no se modifica';
  END IF;
  IF OLD.eliminada_en IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'regla_aprendida: una regla eliminada no cambia';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.regla_aprendida_inmutable() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.regla_aprendida_inmutable() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS regla_aprendida_inmutable ON public.regla_aprendida;--> statement-breakpoint
CREATE TRIGGER regla_aprendida_inmutable BEFORE UPDATE ON public.regla_aprendida
  FOR EACH ROW EXECUTE FUNCTION public.regla_aprendida_inmutable();--> statement-breakpoint

-- ---- Auditoria de reglas aprendidas -------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auditoria_capturar_regla() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.auditoria_registrar(NEW.tenant_id, 'regla.creada', NEW.cliente_id, 'regla_aprendida', NEW.id,
      jsonb_build_object('destino', NEW.destino, 'activa', NEW.activa));
    RETURN NULL;
  END IF;
  IF OLD.eliminada_en IS NULL AND NEW.eliminada_en IS NOT NULL THEN
    PERFORM public.auditoria_registrar(NEW.tenant_id, 'regla.eliminada', NEW.cliente_id, 'regla_aprendida', NEW.id,
      '{}'::jsonb);
    RETURN NULL;
  END IF;
  IF NEW.destino IS DISTINCT FROM OLD.destino OR NEW.periodo_aprendido IS DISTINCT FROM OLD.periodo_aprendido THEN
    PERFORM public.auditoria_registrar(NEW.tenant_id, 'regla.editada', NEW.cliente_id, 'regla_aprendida', NEW.id,
      jsonb_build_object('destino', jsonb_build_object('anterior', OLD.destino, 'nuevo', NEW.destino)));
  END IF;
  IF NEW.activa IS DISTINCT FROM OLD.activa THEN
    PERFORM public.auditoria_registrar(NEW.tenant_id,
      CASE WHEN NEW.activa THEN 'regla.activada' ELSE 'regla.desactivada' END,
      NEW.cliente_id, 'regla_aprendida', NEW.id, '{}'::jsonb);
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.auditoria_capturar_regla() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.auditoria_capturar_regla() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS auditoria_regla ON public.regla_aprendida;--> statement-breakpoint
CREATE TRIGGER auditoria_regla AFTER INSERT OR UPDATE ON public.regla_aprendida
  FOR EACH ROW EXECUTE FUNCTION public.auditoria_capturar_regla();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.auditoria_capturar_regla_motor() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.activa IS NOT DISTINCT FROM OLD.activa THEN
    RETURN NULL;
  END IF;
  PERFORM public.auditoria_registrar(NEW.tenant_id, 'estudio.regla_motor', NULL, 'estudio_regla_motor', NULL,
    jsonb_build_object('codigo', NEW.codigo, 'activa', NEW.activa));
  RETURN NULL;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.auditoria_capturar_regla_motor() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.auditoria_capturar_regla_motor() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS auditoria_regla_motor ON public.estudio_regla_motor;--> statement-breakpoint
CREATE TRIGGER auditoria_regla_motor AFTER INSERT OR UPDATE ON public.estudio_regla_motor
  FOR EACH ROW EXECUTE FUNCTION public.auditoria_capturar_regla_motor();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.auditoria_capturar_aporte() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.aportar_catalogo IS NOT DISTINCT FROM OLD.aportar_catalogo THEN
    RETURN NULL;
  END IF;
  PERFORM public.auditoria_registrar(NEW.tenant_id, 'estudio.aporte_catalogo', NULL, 'estudio_reglas_config', NULL,
    jsonb_build_object('aportar', NEW.aportar_catalogo));
  RETURN NULL;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.auditoria_capturar_aporte() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.auditoria_capturar_aporte() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS auditoria_aporte ON public.estudio_reglas_config;--> statement-breakpoint
CREATE TRIGGER auditoria_aporte AFTER INSERT OR UPDATE ON public.estudio_reglas_config
  FOR EACH ROW EXECUTE FUNCTION public.auditoria_capturar_aporte();
