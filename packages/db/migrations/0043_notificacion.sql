-- 0043_notificacion (spec 017, D-8, D-9, P-3, P-4, P-5, P-7). Notificaciones en la app y estado de los avisos del plan.
--   notificacion  RLS ENABLE + FORCE con politicas FOR SELECT y FOR UPDATE por (app.tenant_id, app.user_id); GRANT SELECT y
--                 UPDATE (leida_en) solo a contapp_backend; el worker, contapp_app y contapp_platform sin ningun grant. Trigger
--                 BEFORE UPDATE: solo `leida_en` de NULL a un instante no futuro. Nadie de la app inserta ni borra: insertan los
--                 triggers de aviso en la misma transaccion del hecho (D-9) y borra notificacion_purgar (worker, P-7).
--   plan_aviso    RLS ENABLE + FORCE sin politicas ni grants a la app; lo escribe solo plan_aviso_recalcular. Se siembra con el
--                 uso actual y `alcanzado` ya calculado, ciclo 0, sin notificar (no inunda al desplegar).
--   Funciones SECURITY DEFINER con search_path fijo y sin EXECUTE para PUBLIC. Las que tocan notificacion y plan_aviso (sin
--   politica de escritura) son de contapp_registrador (0041: NOLOGIN, BYPASSRLS, sin miembros y sin grants sobre tablas de antes
--   de 017); las que leen tablas de 005-008 son de contapp_migrator y fijan app.tenant_id al estudio del hecho mientras leen.
--   EXECUTE para la app solo donde lo nombra el plan.
--   notificaciones_de_esta_transaccion() lee los ids que interno.notificar dejo en app.notificaciones_tx (local a la transaccion:
--   se revierte con ella y con un savepoint) y devuelve sus destinatarios del estudio actual.
-- Lo que sigue a las tablas es repetible sentencia a sentencia.
CREATE TABLE "notificacion" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"usuario_id" uuid NOT NULL,
	"tipo" text NOT NULL,
	"cliente_id" uuid,
	"trabajo_id" uuid,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"clave_dedupe" text NOT NULL,
	"creada_en" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"leida_en" timestamp with time zone,
	CONSTRAINT "notificacion_dedupe_unique" UNIQUE("tenant_id","usuario_id","clave_dedupe"),
	CONSTRAINT "notificacion_tipo_valido" CHECK ("notificacion"."tipo" IN ('credencial_invalida', 'trabajo_terminado', 'plan_limite', 'buzon_critico')),
	CONSTRAINT "notificacion_params_objeto" CHECK (jsonb_typeof("notificacion"."params") = 'object' AND pg_column_size("notificacion"."params") <= 1024),
	CONSTRAINT "notificacion_clave_largo" CHECK (char_length("notificacion"."clave_dedupe") BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE TABLE "plan_aviso" (
	"tenant_id" uuid NOT NULL,
	"recurso" text NOT NULL,
	"umbral" smallint NOT NULL,
	"alcanzado" boolean DEFAULT false NOT NULL,
	"ciclo" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "plan_aviso_pk" PRIMARY KEY("tenant_id","recurso","umbral"),
	CONSTRAINT "plan_aviso_recurso_valido" CHECK ("plan_aviso"."recurso" IN ('rucs', 'usuarios')),
	CONSTRAINT "plan_aviso_umbral_valido" CHECK ("plan_aviso"."umbral" IN (90, 100)),
	CONSTRAINT "plan_aviso_ciclo_no_negativo" CHECK ("plan_aviso"."ciclo" >= 0)
);
--> statement-breakpoint
ALTER TABLE "notificacion" ADD CONSTRAINT "notificacion_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_aviso" ADD CONSTRAINT "plan_aviso_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notificacion_usuario_idx" ON "notificacion" USING btree ("tenant_id","usuario_id","creada_en" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notificacion_purga_idx" ON "notificacion" USING btree ("tenant_id","creada_en");--> statement-breakpoint

-- ---- RLS, dueño y grants -------------------------------------------------------------------------------------------------
ALTER TABLE public.notificacion OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.notificacion ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.notificacion FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS notificacion_lectura ON public.notificacion;--> statement-breakpoint
CREATE POLICY notificacion_lectura ON public.notificacion FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
         AND usuario_id = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
DROP POLICY IF EXISTS notificacion_leida ON public.notificacion;--> statement-breakpoint
CREATE POLICY notificacion_leida ON public.notificacion FOR UPDATE
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
         AND usuario_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
              AND usuario_id = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
REVOKE ALL ON public.notificacion
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT SELECT ON public.notificacion TO contapp_backend;--> statement-breakpoint
GRANT UPDATE (leida_en) ON public.notificacion TO contapp_backend;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON public.notificacion TO contapp_registrador;--> statement-breakpoint

ALTER TABLE public.plan_aviso OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.plan_aviso ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.plan_aviso FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON public.plan_aviso
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.plan_aviso TO contapp_registrador;--> statement-breakpoint

-- ---- leida_en: solo de NULL a un instante no futuro; nada mas cambia ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.notificacion_solo_leida() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.leida_en IS NOT NULL OR NEW.leida_en IS NULL OR NEW.leida_en > clock_timestamp()
     OR (NEW.id, NEW.tenant_id, NEW.usuario_id, NEW.tipo, NEW.cliente_id, NEW.trabajo_id, NEW.params, NEW.clave_dedupe, NEW.creada_en)
        IS DISTINCT FROM
        (OLD.id, OLD.tenant_id, OLD.usuario_id, OLD.tipo, OLD.cliente_id, OLD.trabajo_id, OLD.params, OLD.clave_dedupe, OLD.creada_en)
  THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'notificacion: solo se marca como leida una vez';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.notificacion_solo_leida() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.notificacion_solo_leida() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS notificacion_solo_leida ON public.notificacion;--> statement-breakpoint
CREATE TRIGGER notificacion_solo_leida BEFORE UPDATE ON public.notificacion
  FOR EACH ROW EXECUTE FUNCTION public.notificacion_solo_leida();--> statement-breakpoint

-- ---- Insercion con dedupe y registro de la transaccion ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION interno.notificar(
  p_tenant uuid, p_usuarios uuid[], p_tipo text, p_cliente uuid, p_trabajo uuid, p_params jsonb, p_clave text
) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_ids uuid[];
  v_previos text;
BEGIN
  IF p_tenant IS NULL OR p_usuarios IS NULL OR cardinality(p_usuarios) = 0 THEN
    RETURN;
  END IF;
  WITH nuevas AS (
    INSERT INTO public.notificacion AS n (tenant_id, usuario_id, tipo, cliente_id, trabajo_id, params, clave_dedupe)
    SELECT p_tenant, x.u, p_tipo, p_cliente, p_trabajo, p_params, p_clave
      FROM (SELECT DISTINCT u FROM unnest(p_usuarios) AS u WHERE u IS NOT NULL) x
    ON CONFLICT (tenant_id, usuario_id, clave_dedupe) DO NOTHING
    RETURNING n.id
  )
  SELECT array_agg(nuevas.id) INTO v_ids FROM nuevas;
  IF v_ids IS NOT NULL THEN
    v_previos := coalesce(current_setting('app.notificaciones_tx', true), '');
    PERFORM set_config('app.notificaciones_tx',
      v_previos || CASE WHEN v_previos = '' THEN '' ELSE ',' END || array_to_string(v_ids, ','), true);
  END IF;
END
$$;--> statement-breakpoint
ALTER FUNCTION interno.notificar(uuid, uuid[], text, uuid, uuid, jsonb, text) OWNER TO contapp_registrador;--> statement-breakpoint
REVOKE ALL ON FUNCTION interno.notificar(uuid, uuid[], text, uuid, uuid, jsonb, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION interno.notificar(uuid, uuid[], text, uuid, uuid, jsonb, text) TO contapp_migrator;--> statement-breakpoint

-- ---- CA-8 · credencial invalida -> responsable activo del cliente; si no hay, Duenos y Administradores activos (P-4) -----
-- Las funciones de aviso de dueño contapp_migrator (sin BYPASSRLS) leen las tablas de 005 y 008 con app.tenant_id fijado al
-- estudio de la fila y lo devuelven a su valor al terminar (el hecho puede venir de una sesion sin estudio, p. ej. la siembra).
CREATE OR REPLACE FUNCTION public.notificacion_credencial_invalida() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_previo text := current_setting('app.tenant_id', true);
  v_usuarios uuid[];
  v_trabajo_ctx text;
  v_trabajo uuid;
BEGIN
  PERFORM set_config('app.tenant_id', NEW.tenant_id::text, true);
  SELECT array_agg(a.usuario_id) INTO v_usuarios
    FROM public.asignacion a
    JOIN public.membresia m ON m.tenant_id = a.tenant_id AND m.usuario_id = a.usuario_id AND m.desactivada_en IS NULL
   WHERE a.tenant_id = NEW.tenant_id AND a.cliente_id = NEW.cliente_id AND a.tipo = 'responsable';
  IF v_usuarios IS NULL THEN
    SELECT array_agg(m.usuario_id) INTO v_usuarios FROM public.membresia m
     WHERE m.tenant_id = NEW.tenant_id AND m.desactivada_en IS NULL AND m.rol IN ('dueno', 'admin');
  END IF;
  -- El trabajo solo cuenta en el worker y si es del mismo estudio (como el actor de la auditoria).
  IF current_setting('role', true) = 'contapp_worker' THEN
    v_trabajo_ctx := nullif(current_setting('app.trabajo_id', true), '');
    IF v_trabajo_ctx ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      SELECT j.id INTO v_trabajo FROM public.job_registro j WHERE j.id = v_trabajo_ctx::uuid AND j.tenant_id = NEW.tenant_id;
    END IF;
  END IF;
  PERFORM set_config('app.tenant_id', coalesce(v_previo, ''), true);
  PERFORM interno.notificar(NEW.tenant_id, v_usuarios, 'credencial_invalida', NEW.cliente_id, v_trabajo,
    jsonb_build_object('credencial', NEW.tipo),
    'credencial_invalida:' || NEW.id::text || ':'
      || to_char(coalesce(NEW.estado_at, clock_timestamp()) AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS.US'));
  RETURN NULL;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS notificacion_credencial_invalida ON public.credencial;--> statement-breakpoint
CREATE TRIGGER notificacion_credencial_invalida AFTER UPDATE OF estado ON public.credencial
  FOR EACH ROW WHEN (NEW.estado = 'invalida' AND OLD.estado IS DISTINCT FROM 'invalida')
  EXECUTE FUNCTION public.notificacion_credencial_invalida();--> statement-breakpoint

-- ---- CA-9 · trabajo interactivo terminado (ejecutando -> completado | error) -> su creador activo (P-3) -----------------
CREATE OR REPLACE FUNCTION public.notificacion_trabajo_terminado() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_previo text := current_setting('app.tenant_id', true);
  v_activo boolean;
BEGIN
  PERFORM set_config('app.tenant_id', NEW.tenant_id::text, true);
  SELECT EXISTS (SELECT 1 FROM public.membresia m
                  WHERE m.tenant_id = NEW.tenant_id AND m.usuario_id = NEW.creado_por AND m.desactivada_en IS NULL)
    INTO v_activo;
  PERFORM set_config('app.tenant_id', coalesce(v_previo, ''), true);
  IF v_activo THEN
    PERFORM interno.notificar(NEW.tenant_id, ARRAY[NEW.creado_por], 'trabajo_terminado', NEW.cliente_id, NEW.id,
      jsonb_build_object('tipoTrabajo', NEW.tipo, 'estado', NEW.estado, 'motivo', NEW.motivo),
      'trabajo_terminado:' || NEW.id::text);
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS notificacion_trabajo_terminado ON public.job_registro;--> statement-breakpoint
CREATE TRIGGER notificacion_trabajo_terminado AFTER UPDATE OF estado ON public.job_registro
  FOR EACH ROW WHEN (OLD.estado = 'ejecutando' AND NEW.estado IN ('completado', 'error')
                     AND NEW.prioridad = 'interactivo' AND NEW.creado_por IS NOT NULL)
  EXECUTE FUNCTION public.notificacion_trabajo_terminado();--> statement-breakpoint

-- ---- CA-10 · limite del plan (P-5): estado por (estudio, recurso, umbral), serializado por fila ------------------------
-- Uso como usoDelEstudio de 006: RUCs no archivados frente a max_rucs + least(extras contratados, max_rucs_extra); membresias
-- activas + invitaciones vigentes frente a max_usuarios (NULL = sin limite, sin aviso). Una invitacion vigente cuyo correo ya es
-- de un miembro activo no cuenta dos veces (al aceptar, la membresia entra antes de marcar la invitacion). Lo lee
-- interno.uso_plan (dueño contapp_migrator, app.tenant_id fijado al estudio mientras lee); cero filas = estudio sin suscripcion.
CREATE OR REPLACE FUNCTION interno.uso_plan(p_tenant uuid)
  RETURNS TABLE (limite_rucs bigint, rucs bigint, limite_usuarios bigint, usuarios bigint, duenos uuid[])
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_previo text := current_setting('app.tenant_id', true);
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  RETURN QUERY
    SELECT (p.max_rucs + least(coalesce(s.rucs_extra_contratados, 0), coalesce(p.max_rucs_extra, 0)))::bigint,
           (SELECT count(*) FROM public.cliente c WHERE c.tenant_id = p_tenant AND c.archivado_at IS NULL),
           p.max_usuarios::bigint,
           (SELECT count(*) FROM public.membresia m WHERE m.tenant_id = p_tenant AND m.desactivada_en IS NULL)
           + (SELECT count(*) FROM public.invitacion i
               WHERE i.tenant_id = p_tenant AND i.aceptada_en IS NULL AND i.revocada_en IS NULL AND i.vence_en > now()
                 AND NOT EXISTS (SELECT 1 FROM public.membresia m JOIN public.usuario u ON u.id = m.usuario_id
                                  WHERE m.tenant_id = p_tenant AND m.desactivada_en IS NULL AND lower(u.email) = lower(i.correo))),
           coalesce((SELECT array_agg(m.usuario_id ORDER BY m.usuario_id) FROM public.membresia m
                      WHERE m.tenant_id = p_tenant AND m.rol = 'dueno' AND m.desactivada_en IS NULL), '{}'::uuid[])
      FROM public.suscripcion s JOIN public.plan p ON p.id = s.plan_id
     WHERE s.tenant_id = p_tenant;
  PERFORM set_config('app.tenant_id', coalesce(v_previo, ''), true);
END
$$;--> statement-breakpoint
ALTER FUNCTION interno.uso_plan(uuid) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION interno.uso_plan(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION interno.uso_plan(uuid) TO contapp_registrador;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.plan_aviso_recalcular(p_tenant uuid) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  u record;
  r record;
  v_usado bigint;
  v_limite bigint;
  v_alcanza boolean;
BEGIN
  IF p_tenant IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.plan_aviso a WHERE a.tenant_id = p_tenant) THEN
    IF NOT EXISTS (SELECT 1 FROM interno.uso_plan(p_tenant)) THEN
      RETURN; -- estudio sin suscripcion: sin plan no hay limite
    END IF;
    INSERT INTO public.plan_aviso (tenant_id, recurso, umbral)
    VALUES (p_tenant, 'rucs', 90), (p_tenant, 'rucs', 100), (p_tenant, 'usuarios', 90), (p_tenant, 'usuarios', 100)
    ON CONFLICT DO NOTHING;
  END IF;
  -- Serializa con otras transacciones del mismo estudio; el uso de abajo (nueva instantanea) ya ve lo que confirmaron.
  PERFORM 1 FROM public.plan_aviso a WHERE a.tenant_id = p_tenant ORDER BY a.recurso, a.umbral FOR UPDATE;
  SELECT * INTO u FROM interno.uso_plan(p_tenant);
  IF NOT FOUND THEN
    RETURN;
  END IF;
  FOR r IN SELECT a.recurso, a.umbral, a.alcanzado, a.ciclo FROM public.plan_aviso a
            WHERE a.tenant_id = p_tenant ORDER BY a.recurso, a.umbral LOOP
    IF r.recurso = 'rucs' THEN
      v_usado := u.rucs;
      v_limite := u.limite_rucs;
    ELSE
      v_usado := u.usuarios;
      v_limite := u.limite_usuarios;
    END IF;
    v_alcanza := v_limite IS NOT NULL AND v_limite > 0 AND v_usado * 100 >= r.umbral::bigint * v_limite;
    IF v_alcanza AND NOT r.alcanzado THEN
      UPDATE public.plan_aviso a SET alcanzado = true, ciclo = r.ciclo + 1
       WHERE a.tenant_id = p_tenant AND a.recurso = r.recurso AND a.umbral = r.umbral;
      PERFORM interno.notificar(p_tenant, u.duenos, 'plan_limite', NULL, NULL,
        jsonb_build_object('recurso', r.recurso, 'umbral', r.umbral, 'usado', v_usado, 'limite', v_limite),
        'plan_limite:' || r.recurso || ':' || r.umbral::text || ':' || (r.ciclo + 1)::text);
    ELSIF NOT v_alcanza AND r.alcanzado THEN
      UPDATE public.plan_aviso a SET alcanzado = false
       WHERE a.tenant_id = p_tenant AND a.recurso = r.recurso AND a.umbral = r.umbral;
    END IF;
  END LOOP;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.plan_aviso_recalcular(uuid) OWNER TO contapp_registrador;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.plan_aviso_recalcular(uuid)
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.plan_aviso_recalcular(uuid) TO contapp_migrator;--> statement-breakpoint

-- Disparadores por sentencia con tablas de transicion: recalcula una vez por estudio afectado y solo si cambio el uso.
CREATE OR REPLACE FUNCTION public.plan_aviso_disparar() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  t uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    FOR t IN SELECT DISTINCT n.tenant_id FROM nuevas n ORDER BY 1 LOOP
      PERFORM public.plan_aviso_recalcular(t);
    END LOOP;
  ELSIF TG_TABLE_NAME = 'cliente' THEN
    FOR t IN SELECT DISTINCT n.tenant_id FROM nuevas n JOIN viejas o ON o.id = n.id
              WHERE (o.archivado_at IS NULL) IS DISTINCT FROM (n.archivado_at IS NULL) ORDER BY 1 LOOP
      PERFORM public.plan_aviso_recalcular(t);
    END LOOP;
  ELSIF TG_TABLE_NAME = 'membresia' THEN
    FOR t IN SELECT DISTINCT n.tenant_id FROM nuevas n JOIN viejas o ON o.id = n.id
              WHERE (o.desactivada_en IS NULL) IS DISTINCT FROM (n.desactivada_en IS NULL) ORDER BY 1 LOOP
      PERFORM public.plan_aviso_recalcular(t);
    END LOOP;
  ELSIF TG_TABLE_NAME = 'invitacion' THEN
    FOR t IN SELECT DISTINCT n.tenant_id FROM nuevas n JOIN viejas o ON o.id = n.id
              WHERE (o.aceptada_en IS NULL) IS DISTINCT FROM (n.aceptada_en IS NULL)
                 OR (o.revocada_en IS NULL) IS DISTINCT FROM (n.revocada_en IS NULL)
                 OR (o.vence_en > now()) IS DISTINCT FROM (n.vence_en > now()) ORDER BY 1 LOOP
      PERFORM public.plan_aviso_recalcular(t);
    END LOOP;
  ELSE
    FOR t IN SELECT DISTINCT n.tenant_id FROM nuevas n ORDER BY 1 LOOP
      PERFORM public.plan_aviso_recalcular(t);
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS plan_aviso_alta ON public.cliente;--> statement-breakpoint
CREATE TRIGGER plan_aviso_alta AFTER INSERT ON public.cliente
  REFERENCING NEW TABLE AS nuevas FOR EACH STATEMENT EXECUTE FUNCTION public.plan_aviso_disparar();--> statement-breakpoint
DROP TRIGGER IF EXISTS plan_aviso_cambio ON public.cliente;--> statement-breakpoint
CREATE TRIGGER plan_aviso_cambio AFTER UPDATE ON public.cliente
  REFERENCING OLD TABLE AS viejas NEW TABLE AS nuevas FOR EACH STATEMENT EXECUTE FUNCTION public.plan_aviso_disparar();--> statement-breakpoint
DROP TRIGGER IF EXISTS plan_aviso_alta ON public.membresia;--> statement-breakpoint
CREATE TRIGGER plan_aviso_alta AFTER INSERT ON public.membresia
  REFERENCING NEW TABLE AS nuevas FOR EACH STATEMENT EXECUTE FUNCTION public.plan_aviso_disparar();--> statement-breakpoint
DROP TRIGGER IF EXISTS plan_aviso_cambio ON public.membresia;--> statement-breakpoint
CREATE TRIGGER plan_aviso_cambio AFTER UPDATE ON public.membresia
  REFERENCING OLD TABLE AS viejas NEW TABLE AS nuevas FOR EACH STATEMENT EXECUTE FUNCTION public.plan_aviso_disparar();--> statement-breakpoint
DROP TRIGGER IF EXISTS plan_aviso_alta ON public.invitacion;--> statement-breakpoint
CREATE TRIGGER plan_aviso_alta AFTER INSERT ON public.invitacion
  REFERENCING NEW TABLE AS nuevas FOR EACH STATEMENT EXECUTE FUNCTION public.plan_aviso_disparar();--> statement-breakpoint
DROP TRIGGER IF EXISTS plan_aviso_cambio ON public.invitacion;--> statement-breakpoint
CREATE TRIGGER plan_aviso_cambio AFTER UPDATE ON public.invitacion
  REFERENCING OLD TABLE AS viejas NEW TABLE AS nuevas FOR EACH STATEMENT EXECUTE FUNCTION public.plan_aviso_disparar();--> statement-breakpoint
DROP TRIGGER IF EXISTS plan_aviso_cambio ON public.suscripcion;--> statement-breakpoint
CREATE TRIGGER plan_aviso_cambio AFTER UPDATE ON public.suscripcion
  REFERENCING OLD TABLE AS viejas NEW TABLE AS nuevas FOR EACH STATEMENT EXECUTE FUNCTION public.plan_aviso_disparar();--> statement-breakpoint

-- ---- Destinatarios de esta transaccion (aviso en vivo tras el commit) y purga (P-7) --------------------------------------
CREATE OR REPLACE FUNCTION public.notificaciones_de_esta_transaccion() RETURNS SETOF uuid
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT DISTINCT n.usuario_id FROM public.notificacion n
   WHERE n.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
     AND n.id = ANY (ARRAY(
       SELECT x::uuid FROM unnest(string_to_array(coalesce(current_setting('app.notificaciones_tx', true), ''), ',')) AS x
        WHERE x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
$$;--> statement-breakpoint
ALTER FUNCTION public.notificaciones_de_esta_transaccion() OWNER TO contapp_registrador;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.notificaciones_de_esta_transaccion()
  FROM PUBLIC, contapp_platform, contapp_app, contapp_auth, contapp_enumerador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.notificaciones_de_esta_transaccion() TO contapp_backend, contapp_worker;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.notificacion_purgar(p_dias integer) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  v_n integer;
BEGIN
  IF p_dias IS NULL OR p_dias < 1 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'notificacion_purgar: minimo 1 dia';
  END IF;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'notificacion_purgar: sesion sin estudio';
  END IF;
  DELETE FROM public.notificacion n WHERE n.tenant_id = v_tenant AND n.creada_en < now() - make_interval(days => p_dias);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.notificacion_purgar(integer) OWNER TO contapp_registrador;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.notificacion_purgar(integer)
  FROM PUBLIC, contapp_backend, contapp_platform, contapp_app, contapp_auth, contapp_enumerador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.notificacion_purgar(integer) TO contapp_worker;--> statement-breakpoint

-- ---- Dueño y EXECUTE de las funciones de trigger de aviso (contapp_migrator, como las capturas) -------------------------
ALTER FUNCTION public.notificacion_credencial_invalida() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.notificacion_credencial_invalida() FROM PUBLIC;--> statement-breakpoint
ALTER FUNCTION public.notificacion_trabajo_terminado() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.notificacion_trabajo_terminado() FROM PUBLIC;--> statement-breakpoint
ALTER FUNCTION public.plan_aviso_disparar() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.plan_aviso_disparar() FROM PUBLIC;--> statement-breakpoint

-- ---- Siembra: uso actual, `alcanzado` ya calculado, ciclo 0 y sin notificar ---------------------------------------------
INSERT INTO public.plan_aviso (tenant_id, recurso, umbral, alcanzado, ciclo)
SELECT u.tenant_id, x.recurso, x.umbral,
       CASE WHEN x.recurso = 'rucs' THEN u.lim_rucs > 0 AND u.rucs * 100 >= x.umbral::bigint * u.lim_rucs
            ELSE u.max_usuarios IS NOT NULL AND u.max_usuarios > 0 AND u.usuarios * 100 >= x.umbral::bigint * u.max_usuarios END,
       0
  FROM (
    SELECT s.tenant_id,
           p.max_rucs + least(s.rucs_extra_contratados, p.max_rucs_extra) AS lim_rucs,
           p.max_usuarios,
           (SELECT count(*) FROM public.cliente c WHERE c.tenant_id = s.tenant_id AND c.archivado_at IS NULL) AS rucs,
           (SELECT count(*) FROM public.membresia m WHERE m.tenant_id = s.tenant_id AND m.desactivada_en IS NULL)
           + (SELECT count(*) FROM public.invitacion i
               WHERE i.tenant_id = s.tenant_id AND i.aceptada_en IS NULL AND i.revocada_en IS NULL AND i.vence_en > now()
                 AND NOT EXISTS (SELECT 1 FROM public.membresia m JOIN public.usuario w ON w.id = m.usuario_id
                                  WHERE m.tenant_id = s.tenant_id AND m.desactivada_en IS NULL AND lower(w.email) = lower(i.correo)))
             AS usuarios
      FROM public.suscripcion s JOIN public.plan p ON p.id = s.plan_id
  ) u
  CROSS JOIN (VALUES ('rucs', 90), ('rucs', 100), ('usuarios', 90), ('usuarios', 100)) AS x(recurso, umbral)
ON CONFLICT DO NOTHING;
