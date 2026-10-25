// AAD v1 (D7): `v1|tenant|cliente|tipo` en UTF-8, con UUID canónicos en minúscula.
import { ContextoAadInvalidoError } from "./errores";
import type { ContextoAad, TipoCredencial } from "./sobre";

const UUID_CANONICO =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIPOS: readonly string[] = ["sol", "sire_api"] satisfies TipoCredencial[];

function esUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_CANONICO.test(v);
}

/** Valida el contexto y devuelve la AAD. Lanza ContextoAadInvalidoError. */
export function construirAad(ctx: ContextoAad): Buffer {
  const ok =
    typeof ctx === "object" &&
    ctx !== null &&
    esUuid(ctx.tenantId) &&
    esUuid(ctx.clienteId) &&
    TIPOS.includes(ctx.tipo);
  if (!ok) throw new ContextoAadInvalidoError();
  return Buffer.from(`v1|${ctx.tenantId}|${ctx.clienteId}|${ctx.tipo}`, "utf8");
}
