-- 0055_buzon_programacion (spec 023, D-5, D-6; CA-1, CA-2, CA-11). Programador del buzón SOL: candado del ciclo en BD y funciones
-- acotadas. Parte generada por drizzle-kit (buzon_programacion); lo que sigue es repetible (INSERT ... ON CONFLICT DO NOTHING,
-- CREATE OR REPLACE, GRANT/REVOKE).
--   buzon_programacion  fila única (id = 1). Sin ningún privilegio para los roles de la app: RLS ENABLE sin políticas (sin FORCE:
--                       solo su dueño, contapp_migrator, la lee y escribe, y únicamente desde las funciones sistema.buzon_ciclo_*).
--   Funciones SECURITY DEFINER de contapp_migrator (sin superusuario ni BYPASSRLS: la RLS FORCE de las tablas de negocio aplica
--   dentro), search_path fijo y errores de mensaje fijo (nunca ids ni RUC). EXECUTE solo a contapp_worker, salvo
--   buzon_elevar_prioridad y buzon_estado_bloquear (solo contapp_backend).
--   sistema.buzon_ciclo_tomar(dueño)    una sola sentencia UPDATE ... RETURNING: el bloqueo de la fila serializa a los workers y
--                                       la condición se reevalúa sobre la fila confirmada (READ COMMITTED). Candado de 5 min con
--                                       vencimiento; el intervalo se mide desde el INICIO del último ciclo con el reloj de la BD.
--   sistema.buzon_ciclo_renovar/soltar  solo el dueño con el candado vigente renueva; soltar fija ultimo_ciclo_fin.
--   sistema.estudios_buzon()            (tenant_id, frecuencia_min) de los estudios con suscripción activa o prueba vigente. Lee la
--                                       suscripción de cada estudio con app.tenant_id fijado a ese estudio (sistema.estudios_ids, de
--                                       0018, enumera; contapp_migrator recibe EXECUTE sobre ella) y lo devuelve a su valor.
--   buzon_candidatos()                  clientes del estudio de la sesión, no archivados, con credencial SOL configurada o
--                                       verificada y sin captura viva (sol.buzon.revisar en_cola o ejecutando).
--   encolar_buzon_programados(ids)      orden de bloqueo del plan: primero crea (si falta) y bloquea la fila de estado de cada
--                                       cliente en orden de id, luego el candado del tope (estudio, cola sol) de insertarTrabajo y
--                                       recién entonces revalida e inserta. Así no se interbloquea con «Revisar ahora» (estado ->
--                                       trabajo). Lo que ya no cumple se omite sin consumir la franja.
--   buzon_elevar_prioridad(trabajo)     sol.buzon.revisar en_cola y programado del estudio -> interactivo; nada más cambia.
--   buzon_estado_bloquear(cliente)      (decisión del orquestador, punto 2 de T4) «Revisar ahora» antes del primer ciclo: crea la
--                                       fila de estado si falta (ON CONFLICT DO NOTHING) y la bloquea FOR UPDATE, sin dar INSERT al
--                                       backend. Devuelve el estado del cliente.
CREATE TABLE "buzon_programacion" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"intervalo_min" integer DEFAULT 15 NOT NULL,
	"reserva_interactiva" integer DEFAULT 50 NOT NULL,
	"lote_estudio" integer DEFAULT 1000 NOT NULL,
	"ciclo_dueno" text,
	"ciclo_hasta" timestamp with time zone,
	"ultimo_ciclo_inicio" timestamp with time zone,
	"ultimo_ciclo_fin" timestamp with time zone,
	CONSTRAINT "buzon_programacion_fila_unica" CHECK ("buzon_programacion"."id" = 1),
	CONSTRAINT "buzon_programacion_intervalo" CHECK ("buzon_programacion"."intervalo_min" BETWEEN 5 AND 120),
	CONSTRAINT "buzon_programacion_reserva" CHECK ("buzon_programacion"."reserva_interactiva" >= 0),
	CONSTRAINT "buzon_programacion_lote" CHECK ("buzon_programacion"."lote_estudio" BETWEEN 1 AND 10000),
	CONSTRAINT "buzon_programacion_dueno_largo" CHECK (char_length("buzon_programacion"."ciclo_dueno") BETWEEN 1 AND 100)
);
--> statement-breakpoint

ALTER TABLE public.buzon_programacion OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.buzon_programacion ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON public.buzon_programacion
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
INSERT INTO public.buzon_programacion (id) VALUES (1) ON CONFLICT (id) DO NOTHING;--> statement-breakpoint

-- ---- Candado del ciclo ---------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sistema.buzon_ciclo_tomar(p_dueno text)
  RETURNS TABLE (ahora timestamptz, intervalo_min integer, reserva_interactiva integer, lote_estudio integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_ahora timestamptz := clock_timestamp();
BEGIN
  IF p_dueno IS NULL OR char_length(p_dueno) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'buzon_ciclo_tomar: dueno invalido';
  END IF;
  RETURN QUERY
    UPDATE public.buzon_programacion p
       SET ciclo_dueno = p_dueno,
           ciclo_hasta = v_ahora + interval '5 minutes',
           ultimo_ciclo_inicio = v_ahora
     WHERE p.id = 1
       AND (p.ciclo_hasta IS NULL OR p.ciclo_hasta < v_ahora)
       AND (p.ultimo_ciclo_inicio IS NULL OR v_ahora - p.ultimo_ciclo_inicio >= make_interval(mins => p.intervalo_min))
    RETURNING v_ahora, p.intervalo_min, p.reserva_interactiva, p.lote_estudio;
END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION sistema.buzon_ciclo_renovar(p_dueno text) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_ahora timestamptz := clock_timestamp();
BEGIN
  IF p_dueno IS NULL OR char_length(p_dueno) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'buzon_ciclo_renovar: dueno invalido';
  END IF;
  UPDATE public.buzon_programacion p
     SET ciclo_hasta = v_ahora + interval '5 minutes'
   WHERE p.id = 1 AND p.ciclo_dueno = p_dueno AND p.ciclo_hasta IS NOT NULL AND p.ciclo_hasta >= v_ahora;
  RETURN FOUND;
END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION sistema.buzon_ciclo_soltar(p_dueno text) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_dueno IS NULL OR char_length(p_dueno) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'buzon_ciclo_soltar: dueno invalido';
  END IF;
  UPDATE public.buzon_programacion p
     SET ultimo_ciclo_fin = clock_timestamp(), ciclo_hasta = NULL
   WHERE p.id = 1 AND p.ciclo_dueno = p_dueno AND p.ciclo_hasta IS NOT NULL;
END
$$;--> statement-breakpoint

-- ---- Estudios con suscripción vigente ------------------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION sistema.estudios_ids() TO contapp_migrator;--> statement-breakpoint
CREATE OR REPLACE FUNCTION sistema.estudios_buzon() RETURNS TABLE (tenant_id uuid, frecuencia_min integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_previo text := current_setting('app.tenant_id', true);
  v_estudio uuid;
  v_frecuencia integer;
BEGIN
  FOR v_estudio IN SELECT e.e FROM sistema.estudios_ids() AS e(e) LOOP
    PERFORM set_config('app.tenant_id', v_estudio::text, true);
    SELECT p.frecuencia_buzon_min INTO v_frecuencia
      FROM public.suscripcion s JOIN public.plan p ON p.id = s.plan_id
     WHERE s.tenant_id = v_estudio
       AND (s.estado = 'activa' OR (s.estado = 'prueba' AND s.prueba_vence_en > clock_timestamp()));
    IF FOUND THEN
      tenant_id := v_estudio;
      frecuencia_min := v_frecuencia;
      RETURN NEXT;
    END IF;
  END LOOP;
  PERFORM set_config('app.tenant_id', coalesce(v_previo, ''), true);
END
$$;--> statement-breakpoint

-- ---- Candidatos del estudio de la sesión ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.buzon_candidatos()
  RETURNS TABLE (cliente_id uuid, ultima_programada_en timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'buzon_candidatos: sesion sin estudio';
  END IF;
  RETURN QUERY
    SELECT c.id, e.ultima_programada_en
      FROM public.cliente c
      LEFT JOIN public.buzon_estado_cliente e ON e.tenant_id = c.tenant_id AND e.cliente_id = c.id
     WHERE c.tenant_id = v_tenant AND c.archivado_at IS NULL
       AND EXISTS (SELECT 1 FROM public.credencial k
                    WHERE k.tenant_id = c.tenant_id AND k.cliente_id = c.id AND k.tipo = 'sol'
                      AND k.estado IN ('configurada', 'verificada'))
       AND NOT EXISTS (SELECT 1 FROM public.job_registro j
                        WHERE j.tenant_id = c.tenant_id AND j.cliente_id = c.id AND j.tipo = 'sol.buzon.revisar'
                          AND j.estado IN ('en_cola', 'ejecutando'))
     ORDER BY c.id;
END
$$;--> statement-breakpoint

-- ---- Encolado programado -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.encolar_buzon_programados(p_clientes uuid[]) RETURNS SETOF uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  v_lote integer;
  v_reserva integer;
  v_reintentos integer;
  v_max integer;
  v_pendientes bigint;
  v_ids uuid[];
  v_cliente uuid;
  v_ruc text;
  v_clave bytea;
  v_id uuid;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'encolar_buzon_programados: sesion sin estudio';
  END IF;
  SELECT p.lote_estudio, p.reserva_interactiva INTO v_lote, v_reserva FROM public.buzon_programacion p WHERE p.id = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'encolar_buzon_programados: programacion sin configurar';
  END IF;
  IF p_clientes IS NULL OR coalesce(array_ndims(p_clientes), 0) <> 1 OR cardinality(p_clientes) < 1
     OR cardinality(p_clientes) > v_lote OR array_position(p_clientes, NULL) IS NOT NULL
     OR (SELECT count(DISTINCT x) FROM unnest(p_clientes) AS x) <> cardinality(p_clientes) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'encolar_buzon_programados: parametro invalido';
  END IF;
  v_ids := ARRAY(SELECT x FROM unnest(p_clientes) AS x ORDER BY x);
  IF (SELECT count(*) FROM public.cliente c WHERE c.tenant_id = v_tenant AND c.id = ANY (v_ids)) <> cardinality(v_ids) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'encolar_buzon_programados: cliente desconocido';
  END IF;
  -- Estudio sin suscripción vigente: nada que encolar (sin error, sin consumir franjas).
  IF NOT EXISTS (SELECT 1 FROM public.suscripcion s
                  WHERE s.tenant_id = v_tenant
                    AND (s.estado = 'activa' OR (s.estado = 'prueba' AND s.prueba_vence_en > clock_timestamp()))) THEN
    RETURN;
  END IF;

  -- 1) Estado de cada cliente, creado si falta y bloqueado en orden de id (antes que cualquier trabajo).
  INSERT INTO public.buzon_estado_cliente (tenant_id, cliente_id)
    SELECT v_tenant, x FROM unnest(v_ids) AS x ORDER BY x
  ON CONFLICT (tenant_id, cliente_id) DO NOTHING;
  PERFORM 1 FROM public.buzon_estado_cliente e
   WHERE e.tenant_id = v_tenant AND e.cliente_id = ANY (v_ids)
   ORDER BY e.cliente_id
   FOR UPDATE;

  -- 2) Tope atómico con el mismo candado (estudio normalizado, cola) que insertarTrabajo y encolar_xml_obtener.
  SELECT cs.reintentos, cs.max_pendientes_tenant INTO v_reintentos, v_max FROM public.config_sistema cs WHERE cs.cola = 'sol';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'encolar_buzon_programados: cola sin configurar';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('job_registro.pendientes:' || v_tenant::text || ':sol', 0));
  SELECT count(*) INTO v_pendientes FROM public.job_registro j
   WHERE j.tenant_id = v_tenant AND j.cola = 'sol' AND j.estado = 'en_cola';

  -- 3) Revalidación con el estado bloqueado e inserción, en orden de id, mientras haya cupo.
  FOREACH v_cliente IN ARRAY v_ids LOOP
    EXIT WHEN v_pendientes >= v_max - v_reserva;
    SELECT c.ruc INTO v_ruc FROM public.cliente c
     WHERE c.tenant_id = v_tenant AND c.id = v_cliente AND c.archivado_at IS NULL;
    CONTINUE WHEN NOT FOUND;
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM public.credencial k
                               WHERE k.tenant_id = v_tenant AND k.cliente_id = v_cliente AND k.tipo = 'sol'
                                 AND k.estado IN ('configurada', 'verificada'));
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.job_registro j
                           WHERE j.tenant_id = v_tenant AND j.cliente_id = v_cliente AND j.tipo = 'sol.buzon.revisar'
                             AND j.estado IN ('en_cola', 'ejecutando'));
    -- JSON canónico de claveDedupe (@contapp/queue): ["sol.buzon.revisar","<cliente>",{}].
    v_clave := sha256(convert_to('["sol.buzon.revisar",' || to_json(v_cliente)::text || ',{}]', 'UTF8'));
    v_id := NULL;
    INSERT INTO public.job_registro AS j
      (cliente_id, ruc, tipo, cola, canal, prioridad, estado, parametros, clave_dedupe, creado_por, max_intentos)
    VALUES
      (v_cliente, v_ruc, 'sol.buzon.revisar', 'sol', 'sol', 'programado', 'en_cola', '{}'::jsonb, v_clave, NULL,
       (v_reintentos + 1)::smallint)
    ON CONFLICT (tenant_id, clave_dedupe) WHERE estado IN ('en_cola', 'ejecutando') DO NOTHING
    RETURNING j.id INTO v_id;
    CONTINUE WHEN v_id IS NULL;
    UPDATE public.buzon_estado_cliente e SET ultima_programada_en = clock_timestamp()
     WHERE e.tenant_id = v_tenant AND e.cliente_id = v_cliente;
    v_pendientes := v_pendientes + 1;
    RETURN NEXT v_id;
  END LOOP;
END
$$;--> statement-breakpoint

-- ---- Bajo demanda (backend) ----------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.buzon_elevar_prioridad(p_trabajo uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'buzon_elevar_prioridad: sesion sin estudio';
  END IF;
  UPDATE public.job_registro j SET prioridad = 'interactivo'
   WHERE j.tenant_id = v_tenant AND j.id = p_trabajo AND j.tipo = 'sol.buzon.revisar'
     AND j.estado = 'en_cola' AND j.prioridad = 'programado';
  RETURN FOUND;
END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.buzon_estado_bloquear(p_cliente uuid)
  RETURNS TABLE (ultima_programada_en timestamptz, ultima_solicitud_en timestamptz, ultima_captura_en timestamptz,
                 sincronizado_en timestamptz, cursor_pendiente text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'buzon_estado_bloquear: sesion sin estudio';
  END IF;
  IF p_cliente IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'buzon_estado_bloquear: parametro invalido';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cliente c WHERE c.tenant_id = v_tenant AND c.id = p_cliente) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'buzon_estado_bloquear: cliente desconocido';
  END IF;
  INSERT INTO public.buzon_estado_cliente (tenant_id, cliente_id) VALUES (v_tenant, p_cliente)
  ON CONFLICT (tenant_id, cliente_id) DO NOTHING;
  RETURN QUERY
    SELECT e.ultima_programada_en, e.ultima_solicitud_en, e.ultima_captura_en, e.sincronizado_en, e.cursor_pendiente
      FROM public.buzon_estado_cliente e
     WHERE e.tenant_id = v_tenant AND e.cliente_id = p_cliente
       FOR UPDATE;
END
$$;--> statement-breakpoint

-- ---- Dueño, EXECUTE y nada para PUBLIC -----------------------------------------------------------------------------------
ALTER FUNCTION sistema.buzon_ciclo_tomar(text) OWNER TO contapp_migrator;--> statement-breakpoint
ALTER FUNCTION sistema.buzon_ciclo_renovar(text) OWNER TO contapp_migrator;--> statement-breakpoint
ALTER FUNCTION sistema.buzon_ciclo_soltar(text) OWNER TO contapp_migrator;--> statement-breakpoint
ALTER FUNCTION sistema.estudios_buzon() OWNER TO contapp_migrator;--> statement-breakpoint
ALTER FUNCTION public.buzon_candidatos() OWNER TO contapp_migrator;--> statement-breakpoint
ALTER FUNCTION public.encolar_buzon_programados(uuid[]) OWNER TO contapp_migrator;--> statement-breakpoint
ALTER FUNCTION public.buzon_elevar_prioridad(uuid) OWNER TO contapp_migrator;--> statement-breakpoint
ALTER FUNCTION public.buzon_estado_bloquear(uuid) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION sistema.buzon_ciclo_tomar(text)
  FROM PUBLIC, contapp_backend, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
REVOKE ALL ON FUNCTION sistema.buzon_ciclo_renovar(text)
  FROM PUBLIC, contapp_backend, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
REVOKE ALL ON FUNCTION sistema.buzon_ciclo_soltar(text)
  FROM PUBLIC, contapp_backend, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
REVOKE ALL ON FUNCTION sistema.estudios_buzon()
  FROM PUBLIC, contapp_backend, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.buzon_candidatos()
  FROM PUBLIC, contapp_backend, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.encolar_buzon_programados(uuid[])
  FROM PUBLIC, contapp_backend, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.buzon_elevar_prioridad(uuid)
  FROM PUBLIC, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.buzon_estado_bloquear(uuid)
  FROM PUBLIC, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION sistema.buzon_ciclo_tomar(text) TO contapp_worker;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION sistema.buzon_ciclo_renovar(text) TO contapp_worker;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION sistema.buzon_ciclo_soltar(text) TO contapp_worker;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION sistema.estudios_buzon() TO contapp_worker;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.buzon_candidatos() TO contapp_worker;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.encolar_buzon_programados(uuid[]) TO contapp_worker;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.buzon_elevar_prioridad(uuid) TO contapp_backend;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.buzon_estado_bloquear(uuid) TO contapp_backend;
