-- 0077_correo_t22a (spec 028, T22a: D-1 de la prueba manual T22; decisión U-19: un estudio sin plan no recibe nada). Repetible
-- (CREATE OR REPLACE, REVOKE/GRANT). Conserva firma, dueño, SECURITY DEFINER, search_path = pg_catalog, pg_temp y EXECUTE solo para
-- contapp_worker de 0074; sin EXCEPTION ni SAVEPOINT. Sin funciones ni tablas nuevas (escalada.adv.spec.ts y catalogo.spec.ts no cambian).
--   D-1  sistema.estudios_correo: un envío de avisos registrado con plan que vence cuando el estudio ya no tiene suscripción activa ni
--        prueba vigente, o su plan apaga `correo_avisos`, quedaba `pendiente` (el ciclo no lo encolaba) y salía junto con los demás al
--        volver el plan. Ahora, al recorrer los estudios, los envíos de aviso `pendiente`, sin tomar y vencidos de esos estudios se
--        cierran `omitido` `sin_plan` (lo mismo que haría su trabajo al tomarlos, R-12), salvo los que ya tienen un trabajo
--        `notificacion.enviar` vivo (ese trabajo los cierra al tomarlos). Lo que aún no vence queda: se decide cuando venza. Los avisos
--        diferidos por el tope no cambian (H-028-1-4). Solo el worker ejecuta la función: el backend sigue sin escribir envíos.

-- ---- D-1: estudios_correo cierra los avisos vencidos de los estudios sin plan para avisos (estudios_correo de 0074) --------------
CREATE OR REPLACE FUNCTION sistema.estudios_correo() RETURNS TABLE (tenant_id uuid, avisos boolean, resumen boolean)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_previo text := pg_catalog.current_setting('app.tenant_id', true);
  v_estudio uuid;
  v_features jsonb;
  v_vigente boolean;
  v_avisos boolean;
BEGIN
  FOR v_estudio IN SELECT e.e FROM sistema.estudios_ids() AS e(e) LOOP
    PERFORM pg_catalog.set_config('app.tenant_id', v_estudio::text, true);
    SELECT p.features INTO v_features
      FROM public.suscripcion s JOIN public.plan p ON p.id = s.plan_id
     WHERE s.tenant_id = v_estudio
       AND (s.estado = 'activa' OR (s.estado = 'prueba' AND s.prueba_vence_en > pg_catalog.clock_timestamp()));
    v_vigente := FOUND;
    v_avisos := v_vigente AND (v_features -> 'correo_avisos') IS DISTINCT FROM 'false'::jsonb;
    IF NOT v_avisos THEN
      UPDATE public.correo_envio x SET estado = 'omitido', motivo = 'sin_plan'
       WHERE x.tenant_id = v_estudio AND x.origen = 'aviso' AND x.estado = 'pendiente' AND x.tomado_en IS NULL
         AND x.programado_para <= pg_catalog.clock_timestamp()
         AND NOT EXISTS (
           SELECT 1 FROM public.job_registro j
            WHERE j.tenant_id = v_estudio AND j.estado IN ('en_cola', 'ejecutando')
              AND j.clave_dedupe = pg_catalog.sha256(pg_catalog.convert_to(
                    '["notificacion.enviar",null,' || pg_catalog.jsonb_build_object('envioId', x.id)::text || ']', 'UTF8')));
    END IF;
    IF v_vigente THEN
      tenant_id := v_estudio;
      avisos := v_avisos;
      resumen := (v_features -> 'correo_resumen') IS DISTINCT FROM 'false'::jsonb;
      RETURN NEXT;
    END IF;
  END LOOP;
  PERFORM pg_catalog.set_config('app.tenant_id', coalesce(v_previo, ''), true);
END
$$;--> statement-breakpoint

-- ---- Dueño, EXECUTE y nada para PUBLIC (como en 0074) ----------------------------------------------------------------------------
ALTER FUNCTION sistema.estudios_correo() OWNER TO contapp_migrator;--> statement-breakpoint

REVOKE ALL ON FUNCTION sistema.estudios_correo()
  FROM PUBLIC, contapp_backend, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint

GRANT EXECUTE ON FUNCTION sistema.estudios_correo() TO contapp_worker;
