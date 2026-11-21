-- 0064_reglas_importacion_ronda1 (spec 025, T17: hallazgos de la ronda adversarial 1). Reemplaza tres funciones de 0062 con las
-- mismas firmas, dueño (contapp_migrator), SECURITY DEFINER, search_path fijo, nombres calificados, SQLSTATE y mensajes fijos y los
-- mismos REVOKE/GRANT. Repetible (CREATE OR REPLACE; ALTER/REVOKE/GRANT idempotentes). Sin bloques EXCEPTION (D-1). Cambios:
--   reglas_importacion_completar (H-025-1-5, H-025-1-6): 55000 si el cliente está archivado (leído con el FOR SHARE: serializa con
--     archivar; nada se escribe y las pendientes anteriores siguen pendientes); 22023 si periodos_leidos = 0 (una importación que
--     no leyó ningún periodo no reemplaza la revisión pendiente de la anterior; el worker la cierra fallida datos_invalidos).
--   reglas_candidatas_activar (H-025-1-4, U-8): con p_items, 22023 si una candidata pendiente sin destino propuesto lleva destino
--     elegido y otra del lote lleva destino (elegido o propuesto): la «sin criterio claro» se activa sola. Una sin criterio sin
--     destino sigue siendo el parcial sin_criterio.
--   reglas_candidata_reemplazar (H-025-1-3): la regla resultante queda activa (activa = true); una regla viva desactivada con otro
--     destino se reemplaza y vuelve a regir, coherente con la candidata «activada».

-- ---- Completar ----
CREATE OR REPLACE FUNCTION public.reglas_importacion_completar(p_importacion uuid, p_resumen jsonb, p_candidatas jsonb)
  RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_uuid CONSTANT text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_entero CONSTANT text := '^[0-9]{1,9}$';
  v_periodo CONSTANT text := '^[0-9]{4}(0[1-9]|1[0-2])$';
  v_controles CONSTANT text := '[\u0001-\u001F\u007F-\u009F؜‎‏‪-‮⁦-⁩]';
  v_claves CONSTANT text[] := ARRAY['destino_propuesto', 'doc_numero', 'doc_tipo', 'n_dg', 'n_dgng', 'n_dng', 'n_mixto', 'n_total',
                                    'periodos_con_proveedor', 'razon_social'];
  v_claves_resumen CONSTANT text[] := ARRAY['candidatas', 'periodos_leidos', 'periodos_sin_datos', 'sin_criterio'];
  v_conteos CONSTANT text[] := ARRAY['n_dg', 'n_dgng', 'n_dng', 'n_mixto', 'n_total', 'periodos_con_proveedor'];
  v_tenant_txt text := nullif(current_setting('app.tenant_id', true), '');
  v_tenant uuid;
  v_cliente uuid;
  v_imp record;
  v_archivado timestamptz;
  v_n_periodos integer;
  v_leidos integer;
  v_sin_datos char(6)[];
  v_item jsonb;
  v_clave text;
  v_tipo text;
  v_numero text;
  v_razon text;
  v_destino text;
  v_dg integer;
  v_dgng integer;
  v_dng integer;
  v_mixto integer;
  v_total integer;
  v_con integer;
  v_n integer;
  v_insertadas integer;
  v_sin_criterio integer;
BEGIN
  IF v_tenant_txt IS NULL OR v_tenant_txt !~ v_uuid THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'reglas_importacion_completar: sesion sin estudio';
  END IF;
  v_tenant := v_tenant_txt::uuid;

  -- ---- 1 y 2. Cliente FOR SHARE -> importación FOR UPDATE; solo una en curso del estudio ----
  SELECT i.cliente_id INTO v_cliente FROM public.regla_importacion i WHERE i.tenant_id = v_tenant AND i.id = p_importacion;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'reglas_importacion_completar: la importacion no esta en curso';
  END IF;
  SELECT k.archivado_at INTO v_archivado FROM public.cliente k WHERE k.tenant_id = v_tenant AND k.id = v_cliente FOR SHARE;
  -- H-025-1-5: un cliente archivado mientras corría la importación es de solo lectura: nada que escribir (el worker: «omitida»).
  IF v_archivado IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'reglas_importacion_completar: cliente archivado';
  END IF;
  SELECT i.estado, i.periodos, i.solicitada_por INTO v_imp FROM public.regla_importacion i
   WHERE i.tenant_id = v_tenant AND i.id = p_importacion
     FOR UPDATE;
  IF NOT FOUND OR v_imp.estado <> 'en_curso' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'reglas_importacion_completar: la importacion no esta en curso';
  END IF;
  v_n_periodos := cardinality(v_imp.periodos);

  -- ---- Resumen (IF anidados: jsonb_object_keys solo sobre un objeto) ----
  IF jsonb_typeof(p_resumen) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'reglas_importacion_completar: resumen invalido';
  END IF;
  IF (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(p_resumen) AS k) IS DISTINCT FROM v_claves_resumen
     OR jsonb_typeof(p_resumen -> 'periodos_sin_datos') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'reglas_importacion_completar: resumen invalido';
  END IF;
  FOREACH v_clave IN ARRAY ARRAY['candidatas', 'periodos_leidos', 'sin_criterio'] LOOP
    IF jsonb_typeof(p_resumen -> v_clave) IS DISTINCT FROM 'number' OR (p_resumen ->> v_clave) !~ v_entero THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'reglas_importacion_completar: resumen invalido';
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_resumen -> 'periodos_sin_datos') AS e
     WHERE jsonb_typeof(e.value) IS DISTINCT FROM 'string' OR (e.value #>> '{}') !~ v_periodo
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'reglas_importacion_completar: resumen invalido';
  END IF;
  v_leidos := (p_resumen ->> 'periodos_leidos')::integer;
  v_sin_datos := ARRAY(SELECT e.value::char(6) FROM jsonb_array_elements_text(p_resumen -> 'periodos_sin_datos') AS e
                        ORDER BY e.value DESC);
  IF (SELECT count(DISTINCT x) FROM unnest(v_sin_datos) AS x) <> cardinality(v_sin_datos)
     OR NOT (v_sin_datos <@ v_imp.periodos)
     OR v_leidos + cardinality(v_sin_datos) > v_n_periodos
     -- H-025-1-6: sin ningún periodo leído no hay importación que reemplace la revisión pendiente anterior (CA-5).
     OR v_leidos < 1 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'reglas_importacion_completar: resumen invalido';
  END IF;

  -- ---- Candidatas: todas o ninguna ----
  IF jsonb_typeof(p_candidatas) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'reglas_importacion_completar: candidatas invalidas';
  END IF;
  FOR v_item IN SELECT e.value FROM jsonb_array_elements(p_candidatas) AS e LOOP
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'reglas_importacion_completar: candidatas invalidas';
    END IF;
    IF (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(v_item) AS k) IS DISTINCT FROM v_claves
       OR jsonb_typeof(v_item -> 'doc_tipo') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_item -> 'doc_numero') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_item -> 'razon_social') NOT IN ('string', 'null')
       OR jsonb_typeof(v_item -> 'destino_propuesto') NOT IN ('string', 'null') THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'reglas_importacion_completar: candidatas invalidas';
    END IF;
    FOREACH v_clave IN ARRAY v_conteos LOOP
      IF jsonb_typeof(v_item -> v_clave) IS DISTINCT FROM 'number' OR (v_item ->> v_clave) !~ v_entero THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'reglas_importacion_completar: candidatas invalidas';
      END IF;
    END LOOP;
    v_tipo := v_item ->> 'doc_tipo';
    v_numero := v_item ->> 'doc_numero';
    v_razon := v_item ->> 'razon_social';
    v_destino := v_item ->> 'destino_propuesto';
    v_dg := (v_item ->> 'n_dg')::integer;
    v_dgng := (v_item ->> 'n_dgng')::integer;
    v_dng := (v_item ->> 'n_dng')::integer;
    v_mixto := (v_item ->> 'n_mixto')::integer;
    v_total := (v_item ->> 'n_total')::integer;
    v_con := (v_item ->> 'periodos_con_proveedor')::integer;
    -- Documento como la clave de R-NEW ya normalizada (mayúsculas, sin espacios); un RUC (tipo 6) son 11 dígitos.
    IF v_tipo !~ '^[0-9A-Z]{1,2}$' OR v_numero !~ '^[0-9A-Z-]{1,20}$' OR v_numero !~ '[0-9A-Z]'
       OR (v_tipo = '6' AND v_numero !~ '^[0-9]{11}$') THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'reglas_importacion_completar: candidatas invalidas';
    END IF;
    IF v_razon IS NOT NULL AND (char_length(v_razon) NOT BETWEEN 1 AND 200 OR v_razon ~ v_controles) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'reglas_importacion_completar: candidatas invalidas';
    END IF;
    IF v_total <> v_dg + v_dgng + v_dng + v_mixto OR v_total < 1 OR v_con NOT BETWEEN 1 AND v_n_periodos THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'reglas_importacion_completar: candidatas invalidas';
    END IF;
    IF v_destino IS NOT NULL THEN
      IF v_destino NOT IN ('DG', 'DGNG', 'DNG') THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'reglas_importacion_completar: candidatas invalidas';
      END IF;
      v_n := CASE v_destino WHEN 'DG' THEN v_dg WHEN 'DGNG' THEN v_dgng ELSE v_dng END;
      -- Umbral de U-2 en enteros: al menos 2 comprobantes y 5n >= 4t (80 %).
      IF v_n < 2 OR 5 * v_n < 4 * v_total THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'reglas_importacion_completar: candidatas invalidas';
      END IF;
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT ((e.value ->> 'doc_tipo'), (e.value ->> 'doc_numero'))) FROM jsonb_array_elements(p_candidatas) AS e)
     <> jsonb_array_length(p_candidatas) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'reglas_importacion_completar: candidatas invalidas';
  END IF;

  -- ---- 3. Pendientes del cliente de otras importaciones -> reemplazada (FOR UPDATE en orden de id; CA-5) ----
  PERFORM 1 FROM (
    SELECT k.id FROM public.regla_candidata k
     WHERE k.tenant_id = v_tenant AND k.cliente_id = v_cliente AND k.estado = 'pendiente' AND k.importacion_id <> p_importacion
     ORDER BY k.id
       FOR UPDATE
  ) AS bloqueadas;
  UPDATE public.regla_candidata k
     SET estado = 'reemplazada', resuelta_por = v_imp.solicitada_por, resuelta_en = clock_timestamp()
   WHERE k.tenant_id = v_tenant AND k.cliente_id = v_cliente AND k.estado = 'pendiente' AND k.importacion_id <> p_importacion;

  -- ---- 4. Nuevas candidatas (pendientes) y resumen ----
  INSERT INTO public.regla_candidata (tenant_id, cliente_id, importacion_id, doc_tipo, doc_numero, razon_social, destino_propuesto,
      n_dg, n_dgng, n_dng, n_mixto, n_total, periodos_con_proveedor, estado)
  SELECT v_tenant, v_cliente, p_importacion, x.doc_tipo, x.doc_numero, x.razon_social, x.destino_propuesto,
         x.n_dg, x.n_dgng, x.n_dng, x.n_mixto, x.n_total, x.periodos_con_proveedor, 'pendiente'
    FROM jsonb_to_recordset(p_candidatas) AS x(doc_tipo text, doc_numero text, razon_social text, destino_propuesto text,
         n_dg integer, n_dgng integer, n_dng integer, n_mixto integer, n_total integer, periodos_con_proveedor integer)
   ORDER BY x.doc_tipo, x.doc_numero;
  GET DIAGNOSTICS v_insertadas = ROW_COUNT;
  SELECT count(*)::integer INTO v_sin_criterio FROM jsonb_array_elements(p_candidatas) AS e
   WHERE jsonb_typeof(e.value -> 'destino_propuesto') = 'null';
  UPDATE public.regla_importacion i
     SET estado = 'completada', terminada_en = clock_timestamp(), periodos_leidos = v_leidos, periodos_sin_datos = v_sin_datos,
         candidatas = v_insertadas, sin_criterio = v_sin_criterio
   WHERE i.tenant_id = v_tenant AND i.id = p_importacion;
  RETURN v_insertadas;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.reglas_importacion_completar(uuid, jsonb, jsonb) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.reglas_importacion_completar(uuid, jsonb, jsonb)
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.reglas_importacion_completar(uuid, jsonb, jsonb) TO contapp_worker;--> statement-breakpoint

-- ---- Activar ----
CREATE OR REPLACE FUNCTION public.reglas_candidatas_activar(p_cliente uuid, p_items jsonb, p_todas uuid)
  RETURNS TABLE (candidata_id uuid, resultado text, regla_id uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_uuid CONSTANT text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_tenant_txt text := nullif(current_setting('app.tenant_id', true), '');
  v_usuario_txt text := nullif(current_setting('app.user_id', true), '');
  v_tenant uuid;
  v_usuario uuid;
  v_item jsonb;
  v_ids uuid[] := '{}';
  v_destinos text[] := '{}';
  v_archivado timestamptz;
  v_ultima uuid;
  v_encontradas integer;
  v_destino text;
  v_viva text;
  v_regla uuid;
  v_a_mano integer;
  v_con_destino integer;
  r record;
BEGIN
  -- ---- Quién llama ----
  IF v_tenant_txt IS NULL OR v_usuario_txt IS NULL OR v_tenant_txt !~ v_uuid OR v_usuario_txt !~ v_uuid THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'reglas_candidatas_activar: sesion sin estudio o sin usuario';
  END IF;
  v_tenant := v_tenant_txt::uuid;
  v_usuario := v_usuario_txt::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM public.membresia mb
     WHERE mb.tenant_id = v_tenant AND mb.usuario_id = v_usuario AND mb.desactivada_en IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'reglas_candidatas_activar: sin membresia activa';
  END IF;

  -- ---- Entrada: items XOR todas ----
  IF (p_items IS NULL) = (p_todas IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'reglas_candidatas_activar: entrada invalida';
  END IF;
  IF p_items IS NOT NULL THEN
    IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'reglas_candidatas_activar: entrada invalida';
    END IF;
    IF jsonb_array_length(p_items) NOT BETWEEN 1 AND 1000 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'reglas_candidatas_activar: entrada invalida';
    END IF;
    FOR v_item IN SELECT e.value FROM jsonb_array_elements(p_items) WITH ORDINALITY AS e(value, o) ORDER BY e.o LOOP
      IF jsonb_typeof(v_item) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'reglas_candidatas_activar: entrada invalida';
      END IF;
      IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_item) AS k WHERE k NOT IN ('id', 'destino'))
         OR jsonb_typeof(v_item -> 'id') IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'reglas_candidatas_activar: entrada invalida';
      END IF;
      IF (v_item ->> 'id') !~ v_uuid
         OR (jsonb_typeof(v_item -> 'destino') NOT IN ('null', 'string'))
         OR (jsonb_typeof(v_item -> 'destino') = 'string' AND (v_item ->> 'destino') NOT IN ('DG', 'DGNG', 'DNG')) THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'reglas_candidatas_activar: entrada invalida';
      END IF;
      v_ids := v_ids || (v_item ->> 'id')::uuid;
      v_destinos := v_destinos || (v_item ->> 'destino');
    END LOOP;
    IF (SELECT count(DISTINCT x) FROM unnest(v_ids) AS x) <> cardinality(v_ids) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'reglas_candidatas_activar: entrada invalida';
    END IF;
  END IF;

  -- ---- 1. Cliente FOR SHARE ----
  SELECT k.archivado_at INTO v_archivado FROM public.cliente k
   WHERE k.tenant_id = v_tenant AND k.id = p_cliente
     FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'reglas_candidatas_activar: cliente no encontrado';
  END IF;
  IF v_archivado IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'reglas_candidatas_activar: cliente archivado';
  END IF;

  -- ---- 2. Candidatas FOR UPDATE en orden de id ----
  IF p_todas IS NOT NULL THEN
    SELECT i.id INTO v_ultima FROM public.regla_importacion i
     WHERE i.tenant_id = v_tenant AND i.cliente_id = p_cliente AND i.estado = 'completada'
     ORDER BY i.solicitada_en DESC, i.id DESC
     LIMIT 1;
    IF v_ultima IS DISTINCT FROM p_todas THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'reglas_candidatas_activar: no es la ultima importacion completada';
    END IF;
    SELECT coalesce(array_agg(b.id ORDER BY b.id), '{}') INTO v_ids FROM (
      SELECT k.id FROM public.regla_candidata k
       WHERE k.tenant_id = v_tenant AND k.cliente_id = p_cliente AND k.importacion_id = p_todas AND k.estado = 'pendiente'
         AND k.destino_propuesto IS NOT NULL
       ORDER BY k.id
         FOR UPDATE
    ) AS b;
  ELSE
    SELECT count(*)::integer INTO v_encontradas FROM public.regla_candidata k
     WHERE k.tenant_id = v_tenant AND k.cliente_id = p_cliente AND k.id = ANY (v_ids);
    IF v_encontradas <> cardinality(v_ids) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'reglas_candidatas_activar: candidata no encontrada';
    END IF;
    PERFORM 1 FROM (
      SELECT k.id FROM public.regla_candidata k
       WHERE k.tenant_id = v_tenant AND k.id = ANY (v_ids)
       ORDER BY k.id
         FOR UPDATE
    ) AS bloqueadas;
  END IF;

  -- ---- 2b. U-8 (H-025-1-4): una «sin criterio claro» con destino elegido a mano se activa de una en una: ninguna otra candidata
  --      del lote puede llevar destino (elegido o propuesto). Una sin criterio SIN destino sigue siendo el parcial sin_criterio.
  IF p_items IS NOT NULL THEN
    SELECT count(*) FILTER (WHERE k.estado = 'pendiente' AND k.destino_propuesto IS NULL
                              AND v_destinos[array_position(v_ids, k.id)] IS NOT NULL),
           count(*) FILTER (WHERE coalesce(v_destinos[array_position(v_ids, k.id)], k.destino_propuesto) IS NOT NULL)
      INTO v_a_mano, v_con_destino
      FROM public.regla_candidata k
     WHERE k.tenant_id = v_tenant AND k.id = ANY (v_ids);
    IF v_a_mano > 0 AND v_con_destino > 1 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'reglas_candidatas_activar: sin criterio solo de una en una';
    END IF;
  END IF;

  -- ---- 3. Por candidata (relectura tras los bloqueos: READ COMMITTED ve lo ya confirmado) ----
  FOR r IN
    SELECT k.id, k.estado, k.destino_propuesto, k.doc_tipo, k.doc_numero, i.periodo_hasta
      FROM public.regla_candidata k
      JOIN public.regla_importacion i ON i.tenant_id = k.tenant_id AND i.id = k.importacion_id
     WHERE k.tenant_id = v_tenant AND k.id = ANY (v_ids)
     ORDER BY k.id
  LOOP
    candidata_id := r.id;
    regla_id := NULL;
    IF r.estado <> 'pendiente' THEN
      resultado := 'no_pendiente';
      RETURN NEXT;
      CONTINUE;
    END IF;
    v_destino := r.destino_propuesto;
    IF p_items IS NOT NULL THEN
      v_destino := coalesce(v_destinos[array_position(v_ids, r.id)], r.destino_propuesto);
    END IF;
    IF v_destino IS NULL THEN
      resultado := 'sin_criterio';
      RETURN NEXT;
      CONTINUE;
    END IF;
    v_viva := NULL;
    SELECT g.destino INTO v_viva FROM public.regla_aprendida g
     WHERE g.tenant_id = v_tenant AND g.cliente_id = p_cliente AND g.doc_tipo = r.doc_tipo AND g.doc_numero = r.doc_numero
       AND g.eliminada_en IS NULL;
    IF FOUND THEN
      resultado := CASE WHEN v_viva = v_destino THEN 'ya_aprendida' ELSE 'conflicto' END;
      RETURN NEXT;
      CONTINUE;
    END IF;
    v_regla := NULL;
    INSERT INTO public.regla_aprendida (tenant_id, cliente_id, doc_tipo, doc_numero, destino, activa, version, periodo_aprendido,
        creada_por, actualizada_por, origen)
    VALUES (v_tenant, p_cliente, r.doc_tipo, r.doc_numero, v_destino, true, 1, r.periodo_hasta, v_usuario, v_usuario, 'importacion')
    ON CONFLICT (tenant_id, cliente_id, doc_tipo, doc_numero) WHERE eliminada_en IS NULL DO NOTHING
    RETURNING id INTO v_regla;
    IF v_regla IS NULL THEN
      -- Un «Recordar» (u otra activación) confirmó antes una regla viva del proveedor: esa gana.
      v_viva := NULL;
      SELECT g.destino INTO v_viva FROM public.regla_aprendida g
       WHERE g.tenant_id = v_tenant AND g.cliente_id = p_cliente AND g.doc_tipo = r.doc_tipo AND g.doc_numero = r.doc_numero
         AND g.eliminada_en IS NULL;
      resultado := CASE WHEN v_viva = v_destino THEN 'ya_aprendida' ELSE 'conflicto' END;
      RETURN NEXT;
      CONTINUE;
    END IF;
    UPDATE public.regla_candidata k
       SET estado = 'activada', destino_elegido = v_destino, regla_id = v_regla, resuelta_por = v_usuario,
           resuelta_en = clock_timestamp()
     WHERE k.tenant_id = v_tenant AND k.id = r.id;
    resultado := 'activada';
    regla_id := v_regla;
    RETURN NEXT;
  END LOOP;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.reglas_candidatas_activar(uuid, jsonb, uuid) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.reglas_candidatas_activar(uuid, jsonb, uuid)
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.reglas_candidatas_activar(uuid, jsonb, uuid) TO contapp_backend;--> statement-breakpoint

-- ---- Reemplazar ----
CREATE OR REPLACE FUNCTION public.reglas_candidata_reemplazar(p_cliente uuid, p_candidata uuid, p_destino text,
    p_version_regla integer)
  RETURNS TABLE (regla_id uuid, destino text, version integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_uuid CONSTANT text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_tenant_txt text := nullif(current_setting('app.tenant_id', true), '');
  v_usuario_txt text := nullif(current_setting('app.user_id', true), '');
  v_tenant uuid;
  v_usuario uuid;
  v_archivado timestamptz;
  v_destino text;
  k record;
  g record;
BEGIN
  IF v_tenant_txt IS NULL OR v_usuario_txt IS NULL OR v_tenant_txt !~ v_uuid OR v_usuario_txt !~ v_uuid THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'reglas_candidata_reemplazar: sesion sin estudio o sin usuario';
  END IF;
  v_tenant := v_tenant_txt::uuid;
  v_usuario := v_usuario_txt::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM public.membresia mb
     WHERE mb.tenant_id = v_tenant AND mb.usuario_id = v_usuario AND mb.desactivada_en IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'reglas_candidata_reemplazar: sin membresia activa';
  END IF;
  IF (p_destino IS NOT NULL AND p_destino NOT IN ('DG', 'DGNG', 'DNG')) OR p_version_regla IS NULL OR p_version_regla < 1 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'reglas_candidata_reemplazar: entrada invalida';
  END IF;

  -- ---- 1. Cliente FOR SHARE ----
  SELECT c.archivado_at INTO v_archivado FROM public.cliente c
   WHERE c.tenant_id = v_tenant AND c.id = p_cliente
     FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'reglas_candidata_reemplazar: cliente no encontrado';
  END IF;
  IF v_archivado IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'reglas_candidata_reemplazar: cliente archivado';
  END IF;

  -- ---- 2. Candidata FOR UPDATE ----
  SELECT x.id, x.estado, x.destino_propuesto, x.doc_tipo, x.doc_numero, i.periodo_hasta INTO k
    FROM public.regla_candidata x
    JOIN public.regla_importacion i ON i.tenant_id = x.tenant_id AND i.id = x.importacion_id
   WHERE x.tenant_id = v_tenant AND x.cliente_id = p_cliente AND x.id = p_candidata
     FOR UPDATE OF x;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'reglas_candidata_reemplazar: candidata no encontrada';
  END IF;
  IF k.estado <> 'pendiente' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'reglas_candidata_reemplazar: la candidata no esta pendiente';
  END IF;
  v_destino := coalesce(p_destino, k.destino_propuesto);
  IF v_destino IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'reglas_candidata_reemplazar: sin destino';
  END IF;

  -- ---- 3. Regla viva del proveedor FOR UPDATE: versión (CA409) y conflicto «distinto» ----
  SELECT a.id, a.destino, a.version INTO g FROM public.regla_aprendida a
   WHERE a.tenant_id = v_tenant AND a.cliente_id = p_cliente AND a.doc_tipo = k.doc_tipo AND a.doc_numero = k.doc_numero
     AND a.eliminada_en IS NULL
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'reglas_candidata_reemplazar: sin regla viva que reemplazar';
  END IF;
  IF g.version <> p_version_regla THEN
    RAISE EXCEPTION USING ERRCODE = 'CA409', MESSAGE = 'reglas_candidata_reemplazar: la regla cambio';
  END IF;
  IF g.destino = v_destino THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'reglas_candidata_reemplazar: la regla ya tiene ese destino';
  END IF;
  UPDATE public.regla_aprendida a
     SET destino = v_destino, activa = true, version = a.version + 1, periodo_aprendido = k.periodo_hasta, actualizada_por = v_usuario,
         actualizada_en = clock_timestamp()
   WHERE a.tenant_id = v_tenant AND a.id = g.id;
  UPDATE public.regla_candidata x
     SET estado = 'activada', destino_elegido = v_destino, regla_id = g.id, resuelta_por = v_usuario,
         resuelta_en = clock_timestamp()
   WHERE x.tenant_id = v_tenant AND x.id = k.id;
  regla_id := g.id;
  destino := v_destino;
  version := g.version + 1;
  RETURN NEXT;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.reglas_candidata_reemplazar(uuid, uuid, text, integer) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.reglas_candidata_reemplazar(uuid, uuid, text, integer)
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.reglas_candidata_reemplazar(uuid, uuid, text, integer) TO contapp_backend;
