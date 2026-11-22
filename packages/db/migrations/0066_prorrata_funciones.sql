-- 0066_prorrata_funciones (spec 026, D-3 a D-7; R-5, R-8; CA-1, CA-3, CA-4, CA-6 a CA-10). Funciones acotadas de la prorrata: el ÚNICO
-- camino que escribe las cuatro tablas de 0065. Repetible (CREATE OR REPLACE; ALTER/REVOKE/GRANT idempotentes). SECURITY DEFINER de
-- contapp_migrator (no superusuario ni BYPASSRLS: la RLS sigue aplicando con el app.tenant_id de la sesión), search_path fijo, nombres
-- calificados, SQLSTATE y mensajes fijos (nunca RUC, montos, porcentajes, motivos ni ids). EXECUTE solo al rol indicado.
--   Sin subtransacciones: no hay bloques EXCEPTION ni SAVEPOINT; las entradas se validan con expresiones regulares y rangos ANTES de
--   convertir (ninguna conversión puede fallar). La del worker corre en su transacción, sin SAVEPOINT (D-3, nota de 0038).
--   Orden de las comprobaciones: estudio y usuario (42501) -> cliente FOR SHARE (P0002 ajeno o inexistente; 55000 archivado) ->
--   entradas (22023) -> pg_advisory_xact_lock por (cliente, periodo) en orden ascendente de periodo -> CA412/CA413 -> CA409.
--   Concurrencia: el FOR SHARE del cliente serializa con archivar (UPDATE de cliente); el advisory por (cliente, periodo) serializa
--   guardar, eliminar, la prorrata usada y el registro del worker sobre el mismo mes (el registro toma los de todos sus periodos
--   leídos, en orden ascendente: dos registros simultáneos se reparten las presentaciones nuevas sin duplicar ni 40P01). La única por
--   (cliente, periodo, version) cierra el compare-and-set aunque faltara el advisory.
--
--   prorrata_declaraciones_registrar(p_cliente, p_trabajo, p_periodo_hasta, p_leidos char(6)[], p_sin_declaracion char(6)[],
--     p_declaraciones jsonb) -> integer (nuevas)                                                                    (contapp_worker)
--     Exige app.tenant_id (42501). 22023 a TODO (sin escribir nada) si: p_trabajo no es un sol.declaraciones.descargar del mismo
--     cliente con parametros.periodo = p_periodo_hasta; p_periodo_hasta no es AAAAMM; p_leidos vacío, de más de 12, con nulos,
--     repetidos o fuera de la ventana M-11..M; p_sin_declaracion con nulos, repetidos o fuera de p_leidos; p_declaraciones no es un
--     arreglo (<= 1200) de objetos con EXACTAMENTE las claves periodo, numero_orden, fecha_presentacion, tipo, ventas_gravadas_base,
--     ventas_gravadas_igv, exportaciones, no_gravadas, igv_adq_dg, igv_adq_dgng y prorrata_usada (cadenas; prorrata_usada cadena o
--     null): periodo leído y no «sin declaración», numero_orden 1..15 dígitos > 0, fecha AAAA-MM-DD real, tipo original |
--     rectificatoria, montos -?d{1,12}(.d{1,2})?, prorrata 0..100 con hasta 2 decimales, sin presentaciones repetidas. Inserta la
--     obtención (nuevas = presentaciones que no existían) y las presentaciones ON CONFLICT DO NOTHING (la misma presentación no se
--     sobrescribe). Nunca toca ventas, compras ni los manuales. Audita prorrata.declaraciones_obtenidas (actor trabajo cuando el
--     worker fija app.trabajo_id) con {periodo, leidos, sinDeclaracion, nuevas}: solo conteos.
--   prorrata_mes_manual_guardar(p_cliente, p_periodo, p_gravadas, p_exportaciones, p_no_gravadas, p_motivo, p_version) -> integer
--     (contapp_backend) 22023 periodo no AAAAMM, montos nulos, con más de 2 decimales o fuera de NUMERIC(14,2), motivo nulo, en
--     blanco, de más de 500 o con controles o bidi, versión nula o negativa. CA412 si el periodo tiene alguna presentación; CA409 si
--     la última versión del mes (0 sin manual; una «eliminado» también cuenta) no es p_version. Inserta p_version + 1 (guardado) y
--     audita prorrata.mes_manual_guardado {clienteId, periodo, version}.
--   prorrata_mes_manual_eliminar(p_cliente, p_periodo, p_motivo, p_version) -> integer                            (contapp_backend)
--     22023 como guardar (periodo, motivo, versión). CA409 si no hay manual vivo (sin versiones o la última es «eliminado») o la
--     última versión no es p_version. Un mes que ya tiene declaración SÍ admite eliminar el manual que la declaración reemplazó (T4:
--     limpia el historial sin cambiar el resultado, que ya sale de la declaración); guardar sigue dando CA412. Inserta p_version + 1
--     (eliminado, montos NULL) y audita prorrata.mes_manual_eliminado {clienteId, periodo, version}.
--   prorrata_usada_guardar(p_cliente, p_periodo, p_porcentaje, p_version) -> integer                              (contapp_backend)
--     22023 periodo no AAAAMM, porcentaje (no nulo) fuera de 0..100 o con más de 2 decimales, versión nula o negativa. CA413 si la
--     presentación vigente del periodo (mayor número de orden) trae prorrata_usada (también 0.00); CA409 si la última versión no es
--     p_version. Inserta p_version + 1 (NULL deja el mes sin valor) y audita prorrata.usada_guardada {clienteId, periodo, version}.

-- ---- Registrar la obtención del PDT 621 (worker, sin SAVEPOINT) ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prorrata_declaraciones_registrar(
  p_cliente uuid, p_trabajo uuid, p_periodo_hasta char(6), p_leidos char(6)[], p_sin_declaracion char(6)[], p_declaraciones jsonb
) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_uuid CONSTANT text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_periodo CONSTANT text := '^[0-9]{4}(0[1-9]|1[0-2])$';
  v_monto CONSTANT text := '^-?[0-9]{1,12}(\.[0-9]{1,2})?$';
  v_prorrata CONSTANT text := '^(100(\.0{1,2})?|[0-9]{1,2}(\.[0-9]{1,2})?)$';
  v_orden CONSTANT text := '^[0-9]{1,15}$';
  v_fecha CONSTANT text := '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$';
  v_claves CONSTANT text[] := ARRAY['exportaciones', 'fecha_presentacion', 'igv_adq_dg', 'igv_adq_dgng', 'no_gravadas', 'numero_orden',
                                    'periodo', 'prorrata_usada', 'tipo', 'ventas_gravadas_base', 'ventas_gravadas_igv'];
  v_montos CONSTANT text[] := ARRAY['ventas_gravadas_base', 'ventas_gravadas_igv', 'exportaciones', 'no_gravadas', 'igv_adq_dg',
                                    'igv_adq_dgng'];
  v_tenant_txt text := nullif(current_setting('app.tenant_id', true), '');
  v_tenant uuid;
  v_archivado timestamptz;
  v_hasta text;
  v_hasta_n integer;
  v_leidos text[];
  v_sin text[];
  v_item jsonb;
  v_clave text;
  v_texto text;
  v_anio integer;
  v_mes integer;
  v_p text;
  v_obtencion uuid;
  v_nuevas integer;
  v_insertadas integer;
BEGIN
  -- ---- Quién llama ----
  IF v_tenant_txt IS NULL OR v_tenant_txt !~ v_uuid THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'prorrata_declaraciones_registrar: sesion sin estudio';
  END IF;
  v_tenant := v_tenant_txt::uuid;

  -- ---- 1. Cliente FOR SHARE (serializa con archivar) ----
  IF p_cliente IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'prorrata_declaraciones_registrar: cliente no encontrado';
  END IF;
  SELECT k.archivado_at INTO v_archivado FROM public.cliente k
   WHERE k.tenant_id = v_tenant AND k.id = p_cliente
     FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'prorrata_declaraciones_registrar: cliente no encontrado';
  END IF;
  IF v_archivado IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'prorrata_declaraciones_registrar: cliente archivado';
  END IF;

  -- ---- 2. Periodo hasta y trabajo ----
  v_hasta := p_periodo_hasta::text;
  IF v_hasta IS NULL OR v_hasta !~ v_periodo OR p_trabajo IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'prorrata_declaraciones_registrar: entradas invalidas';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.job_registro j
     WHERE j.tenant_id = v_tenant AND j.id = p_trabajo AND j.cliente_id = p_cliente AND j.tipo = 'sol.declaraciones.descargar'
       AND jsonb_typeof(j.parametros) = 'object' AND (j.parametros ->> 'periodo') = v_hasta
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'prorrata_declaraciones_registrar: trabajo invalido';
  END IF;
  v_hasta_n := substr(v_hasta, 1, 4)::integer * 12 + substr(v_hasta, 5, 2)::integer - 1;

  -- ---- 3. Periodos leídos (1..12, ventana M-11..M) y sin declaración (subconjunto) ----
  IF p_leidos IS NULL OR p_sin_declaracion IS NULL
     OR coalesce(array_ndims(p_leidos), 0) <> 1 OR cardinality(p_leidos) NOT BETWEEN 1 AND 12
     OR array_position(p_leidos, NULL) IS NOT NULL
     OR (cardinality(p_sin_declaracion) > 0 AND (array_ndims(p_sin_declaracion) <> 1
         OR array_position(p_sin_declaracion, NULL) IS NOT NULL)) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'prorrata_declaraciones_registrar: periodos invalidos';
  END IF;
  v_leidos := ARRAY(SELECT u.p::text FROM unnest(p_leidos) AS u(p) ORDER BY 1);
  v_sin := ARRAY(SELECT u.p::text FROM unnest(p_sin_declaracion) AS u(p) ORDER BY 1);
  IF EXISTS (SELECT 1 FROM unnest(v_leidos) AS u(p) WHERE u.p !~ v_periodo)
     OR (SELECT count(DISTINCT u.p) FROM unnest(v_leidos) AS u(p)) <> cardinality(v_leidos)
     OR (SELECT count(DISTINCT u.p) FROM unnest(v_sin) AS u(p)) <> cardinality(v_sin)
     OR NOT (v_sin <@ v_leidos) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'prorrata_declaraciones_registrar: periodos invalidos';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(v_leidos) AS u(p)
     WHERE substr(u.p, 1, 4)::integer * 12 + substr(u.p, 5, 2)::integer - 1 NOT BETWEEN v_hasta_n - 11 AND v_hasta_n
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'prorrata_declaraciones_registrar: periodos invalidos';
  END IF;

  -- ---- 4. Declaraciones: todas o ninguna ----
  IF jsonb_typeof(p_declaraciones) IS DISTINCT FROM 'array' OR jsonb_array_length(p_declaraciones) > 1200 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'prorrata_declaraciones_registrar: declaraciones invalidas';
  END IF;
  FOR v_item IN SELECT e.value FROM jsonb_array_elements(p_declaraciones) AS e LOOP
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'prorrata_declaraciones_registrar: declaraciones invalidas';
    END IF;
    IF (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(v_item) AS k) IS DISTINCT FROM v_claves THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'prorrata_declaraciones_registrar: declaraciones invalidas';
    END IF;
    FOREACH v_clave IN ARRAY ARRAY['periodo', 'numero_orden', 'fecha_presentacion', 'tipo'] || v_montos LOOP
      IF jsonb_typeof(v_item -> v_clave) IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'prorrata_declaraciones_registrar: declaraciones invalidas';
      END IF;
    END LOOP;
    -- Periodo leído y con declaración; orden de 1 a 15 dígitos, mayor que cero; tipo conocido.
    v_p := v_item ->> 'periodo';
    IF v_p !~ v_periodo OR NOT (v_p = ANY (v_leidos)) OR v_p = ANY (v_sin)
       OR (v_item ->> 'numero_orden') !~ v_orden OR (v_item ->> 'numero_orden') !~ '[1-9]'
       OR (v_item ->> 'tipo') NOT IN ('original', 'rectificatoria') THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'prorrata_declaraciones_registrar: declaraciones invalidas';
    END IF;
    -- Fecha real (AAAA-MM-DD): el día existe en ese mes.
    v_texto := v_item ->> 'fecha_presentacion';
    IF v_texto !~ v_fecha THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'prorrata_declaraciones_registrar: declaraciones invalidas';
    END IF;
    v_anio := substr(v_texto, 1, 4)::integer;
    v_mes := substr(v_texto, 6, 2)::integer;
    IF v_anio < 1900
       OR substr(v_texto, 9, 2)::integer
          > extract(day FROM (make_date(v_anio, v_mes, 1) + interval '1 month' - interval '1 day'))::integer THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'prorrata_declaraciones_registrar: declaraciones invalidas';
    END IF;
    -- Montos dentro de NUMERIC(14,2), con signo y hasta 2 decimales; prorrata usada nula o 0..100 con hasta 2 decimales.
    FOREACH v_clave IN ARRAY v_montos LOOP
      IF (v_item ->> v_clave) !~ v_monto THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'prorrata_declaraciones_registrar: declaraciones invalidas';
      END IF;
    END LOOP;
    IF jsonb_typeof(v_item -> 'prorrata_usada') NOT IN ('string', 'null')
       OR (jsonb_typeof(v_item -> 'prorrata_usada') = 'string' AND (v_item ->> 'prorrata_usada') !~ v_prorrata) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'prorrata_declaraciones_registrar: declaraciones invalidas';
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT ((e.value ->> 'periodo'), (e.value ->> 'numero_orden')::numeric)) FROM jsonb_array_elements(p_declaraciones) AS e)
     <> jsonb_array_length(p_declaraciones) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'prorrata_declaraciones_registrar: declaraciones invalidas';
  END IF;

  -- ---- 5. Un periodo a la vez por cliente, en orden ascendente (mismo orden que guardar, eliminar y la prorrata usada) ----
  FOREACH v_p IN ARRAY v_leidos LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('prorrata:' || p_cliente::text || ':' || v_p, 0));
  END LOOP;

  -- ---- 6. Nuevas (bajo los advisory: nadie más inserta presentaciones de estos periodos), obtención y presentaciones ----
  SELECT count(*)::integer INTO v_nuevas FROM jsonb_array_elements(p_declaraciones) AS e
   WHERE NOT EXISTS (
     SELECT 1 FROM public.declaracion_mensual d
      WHERE d.tenant_id = v_tenant AND d.cliente_id = p_cliente AND d.periodo = (e.value ->> 'periodo')::char(6)
        AND d.numero_orden = (e.value ->> 'numero_orden')::numeric);
  INSERT INTO public.prorrata_obtencion (tenant_id, cliente_id, periodo_hasta, trabajo_id, periodos_leidos,
                                         periodos_sin_declaracion, nuevas, obtenida_en)
  VALUES (v_tenant, p_cliente, v_hasta::char(6), p_trabajo,
          ARRAY(SELECT u.p::char(6) FROM unnest(v_leidos) AS u(p) ORDER BY u.p DESC),
          ARRAY(SELECT u.p::char(6) FROM unnest(v_sin) AS u(p) ORDER BY u.p DESC),
          v_nuevas, clock_timestamp())
  RETURNING id INTO v_obtencion;
  INSERT INTO public.declaracion_mensual (tenant_id, cliente_id, periodo, numero_orden, fecha_presentacion, tipo, ventas_gravadas_base,
                                          ventas_gravadas_igv, exportaciones, no_gravadas, igv_adq_dg, igv_adq_dgng, prorrata_usada,
                                          obtencion_id)
  SELECT v_tenant, p_cliente, (e.value ->> 'periodo')::char(6), (e.value ->> 'numero_orden')::numeric,
         make_date(substr(e.value ->> 'fecha_presentacion', 1, 4)::integer, substr(e.value ->> 'fecha_presentacion', 6, 2)::integer,
                   substr(e.value ->> 'fecha_presentacion', 9, 2)::integer),
         e.value ->> 'tipo', (e.value ->> 'ventas_gravadas_base')::numeric, (e.value ->> 'ventas_gravadas_igv')::numeric,
         (e.value ->> 'exportaciones')::numeric, (e.value ->> 'no_gravadas')::numeric, (e.value ->> 'igv_adq_dg')::numeric,
         (e.value ->> 'igv_adq_dgng')::numeric, (e.value ->> 'prorrata_usada')::numeric, v_obtencion
    FROM jsonb_array_elements(p_declaraciones) AS e
   ORDER BY e.value ->> 'periodo', (e.value ->> 'numero_orden')::numeric
  ON CONFLICT (tenant_id, cliente_id, periodo, numero_orden) DO NOTHING;
  GET DIAGNOSTICS v_insertadas = ROW_COUNT;
  IF v_insertadas <> v_nuevas THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'prorrata_declaraciones_registrar: conflicto concurrente';
  END IF;

  PERFORM public.auditoria_registrar(v_tenant, 'prorrata.declaraciones_obtenidas', p_cliente, 'prorrata_obtencion', v_obtencion,
    jsonb_build_object('periodo', v_hasta, 'leidos', cardinality(v_leidos), 'sinDeclaracion', cardinality(v_sin),
                       'nuevas', v_nuevas));
  RETURN v_nuevas;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.prorrata_declaraciones_registrar(uuid, uuid, char(6), char(6)[], char(6)[], jsonb) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.prorrata_declaraciones_registrar(uuid, uuid, char(6), char(6)[], char(6)[], jsonb)
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.prorrata_declaraciones_registrar(uuid, uuid, char(6), char(6)[], char(6)[], jsonb) TO contapp_worker;--> statement-breakpoint

-- ---- Guardar el mes manual (backend) ----------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prorrata_mes_manual_guardar(
  p_cliente uuid, p_periodo char(6), p_gravadas numeric, p_exportaciones numeric, p_no_gravadas numeric, p_motivo text,
  p_version integer
) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_uuid CONSTANT text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_controles CONSTANT text := '[\u0001-\u001F\u007F-\u009F؜‎‏‪-‮⁦-⁩]';
  v_tenant_txt text := nullif(current_setting('app.tenant_id', true), '');
  v_usuario_txt text := nullif(current_setting('app.user_id', true), '');
  v_tenant uuid;
  v_usuario uuid;
  v_archivado timestamptz;
  v_periodo text;
  v_actual integer;
  v_id uuid;
BEGIN
  -- ---- Quién llama ----
  IF v_tenant_txt IS NULL OR v_usuario_txt IS NULL OR v_tenant_txt !~ v_uuid OR v_usuario_txt !~ v_uuid THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'prorrata_mes_manual_guardar: sesion sin estudio o sin usuario';
  END IF;
  v_tenant := v_tenant_txt::uuid;
  v_usuario := v_usuario_txt::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM public.membresia mb
     WHERE mb.tenant_id = v_tenant AND mb.usuario_id = v_usuario AND mb.desactivada_en IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'prorrata_mes_manual_guardar: sin membresia activa';
  END IF;

  -- ---- 1. Cliente FOR SHARE ----
  IF p_cliente IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'prorrata_mes_manual_guardar: cliente no encontrado';
  END IF;
  SELECT k.archivado_at INTO v_archivado FROM public.cliente k
   WHERE k.tenant_id = v_tenant AND k.id = p_cliente
     FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'prorrata_mes_manual_guardar: cliente no encontrado';
  END IF;
  IF v_archivado IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'prorrata_mes_manual_guardar: cliente archivado';
  END IF;

  -- ---- 2. Entradas ----
  v_periodo := p_periodo::text;
  IF v_periodo IS NULL OR v_periodo !~ '^[0-9]{4}(0[1-9]|1[0-2])$'
     OR p_gravadas IS NULL OR p_exportaciones IS NULL OR p_no_gravadas IS NULL
     OR p_gravadas <> round(p_gravadas, 2) OR p_exportaciones <> round(p_exportaciones, 2) OR p_no_gravadas <> round(p_no_gravadas, 2)
     OR abs(p_gravadas) >= 1000000000000 OR abs(p_exportaciones) >= 1000000000000 OR abs(p_no_gravadas) >= 1000000000000
     OR p_motivo IS NULL OR char_length(p_motivo) NOT BETWEEN 1 AND 500 OR btrim(p_motivo) = '' OR p_motivo ~ v_controles
     OR p_version IS NULL OR p_version < 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'prorrata_mes_manual_guardar: entradas invalidas';
  END IF;

  -- ---- 3. El mes, uno a la vez (mismo advisory que el registro del worker) ----
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('prorrata:' || p_cliente::text || ':' || v_periodo, 0));

  -- ---- 4. Mes con declaración: no se ingresa a mano (R-5) ----
  IF EXISTS (
    SELECT 1 FROM public.declaracion_mensual d
     WHERE d.tenant_id = v_tenant AND d.cliente_id = p_cliente AND d.periodo = p_periodo
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'CA412', MESSAGE = 'prorrata_mes_manual_guardar: el mes tiene declaracion';
  END IF;

  -- ---- 5. Compare-and-set por versión ----
  SELECT coalesce(max(m.version), 0) INTO v_actual FROM public.prorrata_mes_manual m
   WHERE m.tenant_id = v_tenant AND m.cliente_id = p_cliente AND m.periodo = p_periodo;
  IF v_actual <> p_version THEN
    RAISE EXCEPTION USING ERRCODE = 'CA409', MESSAGE = 'prorrata_mes_manual_guardar: el mes cambio';
  END IF;

  INSERT INTO public.prorrata_mes_manual (tenant_id, cliente_id, periodo, version, accion, gravadas, exportaciones, no_gravadas, motivo,
                                          autor, creado_en)
  VALUES (v_tenant, p_cliente, p_periodo, p_version + 1, 'guardado', p_gravadas, p_exportaciones, p_no_gravadas, p_motivo, v_usuario,
          clock_timestamp())
  RETURNING id INTO v_id;
  PERFORM public.auditoria_registrar(v_tenant, 'prorrata.mes_manual_guardado', p_cliente, 'prorrata_mes_manual', v_id,
    jsonb_build_object('clienteId', p_cliente, 'periodo', v_periodo, 'version', p_version + 1));
  RETURN p_version + 1;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.prorrata_mes_manual_guardar(uuid, char(6), numeric, numeric, numeric, text, integer) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.prorrata_mes_manual_guardar(uuid, char(6), numeric, numeric, numeric, text, integer)
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.prorrata_mes_manual_guardar(uuid, char(6), numeric, numeric, numeric, text, integer) TO contapp_backend;--> statement-breakpoint

-- ---- Eliminar el mes manual (backend) ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prorrata_mes_manual_eliminar(p_cliente uuid, p_periodo char(6), p_motivo text, p_version integer)
  RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_uuid CONSTANT text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_controles CONSTANT text := '[\u0001-\u001F\u007F-\u009F؜‎‏‪-‮⁦-⁩]';
  v_tenant_txt text := nullif(current_setting('app.tenant_id', true), '');
  v_usuario_txt text := nullif(current_setting('app.user_id', true), '');
  v_tenant uuid;
  v_usuario uuid;
  v_archivado timestamptz;
  v_periodo text;
  v_ultima record;
  v_id uuid;
BEGIN
  -- ---- Quién llama ----
  IF v_tenant_txt IS NULL OR v_usuario_txt IS NULL OR v_tenant_txt !~ v_uuid OR v_usuario_txt !~ v_uuid THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'prorrata_mes_manual_eliminar: sesion sin estudio o sin usuario';
  END IF;
  v_tenant := v_tenant_txt::uuid;
  v_usuario := v_usuario_txt::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM public.membresia mb
     WHERE mb.tenant_id = v_tenant AND mb.usuario_id = v_usuario AND mb.desactivada_en IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'prorrata_mes_manual_eliminar: sin membresia activa';
  END IF;

  -- ---- 1. Cliente FOR SHARE ----
  IF p_cliente IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'prorrata_mes_manual_eliminar: cliente no encontrado';
  END IF;
  SELECT k.archivado_at INTO v_archivado FROM public.cliente k
   WHERE k.tenant_id = v_tenant AND k.id = p_cliente
     FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'prorrata_mes_manual_eliminar: cliente no encontrado';
  END IF;
  IF v_archivado IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'prorrata_mes_manual_eliminar: cliente archivado';
  END IF;

  -- ---- 2. Entradas ----
  v_periodo := p_periodo::text;
  IF v_periodo IS NULL OR v_periodo !~ '^[0-9]{4}(0[1-9]|1[0-2])$'
     OR p_motivo IS NULL OR char_length(p_motivo) NOT BETWEEN 1 AND 500 OR btrim(p_motivo) = '' OR p_motivo ~ v_controles
     OR p_version IS NULL OR p_version < 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'prorrata_mes_manual_eliminar: entradas invalidas';
  END IF;

  -- ---- 3. El mes, uno a la vez ----
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('prorrata:' || p_cliente::text || ':' || v_periodo, 0));

  -- ---- 4. Compare-and-set: debe haber un manual vivo en la versión dada ----
  SELECT m.version, m.accion INTO v_ultima FROM public.prorrata_mes_manual m
   WHERE m.tenant_id = v_tenant AND m.cliente_id = p_cliente AND m.periodo = p_periodo
   ORDER BY m.version DESC
   LIMIT 1;
  IF NOT FOUND OR v_ultima.accion <> 'guardado' OR v_ultima.version <> p_version THEN
    RAISE EXCEPTION USING ERRCODE = 'CA409', MESSAGE = 'prorrata_mes_manual_eliminar: el mes cambio';
  END IF;

  INSERT INTO public.prorrata_mes_manual (tenant_id, cliente_id, periodo, version, accion, gravadas, exportaciones, no_gravadas, motivo,
                                          autor, creado_en)
  VALUES (v_tenant, p_cliente, p_periodo, p_version + 1, 'eliminado', NULL, NULL, NULL, p_motivo, v_usuario, clock_timestamp())
  RETURNING id INTO v_id;
  PERFORM public.auditoria_registrar(v_tenant, 'prorrata.mes_manual_eliminado', p_cliente, 'prorrata_mes_manual', v_id,
    jsonb_build_object('clienteId', p_cliente, 'periodo', v_periodo, 'version', p_version + 1));
  RETURN p_version + 1;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.prorrata_mes_manual_eliminar(uuid, char(6), text, integer) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.prorrata_mes_manual_eliminar(uuid, char(6), text, integer)
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.prorrata_mes_manual_eliminar(uuid, char(6), text, integer) TO contapp_backend;--> statement-breakpoint

-- ---- Guardar la prorrata usada (backend) ------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prorrata_usada_guardar(p_cliente uuid, p_periodo char(6), p_porcentaje numeric, p_version integer)
  RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_uuid CONSTANT text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_tenant_txt text := nullif(current_setting('app.tenant_id', true), '');
  v_usuario_txt text := nullif(current_setting('app.user_id', true), '');
  v_tenant uuid;
  v_usuario uuid;
  v_archivado timestamptz;
  v_periodo text;
  v_actual integer;
  v_id uuid;
BEGIN
  -- ---- Quién llama ----
  IF v_tenant_txt IS NULL OR v_usuario_txt IS NULL OR v_tenant_txt !~ v_uuid OR v_usuario_txt !~ v_uuid THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'prorrata_usada_guardar: sesion sin estudio o sin usuario';
  END IF;
  v_tenant := v_tenant_txt::uuid;
  v_usuario := v_usuario_txt::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM public.membresia mb
     WHERE mb.tenant_id = v_tenant AND mb.usuario_id = v_usuario AND mb.desactivada_en IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'prorrata_usada_guardar: sin membresia activa';
  END IF;

  -- ---- 1. Cliente FOR SHARE ----
  IF p_cliente IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'prorrata_usada_guardar: cliente no encontrado';
  END IF;
  SELECT k.archivado_at INTO v_archivado FROM public.cliente k
   WHERE k.tenant_id = v_tenant AND k.id = p_cliente
     FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'prorrata_usada_guardar: cliente no encontrado';
  END IF;
  IF v_archivado IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'prorrata_usada_guardar: cliente archivado';
  END IF;

  -- ---- 2. Entradas (porcentaje nulo: el mes queda sin valor) ----
  v_periodo := p_periodo::text;
  IF v_periodo IS NULL OR v_periodo !~ '^[0-9]{4}(0[1-9]|1[0-2])$'
     OR (p_porcentaje IS NOT NULL AND (p_porcentaje < 0 OR p_porcentaje > 100 OR p_porcentaje <> round(p_porcentaje, 2)))
     OR p_version IS NULL OR p_version < 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'prorrata_usada_guardar: entradas invalidas';
  END IF;

  -- ---- 3. El mes, uno a la vez ----
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('prorrata:' || p_cliente::text || ':' || v_periodo, 0));

  -- ---- 4. La presentación vigente (mayor número de orden) ya trae la prorrata usada (R-8) ----
  IF EXISTS (
    SELECT 1 FROM (
      SELECT d.prorrata_usada FROM public.declaracion_mensual d
       WHERE d.tenant_id = v_tenant AND d.cliente_id = p_cliente AND d.periodo = p_periodo
       ORDER BY d.numero_orden DESC
       LIMIT 1
    ) v WHERE v.prorrata_usada IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'CA413', MESSAGE = 'prorrata_usada_guardar: la declaracion trae la prorrata usada';
  END IF;

  -- ---- 5. Compare-and-set por versión ----
  SELECT coalesce(max(u.version), 0) INTO v_actual FROM public.prorrata_usada_manual u
   WHERE u.tenant_id = v_tenant AND u.cliente_id = p_cliente AND u.periodo = p_periodo;
  IF v_actual <> p_version THEN
    RAISE EXCEPTION USING ERRCODE = 'CA409', MESSAGE = 'prorrata_usada_guardar: el mes cambio';
  END IF;

  INSERT INTO public.prorrata_usada_manual (tenant_id, cliente_id, periodo, version, porcentaje, autor, creado_en)
  VALUES (v_tenant, p_cliente, p_periodo, p_version + 1, p_porcentaje, v_usuario, clock_timestamp())
  RETURNING id INTO v_id;
  PERFORM public.auditoria_registrar(v_tenant, 'prorrata.usada_guardada', p_cliente, 'prorrata_usada_manual', v_id,
    jsonb_build_object('clienteId', p_cliente, 'periodo', v_periodo, 'version', p_version + 1));
  RETURN p_version + 1;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.prorrata_usada_guardar(uuid, char(6), numeric, integer) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.prorrata_usada_guardar(uuid, char(6), numeric, integer)
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.prorrata_usada_guardar(uuid, char(6), numeric, integer) TO contapp_backend;
