-- 0048_regla_aplicacion (spec 021, D-6, D-7, D-8, P-5, CA-4, CA-9, CA-10, CA-13). Aplicacion de R-HIS en la descarga.
--   regla_aplicacion  una fila por version `historial`; RLS ENABLE + FORCE y tenant_isolation. Solo insercion: ningun rol de la app
--                     escribe (la inserta aplicar_regla_historial) y contapp_backend la lee (contador «aplicada», P-4).
--   reglas_historial_vigentes(p_cliente, p_periodo)  lo que lee la descarga: reglas vivas y activas del cliente con
--                     periodo_aprendido < p_periodo (P-5), bloqueadas FOR SHARE (un cambio concurrente de la regla espera a la
--                     descarga, CA-9). Toma el advisory compartido 'reglas_motor:<estudio>' (el PUT del interruptor lo toma
--                     exclusivo) y devuelve vacio si R-HIS esta apagado en el estudio.
--   aplicar_regla_historial(p_compra, p_regla, p_datos jsonb) -> 2  exige: compra viva creada en esta transaccion (xmin), solo con
--                     la version 1 y vigente; regla del mismo cliente y proveedor (documento normalizado como R-NEW), viva, activa
--                     y aprendida antes del periodo de la compra; R-HIS encendido; `p_datos` con exactamente las 11 columnas de
--                     monto (snake_case, cadenas decimales) iguales a la version 1 consolidada en el destino de la regla
--                     (recalculada aqui en NUMERIC: falla cerrado). Inserta la version 2 (`historial`, clasificada, sin operacion
--                     ni usuario), mueve el puntero e inserta regla_aplicacion. Cualquier otra cosa: 42501 de mensaje fijo.
--   Las dos: SECURITY DEFINER de contapp_migrator (sin BYPASSRLS: la RLS FORCE aplica dentro y ademas filtran por app.tenant_id),
--   search_path fijo, EXECUTE solo para contapp_worker (patron de 0038).
--   compra_version_historial_acotado  BEFORE INSERT: `accion = historial` solo la escribe contapp_migrator (dentro de la funcion);
--                     ni el backend, ni el worker directo, ni el superusuario. El trigger de 0038 no cambia.
--   compra.historial  auditoria por trigger AFTER INSERT sobre regla_aplicacion: {compraId, reglaId, periodo}, entidad
--                     regla_aplicacion; el actor lo decide auditoria_registrar (con app.trabajo_id del worker: trabajo; sin el:
--                     sistema).
-- Orden de bloqueo (plan 021): advisory de la descarga -> compra_periodo FOR SHARE -> advisory compartido reglas_motor ->
-- regla_aprendida FOR SHARE -> compra (insercion). Lo que sigue a la tabla es repetible.
CREATE TABLE "regla_aplicacion" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"regla_id" uuid NOT NULL,
	"compra_id" uuid NOT NULL,
	"version_n" integer NOT NULL,
	"periodo" char(6) NOT NULL,
	"creada_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "regla_aplicacion_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "regla_aplicacion_version_unique" UNIQUE("tenant_id","compra_id","version_n"),
	CONSTRAINT "regla_aplicacion_version_historial" CHECK ("regla_aplicacion"."version_n" >= 2),
	CONSTRAINT "regla_aplicacion_periodo_formato" CHECK ("regla_aplicacion"."periodo" ~ '^[0-9]{4}(0[1-9]|1[0-2])$')
);
--> statement-breakpoint
ALTER TABLE "regla_aplicacion" ADD CONSTRAINT "regla_aplicacion_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regla_aplicacion" ADD CONSTRAINT "regla_aplicacion_regla_fk" FOREIGN KEY ("tenant_id","regla_id") REFERENCES "public"."regla_aprendida"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regla_aplicacion" ADD CONSTRAINT "regla_aplicacion_version_fk" FOREIGN KEY ("tenant_id","compra_id","version_n") REFERENCES "public"."compra_version"("tenant_id","compra_id","n") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "regla_aplicacion_regla_idx" ON "regla_aplicacion" USING btree ("tenant_id","regla_id");
--> statement-breakpoint

-- ---- RLS, dueño y grants -------------------------------------------------------------------------------------------------
ALTER TABLE public.regla_aplicacion OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.regla_aplicacion ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.regla_aplicacion FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.regla_aplicacion;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.regla_aplicacion FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
REVOKE ALL ON public.regla_aplicacion
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT SELECT ON public.regla_aplicacion TO contapp_backend;--> statement-breakpoint

-- ---- accion = historial: solo dentro de aplicar_regla_historial ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compra_version_historial_acotado() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.accion = 'historial' AND current_user <> 'contapp_migrator' THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'compra_version: la version historial solo la escribe aplicar_regla_historial';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.compra_version_historial_acotado() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.compra_version_historial_acotado() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS compra_version_historial_acotado ON public.compra_version;--> statement-breakpoint
CREATE TRIGGER compra_version_historial_acotado BEFORE INSERT ON public.compra_version
  FOR EACH ROW EXECUTE FUNCTION public.compra_version_historial_acotado();--> statement-breakpoint

-- ---- Lectura de la descarga -----------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reglas_historial_vigentes(p_cliente uuid, p_periodo text)
  RETURNS TABLE (regla_id uuid, doc_tipo text, doc_numero text, destino text, version integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'reglas_historial_vigentes: sesion sin estudio';
  END IF;
  IF p_cliente IS NULL OR p_periodo IS NULL OR p_periodo !~ '^[0-9]{4}(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'reglas_historial_vigentes: parametro invalido';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('reglas_motor:' || v_tenant::text, 0));
  IF EXISTS (
    SELECT 1 FROM public.estudio_regla_motor m WHERE m.tenant_id = v_tenant AND m.codigo = 'R-HIS' AND NOT m.activa
  ) THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT r.id, r.doc_tipo, r.doc_numero, r.destino, r.version
      FROM public.regla_aprendida r
     WHERE r.tenant_id = v_tenant AND r.cliente_id = p_cliente AND r.eliminada_en IS NULL AND r.activa
       AND r.periodo_aprendido < p_periodo
     ORDER BY r.id
     FOR SHARE OF r;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.reglas_historial_vigentes(uuid, text) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.reglas_historial_vigentes(uuid, text)
  FROM PUBLIC, contapp_backend, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.reglas_historial_vigentes(uuid, text) TO contapp_worker;--> statement-breakpoint

-- ---- Aplicacion de una regla a una compra nueva de la descarga -----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.aplicar_regla_historial(p_compra uuid, p_regla uuid, p_datos jsonb) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  v_claves CONSTANT text[] := ARRAY['bi_dg', 'bi_dgng', 'bi_dng', 'icbper', 'igv_dg', 'igv_dgng', 'igv_dng', 'isc',
                                    'no_gravado', 'otros_tributos', 'total'];
  v_compra record;
  v_v1 record;
  v_regla record;
  v_bi numeric;
  v_igv numeric;
  v_esperado jsonb;
  v_clave text;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'aplicar_regla_historial: sesion sin estudio';
  END IF;
  IF p_compra IS NULL OR p_regla IS NULL OR p_datos IS NULL OR jsonb_typeof(p_datos) <> 'object'
     OR (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(p_datos) AS k) IS DISTINCT FROM v_claves THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'aplicar_regla_historial: aplicacion rechazada';
  END IF;
  FOREACH v_clave IN ARRAY v_claves LOOP
    IF jsonb_typeof(p_datos -> v_clave) <> 'string' OR (p_datos ->> v_clave) !~ '^-?[0-9]{1,12}([.][0-9]{1,2})?$' THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'aplicar_regla_historial: aplicacion rechazada';
    END IF;
  END LOOP;

  -- Mismo candado compartido que reglas_historial_vigentes: el interruptor no cambia a mitad de la descarga.
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('reglas_motor:' || v_tenant::text, 0));
  IF EXISTS (
    SELECT 1 FROM public.estudio_regla_motor m WHERE m.tenant_id = v_tenant AND m.codigo = 'R-HIS' AND NOT m.activa
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'aplicar_regla_historial: aplicacion rechazada';
  END IF;

  -- La compra: viva, creada en esta transaccion y solo con la version 1, que es la vigente.
  SELECT c.id, c.cliente_id, c.periodo, c.doc_tipo, c.doc_numero INTO v_compra
    FROM public.compra c
   WHERE c.tenant_id = v_tenant AND c.id = p_compra AND c.descartada_en IS NULL AND c.version_vigente = 1
     AND c.xmin = pg_current_xact_id()::xid;
  IF NOT FOUND OR (
    SELECT count(*) FROM public.compra_version v WHERE v.tenant_id = v_tenant AND v.compra_id = p_compra
  ) <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'aplicar_regla_historial: aplicacion rechazada';
  END IF;
  SELECT * INTO v_v1 FROM public.compra_version v WHERE v.tenant_id = v_tenant AND v.compra_id = p_compra AND v.n = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'aplicar_regla_historial: aplicacion rechazada';
  END IF;

  -- La regla: del mismo cliente y proveedor, viva, activa y aprendida antes del periodo de la compra (P-5).
  SELECT r.id, r.destino INTO v_regla
    FROM public.regla_aprendida r
   WHERE r.tenant_id = v_tenant AND r.id = p_regla AND r.cliente_id = v_compra.cliente_id
     AND r.doc_tipo = btrim(v_compra.doc_tipo)
     AND r.doc_numero = upper(regexp_replace(v_compra.doc_numero, '[[:space:]]', '', 'g'))
     AND r.eliminada_en IS NULL AND r.activa AND r.periodo_aprendido < v_compra.periodo
   FOR SHARE OF r;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'aplicar_regla_historial: aplicacion rechazada';
  END IF;

  -- La version 1 consolidada en el destino, recalculada aqui: los tres BI y los tres IGV en el par del destino; lo demas igual.
  v_bi := v_v1.bi_dg + v_v1.bi_dgng + v_v1.bi_dng;
  v_igv := v_v1.igv_dg + v_v1.igv_dgng + v_v1.igv_dng;
  v_esperado := jsonb_build_object(
    'bi_dg', CASE WHEN v_regla.destino = 'DG' THEN v_bi ELSE 0 END,
    'igv_dg', CASE WHEN v_regla.destino = 'DG' THEN v_igv ELSE 0 END,
    'bi_dgng', CASE WHEN v_regla.destino = 'DGNG' THEN v_bi ELSE 0 END,
    'igv_dgng', CASE WHEN v_regla.destino = 'DGNG' THEN v_igv ELSE 0 END,
    'bi_dng', CASE WHEN v_regla.destino = 'DNG' THEN v_bi ELSE 0 END,
    'igv_dng', CASE WHEN v_regla.destino = 'DNG' THEN v_igv ELSE 0 END,
    'no_gravado', v_v1.no_gravado,
    'isc', v_v1.isc,
    'icbper', v_v1.icbper,
    'otros_tributos', v_v1.otros_tributos,
    'total', v_v1.total);
  FOREACH v_clave IN ARRAY v_claves LOOP
    IF (p_datos ->> v_clave)::numeric IS DISTINCT FROM (v_esperado ->> v_clave)::numeric THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'aplicar_regla_historial: aplicacion rechazada';
    END IF;
  END LOOP;

  INSERT INTO public.compra_version (tenant_id, compra_id, n, bi_dg, igv_dg, bi_dgng, igv_dgng, bi_dng, igv_dng, no_gravado, isc,
      icbper, otros_tributos, total, excluida, motivo, clasificada, accion, operacion_id, usuario_id)
  VALUES (v_tenant, p_compra, 2,
      (v_esperado ->> 'bi_dg')::numeric, (v_esperado ->> 'igv_dg')::numeric,
      (v_esperado ->> 'bi_dgng')::numeric, (v_esperado ->> 'igv_dgng')::numeric,
      (v_esperado ->> 'bi_dng')::numeric, (v_esperado ->> 'igv_dng')::numeric,
      v_v1.no_gravado, v_v1.isc, v_v1.icbper, v_v1.otros_tributos, v_v1.total,
      v_v1.excluida, v_v1.motivo, true, 'historial', NULL, NULL);
  UPDATE public.compra SET version_vigente = 2 WHERE tenant_id = v_tenant AND id = p_compra AND version_vigente = 1;
  INSERT INTO public.regla_aplicacion (tenant_id, regla_id, compra_id, version_n, periodo)
  VALUES (v_tenant, p_regla, p_compra, 2, v_compra.periodo);
  RETURN 2;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.aplicar_regla_historial(uuid, uuid, jsonb) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.aplicar_regla_historial(uuid, uuid, jsonb)
  FROM PUBLIC, contapp_backend, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.aplicar_regla_historial(uuid, uuid, jsonb) TO contapp_worker;--> statement-breakpoint

-- ---- compra.historial -----------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auditoria_capturar_regla_aplicacion() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_cliente uuid;
BEGIN
  SELECT c.cliente_id INTO v_cliente FROM public.compra c WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.compra_id;
  PERFORM public.auditoria_registrar(NEW.tenant_id, 'compra.historial', v_cliente, 'regla_aplicacion', NEW.id,
    jsonb_build_object('compraId', NEW.compra_id, 'reglaId', NEW.regla_id, 'periodo', NEW.periodo::text));
  RETURN NULL;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.auditoria_capturar_regla_aplicacion() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.auditoria_capturar_regla_aplicacion() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS auditoria_regla_aplicacion ON public.regla_aplicacion;--> statement-breakpoint
CREATE TRIGGER auditoria_regla_aplicacion AFTER INSERT ON public.regla_aplicacion
  FOR EACH ROW EXECUTE FUNCTION public.auditoria_capturar_regla_aplicacion();
