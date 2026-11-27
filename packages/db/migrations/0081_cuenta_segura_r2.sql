-- 0081_cuenta_segura_r2 (custom, spec 029, T16). Correcciones de la ronda adversarial 2 (T15) en la BD. Mismo patrón que 0078-0080:
-- funciones SECURITY DEFINER con dueño contapp_auth, search_path = pg_catalog, pg_temp, REVOKE de PUBLIC y de cada rol antes del GRANT
-- explícito (contapp_backend; totp_restablecer solo contapp_migrator). Repetible: ADD COLUMN IF NOT EXISTS, DROP ... IF EXISTS de la firma
-- vieja, CREATE OR REPLACE y GRANT/REVOKE idempotentes. No agrega nombres de función (FUNCIONES_AUTH no cambia): totp_confirmar cambia de
-- firma (un 5.º parámetro con DEFAULT NULL; las llamadas de 4 argumentos siguen resolviendo a ella).
--
--   * CA-3 (contador frente a la contraseña). auth.intento_login lleva los fallos de CÓDIGO de la ventana vigente: `fallos_codigo` vale
--     mientras `codigo_ventana` = `ventana_inicio` (todo reinicio de la ventana pone otro `ventana_inicio`, así que nadie más tiene que
--     limpiarlo). totp_intento_reservar los suma; intento_acierto los mantiene <= fallos. contrasena_cambiar y recuperacion_consumir ya no
--     borran el contador cuando hay fallos de código: conservan un bloqueo vigente de códigos y, si no lo hay, dejan solo los fallos de
--     código (levantan el de contraseña). login_exito con TOTP activo descuenta su reserva solo si hay fallos que no son de código.
--   * U3, U5 (sesiones escritas sin el bloqueo `auth.totp:<usuario>`). Toda función que escribe sesiones del usuario o su fila de auth.totp
--     toma ese bloqueo: sesion_rotar, contrasena_cambiar, recuperacion_consumir, totp_verificar_exito, totp_recuperacion_usar,
--     totp_desactivar, totp_recuperacion_regenerar, totp_restablecer, sesion_revocar_id, sesiones_revocar_otras y sesiones_cerrar_todas
--     (login_exito y totp_confirmar ya lo tomaban, 0080). Así una rotación, un cambio de contraseña o un paso de `pendiente` a `verificado`
--     no deja viva una sesión que una activación, un restablecimiento o una revocación concurrente no vio.
--     Orden de bloqueo fijo (sin ciclos): `auth.sesiones:<usuario>` -> credencial -> contador -> `auth.totp:<usuario>` -> filas de sesión
--     -> fila de auth.totp y códigos. Por eso totp_intento_reservar, totp_verificar_exito y totp_recuperacion_usar ahora toman el contador
--     ANTES de bloquear la sesión, contrasena_cambiar la credencial y el contador antes de la sesión, y totp_restablecer revoca las sesiones
--     antes de borrar la fila de TOTP. Tras los bloqueos la sesión se vuelve a leer con una instantánea nueva.
--   * CA-1 (re-enrolamiento entre la evaluación y la confirmación). totp_confirmar recibe el pendiente cifrado que el backend evaluó y solo
--     confirma si sigue siendo el vigente. Sin él (llamadas de 4 argumentos) solo confirma un pendiente que no reemplazó a otro vigente:
--     totp_enrolar_iniciar marca `auth.totp.pendiente_reemplazado`.

ALTER TABLE auth.intento_login ADD COLUMN IF NOT EXISTS fallos_codigo integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE auth.intento_login ADD COLUMN IF NOT EXISTS codigo_ventana timestamptz NULL;--> statement-breakpoint
ALTER TABLE auth.totp ADD COLUMN IF NOT EXISTS pendiente_reemplazado boolean NOT NULL DEFAULT false;--> statement-breakpoint

-- La de 0080 con el orden contador -> sesión (antes sesión -> contador) y los fallos de código de la ventana.
CREATE OR REPLACE FUNCTION auth.totp_intento_reservar(p_token_hash bytea)
  RETURNS TABLE (permitido boolean, usuario_id uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  s auth.sesion%ROWTYPE;
  f auth.intento_login%ROWTYPE;
  v_usuario uuid;
  v_correo text;
  v_clave bytea;
BEGIN
  SELECT x.usuario_id INTO v_usuario FROM auth.sesion x
   WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours'
     AND (x.factor <> 'pendiente' OR x.creada_en > now() - interval '5 minutes');
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT u.email INTO v_correo FROM public.usuario u WHERE u.id = v_usuario;
  v_clave := sha256(convert_to(v_correo, 'UTF8'));
  INSERT INTO auth.intento_login (clave, fallos, ventana_inicio) VALUES (v_clave, 0, now())
  ON CONFLICT (clave) DO NOTHING;
  SELECT * INTO f FROM auth.intento_login i WHERE i.clave = v_clave FOR UPDATE;
  SELECT * INTO s FROM auth.sesion x
   WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours'
     AND (x.factor <> 'pendiente' OR x.creada_en > now() - interval '5 minutes')
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

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
  IF f.codigo_ventana IS DISTINCT FROM f.ventana_inicio THEN
    f.fallos_codigo := 0;
    f.codigo_ventana := f.ventana_inicio;
  END IF;
  f.fallos := f.fallos + 1;
  f.fallos_codigo := f.fallos_codigo + 1;
  IF f.fallos >= 5 THEN
    f.bloqueado_hasta := now() + interval '15 minutes';
    f.bloqueo_codigo_hasta := f.bloqueado_hasta;
    IF s.factor = 'pendiente' THEN
      UPDATE auth.sesion x SET revocada_en = now(), motivo = 'totp' WHERE x.id = s.id;
    END IF;
  END IF;
  UPDATE auth.intento_login i
     SET fallos = f.fallos, ventana_inicio = f.ventana_inicio, bloqueado_hasta = f.bloqueado_hasta,
         bloqueo_codigo_hasta = f.bloqueo_codigo_hasta, fallos_codigo = f.fallos_codigo, codigo_ventana = f.codigo_ventana
   WHERE i.clave = v_clave;
  RETURN QUERY SELECT true, s.usuario_id;
END
$$;--> statement-breakpoint

-- La de 0079: además mantiene fallos_codigo <= fallos (un acierto de código descuenta uno de código).
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
         fallos_codigo = least(i.fallos_codigo, greatest(i.fallos - 1, 0)),
         bloqueado_hasta = CASE WHEN i.fallos - 1 < 5 THEN NULL ELSE i.bloqueado_hasta END
   WHERE i.clave = sha256(convert_to(v_correo, 'UTF8')) AND i.fallos > 0;
END
$$;--> statement-breakpoint

-- La de 0080; con TOTP activo, el descuento de la reserva de `login_preparar` no toca los fallos de código de la ventana.
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
    -- La reserva de `login_preparar` acertó: se descuenta (si fue ella la que llegó a 5, el bloqueo se levanta). Un bloqueo vigente de
    -- códigos no se toca y los fallos de código de la ventana tampoco: la contraseña correcta no es el segundo factor.
    UPDATE auth.intento_login i
       SET fallos = greatest(i.fallos - 1, 0),
           bloqueado_hasta = CASE WHEN i.fallos - 1 < 5 THEN NULL ELSE i.bloqueado_hasta END
     WHERE i.clave = p_clave
       AND i.fallos > CASE WHEN i.codigo_ventana = i.ventana_inicio THEN i.fallos_codigo ELSE 0 END
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

-- La de 0080 (D8, CA-6, CA-8) con el orden credencial -> contador -> totp:<usuario> -> sesiones. Si hay fallos de código en la ventana
-- vigente, el contador no se borra: un bloqueo vigente de códigos queda intacto y, si no lo hay, quedan solo los fallos de código.
CREATE OR REPLACE FUNCTION auth.recuperacion_consumir(p_token_hash bytea, p_hash_nuevo text)
  RETURNS TABLE (usuario_id uuid, correo text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_usuario uuid;
  v_correo text;
  v_clave bytea;
  f auth.intento_login%ROWTYPE;
  v_codigo integer;
BEGIN
  UPDATE auth.token_recuperacion t SET usado_en = now()
   WHERE t.token_hash = p_token_hash AND t.usado_en IS NULL AND t.invalidado_en IS NULL
     AND t.expira_en > now()
  RETURNING t.usuario_id INTO v_usuario;
  IF v_usuario IS NULL THEN
    RETURN;
  END IF;
  SELECT u.email INTO v_correo FROM public.usuario u WHERE u.id = v_usuario;
  v_clave := sha256(convert_to(v_correo, 'UTF8'));
  INSERT INTO auth.usuario_contrasena AS c (usuario_id, hash, actualizada_en)
  VALUES (v_usuario, p_hash_nuevo, now())
  ON CONFLICT (usuario_id) DO UPDATE SET hash = EXCLUDED.hash, actualizada_en = EXCLUDED.actualizada_en;
  SELECT * INTO f FROM auth.intento_login i WHERE i.clave = v_clave FOR UPDATE;
  IF FOUND THEN
    v_codigo := CASE WHEN f.codigo_ventana = f.ventana_inicio AND f.ventana_inicio > now() - interval '15 minutes'
                     THEN least(f.fallos_codigo, f.fallos) ELSE 0 END;
    IF coalesce(f.bloqueado_hasta > now() AND f.bloqueo_codigo_hasta = f.bloqueado_hasta, false) THEN
      NULL;
    ELSIF v_codigo > 0 THEN
      UPDATE auth.intento_login i SET fallos = v_codigo, fallos_codigo = v_codigo, bloqueado_hasta = NULL
       WHERE i.clave = v_clave;
    ELSE
      DELETE FROM auth.intento_login i WHERE i.clave = v_clave;
    END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('auth.totp:' || v_usuario::text, 0));
  UPDATE auth.sesion x SET revocada_en = now(), motivo = 'restablecer'
   WHERE x.usuario_id = v_usuario AND x.revocada_en IS NULL;
  UPDATE auth.token_recuperacion t SET invalidado_en = now()
   WHERE t.usuario_id = v_usuario AND t.usado_en IS NULL AND t.invalidado_en IS NULL;
  RETURN QUERY SELECT v_usuario, v_correo;
END
$$;--> statement-breakpoint

-- La de 0079 con el orden credencial -> contador -> totp:<usuario> -> sesión (antes sesión -> credencial) y el contador como
-- recuperacion_consumir: con fallos de código en la ventana vigente no se reinicia (un bloqueo vigente de códigos queda intacto).
CREATE OR REPLACE FUNCTION auth.contrasena_cambiar(p_token_hash bytea, p_hash_nuevo text, p_token_hash_nuevo bytea)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  s auth.sesion%ROWTYPE;
  f auth.intento_login%ROWTYPE;
  v_usuario uuid;
  v_correo text;
  v_clave bytea;
  v_contador boolean;
  v_codigo integer;
BEGIN
  SELECT x.usuario_id INTO v_usuario FROM auth.sesion x
   WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours'
     AND x.factor <> 'pendiente';
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT u.email INTO v_correo FROM public.usuario u WHERE u.id = v_usuario;
  v_clave := sha256(convert_to(v_correo, 'UTF8'));
  PERFORM 1 FROM auth.usuario_contrasena c WHERE c.usuario_id = v_usuario FOR NO KEY UPDATE;
  SELECT * INTO f FROM auth.intento_login i WHERE i.clave = v_clave FOR UPDATE;
  v_contador := FOUND;
  PERFORM pg_advisory_xact_lock(hashtextextended('auth.totp:' || v_usuario::text, 0));
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
  IF v_contador THEN
    v_codigo := CASE WHEN f.codigo_ventana = f.ventana_inicio AND f.ventana_inicio > now() - interval '15 minutes'
                     THEN least(f.fallos_codigo, f.fallos) ELSE 0 END;
    IF coalesce(f.bloqueado_hasta > now() AND f.bloqueo_codigo_hasta = f.bloqueado_hasta, false) THEN
      NULL;
    ELSIF v_codigo > 0 THEN
      UPDATE auth.intento_login i SET fallos = v_codigo, fallos_codigo = v_codigo, bloqueado_hasta = NULL
       WHERE i.clave = v_clave;
    ELSE
      UPDATE auth.intento_login i SET fallos = 0, ventana_inicio = now(), bloqueado_hasta = NULL
       WHERE i.clave = v_clave;
    END IF;
  END IF;
  RETURN v_correo;
END
$$;--> statement-breakpoint

-- La de 0078 + el bloqueo `auth.totp:<usuario>` después de la credencial (U3, U5).
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
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours'
     AND x.factor <> 'pendiente';
  IF NOT FOUND THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('auth.sesiones:' || v_usuario::text, 0));
  PERFORM 1 FROM auth.usuario_contrasena c WHERE c.usuario_id = v_usuario FOR SHARE;
  PERFORM pg_advisory_xact_lock(hashtextextended('auth.totp:' || v_usuario::text, 0));
  SELECT * INTO s FROM auth.sesion x
   WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours'
     AND x.factor <> 'pendiente'
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
  INSERT INTO auth.sesion AS n (token_hash, usuario_id, tenant_activo, creada_en, ultimo_uso, expira_absoluta,
                                factor, dispositivo, ip_red)
  VALUES (p_token_hash_nuevo, s.usuario_id, p_tenant_nuevo, s.creada_en, now(), s.expira_absoluta,
          s.factor, s.dispositivo, s.ip_red)
  RETURNING n.id INTO v_id;
  RETURN QUERY SELECT v_id, s.expira_absoluta;
END
$$;--> statement-breakpoint

-- La de 0078 (CA-1) + `pendiente_reemplazado`: true si este pendiente reemplaza a otro todavía vigente.
CREATE OR REPLACE FUNCTION auth.totp_enrolar_iniciar(p_usuario_id uuid, p_cifrado bytea, p_version integer)
  RETURNS timestamptz
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_expira timestamptz;
BEGIN
  IF p_usuario_id IS NULL OR p_cifrado IS NULL OR octet_length(p_cifrado) NOT BETWEEN 1 AND 256
     OR p_version IS NULL OR p_version <= 0 THEN
    RAISE EXCEPTION 'argumentos invalidos en totp_enrolar_iniciar' USING ERRCODE = '22023';
  END IF;
  INSERT INTO auth.totp AS t (usuario_id, pendiente_cifrado, pendiente_version, pendiente_expira, pendiente_reemplazado)
  VALUES (p_usuario_id, p_cifrado, p_version, now() + interval '10 minutes', false)
  ON CONFLICT (usuario_id) DO UPDATE SET
    pendiente_cifrado = EXCLUDED.pendiente_cifrado,
    pendiente_version = EXCLUDED.pendiente_version,
    pendiente_expira = EXCLUDED.pendiente_expira,
    pendiente_reemplazado = (t.pendiente_cifrado IS NOT NULL AND t.pendiente_expira > now())
  RETURNING t.pendiente_expira INTO v_expira;
  RETURN v_expira;
END
$$;--> statement-breakpoint

-- La de 0078 con el orden contador -> totp:<usuario> -> sesión (U5: serializa con totp_restablecer).
CREATE OR REPLACE FUNCTION auth.totp_verificar_exito(p_token_hash bytea, p_paso bigint, p_token_hash_nuevo bytea,
                                                     p_tenant_nuevo uuid)
  RETURNS TABLE (sesion_id uuid, expira_absoluta timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  s auth.sesion%ROWTYPE;
  v_usuario uuid;
  v_correo text;
  v_id uuid;
  v_expira timestamptz;
BEGIN
  SELECT x.usuario_id INTO v_usuario FROM auth.sesion x
   WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours'
     AND x.factor = 'pendiente' AND x.creada_en > now() - interval '5 minutes';
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT u.email INTO v_correo FROM public.usuario u WHERE u.id = v_usuario;
  PERFORM 1 FROM auth.intento_login i WHERE i.clave = sha256(convert_to(v_correo, 'UTF8')) FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended('auth.totp:' || v_usuario::text, 0));
  SELECT * INTO s FROM auth.sesion x
   WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours'
     AND x.factor = 'pendiente' AND x.creada_en > now() - interval '5 minutes'
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
  UPDATE auth.totp t SET ultimo_paso = p_paso
   WHERE t.usuario_id = s.usuario_id AND t.activo_cifrado IS NOT NULL AND t.ultimo_paso < p_paso;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  UPDATE auth.intento_login i SET fallos = 0, ventana_inicio = now(), bloqueado_hasta = NULL
   WHERE i.clave = sha256(convert_to(v_correo, 'UTF8'));
  UPDATE auth.sesion x SET revocada_en = now(), motivo = 'rotacion' WHERE x.id = s.id;
  INSERT INTO auth.sesion AS n (token_hash, usuario_id, tenant_activo, creada_en, ultimo_uso, expira_absoluta,
                                factor, dispositivo, ip_red)
  VALUES (p_token_hash_nuevo, s.usuario_id, p_tenant_nuevo, now(), now(), now() + interval '12 hours',
          'verificado', s.dispositivo, s.ip_red)
  RETURNING n.id, n.expira_absoluta INTO v_id, v_expira;
  RETURN QUERY SELECT v_id, v_expira;
END
$$;--> statement-breakpoint

-- La de 0078 con el mismo orden que totp_verificar_exito.
CREATE OR REPLACE FUNCTION auth.totp_recuperacion_usar(p_token_hash bytea, p_hash bytea, p_token_hash_nuevo bytea,
                                                       p_tenant_nuevo uuid)
  RETURNS TABLE (sesion_id uuid, expira_absoluta timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  s auth.sesion%ROWTYPE;
  v_usuario uuid;
  v_correo text;
  v_id uuid;
  v_expira timestamptz;
BEGIN
  SELECT x.usuario_id INTO v_usuario FROM auth.sesion x
   WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours'
     AND x.factor = 'pendiente' AND x.creada_en > now() - interval '5 minutes';
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT u.email INTO v_correo FROM public.usuario u WHERE u.id = v_usuario;
  PERFORM 1 FROM auth.intento_login i WHERE i.clave = sha256(convert_to(v_correo, 'UTF8')) FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended('auth.totp:' || v_usuario::text, 0));
  SELECT * INTO s FROM auth.sesion x
   WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours'
     AND x.factor = 'pendiente' AND x.creada_en > now() - interval '5 minutes'
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
  IF NOT EXISTS (SELECT 1 FROM auth.totp t WHERE t.usuario_id = s.usuario_id AND t.activo_cifrado IS NOT NULL) THEN
    RETURN;
  END IF;
  UPDATE auth.totp_recuperacion r SET usado_en = now()
   WHERE r.usuario_id = s.usuario_id AND r.hash = p_hash AND r.usado_en IS NULL;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  INSERT INTO auth.cuenta_evento (usuario_id, tipo) VALUES (s.usuario_id, 'recuperacion_usada');
  UPDATE auth.intento_login i SET fallos = 0, ventana_inicio = now(), bloqueado_hasta = NULL
   WHERE i.clave = sha256(convert_to(v_correo, 'UTF8'));
  UPDATE auth.sesion x SET revocada_en = now(), motivo = 'rotacion' WHERE x.id = s.id;
  INSERT INTO auth.sesion AS n (token_hash, usuario_id, tenant_activo, creada_en, ultimo_uso, expira_absoluta,
                                factor, dispositivo, ip_red)
  VALUES (p_token_hash_nuevo, s.usuario_id, p_tenant_nuevo, now(), now(), now() + interval '12 hours',
          'verificado', s.dispositivo, s.ip_red)
  RETURNING n.id, n.expira_absoluta INTO v_id, v_expira;
  RETURN QUERY SELECT v_id, v_expira;
END
$$;--> statement-breakpoint

-- La de 0080 (CA-1, U3) ligada al pendiente evaluado: con p_pendiente_cifrado, solo si sigue siendo el vigente; sin él (4 argumentos),
-- solo un pendiente que no reemplazó a otro vigente. Firma nueva: se quita la de 4 parámetros (mismo nombre, mismos permisos).
DROP FUNCTION IF EXISTS auth.totp_confirmar(bytea, bigint, bytea[], bytea);--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth.totp_confirmar(p_token_hash bytea, p_paso bigint, p_hashes bytea[],
                                               p_token_hash_nuevo bytea, p_pendiente_cifrado bytea DEFAULT NULL)
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
         pendiente_cifrado = NULL, pendiente_version = NULL, pendiente_expira = NULL, pendiente_reemplazado = false,
         ultimo_paso = p_paso
   WHERE t.usuario_id = s.usuario_id AND t.activo_cifrado IS NULL
     AND t.pendiente_cifrado IS NOT NULL AND t.pendiente_expira > now() AND t.ultimo_paso < p_paso
     AND CASE WHEN p_pendiente_cifrado IS NULL THEN NOT t.pendiente_reemplazado
              ELSE t.pendiente_cifrado = p_pendiente_cifrado END;
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

-- La de 0078 + el bloqueo `auth.totp:<usuario>` antes de la fila de la sesión.
CREATE OR REPLACE FUNCTION auth.totp_desactivar(p_token_hash bytea, p_paso bigint)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  s auth.sesion%ROWTYPE;
  t auth.totp%ROWTYPE;
  v_usuario uuid;
BEGIN
  SELECT x.usuario_id INTO v_usuario FROM auth.sesion x
   WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours'
     AND x.factor = 'verificado';
  IF NOT FOUND THEN
    RETURN 'invalido';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('auth.totp:' || v_usuario::text, 0));
  SELECT * INTO s FROM auth.sesion x
   WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours'
     AND x.factor = 'verificado'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'invalido';
  END IF;
  SELECT * INTO t FROM auth.totp y WHERE y.usuario_id = s.usuario_id AND y.activo_cifrado IS NOT NULL FOR UPDATE;
  IF NOT FOUND OR p_paso IS NULL OR t.ultimo_paso >= p_paso THEN
    RETURN 'invalido';
  END IF;
  IF EXISTS (SELECT 1 FROM public.admin_plataforma a WHERE a.usuario_id = s.usuario_id)
     OR EXISTS (SELECT 1 FROM public.membresia m
                 WHERE m.usuario_id = s.usuario_id AND m.desactivada_en IS NULL AND m.rol IN ('dueno', 'admin')) THEN
    RETURN 'exigido';
  END IF;
  DELETE FROM auth.totp_recuperacion r WHERE r.usuario_id = s.usuario_id;
  DELETE FROM auth.totp y WHERE y.usuario_id = s.usuario_id;
  INSERT INTO auth.cuenta_evento (usuario_id, tipo) VALUES (s.usuario_id, 'totp_desactivado');
  UPDATE auth.sesion x SET revocada_en = now(), motivo = 'totp'
   WHERE x.usuario_id = s.usuario_id AND x.revocada_en IS NULL AND x.id <> s.id;
  UPDATE auth.sesion x SET factor = 'sin_factor' WHERE x.id = s.id;
  RETURN 'desactivado';
END
$$;--> statement-breakpoint

-- La de 0078 + el bloqueo `auth.totp:<usuario>` antes de la fila de la sesión (escribe la fila de TOTP).
CREATE OR REPLACE FUNCTION auth.totp_recuperacion_regenerar(p_token_hash bytea, p_paso bigint, p_hashes bytea[])
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  s auth.sesion%ROWTYPE;
  v_usuario uuid;
BEGIN
  IF p_hashes IS NULL OR cardinality(p_hashes) <> 10
     OR (SELECT count(DISTINCT h) FROM unnest(p_hashes) AS h WHERE h IS NOT NULL AND octet_length(h) = 32) <> 10 THEN
    RAISE EXCEPTION 'se esperan 10 codigos de recuperacion distintos' USING ERRCODE = '22023';
  END IF;
  SELECT x.usuario_id INTO v_usuario FROM auth.sesion x
   WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours'
     AND x.factor = 'verificado';
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('auth.totp:' || v_usuario::text, 0));
  SELECT * INTO s FROM auth.sesion x
   WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours'
     AND x.factor = 'verificado'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE auth.totp t SET ultimo_paso = p_paso
   WHERE t.usuario_id = s.usuario_id AND t.activo_cifrado IS NOT NULL AND t.ultimo_paso < p_paso;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  DELETE FROM auth.totp_recuperacion r WHERE r.usuario_id = s.usuario_id;
  INSERT INTO auth.totp_recuperacion (usuario_id, hash) SELECT s.usuario_id, h FROM unnest(p_hashes) AS h;
  INSERT INTO auth.cuenta_evento (usuario_id, tipo) VALUES (s.usuario_id, 'recuperacion_regenerada');
  RETURN true;
END
$$;--> statement-breakpoint

-- La de 0078 (U5) con el bloqueo `auth.totp:<usuario>`: revoca las sesiones ANTES de borrar la fila de TOTP (orden sesión -> totp).
CREATE OR REPLACE FUNCTION auth.totp_restablecer(p_correo text)
  RETURNS TABLE (usuario_id uuid, correo text, nombre text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_usuario uuid;
  v_correo text;
  v_nombre text;
BEGIN
  SELECT u.id, u.email, u.nombre INTO v_usuario, v_correo, v_nombre FROM public.usuario u WHERE u.email = p_correo;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('auth.totp:' || v_usuario::text, 0));
  IF NOT EXISTS (SELECT 1 FROM auth.totp t WHERE t.usuario_id = v_usuario AND t.activo_cifrado IS NOT NULL) THEN
    RETURN;
  END IF;
  UPDATE auth.sesion x SET revocada_en = now(), motivo = 'totp'
   WHERE x.usuario_id = v_usuario AND x.revocada_en IS NULL;
  DELETE FROM auth.totp_recuperacion r WHERE r.usuario_id = v_usuario;
  DELETE FROM auth.totp t WHERE t.usuario_id = v_usuario;
  INSERT INTO auth.cuenta_evento (usuario_id, tipo) VALUES (v_usuario, 'totp_restablecido');
  RETURN QUERY SELECT v_usuario, v_correo, v_nombre;
END
$$;--> statement-breakpoint

-- La de 0078 + el bloqueo `auth.totp:<usuario>` antes de revocar.
CREATE OR REPLACE FUNCTION auth.sesion_revocar_id(p_token_hash bytea, p_sesion_id uuid)
  RETURNS void
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
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('auth.totp:' || v_usuario::text, 0));
  UPDATE auth.sesion x SET revocada_en = now(), motivo = 'revocada_usuario'
   WHERE x.id = p_sesion_id AND x.usuario_id = v_usuario AND x.revocada_en IS NULL AND x.expira_absoluta > now();
END
$$;--> statement-breakpoint

-- La de 0078 + el bloqueo `auth.totp:<usuario>`; tras él vuelve a leer la sesión actual (pudo rotar o revocarse mientras esperaba).
CREATE OR REPLACE FUNCTION auth.sesiones_revocar_otras(p_token_hash bytea)
  RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_sesion uuid;
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
  PERFORM pg_advisory_xact_lock(hashtextextended('auth.totp:' || v_usuario::text, 0));
  SELECT x.id INTO v_sesion FROM auth.sesion x
   WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours'
     AND x.factor <> 'pendiente';
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  UPDATE auth.sesion x SET revocada_en = now(), motivo = 'revocada_usuario'
   WHERE x.usuario_id = v_usuario AND x.id <> v_sesion AND x.revocada_en IS NULL AND x.expira_absoluta > now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;--> statement-breakpoint

-- La de 0080 + el bloqueo `auth.totp:<usuario>` después de `auth.sesiones:<usuario>`.
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
  PERFORM pg_advisory_xact_lock(hashtextextended('auth.totp:' || v_usuario::text, 0));
  UPDATE auth.sesion x SET revocada_en = now(), motivo = 'cerrar_todas'
   WHERE x.usuario_id = v_usuario AND x.revocada_en IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;--> statement-breakpoint

ALTER FUNCTION auth.totp_intento_reservar(bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.intento_acierto(bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.login_exito(bytea, uuid, text, bytea, uuid, text, bytea, text, text, cidr) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.recuperacion_consumir(bytea, text) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.contrasena_cambiar(bytea, text, bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.sesion_rotar(bytea, bytea, uuid) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.totp_enrolar_iniciar(uuid, bytea, integer) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.totp_verificar_exito(bytea, bigint, bytea, uuid) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.totp_recuperacion_usar(bytea, bytea, bytea, uuid) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.totp_confirmar(bytea, bigint, bytea[], bytea, bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.totp_desactivar(bytea, bigint) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.totp_recuperacion_regenerar(bytea, bigint, bytea[]) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.totp_restablecer(text) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.sesion_revocar_id(bytea, uuid) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.sesiones_revocar_otras(bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.sesiones_cerrar_todas(bytea) OWNER TO contapp_auth;--> statement-breakpoint

REVOKE ALL ON FUNCTION
  auth.totp_intento_reservar(bytea),
  auth.intento_acierto(bytea),
  auth.login_exito(bytea, uuid, text, bytea, uuid, text, bytea, text, text, cidr),
  auth.recuperacion_consumir(bytea, text),
  auth.contrasena_cambiar(bytea, text, bytea),
  auth.sesion_rotar(bytea, bytea, uuid),
  auth.totp_enrolar_iniciar(uuid, bytea, integer),
  auth.totp_verificar_exito(bytea, bigint, bytea, uuid),
  auth.totp_recuperacion_usar(bytea, bytea, bytea, uuid),
  auth.totp_confirmar(bytea, bigint, bytea[], bytea, bytea),
  auth.totp_desactivar(bytea, bigint),
  auth.totp_recuperacion_regenerar(bytea, bigint, bytea[]),
  auth.totp_restablecer(text),
  auth.sesion_revocar_id(bytea, uuid),
  auth.sesiones_revocar_otras(bytea),
  auth.sesiones_cerrar_todas(bytea)
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_migrator;--> statement-breakpoint

GRANT EXECUTE ON FUNCTION
  auth.totp_intento_reservar(bytea),
  auth.intento_acierto(bytea),
  auth.login_exito(bytea, uuid, text, bytea, uuid, text, bytea, text, text, cidr),
  auth.recuperacion_consumir(bytea, text),
  auth.contrasena_cambiar(bytea, text, bytea),
  auth.sesion_rotar(bytea, bytea, uuid),
  auth.totp_enrolar_iniciar(uuid, bytea, integer),
  auth.totp_verificar_exito(bytea, bigint, bytea, uuid),
  auth.totp_recuperacion_usar(bytea, bytea, bytea, uuid),
  auth.totp_confirmar(bytea, bigint, bytea[], bytea, bytea),
  auth.totp_desactivar(bytea, bigint),
  auth.totp_recuperacion_regenerar(bytea, bigint, bytea[]),
  auth.sesion_revocar_id(bytea, uuid),
  auth.sesiones_revocar_otras(bytea),
  auth.sesiones_cerrar_todas(bytea)
  TO contapp_backend;--> statement-breakpoint

GRANT EXECUTE ON FUNCTION auth.totp_restablecer(text) TO contapp_migrator;
