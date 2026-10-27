-- 0015_acceso_ronda1 (spec 005, T15): correcciones de la ronda adversarial 1 en la BD. Generada con
-- `drizzle-kit generate` (CHECK nuevo de `invitacion`) y completada a mano antes de aplicarse. 0011–0014 no se
-- editan. Repetible: DROP CONSTRAINT IF EXISTS + ADD y CREATE OR REPLACE (mismas firmas y tipos de retorno que
-- 0013/0014; FUNCIONES_AUTH sigue en 15), con dueño, `search_path` y ACL explícitos.
--
-- H-005-1b-2: el correo de una invitación no admite caracteres de control (el CHECK de 0011 solo exige ASCII).
ALTER TABLE "invitacion" DROP CONSTRAINT IF EXISTS "invitacion_correo_sin_control";--> statement-breakpoint
ALTER TABLE "invitacion" ADD CONSTRAINT "invitacion_correo_sin_control" CHECK ("invitacion"."correo" !~ '[[:cntrl:]]');--> statement-breakpoint

-- ===================================================================================================
-- H-005-1b-1 (D8, decisión del usuario): una invitación solo vale mientras quien la emitió conserve la
-- autoridad para emitirla: membresía ACTIVA en el estudio de la invitación y un rol que pueda otorgar el rol
-- invitado. Es `puedeGestionar(rolInvitador, null, rolInvitado)` de @contapp/shared restringido a quien tiene
-- `usuarios.gestionar` (D2/D17): el Dueño otorga cualquier rol; el Administrador, cualquiera salvo `dueno`;
-- los demás, ninguno. Va en línea en las tres funciones (sin funciones auxiliares en `auth`). Además el backend
-- revoca las pendientes del invitador al desactivarlo o degradarlo (misma transacción); esto cubre lo que no
-- pase por el backend. Lectura sin bloqueo de la membresía del invitador: `contapp_auth` no tiene UPDATE en
-- `membresia` (no puede FOR SHARE) y la revocación del backend se serializa con la aceptación en el
-- `FOR UPDATE` de la fila de la invitación.
-- ===================================================================================================

-- Consulta sin efectos (antes de Argon2). Misma salida que 0014; cero filas si el invitador perdió la autoridad.
CREATE OR REPLACE FUNCTION auth.invitacion_vigente(p_token_hash bytea)
  RETURNS TABLE (tenant_id uuid, estudio_nombre text, correo text, rol text, cuenta_existe boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT i.tenant_id, t.nombre, i.correo, i.rol,
         EXISTS (SELECT 1 FROM public.usuario u WHERE u.email = i.correo)
    FROM public.invitacion i
    JOIN public.tenant t ON t.id = i.tenant_id
   WHERE i.token_hash = p_token_hash AND i.aceptada_en IS NULL AND i.revocada_en IS NULL
     AND i.vence_en > now()
     AND EXISTS (SELECT 1 FROM public.membresia g
                  WHERE g.tenant_id = i.tenant_id AND g.usuario_id = i.invitado_por
                    AND g.desactivada_en IS NULL
                    AND (g.rol = 'dueno' OR (g.rol = 'admin' AND i.rol <> 'dueno')));
$$;--> statement-breakpoint

-- CA-3 como en 0013, más: invitador con autoridad (H-005-1b-1) y nombre válido (H-005-1b-3: no vacío ni en
-- blanco, como mucho 200 caracteres y sin caracteres de control; el backend ya lo valida antes de Argon2).
-- Ambos rechazos devuelven 'invalida' sin efectos.
CREATE OR REPLACE FUNCTION auth.invitacion_aceptar_nueva(p_token_hash bytea, p_nombre text, p_hash text)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  i public.invitacion%ROWTYPE;
  v_usuario uuid;
BEGIN
  IF p_nombre IS NULL OR btrim(p_nombre) = '' OR char_length(p_nombre) > 200 OR p_nombre ~ '[[:cntrl:]]' THEN
    RETURN 'invalida';
  END IF;
  SELECT * INTO i FROM public.invitacion x
   WHERE x.token_hash = p_token_hash AND x.aceptada_en IS NULL AND x.revocada_en IS NULL
     AND x.vence_en > now()
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'invalida';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.membresia g
                  WHERE g.tenant_id = i.tenant_id AND g.usuario_id = i.invitado_por
                    AND g.desactivada_en IS NULL
                    AND (g.rol = 'dueno' OR (g.rol = 'admin' AND i.rol <> 'dueno'))) THEN
    RETURN 'invalida';
  END IF;
  IF EXISTS (SELECT 1 FROM public.usuario u WHERE u.email = i.correo) THEN
    RETURN 'cuenta_existe';
  END IF;
  BEGIN
    INSERT INTO public.usuario AS u (email, nombre) VALUES (i.correo, p_nombre) RETURNING u.id INTO v_usuario;
  EXCEPTION WHEN unique_violation THEN
    RETURN 'invalida';
  END;
  INSERT INTO auth.usuario_contrasena (usuario_id, hash, actualizada_en) VALUES (v_usuario, p_hash, now());
  INSERT INTO public.membresia (tenant_id, usuario_id, rol) VALUES (i.tenant_id, v_usuario, i.rol);
  UPDATE public.invitacion x SET aceptada_en = now(), aceptada_por = v_usuario WHERE x.id = i.id;
  RETURN 'aceptada';
END
$$;--> statement-breakpoint

-- D15 como en 0013, más el invitador con autoridad (H-005-1b-1): si no, cero filas sin efectos.
CREATE OR REPLACE FUNCTION auth.invitacion_aceptar_existente(p_token_hash bytea, p_token_hash_sesion bytea)
  RETURNS TABLE (tenant_id uuid, estudio_nombre text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  i public.invitacion%ROWTYPE;
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
  SELECT * INTO i FROM public.invitacion x
   WHERE x.token_hash = p_token_hash AND x.aceptada_en IS NULL AND x.revocada_en IS NULL
     AND x.vence_en > now()
   FOR UPDATE;
  IF NOT FOUND OR v_correo IS NULL OR i.correo <> v_correo THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.membresia g
                  WHERE g.tenant_id = i.tenant_id AND g.usuario_id = i.invitado_por
                    AND g.desactivada_en IS NULL
                    AND (g.rol = 'dueno' OR (g.rol = 'admin' AND i.rol <> 'dueno'))) THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.membresia m WHERE m.tenant_id = i.tenant_id AND m.usuario_id = v_usuario) THEN
    RETURN;
  END IF;
  INSERT INTO public.membresia (tenant_id, usuario_id, rol) VALUES (i.tenant_id, v_usuario, i.rol);
  UPDATE public.invitacion x SET aceptada_en = now(), aceptada_por = v_usuario WHERE x.id = i.id;
  SELECT t.nombre INTO v_nombre FROM public.tenant t WHERE t.id = i.tenant_id;
  RETURN QUERY SELECT i.tenant_id, v_nombre;
END
$$;--> statement-breakpoint

-- Dueño contapp_auth; EXECUTE solo para contapp_backend (ni PUBLIC, ni worker, ni platform, ni contapp_app).
ALTER FUNCTION auth.invitacion_vigente(bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.invitacion_aceptar_nueva(bytea, text, text) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.invitacion_aceptar_existente(bytea, bytea) OWNER TO contapp_auth;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth.invitacion_vigente(bytea) FROM PUBLIC, contapp_worker, contapp_platform, contapp_app;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth.invitacion_aceptar_nueva(bytea, text, text) FROM PUBLIC, contapp_worker, contapp_platform, contapp_app;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth.invitacion_aceptar_existente(bytea, bytea) FROM PUBLIC, contapp_worker, contapp_platform, contapp_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth.invitacion_vigente(bytea) TO contapp_backend;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth.invitacion_aceptar_nueva(bytea, text, text) TO contapp_backend;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth.invitacion_aceptar_existente(bytea, bytea) TO contapp_backend;
