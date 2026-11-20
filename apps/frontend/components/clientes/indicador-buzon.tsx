import Link from "next/link";
import type { IndicadorBuzon as Indicador } from "@contapp/shared";
import { Badge, enlace } from "../ui";
import { MENSAJES_BANDEJA as B } from "../../lib/buzon";
import { cn } from "../../lib/utils";

// Indicador de mensajes nuevos del buzón en el listado de clientes (spec 024, D-9, CA-3, CA-8). `buzon` solo viaja con
// `buzon.ver`: sin él, o con 0 nuevos, no se pinta nada. Los críticos se dicen con texto y con el token de error.

export function IndicadorBuzon({ clienteId, buzon }: { clienteId: string; buzon?: Indicador | undefined }) {
  if (!buzon || buzon.nuevos <= 0) return null;
  return (
    <Link
      href={`/clientes/${encodeURIComponent(clienteId)}/buzon`}
      className={cn(enlace, "inline-flex flex-wrap items-center gap-1.5 no-underline max-lg:min-h-11")}
    >
      <Badge tono="info">{B.nuevos(buzon.nuevos)}</Badge>
      {buzon.criticosNuevos > 0 && <Badge tono="error">{B.criticos(buzon.criticosNuevos)}</Badge>}
    </Link>
  );
}
