-- 0009_auth_ronda2 (custom, spec 004, T18): correcciones de la ronda adversarial 2 sobre 0007.
-- Repetible: CREATE OR REPLACE, ALTER OWNER y GRANT/REVOKE idempotentes. Sin funciones nuevas.
--   H-r2b-1, H-r2b-2  Una rotación (cambio de estudio) concurrente con "cerrar todas", restablecer o cambiar
--          la contraseña dejaba viva la sesión rotada: el UPDATE que revoca todas no ve la fila que inserta una
--          transacción aún abierta (READ COMMITTED). Ahora la rotación se serializa con cada una:
--          * sesion_rotar y sesiones_cerrar_todas toman pg_advisory_xact_lock por usuario
--            (clave 'auth.sesiones:<usuario>');
--          * sesion_rotar toma además FOR SHARE la fila del usuario en auth.usuario_contrasena, que
--            recuperacion_consumir y contrasena_cambiar ya bloquean (upsert) antes de revocar las sesiones:
--            así esas dos quedan serializadas con la rotación sin redefinirlas (0007/0008 intactas).
--          Orden de bloqueo de la rotación: usuario (advisory) -> credencial -> sesión. Tras los bloqueos la
--          sesión se vuelve a leer con una instantánea nueva: si un cierre/restablecer/cambio la revocó mientras
--          esperaba, no rota; si la rotación ganó, la revocación posterior ya ve la sesión nueva confirmada.
--          Límite conocido: la misma cookie cambiando de estudio y de contraseña a la vez puede interbloquearse
--          (contrasena_cambiar bloquea su sesión antes que la credencial); PostgreSQL aborta una de las dos
--          (40P01 -> 500 genérico) y ninguna deja una sesión viva indebida.

-- D4, CA-5: rota conservando creada_en y expira_absoluta; re-comprueba la membresía del estudio nuevo.
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

-- P2: el usuario sale de la sesión vigente (no de un parámetro); cuenta también la propia. La revocación
-- corre tras el bloqueo del usuario, con una instantánea que ya incluye las rotaciones confirmadas.
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
  PERFORM pg_advisory_xact_lock(hashtextextended('auth.sesiones:' || v_usuario::text, 0));
  UPDATE auth.sesion x SET revocada_en = now(), motivo = 'cerrar_todas'
   WHERE x.usuario_id = v_usuario AND x.revocada_en IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;--> statement-breakpoint

-- Dueño contapp_auth; EXECUTE solo para contapp_backend (ni PUBLIC, ni worker, ni platform, ni contapp_app).
ALTER FUNCTION auth.sesion_rotar(bytea, bytea, uuid) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.sesiones_cerrar_todas(bytea) OWNER TO contapp_auth;--> statement-breakpoint

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA auth FROM PUBLIC, contapp_worker, contapp_platform, contapp_app;--> statement-breakpoint
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO contapp_backend;
