-- 0020_auth_purgar_corte (custom, spec 008, T14, H-008-1b-7). `auth.purgar` validaba "retención ≥ 1 día" comparando
-- intervalos (un mes = 30 días) pero cortaba con aritmética de calendario (now() - retención): '-12 mon 361 days'
-- pasaba la validación y dejaba el corte en el futuro, borrando sesiones vigentes. Ahora se valida el CORTE que se va a
-- usar: cada `now() - retención` debe quedar al menos 1 día en el pasado (si no, 22023 sin borrar nada). Mismo cuerpo,
-- firma, dueño y grants que 0018 (no se edita 0018). Repetible: CREATE OR REPLACE, ALTER OWNER y GRANT/REVOKE.
CREATE OR REPLACE FUNCTION auth.purgar(
  retencion_sesion interval,
  retencion_token interval,
  retencion_intento interval,
  retencion_limite interval
) RETURNS TABLE (sesiones integer, tokens integer, intentos integer, limites integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_ahora timestamptz := now();
  v_limite timestamptz := now() - interval '1 day';
BEGIN
  IF retencion_sesion IS NULL OR retencion_token IS NULL OR retencion_intento IS NULL OR retencion_limite IS NULL
     OR retencion_sesion < interval '1 day' OR retencion_token < interval '1 day'
     OR retencion_intento < interval '1 day' OR retencion_limite < interval '1 day'
     OR v_ahora - retencion_sesion > v_limite OR v_ahora - retencion_token > v_limite
     OR v_ahora - retencion_intento > v_limite OR v_ahora - retencion_limite > v_limite THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'retencion invalida: minimo 1 dia';
  END IF;

  DELETE FROM auth.sesion x
   WHERE (x.revocada_en IS NOT NULL AND x.revocada_en < v_ahora - retencion_sesion)
      OR x.expira_absoluta < v_ahora - retencion_sesion;
  GET DIAGNOSTICS sesiones = ROW_COUNT;

  DELETE FROM auth.token_recuperacion x
   WHERE (x.usado_en IS NOT NULL AND x.usado_en < v_ahora - retencion_token)
      OR (x.invalidado_en IS NOT NULL AND x.invalidado_en < v_ahora - retencion_token)
      OR x.expira_en < v_ahora - retencion_token;
  GET DIAGNOSTICS tokens = ROW_COUNT;

  DELETE FROM auth.intento_login x
   WHERE x.ventana_inicio < v_ahora - retencion_intento
     AND (x.bloqueado_hasta IS NULL OR x.bloqueado_hasta <= v_ahora);
  GET DIAGNOSTICS intentos = ROW_COUNT;

  DELETE FROM auth.limite_tasa x
   WHERE x.ventana_inicio < v_ahora - retencion_limite;
  GET DIAGNOSTICS limites = ROW_COUNT;

  RETURN NEXT;
END
$$;--> statement-breakpoint
ALTER FUNCTION auth.purgar(interval, interval, interval, interval) OWNER TO contapp_auth;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth.purgar(interval, interval, interval, interval)
  FROM PUBLIC, contapp_backend, contapp_platform, contapp_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth.purgar(interval, interval, interval, interval) TO contapp_worker;
