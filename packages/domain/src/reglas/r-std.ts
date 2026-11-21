// R-STD, el modo estándar (spec 025, RF-113, HU-30; D-8, U-3, U-4; plan Contratos: domain). Puro: sin IO. En clientes de la
// Amazonía con ventas exoneradas y sin ventas mixtas, sugiere DNG por fila a los proveedores sin regla aprendida activa. Es un
// `clasificar` sin dato ni confirmación (el respaldo es el perfil): aplicar usa el destino del hallazgo y se acepta en masa.
import { crearHallazgo } from "./entrada";
import type { ContextoInterno, FilaInterna } from "./entrada";
import { MODO_ESTANDAR } from "./explicaciones";
import type { Hallazgo } from "./tipos";

/** Perfil fiscal del cliente (RF-036, guardado por 007a). */
export interface PerfilCliente {
  /** «general» o «amazonia»; cualquier otro valor no cumple. */
  readonly zona: string;
  readonly ventasExoneradas: boolean;
  readonly ventasMixtas: boolean;
}

/** U-4: zona «amazonia» exacta, con ventas exoneradas y sin ventas mixtas. */
export function cumpleModoEstandar(perfil: PerfilCliente): boolean {
  return perfil.zona === "amazonia" && perfil.ventasExoneradas === true && perfil.ventasMixtas === false;
}

/** Fila con base gravada fuera de DNG (DG o DGNG ≠ 0) de un proveedor sin regla activa, en modo estándar → DNG. */
export function evaluarEstandar(fila: FilaInterna, ctx: ContextoInterno): Hallazgo | null {
  if (!ctx.modoEstandar || ctx.conRegla.has(fila.proveedor.clave)) return null;
  const biDg = fila.montos.obtener("biDg");
  const biDgng = fila.montos.obtener("biDgng");
  if (biDg.esCero() && biDgng.esCero()) return null;
  return crearHallazgo({
    filaId: fila.id,
    regla: "R-STD",
    destino: "DNG",
    explicacion: MODO_ESTANDAR,
    sugerencia: { tipo: "clasificar" },
    requiereConfirmacion: false,
    dato: null,
    lecturas: { biDg, igvDg: fila.montos.obtener("igvDg"), biDgng, igvDgng: fila.montos.obtener("igvDgng") },
  });
}
