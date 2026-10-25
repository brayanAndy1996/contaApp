-- 0006_credencial_rls_y_grants (custom, spec 003). Dueño, RLS ENABLE + FORCE, tenant_isolation y
-- privilegios por columna. contapp_backend NO tiene SELECT de tabla ni de ninguna columna del sobre
-- (CA-4c): escribe el sobre a ciegas. La rotación (contapp_worker) solo puede tocar dek_envuelta,
-- kek_id y updated_at. La auditoría es solo de inserción para contapp_worker; nadie la lee desde la app.
-- Sentencias repetibles: ALTER/REVOKE/GRANT son idempotentes y la política se recrea con DROP ... IF EXISTS.
ALTER TABLE public.credencial OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.auditoria_descifrado OWNER TO contapp_migrator;--> statement-breakpoint

ALTER TABLE public.credencial ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.credencial FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.auditoria_descifrado ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.auditoria_descifrado FORCE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation ON public.credencial;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.credencial FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.auditoria_descifrado;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.auditoria_descifrado FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- Punto de partida limpio: ningún privilegio de tabla ni de columna para PUBLIC ni para los roles de la app.
REVOKE ALL ON public.credencial, public.auditoria_descifrado
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app;--> statement-breakpoint
REVOKE ALL (id, tenant_id, cliente_id, tipo, ciphertext, nonce, tag, dek_envuelta, kek_id, version, created_at, updated_at)
  ON public.credencial
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app;--> statement-breakpoint
REVOKE ALL (id, tenant_id, credencial_id, cliente_id, tipo, motivo, resultado, created_at)
  ON public.auditoria_descifrado
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app;--> statement-breakpoint

-- contapp_backend: estado legible; el sobre solo se escribe (INSERT/UPDATE sin SELECT).
GRANT SELECT (id, tenant_id, cliente_id, tipo, created_at, updated_at) ON public.credencial TO contapp_backend;--> statement-breakpoint
GRANT INSERT (cliente_id, tipo, ciphertext, nonce, tag, dek_envuelta, kek_id, version) ON public.credencial TO contapp_backend;--> statement-breakpoint
GRANT UPDATE (ciphertext, nonce, tag, dek_envuelta, kek_id, version, updated_at) ON public.credencial TO contapp_backend;--> statement-breakpoint

-- contapp_worker: lee el sobre completo; la rotación solo re-envuelve la DEK (la BD impide tocar ciphertext/nonce/tag).
GRANT SELECT ON public.credencial TO contapp_worker;--> statement-breakpoint
GRANT UPDATE (dek_envuelta, kek_id, updated_at) ON public.credencial TO contapp_worker;--> statement-breakpoint

-- Auditoría: solo inserción de las columnas del registro (tenant_id lo pone el contexto).
GRANT INSERT (credencial_id, cliente_id, tipo, motivo, resultado) ON public.auditoria_descifrado TO contapp_worker;
