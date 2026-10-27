-- 0012_acceso_rls (custom, spec 005). Dueño, RLS ENABLE + FORCE, tenant_isolation y privilegios mínimos de
-- asignacion e invitacion (CA-13); trigger del último Dueño (D10, RF-028). Repetible: DROP ... IF EXISTS,
-- CREATE OR REPLACE y GRANT/REVOKE idempotentes.

ALTER TABLE public.asignacion OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.invitacion OWNER TO contapp_migrator;--> statement-breakpoint

ALTER TABLE public.asignacion ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.asignacion FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.invitacion ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.invitacion FORCE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation ON public.asignacion;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.asignacion FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.invitacion;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.invitacion FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- Privilegios: solo contapp_backend (invitacion sin DELETE: se revoca, nunca se borra). Worker, platform y el
-- rol de login no tocan estas tablas. Los de contapp_auth sobre invitacion están en 0013_acceso_auth.
REVOKE ALL ON public.asignacion, public.invitacion
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.asignacion TO contapp_backend;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.invitacion TO contapp_backend;--> statement-breakpoint

-- D10: un estudio no se queda sin Dueño activo. Solo mira transiciones (OLD era Dueño activo y NEW no lo es, o
-- se borró): un estudio sin Dueño (fixtures) no bloquea otras filas. El bloqueo por estudio serializa dos
-- degradaciones simultáneas; tras obtenerlo, la consulta ve lo ya confirmado (READ COMMITTED, nueva instantánea).
-- SECURITY INVOKER: corre con los permisos y la RLS de quien modifica la fila (fuera del esquema `auth`).
CREATE OR REPLACE FUNCTION public.membresia_ultimo_dueno() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.rol <> 'dueno' OR OLD.desactivada_en IS NOT NULL THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.rol = 'dueno' AND NEW.desactivada_en IS NULL AND NEW.tenant_id = OLD.tenant_id THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('acceso.duenos:' || OLD.tenant_id::text, 0));
  IF NOT EXISTS (
    SELECT 1 FROM public.membresia m
     WHERE m.tenant_id = OLD.tenant_id AND m.rol = 'dueno' AND m.desactivada_en IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'el estudio debe conservar al menos un Dueño activo';
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.membresia_ultimo_dueno() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.membresia_ultimo_dueno() FROM PUBLIC;--> statement-breakpoint

DROP TRIGGER IF EXISTS membresia_ultimo_dueno ON public.membresia;--> statement-breakpoint
CREATE TRIGGER membresia_ultimo_dueno AFTER UPDATE OR DELETE ON public.membresia
  FOR EACH ROW EXECUTE FUNCTION public.membresia_ultimo_dueno();
