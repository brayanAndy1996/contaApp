-- 0007_auth (custom, spec 004). Rol contapp_auth, esquema `auth` (5 tablas con RLS ENABLE + FORCE),
-- funciones SECURITY DEFINER (únicas vías del backend a `auth`), privilegios mínimos y normalización de
-- usuario.email (D10). Plazos con now() del servidor. Sentencias repetibles (IF NOT EXISTS, DROP ... IF
-- EXISTS, CREATE OR REPLACE, GRANT/REVOKE idempotentes).

-- Rol dueño de las funciones: sin login, sin BYPASSRLS; nadie lo hereda ni puede asumirlo.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'contapp_auth') THEN
    CREATE ROLE contapp_auth NOLOGIN;
  END IF;
END
$$;--> statement-breakpoint
ALTER ROLE contapp_auth NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT;--> statement-breakpoint

-- Esquema `auth`: lo crea el superusuario de migraciones; ningún rol de la app (ni contapp_auth) puede
-- crear objetos en él. USAGE: contapp_backend (llama a las funciones), contapp_auth (las ejecuta) y
-- contapp_migrator (dueño de las tablas: las acciones de FK corren como dueño de la tabla que referencia).
CREATE SCHEMA IF NOT EXISTS auth;--> statement-breakpoint
REVOKE ALL ON SCHEMA auth FROM PUBLIC;--> statement-breakpoint
GRANT USAGE ON SCHEMA auth TO contapp_backend, contapp_auth, contapp_migrator;--> statement-breakpoint
-- contapp_auth lee public.usuario y public.membresia.
GRANT USAGE ON SCHEMA public TO contapp_auth;--> statement-breakpoint

-- usuario.email ya normalizado (trim, minúsculas, NFC) y único sin distinguir mayúsculas.
ALTER TABLE public.usuario DROP CONSTRAINT IF EXISTS usuario_email_normalizado;--> statement-breakpoint
ALTER TABLE public.usuario ADD CONSTRAINT usuario_email_normalizado
  CHECK (email = btrim(email) AND email = lower(email) AND email IS NFC NORMALIZED);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS usuario_email_lower_unique ON public.usuario (lower(email));--> statement-breakpoint

CREATE TABLE IF NOT EXISTS auth.usuario_contrasena (
  usuario_id uuid PRIMARY KEY REFERENCES public.usuario (id) ON DELETE CASCADE,
  hash text NOT NULL CONSTRAINT usuario_contrasena_hash_argon2id
    CHECK (hash LIKE '$argon2id$%' AND length(hash) <= 256),
  actualizada_en timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS auth.sesion (
  id uuid PRIMARY KEY DEFAULT public.uuid_v7(),
  token_hash bytea NOT NULL CONSTRAINT sesion_token_hash_unique UNIQUE
    CONSTRAINT sesion_token_hash_32 CHECK (octet_length(token_hash) = 32),
  usuario_id uuid NOT NULL REFERENCES public.usuario (id),
  tenant_activo uuid NULL REFERENCES public.tenant (id),
  creada_en timestamptz NOT NULL DEFAULT now(),
  ultimo_uso timestamptz NOT NULL DEFAULT now(),
  expira_absoluta timestamptz NOT NULL,
  revocada_en timestamptz NULL,
  motivo text NULL CONSTRAINT sesion_motivo_valido
    CHECK (motivo IN ('logout', 'rotacion', 'cerrar_todas', 'contrasena', 'restablecer'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sesion_usuario_idx ON auth.sesion (usuario_id);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS auth.token_recuperacion (
  id uuid PRIMARY KEY DEFAULT public.uuid_v7(),
  token_hash bytea NOT NULL CONSTRAINT token_recuperacion_token_hash_unique UNIQUE
    CONSTRAINT token_recuperacion_token_hash_32 CHECK (octet_length(token_hash) = 32),
  usuario_id uuid NOT NULL REFERENCES public.usuario (id),
  creado_en timestamptz NOT NULL DEFAULT now(),
  expira_en timestamptz NOT NULL,
  usado_en timestamptz NULL,
  invalidado_en timestamptz NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS token_recuperacion_usuario_idx ON auth.token_recuperacion (usuario_id);--> statement-breakpoint

-- clave = SHA-256 del correo normalizado (también para correos inexistentes).
CREATE TABLE IF NOT EXISTS auth.intento_login (
  clave bytea PRIMARY KEY CONSTRAINT intento_login_clave_32 CHECK (octet_length(clave) = 32),
  fallos smallint NOT NULL DEFAULT 0,
  ventana_inicio timestamptz NOT NULL DEFAULT now(),
  bloqueado_hasta timestamptz NULL,
  aviso_enviado_en timestamptz NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS auth.limite_tasa (
  tipo text NOT NULL CONSTRAINT limite_tasa_tipo_valido CHECK (tipo IN ('login_ip', 'recup_correo', 'recup_ip')),
  sujeto text NOT NULL CONSTRAINT limite_tasa_sujeto_largo CHECK (length(sujeto) BETWEEN 1 AND 200),
  ventana_inicio timestamptz NOT NULL DEFAULT now(),
  conteo integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tipo, sujeto)
);--> statement-breakpoint

ALTER TABLE auth.usuario_contrasena OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE auth.sesion OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE auth.token_recuperacion OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE auth.intento_login OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE auth.limite_tasa OWNER TO contapp_migrator;--> statement-breakpoint

ALTER TABLE auth.usuario_contrasena ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE auth.usuario_contrasena FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE auth.sesion ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE auth.sesion FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE auth.token_recuperacion ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE auth.token_recuperacion FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE auth.intento_login ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE auth.intento_login FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE auth.limite_tasa ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE auth.limite_tasa FORCE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS auth_definer ON auth.usuario_contrasena;--> statement-breakpoint
CREATE POLICY auth_definer ON auth.usuario_contrasena FOR ALL TO contapp_auth USING (true) WITH CHECK (true);--> statement-breakpoint
DROP POLICY IF EXISTS auth_definer ON auth.sesion;--> statement-breakpoint
CREATE POLICY auth_definer ON auth.sesion FOR ALL TO contapp_auth USING (true) WITH CHECK (true);--> statement-breakpoint
DROP POLICY IF EXISTS auth_definer ON auth.token_recuperacion;--> statement-breakpoint
CREATE POLICY auth_definer ON auth.token_recuperacion FOR ALL TO contapp_auth USING (true) WITH CHECK (true);--> statement-breakpoint
DROP POLICY IF EXISTS auth_definer ON auth.intento_login;--> statement-breakpoint
CREATE POLICY auth_definer ON auth.intento_login FOR ALL TO contapp_auth USING (true) WITH CHECK (true);--> statement-breakpoint
DROP POLICY IF EXISTS auth_definer ON auth.limite_tasa;--> statement-breakpoint
CREATE POLICY auth_definer ON auth.limite_tasa FOR ALL TO contapp_auth USING (true) WITH CHECK (true);--> statement-breakpoint

-- Privilegios de tabla en auth.*: solo contapp_auth (las funciones). Ningún rol de la app los tiene.
REVOKE ALL ON auth.usuario_contrasena, auth.sesion, auth.token_recuperacion, auth.intento_login, auth.limite_tasa
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE
  ON auth.usuario_contrasena, auth.sesion, auth.token_recuperacion, auth.intento_login, auth.limite_tasa
  TO contapp_auth;--> statement-breakpoint

-- contapp_auth lee usuario y membresia (FORCE RLS): política de solo lectura y solo para él.
GRANT SELECT ON public.usuario, public.membresia TO contapp_auth;--> statement-breakpoint
DROP POLICY IF EXISTS auth_definer ON public.usuario;--> statement-breakpoint
CREATE POLICY auth_definer ON public.usuario FOR SELECT TO contapp_auth USING (true);--> statement-breakpoint
DROP POLICY IF EXISTS auth_definer ON public.membresia;--> statement-breakpoint
CREATE POLICY auth_definer ON public.membresia FOR SELECT TO contapp_auth USING (true);--> statement-breakpoint

-- ===================================================================================================
-- Funciones. Sesión vigente = no revocada, antes de la caducidad absoluta (12 h) y con uso en las
-- últimas 2 h. Las que "rechazan" devuelven cero filas (o NULL/false) sin efectos.
-- ===================================================================================================

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

-- D9, CA-3: bloquea la fila del correo, reinicia la ventana vencida y reserva el intento antes de verificar.
CREATE OR REPLACE FUNCTION auth.login_preparar(p_correo text, p_clave bytea)
  RETURNS TABLE (permitido boolean, usuario_id uuid, hash text, alcanza_bloqueo boolean)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  f auth.intento_login%ROWTYPE;
  v_aviso boolean := false;
  v_usuario uuid;
  v_hash text;
BEGIN
  INSERT INTO auth.intento_login (clave, fallos, ventana_inicio) VALUES (p_clave, 0, now())
  ON CONFLICT (clave) DO NOTHING;
  SELECT * INTO f FROM auth.intento_login i WHERE i.clave = p_clave FOR UPDATE;

  IF f.bloqueado_hasta IS NOT NULL AND f.bloqueado_hasta > now() THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::text, false;
    RETURN;
  END IF;
  IF f.bloqueado_hasta IS NOT NULL OR f.ventana_inicio <= now() - interval '15 minutes' THEN
    f.fallos := 0;
    f.ventana_inicio := now();
    f.bloqueado_hasta := NULL;
  END IF;
  f.fallos := f.fallos + 1;
  IF f.fallos >= 5 THEN
    f.bloqueado_hasta := now() + interval '15 minutes';
    IF f.aviso_enviado_en IS NULL OR f.aviso_enviado_en <= now() - interval '24 hours' THEN
      v_aviso := true;
      f.aviso_enviado_en := now();
    END IF;
  END IF;
  UPDATE auth.intento_login i
     SET fallos = f.fallos, ventana_inicio = f.ventana_inicio,
         bloqueado_hasta = f.bloqueado_hasta, aviso_enviado_en = f.aviso_enviado_en
   WHERE i.clave = p_clave;

  -- Solo el correo exacto (sin LIKE ni normalización en la BD).
  SELECT u.id, c.hash INTO v_usuario, v_hash
    FROM public.usuario u LEFT JOIN auth.usuario_contrasena c ON c.usuario_id = u.id
   WHERE u.email = p_correo;
  RETURN QUERY SELECT true, v_usuario, v_hash, v_aviso;
END
$$;--> statement-breakpoint

-- Login correcto: comprueba la membresía, reinicia el contador, re-hash opcional, crea la sesión (12 h)
-- y revoca la cookie previa (no se promueve).
CREATE OR REPLACE FUNCTION auth.login_exito(
  p_clave bytea, p_usuario_id uuid, p_token_hash bytea, p_tenant_activo uuid, p_hash_nuevo text,
  p_token_anterior_hash bytea)
  RETURNS TABLE (sesion_id uuid, expira_absoluta timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_id uuid;
  v_expira timestamptz;
BEGIN
  IF p_tenant_activo IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.membresia m WHERE m.tenant_id = p_tenant_activo AND m.usuario_id = p_usuario_id
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

-- D3, CA-9: valida, refresca ultimo_uso cada 5 min y limpia el estudio si se perdió la membresía.
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
    SELECT 1 FROM public.membresia m WHERE m.tenant_id = s.tenant_activo AND m.usuario_id = s.usuario_id
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

-- D4, CA-5: rota conservando creada_en y expira_absoluta; re-comprueba la membresía del estudio nuevo.
CREATE OR REPLACE FUNCTION auth.sesion_rotar(p_token_hash bytea, p_token_hash_nuevo bytea, p_tenant_nuevo uuid)
  RETURNS TABLE (sesion_id uuid, expira_absoluta timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  s auth.sesion%ROWTYPE;
  v_id uuid;
BEGIN
  SELECT * INTO s FROM auth.sesion x
   WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF p_tenant_nuevo IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.membresia m WHERE m.tenant_id = p_tenant_nuevo AND m.usuario_id = s.usuario_id
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

-- Logout: idempotente; un token desconocido no falla.
CREATE OR REPLACE FUNCTION auth.sesion_revocar(p_token_hash bytea) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  UPDATE auth.sesion x SET revocada_en = now(), motivo = 'logout'
   WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL;
END
$$;--> statement-breakpoint

-- P2: el usuario sale de la sesión vigente (no de un parámetro); cuenta también la propia.
CREATE OR REPLACE FUNCTION auth.sesiones_cerrar_todas(p_token_hash bytea) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_usuario uuid;
  v_n integer;
BEGIN
  SELECT x.usuario_id INTO v_usuario FROM auth.sesion x
   WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours';
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  UPDATE auth.sesion x SET revocada_en = now(), motivo = 'cerrar_todas'
   WHERE x.usuario_id = v_usuario AND x.revocada_en IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;--> statement-breakpoint

-- P7: estudio de la sesión más reciente del usuario (revocadas incluidas) con membresía vigente.
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
                    WHERE m.tenant_id = x.tenant_activo AND m.usuario_id = v_usuario)
     ORDER BY x.ultimo_uso DESC, x.id DESC
     LIMIT 1
  );
END
$$;--> statement-breakpoint

-- D8, CA-8: un token vivo por usuario (30 min); pedir otro invalida el anterior. Correo exacto.
CREATE OR REPLACE FUNCTION auth.recuperacion_crear(p_correo text, p_token_hash bytea) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_usuario uuid;
BEGIN
  SELECT u.id INTO v_usuario FROM public.usuario u WHERE u.email = p_correo;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  -- Serializa las solicitudes del mismo usuario (se libera al terminar la transacción).
  PERFORM pg_advisory_xact_lock(hashtextextended('auth.recuperacion:' || v_usuario::text, 0));
  DELETE FROM auth.token_recuperacion t
   WHERE t.usuario_id = v_usuario AND t.expira_en < now() - interval '1 day';
  UPDATE auth.token_recuperacion t SET invalidado_en = now()
   WHERE t.usuario_id = v_usuario AND t.usado_en IS NULL AND t.invalidado_en IS NULL;
  INSERT INTO auth.token_recuperacion (token_hash, usuario_id, creado_en, expira_en)
  VALUES (p_token_hash, v_usuario, now(), now() + interval '30 minutes');
  RETURN true;
END
$$;--> statement-breakpoint

-- D8, CA-6, CA-8: consumo atómico de un solo uso; fija la contraseña, revoca todas las sesiones, borra el
-- intento_login del correo e invalida los demás tokens.
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
  DELETE FROM auth.intento_login i WHERE i.clave = sha256(convert_to(v_correo, 'UTF8'));
  UPDATE auth.token_recuperacion t SET invalidado_en = now()
   WHERE t.usuario_id = v_usuario AND t.usado_en IS NULL AND t.invalidado_en IS NULL;
  RETURN QUERY SELECT v_usuario, v_correo;
END
$$;--> statement-breakpoint

-- P11, D4: cambio de contraseña del usuario de la sesión; rota la actual (misma caducidad) y revoca las demás.
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
  SELECT u.email INTO v_correo FROM public.usuario u WHERE u.id = s.usuario_id;
  RETURN v_correo;
END
$$;--> statement-breakpoint

-- Dueño contapp_auth; EXECUTE solo para contapp_backend (ni PUBLIC, ni worker, ni platform, ni contapp_app).
ALTER FUNCTION auth.limite_consumir(text, text) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.login_preparar(text, bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.login_exito(bytea, uuid, bytea, uuid, text, bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.sesion_validar(bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.sesion_rotar(bytea, bytea, uuid) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.sesion_revocar(bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.sesiones_cerrar_todas(bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.ultimo_estudio(bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.recuperacion_crear(text, bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.recuperacion_consumir(bytea, text) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.contrasena_cambiar(bytea, text, bytea) OWNER TO contapp_auth;--> statement-breakpoint

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA auth FROM PUBLIC, contapp_worker, contapp_platform, contapp_app;--> statement-breakpoint
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO contapp_backend;
