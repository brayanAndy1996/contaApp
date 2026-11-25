-- 0076_correo_r2 (spec 028, T20: hallazgos de la ronda adversarial 2, decisiones del 2026-11-24 en tasks.md, resultado de T19). Repetible
-- (DROP CONSTRAINT IF EXISTS antes del ADD, CREATE OR REPLACE, REVOKE/GRANT). Las funciones conservan firma, dueño, SECURITY DEFINER,
-- search_path = pg_catalog, pg_temp y sus SQLSTATE y mensajes fijos de 0074/0075; sin EXCEPTION ni SAVEPOINT. Sin funciones ni tablas
-- nuevas (escalada.adv.spec.ts y catalogo.spec.ts no cambian).
--   H-028-2-1  sistema.correo_ciclo_renovar: el dueño renueva su candado aunque haya vencido mientras nadie más lo tomó (un estudio de
--              más de 90 s no corta el ciclo); devuelve false solo si otro lo tomó o si ya se soltó.
--   H-028-2-3  interno.notificar: la ventana de 10 min corre desde el último envío `enviado` o `pendiente`, nunca desde un omitido.
--   H-028-2-7  correo_envio.motivo admite `fuera_de_dia` (CHECK y correo_envio_cerrar): un resumen que al enviarse ya no es de su día de
--              Lima no sale (R-5) y no avanza el corte; crear_correo_resumenes desune sus diferidos, que van al resumen siguiente.
--   (H-028-2-2, H-028-2-5, H-028-2-6 y H-028-2-8 no tocan la BD: worker, dominio y backend. H-028-2-4 se acepta: U-16.)

-- ---- H-028-2-7: motivo `fuera_de_dia` ------------------------------------------------------------------------------------------
ALTER TABLE "correo_envio" DROP CONSTRAINT IF EXISTS "correo_envio_motivo_valido";--> statement-breakpoint
ALTER TABLE "correo_envio" ADD CONSTRAINT "correo_envio_motivo_valido" CHECK (("correo_envio"."estado" IN ('pendiente', 'enviado') AND "correo_envio"."motivo" IS NULL) OR ("correo_envio"."estado" = 'omitido' AND "correo_envio"."motivo" IN ('membresia_inactiva', 'sin_correo', 'preferencia_apagada', 'sin_plan', 'sin_contenido', 'sin_novedades', 'fuera_de_dia')) OR ("correo_envio"."estado" = 'fallido' AND "correo_envio"."motivo" = 'transporte'));--> statement-breakpoint

-- ---- H-028-2-1: el dueño renueva su candado vencido si nadie lo tomó (sistema.correo_ciclo_renovar de 0075) ----------------------
CREATE OR REPLACE FUNCTION sistema.correo_ciclo_renovar(p_dueno text) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_ahora timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF p_dueno IS NULL OR pg_catalog.char_length(p_dueno) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'correo_ciclo_renovar: dueno invalido';
  END IF;
  UPDATE public.correo_programacion g SET ciclo_hasta = v_ahora + interval '90 seconds'
   WHERE g.id = 1 AND g.ciclo_dueno = p_dueno AND g.ciclo_hasta IS NOT NULL;
  RETURN FOUND;
END
$$;--> statement-breakpoint

-- ---- H-028-2-3: ventana desde el último correo enviado o en curso (interno.notificar de 0075, misma firma) ------------------------
CREATE OR REPLACE FUNCTION interno.notificar(
  p_tenant uuid, p_usuarios uuid[], p_tipo text, p_cliente uuid, p_trabajo uuid, p_params jsonb, p_clave text
) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_ids uuid[];
  v_usuarios uuid[];
  v_creadas timestamptz[];
  v_previos text;
  v_lista text[];
  v_hecho integer;
  v_n_ids integer;
  -- filas a registrar (todas las del estudio que toca)
  r_t uuid[];
  r_u uuid[];
  r_id uuid[];
  r_creada timestamptz[];
  r_tipo text[];
  r_cliente uuid[];
  r_mensaje uuid[];
  r_categoria text[];
  r_recurso text[];
  r_umbral smallint[];
  -- filas del estudio con la preferencia activa
  f_u uuid[];
  f_id uuid[];
  f_creada timestamptz[];
  f_tipo text[];
  f_cliente uuid[];
  f_mensaje uuid[];
  f_categoria text[];
  f_recurso text[];
  f_umbral smallint[];
  -- grupos (usuario, tipo) con su envío
  g_u uuid[];
  g_tipo text[];
  g_envio uuid[];
  v_t uuid;
  v_ventana integer;
  v_tope integer;
  v_ahora timestamptz;
  v_dia_inicio timestamptz;
  v_n bigint;
  v_prev timestamptz;
  v_envio uuid;
  g record;
BEGIN
  IF p_tenant IS NULL OR p_usuarios IS NULL THEN
    RETURN;
  END IF;
  IF cardinality(p_usuarios) = 0 THEN
    IF p_tipo IS DISTINCT FROM 'correo_lote' THEN
      RETURN;
    END IF;
    -- Cierre del lote: las notificaciones de la transacción sin aviso, desde la última llamada de cierre.
    v_lista := string_to_array(coalesce(current_setting('app.notificaciones_tx', true), ''), ',');
    v_hecho := coalesce(nullif(current_setting('app.correo_hecho', true), '')::integer, 0);
    v_n_ids := coalesce(cardinality(v_lista), 0);
    PERFORM set_config('app.correo_hecho', v_n_ids::text, true);
    IF v_n_ids <= v_hecho THEN
      RETURN;
    END IF;
    SELECT array_agg(n.tenant_id ORDER BY n.tenant_id, n.usuario_id, n.creada_en, n.id),
           array_agg(n.usuario_id ORDER BY n.tenant_id, n.usuario_id, n.creada_en, n.id),
           array_agg(n.id ORDER BY n.tenant_id, n.usuario_id, n.creada_en, n.id),
           array_agg(n.creada_en ORDER BY n.tenant_id, n.usuario_id, n.creada_en, n.id),
           array_agg(n.tipo ORDER BY n.tenant_id, n.usuario_id, n.creada_en, n.id),
           array_agg(n.cliente_id ORDER BY n.tenant_id, n.usuario_id, n.creada_en, n.id),
           array_agg(CASE WHEN n.tipo = 'buzon_critico'
                           AND (n.params ->> 'mensajeId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                          THEN (n.params ->> 'mensajeId')::uuid END ORDER BY n.tenant_id, n.usuario_id, n.creada_en, n.id),
           array_agg(CASE WHEN n.tipo = 'buzon_critico' AND (n.params ->> 'categoria') ~ '^[a-z_]{1,40}$'
                          THEN n.params ->> 'categoria' END ORDER BY n.tenant_id, n.usuario_id, n.creada_en, n.id),
           array_agg(CASE WHEN n.tipo = 'plan_limite' AND (n.params ->> 'recurso') IN ('rucs', 'usuarios')
                          THEN n.params ->> 'recurso' END ORDER BY n.tenant_id, n.usuario_id, n.creada_en, n.id),
           array_agg(CASE WHEN n.tipo = 'plan_limite' AND (n.params ->> 'umbral') IN ('90', '100')
                          THEN (n.params ->> 'umbral')::smallint END ORDER BY n.tenant_id, n.usuario_id, n.creada_en, n.id)
      INTO r_t, r_u, r_id, r_creada, r_tipo, r_cliente, r_mensaje, r_categoria, r_recurso, r_umbral
      FROM public.notificacion n
     WHERE n.id = ANY (v_lista[v_hecho + 1:v_n_ids]::uuid[])
       AND n.tipo IN ('buzon_critico', 'credencial_invalida', 'plan_limite')
       AND NOT EXISTS (SELECT 1 FROM public.correo_envio_aviso a WHERE a.tenant_id = n.tenant_id AND a.notificacion_id = n.id);
    IF r_id IS NULL THEN
      RETURN;
    END IF;
  ELSE
    WITH nuevas AS (
      INSERT INTO public.notificacion AS n (tenant_id, usuario_id, tipo, cliente_id, trabajo_id, params, clave_dedupe)
      SELECT p_tenant, x.u, p_tipo, p_cliente, p_trabajo, p_params, p_clave
        FROM (SELECT DISTINCT u FROM unnest(p_usuarios) AS u WHERE u IS NOT NULL) x
      ON CONFLICT (tenant_id, usuario_id, clave_dedupe) DO NOTHING
      RETURNING n.id, n.usuario_id, n.creada_en
    )
    SELECT array_agg(nuevas.id ORDER BY nuevas.usuario_id), array_agg(nuevas.usuario_id ORDER BY nuevas.usuario_id),
           array_agg(nuevas.creada_en ORDER BY nuevas.usuario_id)
      INTO v_ids, v_usuarios, v_creadas
      FROM nuevas;
    IF v_ids IS NULL THEN
      RETURN;
    END IF;
    v_previos := coalesce(current_setting('app.notificaciones_tx', true), '');
    PERFORM set_config('app.notificaciones_tx',
      v_previos || CASE WHEN v_previos = '' THEN '' ELSE ',' END || array_to_string(v_ids, ','), true);
    -- 028: solo los tipos de U-1 van por correo (trabajo_terminado nunca); en el lote, los registra la llamada de cierre.
    IF p_tipo NOT IN ('buzon_critico', 'credencial_invalida', 'plan_limite')
       OR current_setting('app.correo_lote', true) = 'on' THEN
      RETURN;
    END IF;
    r_t := array_fill(p_tenant, ARRAY[cardinality(v_ids)]);
    r_u := v_usuarios;
    r_id := v_ids;
    r_creada := v_creadas;
    r_tipo := array_fill(p_tipo, ARRAY[cardinality(v_ids)]);
    r_cliente := array_fill(p_cliente, ARRAY[cardinality(v_ids)]);
    r_mensaje := array_fill(CASE WHEN p_tipo = 'buzon_critico'
                                  AND (p_params ->> 'mensajeId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                 THEN (p_params ->> 'mensajeId')::uuid END, ARRAY[cardinality(v_ids)]);
    r_categoria := array_fill(CASE WHEN p_tipo = 'buzon_critico' AND (p_params ->> 'categoria') ~ '^[a-z_]{1,40}$'
                                   THEN p_params ->> 'categoria' END, ARRAY[cardinality(v_ids)]);
    r_recurso := array_fill(CASE WHEN p_tipo = 'plan_limite' AND (p_params ->> 'recurso') IN ('rucs', 'usuarios')
                                 THEN p_params ->> 'recurso' END, ARRAY[cardinality(v_ids)]);
    r_umbral := array_fill(CASE WHEN p_tipo = 'plan_limite' AND (p_params ->> 'umbral') IN ('90', '100')
                                THEN (p_params ->> 'umbral')::smallint END, ARRAY[cardinality(v_ids)]);
  END IF;

  FOR v_t IN SELECT DISTINCT x.t FROM unnest(r_t) AS x(t) ORDER BY 1 LOOP
    -- Plan vigente con `correo_avisos` no apagado (R-12), con la ventana y el tope de la programación.
    SELECT pg.ventana_min, pg.tope_diario INTO v_ventana, v_tope
      FROM public.suscripcion s
      JOIN public.plan p ON p.id = s.plan_id
      CROSS JOIN public.correo_programacion pg
     WHERE s.tenant_id = v_t AND pg.id = 1
       AND (s.estado = 'activa' OR (s.estado = 'prueba' AND s.prueba_vence_en > clock_timestamp()))
       AND (p.features -> 'correo_avisos') IS DISTINCT FROM 'false'::jsonb;
    CONTINUE WHEN NOT FOUND;
    -- Preferencia efectiva activa (R-15): la fila si existe; si no, la inicial por rol.
    SELECT array_agg(x.u ORDER BY x.u, x.tipo, x.creada, x.id), array_agg(x.id ORDER BY x.u, x.tipo, x.creada, x.id),
           array_agg(x.creada ORDER BY x.u, x.tipo, x.creada, x.id), array_agg(x.tipo ORDER BY x.u, x.tipo, x.creada, x.id),
           array_agg(x.cliente ORDER BY x.u, x.tipo, x.creada, x.id), array_agg(x.mensaje ORDER BY x.u, x.tipo, x.creada, x.id),
           array_agg(x.categoria ORDER BY x.u, x.tipo, x.creada, x.id), array_agg(x.recurso ORDER BY x.u, x.tipo, x.creada, x.id),
           array_agg(x.umbral ORDER BY x.u, x.tipo, x.creada, x.id)
      INTO f_u, f_id, f_creada, f_tipo, f_cliente, f_mensaje, f_categoria, f_recurso, f_umbral
      FROM unnest(r_t, r_u, r_id, r_creada, r_tipo, r_cliente, r_mensaje, r_categoria, r_recurso, r_umbral)
             AS x(t, u, id, creada, tipo, cliente, mensaje, categoria, recurso, umbral)
      JOIN public.membresia m ON m.tenant_id = v_t AND m.usuario_id = x.u
      LEFT JOIN public.correo_preferencia cp ON cp.tenant_id = v_t AND cp.usuario_id = x.u AND cp.tipo = x.tipo
     WHERE x.t = v_t AND coalesce(cp.activo, x.tipo <> 'plan_limite' OR m.rol = 'dueno');
    CONTINUE WHEN f_id IS NULL;
    -- D-2: candado de transacción por (estudio, usuario), en orden de usuario.
    PERFORM pg_advisory_xact_lock(hashtextextended('correo:' || v_t::text || ':' || d.u::text, 0))
       FROM unnest(ARRAY(SELECT DISTINCT y.u FROM unnest(f_u) AS y(u) ORDER BY 1)) AS d(u);
    v_ahora := clock_timestamp();
    -- Se suman al envío pendiente sin tomar de su (usuario, tipo), si lo hay (a lo sumo uno: índice único parcial).
    WITH grupos AS (
      SELECT y.u, y.tipo, count(*) AS k FROM unnest(f_u, f_tipo) AS y(u, tipo) GROUP BY y.u, y.tipo
    ), sumados AS (
      UPDATE public.correo_envio e SET total_avisos = e.total_avisos + grupos.k
        FROM grupos
       WHERE e.tenant_id = v_t AND e.usuario_id = grupos.u AND e.tipo = grupos.tipo AND e.origen = 'aviso'
         AND e.estado = 'pendiente' AND e.tomado_en IS NULL
      RETURNING e.usuario_id, e.tipo, e.id
    )
    SELECT array_agg(s.usuario_id), array_agg(s.tipo), array_agg(s.id) INTO g_u, g_tipo, g_envio FROM sumados s;
    -- Sin pendiente: un envío nuevo (ventana desde el anterior) o, con el tope del día de Lima agotado, diferidos (R-14).
    v_dia_inicio := date_trunc('day', v_ahora AT TIME ZONE 'America/Lima') AT TIME ZONE 'America/Lima';
    FOR g IN SELECT y.u, y.tipo, count(*) AS k FROM unnest(f_u, f_tipo) AS y(u, tipo)
              WHERE NOT EXISTS (SELECT 1 FROM unnest(g_u, g_tipo) AS z(u, tipo) WHERE z.u = y.u AND z.tipo = y.tipo)
              GROUP BY y.u, y.tipo ORDER BY y.u, y.tipo LOOP
      SELECT count(*) INTO v_n FROM public.correo_envio e
       WHERE e.tenant_id = v_t AND e.usuario_id = g.u AND e.origen = 'aviso' AND e.creado_en >= v_dia_inicio
         AND e.estado IN ('enviado', 'pendiente');
      CONTINUE WHEN v_n >= v_tope;
      -- H-028-2-3 (D-2): la ventana corre desde el último correo enviado o en curso, nunca desde un omitido (ni un fallido).
      SELECT max(e.programado_para) INTO v_prev FROM public.correo_envio e
       WHERE e.tenant_id = v_t AND e.usuario_id = g.u AND e.tipo = g.tipo AND e.origen = 'aviso'
         AND e.estado IN ('enviado', 'pendiente');
      INSERT INTO public.correo_envio AS e (tenant_id, usuario_id, origen, tipo, estado, clave, programado_para, total_avisos)
      VALUES (v_t, g.u, 'aviso', g.tipo, 'pendiente', 'aviso:' || g.u::text || ':' || g.tipo || ':' || gen_random_uuid()::text,
              GREATEST(v_ahora, coalesce(v_prev + make_interval(mins => v_ventana), v_ahora)), g.k)
      RETURNING e.id INTO v_envio;
      g_u := coalesce(g_u, '{}'::uuid[]) || g.u;
      g_tipo := coalesce(g_tipo, '{}'::text[]) || g.tipo;
      g_envio := coalesce(g_envio, '{}'::uuid[]) || v_envio;
    END LOOP;
    INSERT INTO public.correo_envio_aviso
      (tenant_id, notificacion_id, usuario_id, tipo, envio_id, diferido_en, cliente_id, mensaje_id, categoria, recurso, umbral,
       notificada_en)
    SELECT v_t, x.id, x.u, x.tipo, e.envio, CASE WHEN e.envio IS NULL THEN v_ahora END,
           x.cliente, x.mensaje, x.categoria, x.recurso, x.umbral, x.creada
      FROM unnest(f_u, f_id, f_creada, f_tipo, f_cliente, f_mensaje, f_categoria, f_recurso, f_umbral)
             AS x(u, id, creada, tipo, cliente, mensaje, categoria, recurso, umbral)
      LEFT JOIN unnest(g_u, g_tipo, g_envio) AS e(u, tipo, envio) ON e.u = x.u AND e.tipo = x.tipo;
  END LOOP;
END
$$;--> statement-breakpoint

-- ---- H-028-2-7: cerrar un envío `omitido` por `fuera_de_dia` (correo_envio_cerrar de 0074) ---------------------------------------
CREATE OR REPLACE FUNCTION public.correo_envio_cerrar(p_envio uuid, p_estado text, p_motivo text, p_corte timestamptz) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := nullif(pg_catalog.current_setting('app.tenant_id', true), '')::uuid;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'correo_envio_cerrar: sesion sin estudio';
  END IF;
  IF p_estado IS NULL
     OR NOT coalesce((p_estado = 'enviado' AND p_motivo IS NULL)
             OR (p_estado = 'omitido' AND p_motivo IN ('membresia_inactiva', 'sin_correo', 'preferencia_apagada', 'sin_plan',
                                                        'sin_contenido', 'sin_novedades', 'fuera_de_dia'))
             OR (p_estado = 'fallido' AND p_motivo = 'transporte'), false) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'correo_envio_cerrar: estado o motivo invalido';
  END IF;
  UPDATE public.correo_envio e
     SET estado = p_estado, motivo = p_motivo, corte_hasta = p_corte,
         enviado_en = CASE WHEN p_estado = 'enviado' THEN pg_catalog.clock_timestamp() END
   WHERE e.tenant_id = v_tenant AND e.id = p_envio AND e.estado = 'pendiente';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'correo_envio_cerrar: envio inexistente';
  END IF;
END
$$;--> statement-breakpoint

-- ---- H-028-2-7: diferidos de un resumen `fuera_de_dia` (crear_correo_resumenes de 0075) ------------------------------------------
CREATE OR REPLACE FUNCTION public.crear_correo_resumenes(p_dia date) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := nullif(pg_catalog.current_setting('app.tenant_id', true), '')::uuid;
  v_ahora timestamptz := pg_catalog.clock_timestamp();
  v_features jsonb;
  v_resumen boolean;
  v_dia text;
  v_max smallint;
  v_res uuid[];
  v_res_us uuid[];
  v_pen uuid[];
  v_pen_us uuid[];
  v_pen_tipos text[];
  v_todos uuid[];
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'crear_correo_resumenes: sesion sin estudio';
  END IF;
  IF p_dia IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'crear_correo_resumenes: dia invalido';
  END IF;
  SELECT p.features INTO v_features
    FROM public.suscripcion s JOIN public.plan p ON p.id = s.plan_id
   WHERE s.tenant_id = v_tenant
     AND (s.estado = 'activa' OR (s.estado = 'prueba' AND s.prueba_vence_en > v_ahora));
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  v_resumen := (v_features -> 'correo_resumen') IS DISTINCT FROM 'false'::jsonb;
  v_dia := pg_catalog.to_char(p_dia, 'YYYY-MM-DD');

  -- H-028-1-4: los diferidos que llevaba un resumen que no salió porque el usuario lo apagó (D-7 o la revalidación) o el plan ya no
  -- lo incluye vuelven a ser diferidos (conservan su diferido_en): van al resumen de hoy o, sin resumen activo, a «Avisos pendientes».
  -- H-028-2-7: también los de un resumen que se tomó cuando ya no era su día de Lima (`fuera_de_dia`, R-5).
  UPDATE public.correo_envio_aviso a SET envio_id = NULL
    FROM public.correo_envio e
   WHERE e.tenant_id = v_tenant AND e.origen = 'resumen' AND e.estado = 'omitido'
     AND e.motivo IN ('preferencia_apagada', 'sin_plan', 'fuera_de_dia')
     AND a.tenant_id = v_tenant AND a.envio_id = e.id AND a.diferido_en IS NOT NULL;

  -- Resúmenes.
  WITH r AS (
    INSERT INTO public.correo_envio AS e (tenant_id, usuario_id, origen, tipo, estado, clave, programado_para, dia_lima)
    SELECT v_tenant, m.usuario_id, 'resumen', 'resumen', 'pendiente', 'resumen:' || m.usuario_id::text || ':' || v_dia, v_ahora, p_dia
      FROM public.membresia m
      JOIN public.correo_preferencia cp ON cp.tenant_id = m.tenant_id AND cp.usuario_id = m.usuario_id AND cp.tipo = 'resumen'
     WHERE m.tenant_id = v_tenant AND m.desactivada_en IS NULL AND cp.activo AND v_resumen
     ORDER BY m.usuario_id
    ON CONFLICT (tenant_id, clave) DO NOTHING
    RETURNING e.id, e.usuario_id
  )
  SELECT pg_catalog.array_agg(r.id), pg_catalog.array_agg(r.usuario_id) INTO v_res, v_res_us FROM r;

  -- «Avisos pendientes» por tipo de quien no tiene el resumen activo (U-17).
  WITH d AS (
    SELECT a.usuario_id, a.tipo FROM public.correo_envio_aviso a
     WHERE a.tenant_id = v_tenant AND a.envio_id IS NULL
     GROUP BY a.usuario_id, a.tipo
  ), p AS (
    INSERT INTO public.correo_envio AS e (tenant_id, usuario_id, origen, tipo, estado, clave, programado_para, dia_lima)
    SELECT v_tenant, d.usuario_id, 'pendientes', d.tipo, 'pendiente',
           'pendientes:' || d.usuario_id::text || ':' || d.tipo || ':' || v_dia, v_ahora, p_dia
      FROM d
      JOIN public.membresia m ON m.tenant_id = v_tenant AND m.usuario_id = d.usuario_id AND m.desactivada_en IS NULL
     WHERE NOT (v_resumen AND EXISTS (SELECT 1 FROM public.correo_preferencia cp
                                       WHERE cp.tenant_id = v_tenant AND cp.usuario_id = d.usuario_id AND cp.tipo = 'resumen'
                                         AND cp.activo))
     ORDER BY d.usuario_id, d.tipo
    ON CONFLICT (tenant_id, clave) DO NOTHING
    RETURNING e.id, e.usuario_id, e.tipo
  )
  SELECT pg_catalog.array_agg(p.id), pg_catalog.array_agg(p.usuario_id), pg_catalog.array_agg(p.tipo)
    INTO v_pen, v_pen_us, v_pen_tipos FROM p;

  -- Los diferidos quedan unidos al envío que los lleva (conservan su diferido_en) y el envío cuenta cuántos lleva.
  IF v_res IS NOT NULL THEN
    UPDATE public.correo_envio_aviso a SET envio_id = x.envio
      FROM unnest(v_res, v_res_us) AS x(envio, u)
     WHERE a.tenant_id = v_tenant AND a.usuario_id = x.u AND a.envio_id IS NULL;
  END IF;
  IF v_pen IS NOT NULL THEN
    UPDATE public.correo_envio_aviso a SET envio_id = x.envio
      FROM unnest(v_pen, v_pen_us, v_pen_tipos) AS x(envio, u, tipo)
     WHERE a.tenant_id = v_tenant AND a.usuario_id = x.u AND a.tipo = x.tipo AND a.envio_id IS NULL;
  END IF;
  v_todos := coalesce(v_res, '{}'::uuid[]) || coalesce(v_pen, '{}'::uuid[]);
  IF cardinality(v_todos) = 0 THEN
    RETURN 0;
  END IF;
  UPDATE public.correo_envio e
     SET total_avisos = (SELECT pg_catalog.count(*) FROM public.correo_envio_aviso a WHERE a.tenant_id = v_tenant AND a.envio_id = e.id)
   WHERE e.tenant_id = v_tenant AND e.id = ANY (v_todos);

  SELECT (cs.reintentos + 1)::smallint INTO v_max FROM public.config_sistema cs WHERE cs.cola = 'notificaciones';
  v_max := coalesce(v_max, 3::smallint);
  INSERT INTO public.job_registro AS j
    (cliente_id, ruc, tipo, cola, canal, prioridad, estado, parametros, clave_dedupe, creado_por, max_intentos)
  SELECT NULL, NULL, 'notificacion.enviar', 'notificaciones', 'ninguno', 'programado', 'en_cola',
         pg_catalog.jsonb_build_object('envioId', x.id),
         pg_catalog.sha256(pg_catalog.convert_to(
           '["notificacion.enviar",null,' || pg_catalog.jsonb_build_object('envioId', x.id)::text || ']', 'UTF8')),
         NULL, v_max
    FROM unnest(v_todos) AS x(id)
  ON CONFLICT (tenant_id, clave_dedupe)
    WHERE estado IN ('en_cola', 'ejecutando') AND (tipo <> 'compras.reevaluar' OR (estado = 'en_cola' AND intentos = 0))
    DO NOTHING;
  RETURN cardinality(v_todos);
END
$$;--> statement-breakpoint

-- ---- Dueños, EXECUTE y nada para PUBLIC (como en 0074/0075) -----------------------------------------------------------------------
ALTER FUNCTION interno.notificar(uuid, uuid[], text, uuid, uuid, jsonb, text) OWNER TO contapp_registrador;--> statement-breakpoint
ALTER FUNCTION sistema.correo_ciclo_renovar(text) OWNER TO contapp_migrator;--> statement-breakpoint
ALTER FUNCTION public.correo_envio_cerrar(uuid, text, text, timestamptz) OWNER TO contapp_migrator;--> statement-breakpoint
ALTER FUNCTION public.crear_correo_resumenes(date) OWNER TO contapp_migrator;--> statement-breakpoint

REVOKE ALL ON FUNCTION interno.notificar(uuid, uuid[], text, uuid, uuid, jsonb, text)
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador;--> statement-breakpoint
REVOKE ALL ON FUNCTION sistema.correo_ciclo_renovar(text)
  FROM PUBLIC, contapp_backend, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.correo_envio_cerrar(uuid, text, text, timestamptz)
  FROM PUBLIC, contapp_backend, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.crear_correo_resumenes(date)
  FROM PUBLIC, contapp_backend, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint

GRANT EXECUTE ON FUNCTION interno.notificar(uuid, uuid[], text, uuid, uuid, jsonb, text) TO contapp_migrator;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION sistema.correo_ciclo_renovar(text) TO contapp_worker;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.correo_envio_cerrar(uuid, text, text, timestamptz) TO contapp_worker;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.crear_correo_resumenes(date) TO contapp_worker;
