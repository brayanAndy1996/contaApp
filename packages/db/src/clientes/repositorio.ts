/* eslint-disable @typescript-eslint/no-unused-vars */
// STUB (spec 007a T2): lo reemplaza T7. Solo existe para que las pruebas compilen y fallen en rojo.
import type { Alcance } from "../acceso/alcance";
import type { TxConsulta } from "../acceso/errores";

const pendiente = (): never => {
  throw new Error("no implementado (007a T7)");
};
export interface DatosCliente {
  ruc: string;
  razonSocial?: string;
  perfil?: {
    regimen: "rg" | "rmt" | "rer" | "nrus" | null;
    zona: "general" | "amazonia";
    ventasExoneradas: boolean;
    ventasMixtas: boolean;
    monedaHabitual: "PEN" | "USD";
  };
}
export interface FiltrosListado {
  responsable?: string;
  credencial?: "no_configurada" | "configurada" | "verificada" | "invalida";
  archivados?: boolean;
  q?: string;
}
export const crearCliente = async (
  _tx: TxConsulta,
  _tenantId: string,
  _d: DatosCliente,
): Promise<unknown> => pendiente();
export const editarCliente = async (
  _tx: TxConsulta,
  _id: string,
  _d: Pick<DatosCliente, "razonSocial" | "perfil">,
): Promise<unknown> => pendiente();
export const archivarCliente = async (
  _tx: TxConsulta,
  _id: string,
): Promise<unknown> => pendiente();
export const reactivarCliente = async (
  _tx: TxConsulta,
  _id: string,
): Promise<unknown> => pendiente();
export const leerClienteDto = async (
  _tx: TxConsulta,
  _id: string,
): Promise<unknown> => pendiente();
export const listarClientesFiltrado = async (
  _tx: TxConsulta,
  _a: Alcance,
  _f: FiltrosListado,
): Promise<unknown[]> => pendiente();
