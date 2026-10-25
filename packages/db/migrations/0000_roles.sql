-- 0000_roles (custom). Roles del clúster (idempotentes: existen entre bases, CA-1) y uuid_v7().
-- Sin contraseñas: migrar.ts fija la de contapp_app con un verificador SCRAM calculado en el cliente.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'contapp_migrator') THEN
    CREATE ROLE contapp_migrator NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'contapp_backend') THEN
    CREATE ROLE contapp_backend NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'contapp_worker') THEN
    CREATE ROLE contapp_worker NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'contapp_platform') THEN
    CREATE ROLE contapp_platform NOLOGIN BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'contapp_app') THEN
    CREATE ROLE contapp_app LOGIN NOINHERIT;
  END IF;
END
$$;
--> statement-breakpoint
-- Atributos forzados aunque el rol ya existiera en el clúster.
ALTER ROLE contapp_migrator NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;--> statement-breakpoint
ALTER ROLE contapp_backend NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;--> statement-breakpoint
ALTER ROLE contapp_worker NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;--> statement-breakpoint
ALTER ROLE contapp_platform NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;--> statement-breakpoint
ALTER ROLE contapp_app LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;--> statement-breakpoint
-- Mensajes del servidor en inglés para la app (estables para logs y pruebas, sin depender del locale del clúster).
ALTER ROLE contapp_app SET lc_messages TO 'C';--> statement-breakpoint
-- El rol de login solo puede hacer SET ROLE hacia los roles de la app; no hereda sus privilegios (PG >= 16).
GRANT contapp_backend, contapp_worker, contapp_platform TO contapp_app WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;--> statement-breakpoint
-- PG 17 no trae uuidv7(): versión SQL (SECURITY INVOKER) sobre gen_random_uuid().
CREATE OR REPLACE FUNCTION public.uuid_v7() RETURNS uuid
  LANGUAGE sql VOLATILE PARALLEL SAFE SECURITY INVOKER
AS $$
  SELECT encode(
    set_bit(
      set_bit(
        overlay(uuid_send(gen_random_uuid())
                placing substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
                FROM 1 FOR 6),
        52, 1),
      53, 1),
    'hex')::uuid
$$;--> statement-breakpoint
ALTER FUNCTION public.uuid_v7() OWNER TO contapp_migrator;
