-- 0082_roles_propios (custom, spec 030, T6; D1–D4, U1–U10; CA-1, CA-2, CA-5–CA-10). Roles propios del estudio.
-- DDL de drizzle-kit (tablas rol y rol_permiso, rol_id de membresia e invitacion, CHECK de rol con 'propio', vence_en de invitacion con
-- 72 h por defecto y CHECK de auditoria.accion con las tres acciones rol.*) reescrito para ser REPETIBLE (IF NOT EXISTS, DROP ... IF EXISTS
-- antes de cada ADD CONSTRAINT); luego dueño, RLS FORCE y privilegios (solo SELECT para contapp_backend), el esquema `acceso` con el
-- resolvedor SQL y las funciones de gestión, el disparador de asignación y las nuevas versiones de las funciones de auth que decidían por
-- `rol IN (...)`.
--
-- Decisiones (T6):
--   * Orden de bloqueo fijo (D4): advisory `acceso.roles:<estudio>` -> membresías (actor y miembros del rol, FOR NO KEY UPDATE para no
--     chocar con el FOR KEY SHARE de las FK) -> fila de `rol` FOR UPDATE -> asignaciones -> invitaciones -> advisory `acceso.duenos`
--     (disparador de 0012). Aceptar una invitación toma el mismo advisory antes de bloquear la invitación; el disparador de asignación,
--     que corre con la membresía o la invitación ya en curso, solo bloquea la fila del rol FOR SHARE.
--   * U5/CA-6: eliminar un rol referido por cualquier membresía (activa o desactivada) o invitación (de cualquier estado) se rechaza con
--     23503, igual que la FK RESTRICT: nunca queda una fila con un rol inexistente y la historia de las invitaciones no se reescribe.
--   * U6: al perder `sire.clasificar`, las filas de responsable de sus miembros pasan a colaborador (como el cambio de rol de 005 D18).
--   * U10: las funciones de avisos (destinatarios, notificar, uso del plan, credencial inválida, correo) no cambian: siguen por 'dueno' y
--     'admin'; un rol propio nunca cuenta como Dueño (U7, membresia_ultimo_dueno sin cambio).

CREATE TABLE IF NOT EXISTS "rol" (
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"nombre" text NOT NULL,
	"nombre_clave" text GENERATED ALWAYS AS (lower(regexp_replace(normalize(btrim(nombre), NFD), '[\u0300-\u036f]', '', 'g'))) STORED NOT NULL,
	"alcance" text NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rol_tenant_nombre_clave_unique" UNIQUE("tenant_id","nombre_clave"),
	CONSTRAINT "rol_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "rol_alcance_valido" CHECK ("rol"."alcance" IN ('global', 'asignado')),
	CONSTRAINT "rol_nombre_valido" CHECK (char_length("rol"."nombre") BETWEEN 1 AND 40 AND btrim("rol"."nombre") <> '' AND "rol"."nombre" !~ '[[:cntrl:]]'),
	CONSTRAINT "rol_nombre_clave_no_sistema" CHECK ("rol"."nombre_clave" NOT IN ('dueno', 'administrador', 'admin', 'contador', 'asistente', 'lectura', 'solo lectura'))
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rol_permiso" (
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"rol_id" uuid NOT NULL,
	"permiso" text NOT NULL,
	CONSTRAINT "rol_permiso_pk" PRIMARY KEY("rol_id","permiso"),
	CONSTRAINT "rol_permiso_catalogo" CHECK ("rol_permiso"."permiso" IN ('estudio.configurar', 'usuarios.ver', 'usuarios.gestionar', 'roles.gestionar', 'clientes.ver', 'clientes.crear', 'clientes.editar', 'clientes.archivar', 'clientes.asignar', 'credenciales.editar', 'sire.descargar', 'sire.clasificar', 'sire.aprobar_generar', 'ajustes.crear', 'ajustes.generar', 'buzon.ver', 'buzon.marcar_leido', 'buzon.atender', 'reglas.ver', 'reglas.gestionar', 'prorrata.ver', 'prorrata.gestionar', 'auditoria.ver'))
);--> statement-breakpoint
ALTER TABLE "invitacion" DROP CONSTRAINT IF EXISTS "invitacion_rol_valido";--> statement-breakpoint
ALTER TABLE "membresia" DROP CONSTRAINT IF EXISTS "membresia_rol_valido";--> statement-breakpoint
ALTER TABLE "auditoria" DROP CONSTRAINT IF EXISTS "auditoria_accion_valida";--> statement-breakpoint
ALTER TABLE "invitacion" ALTER COLUMN "vence_en" SET DEFAULT now() + interval '72 hours';--> statement-breakpoint
ALTER TABLE "invitacion" ADD COLUMN IF NOT EXISTS "rol_id" uuid;--> statement-breakpoint
ALTER TABLE "membresia" ADD COLUMN IF NOT EXISTS "rol_id" uuid;--> statement-breakpoint
ALTER TABLE "rol" DROP CONSTRAINT IF EXISTS "rol_tenant_id_tenant_id_fk";--> statement-breakpoint
ALTER TABLE "rol" ADD CONSTRAINT "rol_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rol_permiso" DROP CONSTRAINT IF EXISTS "rol_permiso_rol_fk";--> statement-breakpoint
ALTER TABLE "rol_permiso" ADD CONSTRAINT "rol_permiso_rol_fk" FOREIGN KEY ("tenant_id","rol_id") REFERENCES "public"."rol"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rol_permiso_tenant_rol_idx" ON "rol_permiso" USING btree ("tenant_id","rol_id");--> statement-breakpoint
ALTER TABLE "invitacion" DROP CONSTRAINT IF EXISTS "invitacion_rol_fk";--> statement-breakpoint
ALTER TABLE "invitacion" ADD CONSTRAINT "invitacion_rol_fk" FOREIGN KEY ("tenant_id","rol_id") REFERENCES "public"."rol"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membresia" DROP CONSTRAINT IF EXISTS "membresia_rol_fk";--> statement-breakpoint
ALTER TABLE "membresia" ADD CONSTRAINT "membresia_rol_fk" FOREIGN KEY ("tenant_id","rol_id") REFERENCES "public"."rol"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invitacion_tenant_rol_idx" ON "invitacion" USING btree ("tenant_id","rol_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "membresia_tenant_rol_idx" ON "membresia" USING btree ("tenant_id","rol_id");--> statement-breakpoint
ALTER TABLE "invitacion" DROP CONSTRAINT IF EXISTS "invitacion_rol_propio_coherente";--> statement-breakpoint
ALTER TABLE "invitacion" ADD CONSTRAINT "invitacion_rol_propio_coherente" CHECK (("invitacion"."rol" = 'propio') = ("invitacion"."rol_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "invitacion" ADD CONSTRAINT "invitacion_rol_valido" CHECK ("invitacion"."rol" IN ('dueno', 'admin', 'contador', 'asistente', 'lectura', 'propio'));--> statement-breakpoint
ALTER TABLE "membresia" DROP CONSTRAINT IF EXISTS "membresia_rol_propio_coherente";--> statement-breakpoint
ALTER TABLE "membresia" ADD CONSTRAINT "membresia_rol_propio_coherente" CHECK (("membresia"."rol" = 'propio') = ("membresia"."rol_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "membresia" ADD CONSTRAINT "membresia_rol_valido" CHECK ("membresia"."rol" IN ('dueno', 'admin', 'contador', 'asistente', 'lectura', 'propio'));--> statement-breakpoint
ALTER TABLE "auditoria" ADD CONSTRAINT "auditoria_accion_valida" CHECK ("auditoria"."accion" IN ('sesion.ingreso', 'invitacion.creada', 'invitacion.revocada', 'invitacion.modificada', 'miembro.alta', 'miembro.rol_cambiado', 'miembro.desactivado', 'miembro.reactivado', 'miembro.eliminado', 'asignacion.agregada', 'asignacion.quitada', 'asignacion.tipo_cambiado', 'cliente.creado', 'cliente.editado', 'cliente.archivado', 'cliente.reactivado', 'cliente.eliminado', 'credencial.guardada', 'credencial.verificada', 'credencial.invalidada', 'credencial.descifrada', 'propuesta.cargada', 'compra.operacion', 'venta.agregada', 'venta.excluida', 'venta.restaurada', 'venta.salto_justificado', 'xml.subido', 'periodo.estado_cambiado', 'archivo.generado', 'sunat.envio', 'regla.creada', 'regla.editada', 'regla.activada', 'regla.desactivada', 'regla.eliminada', 'estudio.regla_motor', 'estudio.aporte_catalogo', 'compra.historial', 'buzon.captura_solicitada', 'buzon.apertura_solicitada', 'buzon.contenido_visto', 'buzon.adjunto_descargado', 'buzon.contenido_obtenido', 'buzon.atendido', 'buzon.atencion_deshecha', 'regla.historial_importado', 'regla.candidata_descartada', 'prorrata.declaraciones_obtenidas', 'prorrata.mes_manual_guardado', 'prorrata.mes_manual_eliminado', 'prorrata.usada_guardada', 'gnd.palabra_agregada', 'gnd.palabra_desactivada', 'gnd.palabra_reactivada', 'gnd.palabra_aprendida', 'gnd.global_desactivada', 'gnd.global_reactivada', 'gnd.umbral_cambiado', 'gnd.categorias_cliente', 'correo.preferencia_cambiada', 'rol.creado', 'rol.editado', 'rol.eliminado'));
--> statement-breakpoint

-- ===================================================================================================
-- Dueño, RLS y privilegios de rol / rol_permiso (patrón de 0012): RLS ENABLE + FORCE, una sola política tenant_isolation y solo SELECT
-- para contapp_backend. Nadie de la app escribe directo: escriben acceso.rol_guardar y acceso.rol_eliminar (dueño contapp_migrator).
-- ===================================================================================================
ALTER TABLE public.rol OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.rol_permiso OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.rol ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.rol FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.rol_permiso ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.rol_permiso FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.rol;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.rol FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.rol_permiso;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.rol_permiso FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
REVOKE ALL ON public.rol, public.rol_permiso
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT SELECT ON public.rol, public.rol_permiso TO contapp_backend;--> statement-breakpoint

-- ===================================================================================================
-- Esquema acceso: funciones SECURITY DEFINER de contapp_migrator, search_path fijo, sin EXECUTE para PUBLIC.
-- ===================================================================================================
CREATE SCHEMA IF NOT EXISTS acceso;--> statement-breakpoint
ALTER SCHEMA acceso OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON SCHEMA acceso FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth;--> statement-breakpoint
GRANT USAGE ON SCHEMA acceso TO contapp_backend, contapp_auth;--> statement-breakpoint

-- Catálogo de 01 §4 sin `plan.gestionar` (el mismo del CHECK de rol_permiso), en el orden del catálogo.
CREATE OR REPLACE FUNCTION acceso.permisos_asignables() RETURNS text[]
  LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT ARRAY['estudio.configurar', 'usuarios.ver', 'usuarios.gestionar', 'roles.gestionar', 'clientes.ver', 'clientes.crear',
               'clientes.editar', 'clientes.archivar', 'clientes.asignar', 'credenciales.editar', 'sire.descargar', 'sire.clasificar',
               'sire.aprobar_generar', 'ajustes.crear', 'ajustes.generar', 'buzon.ver', 'buzon.marcar_leido', 'buzon.atender',
               'reglas.ver', 'reglas.gestionar', 'prorrata.ver', 'prorrata.gestionar', 'auditoria.ver']::text[]
$$;--> statement-breakpoint

-- Matriz de 005 (D2/D17), espejo de PERMISOS_POR_ROL de shared. NULL para un rol que no es de sistema.
CREATE OR REPLACE FUNCTION acceso.permisos_sistema(p_rol text) RETURNS text[]
  LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE p_rol
    WHEN 'dueno' THEN acceso.permisos_asignables() || ARRAY['plan.gestionar']::text[]
    WHEN 'admin' THEN acceso.permisos_asignables()
    WHEN 'contador' THEN ARRAY['clientes.ver', 'credenciales.editar', 'sire.descargar', 'sire.clasificar', 'sire.aprobar_generar',
                               'ajustes.crear', 'ajustes.generar', 'buzon.ver', 'buzon.marcar_leido', 'buzon.atender', 'reglas.ver',
                               'reglas.gestionar', 'prorrata.ver', 'prorrata.gestionar']::text[]
    WHEN 'asistente' THEN ARRAY['clientes.ver', 'sire.descargar', 'sire.clasificar', 'buzon.ver', 'buzon.marcar_leido', 'buzon.atender',
                                'reglas.ver', 'prorrata.ver']::text[]
    WHEN 'lectura' THEN ARRAY['clientes.ver', 'buzon.ver', 'reglas.ver', 'prorrata.ver']::text[]
  END
$$;--> statement-breakpoint

-- U3: toda acción exige el `.ver` de su módulo y todo permiso de cliente exige `clientes.ver` (las 23 reglas de REGLAS_U3).
CREATE OR REPLACE FUNCTION acceso.combinacion_valida(p_permisos text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT NOT EXISTS (
    SELECT 1
      FROM (VALUES ('usuarios.gestionar', 'usuarios.ver'), ('roles.gestionar', 'usuarios.ver'), ('buzon.marcar_leido', 'buzon.ver'),
                   ('buzon.atender', 'buzon.ver'), ('reglas.gestionar', 'reglas.ver'), ('prorrata.gestionar', 'prorrata.ver'),
                   ('clientes.crear', 'clientes.ver'), ('clientes.editar', 'clientes.ver'), ('clientes.archivar', 'clientes.ver'),
                   ('clientes.asignar', 'clientes.ver'), ('credenciales.editar', 'clientes.ver'), ('sire.descargar', 'clientes.ver'),
                   ('sire.clasificar', 'clientes.ver'), ('sire.aprobar_generar', 'clientes.ver'), ('ajustes.crear', 'clientes.ver'),
                   ('ajustes.generar', 'clientes.ver'), ('buzon.ver', 'clientes.ver'), ('buzon.marcar_leido', 'clientes.ver'),
                   ('buzon.atender', 'clientes.ver'), ('reglas.ver', 'clientes.ver'), ('reglas.gestionar', 'clientes.ver'),
                   ('prorrata.ver', 'clientes.ver'), ('prorrata.gestionar', 'clientes.ver')) AS r (permiso, requiere)
     WHERE r.permiso = ANY (coalesce(p_permisos, '{}'::text[])) AND NOT (r.requiere = ANY (coalesce(p_permisos, '{}'::text[])))
  )
$$;--> statement-breakpoint

-- U2/U4: los permisos y el alcance del rol tocado están contenidos en los del actor (global ⊇ asignado).
CREATE OR REPLACE FUNCTION acceso.contiene(p_actor_permisos text[], p_actor_alcance text, p_permisos text[], p_alcance text)
  RETURNS boolean
  LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce(p_permisos, '{}'::text[]) <@ coalesce(p_actor_permisos, '{}'::text[])
     AND (p_alcance = 'asignado' OR p_actor_alcance = 'global')
$$;--> statement-breakpoint

-- D3: espejo SQL del resolvedor de shared (`permisosEfectivos`, misma tabla CASOS_EFECTIVOS). Cero filas si la membresía no existe o está
-- desactivada. Lee con app.tenant_id fijado al estudio pedido (dueño sin BYPASSRLS, patrón de 0056) y lo restaura.
CREATE OR REPLACE FUNCTION acceso.permisos_membresia(p_tenant uuid, p_usuario uuid)
  RETURNS TABLE (rol_sistema text, permisos text[], alcance text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_previo text := current_setting('app.tenant_id', true);
  v_rol text;
  v_rol_id uuid;
  v_permisos text[];
  v_alcance text;
  v_hay boolean := false;
BEGIN
  IF p_tenant IS NULL OR p_usuario IS NULL THEN
    RETURN;
  END IF;
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  SELECT m.rol, m.rol_id INTO v_rol, v_rol_id FROM public.membresia m
   WHERE m.tenant_id = p_tenant AND m.usuario_id = p_usuario AND m.desactivada_en IS NULL;
  IF FOUND THEN
    IF v_rol = 'propio' THEN
      SELECT r.alcance,
             coalesce((SELECT array_agg(p.permiso ORDER BY p.permiso) FROM public.rol_permiso p
                        WHERE p.tenant_id = r.tenant_id AND p.rol_id = r.id), '{}'::text[])
        INTO v_alcance, v_permisos
        FROM public.rol r WHERE r.tenant_id = p_tenant AND r.id = v_rol_id;
      v_hay := FOUND;
      v_rol := NULL;
    ELSE
      v_permisos := acceso.permisos_sistema(v_rol);
      v_alcance := CASE WHEN v_rol IN ('dueno', 'admin') THEN 'global' ELSE 'asignado' END;
      v_hay := v_permisos IS NOT NULL;
    END IF;
  END IF;
  PERFORM set_config('app.tenant_id', coalesce(v_previo, ''), true);
  IF v_hay THEN
    RETURN QUERY SELECT v_rol, v_permisos, v_alcance;
  END IF;
END
$$;--> statement-breakpoint

-- Actor de las funciones de roles: app.user_id con una membresía activa en app.tenant_id y `roles.gestionar` (U1). Si no, 42501.
CREATE OR REPLACE FUNCTION acceso.actor_gestor(p_tenant uuid, p_usuario uuid)
  RETURNS TABLE (permisos text[], alcance text, rol_id uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_permisos text[];
  v_alcance text;
  v_rol_id uuid;
BEGIN
  IF p_tenant IS NULL OR p_usuario IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'acceso: sin permiso para gestionar roles';
  END IF;
  SELECT e.permisos, e.alcance INTO v_permisos, v_alcance FROM acceso.permisos_membresia(p_tenant, p_usuario) e;
  IF NOT FOUND OR NOT ('roles.gestionar' = ANY (v_permisos)) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'acceso: sin permiso para gestionar roles';
  END IF;
  SELECT m.rol_id INTO v_rol_id FROM public.membresia m WHERE m.tenant_id = p_tenant AND m.usuario_id = p_usuario;
  RETURN QUERY SELECT v_permisos, v_alcance, v_rol_id;
END
$$;--> statement-breakpoint

-- Crea (p_id NULL) o edita un rol propio (U1–U6, U9). Orden de bloqueo de D4: advisory `acceso.roles:<estudio>` -> membresías del actor y
-- de los miembros del rol (FOR NO KEY UPDATE: no choca con el FOR KEY SHARE de las FK) -> fila del rol FOR UPDATE -> asignaciones.
-- Errores con SQLSTATE y mensaje fijos (sin ids ni nombres): 42501 escalada o sin roles.gestionar, RL001 el rol propio del actor,
-- 22023 combinación (U3), 54000 límite (U9), 23505 nombre repetido, 23514 CHECK, P0002 rol inexistente o de otro estudio.
CREATE OR REPLACE FUNCTION acceso.rol_guardar(p_id uuid, p_nombre text, p_alcance text, p_permisos text[])
  RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  v_usuario uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  v_permisos text[];
  a record;
  r public.rol%ROWTYPE;
  v_antes text[];
  v_id uuid;
BEGIN
  IF v_tenant IS NULL OR v_usuario IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'acceso: sin permiso para gestionar roles';
  END IF;
  IF p_alcance IS NULL OR p_alcance NOT IN ('global', 'asignado') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'acceso: alcance de rol invalido';
  END IF;
  SELECT coalesce(array_agg(DISTINCT x ORDER BY x), '{}'::text[]) INTO v_permisos FROM unnest(coalesce(p_permisos, '{}'::text[])) AS x;
  IF EXISTS (SELECT 1 FROM unnest(v_permisos) AS x WHERE x IS NULL OR NOT (x = ANY (acceso.permisos_asignables()))) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'acceso: permiso fuera del catalogo';
  END IF;
  IF NOT acceso.combinacion_valida(v_permisos) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'acceso: combinacion de permisos invalida';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('acceso.roles:' || v_tenant::text, 0));
  PERFORM 1 FROM public.membresia m
   WHERE m.tenant_id = v_tenant AND (m.usuario_id = v_usuario OR m.rol_id = p_id)
   ORDER BY m.usuario_id
   FOR NO KEY UPDATE;
  SELECT g.permisos, g.alcance, g.rol_id INTO a FROM acceso.actor_gestor(v_tenant, v_usuario) g;

  IF p_id IS NULL THEN
    IF NOT acceso.contiene(a.permisos, a.alcance, v_permisos, p_alcance) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'acceso: el rol excede los permisos del actor';
    END IF;
    IF (SELECT count(*) FROM public.rol x WHERE x.tenant_id = v_tenant) >= 20 THEN
      RAISE EXCEPTION USING ERRCODE = '54000', MESSAGE = 'acceso: limite de roles propios alcanzado';
    END IF;
    INSERT INTO public.rol AS x (tenant_id, nombre, alcance) VALUES (v_tenant, p_nombre, p_alcance) RETURNING x.id INTO v_id;
    INSERT INTO public.rol_permiso (tenant_id, rol_id, permiso) SELECT v_tenant, v_id, x FROM unnest(v_permisos) AS x;
    PERFORM public.auditoria_registrar(v_tenant, 'rol.creado', NULL, 'rol', v_id,
      jsonb_build_object('antes', NULL,
                         'despues', jsonb_build_object('nombre', p_nombre, 'alcance', p_alcance, 'permisos', to_jsonb(v_permisos))));
    RETURN v_id;
  END IF;

  SELECT * INTO r FROM public.rol x WHERE x.tenant_id = v_tenant AND x.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'acceso: rol inexistente';
  END IF;
  IF a.rol_id IS NOT DISTINCT FROM p_id THEN
    RAISE EXCEPTION USING ERRCODE = 'RL001', MESSAGE = 'acceso: nadie gestiona el rol que tiene asignado';
  END IF;
  SELECT coalesce(array_agg(p.permiso ORDER BY p.permiso), '{}'::text[]) INTO v_antes
    FROM public.rol_permiso p WHERE p.tenant_id = v_tenant AND p.rol_id = p_id;
  IF NOT acceso.contiene(a.permisos, a.alcance, v_antes, r.alcance)
     OR NOT acceso.contiene(a.permisos, a.alcance, v_permisos, p_alcance) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'acceso: el rol excede los permisos del actor';
  END IF;
  UPDATE public.rol x SET nombre = p_nombre, alcance = p_alcance, actualizado_en = now()
   WHERE x.tenant_id = v_tenant AND x.id = p_id;
  DELETE FROM public.rol_permiso p WHERE p.tenant_id = v_tenant AND p.rol_id = p_id AND NOT (p.permiso = ANY (v_permisos));
  INSERT INTO public.rol_permiso (tenant_id, rol_id, permiso) SELECT v_tenant, p_id, x FROM unnest(v_permisos) AS x
  ON CONFLICT DO NOTHING;
  -- U6 (005 D18): sin `sire.clasificar`, los miembros del rol (activos o no) dejan de ser responsables: sus filas pasan a colaborador,
  -- como en el cambio de rol de 005, y esos clientes quedan sin responsable. La lista de miembros se lee tras el bloqueo del rol.
  IF 'sire.clasificar' = ANY (v_antes) AND NOT ('sire.clasificar' = ANY (v_permisos)) THEN
    UPDATE public.asignacion s SET tipo = 'colaborador', updated_at = now()
     WHERE s.tenant_id = v_tenant AND s.tipo = 'responsable'
       AND s.usuario_id IN (SELECT m.usuario_id FROM public.membresia m WHERE m.tenant_id = v_tenant AND m.rol_id = p_id);
  END IF;
  PERFORM public.auditoria_registrar(v_tenant, 'rol.editado', NULL, 'rol', p_id,
    jsonb_build_object('antes', jsonb_build_object('nombre', r.nombre, 'alcance', r.alcance, 'permisos', to_jsonb(v_antes)),
                       'despues', jsonb_build_object('nombre', p_nombre, 'alcance', p_alcance, 'permisos', to_jsonb(v_permisos))));
  RETURN p_id;
END
$$;--> statement-breakpoint

-- U5: un rol con membresías (activas o no) o invitaciones (de cualquier estado) no se elimina: 23503, como la FK RESTRICT (CA-6: nunca
-- queda una fila con un rol inexistente). El backend informa los conteos de miembros activos e invitaciones vigentes (409 rol_en_uso).
CREATE OR REPLACE FUNCTION acceso.rol_eliminar(p_id uuid)
  RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  v_usuario uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  a record;
  r public.rol%ROWTYPE;
  v_antes text[];
BEGIN
  IF v_tenant IS NULL OR v_usuario IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'acceso: sin permiso para gestionar roles';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('acceso.roles:' || v_tenant::text, 0));
  PERFORM 1 FROM public.membresia m
   WHERE m.tenant_id = v_tenant AND (m.usuario_id = v_usuario OR m.rol_id = p_id)
   ORDER BY m.usuario_id
   FOR NO KEY UPDATE;
  SELECT g.permisos, g.alcance, g.rol_id INTO a FROM acceso.actor_gestor(v_tenant, v_usuario) g;
  SELECT * INTO r FROM public.rol x WHERE x.tenant_id = v_tenant AND x.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'acceso: rol inexistente';
  END IF;
  IF a.rol_id IS NOT DISTINCT FROM p_id THEN
    RAISE EXCEPTION USING ERRCODE = 'RL001', MESSAGE = 'acceso: nadie gestiona el rol que tiene asignado';
  END IF;
  SELECT coalesce(array_agg(p.permiso ORDER BY p.permiso), '{}'::text[]) INTO v_antes
    FROM public.rol_permiso p WHERE p.tenant_id = v_tenant AND p.rol_id = p_id;
  IF NOT acceso.contiene(a.permisos, a.alcance, v_antes, r.alcance) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'acceso: el rol excede los permisos del actor';
  END IF;
  IF EXISTS (SELECT 1 FROM public.membresia m WHERE m.tenant_id = v_tenant AND m.rol_id = p_id)
     OR EXISTS (SELECT 1 FROM public.invitacion i WHERE i.tenant_id = v_tenant AND i.rol_id = p_id) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'acceso: el rol esta en uso';
  END IF;
  DELETE FROM public.rol x WHERE x.tenant_id = v_tenant AND x.id = p_id;
  PERFORM public.auditoria_registrar(v_tenant, 'rol.eliminado', NULL, 'rol', p_id,
    jsonb_build_object('antes', jsonb_build_object('nombre', r.nombre, 'alcance', r.alcance, 'permisos', to_jsonb(v_antes)),
                       'despues', NULL));
END
$$;--> statement-breakpoint

-- U6/U8, solo lectura: miembros activos del rol, clientes que quedarían sin responsable (si pierde `sire.clasificar`) y miembros activos
-- sin TOTP que pasarían a exigirlo (si gana su primer permiso sensible de U2 de 029).
CREATE OR REPLACE FUNCTION acceso.rol_impacto(p_id uuid, p_alcance text, p_permisos text[])
  RETURNS TABLE (miembros integer, clientes_sin_responsable integer, miembros_sin_totp_exigidos integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  v_usuario uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  v_sensibles constant text[] := ARRAY['usuarios.gestionar', 'roles.gestionar', 'plan.gestionar', 'credenciales.editar'];
  v_despues text[] := coalesce(p_permisos, '{}'::text[]);
  v_antes text[];
  v_miembros integer := 0;
  v_clientes integer := 0;
  v_totp integer := 0;
BEGIN
  PERFORM 1 FROM acceso.actor_gestor(v_tenant, v_usuario);
  IF NOT EXISTS (SELECT 1 FROM public.rol x WHERE x.tenant_id = v_tenant AND x.id = p_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'acceso: rol inexistente';
  END IF;
  SELECT coalesce(array_agg(p.permiso), '{}'::text[]) INTO v_antes
    FROM public.rol_permiso p WHERE p.tenant_id = v_tenant AND p.rol_id = p_id;
  SELECT count(*)::integer INTO v_miembros FROM public.membresia m
   WHERE m.tenant_id = v_tenant AND m.rol_id = p_id AND m.desactivada_en IS NULL;
  IF 'sire.clasificar' = ANY (v_antes) AND NOT ('sire.clasificar' = ANY (v_despues)) THEN
    SELECT count(DISTINCT s.cliente_id)::integer INTO v_clientes
      FROM public.asignacion s
      JOIN public.membresia m ON m.tenant_id = s.tenant_id AND m.usuario_id = s.usuario_id
     WHERE s.tenant_id = v_tenant AND s.tipo = 'responsable' AND m.rol_id = p_id;
  END IF;
  IF NOT (v_antes && v_sensibles) AND (v_despues && v_sensibles) THEN
    SELECT count(*)::integer INTO v_totp FROM public.membresia m
     WHERE m.tenant_id = v_tenant AND m.rol_id = p_id AND m.desactivada_en IS NULL AND NOT auth.totp_activo(m.usuario_id);
  END IF;
  RETURN QUERY SELECT v_miembros, v_clientes, v_totp;
END
$$;--> statement-breakpoint

-- D2/U2/U4: ¿puede el actor de contexto (app.user_id, activo en app.tenant_id) asignar este rol propio (alta o cambio de membresía,
-- invitación)? Exige `usuarios.gestionar` y que contenga los permisos y el alcance del rol. Bloquea la fila del rol FOR SHARE (D4: después
-- de la membresía que la sentencia ya bloqueó), así una edición concurrente se ve entera o no se ve. Un rol inexistente o de otro estudio
-- da true: no se decide aquí, la FK compuesta responde 23503. Solo responde sí o no (el disparador da el error).
CREATE OR REPLACE FUNCTION acceso.rol_asignable(p_tenant uuid, p_rol_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  v_usuario uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  v_alcance text;
  v_permisos text[];
  v_actor_permisos text[];
  v_actor_alcance text;
BEGIN
  IF v_tenant IS NULL OR v_usuario IS NULL OR p_tenant IS DISTINCT FROM v_tenant THEN
    RETURN false;
  END IF;
  SELECT x.alcance INTO v_alcance FROM public.rol x WHERE x.tenant_id = v_tenant AND x.id = p_rol_id FOR SHARE;
  IF NOT FOUND THEN
    RETURN true;
  END IF;
  SELECT coalesce(array_agg(p.permiso), '{}'::text[]) INTO v_permisos
    FROM public.rol_permiso p WHERE p.tenant_id = v_tenant AND p.rol_id = p_rol_id;
  SELECT e.permisos, e.alcance INTO v_actor_permisos, v_actor_alcance FROM acceso.permisos_membresia(v_tenant, v_usuario) e;
  RETURN FOUND AND 'usuarios.gestionar' = ANY (v_actor_permisos)
         AND acceso.contiene(v_actor_permisos, v_actor_alcance, v_permisos, v_alcance);
END
$$;--> statement-breakpoint

ALTER FUNCTION acceso.permisos_asignables() OWNER TO contapp_migrator;--> statement-breakpoint
ALTER FUNCTION acceso.permisos_sistema(text) OWNER TO contapp_migrator;--> statement-breakpoint
ALTER FUNCTION acceso.combinacion_valida(text[]) OWNER TO contapp_migrator;--> statement-breakpoint
ALTER FUNCTION acceso.contiene(text[], text, text[], text) OWNER TO contapp_migrator;--> statement-breakpoint
ALTER FUNCTION acceso.permisos_membresia(uuid, uuid) OWNER TO contapp_migrator;--> statement-breakpoint
ALTER FUNCTION acceso.actor_gestor(uuid, uuid) OWNER TO contapp_migrator;--> statement-breakpoint
ALTER FUNCTION acceso.rol_guardar(uuid, text, text, text[]) OWNER TO contapp_migrator;--> statement-breakpoint
ALTER FUNCTION acceso.rol_eliminar(uuid) OWNER TO contapp_migrator;--> statement-breakpoint
ALTER FUNCTION acceso.rol_impacto(uuid, text, text[]) OWNER TO contapp_migrator;--> statement-breakpoint
ALTER FUNCTION acceso.rol_asignable(uuid, uuid) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION acceso.permisos_asignables(), acceso.permisos_sistema(text), acceso.combinacion_valida(text[]),
  acceso.contiene(text[], text, text[], text), acceso.permisos_membresia(uuid, uuid), acceso.actor_gestor(uuid, uuid),
  acceso.rol_guardar(uuid, text, text, text[]), acceso.rol_eliminar(uuid), acceso.rol_impacto(uuid, text, text[]),
  acceso.rol_asignable(uuid, uuid)
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
-- El backend: las tres de gestión y la del disparador (corre con sus permisos). contapp_auth: el resolvedor (invitación y TOTP).
GRANT EXECUTE ON FUNCTION acceso.rol_guardar(uuid, text, text, text[]), acceso.rol_eliminar(uuid), acceso.rol_impacto(uuid, text, text[]),
  acceso.rol_asignable(uuid, uuid) TO contapp_backend;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION acceso.permisos_membresia(uuid, uuid) TO contapp_auth;--> statement-breakpoint

-- ===================================================================================================
-- Disparador de asignación de un rol propio en membresia e invitacion (D2). SECURITY INVOKER (como membresia_ultimo_dueno de 0012): debe
-- ver quién escribe. La escritura directa de la app (contapp_backend; worker y platform no tienen EXECUTE sobre acceso.rol_asignable y
-- fallan con 42501) pasa por la regla; las funciones definer de contapp_auth (aceptar una invitación ya validada) y de contapp_migrator, y
-- el superusuario (operación y siembra), no. Solo mira la asignación: cambios que no tocan rol_id no la disparan.
-- ===================================================================================================
CREATE OR REPLACE FUNCTION public.rol_propio_asignar() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.rol_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.rol_id IS NOT DISTINCT FROM OLD.rol_id AND NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id THEN
    RETURN NEW;
  END IF;
  IF current_user IN ('contapp_auth', 'contapp_migrator')
     OR coalesce((SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false) THEN
    RETURN NEW;
  END IF;
  IF acceso.rol_asignable(NEW.tenant_id, NEW.rol_id) THEN
    RETURN NEW;
  END IF;
  -- Rechazado. Si además deja al estudio sin Dueño activo, P0001 (lo que daría membresia_ultimo_dueno, U7/CA-8): en una degradación
  -- cruzada el actor puede haber dejado de ser Dueño justo antes; esta lectura es posterior a la del actor. (IF anidado: OLD.rol y
  -- OLD.desactivada_en solo existen en membresia.)
  IF TG_TABLE_NAME = 'membresia' AND TG_OP = 'UPDATE' THEN
    IF OLD.rol = 'dueno' AND OLD.desactivada_en IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.membresia m
                        WHERE m.tenant_id = OLD.tenant_id AND m.rol = 'dueno' AND m.desactivada_en IS NULL
                          AND m.usuario_id <> OLD.usuario_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'el estudio debe conservar al menos un Dueño activo';
    END IF;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'acceso: sin permiso para asignar el rol';
END
$$;--> statement-breakpoint
ALTER FUNCTION public.rol_propio_asignar() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.rol_propio_asignar()
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
DROP TRIGGER IF EXISTS membresia_rol_propio ON public.membresia;--> statement-breakpoint
CREATE TRIGGER membresia_rol_propio BEFORE INSERT OR UPDATE ON public.membresia
  FOR EACH ROW EXECUTE FUNCTION public.rol_propio_asignar();--> statement-breakpoint
DROP TRIGGER IF EXISTS invitacion_rol_propio ON public.invitacion;--> statement-breakpoint
CREATE TRIGGER invitacion_rol_propio BEFORE INSERT OR UPDATE ON public.invitacion
  FOR EACH ROW EXECUTE FUNCTION public.rol_propio_asignar();--> statement-breakpoint

-- ===================================================================================================
-- auth: TOTP activo (solo el booleano) para rol_impacto; dueño contapp_auth, EXECUTE solo para contapp_migrator (dueño de acceso.*).
-- ===================================================================================================
CREATE OR REPLACE FUNCTION auth.totp_activo(p_usuario_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM auth.totp t WHERE t.usuario_id = p_usuario_id AND t.activo_cifrado IS NOT NULL)
$$;--> statement-breakpoint
ALTER FUNCTION auth.totp_activo(uuid) OWNER TO contapp_auth;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth.totp_activo(uuid)
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth.totp_activo(uuid) TO contapp_migrator;--> statement-breakpoint

-- ===================================================================================================
-- Nuevas versiones de las funciones de auth que deciden por el rol de la membresía (D3): usan acceso.permisos_membresia.
-- ===================================================================================================
-- La de 0015 con el invitador por permisos efectivos: activo y con `usuarios.gestionar` (un rol propio también), y solo un Dueño invita a
-- Dueño. Para los roles de sistema es la misma regla (Dueño, o Administrador salvo a Dueño).
CREATE OR REPLACE FUNCTION auth.invitacion_vigente(p_token_hash bytea)
  RETURNS TABLE (tenant_id uuid, estudio_nombre text, correo text, rol text, cuenta_existe boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT i.tenant_id, t.nombre, i.correo, i.rol,
         EXISTS (SELECT 1 FROM public.usuario u WHERE u.email = i.correo)
    FROM public.invitacion i
    JOIN public.tenant t ON t.id = i.tenant_id
   WHERE i.token_hash = p_token_hash AND i.aceptada_en IS NULL AND i.revocada_en IS NULL
     AND i.vence_en > now()
     AND EXISTS (SELECT 1 FROM acceso.permisos_membresia(i.tenant_id, i.invitado_por) g
                  WHERE g.rol_sistema = 'dueno' OR ('usuarios.gestionar' = ANY (g.permisos) AND i.rol <> 'dueno'));
$$;--> statement-breakpoint

-- La de 0016 más: el advisory `acceso.roles:<estudio>` antes de bloquear la invitación (D4: serializa con editar o eliminar su rol),
-- el invitador por permisos efectivos (como invitacion_vigente) y la copia de rol_id a la membresía.
CREATE OR REPLACE FUNCTION auth.invitacion_aceptar_nueva(p_token_hash bytea, p_nombre text, p_hash text)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  i public.invitacion%ROWTYPE;
  v_tenant uuid;
  v_usuario uuid;
BEGIN
  IF p_nombre IS NULL OR btrim(p_nombre) = '' OR char_length(p_nombre) > 200
     OR p_nombre ~ E'[\\u0001-\\u001f\\u007f-\\u009f\\u00ad\\u0600-\\u0605\\u061c\\u06dd\\u070f\\u0890-\\u0891\\u08e2\\u180e\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u206f\\ufeff\\ufff9-\\ufffb\\U000110bd\\U000110cd\\U00013430-\\U0001343f\\U0001bca0-\\U0001bca3\\U0001d173-\\U0001d17a\\U000e0001\\U000e0020-\\U000e007f]'
     OR NOT (p_nombre COLLATE pg_catalog."und-x-icu" ~ '[[:alnum:]]') THEN
    RETURN 'invalida';
  END IF;
  SELECT x.tenant_id INTO v_tenant FROM public.invitacion x
   WHERE x.token_hash = p_token_hash AND x.aceptada_en IS NULL AND x.revocada_en IS NULL AND x.vence_en > now();
  IF NOT FOUND THEN
    RETURN 'invalida';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('acceso.roles:' || v_tenant::text, 0));
  SELECT * INTO i FROM public.invitacion x
   WHERE x.token_hash = p_token_hash AND x.aceptada_en IS NULL AND x.revocada_en IS NULL
     AND x.vence_en > now()
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'invalida';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM acceso.permisos_membresia(i.tenant_id, i.invitado_por) g
                  WHERE g.rol_sistema = 'dueno' OR ('usuarios.gestionar' = ANY (g.permisos) AND i.rol <> 'dueno')) THEN
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
  INSERT INTO public.membresia (tenant_id, usuario_id, rol, rol_id) VALUES (i.tenant_id, v_usuario, i.rol, i.rol_id);
  UPDATE public.invitacion x SET aceptada_en = now(), aceptada_por = v_usuario WHERE x.id = i.id;
  RETURN 'aceptada';
END
$$;--> statement-breakpoint

-- La de 0015 con los mismos cambios que aceptar_nueva (advisory de D4, invitador por permisos efectivos y rol_id).
CREATE OR REPLACE FUNCTION auth.invitacion_aceptar_existente(p_token_hash bytea, p_token_hash_sesion bytea)
  RETURNS TABLE (tenant_id uuid, estudio_nombre text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  i public.invitacion%ROWTYPE;
  v_tenant uuid;
  v_usuario uuid;
  v_correo text;
  v_nombre text;
BEGIN
  SELECT x.usuario_id INTO v_usuario FROM auth.sesion x
   WHERE x.token_hash = p_token_hash_sesion AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours';
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT u.email INTO v_correo FROM public.usuario u WHERE u.id = v_usuario;
  SELECT x.tenant_id INTO v_tenant FROM public.invitacion x
   WHERE x.token_hash = p_token_hash AND x.aceptada_en IS NULL AND x.revocada_en IS NULL AND x.vence_en > now();
  IF NOT FOUND THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('acceso.roles:' || v_tenant::text, 0));
  SELECT * INTO i FROM public.invitacion x
   WHERE x.token_hash = p_token_hash AND x.aceptada_en IS NULL AND x.revocada_en IS NULL
     AND x.vence_en > now()
   FOR UPDATE;
  IF NOT FOUND OR v_correo IS NULL OR i.correo <> v_correo THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM acceso.permisos_membresia(i.tenant_id, i.invitado_por) g
                  WHERE g.rol_sistema = 'dueno' OR ('usuarios.gestionar' = ANY (g.permisos) AND i.rol <> 'dueno')) THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.membresia m WHERE m.tenant_id = i.tenant_id AND m.usuario_id = v_usuario) THEN
    RETURN;
  END IF;
  INSERT INTO public.membresia (tenant_id, usuario_id, rol, rol_id) VALUES (i.tenant_id, v_usuario, i.rol, i.rol_id);
  UPDATE public.invitacion x SET aceptada_en = now(), aceptada_por = v_usuario WHERE x.id = i.id;
  SELECT t.nombre INTO v_nombre FROM public.tenant t WHERE t.id = i.tenant_id;
  RETURN QUERY SELECT i.tenant_id, v_nombre;
END
$$;--> statement-breakpoint

-- La de 0081 con la regla de factorExigido (U1–U2 de 029, CA-7 de 030) sobre los permisos efectivos de cada membresía activa: Dueño o
-- Administrador de sistema, o un rol propio con algún permiso sensible. Super-admin igual que antes.
CREATE OR REPLACE FUNCTION auth.totp_desactivar(p_token_hash bytea, p_paso bigint)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  s auth.sesion%ROWTYPE;
  t auth.totp%ROWTYPE;
  v_usuario uuid;
BEGIN
  SELECT x.usuario_id INTO v_usuario FROM auth.sesion x
   WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours'
     AND x.factor = 'verificado';
  IF NOT FOUND THEN
    RETURN 'invalido';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('auth.totp:' || v_usuario::text, 0));
  SELECT * INTO s FROM auth.sesion x
   WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours'
     AND x.factor = 'verificado'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'invalido';
  END IF;
  SELECT * INTO t FROM auth.totp y WHERE y.usuario_id = s.usuario_id AND y.activo_cifrado IS NOT NULL FOR UPDATE;
  IF NOT FOUND OR p_paso IS NULL OR t.ultimo_paso >= p_paso THEN
    RETURN 'invalido';
  END IF;
  -- Exigido: super-admin, o una membresía activa con rol de sistema Dueño o Administrador, o con un rol propio con un permiso sensible.
  IF EXISTS (SELECT 1 FROM public.admin_plataforma a WHERE a.usuario_id = s.usuario_id)
     OR EXISTS (SELECT 1 FROM public.membresia m
                 CROSS JOIN LATERAL acceso.permisos_membresia(m.tenant_id, m.usuario_id) e
                 WHERE m.usuario_id = s.usuario_id AND m.desactivada_en IS NULL
                   AND (e.rol_sistema IN ('dueno', 'admin')
                        OR (e.rol_sistema IS NULL
                            AND e.permisos && ARRAY['usuarios.gestionar', 'roles.gestionar', 'plan.gestionar', 'credenciales.editar']::text[]))) THEN
    RETURN 'exigido';
  END IF;
  DELETE FROM auth.totp_recuperacion r WHERE r.usuario_id = s.usuario_id;
  DELETE FROM auth.totp y WHERE y.usuario_id = s.usuario_id;
  INSERT INTO auth.cuenta_evento (usuario_id, tipo) VALUES (s.usuario_id, 'totp_desactivado');
  UPDATE auth.sesion x SET revocada_en = now(), motivo = 'totp'
   WHERE x.usuario_id = s.usuario_id AND x.revocada_en IS NULL AND x.id <> s.id;
  UPDATE auth.sesion x SET factor = 'sin_factor' WHERE x.id = s.id;
  RETURN 'desactivado';
END
$$;--> statement-breakpoint

-- Aceptar una invitación a un rol propio copia rol_id (0013 concedió a contapp_auth solo tenant_id, usuario_id y rol).
GRANT INSERT (rol_id) ON public.membresia TO contapp_auth;--> statement-breakpoint

-- Dueño contapp_auth; EXECUTE solo para contapp_backend (como en 0015, 0016 y 0081).
ALTER FUNCTION auth.invitacion_vigente(bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.invitacion_aceptar_nueva(bytea, text, text) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.invitacion_aceptar_existente(bytea, bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.totp_desactivar(bytea, bigint) OWNER TO contapp_auth;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth.invitacion_vigente(bytea), auth.invitacion_aceptar_nueva(bytea, text, text),
  auth.invitacion_aceptar_existente(bytea, bytea), auth.totp_desactivar(bytea, bigint)
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_enumerador, contapp_registrador, contapp_migrator;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth.invitacion_vigente(bytea), auth.invitacion_aceptar_nueva(bytea, text, text),
  auth.invitacion_aceptar_existente(bytea, bytea), auth.totp_desactivar(bytea, bigint) TO contapp_backend;
