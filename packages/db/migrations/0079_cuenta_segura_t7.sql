-- 0079_cuenta_segura_t7 (custom, spec 029, T7). Ajustes de 0078 que exige el contrato HTTP (T3) y el cambio de contraseña con TOTP.
-- Mismo patrón que 0078: funciones SECURITY DEFINER con dueño contapp_auth, search_path = pg_catalog, pg_temp, EXECUTE explícito solo a
-- contapp_backend. Repetible: CREATE OR REPLACE con la misma firma y GRANT/REVOKE idempotentes. No toca tablas.
--
--   * auth.login_exito: con TOTP activo la contraseña correcta NO reinicia el contador de 004 D7 (decisión de 0078: si lo reiniciara, cada
--     login daría otros cuatro intentos de código), pero tampoco cuenta como fallo: descuenta el intento que reservó `login_preparar`
--     (sin borrar los fallos previos). Sin esto, cada login bueno de una cuenta con TOTP sumaba un fallo y cinco logins buenos la bloqueaban.
--   * auth.intento_acierto (nueva): lo mismo para un acierto dentro de una sesión (`verificado` o `sin_factor`, nunca `pendiente`): la
--     contraseña correcta al enrolar, desactivar o regenerar, y el código correcto al confirmar, desactivar o regenerar. Cada intento se
--     reserva antes de evaluarse (CA-3) y solo el fallido queda contado.
--   * auth.contrasena_cambiar: la sesión rotada conserva el factor, el dispositivo y la red de la que cambia la contraseña (como
--     `sesion_rotar`); una `pendiente` no cambia la contraseña. Antes la nueva nacía `sin_factor`: con TOTP activo, Dueño o Administrador
--     quedaban con 403 `segundo_factor_requerido` y sin poder volver a verificar sin cerrar sesión.

-- La de 0078 (mismas columnas, orden de bloqueo y salida); solo cambia el contador cuando hay TOTP activo.
CREATE OR REPLACE FUNCTION auth.login_exito(
  p_clave bytea, p_usuario_id uuid, p_hash_verificado text, p_token_hash bytea, p_tenant_activo uuid,
  p_hash_nuevo text, p_token_anterior_hash bytea,
  p_factor text DEFAULT 'sin_factor', p_dispositivo text DEFAULT NULL, p_ip_red cidr DEFAULT NULL)
  RETURNS TABLE (sesion_id uuid, expira_absoluta timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_hash text;
  v_id uuid;
  v_expira timestamptz;
  v_totp boolean;
BEGIN
  IF p_factor IS NULL OR p_factor NOT IN ('sin_factor', 'pendiente') THEN
    RAISE EXCEPTION 'factor no permitido en login_exito' USING ERRCODE = '22023';
  END IF;
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
  v_totp := EXISTS (SELECT 1 FROM auth.totp t WHERE t.usuario_id = p_usuario_id AND t.activo_cifrado IS NOT NULL);
  IF NOT v_totp THEN
    UPDATE auth.intento_login i SET fallos = 0, ventana_inicio = now(), bloqueado_hasta = NULL
     WHERE i.clave = p_clave;
  ELSE
    -- La reserva de `login_preparar` acertó: se descuenta; si fue ella la que llegó a 5, el bloqueo se levanta (quedan < 5 fallos).
    UPDATE auth.intento_login i
       SET fallos = greatest(i.fallos - 1, 0),
           bloqueado_hasta = CASE WHEN i.fallos - 1 < 5 THEN NULL ELSE i.bloqueado_hasta END
     WHERE i.clave = p_clave AND i.fallos > 0;
  END IF;
  IF p_hash_nuevo IS NOT NULL THEN
    UPDATE auth.usuario_contrasena c SET hash = p_hash_nuevo, actualizada_en = now()
     WHERE c.usuario_id = p_usuario_id;
  END IF;
  IF p_token_anterior_hash IS NOT NULL THEN
    UPDATE auth.sesion x SET revocada_en = now(), motivo = 'rotacion'
     WHERE x.token_hash = p_token_anterior_hash AND x.revocada_en IS NULL;
  END IF;
  IF v_totp THEN
    INSERT INTO auth.sesion AS n (token_hash, usuario_id, tenant_activo, creada_en, ultimo_uso, expira_absoluta,
                                  factor, dispositivo, ip_red)
    VALUES (p_token_hash, p_usuario_id, NULL, now(), now(), now() + interval '5 minutes',
            'pendiente', p_dispositivo, p_ip_red)
    RETURNING n.id, n.expira_absoluta INTO v_id, v_expira;
  ELSE
    INSERT INTO auth.sesion AS n (token_hash, usuario_id, tenant_activo, creada_en, ultimo_uso, expira_absoluta,
                                  factor, dispositivo, ip_red)
    VALUES (p_token_hash, p_usuario_id, p_tenant_activo, now(), now(), now() + interval '12 hours',
            'sin_factor', p_dispositivo, p_ip_red)
    RETURNING n.id, n.expira_absoluta INTO v_id, v_expira;
  END IF;
  RETURN QUERY SELECT v_id, v_expira;
END
$$;--> statement-breakpoint

-- Un intento reservado (login_preparar o totp_intento_reservar) acertó dentro de una sesión vigente que no es `pendiente`: descuenta uno
-- del contador del dueño de la sesión (nunca baja de 0) y, si quedan menos de 5, levanta el bloqueo que esa reserva pudo poner. Con una
-- sesión que no sirve no hace nada. No toca la ventana ni el aviso.
CREATE OR REPLACE FUNCTION auth.intento_acierto(p_token_hash bytea)
  RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_usuario uuid;
  v_correo text;
BEGIN
  SELECT x.usuario_id INTO v_usuario FROM auth.sesion x
   WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours'
     AND x.factor <> 'pendiente';
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT u.email INTO v_correo FROM public.usuario u WHERE u.id = v_usuario;
  IF v_correo IS NULL THEN
    RETURN;
  END IF;
  UPDATE auth.intento_login i
     SET fallos = greatest(i.fallos - 1, 0),
         bloqueado_hasta = CASE WHEN i.fallos - 1 < 5 THEN NULL ELSE i.bloqueado_hasta END
   WHERE i.clave = sha256(convert_to(v_correo, 'UTF8')) AND i.fallos > 0;
END
$$;--> statement-breakpoint

-- La de 0008 (H1, H-r1b-2; mismo orden de bloqueo) con dos cambios: la sesión no puede ser `pendiente` y la nueva conserva factor,
-- dispositivo y red.
CREATE OR REPLACE FUNCTION auth.contrasena_cambiar(p_token_hash bytea, p_hash_nuevo text, p_token_hash_nuevo bytea)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  s auth.sesion%ROWTYPE;
  v_correo text;
BEGIN
  SELECT * INTO s FROM auth.sesion x
   WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours'
     AND x.factor <> 'pendiente'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  INSERT INTO auth.usuario_contrasena AS c (usuario_id, hash, actualizada_en)
  VALUES (s.usuario_id, p_hash_nuevo, now())
  ON CONFLICT (usuario_id) DO UPDATE SET hash = EXCLUDED.hash, actualizada_en = EXCLUDED.actualizada_en;
  UPDATE auth.sesion x SET revocada_en = now(), motivo = 'rotacion' WHERE x.id = s.id;
  UPDATE auth.sesion x SET revocada_en = now(), motivo = 'contrasena'
   WHERE x.usuario_id = s.usuario_id AND x.revocada_en IS NULL;
  INSERT INTO auth.sesion (token_hash, usuario_id, tenant_activo, creada_en, ultimo_uso, expira_absoluta,
                           factor, dispositivo, ip_red)
  VALUES (p_token_hash_nuevo, s.usuario_id, s.tenant_activo, s.creada_en, now(), s.expira_absoluta,
          s.factor, s.dispositivo, s.ip_red);
  UPDATE auth.token_recuperacion t SET invalidado_en = now()
   WHERE t.usuario_id = s.usuario_id AND t.usado_en IS NULL AND t.invalidado_en IS NULL;
  SELECT u.email INTO v_correo FROM public.usuario u WHERE u.id = s.usuario_id;
  UPDATE auth.intento_login i SET fallos = 0, ventana_inicio = now(), bloqueado_hasta = NULL
   WHERE i.clave = sha256(convert_to(v_correo, 'UTF8'));
  RETURN v_correo;
END
$$;--> statement-breakpoint

ALTER FUNCTION auth.login_exito(bytea, uuid, text, bytea, uuid, text, bytea, text, text, cidr) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.intento_acierto(bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.contrasena_cambiar(bytea, text, bytea) OWNER TO contapp_auth;--> statement-breakpoint

REVOKE ALL ON FUNCTION
  auth.login_exito(bytea, uuid, text, bytea, uuid, text, bytea, text, text, cidr),
  auth.intento_acierto(bytea),
  auth.contrasena_cambiar(bytea, text, bytea)
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_migrator;--> statement-breakpoint

GRANT EXECUTE ON FUNCTION
  auth.login_exito(bytea, uuid, text, bytea, uuid, text, bytea, text, text, cidr),
  auth.intento_acierto(bytea),
  auth.contrasena_cambiar(bytea, text, bytea)
  TO contapp_backend;
