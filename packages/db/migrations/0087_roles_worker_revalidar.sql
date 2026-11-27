-- 0087_roles_worker_revalidar (custom, spec 030, T17a; D3, CA-4; dictamen T17-1).
-- El despachador del worker revalida a quien encoló con los permisos EFECTIVOS y el alcance de su membresía (rol de sistema o propio),
-- no por clave de rol: `revalidarEncolado` (packages/db/src/trabajos/registro.ts) llama a acceso.permisos_membresia. El worker obtiene
-- USAGE en el esquema `acceso` y EXECUTE solo sobre el resolvedor; las funciones de gestión (rol_guardar, rol_eliminar, rol_impacto,
-- rol_asignable) y las internas siguen cerradas para él. Sin CREATE en el esquema. El resolvedor no toma bloqueos (orden D4 intacto) y
-- lee con app.tenant_id fijado al estudio pedido (RLS FORCE de membresia, rol y rol_permiso; dueño sin BYPASSRLS).
-- Patrón de 0082: REVOKE de PUBLIC y de cada rol antes del GRANT justo (los mismos de 0082: backend sin EXECUTE, auth y worker con él).
-- Repetible.

GRANT USAGE ON SCHEMA acceso TO contapp_worker;--> statement-breakpoint
REVOKE ALL ON FUNCTION acceso.permisos_membresia(uuid, uuid)
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION acceso.permisos_membresia(uuid, uuid) TO contapp_auth, contapp_worker;
