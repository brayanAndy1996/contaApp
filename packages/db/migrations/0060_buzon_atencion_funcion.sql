-- 0060_buzon_atencion_funcion (spec 024, D-5 a D-8, D-14, U-1, U-3; CA-4, CA-5, CA-7, CA-10). Función acotada de la atención: el
-- ÚNICO camino que cambia el estado de atención de un mensaje y escribe su historial y su auditoría, en la misma transacción.
-- Repetible (CREATE OR REPLACE; ALTER/REVOKE/GRANT idempotentes). SECURITY DEFINER de contapp_migrator (no superusuario ni
-- BYPASSRLS: la RLS de cada tabla sigue aplicando con el app.tenant_id de la sesión), search_path fijo, nombres calificados,
-- SQLSTATE y mensajes fijos (nunca el comentario, ids ni asuntos). EXECUTE solo contapp_backend.
--   public.buzon_atencion_aplicar(p_cliente, p_mensajes, p_accion, p_comentario)
--     42501  sin app.tenant_id, sin app.user_id o sin membresía activa en el estudio.
--     22023  acción distinta de marcar | deshacer; arreglo nulo, vacío, de más de 100, con nulos o repetidos; comentario no nulo
--            que tras recortar espacios queda vacío, pasa de 500 o trae controles (salvo \n) o marcas bidi; deshacer en lote (U-3).
--     P0002  algún id no existe en el estudio (RLS: otro estudio = inexistente) o, con p_cliente, es de otro cliente.
--     55000  algún cliente de los mensajes está archivado (U-1).
--     22004  marcar con algún crítico y sin comentario (todo el lote).
--   Orden de bloqueo (plan, CA-7): cliente FOR SHARE en orden de id (serializa con archivar/reactivar) -> buzon_mensaje FOR NO KEY
--   UPDATE en orden de id (el mismo modo que toma el UPDATE; la captura bloquea igual, escritura.ts) -> evento -> auditoría. Tras
--   los bloqueos cada sentencia lee lo ya confirmado (READ COMMITTED): la segunda de dos marcas simultáneas ve la primera y sale
--   aplicado = false sin evento. Por mensaje, en orden de id: si el estado lo permite, cambia atendido_en/atendido_por (el mismo
--   instante del evento), inserta el evento y la auditoría (buzon.atendido | buzon.atencion_deshecha, entidad buzon_mensaje,
--   datos {mensajeId, clienteId, conComentario, lote}: nunca el texto) y devuelve aplicado = true; si no, aplicado = false con el
--   estado vigente. historico no cambia (U-2: deshacer un histórico lo deja histórico). Nunca toca notificacion,
--   buzon_estado_cliente, job_registro ni leido_sunat (D-14).
CREATE OR REPLACE FUNCTION public.buzon_atencion_aplicar(p_cliente uuid, p_mensajes uuid[], p_accion text, p_comentario text)
  RETURNS TABLE (mensaje_id uuid, aplicado boolean, atendido_por uuid, atendido_en timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid;
  v_usuario uuid;
  v_lote boolean := p_cliente IS NULL;
  v_comentario text;
  v_encontrados integer;
  v_clientes uuid[];
  v_ts timestamptz;
  c record;
  r record;
BEGIN
  -- ---- Quién llama ----
  BEGIN
    v_tenant := nullif(current_setting('app.tenant_id', true), '')::uuid;
    v_usuario := nullif(current_setting('app.user_id', true), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'buzon_atencion_aplicar: sesion invalida';
  END;
  IF v_tenant IS NULL OR v_usuario IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'buzon_atencion_aplicar: sesion sin estudio o sin usuario';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.membresia mb
     WHERE mb.tenant_id = v_tenant AND mb.usuario_id = v_usuario AND mb.desactivada_en IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'buzon_atencion_aplicar: sin membresia activa';
  END IF;

  -- ---- Entrada ----
  IF p_accion IS NULL OR p_accion NOT IN ('marcar', 'deshacer') OR (v_lote AND p_accion <> 'marcar') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'buzon_atencion_aplicar: accion invalida';
  END IF;
  IF p_mensajes IS NULL OR array_ndims(p_mensajes) <> 1 OR cardinality(p_mensajes) NOT BETWEEN 1 AND 100
     OR array_position(p_mensajes, NULL) IS NOT NULL
     OR (SELECT count(DISTINCT u.x) FROM unnest(p_mensajes) AS u(x)) <> cardinality(p_mensajes) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'buzon_atencion_aplicar: mensajes invalidos';
  END IF;
  IF p_comentario IS NOT NULL THEN
    v_comentario := regexp_replace(p_comentario, '^[[:space:]]+|[[:space:]]+$', '', 'g');
    IF char_length(v_comentario) NOT BETWEEN 1 AND 500
       OR v_comentario ~ '[\u0001-\u0009\u000B-\u001F\u007F-\u009F‎‏؜‪-‮⁦-⁩]' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'buzon_atencion_aplicar: comentario invalido';
    END IF;
  END IF;

  -- ---- Pertenencia (sin bloquear: la identidad y el cliente de un mensaje no cambian) ----
  SELECT count(*)::integer, array_agg(DISTINCT m.cliente_id ORDER BY m.cliente_id)
    INTO v_encontrados, v_clientes
    FROM public.buzon_mensaje m
   WHERE m.tenant_id = v_tenant AND m.id = ANY (p_mensajes);
  IF v_encontrados <> cardinality(p_mensajes)
     OR (p_cliente IS NOT NULL AND (cardinality(v_clientes) <> 1 OR v_clientes[1] <> p_cliente)) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'buzon_atencion_aplicar: mensaje no encontrado';
  END IF;

  -- ---- 1. Clientes FOR SHARE en orden de id; archivado -> 55000 (se lee la versión bloqueada, ya confirmada) ----
  FOR c IN
    SELECT k.id, k.archivado_at FROM public.cliente k
     WHERE k.tenant_id = v_tenant AND k.id = ANY (v_clientes)
     ORDER BY k.id
       FOR SHARE
  LOOP
    IF c.archivado_at IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'buzon_atencion_aplicar: cliente archivado';
    END IF;
  END LOOP;

  -- ---- Crítico sin comentario (critico no cambia tras insertar: no necesita bloqueo) ----
  IF p_accion = 'marcar' AND v_comentario IS NULL AND EXISTS (
    SELECT 1 FROM public.buzon_mensaje m WHERE m.tenant_id = v_tenant AND m.id = ANY (p_mensajes) AND m.critico
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22004', MESSAGE = 'buzon_atencion_aplicar: un critico exige comentario';
  END IF;

  -- ---- 2. Mensajes en orden de id ----
  PERFORM 1 FROM (
    SELECT m.id FROM public.buzon_mensaje m
     WHERE m.tenant_id = v_tenant AND m.id = ANY (p_mensajes)
     ORDER BY m.id
       FOR NO KEY UPDATE
  ) AS bloqueados;

  -- ---- 3 y 4. Estado vigente (relectura tras los bloqueos), evento y auditoría por mensaje ----
  FOR r IN
    SELECT m.id, m.cliente_id, m.atendido_en, m.atendido_por FROM public.buzon_mensaje m
     WHERE m.tenant_id = v_tenant AND m.id = ANY (p_mensajes)
     ORDER BY m.id
  LOOP
    mensaje_id := r.id;
    IF (p_accion = 'marcar' AND r.atendido_en IS NULL) OR (p_accion = 'deshacer' AND r.atendido_en IS NOT NULL) THEN
      v_ts := clock_timestamp();
      IF p_accion = 'marcar' THEN
        UPDATE public.buzon_mensaje m SET atendido_en = v_ts, atendido_por = v_usuario
         WHERE m.tenant_id = v_tenant AND m.id = r.id;
        atendido_por := v_usuario;
        atendido_en := v_ts;
      ELSE
        UPDATE public.buzon_mensaje m SET atendido_en = NULL, atendido_por = NULL
         WHERE m.tenant_id = v_tenant AND m.id = r.id;
        atendido_por := NULL;
        atendido_en := NULL;
      END IF;
      INSERT INTO public.buzon_atencion (tenant_id, cliente_id, mensaje_id, accion, comentario, usuario_id, creado_en)
      VALUES (v_tenant, r.cliente_id, r.id, CASE WHEN p_accion = 'marcar' THEN 'atendido' ELSE 'deshecho' END, v_comentario,
              v_usuario, v_ts);
      PERFORM public.auditoria_registrar(
        v_tenant,
        CASE WHEN p_accion = 'marcar' THEN 'buzon.atendido' ELSE 'buzon.atencion_deshecha' END,
        r.cliente_id,
        'buzon_mensaje',
        r.id,
        jsonb_build_object('mensajeId', r.id, 'clienteId', r.cliente_id, 'conComentario', v_comentario IS NOT NULL,
                           'lote', v_lote)
      );
      aplicado := true;
    ELSE
      aplicado := false;
      atendido_por := r.atendido_por;
      atendido_en := r.atendido_en;
    END IF;
    RETURN NEXT;
  END LOOP;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.buzon_atencion_aplicar(uuid, uuid[], text, text) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.buzon_atencion_aplicar(uuid, uuid[], text, text)
  FROM PUBLIC, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.buzon_atencion_aplicar(uuid, uuid[], text, text) TO contapp_backend;
