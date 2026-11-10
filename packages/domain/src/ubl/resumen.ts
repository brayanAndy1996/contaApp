// Spec 016 (D-2, D-6): `DetalleXml` → `ResumenXml` de 011 (lo que leen las reglas). Montos como `Money` en la moneda del
// documento; las notas de crédito ya vienen en negativo en el detalle. Si `monedaUnica` es false, el total queda en la otra
// moneda para que 011 emita `XML_MONEDA` (no hay sugerencias de un XML con monedas mezcladas).
import { Money } from "../dinero/index";
import type { Moneda } from "../dinero/index";
import type { ResumenXml } from "../reglas/index";
import type { DetalleXml } from "./tipos";

const TIPO_RUC = "6";

const otra = (m: Moneda): Moneda => (m === "PEN" ? "USD" : "PEN");

export function aResumenXml(detalle: DetalleXml): ResumenXml {
  const { identidad, totales, moneda } = detalle;
  const m = (valor: string): Money => Money.desde(valor, moneda);
  return {
    proveedor: { tipo: TIPO_RUC, numero: identidad.emisor.ruc },
    comprobante: { tipo: identidad.tipo, serie: identidad.serie, numero: identidad.numero },
    moneda,
    gravado: m(totales.gravado),
    igv: m(totales.igv),
    noGravado: m(totales.noGravado),
    isc: m(totales.isc),
    icbper: m(totales.icbper),
    total: Money.desde(totales.total, detalle.monedaUnica ? moneda : otra(moneda)),
    glosas: detalle.items.map((i) => i.descripcion),
  };
}
