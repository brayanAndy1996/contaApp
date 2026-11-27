-- 0085_roles_propios_r1b (custom, spec 030, T13; D2, D4, U2, U4, U5, U8; hallazgos de la ronda adversarial 1b, T12).
-- La columna `nombre_clave` sale de drizzle-kit (schema/acceso.ts: cambia la expresión generada; PG 16 no tiene SET EXPRESSION, así que se
-- borra y se vuelve a agregar), reescrita para ser REPETIBLE y para reponer la UNIQUE y el CHECK que el DROP COLUMN se lleva. Luego:
--   1. (ALTA, D2) El disparador de asignación también corre cuando, sin cambiar `rol_id`, cambia QUIÉN recibe el rol propio: `usuario_id`
--      de la membresía, o `correo` / `invitado_por` de la invitación. Traspasar o redirigir es asignar: pasa por la regla de contención.
--   2. (MEDIA, 005 D8 ampliada por U2) `rol_guardar`, al editar un rol, revoca las invitaciones pendientes (vivas o vencidas) que el
--      invitador ya no podría dar: las que emitieron los miembros del rol editado y las que invitan a ese rol. Regla (la de aceptar):
--      el invitador es Dueño, o tiene `usuarios.gestionar`, el rol no es `dueno` y contiene sus permisos y alcance (U2, U4).
--      Aceptar (nueva y existente) vuelve a comprobar la contención con el resolvedor sobre la membresía recién creada (dentro de un
--      subbloque: si no la contiene, se deshace y responde como inválida). contapp_auth no lee `rol` ni ejecuta otras funciones de
--      `acceso` (privilegios fijados por T6), por eso compara los efectivos de ambas membresías con `acceso.permisos_membresia`.
--      `auth.invitacion_vigente` (STABLE, sin membresía nueva) sigue igual: la revocación anterior la mantiene al día.
--   3. (MEDIA, D4) Orden de bloqueo: toda sentencia de la app sobre `invitacion` toma primero el advisory `acceso.roles:<estudio>`
--      (disparador BEFORE ... FOR EACH STATEMENT: corre antes de bloquear ninguna fila), así revocar la vencida del mismo correo y luego
--      insertar ya no se cruza con `rol_eliminar` (rol FOR UPDATE -> invitaciones). `bloquearMiembros` (packages/db) toma el mismo
--      advisory antes de las membresías, de modo que crear, reenviar, revocar o aceptar siguen advisory -> membresías -> rol -> invitaciones.
--      Como invitar, reactivar e importar toman luego el cupo (`plan.cupo`), `auth.cupo_usuarios_aceptar` (que el backend llama antes de
--      aceptar) también toma primero `acceso.roles`: un solo orden, acceso.roles -> membresías -> plan.cupo -> rol -> invitaciones.
--   4. (MEDIA, 017 + D2) `invitacion.creada` guarda `rolId` (solo con rol propio) y cambiar `rol_id` deja `invitacion.modificada` con
--      `rol_id` en `campos` y `deRolId`/`aRolId` (como 0083 para la membresía; 0084 borra invitaciones confiando en esa copia).
--   5. (BAJA) `nombre_clave` ignora los caracteres invisibles y de formato (Cc, Cf: ZWSP, ZWJ, WJ, bidi, BOM; selectores de variación y
--      demás Default_Ignorable) y toma toda racha de espacios Unicode (Zs, Zl, Zp y el ASCII) como un solo espacio ASCII: «Dueño» con NBSP o
--      ZWSP choca con el CHECK de los de sistema y un nombre repetido con ellos, con la UNIQUE. Una clave vacía se rechaza (23514).
-- Funciones: SECURITY DEFINER (salvo los disparadores, que deben ver quién escribe: decisión de T6), search_path fijo, REVOKE de PUBLIC y de
-- cada rol antes del GRANT justo (los mismos de 0042, 0082 y 0084). Repetible.

ALTER TABLE "rol" DROP COLUMN IF EXISTS "nombre_clave";--> statement-breakpoint
ALTER TABLE "rol" ADD COLUMN "nombre_clave" text GENERATED ALWAYS AS (lower(regexp_replace(normalize(btrim(regexp_replace(regexp_replace(nombre, '[\u0001-\u001f\u007f-\u009f­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￰-￻؀-؅۝܏࢐࢑࣢\U000110bd\U000110cd\U00013430-\U0001343f\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0000-\U000e0fff]', '', 'g'), '[    -     　]+', ' ', 'g')), NFD), '[̀-ͯ]', '', 'g'))) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "rol" ADD CONSTRAINT "rol_tenant_nombre_clave_unique" UNIQUE("tenant_id","nombre_clave");--> statement-breakpoint
ALTER TABLE "rol" ADD CONSTRAINT "rol_nombre_clave_no_sistema" CHECK ("rol"."nombre_clave" NOT IN ('dueno', 'administrador', 'admin', 'contador', 'asistente', 'lectura', 'solo lectura'));--> statement-breakpoint
ALTER TABLE "rol" ADD CONSTRAINT "rol_nombre_clave_no_vacia" CHECK ("rol"."nombre_clave" <> '');--> statement-breakpoint

-- ===================================================================================================
-- 1. Disparador de asignación (D2): también el traspaso de la membresía y el desvío de la invitación.
-- ===================================================================================================
CREATE OR REPLACE FUNCTION public.rol_propio_asignar() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.rol_id IS NULL THEN
    RETURN NEW;
  END IF;
  -- Mismo rol y mismo estudio: solo es una asignación si cambia quién recibe el rol (IF anidado: cada columna existe en una sola tabla).
  IF TG_OP = 'UPDATE' AND NEW.rol_id IS NOT DISTINCT FROM OLD.rol_id AND NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id THEN
    IF TG_TABLE_NAME = 'membresia' THEN
      IF NEW.usuario_id IS NOT DISTINCT FROM OLD.usuario_id THEN
        RETURN NEW;
      END IF;
    ELSIF NEW.correo IS NOT DISTINCT FROM OLD.correo AND NEW.invitado_por IS NOT DISTINCT FROM OLD.invitado_por THEN
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
-- 3. D4 en `invitacion`: el advisory del estudio antes de bloquear ninguna fila (por sentencia). Las funciones definer (aceptar, de
-- contapp_auth; rol_guardar y rol_eliminar, de contapp_migrator) ya lo toman ellas mismas, y el superusuario (operación, siembra) no lo
-- necesita. La clave es la misma `acceso.roles:<estudio>` de D4 (se arma por partes; el disparador no decide nada de la asignación).
-- ===================================================================================================
CREATE OR REPLACE FUNCTION public.invitacion_orden_bloqueo() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
BEGIN
  IF v_tenant IS NULL OR current_user IN ('contapp_auth', 'contapp_migrator')
     OR coalesce((SELECT x.rolsuper FROM pg_catalog.pg_roles x WHERE x.rolname = current_user), false) THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('acceso' || '.roles:' || v_tenant::text, 0));
  RETURN NULL;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.invitacion_orden_bloqueo() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.invitacion_orden_bloqueo()
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
DROP TRIGGER IF EXISTS invitacion_orden_bloqueo ON public.invitacion;--> statement-breakpoint
CREATE TRIGGER invitacion_orden_bloqueo BEFORE INSERT OR UPDATE OR DELETE ON public.invitacion
  FOR EACH STATEMENT EXECUTE FUNCTION public.invitacion_orden_bloqueo();--> statement-breakpoint

-- ===================================================================================================
-- 4. Auditoría de invitaciones (la de 0045 más `rolId` y `rol_id`).
-- ===================================================================================================
CREATE OR REPLACE FUNCTION public.auditoria_capturar_invitacion() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_campos text[] := '{}'::text[];
  v_datos jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_datos := jsonb_build_object('rol', NEW.rol);
    IF NEW.rol_id IS NOT NULL THEN
      v_datos := v_datos || jsonb_build_object('rolId', NEW.rol_id);
    END IF;
    PERFORM public.auditoria_registrar(NEW.tenant_id, 'invitacion.creada', NULL, 'invitacion', NEW.id, v_datos);
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
  IF NEW.rol_id IS DISTINCT FROM OLD.rol_id THEN
    v_campos := v_campos || 'rol_id'::text;
  END IF;
  IF NEW.vence_en IS DISTINCT FROM OLD.vence_en THEN
    v_campos := v_campos || 'vence_en'::text;
  END IF;
  IF cardinality(v_campos) > 0 THEN
    v_datos := jsonb_build_object('campos', to_jsonb(v_campos));
    IF NEW.rol IS DISTINCT FROM OLD.rol THEN
      v_datos := v_datos || jsonb_build_object('de', OLD.rol, 'a', NEW.rol);
    END IF;
    IF NEW.rol_id IS DISTINCT FROM OLD.rol_id AND OLD.rol_id IS NOT NULL THEN
      v_datos := v_datos || jsonb_build_object('deRolId', OLD.rol_id);
    END IF;
    IF NEW.rol_id IS DISTINCT FROM OLD.rol_id AND NEW.rol_id IS NOT NULL THEN
      v_datos := v_datos || jsonb_build_object('aRolId', NEW.rol_id);
    END IF;
    PERFORM public.auditoria_registrar(NEW.tenant_id, 'invitacion.modificada', NULL, 'invitacion', NEW.id, v_datos);
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.auditoria_capturar_invitacion() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.auditoria_capturar_invitacion()
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
DROP TRIGGER IF EXISTS auditoria_invitacion ON public.invitacion;--> statement-breakpoint
CREATE TRIGGER auditoria_invitacion AFTER INSERT OR UPDATE OF revocada_en, correo, rol, rol_id, vence_en ON public.invitacion
  FOR EACH ROW EXECUTE FUNCTION public.auditoria_capturar_invitacion();--> statement-breakpoint

-- ===================================================================================================
-- 2. rol_guardar (la de 0082) + revocación de las invitaciones pendientes que el invitador ya no podría dar (tras las asignaciones, D4).
-- ===================================================================================================
CREATE OR REPLACE FUNCTION acceso.rol_guardar(p_id uuid, p_nombre text, p_alcance text, p_permisos text[])
  RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  v_usuario uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  v_permisos text[];
  a record;
  r public.rol%ROWTYPE;
  v_antes text[];
  v_id uuid;
  v_revocadas integer := 0;
  v_datos jsonb;
BEGIN
  IF v_tenant IS NULL OR v_usuario IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'acceso: sin permiso para gestionar roles';
  END IF;
  IF p_alcance IS NULL OR p_alcance NOT IN ('global', 'asignado') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'acceso: alcance de rol invalido';
  END IF;
  SELECT coalesce(array_agg(DISTINCT x ORDER BY x), '{}'::text[]) INTO v_permisos FROM unnest(coalesce(p_permisos, '{}'::text[])) AS x;
  IF EXISTS (SELECT 1 FROM unnest(v_permisos) AS x WHERE x IS NULL OR NOT (x = ANY (acceso.permisos_asignables()))) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'acceso: permiso fuera del catalogo';
  END IF;
  IF NOT acceso.combinacion_valida(v_permisos) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'acceso: combinacion de permisos invalida';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('acceso.roles:' || v_tenant::text, 0));
  PERFORM 1 FROM public.membresia m
   WHERE m.tenant_id = v_tenant AND (m.usuario_id = v_usuario OR m.rol_id = p_id)
   ORDER BY m.usuario_id
   FOR NO KEY UPDATE;
  SELECT g.permisos, g.alcance, g.rol_id INTO a FROM acceso.actor_gestor(v_tenant, v_usuario) g;

  IF p_id IS NULL THEN
    IF NOT acceso.contiene(a.permisos, a.alcance, v_permisos, p_alcance) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'acceso: el rol excede los permisos del actor';
    END IF;
    IF (SELECT count(*) FROM public.rol x WHERE x.tenant_id = v_tenant) >= 20 THEN
      RAISE EXCEPTION USING ERRCODE = '54000', MESSAGE = 'acceso: limite de roles propios alcanzado';
    END IF;
    INSERT INTO public.rol AS x (tenant_id, nombre, alcance) VALUES (v_tenant, p_nombre, p_alcance) RETURNING x.id INTO v_id;
    INSERT INTO public.rol_permiso (tenant_id, rol_id, permiso) SELECT v_tenant, v_id, x FROM unnest(v_permisos) AS x;
    PERFORM public.auditoria_registrar(v_tenant, 'rol.creado', NULL, 'rol', v_id,
      jsonb_build_object('antes', NULL,
                         'despues', jsonb_build_object('nombre', p_nombre, 'alcance', p_alcance, 'permisos', to_jsonb(v_permisos))));
    RETURN v_id;
  END IF;

  SELECT * INTO r FROM public.rol x WHERE x.tenant_id = v_tenant AND x.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'acceso: rol inexistente';
  END IF;
  IF a.rol_id IS NOT DISTINCT FROM p_id THEN
    RAISE EXCEPTION USING ERRCODE = 'RL001', MESSAGE = 'acceso: nadie gestiona el rol que tiene asignado';
  END IF;
  SELECT coalesce(array_agg(p.permiso ORDER BY p.permiso), '{}'::text[]) INTO v_antes
    FROM public.rol_permiso p WHERE p.tenant_id = v_tenant AND p.rol_id = p_id;
  IF NOT acceso.contiene(a.permisos, a.alcance, v_antes, r.alcance)
     OR NOT acceso.contiene(a.permisos, a.alcance, v_permisos, p_alcance) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'acceso: el rol excede los permisos del actor';
  END IF;
  UPDATE public.rol x SET nombre = p_nombre, alcance = p_alcance, actualizado_en = now()
   WHERE x.tenant_id = v_tenant AND x.id = p_id;
  DELETE FROM public.rol_permiso p WHERE p.tenant_id = v_tenant AND p.rol_id = p_id AND NOT (p.permiso = ANY (v_permisos));
  INSERT INTO public.rol_permiso (tenant_id, rol_id, permiso) SELECT v_tenant, p_id, x FROM unnest(v_permisos) AS x
  ON CONFLICT DO NOTHING;
  -- U6 (005 D18): sin `sire.clasificar`, los miembros del rol (activos o no) dejan de ser responsables.
  IF 'sire.clasificar' = ANY (v_antes) AND NOT ('sire.clasificar' = ANY (v_permisos)) THEN
    UPDATE public.asignacion s SET tipo = 'colaborador', updated_at = now()
     WHERE s.tenant_id = v_tenant AND s.tipo = 'responsable'
       AND s.usuario_id IN (SELECT m.usuario_id FROM public.membresia m WHERE m.tenant_id = v_tenant AND m.rol_id = p_id);
  END IF;
  -- 005 D8 ampliada por U2: pendientes (vivas o vencidas) emitidas por un miembro del rol o que invitan a él, que su invitador ya no
  -- podría dar con el rol ya editado: Dueño, o `usuarios.gestionar`, rol distinto de `dueno` y permisos y alcance contenidos (U2, U4).
  -- Los invitadores miembros del rol ya están bloqueados; los demás solo cambian de rol tras el mismo advisory (bloquearMiembros).
  UPDATE public.invitacion i SET revocada_en = now()
   WHERE i.tenant_id = v_tenant AND i.aceptada_en IS NULL AND i.revocada_en IS NULL
     AND (i.rol_id = p_id
          OR i.invitado_por IN (SELECT m.usuario_id FROM public.membresia m WHERE m.tenant_id = v_tenant AND m.rol_id = p_id))
     AND NOT EXISTS (
       SELECT 1 FROM acceso.permisos_membresia(v_tenant, i.invitado_por) g
        WHERE g.rol_sistema = 'dueno'
           OR ('usuarios.gestionar' = ANY (g.permisos) AND i.rol <> 'dueno'
               AND acceso.contiene(g.permisos, g.alcance,
                     CASE WHEN i.rol = 'propio'
                          THEN (SELECT coalesce(array_agg(p.permiso), '{}'::text[]) FROM public.rol_permiso p
                                 WHERE p.tenant_id = v_tenant AND p.rol_id = i.rol_id)
                          ELSE acceso.permisos_sistema(i.rol) END,
                     CASE WHEN i.rol = 'propio'
                          THEN (SELECT x.alcance FROM public.rol x WHERE x.tenant_id = v_tenant AND x.id = i.rol_id)
                          WHEN i.rol IN ('dueno', 'admin') THEN 'global'
                          ELSE 'asignado' END)));
  GET DIAGNOSTICS v_revocadas = ROW_COUNT;
  v_datos := jsonb_build_object('antes', jsonb_build_object('nombre', r.nombre, 'alcance', r.alcance, 'permisos', to_jsonb(v_antes)),
                                'despues', jsonb_build_object('nombre', p_nombre, 'alcance', p_alcance, 'permisos', to_jsonb(v_permisos)));
  IF v_revocadas > 0 THEN
    v_datos := v_datos || jsonb_build_object('invitacionesRevocadas', v_revocadas);
  END IF;
  PERFORM public.auditoria_registrar(v_tenant, 'rol.editado', NULL, 'rol', p_id, v_datos);
  RETURN p_id;
END
$$;--> statement-breakpoint
ALTER FUNCTION acceso.rol_guardar(uuid, text, text, text[]) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION acceso.rol_guardar(uuid, text, text, text[])
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION acceso.rol_guardar(uuid, text, text, text[]) TO contapp_backend;--> statement-breakpoint

-- ===================================================================================================
-- 2. Aceptar vuelve a comprobar la contención (las de 0082 más el subbloque). La membresía recién creada da, con el resolvedor, los
-- permisos y el alcance del rol invitado (de sistema o propio, ya con su última edición: el advisory serializa con rol_guardar).
-- ===================================================================================================
CREATE OR REPLACE FUNCTION auth.invitacion_aceptar_nueva(p_token_hash bytea, p_nombre text, p_hash text)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  i public.invitacion%ROWTYPE;
  v_tenant uuid;
  v_usuario uuid;
BEGIN
  IF p_nombre IS NULL OR btrim(p_nombre) = '' OR char_length(p_nombre) > 200
     OR p_nombre ~ E'[\\u0001-\\u001f\\u007f-\\u009f\\u00ad\\u0600-\\u0605\\u061c\\u06dd\\u070f\\u0890-\\u0891\\u08e2\\u180e\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u206f\\ufeff\\ufff9-\\ufffb\\U000110bd\\U000110cd\\U00013430-\\U0001343f\\U0001bca0-\\U0001bca3\\U0001d173-\\U0001d17a\\U000e0001\\U000e0020-\\U000e007f]'
     OR NOT (p_nombre COLLATE pg_catalog."und-x-icu" ~ '[[:alnum:]]') THEN
    RETURN 'invalida';
  END IF;
  SELECT x.tenant_id INTO v_tenant FROM public.invitacion x
   WHERE x.token_hash = p_token_hash AND x.aceptada_en IS NULL AND x.revocada_en IS NULL AND x.vence_en > now();
  IF NOT FOUND THEN
    RETURN 'invalida';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('acceso.roles:' || v_tenant::text, 0));
  SELECT * INTO i FROM public.invitacion x
   WHERE x.token_hash = p_token_hash AND x.aceptada_en IS NULL AND x.revocada_en IS NULL
     AND x.vence_en > now()
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'invalida';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM acceso.permisos_membresia(i.tenant_id, i.invitado_por) g
                  WHERE g.rol_sistema = 'dueno' OR ('usuarios.gestionar' = ANY (g.permisos) AND i.rol <> 'dueno')) THEN
    RETURN 'invalida';
  END IF;
  IF EXISTS (SELECT 1 FROM public.usuario u WHERE u.email = i.correo) THEN
    RETURN 'cuenta_existe';
  END IF;
  BEGIN
    INSERT INTO public.usuario AS u (email, nombre) VALUES (i.correo, p_nombre) RETURNING u.id INTO v_usuario;
    INSERT INTO auth.usuario_contrasena (usuario_id, hash, actualizada_en) VALUES (v_usuario, p_hash, now());
    INSERT INTO public.membresia (tenant_id, usuario_id, rol, rol_id) VALUES (i.tenant_id, v_usuario, i.rol, i.rol_id);
    IF NOT EXISTS (SELECT 1 FROM acceso.permisos_membresia(i.tenant_id, i.invitado_por) g
                    CROSS JOIN acceso.permisos_membresia(i.tenant_id, v_usuario) n
                    WHERE g.rol_sistema = 'dueno'
                       OR ('usuarios.gestionar' = ANY (g.permisos) AND i.rol <> 'dueno'
                           AND n.permisos <@ g.permisos AND (n.alcance = 'asignado' OR g.alcance = 'global'))) THEN
      RAISE EXCEPTION USING ERRCODE = 'RL002', MESSAGE = 'acceso: el invitador ya no puede dar ese rol';
    END IF;
  EXCEPTION
    WHEN unique_violation THEN
      RETURN 'invalida';
    WHEN SQLSTATE 'RL002' THEN
      RETURN 'invalida';
  END;
  UPDATE public.invitacion x SET aceptada_en = now(), aceptada_por = v_usuario WHERE x.id = i.id;
  RETURN 'aceptada';
END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth.invitacion_aceptar_existente(p_token_hash bytea, p_token_hash_sesion bytea)
  RETURNS TABLE (tenant_id uuid, estudio_nombre text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  i public.invitacion%ROWTYPE;
  v_tenant uuid;
  v_usuario uuid;
  v_correo text;
  v_nombre text;
BEGIN
  SELECT x.usuario_id INTO v_usuario FROM auth.sesion x
   WHERE x.token_hash = p_token_hash_sesion AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours';
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT u.email INTO v_correo FROM public.usuario u WHERE u.id = v_usuario;
  SELECT x.tenant_id INTO v_tenant FROM public.invitacion x
   WHERE x.token_hash = p_token_hash AND x.aceptada_en IS NULL AND x.revocada_en IS NULL AND x.vence_en > now();
  IF NOT FOUND THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('acceso.roles:' || v_tenant::text, 0));
  SELECT * INTO i FROM public.invitacion x
   WHERE x.token_hash = p_token_hash AND x.aceptada_en IS NULL AND x.revocada_en IS NULL
     AND x.vence_en > now()
   FOR UPDATE;
  IF NOT FOUND OR v_correo IS NULL OR i.correo <> v_correo THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM acceso.permisos_membresia(i.tenant_id, i.invitado_por) g
                  WHERE g.rol_sistema = 'dueno' OR ('usuarios.gestionar' = ANY (g.permisos) AND i.rol <> 'dueno')) THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.membresia m WHERE m.tenant_id = i.tenant_id AND m.usuario_id = v_usuario) THEN
    RETURN;
  END IF;
  BEGIN
    INSERT INTO public.membresia (tenant_id, usuario_id, rol, rol_id) VALUES (i.tenant_id, v_usuario, i.rol, i.rol_id);
    IF NOT EXISTS (SELECT 1 FROM acceso.permisos_membresia(i.tenant_id, i.invitado_por) g
                    CROSS JOIN acceso.permisos_membresia(i.tenant_id, v_usuario) n
                    WHERE g.rol_sistema = 'dueno'
                       OR ('usuarios.gestionar' = ANY (g.permisos) AND i.rol <> 'dueno'
                           AND n.permisos <@ g.permisos AND (n.alcance = 'asignado' OR g.alcance = 'global'))) THEN
      RAISE EXCEPTION USING ERRCODE = 'RL002', MESSAGE = 'acceso: el invitador ya no puede dar ese rol';
    END IF;
  EXCEPTION
    WHEN SQLSTATE 'RL002' THEN
      RETURN;
  END;
  UPDATE public.invitacion x SET aceptada_en = now(), aceptada_por = v_usuario WHERE x.id = i.id;
  SELECT t.nombre INTO v_nombre FROM public.tenant t WHERE t.id = i.tenant_id;
  RETURN QUERY SELECT i.tenant_id, v_nombre;
END
$$;--> statement-breakpoint

-- 3. D4 también al aceptar: el backend llama a auth.cupo_usuarios_aceptar (advisory `plan.cupo`) ANTES de aceptar (advisory
-- `acceso.roles`), mientras que invitar, reactivar, crear o importar clientes toman ahora `acceso.roles` (bloquearMiembros) antes del cupo.
-- La de 0024 toma primero `acceso.roles:<estudio>` (aceptar lo vuelve a pedir: es reentrante), así el orden es uno solo:
-- acceso.roles -> membresías -> plan.cupo -> rol -> invitaciones.
CREATE OR REPLACE FUNCTION auth.cupo_usuarios_aceptar(p_tenant_id uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_max integer;
  v_activos bigint;
BEGIN
  IF p_tenant_id IS NULL THEN
    RETURN false;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('acceso.roles:' || p_tenant_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('plan.cupo:' || p_tenant_id::text, 0));
  SELECT p.max_usuarios INTO v_max
    FROM public.suscripcion s JOIN public.plan p ON p.id = s.plan_id
   WHERE s.tenant_id = p_tenant_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_max IS NULL THEN
    RETURN true;
  END IF;
  SELECT count(*) INTO v_activos FROM public.membresia m
   WHERE m.tenant_id = p_tenant_id AND m.desactivada_en IS NULL;
  RETURN v_activos + 1 <= v_max;
END
$$;--> statement-breakpoint

-- Dueño contapp_auth; EXECUTE solo para contapp_backend (como en 0024 y 0082).
ALTER FUNCTION auth.cupo_usuarios_aceptar(uuid) OWNER TO contapp_auth;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth.cupo_usuarios_aceptar(uuid)
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_enumerador, contapp_registrador, contapp_migrator;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth.cupo_usuarios_aceptar(uuid) TO contapp_backend;--> statement-breakpoint
ALTER FUNCTION auth.invitacion_aceptar_nueva(bytea, text, text) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.invitacion_aceptar_existente(bytea, bytea) OWNER TO contapp_auth;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth.invitacion_aceptar_nueva(bytea, text, text), auth.invitacion_aceptar_existente(bytea, bytea)
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_enumerador, contapp_registrador, contapp_migrator;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth.invitacion_aceptar_nueva(bytea, text, text), auth.invitacion_aceptar_existente(bytea, bytea)
  TO contapp_backend;
