-- 0070_gnd_funciones (spec 027, D-2 a D-4; R-6, R-7, R-11 a R-14; CA-7 a CA-10, CA-14, CA-16). Funciones acotadas de gastos no
-- deducibles: el ÚNICO camino que escribe las tablas de 0069. Repetible (CREATE OR REPLACE; ALTER/REVOKE/GRANT idempotentes).
-- Las de `public`: SECURITY DEFINER de contapp_migrator (no superusuario ni BYPASSRLS: la RLS sigue aplicando con el app.tenant_id de la
-- sesión), search_path fijo, nombres calificados, SQLSTATE y mensajes fijos (nunca palabras, términos, glosas, RUC ni ids), EXECUTE solo
-- al rol indicado. Las de plataforma (`auth.gnd_global_*`): dueño contapp_auth como `auth.plan_crear` (0024), EXECUTE solo
-- contapp_backend; revalidan en cada llamada la sesión viva y el alta en admin_plataforma (si no, 42501) y solo tocan las dos tablas
-- globales (y leen la sesión, el alta y el nombre del usuario del historial).
--   Sin subtransacciones: no hay bloques EXCEPTION ni SAVEPOINT; las entradas se validan con expresiones regulares y rangos ANTES de
--   escribir (ninguna conversión puede fallar).
--   Quién llama: las del backend exigen app.tenant_id y app.user_id con membresía activa en el estudio (42501); la del worker solo
--   app.tenant_id. Orden: quién llama (42501) -> cliente FOR SHARE (P0002 ajeno o inexistente; 55000 archivado) -> ids y entradas
--   (P0002, 22023) -> pg_advisory_xact_lock -> CA409 -> «sin cambios» (22023) -> CA420 / CA421.
--   Concurrencia: un advisory por estudio `gnd:<tenant>` serializa todo lo que cambia el diccionario propio, las globales desactivadas y
--   el umbral (el límite de 2.000 activas y la palabra repetida se deciden bajo él: nunca 23505); las categorías del cliente toman uno
--   por cliente `gnd:<tenant>:<cliente>`. El FOR SHARE del cliente serializa fijar las categorías y aprender con archivar (UPDATE de
--   cliente). La caché de CIIU se escribe en orden de RUC (sin 40P01) con ON CONFLICT DO UPDATE (el último gana).
--
--   gnd_palabra_agregar(p_palabra, p_categoria, p_excepciones text[]) -> uuid                                        (contapp_backend)
--     22023 palabra fuera de ^[a-z0-9]{3,40}$, categoría fuera de las 6, excepciones nulas o con más de 5 frases o alguna que no sea de
--     1 a 3 palabras normalizadas. CA420 si el estudio ya la tiene (activa o no); CA421 con 2.000 activas. Inserta manual, activa,
--     versión 1, creado_por = el usuario. Audita gnd.palabra_agregada {palabra, categoria, origen}.
--   gnd_palabra_estado(p_id, p_activa, p_version) -> integer (p_version + 1)                                         (contapp_backend)
--     P0002 id ajeno o inexistente; 22023 activa o versión nulas o versión negativa; CA409 versión distinta; 22023 si ya tiene ese
--     estado; reactivar con 2.000 activas: CA421. Audita gnd.palabra_desactivada | gnd.palabra_reactivada {palabra, categoria, origen}.
--   gnd_global_estado(p_palabra_global, p_activa) -> void                                                            (contapp_backend)
--     P0002 global inexistente o inactiva; 22023 activa nula o «sin cambios». false inserta la fila del estudio; true la borra. Audita
--     gnd.global_desactivada | gnd.global_reactivada {palabra, categoria}.
--   gnd_umbral_fijar(p_umbral, p_version) -> integer                                                                 (contapp_backend)
--     22023 umbral fuera de 1..20, versión nula o negativa; CA409 si la versión vigente (0 sin fila) no es p_version; 22023 si el
--     umbral ya es el vigente (3 sin fila). Audita gnd.umbral_cambiado {antes, despues}.
--   gnd_cliente_categorias_fijar(p_cliente, p_permitidas, p_quitadas, p_version) -> integer                          (contapp_backend)
--     22023 listas nulas, con nulos, repetidas, fuera de las 6 o que se cruzan, versión nula o negativa; CA409 versión distinta (0 sin
--     fila); 22023 si las listas (como conjuntos) ya son las vigentes. Guarda las listas tal cual llegan. Audita gnd.categorias_cliente
--     {clienteId, antes: {permitidas, quitadas}, despues: {permitidas, quitadas}}.
--   gnd_aprender(p_cliente, p_compra, p_terminos jsonb) -> jsonb {guardadas, omitidas}                               (contapp_backend)
--     P0002 compra que no es del cliente, descartada, de otro estudio o inexistente; CA422 si su versión vigente (puntero) no está
--     excluida; CA423 sin XML vigente del comprobante; 22023 a TODO si p_terminos no es un arreglo de 1 a 10 objetos con exactamente
--     {termino, categoria} válidos. Omite (en orden) lo que ya existe como propia (activa o no), como global activa no desactivada por
--     el estudio o repetido en la misma lista; CA421 a todo si lo nuevo pasa de 2.000 activas. Guarda cada nueva como aprendida (activa,
--     versión 1, compra de origen) y audita una gnd.palabra_aprendida {palabra, categoria, compraId} por guardada.
--   gnd_ciiu_guardar(p_entradas jsonb) -> integer                                                                    (contapp_worker)
--     Exige app.tenant_id. 22023 a todo si no es un arreglo de 0 a 50 objetos con exactamente {ruc, ciiu}: ruc de 11 dígitos, ciiu de 4
--     dígitos o null. Inserta o actualiza ciiu y consultado_en = clock_timestamp(), en orden de RUC y una vez por RUC (gana la última
--     entrada). No lee ni escribe ninguna otra tabla (ni audita). Devuelve cuántos RUC guardó.
--   auth.gnd_global_listar(hash) -> SETOF gnd_palabra_global (por categoría y palabra, también las inactivas)
--   auth.gnd_global_agregar(hash, palabra, categoria, excepciones) -> la fila nueva; CA420 si existe; 22023 si algo es inválido; su fila
--     `agregada` en gnd_global_historial (antes null, despues {palabra, categoria, excepciones, activa, version}).
--   auth.gnd_global_editar(hash, id, categoria, excepciones, activa, version) -> la fila con version + 1; P0002 inexistente; CA409 versión
--     distinta; 22023 entradas inválidas; su fila `editada` con antes y despues.
--   auth.gnd_global_historial(hash, limite 1..200, antes timestamptz | null) -> los cambios más recientes primero (ocurrida_en < antes),
--     con la palabra y el nombre del autor.

-- ---- Agregar una palabra propia (backend) -----------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gnd_palabra_agregar(p_palabra text, p_categoria text, p_excepciones text[]) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_uuid CONSTANT text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_palabra_re CONSTANT text := '^[a-z0-9]{3,40}$';
  v_frases_re CONSTANT text := '^[a-z0-9]+( [a-z0-9]+){0,2}(\|[a-z0-9]+( [a-z0-9]+){0,2})*$';
  v_categorias CONSTANT text[] := ARRAY['calzado-ropa', 'juguetes', 'entretenimiento', 'alimentos-personales', 'cuidado-personal',
                                        'utiles-escolares'];
  v_limite CONSTANT integer := 2000;
  v_tenant_txt text := nullif(current_setting('app.tenant_id', true), '');
  v_usuario_txt text := nullif(current_setting('app.user_id', true), '');
  v_tenant uuid;
  v_usuario uuid;
  v_activas integer;
  v_id uuid;
BEGIN
  -- ---- Quién llama ----
  IF v_tenant_txt IS NULL OR v_usuario_txt IS NULL OR v_tenant_txt !~ v_uuid OR v_usuario_txt !~ v_uuid THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'gnd_palabra_agregar: sesion sin estudio o sin usuario';
  END IF;
  v_tenant := v_tenant_txt::uuid;
  v_usuario := v_usuario_txt::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM public.membresia mb
     WHERE mb.tenant_id = v_tenant AND mb.usuario_id = v_usuario AND mb.desactivada_en IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'gnd_palabra_agregar: sin membresia activa';
  END IF;

  -- ---- Entradas ----
  IF p_palabra IS NULL OR p_palabra !~ v_palabra_re
     OR p_categoria IS NULL OR NOT (p_categoria = ANY (v_categorias))
     OR p_excepciones IS NULL OR cardinality(p_excepciones) > 5
     OR (cardinality(p_excepciones) > 0
         AND (array_ndims(p_excepciones) <> 1 OR array_to_string(p_excepciones, '|', '') !~ v_frases_re)) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'gnd_palabra_agregar: entradas invalidas';
  END IF;

  -- ---- El diccionario del estudio, uno a la vez ----
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('gnd:' || v_tenant::text, 0));

  IF EXISTS (SELECT 1 FROM public.gnd_palabra_estudio p WHERE p.tenant_id = v_tenant AND p.palabra = p_palabra) THEN
    RAISE EXCEPTION USING ERRCODE = 'CA420', MESSAGE = 'gnd_palabra_agregar: la palabra ya existe';
  END IF;
  SELECT count(*)::integer INTO v_activas FROM public.gnd_palabra_estudio p WHERE p.tenant_id = v_tenant AND p.activa;
  IF v_activas >= v_limite THEN
    RAISE EXCEPTION USING ERRCODE = 'CA421', MESSAGE = 'gnd_palabra_agregar: limite de palabras';
  END IF;

  INSERT INTO public.gnd_palabra_estudio (tenant_id, palabra, categoria, excepciones, origen, activa, version, creado_por,
                                          compra_origen_id, creada_en, actualizada_en)
  VALUES (v_tenant, p_palabra, p_categoria, p_excepciones, 'manual', true, 1, v_usuario, NULL, clock_timestamp(), clock_timestamp())
  RETURNING id INTO v_id;
  PERFORM public.auditoria_registrar(v_tenant, 'gnd.palabra_agregada', NULL, 'gnd_palabra_estudio', v_id,
    jsonb_build_object('palabra', p_palabra, 'categoria', p_categoria, 'origen', 'manual'));
  RETURN v_id;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.gnd_palabra_agregar(text, text, text[]) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gnd_palabra_agregar(text, text, text[])
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gnd_palabra_agregar(text, text, text[]) TO contapp_backend;--> statement-breakpoint

-- ---- Desactivar o reactivar una palabra propia (backend) --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gnd_palabra_estado(p_id uuid, p_activa boolean, p_version integer) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_uuid CONSTANT text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_limite CONSTANT integer := 2000;
  v_tenant_txt text := nullif(current_setting('app.tenant_id', true), '');
  v_usuario_txt text := nullif(current_setting('app.user_id', true), '');
  v_tenant uuid;
  v_usuario uuid;
  v_fila public.gnd_palabra_estudio%ROWTYPE;
  v_activas integer;
BEGIN
  -- ---- Quién llama ----
  IF v_tenant_txt IS NULL OR v_usuario_txt IS NULL OR v_tenant_txt !~ v_uuid OR v_usuario_txt !~ v_uuid THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'gnd_palabra_estado: sesion sin estudio o sin usuario';
  END IF;
  v_tenant := v_tenant_txt::uuid;
  v_usuario := v_usuario_txt::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM public.membresia mb
     WHERE mb.tenant_id = v_tenant AND mb.usuario_id = v_usuario AND mb.desactivada_en IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'gnd_palabra_estado: sin membresia activa';
  END IF;

  -- ---- Entradas ----
  IF p_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'gnd_palabra_estado: palabra no encontrada';
  END IF;
  IF p_activa IS NULL OR p_version IS NULL OR p_version < 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'gnd_palabra_estado: entradas invalidas';
  END IF;

  -- ---- El diccionario del estudio, uno a la vez (el límite se cuenta bajo el bloqueo) ----
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('gnd:' || v_tenant::text, 0));

  SELECT p.* INTO v_fila FROM public.gnd_palabra_estudio p WHERE p.tenant_id = v_tenant AND p.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'gnd_palabra_estado: palabra no encontrada';
  END IF;
  IF v_fila.version <> p_version THEN
    RAISE EXCEPTION USING ERRCODE = 'CA409', MESSAGE = 'gnd_palabra_estado: la palabra cambio';
  END IF;
  IF v_fila.activa = p_activa THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'gnd_palabra_estado: sin cambios';
  END IF;
  IF p_activa THEN
    SELECT count(*)::integer INTO v_activas FROM public.gnd_palabra_estudio p WHERE p.tenant_id = v_tenant AND p.activa;
    IF v_activas >= v_limite THEN
      RAISE EXCEPTION USING ERRCODE = 'CA421', MESSAGE = 'gnd_palabra_estado: limite de palabras';
    END IF;
  END IF;

  UPDATE public.gnd_palabra_estudio p
     SET activa = p_activa, version = p_version + 1, actualizada_en = clock_timestamp()
   WHERE p.tenant_id = v_tenant AND p.id = p_id;
  PERFORM public.auditoria_registrar(v_tenant,
    CASE WHEN p_activa THEN 'gnd.palabra_reactivada' ELSE 'gnd.palabra_desactivada' END, NULL, 'gnd_palabra_estudio', p_id,
    jsonb_build_object('palabra', v_fila.palabra, 'categoria', v_fila.categoria, 'origen', v_fila.origen));
  RETURN p_version + 1;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.gnd_palabra_estado(uuid, boolean, integer) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gnd_palabra_estado(uuid, boolean, integer)
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gnd_palabra_estado(uuid, boolean, integer) TO contapp_backend;--> statement-breakpoint

-- ---- Desactivar o reactivar una global para el estudio (backend) ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gnd_global_estado(p_palabra_global uuid, p_activa boolean) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_uuid CONSTANT text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_tenant_txt text := nullif(current_setting('app.tenant_id', true), '');
  v_usuario_txt text := nullif(current_setting('app.user_id', true), '');
  v_tenant uuid;
  v_usuario uuid;
  v_palabra text;
  v_categoria text;
  v_desactivada boolean;
BEGIN
  -- ---- Quién llama ----
  IF v_tenant_txt IS NULL OR v_usuario_txt IS NULL OR v_tenant_txt !~ v_uuid OR v_usuario_txt !~ v_uuid THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'gnd_global_estado: sesion sin estudio o sin usuario';
  END IF;
  v_tenant := v_tenant_txt::uuid;
  v_usuario := v_usuario_txt::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM public.membresia mb
     WHERE mb.tenant_id = v_tenant AND mb.usuario_id = v_usuario AND mb.desactivada_en IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'gnd_global_estado: sin membresia activa';
  END IF;

  -- ---- Entradas y la global (activa) ----
  IF p_palabra_global IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'gnd_global_estado: palabra no encontrada';
  END IF;
  IF p_activa IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'gnd_global_estado: entradas invalidas';
  END IF;
  SELECT g.palabra, g.categoria INTO v_palabra, v_categoria FROM public.gnd_palabra_global g
   WHERE g.id = p_palabra_global AND g.activa;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'gnd_global_estado: palabra no encontrada';
  END IF;

  -- ---- Uno a la vez por estudio ----
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('gnd:' || v_tenant::text, 0));

  v_desactivada := EXISTS (
    SELECT 1 FROM public.gnd_global_desactivada d WHERE d.tenant_id = v_tenant AND d.palabra_global_id = p_palabra_global);
  IF v_desactivada = NOT p_activa THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'gnd_global_estado: sin cambios';
  END IF;
  IF p_activa THEN
    DELETE FROM public.gnd_global_desactivada d WHERE d.tenant_id = v_tenant AND d.palabra_global_id = p_palabra_global;
  ELSE
    INSERT INTO public.gnd_global_desactivada (tenant_id, palabra_global_id, usuario_id, desactivada_en)
    VALUES (v_tenant, p_palabra_global, v_usuario, clock_timestamp());
  END IF;
  PERFORM public.auditoria_registrar(v_tenant,
    CASE WHEN p_activa THEN 'gnd.global_reactivada' ELSE 'gnd.global_desactivada' END, NULL, 'gnd_palabra_global', p_palabra_global,
    jsonb_build_object('palabra', v_palabra, 'categoria', v_categoria));
END
$$;--> statement-breakpoint
ALTER FUNCTION public.gnd_global_estado(uuid, boolean) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gnd_global_estado(uuid, boolean)
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gnd_global_estado(uuid, boolean) TO contapp_backend;--> statement-breakpoint

-- ---- Umbral del estudio (backend) -------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gnd_umbral_fijar(p_umbral integer, p_version integer) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_uuid CONSTANT text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_tenant_txt text := nullif(current_setting('app.tenant_id', true), '');
  v_usuario_txt text := nullif(current_setting('app.user_id', true), '');
  v_tenant uuid;
  v_usuario uuid;
  v_umbral integer;
  v_version integer;
BEGIN
  -- ---- Quién llama ----
  IF v_tenant_txt IS NULL OR v_usuario_txt IS NULL OR v_tenant_txt !~ v_uuid OR v_usuario_txt !~ v_uuid THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'gnd_umbral_fijar: sesion sin estudio o sin usuario';
  END IF;
  v_tenant := v_tenant_txt::uuid;
  v_usuario := v_usuario_txt::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM public.membresia mb
     WHERE mb.tenant_id = v_tenant AND mb.usuario_id = v_usuario AND mb.desactivada_en IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'gnd_umbral_fijar: sin membresia activa';
  END IF;

  -- ---- Entradas ----
  IF p_umbral IS NULL OR p_umbral NOT BETWEEN 1 AND 20 OR p_version IS NULL OR p_version < 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'gnd_umbral_fijar: entradas invalidas';
  END IF;

  -- ---- Compare-and-set (sin fila: umbral 3, versión 0) ----
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('gnd:' || v_tenant::text, 0));
  SELECT c.umbral, c.version INTO v_umbral, v_version FROM public.gnd_config c WHERE c.tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN
    v_umbral := 3;
    v_version := 0;
  END IF;
  IF v_version <> p_version THEN
    RAISE EXCEPTION USING ERRCODE = 'CA409', MESSAGE = 'gnd_umbral_fijar: el umbral cambio';
  END IF;
  IF v_umbral = p_umbral THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'gnd_umbral_fijar: sin cambios';
  END IF;

  INSERT INTO public.gnd_config AS c (tenant_id, umbral, version) VALUES (v_tenant, p_umbral::smallint, p_version + 1)
  ON CONFLICT (tenant_id) DO UPDATE SET umbral = excluded.umbral, version = excluded.version;
  PERFORM public.auditoria_registrar(v_tenant, 'gnd.umbral_cambiado', NULL, 'gnd_config', NULL,
    jsonb_build_object('antes', v_umbral, 'despues', p_umbral));
  RETURN p_version + 1;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.gnd_umbral_fijar(integer, integer) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gnd_umbral_fijar(integer, integer)
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gnd_umbral_fijar(integer, integer) TO contapp_backend;--> statement-breakpoint

-- ---- Categorías permitidas y quitadas del cliente (backend) -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gnd_cliente_categorias_fijar(p_cliente uuid, p_permitidas text[], p_quitadas text[], p_version integer)
  RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_uuid CONSTANT text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_categorias CONSTANT text[] := ARRAY['calzado-ropa', 'juguetes', 'entretenimiento', 'alimentos-personales', 'cuidado-personal',
                                        'utiles-escolares'];
  v_tenant_txt text := nullif(current_setting('app.tenant_id', true), '');
  v_usuario_txt text := nullif(current_setting('app.user_id', true), '');
  v_tenant uuid;
  v_usuario uuid;
  v_archivado timestamptz;
  v_permitidas text[];
  v_quitadas text[];
  v_version integer;
BEGIN
  -- ---- Quién llama ----
  IF v_tenant_txt IS NULL OR v_usuario_txt IS NULL OR v_tenant_txt !~ v_uuid OR v_usuario_txt !~ v_uuid THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'gnd_cliente_categorias_fijar: sesion sin estudio o sin usuario';
  END IF;
  v_tenant := v_tenant_txt::uuid;
  v_usuario := v_usuario_txt::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM public.membresia mb
     WHERE mb.tenant_id = v_tenant AND mb.usuario_id = v_usuario AND mb.desactivada_en IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'gnd_cliente_categorias_fijar: sin membresia activa';
  END IF;

  -- ---- 1. Cliente FOR SHARE (serializa con archivar) ----
  IF p_cliente IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'gnd_cliente_categorias_fijar: cliente no encontrado';
  END IF;
  SELECT k.archivado_at INTO v_archivado FROM public.cliente k
   WHERE k.tenant_id = v_tenant AND k.id = p_cliente
     FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'gnd_cliente_categorias_fijar: cliente no encontrado';
  END IF;
  IF v_archivado IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'gnd_cliente_categorias_fijar: cliente archivado';
  END IF;

  -- ---- 2. Entradas: subconjuntos de las 6, sin nulos ni repetidas, disjuntas ----
  IF p_permitidas IS NULL OR p_quitadas IS NULL OR p_version IS NULL OR p_version < 0
     OR (cardinality(p_permitidas) > 0 AND array_ndims(p_permitidas) <> 1)
     OR (cardinality(p_quitadas) > 0 AND array_ndims(p_quitadas) <> 1)
     OR array_position(p_permitidas, NULL) IS NOT NULL OR array_position(p_quitadas, NULL) IS NOT NULL
     OR NOT (p_permitidas <@ v_categorias) OR NOT (p_quitadas <@ v_categorias)
     OR p_permitidas && p_quitadas
     OR (SELECT count(DISTINCT u.c) FROM unnest(p_permitidas) AS u(c)) <> cardinality(p_permitidas)
     OR (SELECT count(DISTINCT u.c) FROM unnest(p_quitadas) AS u(c)) <> cardinality(p_quitadas) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'gnd_cliente_categorias_fijar: entradas invalidas';
  END IF;

  -- ---- 3. Compare-and-set por cliente (sin fila: listas vacías, versión 0) ----
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('gnd:' || v_tenant::text || ':' || p_cliente::text, 0));
  SELECT g.permitidas, g.quitadas, g.version INTO v_permitidas, v_quitadas, v_version FROM public.gnd_cliente_categorias g
   WHERE g.tenant_id = v_tenant AND g.cliente_id = p_cliente FOR UPDATE;
  IF NOT FOUND THEN
    v_permitidas := '{}'::text[];
    v_quitadas := '{}'::text[];
    v_version := 0;
  END IF;
  IF v_version <> p_version THEN
    RAISE EXCEPTION USING ERRCODE = 'CA409', MESSAGE = 'gnd_cliente_categorias_fijar: las categorias cambiaron';
  END IF;
  IF p_permitidas <@ v_permitidas AND v_permitidas <@ p_permitidas AND p_quitadas <@ v_quitadas AND v_quitadas <@ p_quitadas THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'gnd_cliente_categorias_fijar: sin cambios';
  END IF;

  INSERT INTO public.gnd_cliente_categorias AS g (tenant_id, cliente_id, permitidas, quitadas, version)
  VALUES (v_tenant, p_cliente, p_permitidas, p_quitadas, p_version + 1)
  ON CONFLICT (tenant_id, cliente_id) DO UPDATE
    SET permitidas = excluded.permitidas, quitadas = excluded.quitadas, version = excluded.version;
  PERFORM public.auditoria_registrar(v_tenant, 'gnd.categorias_cliente', p_cliente, 'gnd_cliente_categorias', NULL,
    jsonb_build_object('clienteId', p_cliente,
                       'antes', jsonb_build_object('permitidas', to_jsonb(v_permitidas), 'quitadas', to_jsonb(v_quitadas)),
                       'despues', jsonb_build_object('permitidas', to_jsonb(p_permitidas), 'quitadas', to_jsonb(p_quitadas))));
  RETURN p_version + 1;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.gnd_cliente_categorias_fijar(uuid, text[], text[], integer) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gnd_cliente_categorias_fijar(uuid, text[], text[], integer)
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gnd_cliente_categorias_fijar(uuid, text[], text[], integer) TO contapp_backend;--> statement-breakpoint

-- ---- Aprender palabras de una compra excluida con XML (backend) -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gnd_aprender(p_cliente uuid, p_compra uuid, p_terminos jsonb) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_uuid CONSTANT text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_palabra_re CONSTANT text := '^[a-z0-9]{3,40}$';
  v_categorias CONSTANT text[] := ARRAY['calzado-ropa', 'juguetes', 'entretenimiento', 'alimentos-personales', 'cuidado-personal',
                                        'utiles-escolares'];
  v_claves CONSTANT text[] := ARRAY['categoria', 'termino'];
  v_limite CONSTANT integer := 2000;
  v_tenant_txt text := nullif(current_setting('app.tenant_id', true), '');
  v_usuario_txt text := nullif(current_setting('app.user_id', true), '');
  v_tenant uuid;
  v_usuario uuid;
  v_archivado timestamptz;
  v_tipo text;
  v_serie text;
  v_numero text;
  v_doc text;
  v_vigente integer;
  v_excluida boolean;
  v_item jsonb;
  v_termino text;
  v_guardadas text[] := '{}'::text[];
  v_categorias_nuevas text[] := '{}'::text[];
  v_omitidas text[] := '{}'::text[];
  v_activas integer;
  v_i integer;
  v_id uuid;
BEGIN
  -- ---- Quién llama ----
  IF v_tenant_txt IS NULL OR v_usuario_txt IS NULL OR v_tenant_txt !~ v_uuid OR v_usuario_txt !~ v_uuid THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'gnd_aprender: sesion sin estudio o sin usuario';
  END IF;
  v_tenant := v_tenant_txt::uuid;
  v_usuario := v_usuario_txt::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM public.membresia mb
     WHERE mb.tenant_id = v_tenant AND mb.usuario_id = v_usuario AND mb.desactivada_en IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'gnd_aprender: sin membresia activa';
  END IF;

  -- ---- 1. Cliente FOR SHARE (serializa con archivar) ----
  IF p_cliente IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'gnd_aprender: cliente no encontrado';
  END IF;
  SELECT k.archivado_at INTO v_archivado FROM public.cliente k
   WHERE k.tenant_id = v_tenant AND k.id = p_cliente
     FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'gnd_aprender: cliente no encontrado';
  END IF;
  IF v_archivado IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'gnd_aprender: cliente archivado';
  END IF;

  -- ---- 2. Compra viva del cliente (FOR SHARE: su exclusión no cambia mientras se aprende) ----
  IF p_compra IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'gnd_aprender: compra no encontrada';
  END IF;
  SELECT btrim(c.tipo_doc), upper(btrim(c.serie)), btrim(c.numero), btrim(c.doc_numero), c.version_vigente
    INTO v_tipo, v_serie, v_numero, v_doc, v_vigente
    FROM public.compra c
   WHERE c.tenant_id = v_tenant AND c.id = p_compra AND c.cliente_id = p_cliente AND c.descartada_en IS NULL
     FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'gnd_aprender: compra no encontrada';
  END IF;
  SELECT v.excluida INTO v_excluida FROM public.compra_version v
   WHERE v.tenant_id = v_tenant AND v.compra_id = p_compra AND v.n = v_vigente;
  IF v_excluida IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = 'CA422', MESSAGE = 'gnd_aprender: la compra no esta excluida';
  END IF;
  -- XML vigente del comprobante (identidad normalizada como la `clave` de 014: serie en mayúsculas, número sin ceros a la izquierda).
  v_numero := CASE WHEN ltrim(v_numero, '0') = '' AND v_numero <> '' THEN '0' ELSE ltrim(v_numero, '0') END;
  IF NOT EXISTS (
    SELECT 1 FROM public.documento_xml d
     WHERE d.tenant_id = v_tenant AND d.cliente_id = p_cliente AND d.ruc_emisor = v_doc AND d.tipo = v_tipo
       AND d.serie = v_serie AND d.numero = v_numero
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'CA423', MESSAGE = 'gnd_aprender: la compra no tiene XML';
  END IF;

  -- ---- 3. Términos: 1 a 10 objetos {termino, categoria} válidos, o nada ----
  IF jsonb_typeof(p_terminos) IS DISTINCT FROM 'array' OR jsonb_array_length(p_terminos) NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'gnd_aprender: terminos invalidos';
  END IF;
  FOR v_item IN SELECT e.value FROM jsonb_array_elements(p_terminos) AS e LOOP
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object'
       OR (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(v_item) AS k) IS DISTINCT FROM v_claves
       OR jsonb_typeof(v_item -> 'termino') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_item -> 'categoria') IS DISTINCT FROM 'string'
       OR (v_item ->> 'termino') !~ v_palabra_re
       OR NOT ((v_item ->> 'categoria') = ANY (v_categorias)) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'gnd_aprender: terminos invalidos';
    END IF;
  END LOOP;

  -- ---- 4. El diccionario del estudio, uno a la vez: omitidas, límite y alta ----
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('gnd:' || v_tenant::text, 0));
  FOR v_item IN SELECT e.value FROM jsonb_array_elements(p_terminos) WITH ORDINALITY AS e(value, orden) ORDER BY e.orden LOOP
    v_termino := v_item ->> 'termino';
    IF v_termino = ANY (v_guardadas) OR v_termino = ANY (v_omitidas)
       OR EXISTS (SELECT 1 FROM public.gnd_palabra_estudio p WHERE p.tenant_id = v_tenant AND p.palabra = v_termino)
       OR EXISTS (
         SELECT 1 FROM public.gnd_palabra_global g
          WHERE g.palabra = v_termino AND g.activa
            AND NOT EXISTS (SELECT 1 FROM public.gnd_global_desactivada d
                             WHERE d.tenant_id = v_tenant AND d.palabra_global_id = g.id)) THEN
      v_omitidas := v_omitidas || v_termino;
    ELSE
      v_guardadas := v_guardadas || v_termino;
      v_categorias_nuevas := v_categorias_nuevas || (v_item ->> 'categoria');
    END IF;
  END LOOP;
  IF cardinality(v_guardadas) > 0 THEN
    SELECT count(*)::integer INTO v_activas FROM public.gnd_palabra_estudio p WHERE p.tenant_id = v_tenant AND p.activa;
    IF v_activas + cardinality(v_guardadas) > v_limite THEN
      RAISE EXCEPTION USING ERRCODE = 'CA421', MESSAGE = 'gnd_aprender: limite de palabras';
    END IF;
  END IF;
  FOR v_i IN 1 .. cardinality(v_guardadas) LOOP
    INSERT INTO public.gnd_palabra_estudio (tenant_id, palabra, categoria, excepciones, origen, activa, version, creado_por,
                                            compra_origen_id, creada_en, actualizada_en)
    VALUES (v_tenant, v_guardadas[v_i], v_categorias_nuevas[v_i], '{}'::text[], 'aprendida', true, 1, v_usuario, p_compra,
            clock_timestamp(), clock_timestamp())
    RETURNING id INTO v_id;
    PERFORM public.auditoria_registrar(v_tenant, 'gnd.palabra_aprendida', p_cliente, 'gnd_palabra_estudio', v_id,
      jsonb_build_object('palabra', v_guardadas[v_i], 'categoria', v_categorias_nuevas[v_i], 'compraId', p_compra));
  END LOOP;
  RETURN jsonb_build_object('guardadas', to_jsonb(v_guardadas), 'omitidas', to_jsonb(v_omitidas));
END
$$;--> statement-breakpoint
ALTER FUNCTION public.gnd_aprender(uuid, uuid, jsonb) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gnd_aprender(uuid, uuid, jsonb)
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gnd_aprender(uuid, uuid, jsonb) TO contapp_backend;--> statement-breakpoint

-- ---- Caché de CIIU (worker, sin SAVEPOINT) ------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gnd_ciiu_guardar(p_entradas jsonb) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_uuid CONSTANT text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_claves CONSTANT text[] := ARRAY['ciiu', 'ruc'];
  v_tenant_txt text := nullif(current_setting('app.tenant_id', true), '');
  v_tenant uuid;
  v_item jsonb;
  v_n integer;
BEGIN
  -- ---- Quién llama ----
  IF v_tenant_txt IS NULL OR v_tenant_txt !~ v_uuid THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'gnd_ciiu_guardar: sesion sin estudio';
  END IF;
  v_tenant := v_tenant_txt::uuid;

  -- ---- Entradas: todas o ninguna ----
  IF jsonb_typeof(p_entradas) IS DISTINCT FROM 'array' OR jsonb_array_length(p_entradas) > 50 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'gnd_ciiu_guardar: entradas invalidas';
  END IF;
  FOR v_item IN SELECT e.value FROM jsonb_array_elements(p_entradas) AS e LOOP
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object'
       OR (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(v_item) AS k) IS DISTINCT FROM v_claves
       OR jsonb_typeof(v_item -> 'ruc') IS DISTINCT FROM 'string'
       OR (v_item ->> 'ruc') !~ '^[0-9]{11}$'
       OR jsonb_typeof(v_item -> 'ciiu') NOT IN ('string', 'null')
       OR (jsonb_typeof(v_item -> 'ciiu') = 'string' AND (v_item ->> 'ciiu') !~ '^[0-9]{4}$') THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'gnd_ciiu_guardar: entradas invalidas';
    END IF;
  END LOOP;

  -- ---- Una vez por RUC (gana la última entrada), en orden de RUC: dos llamadas cruzadas no se interbloquean ----
  INSERT INTO public.gnd_ciiu AS g (tenant_id, ruc, ciiu, consultado_en)
  SELECT v_tenant, x.ruc::char(11), x.ciiu::char(4), clock_timestamp()
    FROM (SELECT DISTINCT ON (e.value ->> 'ruc') e.value ->> 'ruc' AS ruc, e.value ->> 'ciiu' AS ciiu
            FROM jsonb_array_elements(p_entradas) WITH ORDINALITY AS e(value, orden)
           ORDER BY e.value ->> 'ruc', e.orden DESC) AS x
   ORDER BY x.ruc
  ON CONFLICT (tenant_id, ruc) DO UPDATE SET ciiu = excluded.ciiu, consultado_en = excluded.consultado_en;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.gnd_ciiu_guardar(jsonb) OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gnd_ciiu_guardar(jsonb)
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gnd_ciiu_guardar(jsonb) TO contapp_worker;--> statement-breakpoint

-- =================================================================================================================================
-- Plataforma (D-2): el diccionario global lo edita solo el super-admin. Cada función revalida la sesión viva y el alta en
-- admin_plataforma. Solo tocan gnd_palabra_global y gnd_global_historial.
-- =================================================================================================================================

-- Todas las globales (también las inactivas), por categoría y palabra.
CREATE OR REPLACE FUNCTION auth.gnd_global_listar(p_token_hash bytea) RETURNS SETOF public.gnd_palabra_global
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM auth.sesion x JOIN public.admin_plataforma a ON a.usuario_id = x.usuario_id
     WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
       AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'permiso_denegado';
  END IF;
  RETURN QUERY SELECT g.* FROM public.gnd_palabra_global g ORDER BY g.categoria, g.palabra;
END
$$;--> statement-breakpoint

-- Agrega una global activa (versión 1) y su fila `agregada` del historial.
CREATE OR REPLACE FUNCTION auth.gnd_global_agregar(p_token_hash bytea, p_palabra text, p_categoria text, p_excepciones text[])
  RETURNS SETOF public.gnd_palabra_global
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_palabra_re CONSTANT text := '^[a-z0-9]{3,40}$';
  v_frases_re CONSTANT text := '^[a-z0-9]+( [a-z0-9]+){0,2}(\|[a-z0-9]+( [a-z0-9]+){0,2})*$';
  v_categorias CONSTANT text[] := ARRAY['calzado-ropa', 'juguetes', 'entretenimiento', 'alimentos-personales', 'cuidado-personal',
                                        'utiles-escolares'];
  v_usuario uuid;
  v public.gnd_palabra_global%ROWTYPE;
BEGIN
  SELECT x.usuario_id INTO v_usuario FROM auth.sesion x JOIN public.admin_plataforma a ON a.usuario_id = x.usuario_id
   WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'permiso_denegado';
  END IF;
  IF p_palabra IS NULL OR p_palabra !~ v_palabra_re
     OR p_categoria IS NULL OR NOT (p_categoria = ANY (v_categorias))
     OR p_excepciones IS NULL OR cardinality(p_excepciones) > 5
     OR (cardinality(p_excepciones) > 0
         AND (array_ndims(p_excepciones) <> 1 OR array_to_string(p_excepciones, '|', '') !~ v_frases_re)) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'gnd_global_agregar: entradas invalidas';
  END IF;
  INSERT INTO public.gnd_palabra_global AS n (palabra, categoria, excepciones, activa, version, actualizada_en)
  VALUES (p_palabra, p_categoria, p_excepciones, true, 1, clock_timestamp())
  ON CONFLICT (palabra) DO NOTHING
  RETURNING n.* INTO v;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'CA420', MESSAGE = 'gnd_global_agregar: la palabra ya existe';
  END IF;
  INSERT INTO public.gnd_global_historial (palabra_global_id, accion, antes, despues, usuario_id, ocurrida_en)
  VALUES (v.id, 'agregada', NULL,
          jsonb_build_object('palabra', v.palabra, 'categoria', v.categoria, 'excepciones', to_jsonb(v.excepciones),
                             'activa', v.activa, 'version', v.version),
          v_usuario, clock_timestamp());
  RETURN NEXT v;
END
$$;--> statement-breakpoint

-- Edita categoría, excepciones y estado con compare-and-set por versión; deja su fila `editada` con antes y después.
CREATE OR REPLACE FUNCTION auth.gnd_global_editar(
  p_token_hash bytea, p_id uuid, p_categoria text, p_excepciones text[], p_activa boolean, p_version integer
) RETURNS SETOF public.gnd_palabra_global
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_frases_re CONSTANT text := '^[a-z0-9]+( [a-z0-9]+){0,2}(\|[a-z0-9]+( [a-z0-9]+){0,2})*$';
  v_categorias CONSTANT text[] := ARRAY['calzado-ropa', 'juguetes', 'entretenimiento', 'alimentos-personales', 'cuidado-personal',
                                        'utiles-escolares'];
  v_usuario uuid;
  v_antes public.gnd_palabra_global%ROWTYPE;
  v public.gnd_palabra_global%ROWTYPE;
BEGIN
  SELECT x.usuario_id INTO v_usuario FROM auth.sesion x JOIN public.admin_plataforma a ON a.usuario_id = x.usuario_id
   WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
     AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'permiso_denegado';
  END IF;
  IF p_categoria IS NULL OR NOT (p_categoria = ANY (v_categorias))
     OR p_excepciones IS NULL OR cardinality(p_excepciones) > 5
     OR (cardinality(p_excepciones) > 0
         AND (array_ndims(p_excepciones) <> 1 OR array_to_string(p_excepciones, '|', '') !~ v_frases_re))
     OR p_activa IS NULL OR p_version IS NULL OR p_version < 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'gnd_global_editar: entradas invalidas';
  END IF;
  IF p_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'gnd_global_editar: palabra no encontrada';
  END IF;
  SELECT g.* INTO v_antes FROM public.gnd_palabra_global g WHERE g.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'gnd_global_editar: palabra no encontrada';
  END IF;
  IF v_antes.version <> p_version THEN
    RAISE EXCEPTION USING ERRCODE = 'CA409', MESSAGE = 'gnd_global_editar: la palabra cambio';
  END IF;
  UPDATE public.gnd_palabra_global AS g
     SET categoria = p_categoria, excepciones = p_excepciones, activa = p_activa, version = p_version + 1,
         actualizada_en = clock_timestamp()
   WHERE g.id = p_id
  RETURNING g.* INTO v;
  INSERT INTO public.gnd_global_historial (palabra_global_id, accion, antes, despues, usuario_id, ocurrida_en)
  VALUES (v.id, 'editada',
          jsonb_build_object('palabra', v_antes.palabra, 'categoria', v_antes.categoria, 'excepciones', to_jsonb(v_antes.excepciones),
                             'activa', v_antes.activa, 'version', v_antes.version),
          jsonb_build_object('palabra', v.palabra, 'categoria', v.categoria, 'excepciones', to_jsonb(v.excepciones),
                             'activa', v.activa, 'version', v.version),
          v_usuario, clock_timestamp());
  RETURN NEXT v;
END
$$;--> statement-breakpoint

-- Historial global, los más recientes primero, paginado por fecha (`p_antes` null: la primera página), con la palabra y el autor.
CREATE OR REPLACE FUNCTION auth.gnd_global_historial(p_token_hash bytea, p_limite integer, p_antes timestamptz)
  RETURNS TABLE (id uuid, palabra_global_id uuid, accion text, antes jsonb, despues jsonb, usuario_id uuid,
                 ocurrida_en timestamptz, palabra text, usuario_nombre text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM auth.sesion x JOIN public.admin_plataforma a ON a.usuario_id = x.usuario_id
     WHERE x.token_hash = p_token_hash AND x.revocada_en IS NULL
       AND x.expira_absoluta > now() AND x.ultimo_uso > now() - interval '2 hours'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'permiso_denegado';
  END IF;
  IF p_limite IS NULL OR p_limite NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'gnd_global_historial: entradas invalidas';
  END IF;
  RETURN QUERY
    SELECT h.id, h.palabra_global_id, h.accion, h.antes, h.despues, h.usuario_id, h.ocurrida_en, g.palabra, u.nombre
      FROM public.gnd_global_historial h
      JOIN public.gnd_palabra_global g ON g.id = h.palabra_global_id
      JOIN public.usuario u ON u.id = h.usuario_id
     WHERE p_antes IS NULL OR h.ocurrida_en < p_antes
     ORDER BY h.ocurrida_en DESC, h.id DESC
     LIMIT p_limite;
END
$$;--> statement-breakpoint

ALTER FUNCTION auth.gnd_global_listar(bytea) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.gnd_global_agregar(bytea, text, text, text[]) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.gnd_global_editar(bytea, uuid, text, text[], boolean, integer) OWNER TO contapp_auth;--> statement-breakpoint
ALTER FUNCTION auth.gnd_global_historial(bytea, integer, timestamptz) OWNER TO contapp_auth;--> statement-breakpoint
REVOKE ALL ON FUNCTION
  auth.gnd_global_listar(bytea),
  auth.gnd_global_agregar(bytea, text, text, text[]),
  auth.gnd_global_editar(bytea, uuid, text, text[], boolean, integer),
  auth.gnd_global_historial(bytea, integer, timestamptz)
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_enumerador, contapp_registrador;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  auth.gnd_global_listar(bytea),
  auth.gnd_global_agregar(bytea, text, text, text[]),
  auth.gnd_global_editar(bytea, uuid, text, text[], boolean, integer),
  auth.gnd_global_historial(bytea, integer, timestamptz)
  TO contapp_backend;
