-- 0045_auditoria_ronda_r1 (spec 017, T17: hallazgos de la ronda adversarial R1; contrato en tasks.md, «Resultado» de T16).
-- Sin grants nuevos ni cambiados (decision del usuario: auditar con triggers) y sin funciones nuevas: CREATE OR REPLACE de las
-- capturas de 0042 y de las funciones de aviso de 0043, que conservan dueño, search_path fijo y REVOKE de PUBLIC.
--   Catalogo: 4 acciones nuevas en el CHECK (31 en total; parte generada por drizzle-kit).
--   H-017-1   asignacion UPDATE: cambia `tipo` -> asignacion.tipo_cambiado {de, a, usuarioId}; cambia la clave (usuario_id,
--             cliente_id o tenant_id) -> asignacion.quitada (fila vieja) + asignacion.agregada (fila nueva); nada mas, sin fila.
--             Cubre el UPDATE directo, el INSERT ... ON CONFLICT DO UPDATE de asignar/asignarPorUsuario y cambiarRol (D18).
--   H-017-2   membresia DELETE -> miembro.eliminado {rol}; cliente DELETE -> cliente.eliminado {}; invitacion UPDATE de correo,
--             rol o vence_en -> invitacion.modificada {campos (orden alfabetico), de?, a?} (de/a solo si cambio el rol; nunca el
--             correo ni la fecha, D-5). DELETE de membresia y de cliente recalculan plan_aviso (plan_aviso_disparar).
--   H-017-3   notificaciones_de_esta_transaccion() solo devuelve filas que inserto la transaccion en curso (o una de sus
--             subtransacciones): ademas del id en app.notificaciones_tx exige que el xmin de la fila siga «en curso». Una fila
--             visible con xmin en curso solo puede ser propia (las de otra transaccion en curso no se ven).
--   P-5       plan_aviso_recalcular omite al Dueño que ya tiene un plan_limite del mismo recurso y umbral con
--             notificacion.creada_en de hace menos de 24 h; el estado (alcanzado, ciclo) sigue su curso.
-- Mismo actor y mismo falla-cerrado que 0042 (todo pasa por auditoria_registrar). Lo que sigue al CHECK es repetible.
ALTER TABLE "auditoria" DROP CONSTRAINT "auditoria_accion_valida";--> statement-breakpoint
ALTER TABLE "auditoria" ADD CONSTRAINT "auditoria_accion_valida" CHECK ("auditoria"."accion" IN ('sesion.ingreso', 'invitacion.creada', 'invitacion.revocada', 'invitacion.modificada', 'miembro.alta', 'miembro.rol_cambiado', 'miembro.desactivado', 'miembro.reactivado', 'miembro.eliminado', 'asignacion.agregada', 'asignacion.quitada', 'asignacion.tipo_cambiado', 'cliente.creado', 'cliente.editado', 'cliente.archivado', 'cliente.reactivado', 'cliente.eliminado', 'credencial.guardada', 'credencial.verificada', 'credencial.invalidada', 'credencial.descifrada', 'propuesta.cargada', 'compra.operacion', 'venta.agregada', 'venta.excluida', 'venta.restaurada', 'venta.salto_justificado', 'xml.subido', 'periodo.estado_cambiado', 'archivo.generado', 'sunat.envio'));--> statement-breakpoint

-- ---- invitacion.creada / revocada / modificada ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auditoria_capturar_invitacion() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_campos text[] := '{}'::text[];
  v_datos jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.auditoria_registrar(NEW.tenant_id, 'invitacion.creada', NULL, 'invitacion', NEW.id,
      jsonb_build_object('rol', NEW.rol));
    RETURN NULL;
  END IF;
  IF OLD.revocada_en IS NULL AND NEW.revocada_en IS NOT NULL THEN
    PERFORM public.auditoria_registrar(NEW.tenant_id, 'invitacion.revocada', NULL, 'invitacion', NEW.id, '{}'::jsonb);
  END IF;
  -- Solo los nombres de las columnas cambiadas (orden alfabetico): ni el correo ni la fecha (D-5).
  IF NEW.correo IS DISTINCT FROM OLD.correo THEN
    v_campos := v_campos || 'correo'::text;
  END IF;
  IF NEW.rol IS DISTINCT FROM OLD.rol THEN
    v_campos := v_campos || 'rol'::text;
  END IF;
  IF NEW.vence_en IS DISTINCT FROM OLD.vence_en THEN
    v_campos := v_campos || 'vence_en'::text;
  END IF;
  IF cardinality(v_campos) > 0 THEN
    v_datos := jsonb_build_object('campos', to_jsonb(v_campos));
    IF NEW.rol IS DISTINCT FROM OLD.rol THEN
      v_datos := v_datos || jsonb_build_object('de', OLD.rol, 'a', NEW.rol);
    END IF;
    PERFORM public.auditoria_registrar(NEW.tenant_id, 'invitacion.modificada', NULL, 'invitacion', NEW.id, v_datos);
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS auditoria_invitacion ON public.invitacion;--> statement-breakpoint
CREATE TRIGGER auditoria_invitacion AFTER INSERT OR UPDATE OF revocada_en, correo, rol, vence_en ON public.invitacion
  FOR EACH ROW EXECUTE FUNCTION public.auditoria_capturar_invitacion();--> statement-breakpoint

-- ---- miembro.alta / rol_cambiado / desactivado / reactivado / eliminado ---------------------------------------------------
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
  IF TG_OP = 'DELETE' THEN
    PERFORM public.auditoria_registrar(OLD.tenant_id, 'miembro.eliminado', NULL, 'membresia', OLD.id,
      jsonb_build_object('rol', OLD.rol));
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
DROP TRIGGER IF EXISTS auditoria_membresia_baja ON public.membresia;--> statement-breakpoint
CREATE TRIGGER auditoria_membresia_baja AFTER DELETE ON public.membresia
  FOR EACH ROW EXECUTE FUNCTION public.auditoria_capturar_membresia();--> statement-breakpoint

-- ---- asignacion.agregada / quitada / tipo_cambiado ------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auditoria_capturar_asignacion() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.tenant_id, NEW.cliente_id, NEW.usuario_id) IS NOT DISTINCT FROM
                          (OLD.tenant_id, OLD.cliente_id, OLD.usuario_id) THEN
    IF NEW.tipo IS DISTINCT FROM OLD.tipo THEN
      PERFORM public.auditoria_registrar(NEW.tenant_id, 'asignacion.tipo_cambiado', NEW.cliente_id, 'asignacion', NEW.id,
        jsonb_build_object('de', OLD.tipo, 'a', NEW.tipo, 'usuarioId', NEW.usuario_id));
    END IF;
    RETURN NULL;
  END IF;
  -- DELETE, o UPDATE que cambia de usuario o de cliente: la asignacion vieja se quita.
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    PERFORM public.auditoria_registrar(OLD.tenant_id, 'asignacion.quitada', OLD.cliente_id, 'asignacion', OLD.id,
      jsonb_build_object('tipo', OLD.tipo, 'usuarioId', OLD.usuario_id));
  END IF;
  -- INSERT, o UPDATE que cambia de usuario o de cliente: la asignacion nueva se agrega.
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM public.auditoria_registrar(NEW.tenant_id, 'asignacion.agregada', NEW.cliente_id, 'asignacion', NEW.id,
      jsonb_build_object('tipo', NEW.tipo, 'usuarioId', NEW.usuario_id));
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS auditoria_asignacion_cambio ON public.asignacion;--> statement-breakpoint
CREATE TRIGGER auditoria_asignacion_cambio AFTER UPDATE ON public.asignacion
  FOR EACH ROW WHEN ((NEW.tenant_id, NEW.cliente_id, NEW.usuario_id, NEW.tipo) IS DISTINCT FROM
                     (OLD.tenant_id, OLD.cliente_id, OLD.usuario_id, OLD.tipo))
  EXECUTE FUNCTION public.auditoria_capturar_asignacion();--> statement-breakpoint

-- ---- cliente.creado / editado / archivado / reactivado / eliminado ---------------------------------------------------------
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
  IF TG_OP = 'DELETE' THEN
    PERFORM public.auditoria_registrar(OLD.tenant_id, 'cliente.eliminado', OLD.id, 'cliente', OLD.id, '{}'::jsonb);
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
DROP TRIGGER IF EXISTS auditoria_cliente_baja ON public.cliente;--> statement-breakpoint
CREATE TRIGGER auditoria_cliente_baja AFTER DELETE ON public.cliente
  FOR EACH ROW EXECUTE FUNCTION public.auditoria_capturar_cliente();--> statement-breakpoint

-- ---- P-5 · el mismo aviso de limite, una vez por dia por Dueño, recurso y umbral -----------------------------------------
CREATE OR REPLACE FUNCTION public.plan_aviso_recalcular(p_tenant uuid) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  u record;
  r record;
  v_usado bigint;
  v_limite bigint;
  v_alcanza boolean;
  v_destino uuid[];
BEGIN
  IF p_tenant IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.plan_aviso a WHERE a.tenant_id = p_tenant) THEN
    IF NOT EXISTS (SELECT 1 FROM interno.uso_plan(p_tenant)) THEN
      RETURN; -- estudio sin suscripcion: sin plan no hay limite
    END IF;
    INSERT INTO public.plan_aviso (tenant_id, recurso, umbral)
    VALUES (p_tenant, 'rucs', 90), (p_tenant, 'rucs', 100), (p_tenant, 'usuarios', 90), (p_tenant, 'usuarios', 100)
    ON CONFLICT DO NOTHING;
  END IF;
  -- Serializa con otras transacciones del mismo estudio; el uso de abajo (nueva instantanea) ya ve lo que confirmaron.
  PERFORM 1 FROM public.plan_aviso a WHERE a.tenant_id = p_tenant ORDER BY a.recurso, a.umbral FOR UPDATE;
  SELECT * INTO u FROM interno.uso_plan(p_tenant);
  IF NOT FOUND THEN
    RETURN;
  END IF;
  FOR r IN SELECT a.recurso, a.umbral, a.alcanzado, a.ciclo FROM public.plan_aviso a
            WHERE a.tenant_id = p_tenant ORDER BY a.recurso, a.umbral LOOP
    IF r.recurso = 'rucs' THEN
      v_usado := u.rucs;
      v_limite := u.limite_rucs;
    ELSE
      v_usado := u.usuarios;
      v_limite := u.limite_usuarios;
    END IF;
    v_alcanza := v_limite IS NOT NULL AND v_limite > 0 AND v_usado * 100 >= r.umbral::bigint * v_limite;
    IF v_alcanza AND NOT r.alcanzado THEN
      UPDATE public.plan_aviso a SET alcanzado = true, ciclo = r.ciclo + 1
       WHERE a.tenant_id = p_tenant AND a.recurso = r.recurso AND a.umbral = r.umbral;
      -- Una vez por dia: fuera el Dueño con un aviso del mismo recurso y umbral de hace menos de 24 h (sobre `notificacion`).
      SELECT array_agg(d) INTO v_destino FROM unnest(u.duenos) AS d
       WHERE NOT EXISTS (SELECT 1 FROM public.notificacion n
                          WHERE n.tenant_id = p_tenant AND n.usuario_id = d AND n.tipo = 'plan_limite'
                            AND n.params ->> 'recurso' = r.recurso AND n.params ->> 'umbral' = r.umbral::text
                            AND n.creada_en > now() - interval '24 hours');
      PERFORM interno.notificar(p_tenant, v_destino, 'plan_limite', NULL, NULL,
        jsonb_build_object('recurso', r.recurso, 'umbral', r.umbral, 'usado', v_usado, 'limite', v_limite),
        'plan_limite:' || r.recurso || ':' || r.umbral::text || ':' || (r.ciclo + 1)::text);
    ELSIF NOT v_alcanza AND r.alcanzado THEN
      UPDATE public.plan_aviso a SET alcanzado = false
       WHERE a.tenant_id = p_tenant AND a.recurso = r.recurso AND a.umbral = r.umbral;
    END IF;
  END LOOP;
END
$$;--> statement-breakpoint

-- ---- DELETE de cliente y de membresia tambien recalculan plan_aviso (H-017-2) ----------------------------------------------
CREATE OR REPLACE FUNCTION public.plan_aviso_disparar() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  t uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    FOR t IN SELECT DISTINCT n.tenant_id FROM nuevas n ORDER BY 1 LOOP
      PERFORM public.plan_aviso_recalcular(t);
    END LOOP;
  ELSIF TG_OP = 'DELETE' THEN
    -- Solo si la fila borrada contaba en el uso (cliente no archivado, membresia activa).
    FOR t IN SELECT DISTINCT o.tenant_id FROM viejas o
              WHERE CASE TG_TABLE_NAME WHEN 'cliente' THEN (to_jsonb(o) ->> 'archivado_at') IS NULL
                                       WHEN 'membresia' THEN (to_jsonb(o) ->> 'desactivada_en') IS NULL
                                       ELSE true END
              ORDER BY 1 LOOP
      PERFORM public.plan_aviso_recalcular(t);
    END LOOP;
  ELSIF TG_TABLE_NAME = 'cliente' THEN
    FOR t IN SELECT DISTINCT n.tenant_id FROM nuevas n JOIN viejas o ON o.id = n.id
              WHERE (o.archivado_at IS NULL) IS DISTINCT FROM (n.archivado_at IS NULL) ORDER BY 1 LOOP
      PERFORM public.plan_aviso_recalcular(t);
    END LOOP;
  ELSIF TG_TABLE_NAME = 'membresia' THEN
    FOR t IN SELECT DISTINCT n.tenant_id FROM nuevas n JOIN viejas o ON o.id = n.id
              WHERE (o.desactivada_en IS NULL) IS DISTINCT FROM (n.desactivada_en IS NULL) ORDER BY 1 LOOP
      PERFORM public.plan_aviso_recalcular(t);
    END LOOP;
  ELSIF TG_TABLE_NAME = 'invitacion' THEN
    FOR t IN SELECT DISTINCT n.tenant_id FROM nuevas n JOIN viejas o ON o.id = n.id
              WHERE (o.aceptada_en IS NULL) IS DISTINCT FROM (n.aceptada_en IS NULL)
                 OR (o.revocada_en IS NULL) IS DISTINCT FROM (n.revocada_en IS NULL)
                 OR (o.vence_en > now()) IS DISTINCT FROM (n.vence_en > now()) ORDER BY 1 LOOP
      PERFORM public.plan_aviso_recalcular(t);
    END LOOP;
  ELSE
    FOR t IN SELECT DISTINCT n.tenant_id FROM nuevas n ORDER BY 1 LOOP
      PERFORM public.plan_aviso_recalcular(t);
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS plan_aviso_baja ON public.cliente;--> statement-breakpoint
CREATE TRIGGER plan_aviso_baja AFTER DELETE ON public.cliente
  REFERENCING OLD TABLE AS viejas FOR EACH STATEMENT EXECUTE FUNCTION public.plan_aviso_disparar();--> statement-breakpoint
DROP TRIGGER IF EXISTS plan_aviso_baja ON public.membresia;--> statement-breakpoint
CREATE TRIGGER plan_aviso_baja AFTER DELETE ON public.membresia
  REFERENCING OLD TABLE AS viejas FOR EACH STATEMENT EXECUTE FUNCTION public.plan_aviso_disparar();--> statement-breakpoint

-- ---- H-017-3 · destinatarios solo de las filas que inserto esta transaccion -------------------------------------------------
-- Sin xid propio la transaccion no inserto nada: vacio. Con xid, una fila cuenta si su xmin es posterior o igual al de la
-- transaccion (age <= 0; para las demas `age` es positiva o INT_MAX si esta congelada) y su estado sigue «en curso»: la fila es
-- visible, asi que no es de otra transaccion en curso. El xid completo se reconstruye con la diferencia de 32 bits respecto del
-- xid de la transaccion (cercana: la fila es de despues), y el CASE evita llamar a pg_xact_status con un xid fuera de rango.
CREATE OR REPLACE FUNCTION public.notificaciones_de_esta_transaccion() RETURNS SETOF uuid
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  WITH tx AS (SELECT pg_current_xact_id_if_assigned()::text::bigint AS xid)
  SELECT DISTINCT n.usuario_id FROM public.notificacion n CROSS JOIN tx
   WHERE tx.xid IS NOT NULL
     AND n.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
     AND n.id = ANY (ARRAY(
       SELECT x::uuid FROM unnest(string_to_array(coalesce(current_setting('app.notificaciones_tx', true), ''), ',')) AS x
        WHERE x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
     AND CASE WHEN age(n.xmin) <= 0 THEN
           pg_xact_status((tx.xid + ((((n.xmin::text::bigint - tx.xid % 4294967296) % 4294967296) + 6442450944) % 4294967296
                                     - 2147483648))::text::xid8) = 'in progress'
         ELSE false END
$$;
