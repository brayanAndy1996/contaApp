-- 0033b_compra_puntero_vigente (spec 014, H-014-6, D-7, D-12). Endurece el trigger `compra_identidad_inmutable` de 0032:
--   * `version_vigente` solo avanza (el nuevo valor es mayor que el anterior) y apunta a una versión que existe en
--     `compra_version` de ESA compra (no de otra): sin versión inexistente, sin retroceso silencioso (D-12: deshacer y rehacer
--     crean versión, no mueven el puntero hacia atrás).
--   * `descartada_en` solo se pone en una compra agregada a mano (D-7: las del SIRE no se descartan).
-- Vale también para el superusuario (es un trigger, no un grant). Es una migración aparte y no una edición de 0032 porque
-- drizzle solo aplica las migraciones nuevas: una base que ya tiene 0032 no vería el cambio. El nombre `0033b` evita el rango
-- 0034 en adelante, reservado a 012b y 015. CREATE OR REPLACE: repetirla no cambia nada.
CREATE OR REPLACE FUNCTION public.compra_identidad_inmutable() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.cliente_id IS DISTINCT FROM OLD.cliente_id
     OR NEW.periodo IS DISTINCT FROM OLD.periodo
     OR NEW.propuesta_id IS DISTINCT FROM OLD.propuesta_id
     OR NEW.clave IS DISTINCT FROM OLD.clave
     OR NEW.tipo_doc IS DISTINCT FROM OLD.tipo_doc
     OR NEW.serie IS DISTINCT FROM OLD.serie
     OR NEW.numero IS DISTINCT FROM OLD.numero
     OR NEW.doc_tipo IS DISTINCT FROM OLD.doc_tipo
     OR NEW.doc_numero IS DISTINCT FROM OLD.doc_numero
     OR NEW.razon_social IS DISTINCT FROM OLD.razon_social
     OR NEW.fecha IS DISTINCT FROM OLD.fecha
     OR NEW.moneda IS DISTINCT FROM OLD.moneda
     OR NEW.tipo_cambio IS DISTINCT FROM OLD.tipo_cambio
     OR NEW.origen IS DISTINCT FROM OLD.origen
     OR NEW.creada_en IS DISTINCT FROM OLD.creada_en THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'compra: la identidad de la fila no se modifica';
  END IF;
  IF OLD.descartada_en IS NOT NULL AND NEW.descartada_en IS DISTINCT FROM OLD.descartada_en THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'compra: una compra descartada no se reabre ni cambia de fecha';
  END IF;
  IF OLD.descartada_en IS NULL AND NEW.descartada_en IS NOT NULL AND OLD.origen IS DISTINCT FROM 'agregada' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'compra: solo se descarta una compra agregada a mano';
  END IF;
  IF NEW.version_vigente IS DISTINCT FROM OLD.version_vigente THEN
    IF NEW.version_vigente < OLD.version_vigente THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'compra: la version vigente no retrocede';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.compra_version v
       WHERE v.tenant_id = NEW.tenant_id AND v.compra_id = NEW.id AND v.n = NEW.version_vigente
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'compra: la version vigente debe existir en compra_version';
    END IF;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.compra_identidad_inmutable() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.compra_identidad_inmutable() FROM PUBLIC;
