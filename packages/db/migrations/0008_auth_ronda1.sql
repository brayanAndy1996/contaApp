-- 0008_auth_ronda1 (custom, spec 004, T16): correcciones de la ronda adversarial 1 sobre 0007_auth.
-- Repetible: DROP ... IF EXISTS antes de cada ADD CONSTRAINT, CREATE OR REPLACE y GRANT/REVOKE idempotentes.
--   H1     contrasena_cambiar invalida los tokens de recuperación vivos del usuario.
--   H-r1b-1 límite por IP de restablecer (`restab_ip`, 10 cada 15 min) y recuperacion_vigente(token) para
--          comprobar el token antes de calcular Argon2.
--   H-r1b-2 contrasena_cambiar reinicia el contador de intentos (un éxito reinicia, CA-3).
--   H-r1b-4 usuario.email solo ASCII (decisión del usuario: dominios internacionales en punycode).

-- usuario.email: además de btrim/lower/NFC, solo ASCII (en UTF-8, un byte por carácter).
ALTER TABLE public.usuario DROP CONSTRAINT IF EXISTS usuario_email_normalizado;--> statement-breakpoint
ALTER TABLE public.usuario ADD CONSTRAINT usuario_email_normalizado
  CHECK (email = btrim(email) AND email = lower(email) AND email IS NFC NORMALIZED
         AND octet_length(email) = char_length(email));--> statement-breakpoint

-- Nuevo tipo de límite: restab_ip.
ALTER TABLE auth.limite_tasa DROP CONSTRAINT IF EXISTS limite_tasa_tipo_valido;--> statement-breakpoint
ALTER TABLE auth.limite_tasa ADD CONSTRAINT limite_tasa_tipo_valido
  CHECK (tipo IN ('login_ip', 'recup_correo', 'recup_ip', 'restab_ip'));--> statement-breakpoint

-- D7: contador por ventana fija, atómico con INSERT ... ON CONFLICT DO UPDATE.
CREATE OR REPLACE FUNCTION auth.limite_consumir(p_tipo text, p_sujeto text) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_max integer;
  v_ventana interval;
  v_conteo integer;
BEGIN
  IF p_tipo = 'login_ip' THEN
    v_max := 20; v_ventana := interval '10 minutes';
  ELSIF p_tipo = 'recup_correo' THEN
    v_max := 3; v_ventana := interval '1 hour';
  ELSIF p_tipo = 'recup_ip' THEN
    v_max := 10; v_ventana := interval '1 hour';
  ELSIF p_tipo = 'restab_ip' THEN
    v_max := 10; v_ventana := interval '15 minutes';
  ELSE
    RETURN false;
  END IF;
  INSERT INTO auth.limite_tasa AS l (tipo, sujeto, ventana_inicio, conteo)
  VALUES (p_tipo, p_sujeto, now(), 1)
  ON CONFLICT (tipo, sujeto) DO UPDATE SET
    ventana_inicio = CASE WHEN l.ventana_inicio <= now() - v_ventana THEN now() ELSE l.ventana_inicio END,
    conteo = CASE WHEN l.ventana_inicio <= now() - v_ventana THEN 1 ELSE least(l.conteo + 1, v_max + 1) END
  RETURNING l.conteo INTO v_conteo;
  RETURN v_conteo <= v_max;
END
$$;--> statement-breakpoint

-- D8: ¿el token existe, no se usó, no se invalidó y no venció? Sin efectos. Se consulta antes de calcular
-- Argon2; el consumo sigue siendo atómico en recuperacion_consumir.
CREATE OR REPLACE FUNCTION auth.recuperacion_vigente(p_token_hash bytea) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM auth.token_recuperacion t
     WHERE t.token_hash = p_token_hash AND t.usado_en IS NULL AND t.invalidado_en IS NULL
       AND t.expira_en > now()
  );
$$;--> statement-breakpoint

-- P11, D4: cambio de contraseña del usuario de la sesión; rota la actual (misma caducidad), revoca las demás,
-- invalida los tokens de recuperación vivos (H1) y reinicia el contador de intentos (CA-3).
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
  INSERT INTO auth.sesion (token_hash, usuario_id, tenant_activo, creada_en, ultimo_uso, expira_absoluta)
  VALUES (p_token_hash_nuevo, s.usuario_id, s.tenant_activo, s.creada_en, now(), s.expira_absoluta);
  UPDATE auth.token_recuperacion t SET invalidado_en = now()
   WHERE t.usuario_id = s.usuario_id AND t.usado_en IS NULL AND t.invalidado_en IS NULL;
  SELECT u.email INTO v_correo FROM public.usuario u WHERE u.id = s.usuario_id;
  UPDATE auth.intento_login i SET fallos = 0, ventana_inicio = now(), bloqueado_hasta = NULL
   WHERE i.clave = sha256(convert_to(v_correo, 'UTF8'));
  RETURN v_correo;
END
$$;--> statement-breakpoint

-- Dueño contapp_auth; EXECUTE solo para contapp_backend (ni PUBLIC, ni worker, ni platform, ni contapp_app).
ALTER FUNCTION auth.limite_consumir(text, text) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.recuperacion_vigente(bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.contrasena_cambiar(bytea, text, bytea) OWNER TO contapp_auth;--> statement-breakpoint

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA auth FROM PUBLIC, contapp_worker, contapp_platform, contapp_app;--> statement-breakpoint
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO contapp_backend;
