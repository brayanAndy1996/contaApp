-- 0078_cuenta_segura (custom, spec 029, T5). Segundo factor TOTP, códigos de recuperación, eventos de cuenta y gestión de
-- sesiones. Patrón de 0007: tablas de `auth` con dueño contapp_migrator, RLS ENABLE + FORCE y una sola política `auth_definer`
-- para contapp_auth; funciones SECURITY DEFINER con dueño contapp_auth y search_path = pg_catalog, pg_temp. EXECUTE explícito por
-- función (nunca `ON ALL FUNCTIONS`: auth.purgar es solo del worker y auth.totp_restablecer solo del operador).
-- Repetible: IF NOT EXISTS, DROP ... IF EXISTS, CREATE OR REPLACE, GRANT/REVOKE idempotentes.
--
-- La BD nunca interpreta el secreto: guarda el cifrado AES-GCM que arma el backend (D1) y compara pasos de 30 s (enteros) que el
-- backend calcula con su reloj. Sesión vigente = la de 004 (no revocada, antes de la caducidad absoluta y con uso en las últimas
-- 2 h) y, si es `pendiente`, creada hace menos de 5 min. Las funciones que "rechazan" devuelven cero filas (o 'invalido'/false)
-- sin efectos; los argumentos mal formados dan 22023 con un mensaje fijo (sin valores).
--
-- Decisiones:
--   * Con TOTP activo, `login_exito` NO reinicia el contador de 004 D7: la contraseña correcta no es el login completo. Si lo
--     reiniciara, cada nuevo login daría otros cuatro intentos de código sin bloqueo. Lo reinician `totp_verificar_exito` y
--     `totp_recuperacion_usar`.
--   * `totp_intento_reservar` bloquea la fila de la sesión y luego la del contador (mismo orden que verificar: sesión -> totp ->
--     contador), así N reservas concurrentes evalúan exactamente hasta el 5.º intento.
--   * `sesion_rotar` conserva el factor (y el dispositivo y la red) y una `pendiente` no rota.
--   * Desactivar deja la sesión actual en `sin_factor` (ya no hay factor que la respalde) y revoca las demás.

-- ===================================================================================================
-- Tablas nuevas
-- ===================================================================================================
CREATE TABLE IF NOT EXISTS auth.totp (
  usuario_id uuid PRIMARY KEY REFERENCES public.usuario (id) ON DELETE CASCADE,
  activo_cifrado bytea NULL,
  activo_version integer NULL,
  pendiente_cifrado bytea NULL,
  pendiente_version integer NULL,
  pendiente_expira timestamptz NULL,
  ultimo_paso bigint NOT NULL DEFAULT 0 CONSTRAINT totp_ultimo_paso_no_negativo CHECK (ultimo_paso >= 0),
  activado_en timestamptz NULL,
  CONSTRAINT totp_activo_completo CHECK (
    (activo_cifrado IS NULL AND activo_version IS NULL AND activado_en IS NULL)
    OR (activo_cifrado IS NOT NULL AND activo_version IS NOT NULL AND activado_en IS NOT NULL)),
  CONSTRAINT totp_pendiente_completo CHECK (
    (pendiente_cifrado IS NULL AND pendiente_version IS NULL AND pendiente_expira IS NULL)
    OR (pendiente_cifrado IS NOT NULL AND pendiente_version IS NOT NULL AND pendiente_expira IS NOT NULL)),
  CONSTRAINT totp_cifrado_largo CHECK (
    (activo_cifrado IS NULL OR octet_length(activo_cifrado) BETWEEN 1 AND 256)
    AND (pendiente_cifrado IS NULL OR octet_length(pendiente_cifrado) BETWEEN 1 AND 256)),
  CONSTRAINT totp_version_positiva CHECK (
    (activo_version IS NULL OR activo_version > 0) AND (pendiente_version IS NULL OR pendiente_version > 0))
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS auth.totp_recuperacion (
  id uuid PRIMARY KEY DEFAULT public.uuid_v7(),
  usuario_id uuid NOT NULL REFERENCES public.usuario (id) ON DELETE CASCADE,
  hash bytea NOT NULL CONSTRAINT totp_recuperacion_hash_unique UNIQUE
    CONSTRAINT totp_recuperacion_hash_32 CHECK (octet_length(hash) = 32),
  usado_en timestamptz NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS totp_recuperacion_usuario_idx ON auth.totp_recuperacion (usuario_id);--> statement-breakpoint

-- Hechos de la cuenta (la auditoría de 017 es por estudio y el super-admin no tiene): sin texto libre.
CREATE TABLE IF NOT EXISTS auth.cuenta_evento (
  id uuid PRIMARY KEY DEFAULT public.uuid_v7(),
  usuario_id uuid NOT NULL REFERENCES public.usuario (id) ON DELETE CASCADE,
  tipo text NOT NULL CONSTRAINT cuenta_evento_tipo_valido CHECK (tipo IN (
    'totp_activado', 'totp_desactivado', 'recuperacion_usada', 'recuperacion_regenerada', 'totp_restablecido')),
  creado_en timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cuenta_evento_usuario_idx ON auth.cuenta_evento (usuario_id, creado_en);--> statement-breakpoint

ALTER TABLE auth.totp OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE auth.totp_recuperacion OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE auth.cuenta_evento OWNER TO contapp_migrator;--> statement-breakpoint

ALTER TABLE auth.totp ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE auth.totp FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE auth.totp_recuperacion ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE auth.totp_recuperacion FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE auth.cuenta_evento ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE auth.cuenta_evento FORCE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS auth_definer ON auth.totp;--> statement-breakpoint
CREATE POLICY auth_definer ON auth.totp FOR ALL TO contapp_auth USING (true) WITH CHECK (true);--> statement-breakpoint
DROP POLICY IF EXISTS auth_definer ON auth.totp_recuperacion;--> statement-breakpoint
CREATE POLICY auth_definer ON auth.totp_recuperacion FOR ALL TO contapp_auth USING (true) WITH CHECK (true);--> statement-breakpoint
DROP POLICY IF EXISTS auth_definer ON auth.cuenta_evento;--> statement-breakpoint
CREATE POLICY auth_definer ON auth.cuenta_evento FOR ALL TO contapp_auth USING (true) WITH CHECK (true);--> statement-breakpoint

-- Solo contapp_auth (las funciones). Un evento es un hecho: se agrega y se lee, nunca se edita ni se borra con las funciones.
REVOKE ALL ON auth.totp, auth.totp_recuperacion, auth.cuenta_evento
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.totp, auth.totp_recuperacion TO contapp_auth;--> statement-breakpoint
GRANT SELECT, INSERT ON auth.cuenta_evento TO contapp_auth;--> statement-breakpoint

-- ===================================================================================================
-- auth.sesion: factor, dispositivo (lista cerrada del backend, U6) y red truncada (/24 o /48); motivos nuevos.
-- Las sesiones previas quedan `sin_factor` (U3).
-- ===================================================================================================
ALTER TABLE auth.sesion ADD COLUMN IF NOT EXISTS factor text NOT NULL DEFAULT 'sin_factor';--> statement-breakpoint
ALTER TABLE auth.sesion ADD COLUMN IF NOT EXISTS dispositivo text NULL;--> statement-breakpoint
ALTER TABLE auth.sesion ADD COLUMN IF NOT EXISTS ip_red cidr NULL;--> statement-breakpoint
ALTER TABLE auth.sesion DROP CONSTRAINT IF EXISTS sesion_factor_valido;--> statement-breakpoint
ALTER TABLE auth.sesion ADD CONSTRAINT sesion_factor_valido
  CHECK (factor IN ('pendiente', 'verificado', 'sin_factor'));--> statement-breakpoint
ALTER TABLE auth.sesion DROP CONSTRAINT IF EXISTS sesion_dispositivo_largo;--> statement-breakpoint
ALTER TABLE auth.sesion ADD CONSTRAINT sesion_dispositivo_largo CHECK (length(dispositivo) <= 60);--> statement-breakpoint
ALTER TABLE auth.sesion DROP CONSTRAINT IF EXISTS sesion_motivo_valido;--> statement-breakpoint
ALTER TABLE auth.sesion ADD CONSTRAINT sesion_motivo_valido
  CHECK (motivo IN ('logout', 'rotacion', 'cerrar_todas', 'contrasena', 'restablecer', 'revocada_usuario', 'totp'));--> statement-breakpoint

-- ===================================================================================================
-- Login y validación de sesión (nuevas versiones de 0013 y 0019)
-- ===================================================================================================

-- La de 0013 con tres parámetros al final (una sola firma; las llamadas de 7 argumentos siguen valiendo). Con TOTP activo la sesión
-- nace `pendiente` (5 min, sin estudio) aunque se pida otro factor y el contador no se reinicia; `verificado` no se pide por aquí.
DROP FUNCTION IF EXISTS auth.login_exito(bytea, uuid, text, bytea, uuid, text, bytea);--> statement-breakpoint
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

-- La de 0013 + `factor` al final (D2: el guard no hace otra consulta); una `pendiente` solo vale 5 min.
DROP FUNCTION IF EXISTS auth.sesion_validar(bytea);--> statement-breakpoint
CREATE OR REPLACE FUNCTION auth.sesion_validar(p_token_hash bytea)
  RETURNS TABLE (sesion_id uuid, usuario_id uuid, tenant_activo uuid, estudio_revocado boolean,
                 expira_absoluta timestamptz, factor text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  s auth.sesion%ROWTYPE;
  v_revocado boolean := false;
BEGIN
  SELECT * INTO s FROM auth.sesion x
   WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours'
     AND (x.factor <> 'pendiente' OR x.creada_en > now() - interval '5 minutes');
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
  RETURN QUERY SELECT s.id, s.usuario_id, s.tenant_activo, v_revocado, s.expira_absoluta, s.factor;
END
$$;--> statement-breakpoint

-- La de 0019 + `factor` al final; sin escrituras.
DROP FUNCTION IF EXISTS auth.sesion_consultar(bytea);--> statement-breakpoint
CREATE OR REPLACE FUNCTION auth.sesion_consultar(p_token_hash bytea)
  RETURNS TABLE (sesion_id uuid, usuario_id uuid, tenant_activo uuid, estudio_revocado boolean,
                 expira_absoluta timestamptz, factor text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  s auth.sesion%ROWTYPE;
  v_revocado boolean := false;
BEGIN
  SELECT * INTO s FROM auth.sesion x
   WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours'
     AND (x.factor <> 'pendiente' OR x.creada_en > now() - interval '5 minutes');
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF s.tenant_activo IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.membresia m
     WHERE m.tenant_id = s.tenant_activo AND m.usuario_id = s.usuario_id AND m.desactivada_en IS NULL
  ) THEN
    s.tenant_activo := NULL;
    v_revocado := true;
  END IF;
  RETURN QUERY SELECT s.id, s.usuario_id, s.tenant_activo, v_revocado, s.expira_absoluta, s.factor;
END
$$;--> statement-breakpoint

-- La de 0013 (mismo orden de bloqueo: usuario -> credencial -> sesión): conserva factor, dispositivo y red; una `pendiente` no
-- rota ni cambia de estudio.
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

-- ===================================================================================================
-- TOTP
-- ===================================================================================================

-- Lo que el backend necesita para descifrar y evaluar; 0 filas si el usuario nunca inició el enrolamiento.
CREATE OR REPLACE FUNCTION auth.totp_leer(p_usuario_id uuid)
  RETURNS TABLE (activo_cifrado bytea, activo_version integer, pendiente_cifrado bytea, pendiente_version integer,
                 pendiente_expira timestamptz, ultimo_paso bigint, activado_en timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT t.activo_cifrado, t.activo_version, t.pendiente_cifrado, t.pendiente_version, t.pendiente_expira,
         t.ultimo_paso, t.activado_en
    FROM auth.totp t
   WHERE t.usuario_id = p_usuario_id;
$$;--> statement-breakpoint

-- CA-1: guarda (o reemplaza) el secreto pendiente cifrado; vence en 10 min. Nunca toca el activo ni el último paso.
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
  INSERT INTO auth.totp AS t (usuario_id, pendiente_cifrado, pendiente_version, pendiente_expira)
  VALUES (p_usuario_id, p_cifrado, p_version, now() + interval '10 minutes')
  ON CONFLICT (usuario_id) DO UPDATE SET
    pendiente_cifrado = EXCLUDED.pendiente_cifrado,
    pendiente_version = EXCLUDED.pendiente_version,
    pendiente_expira = EXCLUDED.pendiente_expira
  RETURNING t.pendiente_expira INTO v_expira;
  RETURN v_expira;
END
$$;--> statement-breakpoint

-- CA-3: reserva un intento de código en el contador de 004 D7 (clave = sha256 del correo) antes de evaluarlo. Al 5.º bloquea
-- 15 min y revoca la sesión dada si es `pendiente`; con la cuenta bloqueada, permitido = false. 0 filas: sesión no vigente.
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
  END IF;
  f.fallos := f.fallos + 1;
  IF f.fallos >= 5 THEN
    f.bloqueado_hasta := now() + interval '15 minutes';
    IF s.factor = 'pendiente' THEN
      UPDATE auth.sesion x SET revocada_en = now(), motivo = 'totp' WHERE x.id = s.id;
    END IF;
  END IF;
  UPDATE auth.intento_login i
     SET fallos = f.fallos, ventana_inicio = f.ventana_inicio, bloqueado_hasta = f.bloqueado_hasta
   WHERE i.clave = v_clave;
  RETURN QUERY SELECT true, s.usuario_id;
END
$$;--> statement-breakpoint

-- CA-2, D3: el código del paso p_paso fue correcto. Consume el paso de forma atómica (ultimo_paso < p_paso), reinicia el
-- contador y rota la `pendiente` a una `verificado` de 12 h con el estudio pedido. Todo o nada.
CREATE OR REPLACE FUNCTION auth.totp_verificar_exito(p_token_hash bytea, p_paso bigint, p_token_hash_nuevo bytea,
                                                     p_tenant_nuevo uuid)
  RETURNS TABLE (sesion_id uuid, expira_absoluta timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  s auth.sesion%ROWTYPE;
  v_correo text;
  v_id uuid;
  v_expira timestamptz;
BEGIN
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
  SELECT u.email INTO v_correo FROM public.usuario u WHERE u.id = s.usuario_id;
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

-- CA-9: segundo factor con un código de recuperación (HMAC del backend). Lo gasta de forma atómica (usado_en IS NULL), deja
-- el evento, reinicia el contador y rota igual que totp_verificar_exito. No toca ultimo_paso.
CREATE OR REPLACE FUNCTION auth.totp_recuperacion_usar(p_token_hash bytea, p_hash bytea, p_token_hash_nuevo bytea,
                                                       p_tenant_nuevo uuid)
  RETURNS TABLE (sesion_id uuid, expira_absoluta timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  s auth.sesion%ROWTYPE;
  v_correo text;
  v_id uuid;
  v_expira timestamptz;
BEGIN
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
  SELECT u.email INTO v_correo FROM public.usuario u WHERE u.id = s.usuario_id;
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

-- CA-1, U3, U4: el primer código del pendiente fue correcto (paso p_paso). El pendiente pasa a activo, se guardan 10 hashes de
-- recuperación (los anteriores se borran), queda el evento, las demás sesiones se revocan (motivo totp) y la actual rota a
-- `verificado` conservando creada_en, estudio y caducidad. Exige 10 hashes distintos de 32 bytes (si no, 22023).
CREATE OR REPLACE FUNCTION auth.totp_confirmar(p_token_hash bytea, p_paso bigint, p_hashes bytea[],
                                               p_token_hash_nuevo bytea)
  RETURNS TABLE (sesion_id uuid, expira_absoluta timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  s auth.sesion%ROWTYPE;
  v_id uuid;
BEGIN
  IF p_hashes IS NULL OR cardinality(p_hashes) <> 10
     OR (SELECT count(DISTINCT h) FROM unnest(p_hashes) AS h WHERE h IS NOT NULL AND octet_length(h) = 32) <> 10 THEN
    RAISE EXCEPTION 'se esperan 10 codigos de recuperacion distintos' USING ERRCODE = '22023';
  END IF;
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
   WHERE t.usuario_id = s.usuario_id AND t.pendiente_cifrado IS NOT NULL AND t.pendiente_expira > now()
     AND t.ultimo_paso < p_paso;
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

-- CA-4, U1: desactivar con una sesión `verificado` y un código nuevo. 'exigido' (sin NINGÚN efecto) si el usuario es admin de
-- plataforma o tiene una membresía ACTIVA de Dueño o Administrador (la tabla CASOS_FACTOR_EXIGIDO de shared). 'invalido' si la
-- sesión no sirve, no hay TOTP activo o el paso es un replay. 'desactivado': borra TOTP y códigos, deja el evento, revoca las
-- demás sesiones (motivo totp) y deja la actual en `sin_factor`.
CREATE OR REPLACE FUNCTION auth.totp_desactivar(p_token_hash bytea, p_paso bigint)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  s auth.sesion%ROWTYPE;
  t auth.totp%ROWTYPE;
BEGIN
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

-- U4, CA-9: con una sesión `verificado` y un código nuevo (consume el paso), reemplaza TODOS los códigos (usados o no) por 10
-- nuevos y deja el evento. false sin efectos si algo falta; 22023 si no son 10 hashes distintos de 32 bytes.
CREATE OR REPLACE FUNCTION auth.totp_recuperacion_regenerar(p_token_hash bytea, p_paso bigint, p_hashes bytea[])
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  s auth.sesion%ROWTYPE;
BEGIN
  IF p_hashes IS NULL OR cardinality(p_hashes) <> 10
     OR (SELECT count(DISTINCT h) FROM unnest(p_hashes) AS h WHERE h IS NOT NULL AND octet_length(h) = 32) <> 10 THEN
    RAISE EXCEPTION 'se esperan 10 codigos de recuperacion distintos' USING ERRCODE = '22023';
  END IF;
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

-- U5 (operador, solo contapp_migrator): borra TOTP y códigos, revoca TODAS las sesiones del usuario (motivo totp) y deja el
-- evento. 0 filas si el correo (exacto) no existe o no tenía TOTP activo. No toca la contraseña.
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
  PERFORM 1 FROM auth.totp t WHERE t.usuario_id = v_usuario AND t.activo_cifrado IS NOT NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  DELETE FROM auth.totp_recuperacion r WHERE r.usuario_id = v_usuario;
  DELETE FROM auth.totp t WHERE t.usuario_id = v_usuario;
  UPDATE auth.sesion x SET revocada_en = now(), motivo = 'totp'
   WHERE x.usuario_id = v_usuario AND x.revocada_en IS NULL;
  INSERT INTO auth.cuenta_evento (usuario_id, tipo) VALUES (v_usuario, 'totp_restablecido');
  RETURN QUERY SELECT v_usuario, v_correo, v_nombre;
END
$$;--> statement-breakpoint

-- ===================================================================================================
-- Sesiones del usuario (CA-5). Con un token `pendiente`, revocado, vencido o desconocido no hacen nada.
-- ===================================================================================================

-- Las vigentes del dueño de la sesión dada (sin `pendiente`), la más reciente primero. Sin hashes ni tokens; sin escrituras.
CREATE OR REPLACE FUNCTION auth.sesiones_listar(p_token_hash bytea)
  RETURNS TABLE (id uuid, creada_en timestamptz, ultimo_uso timestamptz, dispositivo text, ip_red cidr, actual boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT x.id, x.creada_en, x.ultimo_uso, x.dispositivo, x.ip_red, x.id = yo.id
    FROM (SELECT y.id, y.usuario_id FROM auth.sesion y
           WHERE y.token_hash = p_token_hash AND y.revocada_en IS NULL
             AND y.expira_absoluta > now() AND y.ultimo_uso > now() - interval '2 hours'
             AND y.factor <> 'pendiente') yo
    JOIN auth.sesion x ON x.usuario_id = yo.usuario_id
   WHERE x.revocada_en IS NULL AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours'
     AND x.factor <> 'pendiente'
   ORDER BY x.ultimo_uso DESC, x.id DESC;
$$;--> statement-breakpoint

-- Revoca (motivo revocada_usuario) una sesión vigente del MISMO usuario. Ajena, inexistente o ya revocada: misma salida, sin efectos.
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
  UPDATE auth.sesion x SET revocada_en = now(), motivo = 'revocada_usuario'
   WHERE x.id = p_sesion_id AND x.usuario_id = v_usuario AND x.revocada_en IS NULL AND x.expira_absoluta > now();
END
$$;--> statement-breakpoint

-- Revoca las demás sesiones no vencidas del usuario (también una `pendiente` a medias), no la actual; devuelve cuántas.
CREATE OR REPLACE FUNCTION auth.sesiones_revocar_otras(p_token_hash bytea)
  RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_sesion uuid;
  v_usuario uuid;
  v_n integer;
BEGIN
  SELECT x.id, x.usuario_id INTO v_sesion, v_usuario FROM auth.sesion x
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

-- ===================================================================================================
-- Dueño contapp_auth; EXECUTE explícito: contapp_backend (todas salvo totp_restablecer, que es solo de contapp_migrator).
-- Nada para PUBLIC, contapp_worker, contapp_platform ni contapp_app.
-- ===================================================================================================
ALTER FUNCTION auth.login_exito(bytea, uuid, text, bytea, uuid, text, bytea, text, text, cidr) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.sesion_validar(bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.sesion_consultar(bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.sesion_rotar(bytea, bytea, uuid) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.totp_leer(uuid) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.totp_enrolar_iniciar(uuid, bytea, integer) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.totp_intento_reservar(bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.totp_verificar_exito(bytea, bigint, bytea, uuid) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.totp_recuperacion_usar(bytea, bytea, bytea, uuid) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.totp_confirmar(bytea, bigint, bytea[], bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.totp_desactivar(bytea, bigint) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.totp_recuperacion_regenerar(bytea, bigint, bytea[]) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.totp_restablecer(text) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.sesiones_listar(bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.sesion_revocar_id(bytea, uuid) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.sesiones_revocar_otras(bytea) OWNER TO contapp_auth;--> statement-breakpoint

REVOKE ALL ON FUNCTION
  auth.login_exito(bytea, uuid, text, bytea, uuid, text, bytea, text, text, cidr),
  auth.sesion_validar(bytea),
  auth.sesion_consultar(bytea),
  auth.sesion_rotar(bytea, bytea, uuid),
  auth.totp_leer(uuid),
  auth.totp_enrolar_iniciar(uuid, bytea, integer),
  auth.totp_intento_reservar(bytea),
  auth.totp_verificar_exito(bytea, bigint, bytea, uuid),
  auth.totp_recuperacion_usar(bytea, bytea, bytea, uuid),
  auth.totp_confirmar(bytea, bigint, bytea[], bytea),
  auth.totp_desactivar(bytea, bigint),
  auth.totp_recuperacion_regenerar(bytea, bigint, bytea[]),
  auth.totp_restablecer(text),
  auth.sesiones_listar(bytea),
  auth.sesion_revocar_id(bytea, uuid),
  auth.sesiones_revocar_otras(bytea)
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_migrator;--> statement-breakpoint

GRANT EXECUTE ON FUNCTION
  auth.login_exito(bytea, uuid, text, bytea, uuid, text, bytea, text, text, cidr),
  auth.sesion_validar(bytea),
  auth.sesion_consultar(bytea),
  auth.sesion_rotar(bytea, bytea, uuid),
  auth.totp_leer(uuid),
  auth.totp_enrolar_iniciar(uuid, bytea, integer),
  auth.totp_intento_reservar(bytea),
  auth.totp_verificar_exito(bytea, bigint, bytea, uuid),
  auth.totp_recuperacion_usar(bytea, bytea, bytea, uuid),
  auth.totp_confirmar(bytea, bigint, bytea[], bytea),
  auth.totp_desactivar(bytea, bigint),
  auth.totp_recuperacion_regenerar(bytea, bigint, bytea[]),
  auth.sesiones_listar(bytea),
  auth.sesion_revocar_id(bytea, uuid),
  auth.sesiones_revocar_otras(bytea)
  TO contapp_backend;--> statement-breakpoint

GRANT EXECUTE ON FUNCTION auth.totp_restablecer(text) TO contapp_migrator;
