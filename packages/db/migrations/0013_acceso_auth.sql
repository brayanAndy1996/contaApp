-- 0013_acceso_auth (custom, spec 005). Lo que `auth` necesita para las invitaciones (D7, D15) y la membresía
-- activa en las funciones de sesión (D9). Repetible: DROP POLICY IF EXISTS, CREATE OR REPLACE, ALTER OWNER y
-- GRANT/REVOKE idempotentes. No toca ninguna función de 0008 (auth-r2a.adv la re-aplica y compara).
--   * Políticas de contapp_auth: auth_definer_insert en usuario y membresia (crear la cuenta y la membresía al
--     aceptar), auth_definer (SELECT) y auth_definer_update en invitacion, y auth_definer (SELECT) en tenant para
--     devolver el nombre del estudio (solo columnas id y nombre; contapp_auth es NOLOGIN).
--   * login_exito, sesion_validar, sesion_rotar y ultimo_estudio: misma firma, dueño y search_path que en
--     0007/0009/0010; toda comprobación de membresía exige desactivada_en IS NULL.
--   * Funciones nuevas: invitacion_vigente, invitacion_aceptar_nueva, invitacion_aceptar_existente.

-- ===================================================================================================
-- Privilegios y políticas de contapp_auth (mínimos: por columna donde basta).
-- ===================================================================================================
GRANT INSERT (email, nombre) ON public.usuario TO contapp_auth;--> statement-breakpoint
GRANT INSERT (tenant_id, usuario_id, rol) ON public.membresia TO contapp_auth;--> statement-breakpoint
GRANT SELECT ON public.invitacion TO contapp_auth;--> statement-breakpoint
GRANT UPDATE (aceptada_en, aceptada_por) ON public.invitacion TO contapp_auth;--> statement-breakpoint
GRANT SELECT (id, nombre) ON public.tenant TO contapp_auth;--> statement-breakpoint

DROP POLICY IF EXISTS auth_definer_insert ON public.usuario;--> statement-breakpoint
CREATE POLICY auth_definer_insert ON public.usuario FOR INSERT TO contapp_auth WITH CHECK (true);--> statement-breakpoint
DROP POLICY IF EXISTS auth_definer_insert ON public.membresia;--> statement-breakpoint
CREATE POLICY auth_definer_insert ON public.membresia FOR INSERT TO contapp_auth WITH CHECK (true);--> statement-breakpoint
DROP POLICY IF EXISTS auth_definer ON public.invitacion;--> statement-breakpoint
CREATE POLICY auth_definer ON public.invitacion FOR SELECT TO contapp_auth USING (true);--> statement-breakpoint
DROP POLICY IF EXISTS auth_definer_update ON public.invitacion;--> statement-breakpoint
CREATE POLICY auth_definer_update ON public.invitacion FOR UPDATE TO contapp_auth USING (true) WITH CHECK (true);--> statement-breakpoint
DROP POLICY IF EXISTS auth_definer ON public.tenant;--> statement-breakpoint
CREATE POLICY auth_definer ON public.tenant FOR SELECT TO contapp_auth USING (true);--> statement-breakpoint

-- ===================================================================================================
-- Funciones de 004 redefinidas con membresía activa (D9, CA-9).
-- ===================================================================================================

-- Login correcto (0010): exige que la credencial siga siendo la verificada, comprueba la membresía ACTIVA,
-- reinicia el contador, re-hash opcional, crea la sesión (12 h) y revoca la cookie previa.
CREATE OR REPLACE FUNCTION auth.login_exito(
  p_clave bytea, p_usuario_id uuid, p_hash_verificado text, p_token_hash bytea, p_tenant_activo uuid,
  p_hash_nuevo text, p_token_anterior_hash bytea)
  RETURNS TABLE (sesion_id uuid, expira_absoluta timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_hash text;
  v_id uuid;
  v_expira timestamptz;
BEGIN
  IF p_hash_nuevo IS NULL THEN
    SELECT c.hash INTO v_hash FROM auth.usuario_contrasena c WHERE c.usuario_id = p_usuario_id FOR SHARE;
  ELSE
    SELECT c.hash INTO v_hash FROM auth.usuario_contrasena c WHERE c.usuario_id = p_usuario_id FOR NO KEY UPDATE;
  END IF;
  IF v_hash IS NULL OR p_hash_verificado IS NULL OR v_hash <> p_hash_verificado THEN
    RETURN;
  END IF;
  IF p_tenant_activo IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.membresia m
     WHERE m.tenant_id = p_tenant_activo AND m.usuario_id = p_usuario_id AND m.desactivada_en IS NULL
  ) THEN
    RETURN;
  END IF;
  UPDATE auth.intento_login i SET fallos = 0, ventana_inicio = now(), bloqueado_hasta = NULL
   WHERE i.clave = p_clave;
  IF p_hash_nuevo IS NOT NULL THEN
    UPDATE auth.usuario_contrasena c SET hash = p_hash_nuevo, actualizada_en = now()
     WHERE c.usuario_id = p_usuario_id;
  END IF;
  IF p_token_anterior_hash IS NOT NULL THEN
    UPDATE auth.sesion x SET revocada_en = now(), motivo = 'rotacion'
     WHERE x.token_hash = p_token_anterior_hash AND x.revocada_en IS NULL;
  END IF;
  INSERT INTO auth.sesion AS n (token_hash, usuario_id, tenant_activo, creada_en, ultimo_uso, expira_absoluta)
  VALUES (p_token_hash, p_usuario_id, p_tenant_activo, now(), now(), now() + interval '12 hours')
  RETURNING n.id, n.expira_absoluta INTO v_id, v_expira;
  RETURN QUERY SELECT v_id, v_expira;
END
$$;--> statement-breakpoint

-- D3, CA-9 (0007): valida, refresca ultimo_uso cada 5 min y limpia el estudio si la membresía ya no está activa.
CREATE OR REPLACE FUNCTION auth.sesion_validar(p_token_hash bytea)
  RETURNS TABLE (sesion_id uuid, usuario_id uuid, tenant_activo uuid, estudio_revocado boolean,
                 expira_absoluta timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  s auth.sesion%ROWTYPE;
  v_revocado boolean := false;
BEGIN
  SELECT * INTO s FROM auth.sesion x
   WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours';
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF s.tenant_activo IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.membresia m
     WHERE m.tenant_id = s.tenant_activo AND m.usuario_id = s.usuario_id AND m.desactivada_en IS NULL
  ) THEN
    UPDATE auth.sesion x SET tenant_activo = NULL WHERE x.id = s.id;
    s.tenant_activo := NULL;
    v_revocado := true;
  END IF;
  IF s.ultimo_uso < now() - interval '5 minutes' THEN
    UPDATE auth.sesion x SET ultimo_uso = now() WHERE x.id = s.id;
  END IF;
  RETURN QUERY SELECT s.id, s.usuario_id, s.tenant_activo, v_revocado, s.expira_absoluta;
END
$$;--> statement-breakpoint

-- D4, CA-5 (0009): rota conservando creada_en y expira_absoluta; re-comprueba la membresía ACTIVA del estudio
-- nuevo. Mismo orden de bloqueo que 0009: usuario (advisory) -> credencial -> sesión.
CREATE OR REPLACE FUNCTION auth.sesion_rotar(p_token_hash bytea, p_token_hash_nuevo bytea, p_tenant_nuevo uuid)
  RETURNS TABLE (sesion_id uuid, expira_absoluta timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  s auth.sesion%ROWTYPE;
  v_usuario uuid;
  v_id uuid;
BEGIN
  SELECT x.usuario_id INTO v_usuario FROM auth.sesion x
   WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours';
  IF NOT FOUND THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('auth.sesiones:' || v_usuario::text, 0));
  PERFORM 1 FROM auth.usuario_contrasena c WHERE c.usuario_id = v_usuario FOR SHARE;
  SELECT * INTO s FROM auth.sesion x
   WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF p_tenant_nuevo IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.membresia m
     WHERE m.tenant_id = p_tenant_nuevo AND m.usuario_id = s.usuario_id AND m.desactivada_en IS NULL
  ) THEN
    RETURN;
  END IF;
  UPDATE auth.sesion x SET revocada_en = now(), motivo = 'rotacion' WHERE x.id = s.id;
  INSERT INTO auth.sesion AS n (token_hash, usuario_id, tenant_activo, creada_en, ultimo_uso, expira_absoluta)
  VALUES (p_token_hash_nuevo, s.usuario_id, p_tenant_nuevo, s.creada_en, now(), s.expira_absoluta)
  RETURNING n.id INTO v_id;
  RETURN QUERY SELECT v_id, s.expira_absoluta;
END
$$;--> statement-breakpoint

-- P7 (0007): estudio de la sesión más reciente del usuario (revocadas incluidas) con membresía ACTIVA.
CREATE OR REPLACE FUNCTION auth.ultimo_estudio(p_token_hash bytea) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_usuario uuid;
BEGIN
  SELECT x.usuario_id INTO v_usuario FROM auth.sesion x
   WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours';
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN (
    SELECT x.tenant_activo FROM auth.sesion x
     WHERE x.usuario_id = v_usuario AND x.tenant_activo IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.membresia m
                    WHERE m.tenant_id = x.tenant_activo AND m.usuario_id = v_usuario
                      AND m.desactivada_en IS NULL)
     ORDER BY x.ultimo_uso DESC, x.id DESC
     LIMIT 1
  );
END
$$;--> statement-breakpoint

-- ===================================================================================================
-- Invitaciones (D7, D15). Viva = no aceptada, no revocada y vence_en > now(). Rechazo = cero filas o
-- 'invalida', sin efectos. Correo exacto (sin LIKE ni normalización en la BD).
-- ===================================================================================================

-- Consulta sin efectos (antes de Argon2): estudio, correo, rol y si el correo ya tiene cuenta.
CREATE OR REPLACE FUNCTION auth.invitacion_vigente(p_token_hash bytea)
  RETURNS TABLE (estudio_nombre text, correo text, rol text, cuenta_existe boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT t.nombre, i.correo, i.rol,
         EXISTS (SELECT 1 FROM public.usuario u WHERE u.email = i.correo)
    FROM public.invitacion i
    JOIN public.tenant t ON t.id = i.tenant_id
   WHERE i.token_hash = p_token_hash AND i.aceptada_en IS NULL AND i.revocada_en IS NULL
     AND i.vence_en > now();
$$;--> statement-breakpoint

-- CA-3: cuenta nueva. Bloquea la invitación (dos aceptaciones del mismo token -> una), crea usuario,
-- credencial y membresía y la marca aceptada, todo en la transacción del llamador. Si el correo ya tiene
-- cuenta: 'cuenta_existe' sin consumir (D15). Si otra invitación crea la misma cuenta a la vez, la perdedora
-- devuelve 'invalida' sin efectos y su token sigue vivo (para aceptar con sesión).
CREATE OR REPLACE FUNCTION auth.invitacion_aceptar_nueva(p_token_hash bytea, p_nombre text, p_hash text)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  i public.invitacion%ROWTYPE;
  v_usuario uuid;
BEGIN
  SELECT * INTO i FROM public.invitacion x
   WHERE x.token_hash = p_token_hash AND x.aceptada_en IS NULL AND x.revocada_en IS NULL
     AND x.vence_en > now()
   FOR UPDATE;
  IF NOT FOUND THEN
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

-- D15: cuenta existente con su sesión viva. El correo del usuario de la sesión debe ser exactamente el de la
-- invitación y no debe tener membresía previa en el estudio (ni desactivada). Nunca toca la contraseña.
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
ALTER FUNCTION auth.login_exito(bytea, uuid, text, bytea, uuid, text, bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.sesion_validar(bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.sesion_rotar(bytea, bytea, uuid) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.ultimo_estudio(bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.invitacion_vigente(bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.invitacion_aceptar_nueva(bytea, text, text) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.invitacion_aceptar_existente(bytea, bytea) OWNER TO contapp_auth;--> statement-breakpoint

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA auth FROM PUBLIC, contapp_worker, contapp_platform, contapp_app;--> statement-breakpoint
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO contapp_backend;
