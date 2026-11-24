-- 0074_correo_funciones (spec 028, R-2 a R-5, R-7, R-10 a R-15, D-2, D-7; CA-1 a CA-5, CA-8, CA-9, CA-11, CA-12, CA-14). Funciones del correo
-- de avisos y del resumen diario y la `interno.notificar` ampliada. Sin tablas: todo es repetible (CREATE OR REPLACE, GRANT/REVOKE).
-- Todas SECURITY DEFINER con search_path = pg_catalog, pg_temp, nombres calificados, SQLSTATE y mensaje fijos (nunca ids, correos ni
-- textos), sin EXCEPTION ni SAVEPOINT (corren en la transacción del hecho o del trabajo) y sin EXECUTE para PUBLIC. Dueño
-- contapp_migrator (sin superusuario ni BYPASSRLS: la RLS FORCE aplica dentro), salvo `interno.notificar` (contapp_registrador, como en
-- 0043) y `auth.correo_baja_aplicar` (contapp_auth, como auth.recuperacion_consumir). Reloj de la BD (clock_timestamp()) y día de Lima.
--   Interna:   correo_preferencia_efectiva(estudio, usuario, tipo)  la fila si existe; si no, la inicial por rol (R-15): críticos y clave
--              inválida activados, límite del plan solo para Dueños, resumen apagado; sin membresía, false. EXECUTE solo contapp_registrador.
--   017:       interno.notificar (misma firma, dueño y grants de 0043). Tras insertar, por cada notificación NUEVA de buzon_critico,
--              credencial_invalida o plan_limite cuyo destinatario tiene la preferencia efectiva activa, con suscripción activa o prueba
--              vigente y `correo_avisos` no apagado (ausente = habilitado, R-12): candado de transacción por (estudio, usuario) en orden de
--              usuario; se suma al envío `pendiente` sin tomar de su (usuario, tipo) o abre uno programado para max(ahora, programado del
--              anterior + ventana) (D-2); si el día de Lima ya tiene `tope_diario` envíos de avisos del (usuario, estudio), queda diferida
--              (R-14). Por conjuntos: un UPDATE por (usuario, tipo) y un INSERT de todos los avisos. Nada de esto falla por un dato de
--              la notificación: lo que no está en la lista blanca se guarda como NULL. Lote (R-16): buzon_mensaje_aviso (0056) pasa a
--              ser por sentencia (tabla de transición) y fija app.correo_lote; las notificaciones de la captura se insertan una a una
--              como antes y sus avisos de correo se registran juntos en la llamada de cierre (una suma por envío, no una por aviso).
--   Backend:   correo_preferencias_fijar(p jsonb) -> jsonb   (app.tenant_id y app.user_id con membresía activa: 42501). Exactamente las
--              cinco claves booleanas (22023). «Todos los clientes»: rol dueno/admin (42501) y sin asignaciones (CA430). Crea las 4 filas,
--              audita cada cambio real contra la efectiva (R-10) y apagar deja `omitido` lo pendiente sin tomar del tipo (D-7).
--              auth.correo_baja_aplicar(hash) -> void   token vigente: apaga SOLO el tipo de su (estudio, usuario), audita `origen: enlace`;
--              idempotente; inválido, vencido, NULL o de otra longitud: nada, sin error ni diferencia (D-4, CA-8).
--   Worker:    sistema.correo_ciclo_tomar/renovar/soltar, sistema.correo_resumen_cerrar y sistema.estudios_correo (patrón de 0055);
--              encolar_correo_avisos, crear_correo_resumenes, correo_envio_tomar (devuelve también preferencia, «todos» y plan para
--              revalidar, R-3 y R-12), correo_envio_cerrar, correo_baja_token_crear, correo_purgar y correo_destinatario (correo vigente
--              de un miembro activo: el worker no lee `usuario`, H9 de 002), en el estudio de la sesión (42501 sin él).
--   004:       auth.limite_consumir suma `correo_baja_ip` (20 cada 10 minutos por IP; el resto como en 0025).

-- ---- Preferencia efectiva (R-15) -------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.correo_preferencia_efectiva(p_tenant uuid, p_usuario uuid, p_tipo text) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_previo text := current_setting('app.tenant_id', true);
  v_activo boolean;
  v_rol text;
BEGIN
  IF p_tenant IS NULL OR p_usuario IS NULL OR p_tipo IS NULL THEN
    RETURN false;
  END IF;
  PERFORM pg_catalog.set_config('app.tenant_id', p_tenant::text, true);
  SELECT m.rol INTO v_rol FROM public.membresia m WHERE m.tenant_id = p_tenant AND m.usuario_id = p_usuario;
  IF FOUND THEN
    SELECT cp.activo INTO v_activo FROM public.correo_preferencia cp
     WHERE cp.tenant_id = p_tenant AND cp.usuario_id = p_usuario AND cp.tipo = p_tipo;
    IF NOT FOUND THEN
      v_activo := CASE p_tipo WHEN 'buzon_critico' THEN true WHEN 'credencial_invalida' THEN true
                              WHEN 'plan_limite' THEN v_rol = 'dueno' ELSE false END;
    END IF;
  END IF;
  PERFORM pg_catalog.set_config('app.tenant_id', coalesce(v_previo, ''), true);
  RETURN coalesce(v_activo, false);
END
$$;--> statement-breakpoint

-- ---- interno.notificar ampliada (R-2, R-14, D-2, R-16) ----------------------------------------------------------------------
-- Registra en la transacción del hecho, por conjuntos: cada fila (estudio, usuario, notificación, tipo y lista blanca) con la
-- preferencia efectiva activa y plan vigente con `correo_avisos` se une al envío pendiente sin tomar de su (usuario, tipo) — un solo
-- UPDATE por (usuario, tipo) que suma cuántas trae — o abre uno (ventana desde el anterior) o queda diferida por el tope del día de Lima.
-- Lote (R-16): con app.correo_lote = 'on' (lo fija buzon_mensaje_aviso, por sentencia) solo inserta las notificaciones; la llamada de
-- cierre `interno.notificar(estudio, '{}', 'correo_lote', NULL, NULL, NULL, NULL)` registra juntas las notificaciones de la transacción
-- que aún no tienen aviso (las de app.notificaciones_tx desde app.correo_hecho). Fuera del lote, cada llamada registra las suyas.
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
       WHERE e.tenant_id = v_t AND e.usuario_id = g.u AND e.origen = 'aviso' AND e.creado_en >= v_dia_inicio;
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

-- ---- Aviso del crítico por sentencia (0056, R-16) ----------------------------------------------------------------------------
-- Misma regla de 0056 (destinatarios, trabajo del contexto, params y clave por mensaje, solo los nuevos con avisado), ahora por
-- sentencia con la tabla de transición: los avisos de correo de toda la captura se registran juntos (lote de interno.notificar).
CREATE OR REPLACE FUNCTION public.buzon_mensaje_aviso() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_previo text := current_setting('app.tenant_id', true);
  v_lote_previo text := current_setting('app.correo_lote', true);
  v_es_worker boolean := current_setting('role', true) = 'contapp_worker';
  v_trabajo_ctx text;
  v_trabajo uuid;
  v_usuarios uuid[];
  v_tenant uuid;
  r record;
BEGIN
  PERFORM set_config('app.correo_lote', 'on', true);
  FOR r IN SELECT n.id, n.tenant_id, n.cliente_id, n.categoria FROM nuevos n WHERE n.avisado LOOP
    v_usuarios := interno.destinatarios_cliente(r.tenant_id, r.cliente_id);
    v_trabajo := NULL;
    IF v_es_worker THEN
      v_trabajo_ctx := nullif(current_setting('app.trabajo_id', true), '');
      IF v_trabajo_ctx ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        PERFORM set_config('app.tenant_id', r.tenant_id::text, true);
        SELECT j.id INTO v_trabajo FROM public.job_registro j WHERE j.id = v_trabajo_ctx::uuid AND j.tenant_id = r.tenant_id;
        PERFORM set_config('app.tenant_id', coalesce(v_previo, ''), true);
      END IF;
    END IF;
    PERFORM interno.notificar(r.tenant_id, v_usuarios, 'buzon_critico', r.cliente_id, v_trabajo,
      jsonb_build_object('categoria', r.categoria, 'mensajeId', r.id),
      'buzon_critico:' || r.id::text);
  END LOOP;
  PERFORM set_config('app.correo_lote', coalesce(v_lote_previo, ''), true);
  SELECT n.tenant_id INTO v_tenant FROM nuevos n WHERE n.avisado LIMIT 1;
  IF FOUND THEN
    PERFORM interno.notificar(v_tenant, '{}'::uuid[], 'correo_lote', NULL, NULL, NULL, NULL);
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS buzon_mensaje_aviso ON public.buzon_mensaje;--> statement-breakpoint
CREATE TRIGGER buzon_mensaje_aviso AFTER INSERT ON public.buzon_mensaje
  REFERENCING NEW TABLE AS nuevos FOR EACH STATEMENT EXECUTE FUNCTION public.buzon_mensaje_aviso();--> statement-breakpoint

-- ---- Preferencias del usuario de la sesión (backend; R-10, R-15, D-7, CA-1, CA-12) -----------------------------------------
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

-- ---- Baja sin sesión (backend, dueño contapp_auth; R-7, R-10, D-4, CA-8) ---------------------------------------------------
-- Lee el token vigente por su hash (auth_definer de 0073) y, con app.tenant_id fijado a su estudio y sin app.user_id (el actor de la
-- auditoría es el dueño del token), deja apagado SOLO su tipo. Nunca enciende. Devuelve el contexto como estaba.
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
BEGIN
  IF p_hash IS NULL OR pg_catalog.octet_length(p_hash) <> 32 THEN
    RETURN;
  END IF;
  SELECT k.tenant_id, k.usuario_id, k.tipo INTO v_tenant, v_usuario, v_tipo
    FROM public.correo_baja_token k
   WHERE k.hash = p_hash AND k.vence_en > pg_catalog.clock_timestamp();
  IF NOT FOUND THEN
    RETURN;
  END IF;
  PERFORM pg_catalog.set_config('app.tenant_id', v_tenant::text, true);
  PERFORM pg_catalog.set_config('app.user_id', '', true);
  SELECT m.rol INTO v_rol FROM public.membresia m WHERE m.tenant_id = v_tenant AND m.usuario_id = v_usuario;
  IF FOUND THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('correo:' || v_tenant::text || ':' || v_usuario::text, 0));
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

-- ---- Límite por IP: correo_baja_ip (004; el resto como en 0025) -------------------------------------------------------------
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
    v_max := 20; v_ventana := interval '10 minutes';
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

-- ---- Candado del ciclo y día del resumen (patrón de 0055; R-5) ---------------------------------------------------------------
-- Una sola sentencia UPDATE ... RETURNING: el bloqueo de la fila serializa a los workers. Candado de 5 min con el reloj de la BD.
-- resumenDia = día de Lima si ya pasó hora_resumen, su día ISO está en dias_resumen y ese día aún no se cerró (resumen_cerrado).
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
     SET ciclo_dueno = p_dueno, ciclo_hasta = v_ahora + interval '5 minutes', ultimo_ciclo_inicio = v_ahora
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
  UPDATE public.correo_programacion g SET ciclo_hasta = v_ahora + interval '5 minutes'
   WHERE g.id = 1 AND g.ciclo_dueno = p_dueno AND g.ciclo_hasta IS NOT NULL AND g.ciclo_hasta >= v_ahora;
  RETURN FOUND;
END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION sistema.correo_ciclo_soltar(p_dueno text) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_dueno IS NULL OR pg_catalog.char_length(p_dueno) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'correo_ciclo_soltar: dueno invalido';
  END IF;
  UPDATE public.correo_programacion g SET ultimo_ciclo_fin = pg_catalog.clock_timestamp(), ciclo_hasta = NULL
   WHERE g.id = 1 AND g.ciclo_dueno = p_dueno AND g.ciclo_hasta IS NOT NULL;
END
$$;--> statement-breakpoint

-- Solo el dueño con el candado vigente cierra el día (el ciclo atendió todos los estudios); nunca lo retrocede.
CREATE OR REPLACE FUNCTION sistema.correo_resumen_cerrar(p_dueno text, p_dia date) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_dueno IS NULL OR pg_catalog.char_length(p_dueno) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'correo_resumen_cerrar: dueno invalido';
  END IF;
  IF p_dia IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'correo_resumen_cerrar: dia invalido';
  END IF;
  UPDATE public.correo_programacion g SET resumen_cerrado = GREATEST(coalesce(g.resumen_cerrado, p_dia), p_dia)
   WHERE g.id = 1 AND g.ciclo_dueno = p_dueno AND g.ciclo_hasta IS NOT NULL AND g.ciclo_hasta >= pg_catalog.clock_timestamp();
END
$$;--> statement-breakpoint

-- Estudios con suscripción activa o prueba vigente y lo que su plan habilita (ausente = true; R-12). Lee la suscripción de cada estudio
-- con app.tenant_id fijado a ese estudio (sistema.estudios_ids enumera, como estudios_buzon de 0055) y lo devuelve a su valor.
CREATE OR REPLACE FUNCTION sistema.estudios_correo() RETURNS TABLE (tenant_id uuid, avisos boolean, resumen boolean)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_previo text := pg_catalog.current_setting('app.tenant_id', true);
  v_estudio uuid;
  v_features jsonb;
BEGIN
  FOR v_estudio IN SELECT e.e FROM sistema.estudios_ids() AS e(e) LOOP
    PERFORM pg_catalog.set_config('app.tenant_id', v_estudio::text, true);
    SELECT p.features INTO v_features
      FROM public.suscripcion s JOIN public.plan p ON p.id = s.plan_id
     WHERE s.tenant_id = v_estudio
       AND (s.estado = 'activa' OR (s.estado = 'prueba' AND s.prueba_vence_en > pg_catalog.clock_timestamp()));
    IF FOUND THEN
      tenant_id := v_estudio;
      avisos := (v_features -> 'correo_avisos') IS DISTINCT FROM 'false'::jsonb;
      resumen := (v_features -> 'correo_resumen') IS DISTINCT FROM 'false'::jsonb;
      RETURN NEXT;
    END IF;
  END LOOP;
  PERFORM pg_catalog.set_config('app.tenant_id', coalesce(v_previo, ''), true);
END
$$;--> statement-breakpoint

-- ---- Encolado de los avisos vencidos (worker en withTenant; R-1, R-14) --------------------------------------------------------
-- Un trabajo `notificacion.enviar` {envioId} por envío de avisos pendiente, sin tomar y vencido, que aún no tenga uno vivo (dedupe por
-- envío: sha256 del JSON canónico ["notificacion.enviar",null,{"envioId":...}]). Sin cliente ni solicitante.
CREATE OR REPLACE FUNCTION public.encolar_correo_avisos(p_limite integer) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := nullif(pg_catalog.current_setting('app.tenant_id', true), '')::uuid;
  v_max smallint;
  v_n integer;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'encolar_correo_avisos: sesion sin estudio';
  END IF;
  IF p_limite IS NULL OR p_limite < 1 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'encolar_correo_avisos: limite invalido';
  END IF;
  SELECT (cs.reintentos + 1)::smallint INTO v_max FROM public.config_sistema cs WHERE cs.cola = 'notificaciones';
  v_max := coalesce(v_max, 3::smallint);
  WITH candidatos AS (
    SELECT c.id, c.clave
      FROM (SELECT e.id, e.programado_para,
                   pg_catalog.sha256(pg_catalog.convert_to(
                     '["notificacion.enviar",null,' || pg_catalog.jsonb_build_object('envioId', e.id)::text || ']', 'UTF8')) AS clave
              FROM public.correo_envio e
             WHERE e.tenant_id = v_tenant AND e.origen = 'aviso' AND e.estado = 'pendiente' AND e.tomado_en IS NULL
               AND e.programado_para <= pg_catalog.clock_timestamp()) c
     WHERE NOT EXISTS (SELECT 1 FROM public.job_registro j
                        WHERE j.tenant_id = v_tenant AND j.clave_dedupe = c.clave AND j.estado IN ('en_cola', 'ejecutando'))
     ORDER BY c.programado_para, c.id
     LIMIT p_limite
  ), nuevos AS (
    INSERT INTO public.job_registro AS j
      (cliente_id, ruc, tipo, cola, canal, prioridad, estado, parametros, clave_dedupe, creado_por, max_intentos)
    SELECT NULL, NULL, 'notificacion.enviar', 'notificaciones', 'ninguno', 'programado', 'en_cola',
           pg_catalog.jsonb_build_object('envioId', c.id), c.clave, NULL, v_max
      FROM candidatos c
    ON CONFLICT (tenant_id, clave_dedupe)
      WHERE estado IN ('en_cola', 'ejecutando') AND (tipo <> 'compras.reevaluar' OR (estado = 'en_cola' AND intentos = 0))
      DO NOTHING
    RETURNING j.id
  )
  SELECT pg_catalog.count(*)::integer INTO v_n FROM nuevos;
  RETURN v_n;
END
$$;--> statement-breakpoint

-- ---- Resúmenes y avisos pendientes del día (worker en withTenant; R-5, R-12, R-13, R-14, U-17) --------------------------------
-- Por usuario activo con el resumen activo: un envío `resumen` (clave del día) que también lleva sus diferidos. Sin resumen activo y
-- con diferidos: un envío `pendientes` por tipo. ON CONFLICT DO NOTHING (dos ciclos el mismo día no duplican); cada envío nuevo con
-- su trabajo `notificacion.enviar`. Sin plan vigente, nada; con `correo_resumen: false`, ningún resumen (los diferidos van a pendientes).
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

-- ---- Tomar y cerrar un envío (worker en withTenant; R-3, R-9, R-12, R-13) ------------------------------------------------------
-- Tomar: marca tomado_en y suma un intento (solo un envío `pendiente` del estudio: si no, P0002). Devuelve el envío, el corte del
-- resumen anterior (enviado, u omitido por sin_novedades) y lo que el worker revalida en la misma toma: la preferencia efectiva del
-- tipo, «todos los clientes» y el plan del estudio (vigente y funciones habilitadas, R-12).
CREATE OR REPLACE FUNCTION public.correo_envio_tomar(p_envio uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := nullif(pg_catalog.current_setting('app.tenant_id', true), '')::uuid;
  e record;
  v_corte timestamptz;
  v_rol text;
  v_activo boolean;
  v_todos boolean;
  v_features jsonb;
  v_vigente boolean;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'correo_envio_tomar: sesion sin estudio';
  END IF;
  UPDATE public.correo_envio x SET tomado_en = pg_catalog.clock_timestamp(), intentos = x.intentos + 1
   WHERE x.tenant_id = v_tenant AND x.id = p_envio AND x.estado = 'pendiente'
  RETURNING x.id, x.usuario_id, x.tipo, x.origen, x.intentos, x.dia_lima INTO e;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'correo_envio_tomar: envio inexistente';
  END IF;
  IF e.origen = 'resumen' THEN
    SELECT pg_catalog.max(r.corte_hasta) INTO v_corte FROM public.correo_envio r
     WHERE r.tenant_id = v_tenant AND r.usuario_id = e.usuario_id AND r.origen = 'resumen' AND r.id <> e.id
       AND (r.estado = 'enviado' OR (r.estado = 'omitido' AND r.motivo = 'sin_novedades'));
  END IF;
  SELECT m.rol INTO v_rol FROM public.membresia m WHERE m.tenant_id = v_tenant AND m.usuario_id = e.usuario_id;
  SELECT cp.activo INTO v_activo FROM public.correo_preferencia cp
   WHERE cp.tenant_id = v_tenant AND cp.usuario_id = e.usuario_id AND cp.tipo = e.tipo;
  IF NOT FOUND THEN
    v_activo := CASE e.tipo WHEN 'buzon_critico' THEN true WHEN 'credencial_invalida' THEN true
                            WHEN 'plan_limite' THEN coalesce(v_rol = 'dueno', false) ELSE false END;
  END IF;
  SELECT cp.todos_clientes INTO v_todos FROM public.correo_preferencia cp
   WHERE cp.tenant_id = v_tenant AND cp.usuario_id = e.usuario_id AND cp.tipo = 'resumen';
  SELECT p.features, true INTO v_features, v_vigente
    FROM public.suscripcion s JOIN public.plan p ON p.id = s.plan_id
   WHERE s.tenant_id = v_tenant
     AND (s.estado = 'activa' OR (s.estado = 'prueba' AND s.prueba_vence_en > pg_catalog.clock_timestamp()));
  RETURN pg_catalog.jsonb_build_object(
    'envioId', e.id,
    'usuarioId', e.usuario_id,
    'tipo', e.tipo,
    'origen', e.origen,
    'intentos', e.intentos,
    'diaLima', pg_catalog.to_char(e.dia_lima, 'YYYY-MM-DD'),
    'corteDesde', v_corte,
    'preferencia', coalesce(v_activo, false),
    'todosClientes', coalesce(v_todos, false),
    'plan', pg_catalog.jsonb_build_object(
      'vigente', coalesce(v_vigente, false),
      'avisos', coalesce(v_vigente, false) AND (v_features -> 'correo_avisos') IS DISTINCT FROM 'false'::jsonb,
      'resumen', coalesce(v_vigente, false) AND (v_features -> 'correo_resumen') IS DISTINCT FROM 'false'::jsonb));
END
$$;--> statement-breakpoint

-- Cerrar: enviado (enviado_en = ahora), omitido con un motivo de R-3 o fallido por transporte; fija corte_hasta. Solo un envío
-- `pendiente` del estudio (si no, P0002); estado, motivo o combinación inválidos: 22023.
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
                                                        'sin_contenido', 'sin_novedades'))
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

-- ---- Token de baja de un correo (worker en withTenant; R-7) -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.correo_baja_token_crear(p_envio uuid, p_hash bytea) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := nullif(pg_catalog.current_setting('app.tenant_id', true), '')::uuid;
  v_usuario uuid;
  v_tipo text;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'correo_baja_token_crear: sesion sin estudio';
  END IF;
  IF p_hash IS NULL OR pg_catalog.octet_length(p_hash) <> 32 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'correo_baja_token_crear: hash invalido';
  END IF;
  SELECT e.usuario_id, e.tipo INTO v_usuario, v_tipo FROM public.correo_envio e WHERE e.tenant_id = v_tenant AND e.id = p_envio;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'correo_baja_token_crear: envio inexistente';
  END IF;
  INSERT INTO public.correo_baja_token (tenant_id, hash, usuario_id, tipo, envio_id, creado_en, vence_en)
  VALUES (v_tenant, p_hash, v_usuario, v_tipo, p_envio, pg_catalog.clock_timestamp(),
          pg_catalog.clock_timestamp() + interval '90 days');
END
$$;--> statement-breakpoint

-- ---- Destinatario (worker en withTenant; R-3): membresía activa, correo vigente, rol y nombre del estudio -----------------------
-- El worker no tiene SELECT sobre `usuario` (H9 de 002): lee el correo de un miembro activo del estudio de la sesión solo por aquí.
CREATE OR REPLACE FUNCTION public.correo_destinatario(p_usuario uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := nullif(pg_catalog.current_setting('app.tenant_id', true), '')::uuid;
  v_res jsonb;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'correo_destinatario: sesion sin estudio';
  END IF;
  SELECT pg_catalog.jsonb_build_object('usuarioId', m.usuario_id, 'email', u.email, 'rol', m.rol, 'estudioNombre', t.nombre)
    INTO v_res
    FROM public.membresia m
    JOIN public.usuario u ON u.id = m.usuario_id
    JOIN public.tenant t ON t.id = m.tenant_id
   WHERE m.tenant_id = v_tenant AND m.usuario_id = p_usuario AND m.desactivada_en IS NULL;
  RETURN v_res;
END
$$;--> statement-breakpoint

-- ---- Purga a 90 días (worker en withTenant; R-11, P-7) -------------------------------------------------------------------------
-- Borra los envíos viejos del estudio (sus avisos y tokens caen en cascada) y los avisos diferidos y tokens sueltos viejos. Devuelve
-- cuántos envíos borró.
CREATE OR REPLACE FUNCTION public.correo_purgar(p_dias integer) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := nullif(pg_catalog.current_setting('app.tenant_id', true), '')::uuid;
  v_limite timestamptz;
  v_n integer;
BEGIN
  IF p_dias IS NULL OR p_dias < 1 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'correo_purgar: minimo 1 dia';
  END IF;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'correo_purgar: sesion sin estudio';
  END IF;
  v_limite := pg_catalog.clock_timestamp() - pg_catalog.make_interval(days => p_dias);
  DELETE FROM public.correo_envio e WHERE e.tenant_id = v_tenant AND e.creado_en < v_limite;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  DELETE FROM public.correo_envio_aviso a WHERE a.tenant_id = v_tenant AND a.envio_id IS NULL AND a.creado_en < v_limite;
  DELETE FROM public.correo_baja_token k WHERE k.tenant_id = v_tenant AND k.creado_en < v_limite;
  RETURN v_n;
END
$$;--> statement-breakpoint

-- ---- Dueños, EXECUTE y nada para PUBLIC ------------------------------------------------------------------------------------------
ALTER FUNCTION public.correo_preferencia_efectiva(uuid, uuid, text) OWNER TO contapp_migrator;--> statement-breakpoint
ALTER FUNCTION interno.notificar(uuid, uuid[], text, uuid, uuid, jsonb, text) OWNER TO contapp_registrador;--> statement-breakpoint
ALTER FUNCTION public.correo_preferencias_fijar(jsonb) OWNER TO contapp_migrator;--> statement-breakpoint
ALTER FUNCTION auth.correo_baja_aplicar(bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.limite_consumir(text, text) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION sistema.correo_ciclo_tomar(text) OWNER TO contapp_migrator;--> statement-breakpoint
ALTER FUNCTION sistema.correo_ciclo_renovar(text) OWNER TO contapp_migrator;--> statement-breakpoint
ALTER FUNCTION sistema.correo_ciclo_soltar(text) OWNER TO contapp_migrator;--> statement-breakpoint
ALTER FUNCTION sistema.correo_resumen_cerrar(text, date) OWNER TO contapp_migrator;--> statement-breakpoint
ALTER FUNCTION sistema.estudios_correo() OWNER TO contapp_migrator;--> statement-breakpoint
ALTER FUNCTION public.encolar_correo_avisos(integer) OWNER TO contapp_migrator;--> statement-breakpoint
ALTER FUNCTION public.crear_correo_resumenes(date) OWNER TO contapp_migrator;--> statement-breakpoint
ALTER FUNCTION public.correo_envio_tomar(uuid) OWNER TO contapp_migrator;--> statement-breakpoint
ALTER FUNCTION public.correo_envio_cerrar(uuid, text, text, timestamptz) OWNER TO contapp_migrator;--> statement-breakpoint
ALTER FUNCTION public.correo_baja_token_crear(uuid, bytea) OWNER TO contapp_migrator;--> statement-breakpoint
ALTER FUNCTION public.correo_destinatario(uuid) OWNER TO contapp_migrator;--> statement-breakpoint
ALTER FUNCTION public.correo_purgar(integer) OWNER TO contapp_migrator;--> statement-breakpoint
ALTER FUNCTION public.buzon_mensaje_aviso() OWNER TO contapp_migrator;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.buzon_mensaje_aviso()
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.correo_preferencia_efectiva(uuid, uuid, text)
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador;--> statement-breakpoint
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
REVOKE ALL ON FUNCTION sistema.correo_ciclo_soltar(text)
  FROM PUBLIC, contapp_backend, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
REVOKE ALL ON FUNCTION sistema.correo_resumen_cerrar(text, date)
  FROM PUBLIC, contapp_backend, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
REVOKE ALL ON FUNCTION sistema.estudios_correo()
  FROM PUBLIC, contapp_backend, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.encolar_correo_avisos(integer)
  FROM PUBLIC, contapp_backend, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.crear_correo_resumenes(date)
  FROM PUBLIC, contapp_backend, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.correo_envio_tomar(uuid)
  FROM PUBLIC, contapp_backend, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.correo_envio_cerrar(uuid, text, text, timestamptz)
  FROM PUBLIC, contapp_backend, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.correo_baja_token_crear(uuid, bytea)
  FROM PUBLIC, contapp_backend, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.correo_destinatario(uuid)
  FROM PUBLIC, contapp_backend, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.correo_purgar(integer)
  FROM PUBLIC, contapp_backend, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.correo_preferencia_efectiva(uuid, uuid, text) TO contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION interno.notificar(uuid, uuid[], text, uuid, uuid, jsonb, text) TO contapp_migrator;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.correo_preferencias_fijar(jsonb) TO contapp_backend;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth.correo_baja_aplicar(bytea) TO contapp_backend;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth.limite_consumir(text, text) TO contapp_backend;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION sistema.correo_ciclo_tomar(text) TO contapp_worker;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION sistema.correo_ciclo_renovar(text) TO contapp_worker;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION sistema.correo_ciclo_soltar(text) TO contapp_worker;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION sistema.correo_resumen_cerrar(text, date) TO contapp_worker;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION sistema.estudios_correo() TO contapp_worker;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.encolar_correo_avisos(integer) TO contapp_worker;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.crear_correo_resumenes(date) TO contapp_worker;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.correo_envio_tomar(uuid) TO contapp_worker;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.correo_envio_cerrar(uuid, text, text, timestamptz) TO contapp_worker;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.correo_baja_token_crear(uuid, bytea) TO contapp_worker;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.correo_destinatario(uuid) TO contapp_worker;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.correo_purgar(integer) TO contapp_worker;
