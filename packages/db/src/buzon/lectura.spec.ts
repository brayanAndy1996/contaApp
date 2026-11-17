// Spec 023 (T4, rojo): lectura del buzon sin BD (D-8). Las filas llegan como las entrega `pg`: snake_case con los alias de las
// columnas (contenido_obtenido = contenido_ruta IS NOT NULL), fechas Date y bytea Buffer; bigint como texto.
import { describe, expect, it } from "vitest";
import { errorPg, txFalso } from "../trabajos/soporte-prueba";
import { BuzonRepoError } from "./errores";
import {
  leerAdjuntoBuzon,
  leerEstadoBuzon,
  leerMensajeBuzon,
  listarMensajesBuzon,
} from "./lectura";

const C = "0190a000-0000-7000-8000-0000000000c1";
const M = "0190a000-0000-7000-8000-0000000000b1";
const A = "0190a000-0000-7000-8000-0000000000a1";
const FECHA = new Date("2026-11-10T15:30:00Z");

const FILA = {
  id: M,
  asunto: "Notificacion de cobranza coactiva",
  remitente: "SUNAT",
  fecha: FECHA,
  categoria: "coactiva",
  critico: true,
  motivo_critico: "codigo",
  leido_sunat: false,
  contenido_obtenido: false,
  adjuntos_declarados: 2,
};
const FILA_VISTA = {
  id: M,
  asunto: "Notificacion de cobranza coactiva",
  remitente: "SUNAT",
  fecha: FECHA,
  categoria: "coactiva",
  critico: true,
  motivoCritico: "codigo",
  leidoEnSunat: false,
  contenidoObtenido: false,
  adjuntosDeclarados: 2,
};

describe("leerEstadoBuzon", () => {
  it("devuelve el estado del cliente en camelCase", async () => {
    const f = new Date("2026-11-17T06:00:00Z");
    const { tx, llamadas } = txFalso({
      rows: [
        {
          ultima_programada_en: f,
          ultima_solicitud_en: null,
          ultima_captura_en: f,
          sincronizado_en: f,
          cursor_pendiente: "pagina-2",
        },
      ],
    });
    expect(await leerEstadoBuzon(tx, C)).toEqual({
      ultimaProgramadaEn: f,
      ultimaSolicitudEn: null,
      ultimaCapturaEn: f,
      sincronizadoEn: f,
      cursorPendiente: "pagina-2",
    });
    expect(llamadas[0]!.texto).toMatch(/buzon_estado_cliente/);
    expect(llamadas[0]!.valores).toContain(C);
  });

  it("un cliente sin estado (nunca capturado) devuelve null", async () => {
    expect(await leerEstadoBuzon(txFalso({ rows: [] }).tx, C)).toBeNull();
  });
});

describe("listarMensajesBuzon", () => {
  it("lista del mas reciente al mas antiguo (fecha desc, id desc) del cliente y mapea la fila", async () => {
    const { tx, llamadas } = txFalso({ rows: [FILA] });
    expect(await listarMensajesBuzon(tx, C, { limite: 25 })).toEqual([
      FILA_VISTA,
    ]);
    expect(llamadas[0]!.texto).toMatch(/from buzon_mensaje/i);
    expect(llamadas[0]!.texto).toMatch(/order by[^;]*fecha desc[^;]*id desc/i);
    expect(llamadas[0]!.valores).toContain(C);
  });

  it("el cursor (fecha, id) y el limite viajan como parametros, nunca en el texto", async () => {
    const { tx, llamadas } = txFalso({ rows: [] });
    await listarMensajesBuzon(tx, C, {
      antes: { fecha: FECHA, id: M },
      limite: 10,
    });
    expect(llamadas[0]!.valores).toEqual(expect.arrayContaining([C, FECHA, M]));
    expect(llamadas[0]!.texto).not.toContain(M);
  });

  it("el limite se acota a 100 (un limite de 500 no llega a la consulta)", async () => {
    const { tx, llamadas } = txFalso({ rows: [] });
    await listarMensajesBuzon(tx, C, { limite: 500 });
    expect(llamadas[0]!.valores).not.toContain(500);
  });

  it("no pide el contenido ni la ruta del contenido: solo si ya se obtuvo (booleano)", async () => {
    const { tx, llamadas } = txFalso({ rows: [] });
    await listarMensajesBuzon(tx, C, {});
    expect(llamadas[0]!.texto).toMatch(/contenido_obtenido/);
  });

  it("un error de pg sale como BuzonRepoError con solo el SQLSTATE", async () => {
    const e = await listarMensajesBuzon(
      txFalso(errorPg("42501")).tx,
      C,
      {},
    ).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BuzonRepoError);
    expect((e as BuzonRepoError).codigo).toBe("42501");
    expect(JSON.stringify(e) + (e as Error).message).not.toContain("CANARIO");
  });
});

describe("leerMensajeBuzon", () => {
  const SHA = Buffer.alloc(32, 0xab);
  const ADJ = {
    id: A,
    id_sunat: "ADJ-1",
    nombre: "factura.pdf",
    mime: "application/pdf",
    tamano: "20480",
    sha256: SHA,
    ruta: `buzon/t/c/${A}.pdf`,
    omitido: null,
  };
  const OMITIDO = {
    id: M,
    id_sunat: "ADJ-2",
    nombre: "grande.zip",
    mime: null,
    tamano: null,
    sha256: null,
    ruta: null,
    omitido: "tamano",
  };

  it("devuelve el mensaje con su ruta de contenido y sus adjuntos (sha256 en hex, tamano numerico, omitidos sin ruta)", async () => {
    const { tx, llamadas } = txFalso(
      {
        rows: [
          {
            ...FILA,
            contenido_obtenido: true,
            contenido_ruta: "buzon/t/c/x.txt",
          },
        ],
      },
      { rows: [ADJ, OMITIDO] },
    );
    const r = await leerMensajeBuzon(tx, C, M);
    expect(r).toMatchObject({
      ...FILA_VISTA,
      contenidoObtenido: true,
      contenidoRuta: "buzon/t/c/x.txt",
    });
    expect(r!.adjuntos).toEqual([
      {
        id: A,
        idSunat: "ADJ-1",
        nombre: "factura.pdf",
        mime: "application/pdf",
        tamano: 20480,
        sha256: "ab".repeat(32),
        ruta: `buzon/t/c/${A}.pdf`,
        omitido: null,
      },
      {
        id: M,
        idSunat: "ADJ-2",
        nombre: "grande.zip",
        mime: null,
        tamano: null,
        sha256: null,
        ruta: null,
        omitido: "tamano",
      },
    ]);
    expect(llamadas[0]!.valores).toEqual(expect.arrayContaining([C, M]));
  });

  it("un mensaje que no es del cliente o no existe devuelve null y no consulta los adjuntos", async () => {
    const { tx, llamadas } = txFalso({ rows: [] });
    expect(await leerMensajeBuzon(tx, C, M)).toBeNull();
    expect(llamadas).toHaveLength(1);
  });
});

describe("leerAdjuntoBuzon", () => {
  it("busca por cliente, mensaje y adjunto a la vez (ids cruzados no devuelven nada)", async () => {
    const { tx, llamadas } = txFalso({
      rows: [
        {
          id: A,
          id_sunat: "ADJ-1",
          nombre: "f.pdf",
          mime: "application/pdf",
          tamano: 5,
          sha256: Buffer.alloc(32, 1),
          ruta: "buzon/t/c/a.pdf",
          omitido: null,
        },
      ],
    });
    const r = await leerAdjuntoBuzon(tx, C, M, A);
    expect(r).toMatchObject({
      id: A,
      ruta: "buzon/t/c/a.pdf",
      mime: "application/pdf",
      omitido: null,
    });
    expect(llamadas[0]!.valores).toEqual(expect.arrayContaining([C, M, A]));
  });

  it("sin fila devuelve null", async () => {
    expect(
      await leerAdjuntoBuzon(txFalso({ rows: [] }).tx, C, M, A),
    ).toBeNull();
  });
});
