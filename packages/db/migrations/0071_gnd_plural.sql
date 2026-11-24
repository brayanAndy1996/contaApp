-- 0071_gnd_plural (spec 027, T17; H-027-1-1, decisión del usuario 2026-11-23). El plural simple cuenta EN AMBOS SENTIDOS como la misma
-- palabra (R-4 / U-4 ajustadas): al guardar, la otra forma de una palabra existente es un duplicado. Repetible (CREATE OR REPLACE;
-- ALTER/REVOKE/GRANT idempotentes). Sin migrar el diccionario existente (las dos formas que ya estén guardadas se quedan).
--   public.gnd_formas(palabra) -> text[]: la palabra, su plural simple (+s; +es tras vocal o l, r, n, d, j, s, x, y, «ch») y su singular
--     simple (sin «s»; sin «es» si lo que queda lo admite), con el singular de 3 letras como mínimo. Sin raíces ni prefijos («guantes» es
--     «guante» + s y no «guant» + es; «lapices» no es «lapiz»). Pura (IMMUTABLE, sin tablas), de invocador: la ejecutan los dueños de las
--     funciones que la llaman (contapp_migrator por serlo; contapp_auth por GRANT). Es la misma regla de `mismaPalabra` del dominio
--     (`packages/domain/src/texto/diccionario.ts`).
--   gnd_palabra_agregar: CA420 si el estudio ya tiene la palabra o su otra forma (activa o no).
--   gnd_aprender: omite el término si ya existe en cualquiera de sus formas (propia activa o no, global activa no desactivada por el
--     estudio) o si su otra forma ya se guarda en la misma lista (gana la primera).
--   auth.gnd_global_agregar: CA420 si existe una global (activa o no) con la palabra o su otra forma; decidido bajo un advisory global.
--     `auth.gnd_global_editar` no cambia la palabra: sin cambios.
-- El resto de cada función es el de 0070 (dueño, search_path fijo, nombres calificados, SQLSTATE y mensajes fijos, sin EXCEPTION ni
-- SAVEPOINT, el mismo orden de validación) y se repiten REVOKE/GRANT.

-- ---- La otra forma de una palabra (pura) ----------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gnd_formas(p_palabra text) RETURNS text[]
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog, pg_temp
AS $$
  SELECT ARRAY[p_palabra, p_palabra || 's']
      || CASE WHEN p_palabra ~ '([aeioulrndjsxy]|ch)$' THEN ARRAY[p_palabra || 'es'] ELSE '{}'::text[] END
      || CASE WHEN length(p_palabra) > 3 AND right(p_palabra, 1) = 's' THEN ARRAY[left(p_palabra, -1)] ELSE '{}'::text[] END
      || CASE WHEN length(p_palabra) > 4 AND right(p_palabra, 2) = 'es' AND left(p_palabra, -2) ~ '([aeioulrndjsxy]|ch)$'
              THEN ARRAY[left(p_palabra, -2)] ELSE '{}'::text[] END
$$;--> statement-breakpoint
ALTER FUNCTION public.gnd_formas(text) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gnd_formas(text)
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gnd_formas(text) TO contapp_auth;--> statement-breakpoint

-- ---- Agregar una palabra propia (backend) -----------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gnd_palabra_agregar(p_palabra text, p_categoria text, p_excepciones text[]) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_uuid CONSTANT text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_palabra_re CONSTANT text := '^[a-z0-9]{3,40}$';
  v_frases_re CONSTANT text := '^[a-z0-9]+( [a-z0-9]+){0,2}(\|[a-z0-9]+( [a-z0-9]+){0,2})*$';
  v_categorias CONSTANT text[] := ARRAY['calzado-ropa', 'juguetes', 'entretenimiento', 'alimentos-personales', 'cuidado-personal',
                                        'utiles-escolares'];
  v_limite CONSTANT integer := 2000;
  v_tenant_txt text := nullif(current_setting('app.tenant_id', true), '');
  v_usuario_txt text := nullif(current_setting('app.user_id', true), '');
  v_tenant uuid;
  v_usuario uuid;
  v_activas integer;
  v_id uuid;
BEGIN
  -- ---- Quién llama ----
  IF v_tenant_txt IS NULL OR v_usuario_txt IS NULL OR v_tenant_txt !~ v_uuid OR v_usuario_txt !~ v_uuid THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'gnd_palabra_agregar: sesion sin estudio o sin usuario';
  END IF;
  v_tenant := v_tenant_txt::uuid;
  v_usuario := v_usuario_txt::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM public.membresia mb
     WHERE mb.tenant_id = v_tenant AND mb.usuario_id = v_usuario AND mb.desactivada_en IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'gnd_palabra_agregar: sin membresia activa';
  END IF;

  -- ---- Entradas ----
  IF p_palabra IS NULL OR p_palabra !~ v_palabra_re
     OR p_categoria IS NULL OR NOT (p_categoria = ANY (v_categorias))
     OR p_excepciones IS NULL OR cardinality(p_excepciones) > 5
     OR (cardinality(p_excepciones) > 0
         AND (array_ndims(p_excepciones) <> 1 OR array_to_string(p_excepciones, '|', '') !~ v_frases_re)) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'gnd_palabra_agregar: entradas invalidas';
  END IF;

  -- ---- El diccionario del estudio, uno a la vez ----
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('gnd:' || v_tenant::text, 0));

  IF EXISTS (SELECT 1 FROM public.gnd_palabra_estudio p
              WHERE p.tenant_id = v_tenant AND p.palabra = ANY (public.gnd_formas(p_palabra))) THEN
    RAISE EXCEPTION USING ERRCODE = 'CA420', MESSAGE = 'gnd_palabra_agregar: la palabra ya existe';
  END IF;
  SELECT count(*)::integer INTO v_activas FROM public.gnd_palabra_estudio p WHERE p.tenant_id = v_tenant AND p.activa;
  IF v_activas >= v_limite THEN
    RAISE EXCEPTION USING ERRCODE = 'CA421', MESSAGE = 'gnd_palabra_agregar: limite de palabras';
  END IF;

  INSERT INTO public.gnd_palabra_estudio (tenant_id, palabra, categoria, excepciones, origen, activa, version, creado_por,
                                          compra_origen_id, creada_en, actualizada_en)
  VALUES (v_tenant, p_palabra, p_categoria, p_excepciones, 'manual', true, 1, v_usuario, NULL, clock_timestamp(), clock_timestamp())
  RETURNING id INTO v_id;
  PERFORM public.auditoria_registrar(v_tenant, 'gnd.palabra_agregada', NULL, 'gnd_palabra_estudio', v_id,
    jsonb_build_object('palabra', p_palabra, 'categoria', p_categoria, 'origen', 'manual'));
  RETURN v_id;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.gnd_palabra_agregar(text, text, text[]) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gnd_palabra_agregar(text, text, text[])
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gnd_palabra_agregar(text, text, text[]) TO contapp_backend;--> statement-breakpoint

-- ---- Aprender palabras de una compra excluida con XML (backend) -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gnd_aprender(p_cliente uuid, p_compra uuid, p_terminos jsonb) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_uuid CONSTANT text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_palabra_re CONSTANT text := '^[a-z0-9]{3,40}$';
  v_categorias CONSTANT text[] := ARRAY['calzado-ropa', 'juguetes', 'entretenimiento', 'alimentos-personales', 'cuidado-personal',
                                        'utiles-escolares'];
  v_claves CONSTANT text[] := ARRAY['categoria', 'termino'];
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

  -- ---- 3. Términos: 1 a 10 objetos {termino, categoria} válidos, o nada ----
  IF jsonb_typeof(p_terminos) IS DISTINCT FROM 'array' OR jsonb_array_length(p_terminos) NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'gnd_aprender: terminos invalidos';
  END IF;
  FOR v_item IN SELECT e.value FROM jsonb_array_elements(p_terminos) AS e LOOP
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object'
       OR (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(v_item) AS k) IS DISTINCT FROM v_claves
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
    VALUES (v_tenant, v_guardadas[v_i], v_categorias_nuevas[v_i], '{}'::text[], 'aprendida', true, 1, v_usuario, p_compra,
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
GRANT EXECUTE ON FUNCTION public.gnd_aprender(uuid, uuid, jsonb) TO contapp_backend;--> statement-breakpoint

-- ---- Agregar una global (plataforma) ------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth.gnd_global_agregar(p_token_hash bytea, p_palabra text, p_categoria text, p_excepciones text[])
  RETURNS SETOF public.gnd_palabra_global
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_palabra_re CONSTANT text := '^[a-z0-9]{3,40}$';
  v_frases_re CONSTANT text := '^[a-z0-9]+( [a-z0-9]+){0,2}(\|[a-z0-9]+( [a-z0-9]+){0,2})*$';
  v_categorias CONSTANT text[] := ARRAY['calzado-ropa', 'juguetes', 'entretenimiento', 'alimentos-personales', 'cuidado-personal',
                                        'utiles-escolares'];
  v_usuario uuid;
  v public.gnd_palabra_global%ROWTYPE;
BEGIN
  SELECT x.usuario_id INTO v_usuario FROM auth.sesion x JOIN public.admin_plataforma a ON a.usuario_id = x.usuario_id
   WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'permiso_denegado';
  END IF;
  IF p_palabra IS NULL OR p_palabra !~ v_palabra_re
     OR p_categoria IS NULL OR NOT (p_categoria = ANY (v_categorias))
     OR p_excepciones IS NULL OR cardinality(p_excepciones) > 5
     OR (cardinality(p_excepciones) > 0
         AND (array_ndims(p_excepciones) <> 1 OR array_to_string(p_excepciones, '|', '') !~ v_frases_re)) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'gnd_global_agregar: entradas invalidas';
  END IF;
  -- Las globales, una alta a la vez: la otra forma se decide bajo el advisory (nunca dos formas por concurrencia).
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('gnd:global', 0));
  IF EXISTS (SELECT 1 FROM public.gnd_palabra_global g WHERE g.palabra = ANY (public.gnd_formas(p_palabra))) THEN
    RAISE EXCEPTION USING ERRCODE = 'CA420', MESSAGE = 'gnd_global_agregar: la palabra ya existe';
  END IF;
  INSERT INTO public.gnd_palabra_global AS n (palabra, categoria, excepciones, activa, version, actualizada_en)
  VALUES (p_palabra, p_categoria, p_excepciones, true, 1, clock_timestamp())
  ON CONFLICT (palabra) DO NOTHING
  RETURNING n.* INTO v;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'CA420', MESSAGE = 'gnd_global_agregar: la palabra ya existe';
  END IF;
  INSERT INTO public.gnd_global_historial (palabra_global_id, accion, antes, despues, usuario_id, ocurrida_en)
  VALUES (v.id, 'agregada', NULL,
          jsonb_build_object('palabra', v.palabra, 'categoria', v.categoria, 'excepciones', to_jsonb(v.excepciones),
                             'activa', v.activa, 'version', v.version),
          v_usuario, clock_timestamp());
  RETURN NEXT v;
END
$$;--> statement-breakpoint
ALTER FUNCTION auth.gnd_global_agregar(bytea, text, text, text[]) OWNER TO contapp_auth;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth.gnd_global_agregar(bytea, text, text, text[])
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth.gnd_global_agregar(bytea, text, text, text[]) TO contapp_backend;
