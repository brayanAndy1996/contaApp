-- 0039_venta_periodo_exclusion (spec 012b, P-1, P-8, P-9, D5, D12). Estado del periodo de ventas, exclusión de ventas del SIRE con
-- error y el trigger que acota al worker sobre los estados de los dos libros (lección de 016: ningún grant amplio al worker).
--   venta_periodo     = compra_periodo (0033): SELECT/INSERT y UPDATE de (estado, marcado_por, marcado_en) a backend y worker (el
--                       worker marca `generado` y Postgres exige UPDATE de alguna columna para `FOR SHARE`). Sin DELETE.
--   venta_exclusion   solo inserción; restaurar cierra la vigente escribiendo restaurada_* (como venta_salto_justificado). Backend
--                       SELECT/INSERT y UPDATE (restaurada_por, restaurada_en); worker SELECT. Una sola vigente por venta (único
--                       parcial). Trigger BEFORE INSERT: la venta es de origen `sire` y del mismo cliente y periodo (23514).
--                       Trigger BEFORE UPDATE OR DELETE: 42501 salvo cerrar una vigente una vez tocando solo restaurada_*.
--   periodo_worker_acotado  BEFORE INSERT OR UPDATE en compra_periodo y venta_periodo: con el rol del worker solo inserta `abierto`
--                       sin marca y solo pasa de abierto|revisado a generado con marcado_por no nulo; otro caso 42501.
--   venta_salto_justificado  el worker gana SELECT (avisos de correlatividad del archivo). Nada más.
-- `venta` gana su única (tenant_id, id) como índice (destino de la FK compuesta), sin tocar sus filas.
-- Funciones SECURITY INVOKER de dueño contapp_migrator, search_path fijo, mensajes fijos y sin EXECUTE para PUBLIC. La parte de
-- funciones, triggers, RLS y grants es repetible sentencia a sentencia (CREATE OR REPLACE, DROP ... IF EXISTS, GRANT/REVOKE).
CREATE UNIQUE INDEX IF NOT EXISTS "venta_tenant_id_unique" ON "venta" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE TABLE "venta_exclusion" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"cliente_id" uuid NOT NULL,
	"periodo" char(6) NOT NULL,
	"venta_id" uuid NOT NULL,
	"motivo" text NOT NULL,
	"excluida_por" uuid NOT NULL,
	"excluida_en" timestamp with time zone DEFAULT now() NOT NULL,
	"restaurada_por" uuid,
	"restaurada_en" timestamp with time zone,
	CONSTRAINT "venta_exclusion_periodo_formato" CHECK ("venta_exclusion"."periodo" ~ '^[0-9]{4}(0[1-9]|1[0-2])$'),
	CONSTRAINT "venta_exclusion_motivo_largo" CHECK (char_length("venta_exclusion"."motivo") BETWEEN 1 AND 200),
	CONSTRAINT "venta_exclusion_restauracion_completa" CHECK (("venta_exclusion"."restaurada_por" IS NULL) = ("venta_exclusion"."restaurada_en" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "venta_periodo" (
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"cliente_id" uuid NOT NULL,
	"periodo" char(6) NOT NULL,
	"estado" text NOT NULL,
	"marcado_por" uuid,
	"marcado_en" timestamp with time zone,
	CONSTRAINT "venta_periodo_pk" PRIMARY KEY("tenant_id","cliente_id","periodo"),
	CONSTRAINT "venta_periodo_periodo_formato" CHECK ("venta_periodo"."periodo" ~ '^[0-9]{4}(0[1-9]|1[0-2])$'),
	CONSTRAINT "venta_periodo_estado_valido" CHECK ("venta_periodo"."estado" IN ('abierto', 'revisado', 'generado'))
);
--> statement-breakpoint
ALTER TABLE "venta_exclusion" ADD CONSTRAINT "venta_exclusion_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venta_exclusion" ADD CONSTRAINT "venta_exclusion_cliente_fk" FOREIGN KEY ("tenant_id","cliente_id") REFERENCES "public"."cliente"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venta_exclusion" ADD CONSTRAINT "venta_exclusion_venta_fk" FOREIGN KEY ("tenant_id","venta_id") REFERENCES "public"."venta"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venta_exclusion" ADD CONSTRAINT "venta_exclusion_excluida_por_fk" FOREIGN KEY ("tenant_id","excluida_por") REFERENCES "public"."membresia"("tenant_id","usuario_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venta_exclusion" ADD CONSTRAINT "venta_exclusion_restaurada_por_fk" FOREIGN KEY ("tenant_id","restaurada_por") REFERENCES "public"."membresia"("tenant_id","usuario_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venta_periodo" ADD CONSTRAINT "venta_periodo_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venta_periodo" ADD CONSTRAINT "venta_periodo_cliente_fk" FOREIGN KEY ("tenant_id","cliente_id") REFERENCES "public"."cliente"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venta_periodo" ADD CONSTRAINT "venta_periodo_marcado_por_fk" FOREIGN KEY ("tenant_id","marcado_por") REFERENCES "public"."membresia"("tenant_id","usuario_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "venta_exclusion_vigente_unique" ON "venta_exclusion" USING btree ("tenant_id","venta_id") WHERE "venta_exclusion"."restaurada_en" IS NULL;--> statement-breakpoint
CREATE INDEX "venta_exclusion_cliente_periodo_idx" ON "venta_exclusion" USING btree ("cliente_id","periodo");--> statement-breakpoint

-- RLS, dueño y grants.
ALTER TABLE public.venta_periodo OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.venta_periodo ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.venta_periodo FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.venta_periodo;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.venta_periodo FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
REVOKE ALL ON public.venta_periodo FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app;--> statement-breakpoint
GRANT SELECT, INSERT ON public.venta_periodo TO contapp_backend, contapp_worker;--> statement-breakpoint
GRANT UPDATE (estado, marcado_por, marcado_en) ON public.venta_periodo TO contapp_backend, contapp_worker;--> statement-breakpoint

ALTER TABLE public.venta_exclusion OWNER TO contapp_migrator;--> statement-breakpoint
ALTER TABLE public.venta_exclusion ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.venta_exclusion FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.venta_exclusion;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.venta_exclusion FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
REVOKE ALL ON public.venta_exclusion FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app;--> statement-breakpoint
GRANT SELECT, INSERT ON public.venta_exclusion TO contapp_backend;--> statement-breakpoint
GRANT UPDATE (restaurada_por, restaurada_en) ON public.venta_exclusion TO contapp_backend;--> statement-breakpoint
GRANT SELECT ON public.venta_exclusion TO contapp_worker;--> statement-breakpoint

-- El worker lee los justificados (aviso SALTO_CORRELATIVIDAD del archivo de ventas). Solo lectura.
GRANT SELECT ON public.venta_salto_justificado TO contapp_worker;--> statement-breakpoint

-- Worker acotado sobre el estado de los dos libros. El backend no cambia (revisar, reabrir y marcar siguen como en 014).
CREATE OR REPLACE FUNCTION public.periodo_worker_acotado() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF current_user <> 'contapp_worker' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.estado = 'abierto' AND NEW.marcado_por IS NULL AND NEW.marcado_en IS NULL THEN
      RETURN NEW;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.estado IN ('abierto', 'revisado') AND NEW.estado = 'generado' AND NEW.marcado_por IS NOT NULL
       AND ROW(NEW.tenant_id, NEW.cliente_id, NEW.periodo) IS NOT DISTINCT FROM ROW(OLD.tenant_id, OLD.cliente_id, OLD.periodo) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '42501',
    MESSAGE = 'periodo: el worker solo crea el periodo abierto y lo marca generado';
END
$$;--> statement-breakpoint
ALTER FUNCTION public.periodo_worker_acotado() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.periodo_worker_acotado() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS periodo_worker_acotado ON public.compra_periodo;--> statement-breakpoint
CREATE TRIGGER periodo_worker_acotado BEFORE INSERT OR UPDATE ON public.compra_periodo
  FOR EACH ROW EXECUTE FUNCTION public.periodo_worker_acotado();--> statement-breakpoint
DROP TRIGGER IF EXISTS periodo_worker_acotado ON public.venta_periodo;--> statement-breakpoint
CREATE TRIGGER periodo_worker_acotado BEFORE INSERT OR UPDATE ON public.venta_periodo
  FOR EACH ROW EXECUTE FUNCTION public.periodo_worker_acotado();--> statement-breakpoint

-- venta_exclusion: solo se excluye una venta del SIRE del mismo cliente y periodo (la regla «tiene error» la aplica el servicio).
-- INVOKER: lee `venta` con los permisos y la RLS de quien inserta (una venta de otro estudio no se ve y se rechaza).
CREATE OR REPLACE FUNCTION public.venta_exclusion_venta_valida() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.venta v
     WHERE v.tenant_id = NEW.tenant_id AND v.id = NEW.venta_id AND v.cliente_id = NEW.cliente_id
       AND v.periodo = NEW.periodo AND v.origen = 'sire'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'venta_exclusion: solo se excluye una venta del SIRE del mismo cliente y periodo';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
ALTER FUNCTION public.venta_exclusion_venta_valida() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.venta_exclusion_venta_valida() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS venta_exclusion_venta_valida ON public.venta_exclusion;--> statement-breakpoint
CREATE TRIGGER venta_exclusion_venta_valida BEFORE INSERT ON public.venta_exclusion
  FOR EACH ROW EXECUTE FUNCTION public.venta_exclusion_venta_valida();--> statement-breakpoint

-- venta_exclusion: nadie cambia ni borra (tampoco el dueño ni el superusuario); solo se cierra una vigente, una vez, tocando
-- únicamente restaurada_por y restaurada_en (la FK a membresia valida a quien restaura).
CREATE OR REPLACE FUNCTION public.venta_exclusion_inmutable() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.restaurada_por IS NULL AND OLD.restaurada_en IS NULL
     AND NEW.restaurada_por IS NOT NULL AND NEW.restaurada_en IS NOT NULL
     AND ROW(NEW.id, NEW.tenant_id, NEW.cliente_id, NEW.periodo, NEW.venta_id, NEW.motivo, NEW.excluida_por, NEW.excluida_en)
         IS NOT DISTINCT FROM
         ROW(OLD.id, OLD.tenant_id, OLD.cliente_id, OLD.periodo, OLD.venta_id, OLD.motivo, OLD.excluida_por, OLD.excluida_en) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '42501',
    MESSAGE = 'venta_exclusion: solo se cierra una exclusion vigente, una vez';
END
$$;--> statement-breakpoint
ALTER FUNCTION public.venta_exclusion_inmutable() OWNER TO contapp_migrator;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.venta_exclusion_inmutable() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS venta_exclusion_inmutable ON public.venta_exclusion;--> statement-breakpoint
CREATE TRIGGER venta_exclusion_inmutable BEFORE UPDATE OR DELETE ON public.venta_exclusion
  FOR EACH ROW EXECUTE FUNCTION public.venta_exclusion_inmutable();
