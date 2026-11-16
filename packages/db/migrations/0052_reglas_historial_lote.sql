-- 0052_reglas_historial_lote (spec 021, T25c, decision del usuario 2026-11-16: «Rendimiento de la descarga»). R-HIS por lotes.
--   aplicar_reglas_historial(p_items jsonb) -> integer  aplica un lote de 1 a 500 compras, p_items = [{compra, regla, datos}], con
--                     EXACTAMENTE las validaciones de aplicar_regla_historial (0048 + 0050): estudio por app.tenant_id; R-HIS
--                     encendido (mismo advisory compartido 'reglas_motor'); compra viva, creada en esta transaccion (xmin), solo
--                     con la version 1 y vigente; regla viva, activa, del mismo cliente y proveedor (documento normalizado) y
--                     aprendida antes del periodo de la compra (FOR SHARE); base gravada distinta de 0; algo que mover; `datos`
--                     con exactamente las 11 columnas de monto (cadenas decimales) iguales a la version 1 consolidada en el
--                     destino (recalculada aqui en NUMERIC); un solo `historial` por compra (sin repetir compra en el lote).
--                     TODO O NADA: un item invalido rechaza el lote entero con 42501 de mensaje fijo y no aplica ninguno (la
--                     funcion por fila tampoco deja seguir a las validas: su 42501 aborta la transaccion de la descarga). Valida
--                     item por item con las mismas lecturas por clave (indices unicos: no depende de las estadisticas de un
--                     estudio nuevo, cuyas compras de esta transaccion aun no estan en ellas) y solo despues escribe: las
--                     versiones 2 y las regla_aplicacion en una sentencia cada una, y el puntero por clave. Devuelve
--                     cuantas versiones creo (= el tamano del lote). SECURITY DEFINER de contapp_migrator, search_path fijo,
--                     EXECUTE solo contapp_worker (patron de 0048). aplicar_regla_historial se conserva (la usan las pruebas y el
--                     soporte del backend) sin cambios.
--   compra.historial  la captura pasa de un trigger por fila a uno por sentencia (tabla de transicion): una fila de auditoria por
--                     regla_aplicacion, con el mismo actor, entidad y datos {compraId, reglaId, periodo}, insertadas en un solo
--                     INSERT por lote. El actor se resuelve una vez por sentencia con la misma regla que auditoria_registrar
--                     (0041): worker con app.trabajo_id -> `trabajo` (trabajo ajeno: 42501); app.user_id -> `usuario`; si no,
--                     `sistema`.
--   interno.auditoria_insertar_lote  par de interno.auditoria_insertar (0041) para varias filas: dueno contapp_registrador,
--                     EXECUTE solo contapp_migrator.
-- Repetible: CREATE OR REPLACE, DROP TRIGGER IF EXISTS, REVOKE/GRANT idempotentes.

-- ---- INSERT de bajo nivel por lote (dueño contapp_registrador) ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION interno.auditoria_insertar_lote(
  p_tenant uuid, p_actor text, p_usuario uuid, p_trabajo uuid, p_accion text, p_entidad text,
  p_clientes uuid[], p_entidad_ids uuid[], p_datos jsonb[]
) RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  INSERT INTO public.auditoria (tenant_id, actor_tipo, usuario_id, trabajo_id, accion, cliente_id, entidad, entidad_id, datos)
  SELECT p_tenant, p_actor, p_usuario, p_trabajo, p_accion, f.cliente, p_entidad, f.entidad_id, coalesce(f.datos, '{}'::jsonb)
    FROM unnest(p_clientes, p_entidad_ids, p_datos) WITH ORDINALITY AS f(cliente, entidad_id, datos, o)
   ORDER BY f.o
$$;--> statement-breakpoint
ALTER FUNCTION interno.auditoria_insertar_lote(uuid, text, uuid, uuid, text, text, uuid[], uuid[], jsonb[]) OWNER TO contapp_registrador;--> statement-breakpoint
REVOKE ALL ON FUNCTION interno.auditoria_insertar_lote(uuid, text, uuid, uuid, text, text, uuid[], uuid[], jsonb[]) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION interno.auditoria_insertar_lote(uuid, text, uuid, uuid, text, text, uuid[], uuid[], jsonb[]) TO contapp_migrator;--> statement-breakpoint

-- ---- compra.historial por sentencia -----------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auditoria_capturar_regla_aplicacion() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_ctx text := nullif(current_setting('app.tenant_id', true), '');
  v_trabajo_ctx text := nullif(current_setting('app.trabajo_id', true), '');
  v_usuario_ctx text := nullif(current_setting('app.user_id', true), '');
  v_tenant uuid;
  v_actor text;
  v_usuario uuid;
  v_trabajo uuid;
  v_clientes uuid[];
  v_ids uuid[];
  v_datos jsonb[];
  v_fila record;
  v_k integer;
BEGIN
  FOR v_tenant IN SELECT DISTINCT n.tenant_id FROM nuevas n LOOP
    -- Lo mismo que auditoria_registrar (0041), una vez por sentencia y estudio.
    IF v_tenant IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'auditoria: sin estudio';
    END IF;
    IF v_ctx IS NOT NULL AND v_ctx::uuid IS DISTINCT FROM v_tenant THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'auditoria: el estudio no coincide con el contexto';
    END IF;
    v_usuario := NULL;
    v_trabajo := NULL;
    IF current_setting('role', true) = 'contapp_worker' AND v_trabajo_ctx IS NOT NULL THEN
      v_trabajo := v_trabajo_ctx::uuid;
      SELECT j.creado_por INTO v_usuario FROM public.job_registro j WHERE j.id = v_trabajo AND j.tenant_id = v_tenant;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'auditoria: trabajo desconocido';
      END IF;
      v_actor := 'trabajo';
    ELSIF v_usuario_ctx IS NOT NULL THEN
      v_actor := 'usuario';
      v_usuario := v_usuario_ctx::uuid;
    ELSE
      v_actor := 'sistema';
    END IF;
    -- El cliente de cada compra, leido por su clave (indice unico): no depende de las estadisticas de un estudio nuevo.
    v_clientes := '{}';
    v_ids := '{}';
    v_datos := '{}';
    v_k := 0;
    FOR v_fila IN SELECT n.id, n.compra_id, n.regla_id, n.periodo FROM nuevas n WHERE n.tenant_id = v_tenant ORDER BY n.id LOOP
      v_k := v_k + 1;
      v_clientes[v_k] := (SELECT c.cliente_id FROM public.compra c WHERE c.tenant_id = v_tenant AND c.id = v_fila.compra_id);
      v_ids[v_k] := v_fila.id;
      v_datos[v_k] := jsonb_build_object('compraId', v_fila.compra_id, 'reglaId', v_fila.regla_id, 'periodo', v_fila.periodo::text);
    END LOOP;
    PERFORM interno.auditoria_insertar_lote(v_tenant, v_actor, v_usuario, v_trabajo, 'compra.historial', 'regla_aplicacion',
      v_clientes, v_ids, v_datos);
  END LOOP;
  RETURN NULL;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.auditoria_capturar_regla_aplicacion() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.auditoria_capturar_regla_aplicacion() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS auditoria_regla_aplicacion ON public.regla_aplicacion;--> statement-breakpoint
CREATE TRIGGER auditoria_regla_aplicacion AFTER INSERT ON public.regla_aplicacion
  REFERENCING NEW TABLE AS nuevas FOR EACH STATEMENT EXECUTE FUNCTION public.auditoria_capturar_regla_aplicacion();--> statement-breakpoint

-- ---- Aplicacion de reglas a un lote de compras nuevas de la descarga ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public.aplicar_reglas_historial(p_items jsonb) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  v_claves CONSTANT text[] := ARRAY['bi_dg', 'bi_dgng', 'bi_dng', 'icbper', 'igv_dg', 'igv_dgng', 'igv_dng', 'isc',
                                    'no_gravado', 'otros_tributos', 'total'];
  v_claves_item CONSTANT text[] := ARRAY['compra', 'datos', 'regla'];
  v_uuid CONSTANT text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_monto CONSTANT text := '^-?[0-9]{1,12}([.][0-9]{1,2})?$';
  v_n integer;
  v_i integer := 0;
  v_item jsonb;
  v_datos jsonb;
  v_clave text;
  v_compra_id uuid;
  v_regla_id uuid;
  v_compra record;
  v_v1 record;
  v_regla record;
  v_bi numeric;
  v_igv numeric;
  v_esperado jsonb;
  v_movidas integer;
  -- Lo que se escribe, en el orden del lote (una posicion por item).
  a_compra uuid[] := '{}';
  a_regla uuid[] := '{}';
  a_periodo text[] := '{}';
  a_bi_dg numeric[] := '{}';
  a_igv_dg numeric[] := '{}';
  a_bi_dgng numeric[] := '{}';
  a_igv_dgng numeric[] := '{}';
  a_bi_dng numeric[] := '{}';
  a_igv_dng numeric[] := '{}';
  a_no_gravado numeric[] := '{}';
  a_isc numeric[] := '{}';
  a_icbper numeric[] := '{}';
  a_otros_tributos numeric[] := '{}';
  a_total numeric[] := '{}';
  a_excluida boolean[] := '{}';
  a_motivo text[] := '{}';
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'aplicar_reglas_historial: sesion sin estudio';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'aplicar_reglas_historial: aplicacion rechazada';
  END IF;
  v_n := jsonb_array_length(p_items);
  IF v_n < 1 OR v_n > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'aplicar_reglas_historial: aplicacion rechazada';
  END IF;

  -- Forma de cada item, la misma que los parametros de aplicar_regla_historial: compra y regla uuid; datos con las 11 columnas.
  -- IF anidados: jsonb_object_keys solo se evalua sobre un objeto.
  FOR v_item IN SELECT e.value FROM jsonb_array_elements(p_items) AS e LOOP
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'aplicar_reglas_historial: aplicacion rechazada';
    END IF;
    IF (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(v_item) AS k) IS DISTINCT FROM v_claves_item
       OR jsonb_typeof(v_item -> 'compra') IS DISTINCT FROM 'string' OR jsonb_typeof(v_item -> 'regla') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_item -> 'datos') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'aplicar_reglas_historial: aplicacion rechazada';
    END IF;
    v_datos := v_item -> 'datos';
    IF (v_item ->> 'compra') !~ v_uuid OR (v_item ->> 'regla') !~ v_uuid
       OR (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(v_datos) AS k) IS DISTINCT FROM v_claves THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'aplicar_reglas_historial: aplicacion rechazada';
    END IF;
    FOREACH v_clave IN ARRAY v_claves LOOP
      IF jsonb_typeof(v_datos -> v_clave) <> 'string' OR (v_datos ->> v_clave) !~ v_monto THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'aplicar_reglas_historial: aplicacion rechazada';
      END IF;
    END LOOP;
  END LOOP;
  -- Un solo `historial` por compra: la misma compra dos veces en el lote se rechaza (por fila, la segunda llamada falla).
  IF (SELECT count(DISTINCT (e.value ->> 'compra')::uuid) FROM jsonb_array_elements(p_items) AS e) <> v_n THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'aplicar_reglas_historial: aplicacion rechazada';
  END IF;

  -- Mismo candado compartido que reglas_historial_vigentes: el interruptor no cambia a mitad de la descarga.
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('reglas_motor:' || v_tenant::text, 0));
  IF EXISTS (
    SELECT 1 FROM public.estudio_regla_motor m WHERE m.tenant_id = v_tenant AND m.codigo = 'R-HIS' AND NOT m.activa
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'aplicar_reglas_historial: aplicacion rechazada';
  END IF;

  -- Cada item, en orden, con las mismas lecturas y comprobaciones que aplicar_regla_historial (por clave: indices unicos, sin
  -- depender de las estadisticas de un estudio nuevo). Nada se escribe hasta validar el lote entero.
  FOR v_item IN SELECT e.value FROM jsonb_array_elements(p_items) WITH ORDINALITY AS e(value, o) ORDER BY e.o LOOP
    v_i := v_i + 1;
    v_compra_id := (v_item ->> 'compra')::uuid;
    v_regla_id := (v_item ->> 'regla')::uuid;
    v_datos := v_item -> 'datos';

    -- La compra: viva, creada en esta transaccion y solo con la version 1, que es la vigente.
    SELECT c.id, c.cliente_id, c.periodo, c.doc_tipo, c.doc_numero INTO v_compra
      FROM public.compra c
     WHERE c.tenant_id = v_tenant AND c.id = v_compra_id AND c.descartada_en IS NULL AND c.version_vigente = 1
       AND c.xmin = pg_current_xact_id()::xid;
    IF NOT FOUND OR (
      SELECT count(*) FROM public.compra_version v WHERE v.tenant_id = v_tenant AND v.compra_id = v_compra_id
    ) <> 1 THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'aplicar_reglas_historial: aplicacion rechazada';
    END IF;
    SELECT * INTO v_v1 FROM public.compra_version v WHERE v.tenant_id = v_tenant AND v.compra_id = v_compra_id AND v.n = 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'aplicar_reglas_historial: aplicacion rechazada';
    END IF;

    -- La regla: del mismo cliente y proveedor, viva, activa y aprendida antes del periodo de la compra (P-5).
    SELECT r.id, r.destino INTO v_regla
      FROM public.regla_aprendida r
     WHERE r.tenant_id = v_tenant AND r.id = v_regla_id AND r.cliente_id = v_compra.cliente_id
       AND r.doc_tipo = btrim(v_compra.doc_tipo)
       AND r.doc_numero = upper(regexp_replace(v_compra.doc_numero, '[[:space:]]', '', 'g'))
       AND r.eliminada_en IS NULL AND r.activa AND r.periodo_aprendido < v_compra.periodo
     FOR SHARE OF r;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'aplicar_reglas_historial: aplicacion rechazada';
    END IF;

    -- La version 1 consolidada en el destino, recalculada aqui: los tres BI y los tres IGV en el par del destino; lo demas igual.
    v_bi := v_v1.bi_dg + v_v1.bi_dgng + v_v1.bi_dng;
    v_igv := v_v1.igv_dg + v_v1.igv_dgng + v_v1.igv_dng;
    v_esperado := jsonb_build_object(
      'bi_dg', CASE WHEN v_regla.destino = 'DG' THEN v_bi ELSE 0 END,
      'igv_dg', CASE WHEN v_regla.destino = 'DG' THEN v_igv ELSE 0 END,
      'bi_dgng', CASE WHEN v_regla.destino = 'DGNG' THEN v_bi ELSE 0 END,
      'igv_dgng', CASE WHEN v_regla.destino = 'DGNG' THEN v_igv ELSE 0 END,
      'bi_dng', CASE WHEN v_regla.destino = 'DNG' THEN v_bi ELSE 0 END,
      'igv_dng', CASE WHEN v_regla.destino = 'DNG' THEN v_igv ELSE 0 END,
      'no_gravado', v_v1.no_gravado,
      'isc', v_v1.isc,
      'icbper', v_v1.icbper,
      'otros_tributos', v_v1.otros_tributos,
      'total', v_v1.total);
    -- D-7 (H-021-1-3, H-021-1-4): base gravada total 0 o la version 1 ya en el par del destino: nada que mover.
    IF v_bi = 0 OR (
         v_v1.bi_dg = (v_esperado ->> 'bi_dg')::numeric AND v_v1.igv_dg = (v_esperado ->> 'igv_dg')::numeric
         AND v_v1.bi_dgng = (v_esperado ->> 'bi_dgng')::numeric AND v_v1.igv_dgng = (v_esperado ->> 'igv_dgng')::numeric
         AND v_v1.bi_dng = (v_esperado ->> 'bi_dng')::numeric AND v_v1.igv_dng = (v_esperado ->> 'igv_dng')::numeric
       ) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'aplicar_reglas_historial: aplicacion rechazada';
    END IF;
    FOREACH v_clave IN ARRAY v_claves LOOP
      IF (v_datos ->> v_clave)::numeric IS DISTINCT FROM (v_esperado ->> v_clave)::numeric THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'aplicar_reglas_historial: aplicacion rechazada';
      END IF;
    END LOOP;

    a_compra[v_i] := v_compra_id;
    a_regla[v_i] := v_regla_id;
    a_periodo[v_i] := v_compra.periodo;
    a_bi_dg[v_i] := (v_esperado ->> 'bi_dg')::numeric;
    a_igv_dg[v_i] := (v_esperado ->> 'igv_dg')::numeric;
    a_bi_dgng[v_i] := (v_esperado ->> 'bi_dgng')::numeric;
    a_igv_dgng[v_i] := (v_esperado ->> 'igv_dgng')::numeric;
    a_bi_dng[v_i] := (v_esperado ->> 'bi_dng')::numeric;
    a_igv_dng[v_i] := (v_esperado ->> 'igv_dng')::numeric;
    a_no_gravado[v_i] := v_v1.no_gravado;
    a_isc[v_i] := v_v1.isc;
    a_icbper[v_i] := v_v1.icbper;
    a_otros_tributos[v_i] := v_v1.otros_tributos;
    a_total[v_i] := v_v1.total;
    a_excluida[v_i] := v_v1.excluida;
    a_motivo[v_i] := v_v1.motivo;
  END LOOP;

  -- Lo mismo que escribe aplicar_regla_historial por cada compra.
  INSERT INTO public.compra_version (tenant_id, compra_id, n, bi_dg, igv_dg, bi_dgng, igv_dgng, bi_dng, igv_dng, no_gravado, isc,
      icbper, otros_tributos, total, excluida, motivo, clasificada, accion, operacion_id, usuario_id)
  SELECT v_tenant, u.compra, 2, u.bi_dg, u.igv_dg, u.bi_dgng, u.igv_dgng, u.bi_dng, u.igv_dng, u.no_gravado, u.isc, u.icbper,
         u.otros_tributos, u.total, u.excluida, u.motivo, true, 'historial', NULL, NULL
    FROM unnest(a_compra, a_bi_dg, a_igv_dg, a_bi_dgng, a_igv_dgng, a_bi_dng, a_igv_dng, a_no_gravado, a_isc, a_icbper,
                a_otros_tributos, a_total, a_excluida, a_motivo)
         WITH ORDINALITY AS u(compra, bi_dg, igv_dg, bi_dgng, igv_dgng, bi_dng, igv_dng, no_gravado, isc, icbper, otros_tributos,
                              total, excluida, motivo, o)
   ORDER BY u.o;
  -- El puntero, compra por compra por su clave: un UPDATE con `= ANY` recorre la tabla entera cuando las estadisticas aun no
  -- conocen al estudio (las compras de esta transaccion no estan en ellas).
  FOR v_i IN 1 .. v_n LOOP
    UPDATE public.compra c SET version_vigente = 2
     WHERE c.tenant_id = v_tenant AND c.id = a_compra[v_i] AND c.version_vigente = 1;
    GET DIAGNOSTICS v_movidas = ROW_COUNT;
    IF v_movidas <> 1 THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'aplicar_reglas_historial: aplicacion rechazada';
    END IF;
  END LOOP;
  INSERT INTO public.regla_aplicacion (tenant_id, regla_id, compra_id, version_n, periodo)
  SELECT v_tenant, u.regla, u.compra, 2, u.periodo
    FROM unnest(a_regla, a_compra, a_periodo) WITH ORDINALITY AS u(regla, compra, periodo, o)
   ORDER BY u.o;
  RETURN v_n;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.aplicar_reglas_historial(jsonb) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.aplicar_reglas_historial(jsonb)
  FROM PUBLIC, contapp_backend, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.aplicar_reglas_historial(jsonb) TO contapp_worker;
