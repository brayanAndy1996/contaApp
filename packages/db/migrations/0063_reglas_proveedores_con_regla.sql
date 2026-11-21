-- 0063_reglas_proveedores_con_regla (spec 025, T11a; D-8, D-9, CA-9). Los proveedores con regla aprendida activa de un cliente, para
-- R-STD (y R-NEW) en la descarga y en la re-evaluación del worker. El worker no tiene grant sobre regla_aprendida y
-- reglas_historial_vigentes (0048) devuelve vacío con R-HIS apagado: R-STD nunca se sugiere a un proveedor con regla activa, sea cual
-- sea el estado de R-HIS (una regla desactivada o eliminada no cuenta). Repetible (CREATE OR REPLACE; ALTER/REVOKE/GRANT
-- idempotentes). SECURITY DEFINER de contapp_migrator (no superusuario ni BYPASSRLS: la RLS de regla_aprendida sigue aplicando con el
-- app.tenant_id de la sesión), search_path fijo, nombres calificados, SQLSTATE y mensajes fijos. EXECUTE solo contapp_worker.
--
--   reglas_proveedores_con_regla(p_cliente uuid) -> TABLE (doc_tipo text, doc_numero text)                (contapp_worker)
--     42501 sesión sin app.tenant_id (o que no es uuid); 22023 cliente nulo. Solo el documento del proveedor de cada regla viva
--     (eliminada_en IS NULL) y activa del cliente en el estudio de la sesión, sin importar periodo_aprendido ni el interruptor de
--     R-HIS; cliente ajeno o inexistente: vacío. Toma el advisory compartido del estudio (el mismo que reglas_historial_vigentes) y
--     bloquea esas reglas FOR SHARE, en orden de id, hasta el fin de la transacción (CA-9: editar, desactivar o eliminar la regla
--     espera a que termine la descarga). Sin bloques EXCEPTION ni subtransacciones (D-1).

CREATE OR REPLACE FUNCTION public.reglas_proveedores_con_regla(p_cliente uuid)
  RETURNS TABLE (doc_tipo text, doc_numero text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_uuid CONSTANT text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_tenant_txt text := nullif(current_setting('app.tenant_id', true), '');
  v_tenant uuid;
BEGIN
  IF v_tenant_txt IS NULL OR v_tenant_txt !~ v_uuid THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'reglas_proveedores_con_regla: sesion sin estudio';
  END IF;
  v_tenant := v_tenant_txt::uuid;
  IF p_cliente IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'reglas_proveedores_con_regla: parametro invalido';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('reglas_motor:' || v_tenant::text, 0));
  RETURN QUERY
    SELECT r.doc_tipo, r.doc_numero
      FROM public.regla_aprendida r
     WHERE r.tenant_id = v_tenant AND r.cliente_id = p_cliente AND r.eliminada_en IS NULL AND r.activa
     ORDER BY r.id
     FOR SHARE OF r;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.reglas_proveedores_con_regla(uuid) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.reglas_proveedores_con_regla(uuid)
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.reglas_proveedores_con_regla(uuid) TO contapp_worker;
