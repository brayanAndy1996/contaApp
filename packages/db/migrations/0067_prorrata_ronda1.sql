-- 0067_prorrata_ronda1 (spec 026, T17: hallazgos de la ronda adversarial 1). Reemplaza prorrata_declaraciones_registrar de 0066 con la
-- misma firma, dueño (contapp_migrator), SECURITY DEFINER, search_path fijo, nombres calificados, SQLSTATE y mensajes fijos y los mismos
-- REVOKE/GRANT. Repetible (CREATE OR REPLACE; ALTER/REVOKE/GRANT idempotentes). Sin bloques EXCEPTION ni SAVEPOINT. Cambios:
--   H-026-1-1: p_trabajo debe estar en estado `ejecutando` (en cola, completado, error o cancelado: 22023 «trabajo invalido»).
--   H-026-1-2: si la sesión fija app.trabajo_id, debe ser p_trabajo (22023 «trabajo invalido», sin escribir). La auditoría
--     prorrata.declaraciones_obtenidas lleva siempre actor «trabajo» = p_trabajo (y el usuario que lo creó, como 0041), con o sin
--     app.trabajo_id: se inserta con interno.auditoria_insertar (EXECUTE de contapp_migrator) en vez de auditoria_registrar, que
--     tomaba el actor de la sesión. Mismos datos (solo conteos).
--   H-026-1-3 (R-1): p_periodo_hasta posterior al mes en curso en hora de Lima (clock_timestamp() en America/Lima): 22023
--     «periodo futuro», sin escribir.

-- ---- Registrar la obtención del PDT 621 (worker, sin SAVEPOINT) ------------------------------------------------------------
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
  v_trabajo_ctx text := nullif(current_setting('app.trabajo_id', true), '');
  v_tenant uuid;
  v_creado_por uuid;
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
  -- H-026-1-2: con app.trabajo_id fijado, debe ser p_trabajo (el actor de la auditoría es siempre p_trabajo).
  IF v_trabajo_ctx IS NOT NULL AND (v_trabajo_ctx !~ v_uuid OR v_trabajo_ctx::uuid IS DISTINCT FROM p_trabajo) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'prorrata_declaraciones_registrar: trabajo invalido';
  END IF;
  -- H-026-1-1: el trabajo está en ejecución (un trabajo en cola o ya terminado no habilita escribir).
  SELECT j.creado_por INTO v_creado_por FROM public.job_registro j
   WHERE j.tenant_id = v_tenant AND j.id = p_trabajo AND j.cliente_id = p_cliente AND j.tipo = 'sol.declaraciones.descargar'
     AND j.estado = 'ejecutando'
     AND jsonb_typeof(j.parametros) = 'object' AND (j.parametros ->> 'periodo') = v_hasta;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'prorrata_declaraciones_registrar: trabajo invalido';
  END IF;
  -- H-026-1-3 (R-1): M no es posterior al mes en curso en hora de Lima.
  IF v_hasta > to_char(clock_timestamp() AT TIME ZONE 'America/Lima', 'YYYYMM') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'prorrata_declaraciones_registrar: periodo futuro';
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

  -- Actor «trabajo» = p_trabajo (D-6), coherente con prorrata_obtencion.trabajo_id; el usuario es quien lo creó (como 0041).
  PERFORM interno.auditoria_insertar(v_tenant, 'trabajo', v_creado_por, p_trabajo, 'prorrata.declaraciones_obtenidas', p_cliente,
    'prorrata_obtencion', v_obtencion,
    jsonb_build_object('periodo', v_hasta, 'leidos', cardinality(v_leidos), 'sinDeclaracion', cardinality(v_sin),
                       'nuevas', v_nuevas));
  RETURN v_nuevas;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.prorrata_declaraciones_registrar(uuid, uuid, char(6), char(6)[], char(6)[], jsonb) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.prorrata_declaraciones_registrar(uuid, uuid, char(6), char(6)[], char(6)[], jsonb)
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.prorrata_declaraciones_registrar(uuid, uuid, char(6), char(6)[], char(6)[], jsonb) TO contapp_worker;
