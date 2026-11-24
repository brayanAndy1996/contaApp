-- 0068_prorrata_ronda2 (spec 026, T20: hallazgos de la ronda adversarial 2). Repetible (CREATE OR REPLACE; DROP/ADD CONSTRAINT,
-- ALTER/REVOKE/GRANT idempotentes). Sin bloques EXCEPTION ni SAVEPOINT en las funciones. Cambios:
--   H-026-2-5: el motivo del mes manual tampoco admite U+2028 (LINE SEPARATOR) ni U+2029 (PARAGRAPH SEPARATOR), que no son \p{Cc}:
--     - prorrata_mes_manual_guardar y prorrata_mes_manual_eliminar se reemplazan con la misma firma, dueño (contapp_migrator),
--       SECURITY DEFINER, search_path fijo, nombres calificados, SQLSTATE y mensajes fijos y los mismos REVOKE/GRANT de 0066; solo
--       cambia v_controles (las mismas clases que el CHECK, escritas con escapes, más U+2028 y U+2029): 22023 «entradas invalidas»;
--     - el CHECK prorrata_mes_manual_motivo_valido se vuelve a crear con U+2028 y U+2029 (23514). Se agrega NOT VALID (la tabla es
--       solo de inserción y una BD donde ya se guardó un motivo así no puede corregirlo) y se valida si ninguna fila lo incumple; NOT
--       VALID rige igual para toda fila nueva.
--   El resto de la ronda 2 (H-026-2-1 a H-026-2-4 y H-026-2-6) no cambia la BD.

-- ---- Guardar el mes manual (backend) ----------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prorrata_mes_manual_guardar(
  p_cliente uuid, p_periodo char(6), p_gravadas numeric, p_exportaciones numeric, p_no_gravadas numeric, p_motivo text,
  p_version integer
) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_uuid CONSTANT text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_controles CONSTANT text := '[\u0001-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]';
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
  v_controles CONSTANT text := '[\u0001-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]';
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

-- ---- CHECK del motivo (H-026-2-5) -------------------------------------------------------------------------------------------
ALTER TABLE public.prorrata_mes_manual DROP CONSTRAINT IF EXISTS prorrata_mes_manual_motivo_valido;--> statement-breakpoint
ALTER TABLE public.prorrata_mes_manual ADD CONSTRAINT prorrata_mes_manual_motivo_valido
  CHECK (char_length(motivo) BETWEEN 1 AND 500
         AND motivo !~ '[\u0001-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]') NOT VALID;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.prorrata_mes_manual m
     WHERE NOT (char_length(m.motivo) BETWEEN 1 AND 500
                AND m.motivo !~ '[\u0001-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]')
  ) THEN
    ALTER TABLE public.prorrata_mes_manual VALIDATE CONSTRAINT prorrata_mes_manual_motivo_valido;
  END IF;
END
$$;
