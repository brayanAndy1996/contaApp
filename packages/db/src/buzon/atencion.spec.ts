// Spec 024 (T3, rojo): el repositorio de la atención llama a la función acotada `buzon_atencion_aplicar` (0060) y traduce su resultado
// y sus errores (D-5, D-6, D-7, U-1). Sin BD (tx falsa): el comportamiento de la función contra la BD real está en
// tests/aislamiento/buzon-atencion-*.spec.ts. El repositorio no escribe nada por su cuenta: toda marca y todo deshacer pasan por la función.
//
// CONTRATO que fijan estas pruebas (lo implementa T7 en `packages/db/src/buzon/atencion.ts`, con la `tx` de withTenant):
//   aplicarAtencionBuzon(tx, { accion: "marcar" | "deshacer", mensajes: string[], clienteId?: string, comentario?: string | null })
//     -> { mensajeId, aplicado, atendidoPor: string | null, atendidoEn: Date | null }[]   (una fila por mensaje, en el orden de la función)
//   - ejecuta UNA sola sentencia: `select … from buzon_atencion_aplicar($1, $2, $3, $4)` con los parámetros
//     [clienteId | null, mensajes, accion, comentario | null] (p_cliente, p_mensajes, p_accion, p_comentario); nada va en el texto;
//   - `clienteId` ausente = lote (p_cliente NULL); `comentario` ausente o undefined = NULL;
//   - `aplicado = false` NO es un error: vuelve como dato (el servicio lo convierte en 409 `atencion_cambiada` u «omitido»);
//   - todo error de la función sale como BuzonRepoError con solo el SQLSTATE: P0002 (id inexistente, de otro estudio o de otro
//     cliente), 55000 (cliente archivado, U-1), 22004 (crítico sin comentario), 22023 (parámetros inválidos), 42501, 40P01, 40001.
import { describe, expect, it, vi } from "vitest";
import * as db from "../index";
import { errorPg, txFalso } from "../trabajos/soporte-prueba";
import { aplicarAtencionBuzon } from "./atencion";
import { BuzonRepoError } from "./errores";

const C = "0190a000-0000-7000-8000-0000000000c1";
const M1 = "0190a000-0000-7000-8000-0000000000b1";
const M2 = "0190a000-0000-7000-8000-0000000000b2";
const U = "0190a000-0000-7000-8000-0000000000d1";
const EN = new Date("2026-11-19T15:00:00.000Z");
const CANARIO = "CANARIO-COMENTARIO-ATENCION";

const fila = (
  mensajeId: string,
  aplicado: boolean,
  por: string | null = U,
  en: Date | null = EN,
) => ({
  mensaje_id: mensajeId,
  aplicado,
  atendido_por: por,
  atendido_en: en,
});

describe("aplicarAtencionBuzon: la llamada a la función acotada", () => {
  it("marcar en la ruta individual: una sola sentencia a buzon_atencion_aplicar con [cliente, mensajes, acción, comentario]", async () => {
    const { tx, llamadas } = txFalso({ rows: [fila(M1, true)] });
    await aplicarAtencionBuzon(tx, {
      accion: "marcar",
      clienteId: C,
      mensajes: [M1],
      comentario: "Se presentó el escrito",
    });
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]!.texto).toMatch(/buzon_atencion_aplicar\s*\(/i);
    expect(llamadas[0]!.valores).toEqual([
      C,
      [M1],
      "marcar",
      "Se presentó el escrito",
    ]);
  });

  it("deshacer viaja como 'deshacer' y sin comentario manda NULL", async () => {
    const { tx, llamadas } = txFalso({ rows: [fila(M1, true, null, null)] });
    await aplicarAtencionBuzon(tx, {
      accion: "deshacer",
      clienteId: C,
      mensajes: [M1],
    });
    expect(llamadas[0]!.valores).toEqual([C, [M1], "deshacer", null]);
  });

  it("el lote no manda cliente (p_cliente NULL) y pasa todos los ids como un solo arreglo en el orden pedido", async () => {
    const { tx, llamadas } = txFalso({
      rows: [fila(M2, true), fila(M1, true)],
    });
    await aplicarAtencionBuzon(tx, {
      accion: "marcar",
      mensajes: [M2, M1],
      comentario: "Lote revisado",
    });
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]!.valores).toEqual([
      null,
      [M2, M1],
      "marcar",
      "Lote revisado",
    ]);
  });

  it("un comentario null explícito también manda NULL", async () => {
    const { tx, llamadas } = txFalso({ rows: [fila(M1, true)] });
    await aplicarAtencionBuzon(tx, {
      accion: "marcar",
      clienteId: C,
      mensajes: [M1],
      comentario: null,
    });
    expect(llamadas[0]!.valores[3]).toBeNull();
  });

  it("ningún valor va en el texto de la sentencia: ni ids ni comentario (ni el contenido de un comentario con SQL o HTML)", async () => {
    const malo = `'); drop table buzon_mensaje; -- <img src=x onerror=alert(1)> ${CANARIO}`;
    const { tx, llamadas } = txFalso({ rows: [fila(M1, true)] });
    await aplicarAtencionBuzon(tx, {
      accion: "marcar",
      clienteId: C,
      mensajes: [M1],
      comentario: malo,
    });
    const texto = llamadas[0]!.texto;
    for (const v of [C, M1, "marcar", malo, CANARIO])
      expect(texto).not.toContain(v);
    expect(llamadas[0]!.valores).toContain(malo);
  });

  it("solo llama a la función: no inserta ni actualiza ni borra por su cuenta (D-5)", async () => {
    const { tx, llamadas } = txFalso({ rows: [fila(M1, true)] });
    await aplicarAtencionBuzon(tx, {
      accion: "marcar",
      clienteId: C,
      mensajes: [M1],
    });
    expect(llamadas[0]!.texto).not.toMatch(/\b(insert|update|delete)\b/i);
    expect(llamadas[0]!.texto).not.toMatch(
      /\bnotificacion\b|\bjob_registro\b|\bbuzon_estado_cliente\b/i,
    );
  });
});

describe("aplicarAtencionBuzon: el resultado", () => {
  it("una fila por mensaje, en camelCase, con quién y cuándo (Date)", async () => {
    const { tx } = txFalso({ rows: [fila(M1, true), fila(M2, false, U, EN)] });
    const r = await aplicarAtencionBuzon(tx, {
      accion: "marcar",
      mensajes: [M1, M2],
    });
    expect(r).toEqual([
      { mensajeId: M1, aplicado: true, atendidoPor: U, atendidoEn: EN },
      { mensajeId: M2, aplicado: false, atendidoPor: U, atendidoEn: EN },
    ]);
  });

  it("aplicado = false NO es un error: vuelve como dato con el estado vigente (para el 409 `atencion_cambiada` u «omitido»)", async () => {
    const { tx } = txFalso({ rows: [fila(M1, false, U, EN)] });
    const r = await aplicarAtencionBuzon(tx, {
      accion: "marcar",
      clienteId: C,
      mensajes: [M1],
    });
    expect(r).toHaveLength(1);
    expect(r[0]!.aplicado).toBe(false);
    expect(r[0]!.atendidoPor).toBe(U);
    expect(r[0]!.atendidoEn).toEqual(EN);
  });

  it("al deshacer, el estado vigente sin atender trae atendidoPor y atendidoEn nulos", async () => {
    const { tx } = txFalso({ rows: [fila(M1, true, null, null)] });
    const [r] = await aplicarAtencionBuzon(tx, {
      accion: "deshacer",
      clienteId: C,
      mensajes: [M1],
    });
    expect(r).toEqual({
      mensajeId: M1,
      aplicado: true,
      atendidoPor: null,
      atendidoEn: null,
    });
  });

  it("una fecha que llega como texto se entrega como Date", async () => {
    const { tx } = txFalso({
      rows: [fila(M1, true, U, "2026-11-19T15:00:00.000Z" as unknown as Date)],
    });
    const [r] = await aplicarAtencionBuzon(tx, {
      accion: "marcar",
      clienteId: C,
      mensajes: [M1],
    });
    expect(r!.atendidoEn).toBeInstanceOf(Date);
    expect(r!.atendidoEn!.getTime()).toBe(EN.getTime());
  });
});

describe("aplicarAtencionBuzon: errores de la función", () => {
  it.each([
    ["P0002", "mensaje inexistente, de otro estudio o de otro cliente"],
    ["55000", "cliente archivado (U-1)"],
    ["22004", "crítico sin comentario"],
    ["22023", "parámetros inválidos"],
    ["42501", "sin estudio, sin usuario o miembro desactivado"],
    ["40P01", "interbloqueo (el servicio reintenta una vez)"],
    ["40001", "fallo de serialización (el servicio reintenta una vez)"],
  ])(
    "%s (%s) sale como BuzonRepoError con solo el SQLSTATE",
    async (codigo) => {
      const { tx } = txFalso(errorPg(codigo, CANARIO));
      const e = await aplicarAtencionBuzon(tx, {
        accion: "marcar",
        clienteId: C,
        mensajes: [M1],
        comentario: CANARIO,
      }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(BuzonRepoError);
      expect((e as BuzonRepoError).codigo).toBe(codigo);
      const rastro =
        JSON.stringify(e) +
        (e as Error).message +
        String((e as Error).stack) +
        String((e as { cause?: unknown }).cause);
      expect(rastro).not.toContain(CANARIO);
      expect(rastro).not.toMatch(/job_registro|constraint|Failing row/);
    },
  );

  it("un error sin SQLSTATE sale como «desconocido» sin rastro del original", async () => {
    const { tx } = txFalso(errorPg(undefined, CANARIO));
    const e = await aplicarAtencionBuzon(tx, {
      accion: "deshacer",
      clienteId: C,
      mensajes: [M1],
    }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BuzonRepoError);
    expect((e as BuzonRepoError).codigo).toBe("desconocido");
    expect(JSON.stringify(e) + (e as Error).message).not.toContain(CANARIO);
  });

  it("no registra nada en consola (ni el comentario ni los ids), ni con éxito ni con error", async () => {
    const espias = (["log", "info", "warn", "error", "debug"] as const).map(
      (n) => vi.spyOn(console, n).mockImplementation(() => undefined),
    );
    try {
      await aplicarAtencionBuzon(txFalso({ rows: [fila(M1, true)] }).tx, {
        accion: "marcar",
        clienteId: C,
        mensajes: [M1],
        comentario: CANARIO,
      });
      await aplicarAtencionBuzon(txFalso(errorPg("55000", CANARIO)).tx, {
        accion: "marcar",
        clienteId: C,
        mensajes: [M1],
        comentario: CANARIO,
      }).catch(() => undefined);
      for (const e of espias) expect(e).not.toHaveBeenCalled();
    } finally {
      for (const e of espias) e.mockRestore();
    }
  });
});

describe("exportes de @contapp/db para la bandeja (T8 los consume)", () => {
  it.each([
    "listarBandeja",
    "detalleAtencion",
    "indicadorBuzon",
    "aplicarAtencionBuzon",
  ])("exporta %s", (nombre) => {
    expect(typeof (db as Record<string, unknown>)[nombre], nombre).toBe(
      "function",
    );
  });
});
