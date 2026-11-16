-- 0053_compra_version_operacion_parcial (spec 022, RP-2: defecto intermitente de CA-7, CI run 43948801592). Parte generada por drizzle-kit.
--   compra_version_operacion_idx pasa a parcial (operacion_id IS NOT NULL). Sus usos (deshacer/rehacer, auditoría, la FK hacia
--   compra_operacion) filtran siempre `operacion_id = …`, que implica la condición, así que lo siguen usando. Lo que deja de poder
--   usarlo es la búsqueda de la versión de cada compra (lateral de leerExistentesCompras y de filas-reemplazo): con estadísticas
--   que estiman 1 fila por estudio (ANALYZE que vio la tabla sin filas vivas y una descarga grande después) el planificador
--   empataba este índice con la única (tenant_id, compra_id, n) y lo elegía, trayendo todas las versiones del estudio en cada
--   vuelta del nested loop (20.000 compras: ~30 s). Sin él, la única es el solo acceso razonable con o sin estadísticas.
-- Repetible: DROP INDEX IF EXISTS antes de crearlo.
DROP INDEX IF EXISTS "compra_version_operacion_idx";--> statement-breakpoint
CREATE INDEX "compra_version_operacion_idx" ON "compra_version" USING btree ("tenant_id","operacion_id") WHERE "compra_version"."operacion_id" is not null;
