-- 0003_rls_plataforma_y_roles (custom). Correcciones de la ronda adversarial 1 (T9, spec 002).
-- H2 (decisión del usuario, opción A): el rol de login solo puede pasar a backend y worker. contapp_platform
-- tendrá su propio login cuando una spec lo necesite. Que worker pueda pasar a backend es riesgo aceptado.
REVOKE contapp_platform FROM contapp_app;--> statement-breakpoint

-- H6: tenant y usuario con RLS de solo lectura para los roles de la app (platform tiene BYPASSRLS y el
-- dueño solo se usa en migraciones; las comprobaciones de FK no aplican RLS). Sin políticas para
-- INSERT/UPDATE/DELETE: backend y worker no tienen esos grants y, además, RLS los deniega.
-- El nombre tenant_isolation es el único permitido por el catálogo (CA-3) fuera de membresia.
ALTER TABLE public.tenant ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.tenant FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.usuario ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.usuario FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- tenant: dentro de withTenant solo el estudio actual; en withUsuario (sin tenant, P7) los estudios
-- donde el usuario tiene membresía (la subconsulta respeta además membresia_por_usuario).
CREATE POLICY tenant_isolation ON public.tenant FOR SELECT
  USING (
    id = nullif(current_setting('app.tenant_id', true), '')::uuid
    OR (
      nullif(current_setting('app.tenant_id', true), '') IS NULL
      AND EXISTS (
        SELECT 1 FROM public.membresia m
         WHERE m.tenant_id = tenant.id
           AND m.usuario_id = nullif(current_setting('app.user_id', true), '')::uuid
      )
    )
  );--> statement-breakpoint

-- usuario: el propio usuario (app.user_id) y, dentro de withTenant, los miembros del estudio actual.
CREATE POLICY tenant_isolation ON public.usuario FOR SELECT
  USING (
    id = nullif(current_setting('app.user_id', true), '')::uuid
    OR EXISTS (
      SELECT 1 FROM public.membresia m
       WHERE m.usuario_id = usuario.id
         AND m.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    )
  );
