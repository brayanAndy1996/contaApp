-- 0025_planes_ronda1 (custom, spec 006, T13b). Correcciones de la ronda adversarial (T12a/T12b) y decisiones del usuario
-- D14 (una prueba por cuenta) y D15 (10 confirmaciones por hora por IP). plan.md, "Ajustes de la ronda adversarial".
-- Esqueleto con `drizzle-kit generate --custom`. Repetible (IF NOT EXISTS, DROP ... IF EXISTS, CREATE OR REPLACE, ALTER
-- OWNER y GRANT/REVOKE idempotentes). No edita 0022-0024 ni redefine funciones de 0008 salvo `limite_consumir` (misma
-- firma, dueño y ACL; el cuerpo suma `registro_confirmar_ip`).
--   * a1/D14: auth.prueba_origen; registro_confirmar_nueva la registra; registro_confirmar_existente (DROP + CREATE,
--     `+ con_prueba`) solo da la Prueba si la cuenta no la originó antes; suscripcion_asignar crea la suscripción
--     `activa` del estudio que no la tiene.
--   * b1: registro_pendiente.invalidada_en (clock_timestamp()), exigida NULL por registro_vigente y registro_confirmar_*.
--   * a3: U+2028/U+2029 en los CHECK de nombre de registro_pendiente.
--   * b3/D15: tipo `registro_confirmar_ip` (10 por hora) en limite_consumir y en limite_tasa_tipo_valido.
--   * b7: plan_crear/plan_editar y CHECK de `plan` rechazan NaN (e Infinity en las funciones) en los tres precios.
-- FUNCIONES_AUTH sigue en 28: ninguna función nueva ni sobrecarga.

-- ===================================================================================================
-- a1 / D14 · auth.prueba_origen: la cuenta que ya originó su prueba (una por cuenta en toda su vida). Tabla y no columna
-- de `suscripcion`: sobrevive a un cambio o borrado de la suscripción o del estudio, y el backend no la ve.
-- ===================================================================================================
CREATE TABLE IF NOT EXISTS auth.prueba_origen (
  usuario_id uuid PRIMARY KEY CONSTRAINT prueba_origen_usuario_fk REFERENCES public.usuario (id) ON DELETE CASCADE,
  tenant_id uuid NULL CONSTRAINT prueba_origen_tenant_fk REFERENCES public.tenant (id) ON DELETE SET NULL,
  creada_en timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS prueba_origen_tenant_idx ON auth.prueba_origen (tenant_id);--> statement-breakpoint
ALTER TABLE auth.prueba_origen OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE auth.prueba_origen ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE auth.prueba_origen FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS auth_definer ON auth.prueba_origen;--> statement-breakpoint
CREATE POLICY auth_definer ON auth.prueba_origen FOR ALL TO contapp_auth USING (true) WITH CHECK (true);--> statement-breakpoint
REVOKE ALL ON auth.prueba_origen
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_enumerador;--> statement-breakpoint
GRANT SELECT, INSERT ON auth.prueba_origen TO contapp_auth;--> statement-breakpoint

-- ===================================================================================================
-- b1 · marca explícita de invalidación; a3 · U+2028/U+2029 en los nombres (drop + add de los CHECK). Un pendiente que ya
-- tuviera esos separadores no podría confirmarse con la regla nueva: se borra (la purga de registro_crear lo haría igual).
-- ===================================================================================================
ALTER TABLE auth.registro_pendiente ADD COLUMN IF NOT EXISTS invalidada_en timestamptz NULL;--> statement-breakpoint
DELETE FROM auth.registro_pendiente
 WHERE nombre_estudio ~ E'[\\u2028\\u2029]' OR nombre_usuario ~ E'[\\u2028\\u2029]';--> statement-breakpoint
ALTER TABLE auth.registro_pendiente DROP CONSTRAINT IF EXISTS registro_pendiente_nombre_estudio_valido;--> statement-breakpoint
ALTER TABLE auth.registro_pendiente ADD CONSTRAINT registro_pendiente_nombre_estudio_valido
  CHECK (char_length(btrim(nombre_estudio)) >= 2 AND char_length(nombre_estudio) <= 200
         AND nombre_estudio !~ E'[\\u0001-\\u001f\\u007f-\\u009f\\u00ad\\u0600-\\u0605\\u061c\\u06dd\\u070f\\u0890-\\u0891\\u08e2\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2064\\u2066-\\u206f\\ufeff\\ufff9-\\ufffb\\U000110bd\\U000110cd\\U00013430-\\U0001343f\\U0001bca0-\\U0001bca3\\U0001d173-\\U0001d17a\\U000e0001\\U000e0020-\\U000e007f]');--> statement-breakpoint
ALTER TABLE auth.registro_pendiente DROP CONSTRAINT IF EXISTS registro_pendiente_nombre_usuario_valido;--> statement-breakpoint
ALTER TABLE auth.registro_pendiente ADD CONSTRAINT registro_pendiente_nombre_usuario_valido
  CHECK (btrim(nombre_usuario) <> '' AND char_length(nombre_usuario) <= 200
         AND nombre_usuario !~ E'[\\u0001-\\u001f\\u007f-\\u009f\\u00ad\\u0600-\\u0605\\u061c\\u06dd\\u070f\\u0890-\\u0891\\u08e2\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2064\\u2066-\\u206f\\ufeff\\ufff9-\\ufffb\\U000110bd\\U000110cd\\U00013430-\\U0001343f\\U0001bca0-\\U0001bca3\\U0001d173-\\U0001d17a\\U000e0001\\U000e0020-\\U000e007f]'
         AND (nombre_usuario COLLATE pg_catalog."und-x-icu") ~ '[[:alnum:]]');--> statement-breakpoint

-- ===================================================================================================
-- b3 / D15 · límite al confirmar: `registro_confirmar_ip` (10 por hora).
-- ===================================================================================================
ALTER TABLE auth.limite_tasa DROP CONSTRAINT IF EXISTS limite_tasa_tipo_valido;--> statement-breakpoint
ALTER TABLE auth.limite_tasa ADD CONSTRAINT limite_tasa_tipo_valido
  CHECK (tipo IN ('login_ip', 'recup_correo', 'recup_ip', 'restab_ip', 'registro_ip', 'registro_correo',
                  'registro_confirmar_ip'));--> statement-breakpoint

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
  ELSIF p_tipo = 'registro_confirmar_ip' THEN
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

-- ===================================================================================================
-- Registro (b1, a1/D14).
-- ===================================================================================================

-- Mismo trabajo y mismo retorno exista o no la cuenta (no mira `usuario`). Serializa por correo, marca los pendientes
-- vivos del mismo correo con `invalidada_en = clock_timestamp()` (hora real, no la del inicio de la transacción: una
-- confirmación que empezó antes y relee la fila la ve invalidada; b1) y adelanta su vencimiento, inserta el nuevo y
-- purga los vencidos hace más de 7 días. Un CHECK violado (23514) aborta todo: el enlace anterior sigue vivo.
CREATE OR REPLACE FUNCTION auth.registro_crear(p_correo text, p_estudio text, p_ruc text, p_nombre text,
                                               p_token_hash bytea) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_ahora timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('auth.registro:' || coalesce(p_correo, ''), 0));
  v_ahora := clock_timestamp();
  UPDATE auth.registro_pendiente r SET invalidada_en = v_ahora, vence_en = least(r.vence_en, v_ahora)
   WHERE r.correo = p_correo AND r.consumida_en IS NULL AND r.invalidada_en IS NULL AND r.vence_en > now();
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
   WHERE r.token_hash = p_token_hash AND r.consumida_en IS NULL AND r.invalidada_en IS NULL AND r.vence_en > now();
$$;--> statement-breakpoint

-- Cuenta nueva: todo o nada (como en 0024) y además registra en prueba_origen que este usuario ya originó su prueba.
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
   WHERE x.token_hash = p_token_hash AND x.consumida_en IS NULL AND x.invalidada_en IS NULL AND x.vence_en > now()
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
  INSERT INTO auth.prueba_origen (usuario_id, tenant_id) VALUES (v_usuario, v_tenant);
  UPDATE auth.registro_pendiente x SET consumida_en = now() WHERE x.id = r.id;
  RETURN 'creado';
END
$$;--> statement-breakpoint

-- Cuenta existente (D14): con la sesión viva del titular (correo EXACTO del pendiente) crea estudio y membresía Dueño sin
-- tocar la contraseña. La Prueba solo si la cuenta no la originó antes: `INSERT ... ON CONFLICT (usuario_id) DO NOTHING`
-- en prueba_origen (la PK serializa las confirmaciones simultáneas de la misma cuenta: una sola inserta). Si inserta,
-- suscripción `prueba` a 14 días y con_prueba = true; si no, el estudio nace SIN suscripción y con_prueba = false (falla
-- cerrado: 409 sin_plan hasta que el super-admin le asigne un plan). Cero filas si no procede (sin efectos). DROP + CREATE
-- porque cambia el RETURNS TABLE; dueño, search_path y EXECUTE se reaplican abajo.
DROP FUNCTION IF EXISTS auth.registro_confirmar_existente(bytea, bytea);--> statement-breakpoint
CREATE FUNCTION auth.registro_confirmar_existente(p_token_hash bytea, p_token_hash_sesion bytea)
  RETURNS TABLE (tenant_id uuid, estudio_nombre text, con_prueba boolean)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  r auth.registro_pendiente%ROWTYPE;
  v_usuario uuid;
  v_correo text;
  v_plan uuid;
  v_tenant uuid;
  v_origen uuid;
BEGIN
  SELECT x.usuario_id INTO v_usuario FROM auth.sesion x
   WHERE x.token_hash = p_token_hash_sesion AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours';
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT u.email INTO v_correo FROM public.usuario u WHERE u.id = v_usuario;
  SELECT * INTO r FROM auth.registro_pendiente x
   WHERE x.token_hash = p_token_hash AND x.consumida_en IS NULL AND x.invalidada_en IS NULL AND x.vence_en > now()
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
  INSERT INTO auth.prueba_origen AS o (usuario_id, tenant_id) VALUES (v_usuario, v_tenant)
  ON CONFLICT (usuario_id) DO NOTHING
  RETURNING o.usuario_id INTO v_origen;
  IF v_origen IS NOT NULL THEN
    INSERT INTO public.suscripcion (tenant_id, plan_id, estado, prueba_vence_en, rucs_extra_contratados)
    VALUES (v_tenant, v_plan, 'prueba', now() + interval '14 days', 0);
  END IF;
  UPDATE auth.registro_pendiente x SET consumida_en = now() WHERE x.id = r.id;
  RETURN QUERY SELECT v_tenant, r.nombre_estudio, v_origen IS NOT NULL;
END
$$;--> statement-breakpoint

-- ===================================================================================================
-- b7 · NaN en los precios. NUMERIC(14,2) admite 'NaN' y NaN >= 0 es verdadero en PG: CHECK propio en `plan` y rechazo
-- en las funciones (también ±Infinity, que el parámetro `numeric` admite aunque la columna lo rechace con 22003). Los
-- CHECK viven solo aquí (como el resto de 0025), no en el esquema drizzle: el snapshot 0025 es el de 0024.
-- ===================================================================================================
ALTER TABLE public.plan DROP CONSTRAINT IF EXISTS plan_precio_mensual_finito;--> statement-breakpoint
ALTER TABLE public.plan ADD CONSTRAINT plan_precio_mensual_finito CHECK (precio_mensual <> 'NaN'::numeric);--> statement-breakpoint
ALTER TABLE public.plan DROP CONSTRAINT IF EXISTS plan_precio_anual_finito;--> statement-breakpoint
ALTER TABLE public.plan ADD CONSTRAINT plan_precio_anual_finito CHECK (precio_anual <> 'NaN'::numeric);--> statement-breakpoint
ALTER TABLE public.plan DROP CONSTRAINT IF EXISTS plan_precio_ruc_extra_finito;--> statement-breakpoint
ALTER TABLE public.plan ADD CONSTRAINT plan_precio_ruc_extra_finito CHECK (precio_ruc_extra <> 'NaN'::numeric);--> statement-breakpoint

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
  IF p_precio_mensual IN ('NaN', 'Infinity', '-Infinity') OR p_precio_anual IN ('NaN', 'Infinity', '-Infinity')
     OR p_precio_ruc_extra IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'valor_invalido';
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
  IF p_precio_mensual IN ('NaN', 'Infinity', '-Infinity') OR p_precio_anual IN ('NaN', 'Infinity', '-Infinity')
     OR p_precio_ruc_extra IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'valor_invalido';
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

-- ===================================================================================================
-- a1 / D14 · suscripcion_asignar: si el estudio no tiene suscripción la CREA (`activa`, sin vencimiento de prueba);
-- si la tiene, cambia plan y adicionales como antes (el estado no cambia). `INSERT ... ON CONFLICT (tenant_id) DO UPDATE`
-- deja una sola fila aunque haya asignaciones simultáneas. Sigue rechazando estudio o plan inexistente
-- ('no_encontrado'), plan inactivo ('plan_inactivo') y adicionales sobre el tope ('extra_sobre_tope'); negativos: CHECK.
-- ===================================================================================================
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
  IF NOT EXISTS (SELECT 1 FROM public.tenant t WHERE t.id = p_tenant_id) THEN
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
  INSERT INTO public.suscripcion AS s (tenant_id, plan_id, estado, prueba_vence_en, rucs_extra_contratados)
  VALUES (p_tenant_id, p.id, 'activa', NULL, p_rucs_extra)
  ON CONFLICT (tenant_id) DO UPDATE
    SET plan_id = EXCLUDED.plan_id, rucs_extra_contratados = EXCLUDED.rucs_extra_contratados, updated_at = now()
  RETURNING s.estado INTO v_estado;
  RETURN QUERY SELECT p_tenant_id, p.id, p.codigo, p.nombre, v_estado, p_rucs_extra;
END
$$;--> statement-breakpoint

-- ===================================================================================================
-- Dueño contapp_auth, search_path fijo y EXECUTE solo para contapp_backend en las funciones que 0025 toca (la de
-- DROP + CREATE nace con EXECUTE para PUBLIC: el REVOKE lo quita).
-- ===================================================================================================
ALTER FUNCTION auth.limite_consumir(text, text) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.registro_crear(text, text, text, text, bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.registro_vigente(bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.registro_confirmar_nueva(bytea, text) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.registro_confirmar_existente(bytea, bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.plan_crear(bytea, text, text, numeric, numeric, integer, integer, numeric, integer, integer, jsonb, boolean) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.plan_editar(bytea, uuid, text, text, numeric, numeric, integer, integer, numeric, integer, integer, jsonb, boolean) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.suscripcion_asignar(bytea, uuid, uuid, integer) OWNER TO contapp_auth;--> statement-breakpoint

REVOKE ALL ON FUNCTION
  auth.limite_consumir(text, text),
  auth.registro_crear(text, text, text, text, bytea),
  auth.registro_vigente(bytea),
  auth.registro_confirmar_nueva(bytea, text),
  auth.registro_confirmar_existente(bytea, bytea),
  auth.plan_crear(bytea, text, text, numeric, numeric, integer, integer, numeric, integer, integer, jsonb, boolean),
  auth.plan_editar(bytea, uuid, text, text, numeric, numeric, integer, integer, numeric, integer, integer, jsonb, boolean),
  auth.suscripcion_asignar(bytea, uuid, uuid, integer)
  FROM PUBLIC, contapp_worker, contapp_platform, contapp_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  auth.limite_consumir(text, text),
  auth.registro_crear(text, text, text, text, bytea),
  auth.registro_vigente(bytea),
  auth.registro_confirmar_nueva(bytea, text),
  auth.registro_confirmar_existente(bytea, bytea),
  auth.plan_crear(bytea, text, text, numeric, numeric, integer, integer, numeric, integer, integer, jsonb, boolean),
  auth.plan_editar(bytea, uuid, text, text, numeric, numeric, integer, integer, numeric, integer, integer, jsonb, boolean),
  auth.suscripcion_asignar(bytea, uuid, uuid, integer)
  TO contapp_backend;
