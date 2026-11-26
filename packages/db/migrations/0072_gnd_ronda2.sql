-- 0072_gnd_ronda2 (spec 027, T20; hallazgos de la ronda adversarial 2, decisiones del usuario 2026-11-23). Repetible (DROP/CREATE
-- INDEX IF [NOT] EXISTS, CREATE OR REPLACE; ALTER/REVOKE/GRANT idempotentes). Sin migrar datos.
--   H-027-2-8 · «Volver a evaluar» (CA-12): con un trabajo en cola se comparte; con uno ejecutándose se encola uno nuevo que relee el
--     diccionario. El índice único de dedupe de 008 (`job_registro_dedupe_vivo`, 0017) contaba `en_cola` y `ejecutando` para todos los
--     tipos: ahora, para `compras.reevaluar`, solo el que está en cola sin haberse ejecutado (intentos = 0; uno devuelto a la cola por un
--     reintento tampoco bloquea, así el reintento nunca choca con el nuevo). Los demás tipos, igual que antes. Los dos INSERT con ON
--     CONFLICT de funciones (`encolar_xml_obtener` de 0038 y `encolar_buzon_programados` de 0055) nombran el predicado nuevo (la
--     inferencia del índice parcial lo exige); el resto de cada función es el de su migración (dueño, search_path, errores y grants).
--   H-027-2-3 · frases de excepción sugeridas al aprender una palabra cuyo singular o plural es OTRA palabra (D-8 mantiene el plural en
--     ambos sentidos). `public.gnd_excepciones_sugeridas(terminos)` -> jsonb {termino: [frases]} solo para los términos que tienen, en
--     cualquiera de sus formas (`gnd_formas`); lista corta y conservadora en `plan.md` («Excepciones sugeridas», para revisión de un
--     contador del equipo). SECURITY DEFINER de contapp_migrator (para llamar a `gnd_formas`), sin tablas, EXECUTE solo contapp_backend.
--   gnd_aprender: cada término admite `excepciones` (0 a 5 frases de 1 a 3 palabras normalizadas, como `gnd_palabra_agregar`) y la propia
--     aprendida las guarda. El resto, como en 0071.
--   H-027-2-1 (la propia reemplaza a la global en cualquiera de sus formas) es del dominio (`crearDiccionarioEfectivo`): `gnd_palabra_agregar`
--     sigue comparando solo con las propias.

-- ---- Dedupe de trabajos vivos (H-027-2-8) ---------------------------------------------------------------------------------------
DROP INDEX IF EXISTS "job_registro_dedupe_vivo";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "job_registro_dedupe_vivo" ON "job_registro" USING btree ("tenant_id","clave_dedupe") WHERE "job_registro"."estado" IN ('en_cola', 'ejecutando') AND ("job_registro"."tipo" <> 'compras.reevaluar' OR ("job_registro"."estado" = 'en_cola' AND "job_registro"."intentos" = 0));--> statement-breakpoint

-- encolar_xml_obtener: la de 0038 con el ON CONFLICT del índice nuevo.
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
    ON CONFLICT (tenant_id, clave_dedupe)
      WHERE estado IN ('en_cola', 'ejecutando') AND (tipo <> 'compras.reevaluar' OR (estado = 'en_cola' AND intentos = 0))
      DO NOTHING
    RETURNING j.id, j.estado, j.creado_en INTO v_id, v_estado, v_creado;
    IF v_id IS NOT NULL THEN
      -- Mismo candado (estudio normalizado, cola) que `insertarTrabajo` (H-016-9): serializa el conteo con el backend y otros workers.
      PERFORM pg_advisory_xact_lock(hashtextextended('job_registro.pendientes:' || v_tenant::text || ':xml', 0));
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
GRANT EXECUTE ON FUNCTION public.encolar_xml_obtener(uuid, text, uuid[], uuid) TO contapp_worker;--> statement-breakpoint

-- encolar_buzon_programados: la de 0055 con el ON CONFLICT del índice nuevo.
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
    ON CONFLICT (tenant_id, clave_dedupe)
      WHERE estado IN ('en_cola', 'ejecutando') AND (tipo <> 'compras.reevaluar' OR (estado = 'en_cola' AND intentos = 0))
      DO NOTHING
    RETURNING j.id INTO v_id;
    CONTINUE WHEN v_id IS NULL;
    UPDATE public.buzon_estado_cliente e SET ultima_programada_en = clock_timestamp()
     WHERE e.tenant_id = v_tenant AND e.cliente_id = v_cliente;
    v_pendientes := v_pendientes + 1;
    RETURN NEXT v_id;
  END LOOP;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.encolar_buzon_programados(uuid[]) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.encolar_buzon_programados(uuid[])
  FROM PUBLIC, contapp_backend, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.encolar_buzon_programados(uuid[]) TO contapp_worker;--> statement-breakpoint

-- ---- Frases de excepción sugeridas al aprender (H-027-2-3) ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gnd_excepciones_sugeridas(p_terminos text[]) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_palabra_re CONSTANT text := '^[a-z0-9]{3,40}$';
  v_r jsonb;
BEGIN
  IF p_terminos IS NULL OR cardinality(p_terminos) > 10
     OR (cardinality(p_terminos) > 0
         AND (array_ndims(p_terminos) <> 1 OR array_position(p_terminos, NULL) IS NOT NULL
              OR EXISTS (SELECT 1 FROM unnest(p_terminos) AS t WHERE t !~ v_palabra_re))) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'gnd_excepciones_sugeridas: terminos invalidos';
  END IF;
  -- Palabras cuyo singular o plural simple es otra palabra frecuente en compras de empresa (plan.md, «Excepciones sugeridas»).
  WITH sugeridas(palabra, frases) AS (
    VALUES ('medias', ARRAY['media pulgada', 'media presion', 'media cana', 'media tension']),
           ('lentes', ARRAY['camara', 'fotografica', 'fotografico', 'proyector']),
           ('tirantes', ARRAY['madera', 'acero', 'metalico'])
  )
  SELECT jsonb_object_agg(t.termino, to_jsonb(s.frases))
    INTO v_r
    FROM (SELECT DISTINCT x AS termino FROM unnest(p_terminos) AS x) AS t
    JOIN sugeridas s ON s.palabra = ANY (public.gnd_formas(t.termino));
  RETURN coalesce(v_r, '{}'::jsonb);
END
$$;--> statement-breakpoint
ALTER FUNCTION public.gnd_excepciones_sugeridas(text[]) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gnd_excepciones_sugeridas(text[])
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gnd_excepciones_sugeridas(text[]) TO contapp_backend;--> statement-breakpoint

-- ---- Aprender con excepciones (H-027-2-3) -----------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gnd_aprender(p_cliente uuid, p_compra uuid, p_terminos jsonb) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_uuid CONSTANT text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_palabra_re CONSTANT text := '^[a-z0-9]{3,40}$';
  v_categorias CONSTANT text[] := ARRAY['calzado-ropa', 'juguetes', 'entretenimiento', 'alimentos-personales', 'cuidado-personal',
                                        'utiles-escolares'];
  v_frases_re CONSTANT text := '^[a-z0-9]+( [a-z0-9]+){0,2}(\|[a-z0-9]+( [a-z0-9]+){0,2})*$';
  v_claves CONSTANT text[] := ARRAY['categoria', 'termino'];
  v_claves_exc CONSTANT text[] := ARRAY['categoria', 'excepciones', 'termino'];
  v_limite CONSTANT integer := 2000;
  v_tenant_txt text := nullif(current_setting('app.tenant_id', true), '');
  v_usuario_txt text := nullif(current_setting('app.user_id', true), '');
  v_tenant uuid;
  v_usuario uuid;
  v_archivado timestamptz;
  v_tipo text;
  v_serie text;
  v_numero text;
  v_doc text;
  v_vigente integer;
  v_excluida boolean;
  v_item jsonb;
  v_termino text;
  v_formas text[];
  v_guardadas text[] := '{}'::text[];
  v_categorias_nuevas text[] := '{}'::text[];
  v_excepciones_nuevas jsonb[] := '{}'::jsonb[];
  v_llaves text[];
  v_exc jsonb;
  v_omitidas text[] := '{}'::text[];
  v_activas integer;
  v_i integer;
  v_id uuid;
BEGIN
  -- ---- Quién llama ----
  IF v_tenant_txt IS NULL OR v_usuario_txt IS NULL OR v_tenant_txt !~ v_uuid OR v_usuario_txt !~ v_uuid THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'gnd_aprender: sesion sin estudio o sin usuario';
  END IF;
  v_tenant := v_tenant_txt::uuid;
  v_usuario := v_usuario_txt::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM public.membresia mb
     WHERE mb.tenant_id = v_tenant AND mb.usuario_id = v_usuario AND mb.desactivada_en IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'gnd_aprender: sin membresia activa';
  END IF;

  -- ---- 1. Cliente FOR SHARE (serializa con archivar) ----
  IF p_cliente IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'gnd_aprender: cliente no encontrado';
  END IF;
  SELECT k.archivado_at INTO v_archivado FROM public.cliente k
   WHERE k.tenant_id = v_tenant AND k.id = p_cliente
     FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'gnd_aprender: cliente no encontrado';
  END IF;
  IF v_archivado IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'gnd_aprender: cliente archivado';
  END IF;

  -- ---- 2. Compra viva del cliente (FOR SHARE: su exclusión no cambia mientras se aprende) ----
  IF p_compra IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'gnd_aprender: compra no encontrada';
  END IF;
  SELECT btrim(c.tipo_doc), upper(btrim(c.serie)), btrim(c.numero), btrim(c.doc_numero), c.version_vigente
    INTO v_tipo, v_serie, v_numero, v_doc, v_vigente
    FROM public.compra c
   WHERE c.tenant_id = v_tenant AND c.id = p_compra AND c.cliente_id = p_cliente AND c.descartada_en IS NULL
     FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'gnd_aprender: compra no encontrada';
  END IF;
  SELECT v.excluida INTO v_excluida FROM public.compra_version v
   WHERE v.tenant_id = v_tenant AND v.compra_id = p_compra AND v.n = v_vigente;
  IF v_excluida IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = 'CA422', MESSAGE = 'gnd_aprender: la compra no esta excluida';
  END IF;
  -- XML vigente del comprobante (identidad normalizada como la `clave` de 014: serie en mayúsculas, número sin ceros a la izquierda).
  v_numero := CASE WHEN ltrim(v_numero, '0') = '' AND v_numero <> '' THEN '0' ELSE ltrim(v_numero, '0') END;
  IF NOT EXISTS (
    SELECT 1 FROM public.documento_xml d
     WHERE d.tenant_id = v_tenant AND d.cliente_id = p_cliente AND d.ruc_emisor = v_doc AND d.tipo = v_tipo
       AND d.serie = v_serie AND d.numero = v_numero
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'CA423', MESSAGE = 'gnd_aprender: la compra no tiene XML';
  END IF;

  -- ---- 3. Términos: 1 a 10 objetos {termino, categoria[, excepciones]} válidos, o nada ----
  IF jsonb_typeof(p_terminos) IS DISTINCT FROM 'array' OR jsonb_array_length(p_terminos) NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'gnd_aprender: terminos invalidos';
  END IF;
  FOR v_item IN SELECT e.value FROM jsonb_array_elements(p_terminos) AS e LOOP
    -- Paso a paso (sin depender del orden de evaluación de OR): forma del objeto y, si trae `excepciones`, un arreglo de 0 a 5 textos
    -- que juntos cumplen la gramática de frases (la misma de `gnd_palabra_agregar`).
    v_llaves := CASE WHEN jsonb_typeof(v_item) = 'object'
                     THEN (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(v_item) AS k) END;
    IF v_llaves IS DISTINCT FROM v_claves AND v_llaves IS DISTINCT FROM v_claves_exc THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'gnd_aprender: terminos invalidos';
    END IF;
    v_exc := coalesce(v_item -> 'excepciones', '[]'::jsonb);
    IF jsonb_typeof(v_exc) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'gnd_aprender: terminos invalidos';
    END IF;
    IF jsonb_array_length(v_exc) > 5
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_exc) AS x WHERE jsonb_typeof(x) IS DISTINCT FROM 'string')
       OR (jsonb_array_length(v_exc) > 0
           AND (SELECT string_agg(x, '|' ORDER BY n) FROM jsonb_array_elements_text(v_exc) WITH ORDINALITY AS e(x, n)) !~ v_frases_re)
       OR jsonb_typeof(v_item -> 'termino') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_item -> 'categoria') IS DISTINCT FROM 'string'
       OR (v_item ->> 'termino') !~ v_palabra_re
       OR NOT ((v_item ->> 'categoria') = ANY (v_categorias)) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'gnd_aprender: terminos invalidos';
    END IF;
  END LOOP;

  -- ---- 4. El diccionario del estudio, uno a la vez: omitidas, límite y alta ----
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('gnd:' || v_tenant::text, 0));
  FOR v_item IN SELECT e.value FROM jsonb_array_elements(p_terminos) WITH ORDINALITY AS e(value, orden) ORDER BY e.orden LOOP
    v_termino := v_item ->> 'termino';
    v_formas := public.gnd_formas(v_termino);
    IF (v_guardadas && v_formas) OR v_termino = ANY (v_omitidas)
       OR EXISTS (SELECT 1 FROM public.gnd_palabra_estudio p WHERE p.tenant_id = v_tenant AND p.palabra = ANY (v_formas))
       OR EXISTS (
         SELECT 1 FROM public.gnd_palabra_global g
          WHERE g.palabra = ANY (v_formas) AND g.activa
            AND NOT EXISTS (SELECT 1 FROM public.gnd_global_desactivada d
                             WHERE d.tenant_id = v_tenant AND d.palabra_global_id = g.id)) THEN
      v_omitidas := v_omitidas || v_termino;
    ELSE
      v_guardadas := v_guardadas || v_termino;
      v_categorias_nuevas := v_categorias_nuevas || (v_item ->> 'categoria');
      v_excepciones_nuevas := array_append(v_excepciones_nuevas, coalesce(v_item -> 'excepciones', '[]'::jsonb));
    END IF;
  END LOOP;
  IF cardinality(v_guardadas) > 0 THEN
    SELECT count(*)::integer INTO v_activas FROM public.gnd_palabra_estudio p WHERE p.tenant_id = v_tenant AND p.activa;
    IF v_activas + cardinality(v_guardadas) > v_limite THEN
      RAISE EXCEPTION USING ERRCODE = 'CA421', MESSAGE = 'gnd_aprender: limite de palabras';
    END IF;
  END IF;
  FOR v_i IN 1 .. cardinality(v_guardadas) LOOP
    INSERT INTO public.gnd_palabra_estudio (tenant_id, palabra, categoria, excepciones, origen, activa, version, creado_por,
                                            compra_origen_id, creada_en, actualizada_en)
    VALUES (v_tenant, v_guardadas[v_i], v_categorias_nuevas[v_i],
            ARRAY(SELECT x FROM jsonb_array_elements_text(v_excepciones_nuevas[v_i]) WITH ORDINALITY AS e(x, n) ORDER BY n),
            'aprendida', true, 1, v_usuario, p_compra,
            clock_timestamp(), clock_timestamp())
    RETURNING id INTO v_id;
    PERFORM public.auditoria_registrar(v_tenant, 'gnd.palabra_aprendida', p_cliente, 'gnd_palabra_estudio', v_id,
      jsonb_build_object('palabra', v_guardadas[v_i], 'categoria', v_categorias_nuevas[v_i], 'compraId', p_compra));
  END LOOP;
  RETURN jsonb_build_object('guardadas', to_jsonb(v_guardadas), 'omitidas', to_jsonb(v_omitidas));
END
$$;--> statement-breakpoint
ALTER FUNCTION public.gnd_aprender(uuid, uuid, jsonb) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gnd_aprender(uuid, uuid, jsonb)
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gnd_aprender(uuid, uuid, jsonb) TO contapp_backend;
