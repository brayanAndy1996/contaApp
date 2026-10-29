// Soporte de las pruebas unitarias de `trabajos` (spec 008, T3): una `tx` falsa que responde en orden y registra las
// consultas. No es codigo de produccion ni una prueba (sin sufijo .spec). Sin BD.
export interface Llamada {
  texto: string;
  valores: unknown[];
}

export type Respuesta =
  { rows?: Record<string, unknown>[]; rowCount?: number | null } | Error;

/** `tx` falsa: cada query consume la siguiente respuesta (la ultima se repite); un Error se lanza tal cual. */
export function txFalso(...respuestas: Respuesta[]) {
  const llamadas: Llamada[] = [];
  let i = 0;
  const tx = {
    query: async (texto: string, valores: unknown[] = []) => {
      llamadas.push({ texto, valores });
      const r = respuestas[Math.min(i++, respuestas.length - 1)] ?? {
        rows: [],
        rowCount: 0,
      };
      if (r instanceof Error) throw r;
      const rows = r.rows ?? [];
      return { rows, rowCount: r.rowCount ?? rows.length };
    },
  };
  return { tx: tx as never, llamadas };
}

/** Error como el de `pg`: con SQLSTATE y datos que NO deben filtrarse. */
export function errorPg(code: string | undefined, canario = "CANARIO-SOL-123") {
  return Object.assign(new Error(`falla con ${canario}`), {
    code,
    detail: `Failing row contains (${canario})`,
    constraint: "job_registro_tipo_valido",
    table: "job_registro",
    column: "parametros",
    where: canario,
  });
}

/** Fila de job_registro tal como la entrega `pg` (snake_case; fechas Date; bytea Buffer). */
export const FILA = {
  id: "00000000-0000-4000-8000-0000000000a1",
  tenant_id: "00000000-0000-4000-8000-0000000000b1",
  cliente_id: "00000000-0000-4000-8000-0000000000c1",
  ruc: "20123456789",
  tipo: "prueba.eco",
  cola: "sire",
  canal: "sire",
  prioridad: "interactivo",
  estado: "en_cola",
  parametros: { n: 1 },
  clave_dedupe: Buffer.alloc(32, 7),
  creado_por: "00000000-0000-4000-8000-0000000000d1",
  intentos: 0,
  max_intentos: 3,
  motivo: null,
  resultado: null,
  disponible_desde: new Date("2026-10-27T10:00:00Z"),
  creado_en: new Date("2026-10-27T09:59:00Z"),
  iniciado_en: null,
  terminado_en: null,
  actualizado_en: new Date("2026-10-27T09:59:00Z"),
};
