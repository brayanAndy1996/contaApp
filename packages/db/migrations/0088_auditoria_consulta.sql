-- 0088_auditoria_consulta (spec 031, D-1, D-3, D-4, D-7). Consulta de auditoría con filtros y alcance en SQL. Solo índices y funciones:
--   public.auditoria_ms  milisegundos truncados de un timestamptz (date_trunc en UTC, que no depende de la zona). IMMUTABLE para el
--              índice y LEAKPROOF (la crea el superusuario de las migraciones): `auditoria_descifrado` tiene RLS FORCE y una comparación
--              con date_trunc (no LEAKPROOF) quedaría como Filter y no como condición del índice; la función de descifrados recorrería
--              el estudio entero para una ventana de fechas o una página profunda. No lanza para ningún valor (también ±infinity).
--              SET search_path: además impide que se expanda en línea (perdería LEAKPROOF). Sin EXECUTE para PUBLIC; la ejecuta
--              contapp_worker porque la expresión del índice se evalúa con el rol que inserta en `auditoria_descifrado`. Va en
--              `public` (como uuid_v7) y no en `interno`: ningún rol de la app ejecuta funciones de `interno` (017 R1).
--   Índices (D-7) auditoria (tenant_id, usuario_id, ocurrida_en, id) y (tenant_id, accion, ocurrida_en, id); auditoria_descifrado
--              (tenant_id, ms, id) y (tenant_id, cliente_id, ms, id), con ms = public.auditoria_ms(created_at). Mismo orden
--              (DESC NULLS LAST) que los de 017 y que el ORDER BY de cada rama.
--   auditoria_descifrado_listar  reemplaza la firma de 017 (DROP): agrega cliente, fechas (desde inclusivo, hasta exclusivo, sobre ms) y
--              alcance DENTRO de la función, antes del LIMIT: p_global true = todo el estudio; false = clientes con asignación de
--              p_usuario en el estudio del contexto (LATERAL por cliente asignado); null, o false sin usuario = nada (falla cerrado).
--              Sin estudio en el contexto, nada. plpgsql con RETURN QUERY EXECUTE de texto FIJO y valores por USING: cada llamada se
--              planifica con sus valores (los filtros ausentes se pliegan) y nada se concatena. Mismo dueño, search_path y grants.
-- Lo de 003 no cambia: la app sigue sin SELECT sobre auditoria_descifrado.
CREATE OR REPLACE FUNCTION public.auditoria_ms(p timestamptz) RETURNS timestamptz
  LANGUAGE sql IMMUTABLE STRICT LEAKPROOF PARALLEL SAFE SET search_path = pg_catalog, pg_temp
AS $$ SELECT date_trunc('milliseconds', p AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' $$;--> statement-breakpoint
ALTER FUNCTION public.auditoria_ms(timestamptz) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.auditoria_ms(timestamptz)
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.auditoria_ms(timestamptz) TO contapp_worker;--> statement-breakpoint

CREATE INDEX "auditoria_descifrado_fecha_idx" ON "auditoria_descifrado" USING btree ("tenant_id",public.auditoria_ms("created_at") DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "auditoria_descifrado_cliente_idx" ON "auditoria_descifrado" USING btree ("tenant_id","cliente_id",public.auditoria_ms("created_at") DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "auditoria_usuario_idx" ON "auditoria" USING btree ("tenant_id","usuario_id","ocurrida_en" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "auditoria_accion_idx" ON "auditoria" USING btree ("tenant_id","accion","ocurrida_en" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint

-- ---- auditoria_descifrado_listar (firma nueva; la de 017 se quita) ------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.auditoria_descifrado_listar(timestamptz, uuid, integer);--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.auditoria_descifrado_listar(
  p_antes timestamptz, p_antes_id uuid, p_limite integer, p_cliente_id uuid, p_desde timestamptz, p_hasta timestamptz,
  p_global boolean, p_usuario uuid
) RETURNS TABLE (id uuid, cliente_id uuid, tipo text, motivo text, resultado text, created_at timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  v_limite integer := least(greatest(coalesce(p_limite, 50), 0), 50);
BEGIN
  IF v_tenant IS NULL OR v_limite = 0 OR p_global IS NULL OR (p_global IS FALSE AND p_usuario IS NULL) THEN
    RETURN;
  END IF;
  -- $1 estudio · $2 antes · $3 antes_id · $4 límite · $5 cliente · $6 desde · $7 hasta (exclusivo) · $8 usuario del alcance.
  -- El cursor (ms, id) < ($2, $3) es el de 017: con $3 null no entra ninguna fila del mismo ms.
  IF p_global THEN
    RETURN QUERY EXECUTE $q$
      SELECT d.id, d.cliente_id, d.tipo, d.motivo, d.resultado, public.auditoria_ms(d.created_at)
        FROM public.auditoria_descifrado d
       WHERE d.tenant_id = $1
         AND ($2::timestamptz IS NULL OR (public.auditoria_ms(d.created_at), d.id) < ($2::timestamptz, $3::uuid))
         AND ($5::uuid IS NULL OR d.cliente_id = $5::uuid)
         AND ($6::timestamptz IS NULL OR public.auditoria_ms(d.created_at) >= $6::timestamptz)
         AND ($7::timestamptz IS NULL OR public.auditoria_ms(d.created_at) < $7::timestamptz)
       ORDER BY public.auditoria_ms(d.created_at) DESC NULLS LAST, d.id DESC NULLS LAST
       LIMIT $4
    $q$ USING v_tenant, p_antes, p_antes_id, v_limite, p_cliente_id, p_desde, p_hasta;
  ELSE
    RETURN QUERY EXECUTE $q$
      SELECT x.id, x.cliente_id, x.tipo, x.motivo, x.resultado, x.ms
        FROM public.asignacion asg
       CROSS JOIN LATERAL (
         SELECT d.id, d.cliente_id, d.tipo, d.motivo, d.resultado, public.auditoria_ms(d.created_at) AS ms
           FROM public.auditoria_descifrado d
          WHERE d.tenant_id = $1
            AND d.cliente_id = asg.cliente_id
            AND ($2::timestamptz IS NULL OR (public.auditoria_ms(d.created_at), d.id) < ($2::timestamptz, $3::uuid))
            AND ($6::timestamptz IS NULL OR public.auditoria_ms(d.created_at) >= $6::timestamptz)
            AND ($7::timestamptz IS NULL OR public.auditoria_ms(d.created_at) < $7::timestamptz)
          ORDER BY public.auditoria_ms(d.created_at) DESC NULLS LAST, d.id DESC NULLS LAST
          LIMIT $4) x
       WHERE asg.tenant_id = $1
         AND asg.usuario_id = $8::uuid
         AND ($5::uuid IS NULL OR asg.cliente_id = $5::uuid)
       ORDER BY x.ms DESC, x.id DESC
       LIMIT $4
    $q$ USING v_tenant, p_antes, p_antes_id, v_limite, p_cliente_id, p_desde, p_hasta, p_usuario;
  END IF;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.auditoria_descifrado_listar(timestamptz, uuid, integer, uuid, timestamptz, timestamptz, boolean, uuid) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.auditoria_descifrado_listar(timestamptz, uuid, integer, uuid, timestamptz, timestamptz, boolean, uuid)
  FROM PUBLIC, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.auditoria_descifrado_listar(timestamptz, uuid, integer, uuid, timestamptz, timestamptz, boolean, uuid) TO contapp_backend;
