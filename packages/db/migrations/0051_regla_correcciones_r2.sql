-- 0051_regla_correcciones_r2 (spec 021, T21). Correcciones de la ronda adversarial 2. Solo CREATE OR REPLACE con la misma firma,
-- dueno y grants (el trigger de 0049 sigue apuntando a la funcion): repetible.
--   regla_aceptar_periodo  ademas de lo de 0050, una aplicacion cuenta como aceptada (y deja la confirmacion `aceptada`) solo si
--                     la version vigente tiene base gravada (H-021-2-1). Una fila restaurada con deshacer a los montos de la
--                     version `historial` (H-021-2-2) esta en el destino de la regla y cuenta, como cualquier vigente en el
--                     destino (P-4).
-- Las demas correcciones de la ronda 2 no tocan la BD: H-021-2-2 y H-021-2-3 son lecturas (packages/db/src/compras/lectura.ts)
-- y H-021-2-4 es del dominio (planificarHistorial).
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
       -- H-021-2-1: la vigente tiene base gravada (los BI no suman 0). Una fila que el contador dejo sin base en ningun destino
       -- (todo a no gravado, exonerado...) no esta en el destino de la regla: no cuenta ni confirma (decision del usuario).
       AND (v.bi_dg + v.bi_dgng + v.bi_dng) <> 0
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
