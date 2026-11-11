-- 0044_auditoria_notificacion_ms (spec 017, cierre del defecto latente del cursor de paginacion). El cursor de la API viaja como
-- Date (milisegundos): un instante con microsegundos no se compara de forma exacta contra el cursor y la pagina repite o salta filas.
-- Los DEFAULT de 0041 y 0043 ya truncan a ms; este CHECK impide que cualquier escritor (superusuario incluido) guarde un valor con us.
--   auditoria.ocurrida_en y notificacion.creada_en: col = date_trunc('milliseconds', col). Sin RLS tocada ni grants nuevos.
-- Via elegida: ADD CONSTRAINT ... NOT VALID (rige para toda fila nueva o modificada, sin revisar las existentes).
--   Por que no truncar antes y validar: `auditoria` es inmutable por trigger (0041) y saltarse el trigger o desactivar RLS para
--   reescribir historia de auditoria no es una via legitima de migracion. En produccion no hay filas con us (los DEFAULT truncan
--   desde 0041/0043), asi que NOT VALID equivale a un CHECK validado alli. En la BD local solo hay unas pocas filas con us, creadas
--   por las pruebas antes de esta migracion: quedan sin revisar y siguen leyendose bien, porque el cursor solo importa para filas
--   nuevas. Nota: en notificacion, marcar como leida una de esas filas viejas falla el CHECK (se reevalua en cada UPDATE); solo
--   puede ocurrir con datos de prueba previos a 0044.
-- Idempotente: cada sentencia comprueba pg_constraint antes de agregar.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auditoria_ocurrida_en_ms' AND conrelid = 'public.auditoria'::regclass) THEN
    ALTER TABLE "auditoria" ADD CONSTRAINT "auditoria_ocurrida_en_ms" CHECK ("auditoria"."ocurrida_en" = date_trunc('milliseconds', "auditoria"."ocurrida_en")) NOT VALID;
  END IF;
END
$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notificacion_creada_en_ms' AND conrelid = 'public.notificacion'::regclass) THEN
    ALTER TABLE "notificacion" ADD CONSTRAINT "notificacion_creada_en_ms" CHECK ("notificacion"."creada_en" = date_trunc('milliseconds', "notificacion"."creada_en")) NOT VALID;
  END IF;
END
$$;
