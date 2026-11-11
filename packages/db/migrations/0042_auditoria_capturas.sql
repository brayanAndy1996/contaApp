-- 0042_auditoria_capturas (custom, spec 017, D-3, D-4, D-5). Captura por triggers en la misma transaccion de la accion: si no se
-- puede auditar, la accion se revierte (falla cerrado, como 003 D3). Cada funcion de trigger es SECURITY DEFINER de
-- contapp_migrator (llama a auditoria_registrar, que la app no ejecuta), con search_path fijo y sin EXECUTE para PUBLIC. `datos`
-- es una lista blanca por accion (plan 017, tabla de captura): nunca cifrados, DEK, nonce, hashes, correos, XML ni montos.
--   compra.operacion es un constraint trigger DEFERRABLE INITIALLY DEFERRED sobre compra_operacion: al confirmar cuenta las compras
--   con versiones de esa operacion (deshacer y rehacer escriben sus versiones con su propio operacion_id; referenciaId = la tratada).
--   El origen de cliente.creado sale de app.origen_cliente ('importacion'; cualquier otro valor o vacio = 'manual').
--   La via de miembro.alta la decide interno.membresia_via: 'registro' si el estudio se creo en esta
--   transaccion, 'invitacion' si hay una invitacion vigente del estudio para el correo y el rol del usuario, si no 'otro'.
--   La rotacion de KEK (dek_envuelta, kek_id) no se audita. Repetible: CREATE OR REPLACE, DROP ... IF EXISTS, GRANT/REVOKE.

-- ---- Via de un alta de miembro --------------------------------------------------------------------------------------------
-- Dueño contapp_migrator (sin BYPASSRLS): fija app.tenant_id al estudio de la fila mientras lee (auth no lo fija) y lo devuelve a
-- su valor; si algo falla, la transaccion se revierte con el ajuste. No se ejecuta fuera de los triggers (sin EXECUTE a nadie).
CREATE OR REPLACE FUNCTION interno.membresia_via(p_tenant uuid, p_usuario uuid, p_rol text) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_previo text := current_setting('app.tenant_id', true);
  v_via text;
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM public.tenant t WHERE t.id = p_tenant AND t.xmin = pg_current_xact_id()::xid) THEN 'registro'
    WHEN EXISTS (
      SELECT 1 FROM public.invitacion i JOIN public.usuario u ON lower(u.email) = lower(i.correo)
       WHERE i.tenant_id = p_tenant AND u.id = p_usuario AND i.rol = p_rol
         AND i.aceptada_en IS NULL AND i.revocada_en IS NULL AND i.vence_en > now()
    ) THEN 'invitacion'
    ELSE 'otro'
  END INTO v_via;
  PERFORM set_config('app.tenant_id', coalesce(v_previo, ''), true);
  RETURN v_via;
END
$$;--> statement-breakpoint
ALTER FUNCTION interno.membresia_via(uuid, uuid, text) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION interno.membresia_via(uuid, uuid, text) FROM PUBLIC;--> statement-breakpoint

-- ---- sesion.ingreso (auth.sesion: alta con estudio o cambio a otro estudio no nulo) --------------------------------------
CREATE OR REPLACE FUNCTION public.auditoria_capturar_sesion() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM public.auditoria_registrar(NEW.tenant_activo, 'sesion.ingreso', NULL, 'sesion', NEW.id, '{}'::jsonb, NEW.usuario_id);
  RETURN NULL;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS auditoria_sesion_alta ON auth.sesion;--> statement-breakpoint
CREATE TRIGGER auditoria_sesion_alta AFTER INSERT ON auth.sesion
  FOR EACH ROW WHEN (NEW.tenant_activo IS NOT NULL) EXECUTE FUNCTION public.auditoria_capturar_sesion();--> statement-breakpoint
DROP TRIGGER IF EXISTS auditoria_sesion_estudio ON auth.sesion;--> statement-breakpoint
CREATE TRIGGER auditoria_sesion_estudio AFTER UPDATE OF tenant_activo ON auth.sesion
  FOR EACH ROW WHEN (NEW.tenant_activo IS NOT NULL AND NEW.tenant_activo IS DISTINCT FROM OLD.tenant_activo)
  EXECUTE FUNCTION public.auditoria_capturar_sesion();--> statement-breakpoint

-- ---- invitacion.creada / invitacion.revocada ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auditoria_capturar_invitacion() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.auditoria_registrar(NEW.tenant_id, 'invitacion.creada', NULL, 'invitacion', NEW.id,
      jsonb_build_object('rol', NEW.rol));
  ELSIF OLD.revocada_en IS NULL AND NEW.revocada_en IS NOT NULL THEN
    PERFORM public.auditoria_registrar(NEW.tenant_id, 'invitacion.revocada', NULL, 'invitacion', NEW.id, '{}'::jsonb);
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS auditoria_invitacion ON public.invitacion;--> statement-breakpoint
CREATE TRIGGER auditoria_invitacion AFTER INSERT OR UPDATE OF revocada_en ON public.invitacion
  FOR EACH ROW EXECUTE FUNCTION public.auditoria_capturar_invitacion();--> statement-breakpoint

-- ---- miembro.alta / rol_cambiado / desactivado / reactivado --------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auditoria_capturar_membresia() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_via text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_via := interno.membresia_via(NEW.tenant_id, NEW.usuario_id, NEW.rol);
    PERFORM public.auditoria_registrar(NEW.tenant_id, 'miembro.alta', NULL, 'membresia', NEW.id,
      jsonb_build_object('rol', NEW.rol, 'via', v_via),
      CASE WHEN v_via IN ('invitacion', 'registro') THEN NEW.usuario_id END);
    RETURN NULL;
  END IF;
  IF NEW.rol IS DISTINCT FROM OLD.rol THEN
    PERFORM public.auditoria_registrar(NEW.tenant_id, 'miembro.rol_cambiado', NULL, 'membresia', NEW.id,
      jsonb_build_object('de', OLD.rol, 'a', NEW.rol));
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
CREATE TRIGGER auditoria_membresia AFTER INSERT OR UPDATE OF rol, desactivada_en ON public.membresia
  FOR EACH ROW EXECUTE FUNCTION public.auditoria_capturar_membresia();--> statement-breakpoint

-- ---- asignacion.agregada / asignacion.quitada ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auditoria_capturar_asignacion() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.auditoria_registrar(NEW.tenant_id, 'asignacion.agregada', NEW.cliente_id, 'asignacion', NEW.id,
      jsonb_build_object('tipo', NEW.tipo, 'usuarioId', NEW.usuario_id));
  ELSE
    PERFORM public.auditoria_registrar(OLD.tenant_id, 'asignacion.quitada', OLD.cliente_id, 'asignacion', OLD.id,
      jsonb_build_object('tipo', OLD.tipo, 'usuarioId', OLD.usuario_id));
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS auditoria_asignacion ON public.asignacion;--> statement-breakpoint
CREATE TRIGGER auditoria_asignacion AFTER INSERT OR DELETE ON public.asignacion
  FOR EACH ROW EXECUTE FUNCTION public.auditoria_capturar_asignacion();--> statement-breakpoint

-- ---- cliente.creado / editado / archivado / reactivado ------------------------------------------------------------------
-- `cambios` solo con columnas de datos y de perfil fiscal (nunca ids ni marcas de tiempo), con [antes, despues].
CREATE OR REPLACE FUNCTION public.auditoria_capturar_cliente() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_viejo jsonb;
  v_nuevo jsonb;
  v_cambios jsonb := '{}'::jsonb;
  c text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.auditoria_registrar(NEW.tenant_id, 'cliente.creado', NEW.id, 'cliente', NEW.id,
      jsonb_build_object('origen',
        CASE WHEN current_setting('app.origen_cliente', true) = 'importacion' THEN 'importacion' ELSE 'manual' END));
    RETURN NULL;
  END IF;
  v_viejo := to_jsonb(OLD);
  v_nuevo := to_jsonb(NEW);
  FOREACH c IN ARRAY ARRAY['ruc', 'razon_social', 'estado_contribuyente', 'condicion_contribuyente', 'regimen', 'zona',
                           'ventas_exoneradas', 'ventas_mixtas', 'moneda_habitual'] LOOP
    IF (v_viejo -> c) IS DISTINCT FROM (v_nuevo -> c) THEN
      v_cambios := v_cambios || jsonb_build_object(c, jsonb_build_array(v_viejo -> c, v_nuevo -> c));
    END IF;
  END LOOP;
  IF v_cambios <> '{}'::jsonb THEN
    PERFORM public.auditoria_registrar(NEW.tenant_id, 'cliente.editado', NEW.id, 'cliente', NEW.id,
      jsonb_build_object('cambios', v_cambios));
  END IF;
  IF OLD.archivado_at IS NULL AND NEW.archivado_at IS NOT NULL THEN
    PERFORM public.auditoria_registrar(NEW.tenant_id, 'cliente.archivado', NEW.id, 'cliente', NEW.id, '{}'::jsonb);
  ELSIF OLD.archivado_at IS NOT NULL AND NEW.archivado_at IS NULL THEN
    PERFORM public.auditoria_registrar(NEW.tenant_id, 'cliente.reactivado', NEW.id, 'cliente', NEW.id, '{}'::jsonb);
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS auditoria_cliente ON public.cliente;--> statement-breakpoint
CREATE TRIGGER auditoria_cliente AFTER INSERT OR UPDATE ON public.cliente
  FOR EACH ROW EXECUTE FUNCTION public.auditoria_capturar_cliente();--> statement-breakpoint

-- ---- credencial.guardada / verificada / invalidada (solo tipo y motivo, D-5) --------------------------------------------
CREATE OR REPLACE FUNCTION public.auditoria_capturar_credencial() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.ciphertext IS DISTINCT FROM OLD.ciphertext THEN
    PERFORM public.auditoria_registrar(NEW.tenant_id, 'credencial.guardada', NEW.cliente_id, 'credencial', NEW.id,
      jsonb_build_object('tipo', NEW.tipo));
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.estado IS DISTINCT FROM OLD.estado THEN
    IF NEW.estado = 'verificada' THEN
      PERFORM public.auditoria_registrar(NEW.tenant_id, 'credencial.verificada', NEW.cliente_id, 'credencial', NEW.id,
        jsonb_build_object('tipo', NEW.tipo));
    ELSIF NEW.estado = 'invalida' THEN
      PERFORM public.auditoria_registrar(NEW.tenant_id, 'credencial.invalidada', NEW.cliente_id, 'credencial', NEW.id,
        jsonb_build_object('tipo', NEW.tipo, 'motivo', NEW.estado_motivo));
    END IF;
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS auditoria_credencial ON public.credencial;--> statement-breakpoint
CREATE TRIGGER auditoria_credencial AFTER INSERT OR UPDATE OF ciphertext, estado ON public.credencial
  FOR EACH ROW EXECUTE FUNCTION public.auditoria_capturar_credencial();--> statement-breakpoint

-- ---- propuesta.cargada ---------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auditoria_capturar_propuesta() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM public.auditoria_registrar(NEW.tenant_id, 'propuesta.cargada', NEW.cliente_id, 'propuesta', NEW.id,
    jsonb_build_object('libro', NEW.libro, 'periodo', NEW.periodo::text, 'fuente', NEW.fuente,
                       'filasRecibidas', NEW.filas_recibidas));
  RETURN NULL;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS auditoria_propuesta ON public.propuesta;--> statement-breakpoint
CREATE TRIGGER auditoria_propuesta AFTER INSERT ON public.propuesta
  FOR EACH ROW EXECUTE FUNCTION public.auditoria_capturar_propuesta();--> statement-breakpoint

-- ---- compra.operacion: una fila por operacion, al confirmar (D-4) ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auditoria_capturar_compra_operacion() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_filas bigint;
BEGIN
  SELECT count(DISTINCT v.compra_id) INTO v_filas FROM public.compra_version v
   WHERE v.tenant_id = NEW.tenant_id AND v.operacion_id = NEW.id;
  PERFORM public.auditoria_registrar(NEW.tenant_id, 'compra.operacion', NEW.cliente_id, 'compra_operacion', NEW.id,
    jsonb_build_object('tipo', NEW.tipo, 'periodo', NEW.periodo::text, 'filas', v_filas, 'referenciaId', NEW.referencia_id));
  RETURN NULL;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS auditoria_compra_operacion ON public.compra_operacion;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER auditoria_compra_operacion AFTER INSERT ON public.compra_operacion
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.auditoria_capturar_compra_operacion();--> statement-breakpoint

-- ---- venta.agregada (solo manual) / venta.excluida / venta.restaurada / venta.salto_justificado ---------------------------
CREATE OR REPLACE FUNCTION public.auditoria_capturar_venta() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_TABLE_NAME = 'venta' THEN
    PERFORM public.auditoria_registrar(NEW.tenant_id, 'venta.agregada', NEW.cliente_id, 'venta', NEW.id,
      jsonb_build_object('periodo', NEW.periodo::text));
  ELSIF TG_TABLE_NAME = 'venta_salto_justificado' THEN
    PERFORM public.auditoria_registrar(NEW.tenant_id, 'venta.salto_justificado', NEW.cliente_id, 'venta_salto_justificado',
      NEW.id, jsonb_build_object('periodo', NEW.periodo::text));
  ELSIF TG_OP = 'INSERT' THEN
    PERFORM public.auditoria_registrar(NEW.tenant_id, 'venta.excluida', NEW.cliente_id, 'venta_exclusion', NEW.id,
      jsonb_build_object('periodo', NEW.periodo::text));
  ELSE
    PERFORM public.auditoria_registrar(NEW.tenant_id, 'venta.restaurada', NEW.cliente_id, 'venta_exclusion', NEW.id,
      jsonb_build_object('periodo', NEW.periodo::text));
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS auditoria_venta ON public.venta;--> statement-breakpoint
CREATE TRIGGER auditoria_venta AFTER INSERT ON public.venta
  FOR EACH ROW WHEN (NEW.origen = 'manual') EXECUTE FUNCTION public.auditoria_capturar_venta();--> statement-breakpoint
DROP TRIGGER IF EXISTS auditoria_venta_exclusion ON public.venta_exclusion;--> statement-breakpoint
CREATE TRIGGER auditoria_venta_exclusion AFTER INSERT ON public.venta_exclusion
  FOR EACH ROW EXECUTE FUNCTION public.auditoria_capturar_venta();--> statement-breakpoint
DROP TRIGGER IF EXISTS auditoria_venta_restaurada ON public.venta_exclusion;--> statement-breakpoint
CREATE TRIGGER auditoria_venta_restaurada AFTER UPDATE OF restaurada_en ON public.venta_exclusion
  FOR EACH ROW WHEN (OLD.restaurada_en IS NULL AND NEW.restaurada_en IS NOT NULL)
  EXECUTE FUNCTION public.auditoria_capturar_venta();--> statement-breakpoint
DROP TRIGGER IF EXISTS auditoria_venta_salto ON public.venta_salto_justificado;--> statement-breakpoint
CREATE TRIGGER auditoria_venta_salto AFTER INSERT ON public.venta_salto_justificado
  FOR EACH ROW EXECUTE FUNCTION public.auditoria_capturar_venta();--> statement-breakpoint

-- ---- xml.subido (solo origen 'subido'; nunca el contenido) ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auditoria_capturar_xml() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM public.auditoria_registrar(NEW.tenant_id, 'xml.subido', NEW.cliente_id, 'documento_xml', NEW.id,
    jsonb_build_object('n', NEW.n));
  RETURN NULL;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS auditoria_xml ON public.documento_xml;--> statement-breakpoint
CREATE TRIGGER auditoria_xml AFTER INSERT ON public.documento_xml
  FOR EACH ROW WHEN (NEW.origen = 'subido') EXECUTE FUNCTION public.auditoria_capturar_xml();--> statement-breakpoint

-- ---- periodo.estado_cambiado (compras y ventas; las tablas de periodo no tienen id) -------------------------------------
CREATE OR REPLACE FUNCTION public.auditoria_capturar_periodo() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_de text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_de := OLD.estado;
  END IF;
  PERFORM public.auditoria_registrar(NEW.tenant_id, 'periodo.estado_cambiado', NEW.cliente_id, TG_TABLE_NAME::text, NULL,
    jsonb_build_object('libro', CASE TG_TABLE_NAME WHEN 'compra_periodo' THEN 'compras' ELSE 'ventas' END,
                       'periodo', NEW.periodo::text, 'de', v_de, 'a', NEW.estado));
  RETURN NULL;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS auditoria_compra_periodo_alta ON public.compra_periodo;--> statement-breakpoint
CREATE TRIGGER auditoria_compra_periodo_alta AFTER INSERT ON public.compra_periodo
  FOR EACH ROW EXECUTE FUNCTION public.auditoria_capturar_periodo();--> statement-breakpoint
DROP TRIGGER IF EXISTS auditoria_compra_periodo_estado ON public.compra_periodo;--> statement-breakpoint
CREATE TRIGGER auditoria_compra_periodo_estado AFTER UPDATE OF estado ON public.compra_periodo
  FOR EACH ROW WHEN (NEW.estado IS DISTINCT FROM OLD.estado) EXECUTE FUNCTION public.auditoria_capturar_periodo();--> statement-breakpoint
DROP TRIGGER IF EXISTS auditoria_venta_periodo_alta ON public.venta_periodo;--> statement-breakpoint
CREATE TRIGGER auditoria_venta_periodo_alta AFTER INSERT ON public.venta_periodo
  FOR EACH ROW EXECUTE FUNCTION public.auditoria_capturar_periodo();--> statement-breakpoint
DROP TRIGGER IF EXISTS auditoria_venta_periodo_estado ON public.venta_periodo;--> statement-breakpoint
CREATE TRIGGER auditoria_venta_periodo_estado AFTER UPDATE OF estado ON public.venta_periodo
  FOR EACH ROW WHEN (NEW.estado IS DISTINCT FROM OLD.estado) EXECUTE FUNCTION public.auditoria_capturar_periodo();--> statement-breakpoint

-- ---- archivo.generado (version y SHA-256 del ZIP en hex) -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auditoria_capturar_archivo() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM public.auditoria_registrar(NEW.tenant_id, 'archivo.generado', NEW.cliente_id, 'archivo_generado', NEW.id,
    jsonb_build_object('libro', NEW.libro, 'periodo', NEW.periodo::text, 'version', NEW.version,
                       'sha256Zip', encode(NEW.sha256_zip, 'hex')));
  RETURN NULL;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS auditoria_archivo ON public.archivo_generado;--> statement-breakpoint
CREATE TRIGGER auditoria_archivo AFTER INSERT ON public.archivo_generado
  FOR EACH ROW EXECUTE FUNCTION public.auditoria_capturar_archivo();--> statement-breakpoint

-- ---- Dueño y EXECUTE de las funciones de captura ------------------------------------------------------------------------
DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['auditoria_capturar_sesion', 'auditoria_capturar_invitacion', 'auditoria_capturar_membresia',
                           'auditoria_capturar_asignacion', 'auditoria_capturar_cliente', 'auditoria_capturar_credencial',
                           'auditoria_capturar_propuesta', 'auditoria_capturar_compra_operacion', 'auditoria_capturar_venta',
                           'auditoria_capturar_xml', 'auditoria_capturar_periodo', 'auditoria_capturar_archivo'] LOOP
    EXECUTE format('ALTER FUNCTION public.%I() OWNER TO contapp_migrator', f);
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I() FROM PUBLIC', f);
  END LOOP;
END
$$;
