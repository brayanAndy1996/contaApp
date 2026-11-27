-- 0086_roles_propios_r2 (custom, spec 030, T13b; D2, D4, U2, U4, U5; hallazgos de la ronda adversarial 2, T13a).
--   1. (ALTA, D2) El disparador de asignación de 0085 solo miraba rol_id, tenant_id, usuario_id, correo e invitado_por: con el mismo rol
--      propio, un gestor sin contención podía re-emitir (token_hash), revivir (vence_en), des-revocar (revocada_en) o des-aceptar una
--      invitación ajena y aceptarla él. Se cierra la clase entera en modo «falla cerrado»: con el mismo rol y estudio, TODO cambio de una
--      fila con rol propio pasa por la regla de contención (acceso.rol_asignable), salvo `updated_at` y las bajas, que no dan nada:
--      desactivar la membresía (desactivada_en queda puesta) o revocar la invitación (revocada_en queda puesta). Columnas nuevas también
--      quedan cubiertas sin tocar el disparador.
--   2. (MEDIA, D2) Reactivar una membresía con rol propio (UPDATE, o INSERT ... ON CONFLICT DO UPDATE, que dispara el BEFORE UPDATE con la
--      fila existente) es una asignación: desactivada_en vuelve a NULL y la regla aplica.
--   3. (BAJA, U2) acceso.rol_impacto aplica dentro de la BD la misma regla que rol_guardar: RL001 si es el rol del actor y 42501 si el rol
--      (antes, con su alcance, o después, con el pedido) no está contenido en los permisos y el alcance del actor. Solo lectura, sin bloqueos.
-- Funciones: SECURITY DEFINER (salvo el disparador, que debe ver quién escribe: decisión de T6), search_path fijo, REVOKE de PUBLIC y de
-- cada rol antes del GRANT justo (los mismos de 0082 y 0085). Repetible. Los disparadores de 0082 (BEFORE INSERT OR UPDATE de toda columna,
-- por fila) ya llaman a esta función: no se recrean.

-- ===================================================================================================
-- 1 y 2. Disparador de asignación (D2): con el mismo rol propio, todo cambio que no sea una baja pasa por la regla.
-- ===================================================================================================
CREATE OR REPLACE FUNCTION public.rol_propio_asignar() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_antes jsonb;
  v_despues jsonb;
BEGIN
  IF NEW.rol_id IS NULL THEN
    RETURN NEW;
  END IF;
  -- Mismo rol y mismo estudio: se compara la fila entera (genérico para membresia e invitacion) sin `updated_at` y, si la fila queda dada
  -- de baja, sin la columna de baja (desactivar o revocar no asigna nada). Cualquier otra diferencia (usuario_id, correo, invitado_por,
  -- token_hash, vence_en, revocada_en o desactivada_en a NULL, aceptada_en, aceptada_por, ...) es una asignación.
  IF TG_OP = 'UPDATE' AND NEW.rol_id IS NOT DISTINCT FROM OLD.rol_id AND NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id THEN
    v_antes := to_jsonb(OLD) - 'updated_at';
    v_despues := to_jsonb(NEW) - 'updated_at';
    IF (v_despues ->> 'desactivada_en') IS NOT NULL THEN
      v_antes := v_antes - 'desactivada_en';
      v_despues := v_despues - 'desactivada_en';
    END IF;
    IF (v_despues ->> 'revocada_en') IS NOT NULL THEN
      v_antes := v_antes - 'revocada_en';
      v_despues := v_despues - 'revocada_en';
    END IF;
    IF v_antes = v_despues THEN
      RETURN NEW;
    END IF;
  END IF;
  IF current_user IN ('contapp_auth', 'contapp_migrator')
     OR coalesce((SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false) THEN
    RETURN NEW;
  END IF;
  IF acceso.rol_asignable(NEW.tenant_id, NEW.rol_id) THEN
    RETURN NEW;
  END IF;
  -- Rechazado. Si además deja al estudio sin Dueño activo, P0001 (lo que daría membresia_ultimo_dueno, U7/CA-8).
  IF TG_TABLE_NAME = 'membresia' AND TG_OP = 'UPDATE' THEN
    IF OLD.rol = 'dueno' AND OLD.desactivada_en IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.membresia m
                        WHERE m.tenant_id = OLD.tenant_id AND m.rol = 'dueno' AND m.desactivada_en IS NULL
                          AND m.usuario_id <> OLD.usuario_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'el estudio debe conservar al menos un Dueño activo';
    END IF;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'acceso: sin permiso para asignar el rol';
END
$$;--> statement-breakpoint
ALTER FUNCTION public.rol_propio_asignar() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.rol_propio_asignar()
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint

-- ===================================================================================================
-- 3. rol_impacto (la de 0082) con U2 en la BD, en el orden de rol_guardar: P0002, RL001, 42501 (antes y después).
-- ===================================================================================================
CREATE OR REPLACE FUNCTION acceso.rol_impacto(p_id uuid, p_alcance text, p_permisos text[])
  RETURNS TABLE (miembros integer, clientes_sin_responsable integer, miembros_sin_totp_exigidos integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  v_usuario uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  v_sensibles constant text[] := ARRAY['usuarios.gestionar', 'roles.gestionar', 'plan.gestionar', 'credenciales.editar'];
  v_despues text[] := coalesce(p_permisos, '{}'::text[]);
  v_antes text[];
  v_alcance_antes text;
  a record;
  v_miembros integer := 0;
  v_clientes integer := 0;
  v_totp integer := 0;
BEGIN
  SELECT g.permisos, g.alcance, g.rol_id INTO a FROM acceso.actor_gestor(v_tenant, v_usuario) g;
  SELECT x.alcance INTO v_alcance_antes FROM public.rol x WHERE x.tenant_id = v_tenant AND x.id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'acceso: rol inexistente';
  END IF;
  IF a.rol_id IS NOT DISTINCT FROM p_id THEN
    RAISE EXCEPTION USING ERRCODE = 'RL001', MESSAGE = 'acceso: nadie gestiona el rol que tiene asignado';
  END IF;
  SELECT coalesce(array_agg(p.permiso), '{}'::text[]) INTO v_antes
    FROM public.rol_permiso p WHERE p.tenant_id = v_tenant AND p.rol_id = p_id;
  IF acceso.contiene(a.permisos, a.alcance, v_antes, v_alcance_antes) IS NOT TRUE
     OR acceso.contiene(a.permisos, a.alcance, v_despues, p_alcance) IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'acceso: el rol excede los permisos del actor';
  END IF;
  SELECT count(*)::integer INTO v_miembros FROM public.membresia m
   WHERE m.tenant_id = v_tenant AND m.rol_id = p_id AND m.desactivada_en IS NULL;
  IF 'sire.clasificar' = ANY (v_antes) AND NOT ('sire.clasificar' = ANY (v_despues)) THEN
    SELECT count(DISTINCT s.cliente_id)::integer INTO v_clientes
      FROM public.asignacion s
      JOIN public.membresia m ON m.tenant_id = s.tenant_id AND m.usuario_id = s.usuario_id
     WHERE s.tenant_id = v_tenant AND s.tipo = 'responsable' AND m.rol_id = p_id;
  END IF;
  IF NOT (v_antes && v_sensibles) AND (v_despues && v_sensibles) THEN
    SELECT count(*)::integer INTO v_totp FROM public.membresia m
     WHERE m.tenant_id = v_tenant AND m.rol_id = p_id AND m.desactivada_en IS NULL AND NOT auth.totp_activo(m.usuario_id);
  END IF;
  RETURN QUERY SELECT v_miembros, v_clientes, v_totp;
END
$$;--> statement-breakpoint
ALTER FUNCTION acceso.rol_impacto(uuid, text, text[]) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION acceso.rol_impacto(uuid, text, text[])
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION acceso.rol_impacto(uuid, text, text[]) TO contapp_backend;
