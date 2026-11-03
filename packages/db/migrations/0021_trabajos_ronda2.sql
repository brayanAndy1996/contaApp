-- 0021_trabajos_ronda2 (custom, spec 008, T16, H-008-2a-4 / H-008-2b-8). El trigger que reinicia el estado de la
-- credencial al reemplazar el sobre fechaba `estado_at` con now() (INICIO de la transacción del guardado): un guardado
-- que empezó antes del despacho y escribió durante el trabajo quedaba con `estado_at <= iniciado_en`, y el
-- ErrorCredencial del intento viejo marcaba `invalida` la credencial nueva (CA-9). Ahora usa clock_timestamp(): la hora
-- en que la fila cambia. (El ejecutor, además, compara la versión de la fila que vio al empezar; ver
-- `packages/db/src/credenciales/estado.ts`.) Mismo cuerpo, firma, atributos, dueño y grants que 0018 (no se edita
-- 0018; no toca funciones de 0008). Repetible: CREATE OR REPLACE, ALTER OWNER y REVOKE.
CREATE OR REPLACE FUNCTION public.credencial_reinicia_estado() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.estado := 'configurada';
  NEW.estado_motivo := NULL;
  NEW.estado_at := clock_timestamp();
  RETURN NEW;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.credencial_reinicia_estado() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.credencial_reinicia_estado() FROM PUBLIC;
