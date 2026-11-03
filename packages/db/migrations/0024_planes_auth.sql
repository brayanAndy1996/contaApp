-- 0024_planes_auth (custom, spec 006). Lo que `auth` necesita para el registro público (D3), el cupo de aceptación
-- (D4, D7) y la plataforma (D5, D13). Esqueleto con `drizzle-kit generate --custom`. Repetible: IF NOT EXISTS,
-- DROP ... IF EXISTS, CREATE OR REPLACE, ALTER OWNER y GRANT/REVOKE idempotentes. No toca ninguna función de 0008
-- salvo `limite_consumir` (misma firma, dueño y ACL; el cuerpo suma los tipos de registro).
--   * auth.registro_pendiente: pendiente de registro (solo el hash del token), RLS como el resto de `auth`.
--   * Políticas y privilegios de contapp_auth sobre plan, suscripcion, admin_plataforma y tenant (crear estudios).
--   * 11 funciones SECURITY DEFINER nuevas (dueño contapp_auth, search_path fijo, EXECUTE solo contapp_backend).
-- Las funciones de plataforma revalidan en CADA llamada la sesión viva y el alta en admin_plataforma; si no, error
-- genérico 42501 'permiso_denegado' (plataforma_yo: cero filas). Tras validar, los rechazos de negocio son P0001
-- con mensaje estable 'plan_inactivo', 'extra_sobre_tope' o 'no_encontrado'; un CHECK violado da 23514 y un
-- `codigo` repetido 23505. Solo escriben plan y suscripcion.

-- ===================================================================================================
-- auth.registro_pendiente (D3). vence_en = creada_en + 24 h (mismo now() en la sentencia). correo como
-- usuario.email; nombre_usuario con las reglas de 0016 (sin control ni formato, con una letra o dígito).
-- ===================================================================================================
CREATE TABLE IF NOT EXISTS auth.registro_pendiente (
  id uuid PRIMARY KEY DEFAULT public.uuid_v7(),
  correo text NOT NULL CONSTRAINT registro_pendiente_correo_normalizado
    CHECK (correo = btrim(correo) AND correo = lower(correo) AND correo IS NFC NORMALIZED
           AND octet_length(correo) = char_length(correo) AND char_length(correo) BETWEEN 3 AND 320),
  nombre_estudio text NOT NULL CONSTRAINT registro_pendiente_nombre_estudio_valido
    CHECK (char_length(btrim(nombre_estudio)) >= 2 AND char_length(nombre_estudio) <= 200
           AND nombre_estudio !~ E'[\\u0001-\\u001f\\u007f-\\u009f\\u00ad\\u0600-\\u0605\\u061c\\u06dd\\u070f\\u0890-\\u0891\\u08e2\\u180e\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u206f\\ufeff\\ufff9-\\ufffb\\U000110bd\\U000110cd\\U00013430-\\U0001343f\\U0001bca0-\\U0001bca3\\U0001d173-\\U0001d17a\\U000e0001\\U000e0020-\\U000e007f]'),
  ruc_estudio text NULL CONSTRAINT registro_pendiente_ruc_11_digitos CHECK (ruc_estudio ~ '^[0-9]{11}$'),
  nombre_usuario text NOT NULL CONSTRAINT registro_pendiente_nombre_usuario_valido
    CHECK (btrim(nombre_usuario) <> '' AND char_length(nombre_usuario) <= 200
           AND nombre_usuario !~ E'[\\u0001-\\u001f\\u007f-\\u009f\\u00ad\\u0600-\\u0605\\u061c\\u06dd\\u070f\\u0890-\\u0891\\u08e2\\u180e\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u206f\\ufeff\\ufff9-\\ufffb\\U000110bd\\U000110cd\\U00013430-\\U0001343f\\U0001bca0-\\U0001bca3\\U0001d173-\\U0001d17a\\U000e0001\\U000e0020-\\U000e007f]'
           AND (nombre_usuario COLLATE pg_catalog."und-x-icu") ~ '[[:alnum:]]'),
  token_hash bytea NOT NULL CONSTRAINT registro_pendiente_token_hash_unique UNIQUE
    CONSTRAINT registro_pendiente_token_hash_32 CHECK (octet_length(token_hash) = 32),
  creada_en timestamptz NOT NULL DEFAULT now(),
  vence_en timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  consumida_en timestamptz NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS registro_pendiente_correo_idx ON auth.registro_pendiente (correo);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS registro_pendiente_vence_idx ON auth.registro_pendiente (vence_en);--> statement-breakpoint
ALTER TABLE auth.registro_pendiente OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE auth.registro_pendiente ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE auth.registro_pendiente FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS auth_definer ON auth.registro_pendiente;--> statement-breakpoint
CREATE POLICY auth_definer ON auth.registro_pendiente FOR ALL TO contapp_auth USING (true) WITH CHECK (true);--> statement-breakpoint
REVOKE ALL ON auth.registro_pendiente
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_enumerador;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.registro_pendiente TO contapp_auth;--> statement-breakpoint

-- Límites de tasa del registro (CA-4): por IP y por correo.
ALTER TABLE auth.limite_tasa DROP CONSTRAINT IF EXISTS limite_tasa_tipo_valido;--> statement-breakpoint
ALTER TABLE auth.limite_tasa ADD CONSTRAINT limite_tasa_tipo_valido
  CHECK (tipo IN ('login_ip', 'recup_correo', 'recup_ip', 'restab_ip', 'registro_ip', 'registro_correo'));--> statement-breakpoint

-- ===================================================================================================
-- Privilegios y políticas de contapp_auth (mínimos: por columna donde basta). Nunca DELETE ni TRUNCATE.
-- ===================================================================================================
GRANT SELECT, INSERT, UPDATE ON public.plan, public.suscripcion TO contapp_auth;--> statement-breakpoint
GRANT SELECT ON public.admin_plataforma TO contapp_auth;--> statement-breakpoint
GRANT INSERT (nombre, ruc_estudio) ON public.tenant TO contapp_auth;--> statement-breakpoint
DROP POLICY IF EXISTS auth_definer ON public.suscripcion;--> statement-breakpoint
CREATE POLICY auth_definer ON public.suscripcion FOR SELECT TO contapp_auth USING (true);--> statement-breakpoint
DROP POLICY IF EXISTS auth_definer_insert ON public.suscripcion;--> statement-breakpoint
CREATE POLICY auth_definer_insert ON public.suscripcion FOR INSERT TO contapp_auth WITH CHECK (true);--> statement-breakpoint
DROP POLICY IF EXISTS auth_definer_update ON public.suscripcion;--> statement-breakpoint
CREATE POLICY auth_definer_update ON public.suscripcion FOR UPDATE TO contapp_auth USING (true) WITH CHECK (true);--> statement-breakpoint
DROP POLICY IF EXISTS auth_definer_insert ON public.tenant;--> statement-breakpoint
CREATE POLICY auth_definer_insert ON public.tenant FOR INSERT TO contapp_auth WITH CHECK (true);--> statement-breakpoint

-- ===================================================================================================
-- limite_consumir (0008): misma firma y semántica; suma registro_ip (5/h) y registro_correo (3/h).
-- ===================================================================================================
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
  ELSIF p_tipo = 'registro_ip' THEN
    v_max := 5; v_ventana := interval '1 hour';
  ELSIF p_tipo = 'registro_correo' THEN
    v_max := 3; v_ventana := interval '1 hour';
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

-- ===================================================================================================
-- Registro público (D3, CA-3, CA-4).
-- ===================================================================================================

-- Mismo trabajo y mismo retorno exista o no la cuenta (no mira `usuario`). Serializa por correo, invalida los
-- pendientes vivos del mismo correo (vencen ya), inserta el nuevo y purga los vencidos hace más de 7 días (no
-- depende de auth.purgar de 008).
CREATE OR REPLACE FUNCTION auth.registro_crear(p_correo text, p_estudio text, p_ruc text, p_nombre text,
                                               p_token_hash bytea) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('auth.registro:' || coalesce(p_correo, ''), 0));
  UPDATE auth.registro_pendiente r SET vence_en = now()
   WHERE r.correo = p_correo AND r.consumida_en IS NULL AND r.vence_en > now();
  INSERT INTO auth.registro_pendiente (correo, nombre_estudio, ruc_estudio, nombre_usuario, token_hash)
  VALUES (p_correo, p_estudio, p_ruc, p_nombre, p_token_hash);
  DELETE FROM auth.registro_pendiente r WHERE r.vence_en < now() - interval '7 days';
  RETURN true;
END
$$;--> statement-breakpoint

-- Sin efectos: datos del pendiente vivo (no vencido, no consumido, no invalidado) o cero filas.
CREATE OR REPLACE FUNCTION auth.registro_vigente(p_token_hash bytea)
  RETURNS TABLE (nombre_estudio text, correo text, cuenta_existe boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT r.nombre_estudio, r.correo, EXISTS (SELECT 1 FROM public.usuario u WHERE u.email = r.correo)
    FROM auth.registro_pendiente r
   WHERE r.token_hash = p_token_hash AND r.consumida_en IS NULL AND r.vence_en > now();
$$;--> statement-breakpoint

-- Cuenta nueva: todo o nada. Bloquea el pendiente (N confirmaciones simultáneas -> un solo 'creado'); con la cuenta
-- ya existente o sin plan Prueba activo no consume. Crea estudio, usuario, credencial, membresía Dueño y suscripción
-- 'prueba' a 14 días sobre el plan activo `prueba` (leído de la BD en cada llamada, CA-2).
CREATE OR REPLACE FUNCTION auth.registro_confirmar_nueva(p_token_hash bytea, p_hash text) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  r auth.registro_pendiente%ROWTYPE;
  v_plan uuid;
  v_tenant uuid;
  v_usuario uuid;
BEGIN
  SELECT * INTO r FROM auth.registro_pendiente x
   WHERE x.token_hash = p_token_hash AND x.consumida_en IS NULL AND x.vence_en > now()
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'invalida';
  END IF;
  IF EXISTS (SELECT 1 FROM public.usuario u WHERE u.email = r.correo) THEN
    RETURN 'cuenta_existe';
  END IF;
  SELECT p.id INTO v_plan FROM public.plan p WHERE p.codigo = 'prueba' AND p.activo;
  IF NOT FOUND THEN
    RETURN 'sin_plan';
  END IF;
  BEGIN
    INSERT INTO public.usuario AS u (email, nombre) VALUES (r.correo, r.nombre_usuario) RETURNING u.id INTO v_usuario;
  EXCEPTION WHEN unique_violation THEN
    -- La cuenta se creó por otra vía entre la comprobación y el INSERT.
    RETURN 'cuenta_existe';
  END;
  INSERT INTO public.tenant AS t (nombre, ruc_estudio) VALUES (r.nombre_estudio, r.ruc_estudio)
  RETURNING t.id INTO v_tenant;
  INSERT INTO auth.usuario_contrasena (usuario_id, hash, actualizada_en) VALUES (v_usuario, p_hash, now());
  INSERT INTO public.membresia (tenant_id, usuario_id, rol) VALUES (v_tenant, v_usuario, 'dueno');
  INSERT INTO public.suscripcion (tenant_id, plan_id, estado, prueba_vence_en, rucs_extra_contratados)
  VALUES (v_tenant, v_plan, 'prueba', now() + interval '14 days', 0);
  UPDATE auth.registro_pendiente x SET consumida_en = now() WHERE x.id = r.id;
  RETURN 'creado';
END
$$;--> statement-breakpoint

-- Cuenta existente: con la sesión viva del titular (correo EXACTO del pendiente). Crea estudio, membresía Dueño y
-- suscripción 'prueba' sin tocar la contraseña ni el usuario; cero filas si no procede (sin efectos).
CREATE OR REPLACE FUNCTION auth.registro_confirmar_existente(p_token_hash bytea, p_token_hash_sesion bytea)
  RETURNS TABLE (tenant_id uuid, estudio_nombre text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  r auth.registro_pendiente%ROWTYPE;
  v_usuario uuid;
  v_correo text;
  v_plan uuid;
  v_tenant uuid;
BEGIN
  SELECT x.usuario_id INTO v_usuario FROM auth.sesion x
   WHERE x.token_hash = p_token_hash_sesion AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours';
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT u.email INTO v_correo FROM public.usuario u WHERE u.id = v_usuario;
  SELECT * INTO r FROM auth.registro_pendiente x
   WHERE x.token_hash = p_token_hash AND x.consumida_en IS NULL AND x.vence_en > now()
   FOR UPDATE;
  IF NOT FOUND OR v_correo IS NULL OR r.correo <> v_correo THEN
    RETURN;
  END IF;
  SELECT p.id INTO v_plan FROM public.plan p WHERE p.codigo = 'prueba' AND p.activo;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  INSERT INTO public.tenant AS t (nombre, ruc_estudio) VALUES (r.nombre_estudio, r.ruc_estudio)
  RETURNING t.id INTO v_tenant;
  INSERT INTO public.membresia (tenant_id, usuario_id, rol) VALUES (v_tenant, v_usuario, 'dueno');
  INSERT INTO public.suscripcion (tenant_id, plan_id, estado, prueba_vence_en, rucs_extra_contratados)
  VALUES (v_tenant, v_plan, 'prueba', now() + interval '14 days', 0);
  UPDATE auth.registro_pendiente x SET consumida_en = now() WHERE x.id = r.id;
  RETURN QUERY SELECT v_tenant, r.nombre_estudio;
END
$$;--> statement-breakpoint

-- ===================================================================================================
-- Cupo de aceptación (D4, D7, CA-6, CA-7). Mismo bloqueo `plan.cupo:<tenant>` que bloquearCupo (packages/db): se
-- toma antes de contar y dura hasta el fin de la transacción del llamador. La invitación ya estaba contada al
-- invitar: aquí solo activos + 1 <= max_usuarios (NULL = sin límite). Sin suscripción -> false (falla cerrado).
-- ===================================================================================================
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

-- ===================================================================================================
-- Plataforma (D5, D13). Cada función revalida la sesión viva y el alta en admin_plataforma.
-- ===================================================================================================

-- Una fila (usuario_id) si la sesión es de un admin vivo; cero filas si no.
CREATE OR REPLACE FUNCTION auth.plataforma_yo(p_token_hash bytea) RETURNS TABLE (usuario_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT x.usuario_id FROM auth.sesion x JOIN public.admin_plataforma a ON a.usuario_id = x.usuario_id
   WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours';
$$;--> statement-breakpoint

-- Todos los planes (con precios e inactivos).
CREATE OR REPLACE FUNCTION auth.plan_listar(p_token_hash bytea) RETURNS SETOF public.plan
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM auth.sesion x JOIN public.admin_plataforma a ON a.usuario_id = x.usuario_id
     WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
       AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'permiso_denegado';
  END IF;
  RETURN QUERY SELECT p.* FROM public.plan p ORDER BY p.max_rucs, p.codigo;
END
$$;--> statement-breakpoint

-- Crea un plan (D11). Los CHECK de `plan` rechazan valores inválidos (23514) y el UNIQUE el código repetido (23505).
-- Precios con más de 2 decimales se rechazan (NUMERIC(14,2) redondearía en silencio).
CREATE OR REPLACE FUNCTION auth.plan_crear(
  p_token_hash bytea, p_codigo text, p_nombre text, p_precio_mensual numeric, p_precio_anual numeric,
  p_max_rucs integer, p_max_usuarios integer, p_precio_ruc_extra numeric, p_max_rucs_extra integer,
  p_frecuencia_buzon_min integer, p_features jsonb, p_activo boolean) RETURNS SETOF public.plan
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v public.plan%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM auth.sesion x JOIN public.admin_plataforma a ON a.usuario_id = x.usuario_id
     WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
       AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'permiso_denegado';
  END IF;
  IF p_precio_mensual <> round(p_precio_mensual, 2) OR p_precio_anual <> round(p_precio_anual, 2)
     OR p_precio_ruc_extra <> round(p_precio_ruc_extra, 2) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'valor_invalido';
  END IF;
  INSERT INTO public.plan AS n (codigo, nombre, precio_mensual, precio_anual, max_rucs, max_usuarios,
                                precio_ruc_extra, max_rucs_extra, frecuencia_buzon_min, features, activo)
  VALUES (p_codigo, p_nombre, p_precio_mensual, p_precio_anual, p_max_rucs, p_max_usuarios,
          p_precio_ruc_extra, p_max_rucs_extra, p_frecuencia_buzon_min, p_features, p_activo)
  RETURNING n.* INTO v;
  RETURN NEXT v;
END
$$;--> statement-breakpoint

-- Reemplazo completo en sitio (incluye codigo y activo; D11). Desactivar no toca a quien ya lo usa.
CREATE OR REPLACE FUNCTION auth.plan_editar(
  p_token_hash bytea, p_plan_id uuid, p_codigo text, p_nombre text, p_precio_mensual numeric,
  p_precio_anual numeric, p_max_rucs integer, p_max_usuarios integer, p_precio_ruc_extra numeric,
  p_max_rucs_extra integer, p_frecuencia_buzon_min integer, p_features jsonb, p_activo boolean)
  RETURNS SETOF public.plan
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v public.plan%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM auth.sesion x JOIN public.admin_plataforma a ON a.usuario_id = x.usuario_id
     WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
       AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'permiso_denegado';
  END IF;
  IF p_precio_mensual <> round(p_precio_mensual, 2) OR p_precio_anual <> round(p_precio_anual, 2)
     OR p_precio_ruc_extra <> round(p_precio_ruc_extra, 2) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'valor_invalido';
  END IF;
  UPDATE public.plan AS x
     SET codigo = p_codigo, nombre = p_nombre, precio_mensual = p_precio_mensual, precio_anual = p_precio_anual,
         max_rucs = p_max_rucs, max_usuarios = p_max_usuarios, precio_ruc_extra = p_precio_ruc_extra,
         max_rucs_extra = p_max_rucs_extra, frecuencia_buzon_min = p_frecuencia_buzon_min,
         features = p_features, activo = p_activo, updated_at = now()
   WHERE x.id = p_plan_id
  RETURNING x.* INTO v;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'no_encontrado';
  END IF;
  RETURN NEXT v;
END
$$;--> statement-breakpoint

-- Estudios con su plan y estado, y NADA más (D13: sin precios, RUCs ni uso). Un estudio sin suscripción sale con
-- plan y estado NULL.
CREATE OR REPLACE FUNCTION auth.estudios_listar(p_token_hash bytea)
  RETURNS TABLE (id uuid, nombre text, plan_codigo text, plan_nombre text, estado text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM auth.sesion x JOIN public.admin_plataforma a ON a.usuario_id = x.usuario_id
     WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
       AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'permiso_denegado';
  END IF;
  RETURN QUERY
    SELECT t.id, t.nombre, p.codigo, p.nombre, s.estado
      FROM public.tenant t
      LEFT JOIN public.suscripcion s ON s.tenant_id = t.id
      LEFT JOIN public.plan p ON p.id = s.plan_id
     ORDER BY t.nombre, t.id;
END
$$;--> statement-breakpoint

-- Asigna plan y RUCs adicionales a la suscripción EXISTENTE del estudio (D5, D6, D10). Nunca la crea (solo el
-- registro y el backfill lo hacen). Rechaza estudio o suscripción inexistente y plan inexistente ('no_encontrado'),
-- plan inactivo ('plan_inactivo') y adicionales sobre el tope del plan nuevo ('extra_sobre_tope'); negativos: CHECK.
CREATE OR REPLACE FUNCTION auth.suscripcion_asignar(p_token_hash bytea, p_tenant_id uuid, p_plan_id uuid,
                                                    p_rucs_extra integer)
  RETURNS TABLE (tenant_id uuid, plan_id uuid, plan_codigo text, plan_nombre text, estado text,
                 rucs_extra_contratados integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  p public.plan%ROWTYPE;
  v_estado text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM auth.sesion x JOIN public.admin_plataforma a ON a.usuario_id = x.usuario_id
     WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
       AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'permiso_denegado';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.suscripcion s WHERE s.tenant_id = p_tenant_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'no_encontrado';
  END IF;
  SELECT * INTO p FROM public.plan x WHERE x.id = p_plan_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'no_encontrado';
  END IF;
  IF NOT p.activo THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'plan_inactivo';
  END IF;
  IF p_rucs_extra > p.max_rucs_extra THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'extra_sobre_tope';
  END IF;
  UPDATE public.suscripcion s
     SET plan_id = p.id, rucs_extra_contratados = p_rucs_extra, updated_at = now()
   WHERE s.tenant_id = p_tenant_id
  RETURNING s.estado INTO v_estado;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'no_encontrado';
  END IF;
  RETURN QUERY SELECT p_tenant_id, p.id, p.codigo, p.nombre, v_estado, p_rucs_extra;
END
$$;--> statement-breakpoint

-- Dueño contapp_auth; EXECUTE solo para contapp_backend (ni PUBLIC, ni worker, ni platform, ni contapp_app). Por
-- función (no ON ALL FUNCTIONS: auth.purgar de 008 es solo del worker).
ALTER FUNCTION auth.limite_consumir(text, text) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.registro_crear(text, text, text, text, bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.registro_vigente(bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.registro_confirmar_nueva(bytea, text) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.registro_confirmar_existente(bytea, bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.cupo_usuarios_aceptar(uuid) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.plataforma_yo(bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.plan_listar(bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.plan_crear(bytea, text, text, numeric, numeric, integer, integer, numeric, integer, integer, jsonb, boolean) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.plan_editar(bytea, uuid, text, text, numeric, numeric, integer, integer, numeric, integer, integer, jsonb, boolean) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.estudios_listar(bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.suscripcion_asignar(bytea, uuid, uuid, integer) OWNER TO contapp_auth;--> statement-breakpoint

REVOKE ALL ON FUNCTION
  auth.limite_consumir(text, text),
  auth.registro_crear(text, text, text, text, bytea),
  auth.registro_vigente(bytea),
  auth.registro_confirmar_nueva(bytea, text),
  auth.registro_confirmar_existente(bytea, bytea),
  auth.cupo_usuarios_aceptar(uuid),
  auth.plataforma_yo(bytea),
  auth.plan_listar(bytea),
  auth.plan_crear(bytea, text, text, numeric, numeric, integer, integer, numeric, integer, integer, jsonb, boolean),
  auth.plan_editar(bytea, uuid, text, text, numeric, numeric, integer, integer, numeric, integer, integer, jsonb, boolean),
  auth.estudios_listar(bytea),
  auth.suscripcion_asignar(bytea, uuid, uuid, integer)
  FROM PUBLIC, contapp_worker, contapp_platform, contapp_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  auth.limite_consumir(text, text),
  auth.registro_crear(text, text, text, text, bytea),
  auth.registro_vigente(bytea),
  auth.registro_confirmar_nueva(bytea, text),
  auth.registro_confirmar_existente(bytea, bytea),
  auth.cupo_usuarios_aceptar(uuid),
  auth.plataforma_yo(bytea),
  auth.plan_listar(bytea),
  auth.plan_crear(bytea, text, text, numeric, numeric, integer, integer, numeric, integer, integer, jsonb, boolean),
  auth.plan_editar(bytea, uuid, text, text, numeric, numeric, integer, integer, numeric, integer, integer, jsonb, boolean),
  auth.estudios_listar(bytea),
  auth.suscripcion_asignar(bytea, uuid, uuid, integer)
  TO contapp_backend;
