-- Spec 007b (D2): credencial.cliente_id pasa a tener FK compuesta al cliente del mismo estudio (sin ON DELETE: borrar un
-- cliente con credenciales se rechaza; archivar es la baja lógica). Idempotente.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'credencial_cliente_fk' AND conrelid = 'public.credencial'::regclass
  ) THEN
    ALTER TABLE "credencial" ADD CONSTRAINT "credencial_cliente_fk" FOREIGN KEY ("tenant_id","cliente_id") REFERENCES "public"."cliente"("tenant_id","id") ON DELETE no action ON UPDATE no action;
  END IF;
END
$$;
