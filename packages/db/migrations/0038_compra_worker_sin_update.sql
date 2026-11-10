-- 0038_compra_worker_sin_update (custom, spec 016, T23: hallazgos H-016-8 y H-016-9 de la ronda adversarial 2). Se renumera si 012b
-- llega antes a main. Repetible: REVOKE/GRANT idempotentes, CREATE OR REPLACE y DROP TRIGGER IF EXISTS.
--   H-016-8  El worker pierde TODO UPDATE sobre `compra` (0036 le dio UPDATE (version_vigente) solo para poder bloquear la fila en
--            la re-evaluación): no puede mover el puntero ni a una versión que existe. La re-evaluación sigue bloqueando la fila con
--            `bloquear_compras_reevaluar`, una función SECURITY DEFINER acotada:
--              - dueño contapp_migrator (dueño de compra, no superusuario ni BYPASSRLS): la RLS FORCE de compra aplica dentro, y
--                además filtra por el estudio de app.tenant_id;
--              - solo bloquea (FOR UPDATE, en orden de id, el mismo modo que las escrituras de 014: sin interbloqueos nuevos) las
--                compras vivas pedidas y devuelve sus ids; no lee ni escribe nada más;
--              - search_path fijo, EXECUTE solo a contapp_worker; errores con mensaje fijo (42501 sin estudio, 22023 parámetro).
--            Su INSERT en `compra_version` queda acotado a la versión 1 de una compra creada en la MISMA transacción y aún sin
--            versiones (lo único que hace `insertarCompras` en la descarga): trigger BEFORE INSERT, 42501 antes que la unicidad.
--            El backend no cambia (conserva UPDATE (version_vigente, descartada_en) y escribe versiones con normalidad).
--   H-016-9  La clave del candado del tope de `encolar_xml_obtener` sale del estudio normalizado (uuid canónico en minúsculas),
--            igual que `insertarTrabajo` (registro.ts): con app.tenant_id en mayúsculas el candado es el mismo.
REVOKE UPDATE ON public.compra FROM contapp_worker;--> statement-breakpoint
REVOKE UPDATE (version_vigente) ON public.compra FROM contapp_worker;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.bloquear_compras_reevaluar(p_compra_ids uuid[]) RETURNS SETOF uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'bloquear_compras_reevaluar: sesion sin estudio' USING ERRCODE = '42501';
  END IF;
  IF p_compra_ids IS NULL OR coalesce(array_ndims(p_compra_ids), 1) <> 1 OR coalesce(cardinality(p_compra_ids), 0) > 5000 THEN
    RAISE EXCEPTION 'bloquear_compras_reevaluar: parametro invalido' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT c.id FROM public.compra c
     WHERE c.tenant_id = v_tenant AND c.id = ANY (p_compra_ids) AND c.descartada_en IS NULL
     ORDER BY c.id
     FOR UPDATE;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.bloquear_compras_reevaluar(uuid[]) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.bloquear_compras_reevaluar(uuid[])
  FROM PUBLIC, contapp_backend, contapp_platform, contapp_app, contapp_enumerador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.bloquear_compras_reevaluar(uuid[]) TO contapp_worker;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.compra_version_worker_acotado() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF current_user <> 'contapp_worker' THEN
    RETURN NEW;
  END IF;
  IF NEW.n IS DISTINCT FROM 1
     OR NOT EXISTS (
       SELECT 1 FROM public.compra c
        WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.compra_id AND c.xmin = pg_current_xact_id()::xid
     )
     OR EXISTS (
       SELECT 1 FROM public.compra_version v WHERE v.tenant_id = NEW.tenant_id AND v.compra_id = NEW.compra_id
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'compra_version: el worker solo escribe la version 1 de una compra creada en su transaccion';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.compra_version_worker_acotado() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.compra_version_worker_acotado() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS compra_version_worker_acotado ON public.compra_version;--> statement-breakpoint
CREATE TRIGGER compra_version_worker_acotado BEFORE INSERT ON public.compra_version
  FOR EACH ROW EXECUTE FUNCTION public.compra_version_worker_acotado();--> statement-breakpoint

-- H-016-9: la misma función de 0037 con la clave del candado del tope sobre el estudio normalizado.
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
GRANT EXECUTE ON FUNCTION public.encolar_xml_obtener(uuid, text, uuid[], uuid) TO contapp_worker;
