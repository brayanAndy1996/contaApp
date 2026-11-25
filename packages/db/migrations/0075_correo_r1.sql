-- 0075_correo_r1 (spec 028, T17: hallazgos de la ronda adversarial 1, decisiones del 2026-11-24 en tasks.md, resultado de T16). Repetible
-- (ADD COLUMN IF NOT EXISTS, DROP ... IF EXISTS antes de cada ADD/CREATE, CREATE OR REPLACE, REVOKE/GRANT). Las funciones conservan firma,
-- dueño, SECURITY DEFINER, search_path = pg_catalog, pg_temp y sus SQLSTATE y mensajes fijos de 0074; sin EXCEPTION ni SAVEPOINT. Sin
-- funciones ni tablas nuevas (escalada.adv.spec.ts y catalogo.spec.ts no cambian).
--   H-028-1-2  sistema.correo_ciclo_tomar/renovar: candado de 90 s (no 5 min), renovado tras cada estudio (R-14: ≤ 1 min; ≤ 2 min tras una caída).
--   H-028-1-3  job_registro: política RESTRICTIVE de INSERT para contapp_backend que excluye `notificacion.enviar` (solo lo encolan las
--              funciones acotadas de 0074, dueño contapp_migrator; R-1, R-11).
--   H-028-1-4  crear_correo_resumenes: los diferidos unidos a un resumen `omitido` (preferencia_apagada o sin_plan) vuelven a diferidos y
--              salen en el resumen de hoy o, sin resumen activo, en «Avisos pendientes» (R-14, CA-9).
--   H-028-1-5  correo_baja_token.anulado_en: el token es de un solo uso (auth.correo_baja_aplicar lo consume con el candado del usuario
--              tomado) y cambiar ESE tipo en la app (correo_preferencias_fijar, cambio real) anula los emitidos antes. contapp_auth recibe
--              UPDATE solo de anulado_en, con política propia que solo deja marcarlo.
--   H-028-1-6  auth.limite_consumir: `correo_baja_ip` sube a 500 cada 10 min (solo contra abuso masivo: el POST de RFC 8058 lo hace el
--              servidor del proveedor) y nace `correo_baja_token` (10 cada 10 min por token, sujeto = SHA-256 del token con prefijo).
--   H-028-1-8  interno.notificar: el tope diario de avisos cuenta solo los envíos `enviado` o `pendiente` (en curso), no los omitidos ni fallidos.
--   (H-028-1-1 y H-028-1-7 no tocan la BD: worker y OrigenGuard.)

-- ---- H-028-1-5: token de un solo uso ------------------------------------------------------------------------------------------------
ALTER TABLE public.correo_baja_token ADD COLUMN IF NOT EXISTS anulado_en timestamp with time zone;--> statement-breakpoint
REVOKE UPDATE ON public.correo_baja_token FROM contapp_auth;--> statement-breakpoint
GRANT UPDATE (anulado_en) ON public.correo_baja_token TO contapp_auth;--> statement-breakpoint
DROP POLICY IF EXISTS correo_baja_token_auth_anular ON public.correo_baja_token;--> statement-breakpoint
CREATE POLICY correo_baja_token_auth_anular ON public.correo_baja_token FOR UPDATE TO contapp_auth
  USING (anulado_en IS NULL) WITH CHECK (anulado_en IS NOT NULL);--> statement-breakpoint

-- ---- H-028-1-3: el backend no encola notificacion.enviar ------------------------------------------------------------------------------
DROP POLICY IF EXISTS job_registro_sin_correo_backend ON public.job_registro;--> statement-breakpoint
CREATE POLICY job_registro_sin_correo_backend ON public.job_registro AS RESTRICTIVE FOR INSERT TO contapp_backend
  WITH CHECK (tipo <> 'notificacion.enviar');--> statement-breakpoint

-- ---- H-028-1-6: límite por token de la baja -------------------------------------------------------------------------------------
ALTER TABLE auth.limite_tasa DROP CONSTRAINT IF EXISTS limite_tasa_tipo_valido;--> statement-breakpoint
ALTER TABLE auth.limite_tasa ADD CONSTRAINT limite_tasa_tipo_valido
  CHECK (tipo IN ('login_ip', 'recup_correo', 'recup_ip', 'restab_ip', 'registro_ip', 'registro_correo',
                  'registro_confirmar_ip', 'correo_baja_ip', 'correo_baja_token'));--> statement-breakpoint

-- ---- H-028-1-8: tope diario solo con lo enviado o en curso (interno.notificar de 0074, misma firma) ---------------------------
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
      SELECT max(e.programado_para) INTO v_prev FROM public.correo_envio e
       WHERE e.tenant_id = v_t AND e.usuario_id = g.u AND e.tipo = g.tipo AND e.origen = 'aviso';
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

-- ---- H-028-1-5: cambiar un tipo en la app anula sus enlaces de baja (correo_preferencias_fijar de 0074) -------------------------
CREATE OR REPLACE FUNCTION public.correo_preferencias_fijar(p jsonb) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := nullif(pg_catalog.current_setting('app.tenant_id', true), '')::uuid;
  v_usuario_ctx text := nullif(pg_catalog.current_setting('app.user_id', true), '');
  v_usuario uuid;
  v_rol text;
  v_todos boolean;
  v_valor boolean;
  v_previo boolean;
  v_todos_antes boolean;
  t record;
BEGIN
  IF v_tenant IS NULL OR v_usuario_ctx IS NULL
     OR v_usuario_ctx !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'correo_preferencias_fijar: sesion sin estudio o sin usuario';
  END IF;
  v_usuario := v_usuario_ctx::uuid;
  SELECT m.rol INTO v_rol FROM public.membresia m
   WHERE m.tenant_id = v_tenant AND m.usuario_id = v_usuario AND m.desactivada_en IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'correo_preferencias_fijar: sin membresia activa';
  END IF;
  IF p IS NULL OR pg_catalog.jsonb_typeof(p) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'correo_preferencias_fijar: entrada invalida';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p)) <> 5
     OR NOT (p ?& ARRAY['buzonCritico', 'credencialInvalida', 'planLimite', 'resumen', 'todosClientes'])
     OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_each(p) AS e WHERE pg_catalog.jsonb_typeof(e.value) <> 'boolean') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'correo_preferencias_fijar: entrada invalida';
  END IF;
  v_todos := (p ->> 'todosClientes')::boolean;
  IF v_todos THEN
    IF v_rol NOT IN ('dueno', 'admin') THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'correo_preferencias_fijar: todos los clientes no permitido';
    END IF;
    IF EXISTS (SELECT 1 FROM public.asignacion a WHERE a.tenant_id = v_tenant AND a.usuario_id = v_usuario) THEN
      RAISE EXCEPTION USING ERRCODE = 'CA430', MESSAGE = 'correo_preferencias_fijar: todos los clientes no disponible';
    END IF;
  END IF;
  -- Mismo candado que interno.notificar y la baja: serializa con el registro de avisos del usuario.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('correo:' || v_tenant::text || ':' || v_usuario::text, 0));
  FOR t IN SELECT x.tipo, x.clave FROM (VALUES ('buzon_critico', 'buzonCritico'), ('credencial_invalida', 'credencialInvalida'),
                                               ('plan_limite', 'planLimite'), ('resumen', 'resumen')) AS x(tipo, clave) LOOP
    v_valor := (p ->> t.clave)::boolean;
    SELECT cp.activo, cp.todos_clientes INTO v_previo, v_todos_antes FROM public.correo_preferencia cp
     WHERE cp.tenant_id = v_tenant AND cp.usuario_id = v_usuario AND cp.tipo = t.tipo
       FOR UPDATE;
    IF NOT FOUND THEN
      v_previo := CASE t.tipo WHEN 'plan_limite' THEN v_rol = 'dueno' WHEN 'resumen' THEN false ELSE true END;
      v_todos_antes := false;
    END IF;
    INSERT INTO public.correo_preferencia AS cp (tenant_id, usuario_id, tipo, activo, todos_clientes)
    VALUES (v_tenant, v_usuario, t.tipo, v_valor, t.tipo = 'resumen' AND v_todos)
    ON CONFLICT (tenant_id, usuario_id, tipo) DO UPDATE
      SET activo = excluded.activo, todos_clientes = excluded.todos_clientes,
          actualizada_en = CASE WHEN (cp.activo, cp.todos_clientes) IS DISTINCT FROM (excluded.activo, excluded.todos_clientes)
                                THEN pg_catalog.clock_timestamp() ELSE cp.actualizada_en END;
    IF v_previo IS DISTINCT FROM v_valor THEN
      PERFORM public.auditoria_registrar(v_tenant, 'correo.preferencia_cambiada', NULL, 'correo_preferencia', NULL,
        pg_catalog.jsonb_build_object('tipo', t.tipo, 'de', v_previo, 'a', v_valor, 'origen', 'app'));
      -- H-028-1-5: cambiar ESTE tipo en la app anula los enlaces de baja de ese tipo emitidos antes (los de otros tipos siguen).
      UPDATE public.correo_baja_token k SET anulado_en = pg_catalog.clock_timestamp()
       WHERE k.tenant_id = v_tenant AND k.usuario_id = v_usuario AND k.tipo = t.tipo AND k.anulado_en IS NULL;
    END IF;
    IF t.tipo = 'resumen' AND v_todos_antes IS DISTINCT FROM v_todos THEN
      PERFORM public.auditoria_registrar(v_tenant, 'correo.preferencia_cambiada', NULL, 'correo_preferencia', NULL,
        pg_catalog.jsonb_build_object('tipo', 'resumen_todos', 'de', v_todos_antes, 'a', v_todos, 'origen', 'app'));
    END IF;
    -- D-7: apagado, lo pendiente sin tomar de ese tipo no sale (lo ya tomado lo revalida el worker, R-3).
    IF NOT v_valor THEN
      UPDATE public.correo_envio e SET estado = 'omitido', motivo = 'preferencia_apagada'
       WHERE e.tenant_id = v_tenant AND e.usuario_id = v_usuario AND e.tipo = t.tipo
         AND e.estado = 'pendiente' AND e.tomado_en IS NULL;
    END IF;
  END LOOP;
  RETURN pg_catalog.jsonb_build_object(
    'buzonCritico', (p ->> 'buzonCritico')::boolean, 'credencialInvalida', (p ->> 'credencialInvalida')::boolean,
    'planLimite', (p ->> 'planLimite')::boolean, 'resumen', (p ->> 'resumen')::boolean, 'todosClientes', v_todos);
END
$$;--> statement-breakpoint

-- ---- H-028-1-5: baja de un solo uso (auth.correo_baja_aplicar de 0074) ---------------------------------------------------------
CREATE OR REPLACE FUNCTION auth.correo_baja_aplicar(p_hash bytea) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant_previo text := pg_catalog.current_setting('app.tenant_id', true);
  v_usuario_previo text := pg_catalog.current_setting('app.user_id', true);
  v_tenant uuid;
  v_usuario uuid;
  v_tipo text;
  v_rol text;
  v_activo boolean;
  v_vigente boolean := false;
BEGIN
  IF p_hash IS NULL OR pg_catalog.octet_length(p_hash) <> 32 THEN
    RETURN;
  END IF;
  SELECT k.tenant_id, k.usuario_id, k.tipo INTO v_tenant, v_usuario, v_tipo
    FROM public.correo_baja_token k
   WHERE k.hash = p_hash AND k.vence_en > pg_catalog.clock_timestamp() AND k.anulado_en IS NULL;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  PERFORM pg_catalog.set_config('app.tenant_id', v_tenant::text, true);
  PERFORM pg_catalog.set_config('app.user_id', '', true);
  SELECT m.rol INTO v_rol FROM public.membresia m WHERE m.tenant_id = v_tenant AND m.usuario_id = v_usuario;
  IF FOUND THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('correo:' || v_tenant::text || ':' || v_usuario::text, 0));
    -- H-028-1-5: un solo uso. Se consume con el candado tomado: si el usuario cambió ese tipo en la app mientras tanto, ya está anulado.
    UPDATE public.correo_baja_token k SET anulado_en = pg_catalog.clock_timestamp()
     WHERE k.hash = p_hash AND k.anulado_en IS NULL AND k.vence_en > pg_catalog.clock_timestamp();
    v_vigente := FOUND;
  END IF;
  IF v_vigente THEN
    SELECT cp.activo INTO v_activo FROM public.correo_preferencia cp
     WHERE cp.tenant_id = v_tenant AND cp.usuario_id = v_usuario AND cp.tipo = v_tipo;
    IF FOUND THEN
      IF v_activo THEN
        UPDATE public.correo_preferencia cp SET activo = false, actualizada_en = pg_catalog.clock_timestamp()
         WHERE cp.tenant_id = v_tenant AND cp.usuario_id = v_usuario AND cp.tipo = v_tipo;
      END IF;
    ELSE
      -- Inicial por rol (R-15): el límite del plan solo para Dueños, el resumen apagado, los dos avisos del buzón y de la clave activos.
      v_activo := CASE v_tipo WHEN 'plan_limite' THEN v_rol = 'dueno' WHEN 'resumen' THEN false ELSE true END;
      IF v_activo THEN
        INSERT INTO public.correo_preferencia (tenant_id, usuario_id, tipo, activo, todos_clientes)
        VALUES (v_tenant, v_usuario, v_tipo, false, false);
      END IF;
    END IF;
    IF v_activo THEN
      PERFORM public.auditoria_registrar(v_tenant, 'correo.preferencia_cambiada', NULL, 'correo_preferencia', NULL,
        pg_catalog.jsonb_build_object('tipo', v_tipo, 'de', true, 'a', false, 'origen', 'enlace'), v_usuario);
    END IF;
  END IF;
  PERFORM pg_catalog.set_config('app.tenant_id', coalesce(v_tenant_previo, ''), true);
  PERFORM pg_catalog.set_config('app.user_id', coalesce(v_usuario_previo, ''), true);
END
$$;--> statement-breakpoint

-- ---- H-028-1-6: 500 por IP y 10 por token cada 10 min (auth.limite_consumir de 0074; el resto como en 0025) -----------------------
CREATE OR REPLACE FUNCTION auth.limite_consumir(p_tipo text, p_sujeto text) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_max integer;
  v_ventana interval;
  v_conteo integer;
BEGIN
  IF p_tipo = 'login_ip' THEN
    v_max := 20; v_ventana := interval '10 minutes';
  ELSIF p_tipo = 'recup_correo' THEN
    v_max := 3; v_ventana := interval '1 hour';
  ELSIF p_tipo = 'recup_ip' THEN
    v_max := 10; v_ventana := interval '1 hour';
  ELSIF p_tipo = 'restab_ip' THEN
    v_max := 10; v_ventana := interval '15 minutes';
  ELSIF p_tipo = 'registro_ip' THEN
    v_max := 5; v_ventana := interval '1 hour';
  ELSIF p_tipo = 'registro_correo' THEN
    v_max := 3; v_ventana := interval '1 hour';
  ELSIF p_tipo = 'registro_confirmar_ip' THEN
    v_max := 10; v_ventana := interval '1 hour';
  ELSIF p_tipo = 'correo_baja_ip' THEN
    v_max := 500; v_ventana := interval '10 minutes';
  ELSIF p_tipo = 'correo_baja_token' THEN
    v_max := 10; v_ventana := interval '10 minutes';
  ELSE
    RETURN false;
  END IF;
  INSERT INTO auth.limite_tasa AS l (tipo, sujeto, ventana_inicio, conteo)
  VALUES (p_tipo, p_sujeto, now(), 1)
  ON CONFLICT (tipo, sujeto) DO UPDATE SET
    ventana_inicio = CASE WHEN l.ventana_inicio <= now() - v_ventana THEN now() ELSE l.ventana_inicio END,
    conteo = CASE WHEN l.ventana_inicio <= now() - v_ventana THEN 1 ELSE least(l.conteo + 1, v_max + 1) END
  RETURNING l.conteo INTO v_conteo;
  RETURN v_conteo <= v_max;
END
$$;--> statement-breakpoint

-- ---- H-028-1-2: candado del ciclo de 90 s (sistema.correo_ciclo_tomar/renovar de 0074) ------------------------------------------
CREATE OR REPLACE FUNCTION sistema.correo_ciclo_tomar(p_dueno text) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_ahora timestamptz := pg_catalog.clock_timestamp();
  v_local timestamp;
  v_hora time;
  v_dias smallint[];
  v_cerrado date;
BEGIN
  IF p_dueno IS NULL OR pg_catalog.char_length(p_dueno) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'correo_ciclo_tomar: dueno invalido';
  END IF;
  UPDATE public.correo_programacion g
     SET ciclo_dueno = p_dueno, ciclo_hasta = v_ahora + interval '90 seconds', ultimo_ciclo_inicio = v_ahora
   WHERE g.id = 1 AND (g.ciclo_hasta IS NULL OR g.ciclo_hasta < v_ahora)
  RETURNING g.hora_resumen, g.dias_resumen, g.resumen_cerrado INTO v_hora, v_dias, v_cerrado;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  v_local := v_ahora AT TIME ZONE 'America/Lima';
  RETURN pg_catalog.jsonb_build_object('resumenDia',
    CASE WHEN v_local::time >= v_hora
              AND pg_catalog.date_part('isodow', v_local)::smallint = ANY (v_dias)
              AND (v_cerrado IS NULL OR v_cerrado < v_local::date)
         THEN pg_catalog.to_char(v_local::date, 'YYYY-MM-DD') END);
END
$$;--> statement-breakpoint

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
   WHERE g.id = 1 AND g.ciclo_dueno = p_dueno AND g.ciclo_hasta IS NOT NULL AND g.ciclo_hasta >= v_ahora;
  RETURN FOUND;
END
$$;--> statement-breakpoint

-- ---- H-028-1-4: diferidos de un resumen omitido (crear_correo_resumenes de 0074) ---------------------------------------------------
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
  UPDATE public.correo_envio_aviso a SET envio_id = NULL
    FROM public.correo_envio e
   WHERE e.tenant_id = v_tenant AND e.origen = 'resumen' AND e.estado = 'omitido'
     AND e.motivo IN ('preferencia_apagada', 'sin_plan')
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

-- ---- Dueños, EXECUTE y nada para PUBLIC (como en 0074) -----------------------------------------------------------------------------
ALTER FUNCTION interno.notificar(uuid, uuid[], text, uuid, uuid, jsonb, text) OWNER TO contapp_registrador;--> statement-breakpoint
ALTER FUNCTION public.correo_preferencias_fijar(jsonb) OWNER TO contapp_migrator;--> statement-breakpoint
ALTER FUNCTION auth.correo_baja_aplicar(bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.limite_consumir(text, text) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION sistema.correo_ciclo_tomar(text) OWNER TO contapp_migrator;--> statement-breakpoint
ALTER FUNCTION sistema.correo_ciclo_renovar(text) OWNER TO contapp_migrator;--> statement-breakpoint
ALTER FUNCTION public.crear_correo_resumenes(date) OWNER TO contapp_migrator;--> statement-breakpoint

REVOKE ALL ON FUNCTION interno.notificar(uuid, uuid[], text, uuid, uuid, jsonb, text)
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.correo_preferencias_fijar(jsonb)
  FROM PUBLIC, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth.correo_baja_aplicar(bytea)
  FROM PUBLIC, contapp_worker, contapp_platform, contapp_app, contapp_enumerador, contapp_registrador, contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth.limite_consumir(text, text)
  FROM PUBLIC, contapp_worker, contapp_platform, contapp_app, contapp_enumerador, contapp_registrador;--> statement-breakpoint
REVOKE ALL ON FUNCTION sistema.correo_ciclo_tomar(text)
  FROM PUBLIC, contapp_backend, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
REVOKE ALL ON FUNCTION sistema.correo_ciclo_renovar(text)
  FROM PUBLIC, contapp_backend, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.crear_correo_resumenes(date)
  FROM PUBLIC, contapp_backend, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint

GRANT EXECUTE ON FUNCTION interno.notificar(uuid, uuid[], text, uuid, uuid, jsonb, text) TO contapp_migrator;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.correo_preferencias_fijar(jsonb) TO contapp_backend;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth.correo_baja_aplicar(bytea) TO contapp_backend;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth.limite_consumir(text, text) TO contapp_backend;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION sistema.correo_ciclo_tomar(text) TO contapp_worker;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION sistema.correo_ciclo_renovar(text) TO contapp_worker;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.crear_correo_resumenes(date) TO contapp_worker;
