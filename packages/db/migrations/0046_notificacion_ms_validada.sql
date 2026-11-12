-- 0046_notificacion_ms_validada (spec 020, DT-8: 0044 dejo `notificacion_creada_en_ms` como NOT VALID; aqui se valida).
-- Por que se pudo dejar NOT VALID en 0044 y por que ahora se valida: en produccion no hay filas con microsegundos (el DEFAULT de 0043
-- ya trunca a ms), pero un CHECK NOT VALID se reevalua en cada UPDATE y deja pasar lecturas/estadisticas sin garantia. Si queda
-- alguna fila con us (datos de prueba previos a 0044), se trunca y se valida; si no hay ninguna, solo se valida.
-- Seguridad del UPDATE de datos:
--   * RLS NO se desactiva ni se cambia: `notificacion` conserva FORCE ROW LEVEL SECURITY (0043). Esta migracion corre con
--     MIGRATIONS_DATABASE_URL (superusuario con BYPASSRLS, ver cli/migrar.ts), igual que el resto de migraciones: ninguna
--     politica se evalua ni se toca. Si el rol no la saltara, el UPDATE afectaria 0 filas y VALIDATE CONSTRAINT fallaria
--     (falla cerrado, nunca silencioso).
--   * El trigger `notificacion_solo_leida` (0043) rechaza cambiar `creada_en`. Se deshabilita SOLO ese trigger, por nombre
--     (nunca ALL ni USER), y solo si hay filas que corregir; se rehabilita en el mismo bloque.
--   * Un unico bloque DO es una sola sentencia: atomica aunque el migrador no abra transaccion, asi el trigger no puede quedar
--     deshabilitado a medias. Idempotente: segunda ejecucion = sin filas, trigger intacto, VALIDATE sobre algo ya valido.
-- `auditoria_ocurrida_en_ms` sigue NOT VALID, como explica 0044 (auditoria es inmutable por trigger; no se reescribe su historia).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.notificacion
    WHERE creada_en <> date_trunc('milliseconds', creada_en)
  ) THEN
    ALTER TABLE public.notificacion DISABLE TRIGGER notificacion_solo_leida;
    UPDATE public.notificacion
       SET creada_en = date_trunc('milliseconds', creada_en)
     WHERE creada_en <> date_trunc('milliseconds', creada_en);
    ALTER TABLE public.notificacion ENABLE TRIGGER notificacion_solo_leida;
  END IF;
  ALTER TABLE public.notificacion VALIDATE CONSTRAINT notificacion_creada_en_ms;
END
$$;
