-- 0080_cuenta_segura_r1 (custom, spec 029, T14). Correcciones de la ronda adversarial 1b (T13) en la BD. Mismo patrón que 0078/0079:
-- funciones SECURITY DEFINER con dueño contapp_auth, search_path = pg_catalog, pg_temp, REVOKE de PUBLIC y de cada rol antes del GRANT
-- explícito solo a contapp_backend. Repetible: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE con la misma firma y GRANT/REVOKE idempotentes.
-- No agrega funciones (FUNCIONES_AUTH no cambia; reaplicar 0008 no las alcanza).
--
--   * auth.intento_login.bloqueo_codigo_hasta: copia de `bloqueado_hasta` cuando el bloqueo lo puso un intento de CÓDIGO
--     (`totp_intento_reservar`). Un bloqueo es "de códigos" mientras ambos coinciden y sigue vigente; si `login_preparar` pone otro bloqueo,
--     `bloqueado_hasta` cambia y deja de serlo (sin tocar `login_preparar`). Sin GRANT nuevo: la tabla solo es de contapp_auth.
--   * auth.totp_intento_reservar: la de 0078 + la marca al bloquear (y la limpia al reiniciar la ventana).
--   * auth.recuperacion_consumir (CA-3, CA-4): restablecer la contraseña ya no borra el contador si el bloqueo vigente viene de códigos.
--     Lo levantaba a quien controla el correo, que podía volver a probar códigos. Si no, como en 004 (lo borra).
--   * auth.login_exito (CA-3): con TOTP activo, el descuento de la reserva de `login_preparar` no toca un bloqueo de códigos (la contraseña
--     correcta nunca levanta el bloqueo de 15 min que dejaron 5 códigos erróneos).
--   * auth.totp_confirmar (CA-1): exige que no haya TOTP activo (re-enrolar no reemplaza el secreto sin un código del vigente; el backend ya
--     responde 409 `totp_activo` al enrolar) y toma el bloqueo por usuario `auth.totp:<usuario>` antes de bloquear la sesión.
--   * auth.login_exito (U3): toma la fila del contador y luego el mismo bloqueo `auth.totp:<usuario>` ANTES de decidir si hay TOTP activo.
--     Así un login concurrente con la activación ve el TOTP ya confirmado y nace `pendiente` (antes podía nacer `sin_factor` después de que
--     totp_confirmar revocara las demás sesiones). Orden de bloqueo: credencial -> contador -> totp:<usuario> -> sesiones (confirmar no
--     toma credencial ni contador: sin ciclos).
--   * auth.plataforma_yo, auth.sesiones_cerrar_todas y auth.ultimo_estudio (CA-2): una sesión `pendiente` no sirve (0 filas, 0, NULL), como
--     en las funciones de 029. Mismos cuerpos que 0024, 0009 y 0013 con ese filtro.

ALTER TABLE auth.intento_login ADD COLUMN IF NOT EXISTS bloqueo_codigo_hasta timestamptz NULL;--> statement-breakpoint

-- La de 0078 (mismo orden de bloqueo: sesión -> contador) + la marca del bloqueo de códigos.
CREATE OR REPLACE FUNCTION auth.totp_intento_reservar(p_token_hash bytea)
  RETURNS TABLE (permitido boolean, usuario_id uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  s auth.sesion%ROWTYPE;
  f auth.intento_login%ROWTYPE;
  v_correo text;
  v_clave bytea;
BEGIN
  SELECT * INTO s FROM auth.sesion x
   WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours'
     AND (x.factor <> 'pendiente' OR x.creada_en > now() - interval '5 minutes')
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT u.email INTO v_correo FROM public.usuario u WHERE u.id = s.usuario_id;
  v_clave := sha256(convert_to(v_correo, 'UTF8'));
  INSERT INTO auth.intento_login (clave, fallos, ventana_inicio) VALUES (v_clave, 0, now())
  ON CONFLICT (clave) DO NOTHING;
  SELECT * INTO f FROM auth.intento_login i WHERE i.clave = v_clave FOR UPDATE;

  IF f.bloqueado_hasta IS NOT NULL AND f.bloqueado_hasta > now() THEN
    IF s.factor = 'pendiente' THEN
      UPDATE auth.sesion x SET revocada_en = now(), motivo = 'totp' WHERE x.id = s.id;
    END IF;
    RETURN QUERY SELECT false, s.usuario_id;
    RETURN;
  END IF;
  IF f.bloqueado_hasta IS NOT NULL OR f.ventana_inicio <= now() - interval '15 minutes' THEN
    f.fallos := 0;
    f.ventana_inicio := now();
    f.bloqueado_hasta := NULL;
    f.bloqueo_codigo_hasta := NULL;
  END IF;
  f.fallos := f.fallos + 1;
  IF f.fallos >= 5 THEN
    f.bloqueado_hasta := now() + interval '15 minutes';
    f.bloqueo_codigo_hasta := f.bloqueado_hasta;
    IF s.factor = 'pendiente' THEN
      UPDATE auth.sesion x SET revocada_en = now(), motivo = 'totp' WHERE x.id = s.id;
    END IF;
  END IF;
  UPDATE auth.intento_login i
     SET fallos = f.fallos, ventana_inicio = f.ventana_inicio, bloqueado_hasta = f.bloqueado_hasta,
         bloqueo_codigo_hasta = f.bloqueo_codigo_hasta
   WHERE i.clave = v_clave;
  RETURN QUERY SELECT true, s.usuario_id;
END
$$;--> statement-breakpoint

-- La de 0007 (D8, CA-6, CA-8) salvo el bloqueo de códigos vigente, que se conserva.
CREATE OR REPLACE FUNCTION auth.recuperacion_consumir(p_token_hash bytea, p_hash_nuevo text)
  RETURNS TABLE (usuario_id uuid, correo text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_usuario uuid;
  v_correo text;
BEGIN
  UPDATE auth.token_recuperacion t SET usado_en = now()
   WHERE t.token_hash = p_token_hash AND t.usado_en IS NULL AND t.invalidado_en IS NULL
     AND t.expira_en > now()
  RETURNING t.usuario_id INTO v_usuario;
  IF v_usuario IS NULL THEN
    RETURN;
  END IF;
  SELECT u.email INTO v_correo FROM public.usuario u WHERE u.id = v_usuario;
  INSERT INTO auth.usuario_contrasena AS c (usuario_id, hash, actualizada_en)
  VALUES (v_usuario, p_hash_nuevo, now())
  ON CONFLICT (usuario_id) DO UPDATE SET hash = EXCLUDED.hash, actualizada_en = EXCLUDED.actualizada_en;
  UPDATE auth.sesion x SET revocada_en = now(), motivo = 'restablecer'
   WHERE x.usuario_id = v_usuario AND x.revocada_en IS NULL;
  DELETE FROM auth.intento_login i
   WHERE i.clave = sha256(convert_to(v_correo, 'UTF8'))
     AND NOT coalesce(i.bloqueado_hasta > now() AND i.bloqueo_codigo_hasta = i.bloqueado_hasta, false);
  UPDATE auth.token_recuperacion t SET invalidado_en = now()
   WHERE t.usuario_id = v_usuario AND t.usado_en IS NULL AND t.invalidado_en IS NULL;
  RETURN QUERY SELECT v_usuario, v_correo;
END
$$;--> statement-breakpoint

-- La de 0079 (mismas columnas y salida); cambia el orden: contador y bloqueo por usuario antes de leer si hay TOTP activo.
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
  PERFORM 1 FROM auth.intento_login i WHERE i.clave = p_clave FOR UPDATE;
  -- Serializa con totp_confirmar: lo que se lee después ya incluye una activación confirmada.
  PERFORM pg_advisory_xact_lock(hashtextextended('auth.totp:' || p_usuario_id::text, 0));
  v_totp := EXISTS (SELECT 1 FROM auth.totp t WHERE t.usuario_id = p_usuario_id AND t.activo_cifrado IS NOT NULL);
  IF NOT v_totp THEN
    UPDATE auth.intento_login i SET fallos = 0, ventana_inicio = now(), bloqueado_hasta = NULL
     WHERE i.clave = p_clave;
  ELSE
    -- La reserva de `login_preparar` acertó: se descuenta; si fue ella la que llegó a 5, el bloqueo se levanta (quedan < 5 fallos).
    -- Un bloqueo vigente de códigos no se toca: la contraseña correcta no es el segundo factor.
    UPDATE auth.intento_login i
       SET fallos = greatest(i.fallos - 1, 0),
           bloqueado_hasta = CASE WHEN i.fallos - 1 < 5 THEN NULL ELSE i.bloqueado_hasta END
     WHERE i.clave = p_clave AND i.fallos > 0
       AND NOT coalesce(i.bloqueado_hasta > now() AND i.bloqueo_codigo_hasta = i.bloqueado_hasta, false);
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

-- La de 0078 con dos cambios: el bloqueo `auth.totp:<usuario>` antes de la fila de la sesión y solo sin TOTP activo.
CREATE OR REPLACE FUNCTION auth.totp_confirmar(p_token_hash bytea, p_paso bigint, p_hashes bytea[],
                                               p_token_hash_nuevo bytea)
  RETURNS TABLE (sesion_id uuid, expira_absoluta timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  s auth.sesion%ROWTYPE;
  v_usuario uuid;
  v_id uuid;
BEGIN
  IF p_hashes IS NULL OR cardinality(p_hashes) <> 10
     OR (SELECT count(DISTINCT h) FROM unnest(p_hashes) AS h WHERE h IS NOT NULL AND octet_length(h) = 32) <> 10 THEN
    RAISE EXCEPTION 'se esperan 10 codigos de recuperacion distintos' USING ERRCODE = '22023';
  END IF;
  SELECT x.usuario_id INTO v_usuario FROM auth.sesion x
   WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours'
     AND x.factor IN ('verificado', 'sin_factor');
  IF NOT FOUND THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('auth.totp:' || v_usuario::text, 0));
  SELECT * INTO s FROM auth.sesion x
   WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours'
     AND x.factor IN ('verificado', 'sin_factor')
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  UPDATE auth.totp t
     SET activo_cifrado = t.pendiente_cifrado, activo_version = t.pendiente_version, activado_en = now(),
         pendiente_cifrado = NULL, pendiente_version = NULL, pendiente_expira = NULL, ultimo_paso = p_paso
   WHERE t.usuario_id = s.usuario_id AND t.activo_cifrado IS NULL
     AND t.pendiente_cifrado IS NOT NULL AND t.pendiente_expira > now() AND t.ultimo_paso < p_paso;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  DELETE FROM auth.totp_recuperacion r WHERE r.usuario_id = s.usuario_id;
  INSERT INTO auth.totp_recuperacion (usuario_id, hash) SELECT s.usuario_id, h FROM unnest(p_hashes) AS h;
  INSERT INTO auth.cuenta_evento (usuario_id, tipo) VALUES (s.usuario_id, 'totp_activado');
  UPDATE auth.sesion x SET revocada_en = now(), motivo = 'totp'
   WHERE x.usuario_id = s.usuario_id AND x.revocada_en IS NULL AND x.id <> s.id;
  UPDATE auth.sesion x SET revocada_en = now(), motivo = 'rotacion' WHERE x.id = s.id;
  INSERT INTO auth.sesion AS n (token_hash, usuario_id, tenant_activo, creada_en, ultimo_uso, expira_absoluta,
                                factor, dispositivo, ip_red)
  VALUES (p_token_hash_nuevo, s.usuario_id, s.tenant_activo, s.creada_en, now(), s.expira_absoluta,
          'verificado', s.dispositivo, s.ip_red)
  RETURNING n.id INTO v_id;
  RETURN QUERY SELECT v_id, s.expira_absoluta;
END
$$;--> statement-breakpoint

-- La de 0024 sin `pendiente`.
CREATE OR REPLACE FUNCTION auth.plataforma_yo(p_token_hash bytea) RETURNS TABLE (usuario_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT x.usuario_id FROM auth.sesion x JOIN public.admin_plataforma a ON a.usuario_id = x.usuario_id
   WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours'
     AND x.factor <> 'pendiente';
$$;--> statement-breakpoint

-- La de 0009 (bloqueo por usuario antes de revocar) sin `pendiente`.
CREATE OR REPLACE FUNCTION auth.sesiones_cerrar_todas(p_token_hash bytea) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_usuario uuid;
  v_n integer;
BEGIN
  SELECT x.usuario_id INTO v_usuario FROM auth.sesion x
   WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours'
     AND x.factor <> 'pendiente';
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('auth.sesiones:' || v_usuario::text, 0));
  UPDATE auth.sesion x SET revocada_en = now(), motivo = 'cerrar_todas'
   WHERE x.usuario_id = v_usuario AND x.revocada_en IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;--> statement-breakpoint

-- La de 0013 (membresía ACTIVA) sin `pendiente`.
CREATE OR REPLACE FUNCTION auth.ultimo_estudio(p_token_hash bytea) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_usuario uuid;
BEGIN
  SELECT x.usuario_id INTO v_usuario FROM auth.sesion x
   WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours'
     AND x.factor <> 'pendiente';
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

ALTER FUNCTION auth.totp_intento_reservar(bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.recuperacion_consumir(bytea, text) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.login_exito(bytea, uuid, text, bytea, uuid, text, bytea, text, text, cidr) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.totp_confirmar(bytea, bigint, bytea[], bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.plataforma_yo(bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.sesiones_cerrar_todas(bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.ultimo_estudio(bytea) OWNER TO contapp_auth;--> statement-breakpoint

REVOKE ALL ON FUNCTION
  auth.totp_intento_reservar(bytea),
  auth.recuperacion_consumir(bytea, text),
  auth.login_exito(bytea, uuid, text, bytea, uuid, text, bytea, text, text, cidr),
  auth.totp_confirmar(bytea, bigint, bytea[], bytea),
  auth.plataforma_yo(bytea),
  auth.sesiones_cerrar_todas(bytea),
  auth.ultimo_estudio(bytea)
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_migrator;--> statement-breakpoint

GRANT EXECUTE ON FUNCTION
  auth.totp_intento_reservar(bytea),
  auth.recuperacion_consumir(bytea, text),
  auth.login_exito(bytea, uuid, text, bytea, uuid, text, bytea, text, text, cidr),
  auth.totp_confirmar(bytea, bigint, bytea[], bytea),
  auth.plataforma_yo(bytea),
  auth.sesiones_cerrar_todas(bytea),
  auth.ultimo_estudio(bytea)
  TO contapp_backend;
