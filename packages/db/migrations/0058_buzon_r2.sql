-- 0058_buzon_r2 (spec 023, T21; hallazgos de la ronda adversarial 2). Sin tablas: todo es repetible (CREATE OR REPLACE). Las
-- dos funciones siguen SECURITY DEFINER de contapp_migrator, con search_path fijo y los mismos privilegios de 0055/0056 (CREATE
-- OR REPLACE conserva dueño y ACL; se repiten ALTER/REVOKE/GRANT para que la migración sea idempotente también en eso).
--   sistema.buzon_ciclo_tomar(dueño)          H-023-2-7 (D-5, CA-1): un candado VENCIDO (dueño que murió sin soltar) se toma en
--                                             cuanto vence, sin esperar el intervalo desde el inicio del ciclo muerto. Un ciclo
--                                             SOLTADO (ciclo_hasta NULL) sigue sin repetirse dentro de intervalo_min. Una sola
--                                             sentencia UPDATE ... RETURNING, como en 0055: el bloqueo de la fila serializa.
--   buzon_mensaje_aviso_obligatorio (trigger) H-023-2-9 (CA-6, D-7, «la BD lo exige»): además de exigir el aviso de un crítico
--                                             reciente o de un cliente sincronizado (0056), rechaza (42501) un mensaje con
--                                             categoría crítica o con motivo_critico y critico = false, sean cuales sean las
--                                             demás columnas: un worker no puede disfrazar un crítico de «no crítico» para no
--                                             avisarlo. Para todos los roles (también la siembra).

-- ---- Candado del ciclo ---------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sistema.buzon_ciclo_tomar(p_dueno text)
  RETURNS TABLE (ahora timestamptz, intervalo_min integer, reserva_interactiva integer, lote_estudio integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_ahora timestamptz := clock_timestamp();
BEGIN
  IF p_dueno IS NULL OR char_length(p_dueno) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'buzon_ciclo_tomar: dueno invalido';
  END IF;
  RETURN QUERY
    UPDATE public.buzon_programacion p
       SET ciclo_dueno = p_dueno,
           ciclo_hasta = v_ahora + interval '5 minutes',
           ultimo_ciclo_inicio = v_ahora
     WHERE p.id = 1
       AND (
             -- Ciclo muerto: su candado venció; se retoma ya (H-023-2-7).
             (p.ciclo_hasta IS NOT NULL AND p.ciclo_hasta < v_ahora)
             -- Sin ciclo vivo: uno nuevo solo cuando se cumple el intervalo desde el inicio del último.
          OR (p.ciclo_hasta IS NULL
              AND (p.ultimo_ciclo_inicio IS NULL
                   OR v_ahora - p.ultimo_ciclo_inicio >= make_interval(mins => p.intervalo_min)))
           )
    RETURNING v_ahora, p.intervalo_min, p.reserva_interactiva, p.lote_estudio;
END
$$;--> statement-breakpoint
ALTER FUNCTION sistema.buzon_ciclo_tomar(text) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION sistema.buzon_ciclo_tomar(text)
  FROM PUBLIC, contapp_backend, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION sistema.buzon_ciclo_tomar(text) TO contapp_worker;--> statement-breakpoint

-- ---- La BD exige el aviso, también ante un crítico disfrazado -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.buzon_mensaje_aviso_obligatorio() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_previo text;
  v_sincronizado boolean;
BEGIN
  IF NEW.critico IS NOT TRUE THEN
    -- Solo los valores válidos: uno inválido sigue saliendo por el CHECK de 0054 (23514).
    IF NEW.categoria IN ('coactiva', 'resolucion_determinacion', 'resolucion_multa', 'requerimiento_fiscalizacion')
       OR NEW.motivo_critico IN ('codigo', 'asunto', 'duda') THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'buzon_mensaje: una categoria critica o un motivo exigen critico';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.avisado IS NOT FALSE THEN
    RETURN NEW;
  END IF;
  IF NEW.fecha > clock_timestamp() - interval '30 days' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'buzon_mensaje: un critico reciente debe avisarse';
  END IF;
  v_previo := current_setting('app.tenant_id', true);
  PERFORM set_config('app.tenant_id', NEW.tenant_id::text, true);
  SELECT e.sincronizado_en IS NOT NULL INTO v_sincronizado
    FROM public.buzon_estado_cliente e
   WHERE e.tenant_id = NEW.tenant_id AND e.cliente_id = NEW.cliente_id;
  PERFORM set_config('app.tenant_id', coalesce(v_previo, ''), true);
  IF v_sincronizado THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'buzon_mensaje: un critico de un cliente sincronizado debe avisarse';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.buzon_mensaje_aviso_obligatorio() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.buzon_mensaje_aviso_obligatorio()
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;
