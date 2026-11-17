-- 0057_buzon_insert_acotado (spec 023, T18, H-023-1-5; D-3, D-5). El INSERT del worker en las tablas del buzón queda acotado por
-- columnas: 0054 le dio INSERT en toda la fila. Sin tablas: todo es repetible (CREATE OR REPLACE, DROP ... IF EXISTS). Triggers y
-- no grants por columna: el INSERT de tabla del worker es parte del catálogo de grants de 0054 (y sus pruebas), y la captura y las
-- pruebas insertan columnas reservadas en NULL. Ambos BEFORE INSERT, SECURITY INVOKER (current_user es quien escribe); solo un
-- superusuario (siembra, mantenimiento) queda fuera. Las funciones SECURITY DEFINER de 0055 (encolar_buzon_programados,
-- buzon_estado_bloquear) crean la fila de estado solo con (tenant_id, cliente_id) y fijan las franjas después con UPDATE.
--   buzon_estado_sin_franjas    un estado nuevo llega con ultima_programada_en y ultima_solicitud_en en NULL (42501 si no): la
--                               primera la fija solo encolar_buzon_programados y la segunda el backend (0055).
--   buzon_mensaje_sin_contenido un mensaje nuevo llega SIN contenido (contenido_ruta, contenido_bytes y contenido_obtenido_en en
--                               NULL; 42501 si no): el contenido se fija al abrir, con el UPDATE que audita
--                               buzon.contenido_obtenido (0056).
CREATE OR REPLACE FUNCTION public.buzon_estado_sin_franjas() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (NEW.ultima_programada_en IS NOT NULL OR NEW.ultima_solicitud_en IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND r.rolsuper)
  THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'buzon_estado_cliente: las franjas no se fijan al crear el estado';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.buzon_estado_sin_franjas() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.buzon_estado_sin_franjas() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS buzon_estado_sin_franjas ON public.buzon_estado_cliente;--> statement-breakpoint
CREATE TRIGGER buzon_estado_sin_franjas BEFORE INSERT ON public.buzon_estado_cliente
  FOR EACH ROW EXECUTE FUNCTION public.buzon_estado_sin_franjas();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.buzon_mensaje_sin_contenido() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (NEW.contenido_ruta IS NOT NULL OR NEW.contenido_bytes IS NOT NULL OR NEW.contenido_obtenido_en IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND r.rolsuper)
  THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'buzon_mensaje: el contenido se fija al abrir, no al capturar';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.buzon_mensaje_sin_contenido() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.buzon_mensaje_sin_contenido() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS buzon_mensaje_sin_contenido ON public.buzon_mensaje;--> statement-breakpoint
CREATE TRIGGER buzon_mensaje_sin_contenido BEFORE INSERT ON public.buzon_mensaje
  FOR EACH ROW EXECUTE FUNCTION public.buzon_mensaje_sin_contenido();
