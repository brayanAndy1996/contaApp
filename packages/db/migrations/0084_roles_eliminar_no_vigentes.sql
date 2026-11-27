-- 0084_roles_eliminar_no_vigentes (custom, spec 030; U5, CA-6, CA-10, D4). Corrige acceso.rol_eliminar de 0082.
-- Defecto: 0082 rechazaba (23503) con CUALQUIER membresía o invitación del rol (desactivadas, revocadas, vencidas o aceptadas), mientras
-- el 409 `rol_en_uso` cuenta solo miembros activos e invitaciones vigentes: un rol sin uso visible no se podía eliminar y el 409 salía en
-- ceros. U5 dice: 409 mientras el rol tenga miembros ACTIVOS o invitaciones VIGENTES. Ahora bloquea exactamente eso (los mismos predicados
-- que los conteos del backend) y, en la misma transacción, retira las demás referencias para que la FK RESTRICT no quede colgada (CA-6):
--   * Invitaciones no vigentes del rol (revocadas, vencidas o aceptadas) se BORRAN. El CHECK `invitacion_rol_propio_coherente` impide
--     desligar `rol_id` sin reescribir `rol` (falsearía la historia); la aceptada ya está representada por su membresía (si sigue en el rol,
--     bloquea como miembro). Nada referencia a `invitacion` y `auditoria` guarda su propia copia (invitacion.creada/revocada/modificada,
--     miembro.alta), así que la auditoría no se rompe; `rol.eliminado` agrega `invitacionesDepuradas` (solo si hubo).
--   * Miembros DESACTIVADOS del rol pasan a `lectura` (el rol de sistema de menor privilegio), sin `rol_id`. Decisión: U5 no los cuenta y
--     el listado tampoco, así que no deben bloquear en silencio; si se reactivan vuelven con lo mínimo y el gestor les asigna otro rol. El
--     cambio deja `miembro.rol_cambiado` {de: propio, a: lectura, deRolId} (disparador de 0083) y `rol.eliminado` agrega
--     `miembrosReasignados` (solo si hubo). D19 ya les retiró las asignaciones al desactivarlos, así que no hay responsables que ajustar.
-- Orden de bloqueo D4 sin cambios: advisory `acceso.roles:<estudio>` -> membresías del actor y del rol (FOR NO KEY UPDATE, también las
-- desactivadas que luego se actualizan: no hace falta subir el bloqueo) -> fila del rol FOR UPDATE -> invitaciones del rol FOR UPDATE.
-- Reasignar a un miembro de rol propio no toma `acceso.duenos` (membresia_ultimo_dueno sale si OLD.rol <> 'dueno'). Tras el bloqueo del
-- rol nadie puede ligar una fila nueva a él (el disparador de asignación lo pide FOR SHARE y la FK FOR KEY SHARE).
-- CREATE OR REPLACE conserva dueño, SECURITY DEFINER y privilegios; se repiten igual que en 0082 (REVOKE de todos, GRANT a contapp_backend).
-- Repetible.
CREATE OR REPLACE FUNCTION acceso.rol_eliminar(p_id uuid)
  RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  v_usuario uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  a record;
  r public.rol%ROWTYPE;
  v_antes text[];
  v_invitaciones integer := 0;
  v_miembros integer := 0;
  v_datos jsonb;
BEGIN
  IF v_tenant IS NULL OR v_usuario IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'acceso: sin permiso para gestionar roles';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('acceso.roles:' || v_tenant::text, 0));
  PERFORM 1 FROM public.membresia m
   WHERE m.tenant_id = v_tenant AND (m.usuario_id = v_usuario OR m.rol_id = p_id)
   ORDER BY m.usuario_id
   FOR NO KEY UPDATE;
  SELECT g.permisos, g.alcance, g.rol_id INTO a FROM acceso.actor_gestor(v_tenant, v_usuario) g;
  SELECT * INTO r FROM public.rol x WHERE x.tenant_id = v_tenant AND x.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'acceso: rol inexistente';
  END IF;
  IF a.rol_id IS NOT DISTINCT FROM p_id THEN
    RAISE EXCEPTION USING ERRCODE = 'RL001', MESSAGE = 'acceso: nadie gestiona el rol que tiene asignado';
  END IF;
  SELECT coalesce(array_agg(p.permiso ORDER BY p.permiso), '{}'::text[]) INTO v_antes
    FROM public.rol_permiso p WHERE p.tenant_id = v_tenant AND p.rol_id = p_id;
  IF NOT acceso.contiene(a.permisos, a.alcance, v_antes, r.alcance) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'acceso: el rol excede los permisos del actor';
  END IF;
  -- U5: miembros activos.
  IF EXISTS (SELECT 1 FROM public.membresia m WHERE m.tenant_id = v_tenant AND m.rol_id = p_id AND m.desactivada_en IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'acceso: el rol esta en uso';
  END IF;
  -- U5: invitaciones vigentes (sin aceptar, sin revocar, sin vencer; mismo criterio que auth.invitacion_vigente y los conteos).
  PERFORM 1 FROM public.invitacion i
   WHERE i.tenant_id = v_tenant AND i.rol_id = p_id
   ORDER BY i.id
   FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.invitacion i
              WHERE i.tenant_id = v_tenant AND i.rol_id = p_id
                AND i.aceptada_en IS NULL AND i.revocada_en IS NULL AND i.vence_en > now()) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'acceso: el rol esta en uso';
  END IF;
  -- CA-6: sin referencias colgadas. Las invitaciones que quedan no son vigentes; los miembros que quedan están desactivados.
  DELETE FROM public.invitacion i WHERE i.tenant_id = v_tenant AND i.rol_id = p_id;
  GET DIAGNOSTICS v_invitaciones = ROW_COUNT;
  UPDATE public.membresia m SET rol = 'lectura', rol_id = NULL
   WHERE m.tenant_id = v_tenant AND m.rol_id = p_id AND m.desactivada_en IS NOT NULL;
  GET DIAGNOSTICS v_miembros = ROW_COUNT;
  DELETE FROM public.rol x WHERE x.tenant_id = v_tenant AND x.id = p_id;
  v_datos := jsonb_build_object('antes', jsonb_build_object('nombre', r.nombre, 'alcance', r.alcance, 'permisos', to_jsonb(v_antes)),
                                'despues', NULL);
  IF v_invitaciones > 0 THEN
    v_datos := v_datos || jsonb_build_object('invitacionesDepuradas', v_invitaciones);
  END IF;
  IF v_miembros > 0 THEN
    v_datos := v_datos || jsonb_build_object('miembrosReasignados', v_miembros);
  END IF;
  PERFORM public.auditoria_registrar(v_tenant, 'rol.eliminado', NULL, 'rol', p_id, v_datos);
END
$$;--> statement-breakpoint
ALTER FUNCTION acceso.rol_eliminar(uuid) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION acceso.rol_eliminar(uuid)
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION acceso.rol_eliminar(uuid) TO contapp_backend;
