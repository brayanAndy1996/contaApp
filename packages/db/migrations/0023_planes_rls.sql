-- 0023_planes_rls (custom, spec 006). Dueño, RLS ENABLE + FORCE y tenant_isolation (solo SELECT) de suscripcion, y
-- privilegios mínimos de plan, suscripcion y admin_plataforma (CA-1, CA-8). Esqueleto con
-- `drizzle-kit generate --custom`. Repetible: DROP ... IF EXISTS y GRANT/REVOKE idempotentes. Las políticas y los
-- privilegios de contapp_auth están en 0024_planes_auth.

ALTER TABLE public.plan OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.suscripcion OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.admin_plataforma OWNER TO contapp_migrator;--> statement-breakpoint

-- suscripcion es de estudio: el backend lee solo la de su estudio y nunca escribe (ninguna política de escritura
-- para la app; CA-1 se cumple en la BD aunque alguien le concediera UPDATE). plan y admin_plataforma son de
-- plataforma, sin tenant_id ni RLS: los protegen los grants.
ALTER TABLE public.suscripcion ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.suscripcion FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.suscripcion;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.suscripcion FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- Privilegios: nadie de la app escribe estas tablas. contapp_backend lee su suscripción y las columnas de plan sin
-- precios (D8: el backend de un estudio no lee precios; un fallo en GET /plan/uso no puede filtrarlos).
-- admin_plataforma: ningún rol de la app (solo contapp_auth, en 0024). Worker, platform, el rol de login y el
-- enumerador no tienen acceso (la plataforma sigue fuera del login, 002 D8).
REVOKE ALL ON public.plan, public.suscripcion, public.admin_plataforma
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_enumerador;--> statement-breakpoint
GRANT SELECT ON public.suscripcion TO contapp_backend;--> statement-breakpoint
GRANT SELECT (id, codigo, nombre, max_rucs, max_usuarios, max_rucs_extra, frecuencia_buzon_min, features, activo,
              created_at, updated_at)
  ON public.plan TO contapp_backend;
