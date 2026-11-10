-- 0037_encolar_xml_obtener (custom, spec 016, T12b). Función acotada con la que el worker encola `xml.obtener` (lotes tras la
-- descarga de la propuesta, CA-10) SIN ganar INSERT en job_registro: 0018 lo deja sin INSERT y así sigue (decisión del usuario,
-- 2026-11-10). La función solo puede crear un trabajo `xml.obtener` en_cola de la cola xml, canal ninguno, prioridad programado.
--   - SECURITY DEFINER con dueño contapp_migrator (dueño de job_registro, cliente, membresia y config_sistema): no es
--     superusuario ni BYPASSRLS, así que la RLS FORCE de esas tablas aplica dentro (tenant_isolation con app.tenant_id).
--   - El estudio sale SIEMPRE de app.tenant_id; el RUC, de cliente; max_intentos y el tope, de config_sistema(xml).
--   - clave_dedupe = sha256 del JSON canónico de ["xml.obtener", cliente, {"compraIds": [...], "periodo": "AAAAMM"}], la misma
--     que `claveDedupe` de @contapp/queue (claves ordenadas, sin espacios): deduplica contra lo que encole el backend.
--   - Dedupe antes que el tope. Tope atómico como `insertarTrabajo` (H-008-2a-3): INSERT, luego el mismo candado del estudio y
--     la cola que toma el backend, y conteo; si pasa el tope, 53400 deshace el INSERT con la sentencia.
--   - Errores con mensaje fijo (nunca ids, periodo ni RUC): 22023 parámetro inválido, 42501 sin estudio, 23503 cliente o
--     creador ajeno/inexistente, 53400 cola llena.
--   - EXECUTE solo a contapp_worker. Repetible: CREATE OR REPLACE y GRANT/REVOKE idempotentes.
CREATE OR REPLACE FUNCTION public.encolar_xml_obtener(
  p_cliente_id uuid,
  p_periodo text,
  p_compra_ids uuid[],
  p_creado_por uuid
) RETURNS TABLE (id uuid, nuevo boolean, estado text, creado_en timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_ajuste text := current_setting('app.tenant_id', true);
  v_tenant uuid;
  v_n integer;
  v_ruc text;
  v_reintentos integer;
  v_max integer;
  v_parametros jsonb;
  v_clave bytea;
  v_id uuid;
  v_estado text;
  v_creado timestamptz;
BEGIN
  v_tenant := nullif(v_ajuste, '')::uuid;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'encolar_xml_obtener: sesion sin estudio' USING ERRCODE = '42501';
  END IF;

  -- Lote canónico: 1..100 uuid, unidimensional, sin NULL, estrictamente ascendente (ordenado y sin repetidos).
  IF p_cliente_id IS NULL OR p_periodo IS NULL OR p_compra_ids IS NULL
     OR length(p_periodo) <> 6 OR p_periodo !~ '^[0-9]{4}(0[1-9]|1[0-2])$'
     OR coalesce(array_ndims(p_compra_ids), 0) <> 1
     OR array_position(p_compra_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'encolar_xml_obtener: parametro invalido' USING ERRCODE = '22023';
  END IF;
  v_n := cardinality(p_compra_ids);
  IF v_n < 1 OR v_n > 100 THEN
    RAISE EXCEPTION 'encolar_xml_obtener: parametro invalido' USING ERRCODE = '22023';
  END IF;
  FOR i IN array_lower(p_compra_ids, 1) + 1 .. array_upper(p_compra_ids, 1) LOOP
    IF NOT (p_compra_ids[i - 1] < p_compra_ids[i]) THEN
      RAISE EXCEPTION 'encolar_xml_obtener: parametro invalido' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  SELECT c.ruc INTO v_ruc FROM public.cliente c WHERE c.tenant_id = v_tenant AND c.id = p_cliente_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'encolar_xml_obtener: cliente desconocido' USING ERRCODE = '23503';
  END IF;
  IF p_creado_por IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.membresia m WHERE m.tenant_id = v_tenant AND m.usuario_id = p_creado_por
  ) THEN
    RAISE EXCEPTION 'encolar_xml_obtener: creador desconocido' USING ERRCODE = '23503';
  END IF;

  v_parametros := jsonb_build_object('compraIds', to_jsonb(p_compra_ids), 'periodo', p_periodo);
  -- JSON canónico armado a mano (jsonb::text agrega espacios): claves ordenadas, compraIds < periodo.
  v_clave := sha256(convert_to(
    '["xml.obtener",' || to_json(p_cliente_id)::text
      || ',{"compraIds":' || array_to_json(p_compra_ids)::text
      || ',"periodo":' || to_json(p_periodo)::text || '}]',
    'UTF8'));

  FOR intento IN 1 .. 3 LOOP
    -- Dedupe (antes que el tope): el vivo del estudio con la misma clave.
    SELECT j.id, j.estado, j.creado_en INTO v_id, v_estado, v_creado
      FROM public.job_registro j
     WHERE j.tenant_id = v_tenant AND j.clave_dedupe = v_clave AND j.estado IN ('en_cola', 'ejecutando')
     LIMIT 1;
    IF FOUND THEN
      RETURN QUERY SELECT v_id, false, v_estado, v_creado;
      RETURN;
    END IF;

    SELECT cs.reintentos, cs.max_pendientes_tenant INTO v_reintentos, v_max
      FROM public.config_sistema cs WHERE cs.cola = 'xml';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'encolar_xml_obtener: cola sin configurar' USING ERRCODE = '55000';
    END IF;
    -- Rechazo temprano; el tope atómico va tras el INSERT.
    IF (SELECT count(*) FROM public.job_registro j
         WHERE j.tenant_id = v_tenant AND j.cola = 'xml' AND j.estado = 'en_cola') >= v_max THEN
      RAISE EXCEPTION 'encolar_xml_obtener: cola llena' USING ERRCODE = '53400';
    END IF;

    -- Con otro vivo de la misma clave (encolado concurrente) no inserta: espera a esa transacción y se relee el vivo.
    INSERT INTO public.job_registro AS j
      (cliente_id, ruc, tipo, cola, canal, prioridad, estado, parametros, clave_dedupe, creado_por, max_intentos)
    VALUES
      (p_cliente_id, v_ruc, 'xml.obtener', 'xml', 'ninguno', 'programado', 'en_cola', v_parametros, v_clave, p_creado_por,
       (v_reintentos + 1)::smallint)
    ON CONFLICT (tenant_id, clave_dedupe) WHERE estado IN ('en_cola', 'ejecutando') DO NOTHING
    RETURNING j.id, j.estado, j.creado_en INTO v_id, v_estado, v_creado;
    IF v_id IS NOT NULL THEN
      -- Mismo candado (estudio, cola) que `insertarTrabajo`: serializa el conteo con el backend y otros workers.
      PERFORM pg_advisory_xact_lock(hashtextextended('job_registro.pendientes:' || coalesce(v_ajuste, '') || ':xml', 0));
      IF (SELECT count(*) FROM public.job_registro j
           WHERE j.tenant_id = v_tenant AND j.cola = 'xml' AND j.estado = 'en_cola') > v_max THEN
        RAISE EXCEPTION 'encolar_xml_obtener: cola llena' USING ERRCODE = '53400';
      END IF;
      RETURN QUERY SELECT v_id, true, v_estado, v_creado;
      RETURN;
    END IF;
  END LOOP;
  -- Cada intento chocó con un vivo que terminó antes de releerlo: no se insiste.
  RAISE EXCEPTION 'encolar_xml_obtener: conflicto de dedupe persistente' USING ERRCODE = '40001';
END
$$;--> statement-breakpoint
ALTER FUNCTION public.encolar_xml_obtener(uuid, text, uuid[], uuid) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.encolar_xml_obtener(uuid, text, uuid[], uuid)
  FROM PUBLIC, contapp_backend, contapp_platform, contapp_app, contapp_enumerador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.encolar_xml_obtener(uuid, text, uuid[], uuid) TO contapp_worker;
