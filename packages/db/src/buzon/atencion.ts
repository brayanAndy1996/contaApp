// Atención de mensajes del buzón (spec 024, D-5 a D-7, U-1, U-3). El repositorio no escribe por su cuenta: toda marca y todo
// deshacer pasan por la función acotada `buzon_atencion_aplicar` (0060), que valida estudio, usuario, pertenencia, estado y
// comentario, bloquea en orden de id y deja el evento y la auditoría. `aplicado = false` vuelve como dato (no es error).
import { consultar, type TxConsulta } from "./errores";

export interface EntradaAtencionBuzon {
  accion: "marcar" | "deshacer";
  mensajes: string[];
  /** Ruta individual: el cliente al que deben pertenecer todos los mensajes; sin él (lote) la función recibe NULL. */
  clienteId?: string;
  comentario?: string | null;
}

export interface ResultadoAtencionBuzon {
  mensajeId: string;
  aplicado: boolean;
  atendidoPor: string | null;
  atendidoEn: Date | null;
}

const SQL_APLICAR = `select r.mensaje_id, r.aplicado, r.atendido_por, r.atendido_en
  from public.buzon_atencion_aplicar($1::uuid, $2::uuid[], $3::text, $4::text) r`;

const comoFecha = (v: unknown): Date | null =>
  v === null || v === undefined ? null : v instanceof Date ? v : new Date(String(v));

/** Llama a la función acotada en la tx de withTenant. Errores: BuzonRepoError con solo el SQLSTATE (P0002, 55000, 22004, ...). */
export async function aplicarAtencionBuzon(
  tx: TxConsulta,
  entrada: EntradaAtencionBuzon,
): Promise<ResultadoAtencionBuzon[]> {
  const r = await consultar(tx, SQL_APLICAR, [
    entrada.clienteId ?? null,
    entrada.mensajes,
    entrada.accion,
    entrada.comentario ?? null,
  ]);
  return r.rows.map((f) => ({
    mensajeId: String(f.mensaje_id),
    aplicado: f.aplicado === true,
    atendidoPor: f.atendido_por === null || f.atendido_por === undefined ? null : String(f.atendido_por),
    atendidoEn: comoFecha(f.atendido_en),
  }));
}
