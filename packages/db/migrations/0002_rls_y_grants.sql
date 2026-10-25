-- 0002_rls_y_grants (custom). Dueño, RLS ENABLE + FORCE, políticas y privilegios mínimos (03 §4).
ALTER TABLE public.tenant OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.usuario OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.membresia OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.cliente OWNER TO contapp_migrator;--> statement-breakpoint

ALTER TABLE public.membresia ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.membresia FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.cliente ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.cliente FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.membresia FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
-- P7: listar los estudios de un usuario antes de elegir uno (solo SELECT y solo sin tenant fijado).
CREATE POLICY membresia_por_usuario ON public.membresia FOR SELECT
  USING (nullif(current_setting('app.tenant_id', true), '') IS NULL
         AND usuario_id = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.cliente FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- Base actual: sin TEMP ni CONNECT para PUBLIC; solo el rol de login conecta.
DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO contapp_app', current_database());
END
$$;--> statement-breakpoint

-- Esquema public: USAGE a los roles de la app. contapp_app recibe USAGE (sin privilegios sobre tablas)
-- para que sus consultas a tablas fallen con permission denied (CA-2, CA-4) y no con "relation does not exist".
-- contapp_migrator (dueño) necesita USAGE: las comprobaciones de FK corren como dueño de la tabla referida.
REVOKE ALL ON SCHEMA public FROM PUBLIC;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO contapp_migrator, contapp_backend, contapp_worker, contapp_platform, contapp_app;--> statement-breakpoint

REVOKE ALL ON public.tenant, public.usuario, public.membresia, public.cliente FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.membresia, public.cliente TO contapp_backend, contapp_worker;--> statement-breakpoint
GRANT SELECT ON public.tenant, public.usuario TO contapp_backend;--> statement-breakpoint
GRANT SELECT ON public.tenant TO contapp_worker;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.tenant, public.usuario TO contapp_platform;
