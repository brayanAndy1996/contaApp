-- 0083_roles_propios_auditoria (custom, spec 030, T8). Auditoría de membresía con roles propios (017 + 030 D2).
-- La captura de 0045 solo miraba la columna `rol`: pasar a un miembro de un rol propio a OTRO rol propio (rol = 'propio' en ambos, cambia
-- `rol_id`) no dejaba `miembro.rol_cambiado`. Ahora:
--   * miembro.rol_cambiado también cuando cambia `rol_id`; `datos` = {de, a} de siempre más `deRolId`/`aRolId` solo si el rol es propio
--     (los de sistema quedan exactamente como en 017).
--   * miembro.alta lleva `rolId` solo con un rol propio.
--   * el disparador también se dispara con UPDATE OF rol_id.
-- CREATE OR REPLACE conserva dueño, SECURITY DEFINER, search_path fijo y privilegios de 0042/0045; sin grants nuevos. Repetible.
CREATE OR REPLACE FUNCTION public.auditoria_capturar_membresia() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_via text;
  v_datos jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_via := interno.membresia_via(NEW.tenant_id, NEW.usuario_id, NEW.rol);
    v_datos := jsonb_build_object('rol', NEW.rol, 'via', v_via);
    IF NEW.rol_id IS NOT NULL THEN
      v_datos := v_datos || jsonb_build_object('rolId', NEW.rol_id);
    END IF;
    PERFORM public.auditoria_registrar(NEW.tenant_id, 'miembro.alta', NULL, 'membresia', NEW.id, v_datos,
      CASE WHEN v_via IN ('invitacion', 'registro') THEN NEW.usuario_id END);
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    PERFORM public.auditoria_registrar(OLD.tenant_id, 'miembro.eliminado', NULL, 'membresia', OLD.id,
      jsonb_build_object('rol', OLD.rol));
    RETURN NULL;
  END IF;
  IF NEW.rol IS DISTINCT FROM OLD.rol OR NEW.rol_id IS DISTINCT FROM OLD.rol_id THEN
    v_datos := jsonb_build_object('de', OLD.rol, 'a', NEW.rol);
    IF OLD.rol_id IS NOT NULL THEN
      v_datos := v_datos || jsonb_build_object('deRolId', OLD.rol_id);
    END IF;
    IF NEW.rol_id IS NOT NULL THEN
      v_datos := v_datos || jsonb_build_object('aRolId', NEW.rol_id);
    END IF;
    PERFORM public.auditoria_registrar(NEW.tenant_id, 'miembro.rol_cambiado', NULL, 'membresia', NEW.id, v_datos);
  END IF;
  IF OLD.desactivada_en IS NULL AND NEW.desactivada_en IS NOT NULL THEN
    PERFORM public.auditoria_registrar(NEW.tenant_id, 'miembro.desactivado', NULL, 'membresia', NEW.id, '{}'::jsonb);
  ELSIF OLD.desactivada_en IS NOT NULL AND NEW.desactivada_en IS NULL THEN
    PERFORM public.auditoria_registrar(NEW.tenant_id, 'miembro.reactivado', NULL, 'membresia', NEW.id, '{}'::jsonb);
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS auditoria_membresia ON public.membresia;--> statement-breakpoint
CREATE TRIGGER auditoria_membresia AFTER INSERT OR UPDATE OF rol, rol_id, desactivada_en ON public.membresia
  FOR EACH ROW EXECUTE FUNCTION public.auditoria_capturar_membresia();
