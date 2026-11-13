-- 0050_regla_correcciones_r1 (spec 021, T18). Correcciones de la ronda adversarial 1 sobre las funciones de 0048 y 0049. Solo
-- CREATE OR REPLACE con las mismas firmas, duenos y grants (los triggers de 0049 siguen apuntando a la funcion): repetible.
--   aplicar_regla_historial  ademas de lo de 0048, rechaza (42501, mensaje fijo) lo que no mueve nada (D-7, CA-4): base gravada
--                     total 0 (H-021-1-3) y version 1 ya con los BI e IGV en el par del destino de la regla (H-021-1-4). Es lo
--                     mismo que planificarHistorial descarta en el dominio.
--   regla_aceptar_periodo  una aplicacion cuenta como aceptada (y deja la confirmacion `aceptada`) solo si la version vigente no
--                     esta excluida (H-021-1-6) y tanto la vigente como la version `historial` de regla_aplicacion estan en el
--                     destino actual de la regla (H-021-1-5: tras editar la regla, mover la fila a mano al destino nuevo es una
--                     clasificacion manual y no cuenta, P-1). Editar otro campo o devolver la fila al destino sigue contando (P-4).
CREATE OR REPLACE FUNCTION public.aplicar_regla_historial(p_compra uuid, p_regla uuid, p_datos jsonb) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  v_claves CONSTANT text[] := ARRAY['bi_dg', 'bi_dgng', 'bi_dng', 'icbper', 'igv_dg', 'igv_dgng', 'igv_dng', 'isc',
                                    'no_gravado', 'otros_tributos', 'total'];
  v_compra record;
  v_v1 record;
  v_regla record;
  v_bi numeric;
  v_igv numeric;
  v_esperado jsonb;
  v_clave text;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'aplicar_regla_historial: sesion sin estudio';
  END IF;
  IF p_compra IS NULL OR p_regla IS NULL OR p_datos IS NULL OR jsonb_typeof(p_datos) <> 'object'
     OR (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(p_datos) AS k) IS DISTINCT FROM v_claves THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'aplicar_regla_historial: aplicacion rechazada';
  END IF;
  FOREACH v_clave IN ARRAY v_claves LOOP
    IF jsonb_typeof(p_datos -> v_clave) <> 'string' OR (p_datos ->> v_clave) !~ '^-?[0-9]{1,12}([.][0-9]{1,2})?$' THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'aplicar_regla_historial: aplicacion rechazada';
    END IF;
  END LOOP;

  -- Mismo candado compartido que reglas_historial_vigentes: el interruptor no cambia a mitad de la descarga.
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('reglas_motor:' || v_tenant::text, 0));
  IF EXISTS (
    SELECT 1 FROM public.estudio_regla_motor m WHERE m.tenant_id = v_tenant AND m.codigo = 'R-HIS' AND NOT m.activa
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'aplicar_regla_historial: aplicacion rechazada';
  END IF;

  -- La compra: viva, creada en esta transaccion y solo con la version 1, que es la vigente.
  SELECT c.id, c.cliente_id, c.periodo, c.doc_tipo, c.doc_numero INTO v_compra
    FROM public.compra c
   WHERE c.tenant_id = v_tenant AND c.id = p_compra AND c.descartada_en IS NULL AND c.version_vigente = 1
     AND c.xmin = pg_current_xact_id()::xid;
  IF NOT FOUND OR (
    SELECT count(*) FROM public.compra_version v WHERE v.tenant_id = v_tenant AND v.compra_id = p_compra
  ) <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'aplicar_regla_historial: aplicacion rechazada';
  END IF;
  SELECT * INTO v_v1 FROM public.compra_version v WHERE v.tenant_id = v_tenant AND v.compra_id = p_compra AND v.n = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'aplicar_regla_historial: aplicacion rechazada';
  END IF;

  -- La regla: del mismo cliente y proveedor, viva, activa y aprendida antes del periodo de la compra (P-5).
  SELECT r.id, r.destino INTO v_regla
    FROM public.regla_aprendida r
   WHERE r.tenant_id = v_tenant AND r.id = p_regla AND r.cliente_id = v_compra.cliente_id
     AND r.doc_tipo = btrim(v_compra.doc_tipo)
     AND r.doc_numero = upper(regexp_replace(v_compra.doc_numero, '[[:space:]]', '', 'g'))
     AND r.eliminada_en IS NULL AND r.activa AND r.periodo_aprendido < v_compra.periodo
   FOR SHARE OF r;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'aplicar_regla_historial: aplicacion rechazada';
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
  -- D-7 (H-021-1-3, H-021-1-4): nada que mover. Base gravada total 0 (solo no gravado, exonerado...) o la version 1 ya tiene
  -- los BI e IGV en el par del destino de la regla: no hay version `historial` (la fila sigue como la propuesta).
  IF v_bi = 0 OR (
       v_v1.bi_dg = (v_esperado ->> 'bi_dg')::numeric AND v_v1.igv_dg = (v_esperado ->> 'igv_dg')::numeric
       AND v_v1.bi_dgng = (v_esperado ->> 'bi_dgng')::numeric AND v_v1.igv_dgng = (v_esperado ->> 'igv_dgng')::numeric
       AND v_v1.bi_dng = (v_esperado ->> 'bi_dng')::numeric AND v_v1.igv_dng = (v_esperado ->> 'igv_dng')::numeric
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'aplicar_regla_historial: aplicacion rechazada';
  END IF;
  FOREACH v_clave IN ARRAY v_claves LOOP
    IF (p_datos ->> v_clave)::numeric IS DISTINCT FROM (v_esperado ->> v_clave)::numeric THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'aplicar_regla_historial: aplicacion rechazada';
    END IF;
  END LOOP;

  INSERT INTO public.compra_version (tenant_id, compra_id, n, bi_dg, igv_dg, bi_dgng, igv_dgng, bi_dng, igv_dng, no_gravado, isc,
      icbper, otros_tributos, total, excluida, motivo, clasificada, accion, operacion_id, usuario_id)
  VALUES (v_tenant, p_compra, 2,
      (v_esperado ->> 'bi_dg')::numeric, (v_esperado ->> 'igv_dg')::numeric,
      (v_esperado ->> 'bi_dgng')::numeric, (v_esperado ->> 'igv_dgng')::numeric,
      (v_esperado ->> 'bi_dng')::numeric, (v_esperado ->> 'igv_dng')::numeric,
      v_v1.no_gravado, v_v1.isc, v_v1.icbper, v_v1.otros_tributos, v_v1.total,
      v_v1.excluida, v_v1.motivo, true, 'historial', NULL, NULL);
  UPDATE public.compra SET version_vigente = 2 WHERE tenant_id = v_tenant AND id = p_compra AND version_vigente = 1;
  INSERT INTO public.regla_aplicacion (tenant_id, regla_id, compra_id, version_n, periodo)
  VALUES (v_tenant, p_regla, p_compra, 2, v_compra.periodo);
  RETURN 2;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.aplicar_regla_historial(uuid, uuid, jsonb) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.aplicar_regla_historial(uuid, uuid, jsonb)
  FROM PUBLIC, contapp_backend, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.aplicar_regla_historial(uuid, uuid, jsonb) TO contapp_worker;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.regla_aceptar_periodo() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_previo text := current_setting('app.tenant_id', true);
  v_aportar boolean;
BEGIN
  PERFORM set_config('app.tenant_id', NEW.tenant_id::text, true);
  SELECT coalesce((SELECT k.aportar_catalogo FROM public.estudio_reglas_config k WHERE k.tenant_id = NEW.tenant_id), true)
    INTO v_aportar;
  WITH candidatas AS (
    SELECT a.id, a.regla_id, a.periodo
      FROM public.regla_aplicacion a
      JOIN public.compra c ON c.tenant_id = a.tenant_id AND c.id = a.compra_id
      JOIN public.compra_version v ON v.tenant_id = c.tenant_id AND v.compra_id = c.id AND v.n = c.version_vigente
      JOIN public.compra_version h ON h.tenant_id = a.tenant_id AND h.compra_id = a.compra_id AND h.n = a.version_n
                                    AND h.accion = 'historial'
      JOIN public.regla_aprendida r ON r.tenant_id = a.tenant_id AND r.id = a.regla_id
     WHERE a.tenant_id = NEW.tenant_id AND c.cliente_id = NEW.cliente_id AND c.periodo = NEW.periodo
       AND c.descartada_en IS NULL
       -- H-021-1-6: una fila excluida no cuenta ni confirma (decision del usuario, 2026-11-13).
       AND NOT v.excluida
       -- H-021-1-5: la version `historial` que aplico la regla tambien esta en el destino actual de la regla. Si la regla se
       -- edito despues, la fila que el contador movio a mano al destino nuevo es una clasificacion manual y no cuenta (P-1).
       AND CASE r.destino
             WHEN 'DG' THEN h.bi_dgng = 0 AND h.igv_dgng = 0 AND h.bi_dng = 0 AND h.igv_dng = 0
             WHEN 'DGNG' THEN h.bi_dg = 0 AND h.igv_dg = 0 AND h.bi_dng = 0 AND h.igv_dng = 0
             WHEN 'DNG' THEN h.bi_dg = 0 AND h.igv_dg = 0 AND h.bi_dgng = 0 AND h.igv_dgng = 0
             ELSE false
           END
       AND CASE r.destino
             WHEN 'DG' THEN v.bi_dgng = 0 AND v.igv_dgng = 0 AND v.bi_dng = 0 AND v.igv_dng = 0
             WHEN 'DGNG' THEN v.bi_dg = 0 AND v.igv_dg = 0 AND v.bi_dng = 0 AND v.igv_dng = 0
             WHEN 'DNG' THEN v.bi_dg = 0 AND v.igv_dg = 0 AND v.bi_dgng = 0 AND v.igv_dgng = 0
             ELSE false
           END
  ), nuevas AS (
    INSERT INTO public.regla_aceptacion (tenant_id, regla_aplicacion_id, regla_id, periodo)
    SELECT NEW.tenant_id, x.id, x.regla_id, x.periodo FROM candidatas x ORDER BY x.id
    ON CONFLICT (regla_aplicacion_id) DO NOTHING
    RETURNING regla_aceptacion.regla_aplicacion_id, regla_aceptacion.regla_id
  )
  INSERT INTO public.regla_confirmacion (tenant_id, regla_id, cliente_id, ruc_proveedor, destino, origen)
  SELECT NEW.tenant_id, r.id, r.cliente_id, r.doc_numero, r.destino, 'aceptada'
    FROM nuevas n JOIN public.regla_aprendida r ON r.tenant_id = NEW.tenant_id AND r.id = n.regla_id
   WHERE v_aportar AND r.doc_tipo = '6' AND r.doc_numero ~ '^20[0-9]{9}$'
   ORDER BY n.regla_aplicacion_id;
  PERFORM set_config('app.tenant_id', coalesce(v_previo, ''), true);
  RETURN NULL;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.regla_aceptar_periodo() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.regla_aceptar_periodo() FROM PUBLIC;
