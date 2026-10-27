-- 0010_auth_final (custom, spec 004, T20a): O-1 de la revisión final sobre 0007.
-- Repetible: DROP FUNCTION IF EXISTS de la firma vieja, CREATE OR REPLACE, ALTER OWNER y GRANT/REVOKE
-- idempotentes. Sigue habiendo 12 funciones en `auth` (la firma vieja de login_exito desaparece).
--   O-1  login_preparar lee el hash, el backend verifica fuera de la BD y login_exito crea la sesión en otra
--        transacción: un login con la contraseña vieja que verificaba antes de que recuperacion_consumir o
--        contrasena_cambiar confirmaran dejaba una sesión viva tras "restablecer revoca todas" (CA-6) y, si el
--        hash necesitaba re-hash, sobrescribía la contraseña nueva con el re-hash de la vieja.
--        Ahora login_exito recibe el hash verificado, bloquea la fila de auth.usuario_contrasena (FOR SHARE; FOR
--        NO KEY UPDATE si hay re-hash, para no escalar el bloqueo) y devuelve cero filas, sin efectos, si la
--        credencial ya no es la verificada (cambió o no existe). Si un restablecer/cambio sigue en curso, espera
--        a que confirme y ve el hash nuevo; si el login confirma antes, el restablecer/cambio posterior ya ve y
--        revoca la sesión nueva.
--        Orden de bloqueo (el de 0009): credencial -> intento_login -> sesión (la cookie previa).
--        Límite conocido: dos logins simultáneos del mismo usuario que necesitan re-hash: el segundo ve el hash
--        ya re-calculado por el primero y responde como credenciales inválidas (el reintento entra). La misma
--        cookie haciendo login y cambio de contraseña a la vez puede interbloquearse como en O-2 (40P01 ->
--        500 genérico, sin sesión indebida).

DROP FUNCTION IF EXISTS auth.login_exito(bytea, uuid, bytea, uuid, text, bytea);--> statement-breakpoint

-- Login correcto: exige que la credencial siga siendo la verificada, comprueba la membresía, reinicia el
-- contador, re-hash opcional, crea la sesión (12 h) y revoca la cookie previa (no se promueve).
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

-- Dueño contapp_auth; EXECUTE solo para contapp_backend (ni PUBLIC, ni worker, ni platform, ni contapp_app).
ALTER FUNCTION auth.login_exito(bytea, uuid, text, bytea, uuid, text, bytea) OWNER TO contapp_auth;--> statement-breakpoint

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA auth FROM PUBLIC, contapp_worker, contapp_platform, contapp_app;--> statement-breakpoint
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO contapp_backend;
