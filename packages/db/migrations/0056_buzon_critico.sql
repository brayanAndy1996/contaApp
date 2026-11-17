-- 0056_buzon_critico (spec 023, D-9, P-5, P-8; CA-6, CA-13). Aviso del mensaje crítico y auditoría del buzón. Sin tablas: todo es
-- repetible (CREATE OR REPLACE, DROP ... IF EXISTS, GRANT/REVOKE). No edita 0043: los destinatarios se copian en una función nueva.
--   interno.destinatarios_cliente(estudio, cliente)  responsable activo del cliente; si no hay, Dueños y Administradores activos
--     (la regla del aviso de credencial inválida de 0043). Dueño contapp_migrator (sin BYPASSRLS): lee con app.tenant_id fijado al
--     estudio y lo devuelve a su valor. Sin EXECUTE para la app.
--   buzon_mensaje_aviso_obligatorio (BEFORE INSERT, para todos los roles): un crítico con avisado = false se rechaza (42501) si la
--     fecha es de los últimos 30 días o el cliente ya está sincronizado (sincronizado_en). La BD exige lo que decide el dominio.
--   buzon_mensaje_aviso (AFTER INSERT WHEN avisado): notificación `buzon_critico` {categoria, mensajeId} a cada destinatario en la
--     misma transacción, clave 'buzon_critico:' || id (interno.notificar deduplica). Solo en el INSERT: repetir con ON CONFLICT DO
--     NOTHING o reclasificar no avisa. El trabajo del contexto cuenta solo con el rol del worker y si es del estudio (como 0043).
--   buzon.contenido_obtenido (AFTER UPDATE OF contenido_ruta, NULL -> valor): actor trabajo (auditoria_registrar), datos {mensajeId,
--     marcoLeido, adjuntos, omitidos}; los adjuntos se cuentan al momento del UPDATE (el worker los inserta antes).
--   buzon_auditar(accion, cliente, mensaje, adjunto)  solo el backend (actor usuario): buzon.captura_solicitada (entidad cliente,
--     {}), buzon.apertura_solicitada y buzon.contenido_visto (buzon_mensaje, {mensajeId}), buzon.adjunto_descargado (buzon_adjunto,
--     {mensajeId, adjuntoId}). Valida la pertenencia al cliente y al estudio (23503); otra acción o parámetros incoherentes 22023;
--     sin estudio o sin usuario 42501. Los datos solo llevan ids, booleanos y conteos (nunca asunto, nombre, ruta ni RUC).
-- Todas SECURITY DEFINER de contapp_migrator con search_path fijo y sin EXECUTE para PUBLIC.

-- ---- Destinatarios (copia de la regla de 0043) ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION interno.destinatarios_cliente(p_tenant uuid, p_cliente uuid) RETURNS uuid[]
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_previo text := current_setting('app.tenant_id', true);
  v_usuarios uuid[];
BEGIN
  IF p_tenant IS NULL OR p_cliente IS NULL THEN
    RETURN '{}'::uuid[];
  END IF;
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  SELECT array_agg(a.usuario_id ORDER BY a.usuario_id) INTO v_usuarios
    FROM public.asignacion a
    JOIN public.membresia m ON m.tenant_id = a.tenant_id AND m.usuario_id = a.usuario_id AND m.desactivada_en IS NULL
   WHERE a.tenant_id = p_tenant AND a.cliente_id = p_cliente AND a.tipo = 'responsable';
  IF v_usuarios IS NULL THEN
    SELECT array_agg(m.usuario_id ORDER BY m.usuario_id) INTO v_usuarios FROM public.membresia m
     WHERE m.tenant_id = p_tenant AND m.desactivada_en IS NULL AND m.rol IN ('dueno', 'admin');
  END IF;
  PERFORM set_config('app.tenant_id', coalesce(v_previo, ''), true);
  RETURN coalesce(v_usuarios, '{}'::uuid[]);
END
$$;--> statement-breakpoint
ALTER FUNCTION interno.destinatarios_cliente(uuid, uuid) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION interno.destinatarios_cliente(uuid, uuid)
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint

-- ---- La BD exige el aviso de un crítico reciente o de un cliente ya sincronizado -----------------------------------------
CREATE OR REPLACE FUNCTION public.buzon_mensaje_aviso_obligatorio() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_previo text;
  v_sincronizado boolean;
BEGIN
  IF NEW.critico IS NOT TRUE OR NEW.avisado IS NOT FALSE THEN
    RETURN NEW;
  END IF;
  IF NEW.fecha > clock_timestamp() - interval '30 days' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'buzon_mensaje: un critico reciente debe avisarse';
  END IF;
  v_previo := current_setting('app.tenant_id', true);
  PERFORM set_config('app.tenant_id', NEW.tenant_id::text, true);
  SELECT e.sincronizado_en IS NOT NULL INTO v_sincronizado
    FROM public.buzon_estado_cliente e
   WHERE e.tenant_id = NEW.tenant_id AND e.cliente_id = NEW.cliente_id;
  PERFORM set_config('app.tenant_id', coalesce(v_previo, ''), true);
  IF v_sincronizado THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'buzon_mensaje: un critico de un cliente sincronizado debe avisarse';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.buzon_mensaje_aviso_obligatorio() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.buzon_mensaje_aviso_obligatorio()
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
DROP TRIGGER IF EXISTS buzon_mensaje_aviso_obligatorio ON public.buzon_mensaje;--> statement-breakpoint
CREATE TRIGGER buzon_mensaje_aviso_obligatorio BEFORE INSERT ON public.buzon_mensaje
  FOR EACH ROW EXECUTE FUNCTION public.buzon_mensaje_aviso_obligatorio();--> statement-breakpoint

-- ---- Aviso en la misma transacción del INSERT ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.buzon_mensaje_aviso() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_previo text := current_setting('app.tenant_id', true);
  v_usuarios uuid[];
  v_trabajo_ctx text;
  v_trabajo uuid;
BEGIN
  v_usuarios := interno.destinatarios_cliente(NEW.tenant_id, NEW.cliente_id);
  IF current_setting('role', true) = 'contapp_worker' THEN
    v_trabajo_ctx := nullif(current_setting('app.trabajo_id', true), '');
    IF v_trabajo_ctx ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      PERFORM set_config('app.tenant_id', NEW.tenant_id::text, true);
      SELECT j.id INTO v_trabajo FROM public.job_registro j WHERE j.id = v_trabajo_ctx::uuid AND j.tenant_id = NEW.tenant_id;
      PERFORM set_config('app.tenant_id', coalesce(v_previo, ''), true);
    END IF;
  END IF;
  PERFORM interno.notificar(NEW.tenant_id, v_usuarios, 'buzon_critico', NEW.cliente_id, v_trabajo,
    jsonb_build_object('categoria', NEW.categoria, 'mensajeId', NEW.id),
    'buzon_critico:' || NEW.id::text);
  RETURN NULL;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.buzon_mensaje_aviso() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.buzon_mensaje_aviso()
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
DROP TRIGGER IF EXISTS buzon_mensaje_aviso ON public.buzon_mensaje;--> statement-breakpoint
CREATE TRIGGER buzon_mensaje_aviso AFTER INSERT ON public.buzon_mensaje
  FOR EACH ROW WHEN (NEW.avisado) EXECUTE FUNCTION public.buzon_mensaje_aviso();--> statement-breakpoint

-- ---- buzon.contenido_obtenido (actor trabajo) ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auditoria_capturar_buzon_contenido() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_previo text := current_setting('app.tenant_id', true);
  v_guardados integer;
  v_omitidos integer;
BEGIN
  PERFORM set_config('app.tenant_id', NEW.tenant_id::text, true);
  SELECT count(*) FILTER (WHERE a.omitido IS NULL), count(*) FILTER (WHERE a.omitido IS NOT NULL)
    INTO v_guardados, v_omitidos
    FROM public.buzon_adjunto a
   WHERE a.tenant_id = NEW.tenant_id AND a.cliente_id = NEW.cliente_id AND a.mensaje_id = NEW.id;
  PERFORM set_config('app.tenant_id', coalesce(v_previo, ''), true);
  PERFORM public.auditoria_registrar(NEW.tenant_id, 'buzon.contenido_obtenido', NEW.cliente_id, 'buzon_mensaje', NEW.id,
    jsonb_build_object('mensajeId', NEW.id, 'marcoLeido', (NOT OLD.leido_sunat AND NEW.leido_sunat),
                       'adjuntos', v_guardados, 'omitidos', v_omitidos));
  RETURN NULL;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.auditoria_capturar_buzon_contenido() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.auditoria_capturar_buzon_contenido()
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
DROP TRIGGER IF EXISTS auditoria_buzon_contenido ON public.buzon_mensaje;--> statement-breakpoint
CREATE TRIGGER auditoria_buzon_contenido AFTER UPDATE OF contenido_ruta ON public.buzon_mensaje
  FOR EACH ROW WHEN (OLD.contenido_ruta IS NULL AND NEW.contenido_ruta IS NOT NULL)
  EXECUTE FUNCTION public.auditoria_capturar_buzon_contenido();--> statement-breakpoint

-- ---- Auditoría de las acciones del backend (actor usuario) ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.buzon_auditar(p_accion text, p_cliente uuid, p_mensaje uuid, p_adjunto uuid) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  v_entidad text;
  v_entidad_id uuid;
  v_datos jsonb;
BEGIN
  IF v_tenant IS NULL OR nullif(current_setting('app.user_id', true), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'buzon_auditar: sesion sin estudio o sin usuario';
  END IF;
  IF p_accion IS NULL OR p_cliente IS NULL
     OR p_accion NOT IN ('buzon.captura_solicitada', 'buzon.apertura_solicitada', 'buzon.contenido_visto',
                         'buzon.adjunto_descargado')
     OR (p_accion = 'buzon.captura_solicitada' AND (p_mensaje IS NOT NULL OR p_adjunto IS NOT NULL))
     OR (p_accion IN ('buzon.apertura_solicitada', 'buzon.contenido_visto') AND (p_mensaje IS NULL OR p_adjunto IS NOT NULL))
     OR (p_accion = 'buzon.adjunto_descargado' AND (p_mensaje IS NULL OR p_adjunto IS NULL)) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'buzon_auditar: parametro invalido';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cliente c WHERE c.tenant_id = v_tenant AND c.id = p_cliente) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'buzon_auditar: cliente desconocido';
  END IF;
  IF p_mensaje IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.buzon_mensaje m WHERE m.tenant_id = v_tenant AND m.cliente_id = p_cliente AND m.id = p_mensaje
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'buzon_auditar: mensaje desconocido';
  END IF;
  IF p_adjunto IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.buzon_adjunto a
     WHERE a.tenant_id = v_tenant AND a.cliente_id = p_cliente AND a.mensaje_id = p_mensaje AND a.id = p_adjunto
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'buzon_auditar: adjunto desconocido';
  END IF;
  IF p_accion = 'buzon.captura_solicitada' THEN
    v_entidad := 'cliente';
    v_entidad_id := p_cliente;
    v_datos := '{}'::jsonb;
  ELSIF p_accion = 'buzon.adjunto_descargado' THEN
    v_entidad := 'buzon_adjunto';
    v_entidad_id := p_adjunto;
    v_datos := jsonb_build_object('mensajeId', p_mensaje, 'adjuntoId', p_adjunto);
  ELSE
    v_entidad := 'buzon_mensaje';
    v_entidad_id := p_mensaje;
    v_datos := jsonb_build_object('mensajeId', p_mensaje);
  END IF;
  PERFORM public.auditoria_registrar(v_tenant, p_accion, p_cliente, v_entidad, v_entidad_id, v_datos);
END
$$;--> statement-breakpoint
ALTER FUNCTION public.buzon_auditar(text, uuid, uuid, uuid) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.buzon_auditar(text, uuid, uuid, uuid)
  FROM PUBLIC, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.buzon_auditar(text, uuid, uuid, uuid) TO contapp_backend;
