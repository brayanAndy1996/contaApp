-- 0016_acceso_ronda2 (spec 005, T17): correcciones de la ronda adversarial 2 en la BD. Esqueleto con
-- `drizzle-kit generate --custom` y SQL a mano. 0000–0015 no se editan. Repetible (comprobación sin efectos +
-- CREATE OR REPLACE con la misma firma y tipo de retorno que 0015; FUNCIONES_AUTH sigue en 15), con dueño,
-- `search_path` y ACL explícitos.
--
-- H-005-2a-2 = H-005-2b-2 (variante de H-005-1b-3): el nombre de la cuenta nueva tampoco admite caracteres de
-- formato (\p{Cf}: ancho cero, marcas y aislamientos bidireccionales, BOM, etiquetas) y debe tener al menos una
-- letra o un dígito decimal (\p{L} o \p{Nd}). El backend valida lo mismo antes de Argon2 (400). Aquí:
--   * control (\p{Cc}) y formato (\p{Cf}) por rangos de código explícitos (Unicode 16, el de Node 24), sin
--     depender del locale de la base; NUL no existe en `text`;
--   * letra o dígito con `[[:alnum:]]` bajo la colación ICU `und-x-icu` (u_isalnum = \p{L} o \p{Nd}), igual en
--     cualquier locale (con un locale C, `[[:alnum:]]` solo vería ASCII y rechazaría "李明").
-- Los patrones van en E'' con la barra doblada: su lectura no depende de `standard_conforming_strings`.

-- La colación ICU existe en PostgreSQL 17 compilado con ICU (imagen oficial, instalador de Windows). Si falta,
-- la migración falla aquí y no en la primera aceptación.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_collation
                  WHERE collname = 'und-x-icu' AND collnamespace = 'pg_catalog'::regnamespace) THEN
    RAISE EXCEPTION '0016_acceso_ronda2 requiere la colación ICU pg_catalog."und-x-icu"';
  END IF;
END
$$;--> statement-breakpoint

-- CA-3 como en 0015 (invitador con autoridad, H-005-1b-1) con la validación de nombre ampliada. Todo rechazo de
-- nombre devuelve 'invalida' sin efectos, antes de mirar la invitación.
CREATE OR REPLACE FUNCTION auth.invitacion_aceptar_nueva(p_token_hash bytea, p_nombre text, p_hash text)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  i public.invitacion%ROWTYPE;
  v_usuario uuid;
BEGIN
  IF p_nombre IS NULL OR btrim(p_nombre) = '' OR char_length(p_nombre) > 200
     OR p_nombre ~ E'[\\u0001-\\u001f\\u007f-\\u009f\\u00ad\\u0600-\\u0605\\u061c\\u06dd\\u070f\\u0890-\\u0891\\u08e2\\u180e\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u206f\\ufeff\\ufff9-\\ufffb\\U000110bd\\U000110cd\\U00013430-\\U0001343f\\U0001bca0-\\U0001bca3\\U0001d173-\\U0001d17a\\U000e0001\\U000e0020-\\U000e007f]'
     OR NOT (p_nombre COLLATE pg_catalog."und-x-icu" ~ '[[:alnum:]]') THEN
    RETURN 'invalida';
  END IF;
  SELECT * INTO i FROM public.invitacion x
   WHERE x.token_hash = p_token_hash AND x.aceptada_en IS NULL AND x.revocada_en IS NULL
     AND x.vence_en > now()
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'invalida';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.membresia g
                  WHERE g.tenant_id = i.tenant_id AND g.usuario_id = i.invitado_por
                    AND g.desactivada_en IS NULL
                    AND (g.rol = 'dueno' OR (g.rol = 'admin' AND i.rol <> 'dueno'))) THEN
    RETURN 'invalida';
  END IF;
  IF EXISTS (SELECT 1 FROM public.usuario u WHERE u.email = i.correo) THEN
    RETURN 'cuenta_existe';
  END IF;
  BEGIN
    INSERT INTO public.usuario AS u (email, nombre) VALUES (i.correo, p_nombre) RETURNING u.id INTO v_usuario;
  EXCEPTION WHEN unique_violation THEN
    RETURN 'invalida';
  END;
  INSERT INTO auth.usuario_contrasena (usuario_id, hash, actualizada_en) VALUES (v_usuario, p_hash, now());
  INSERT INTO public.membresia (tenant_id, usuario_id, rol) VALUES (i.tenant_id, v_usuario, i.rol);
  UPDATE public.invitacion x SET aceptada_en = now(), aceptada_por = v_usuario WHERE x.id = i.id;
  RETURN 'aceptada';
END
$$;--> statement-breakpoint

-- Dueño contapp_auth; EXECUTE solo para contapp_backend (ni PUBLIC, ni worker, ni platform, ni contapp_app).
ALTER FUNCTION auth.invitacion_aceptar_nueva(bytea, text, text) OWNER TO contapp_auth;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth.invitacion_aceptar_nueva(bytea, text, text) FROM PUBLIC, contapp_worker, contapp_platform, contapp_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth.invitacion_aceptar_nueva(bytea, text, text) TO contapp_backend;
