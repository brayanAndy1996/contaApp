// Spec 023 (T4, rojo): escritura del worker y auditoria del backend sin BD. Contrato: tests/aislamiento/buzon-soporte.ts.
// El estudio sale de app.tenant_id (default de tenant_id); ningun valor de la fila viaja en el texto SQL.
import { describe, expect, it } from "vitest";
import { errorPg, txFalso } from "../trabajos/soporte-prueba";
import { BuzonRepoError } from "./errores";
import {
  actualizarConocidosBuzon,
  auditarBuzon,
  conocidosBuzon,
  guardarContenidoBuzon,
  guardarEstadoCapturaBuzon,
  insertarMensajeBuzon,
} from "./escritura";

const C = "0190a000-0000-7000-8000-0000000000c1";
const M = "0190a000-0000-7000-8000-0000000000b1";
const A = "0190a000-0000-7000-8000-0000000000a1";
const FECHA = new Date("2026-11-10T15:30:00Z");
const ENTRADA = {
  clienteId: C,
  idSunat: "SUNAT-77",
  asunto: "ASUNTO-CANARIO-77",
  remitente: "SUNAT",
  fecha: FECHA,
  codigoTipo: "COA",
  categoria: "coactiva",
  critico: true,
  motivoCritico: "codigo" as const,
  versionCatalogo: 1,
  avisado: true,
  leidoEnSunat: false,
  adjuntosDeclarados: 1,
};

describe("insertarMensajeBuzon", () => {
  it("inserta con ON CONFLICT DO NOTHING y devuelve el id; los valores viajan como parametros", async () => {
    const { tx, llamadas } = txFalso({ rows: [{ id: M }] });
    expect(await insertarMensajeBuzon(tx, ENTRADA)).toEqual({ id: M });
    const { texto, valores } = llamadas[0]!;
    expect(texto).toMatch(/insert into buzon_mensaje/i);
    expect(texto).toMatch(/on conflict[^;]*do nothing/i);
    expect(texto).toMatch(/returning[^;]*id/i);
    expect(texto).not.toContain(ENTRADA.asunto);
    expect(valores).toEqual(
      expect.arrayContaining([
        C,
        "SUNAT-77",
        ENTRADA.asunto,
        "SUNAT",
        FECHA,
        "COA",
        "coactiva",
        true,
        "codigo",
        1,
        false,
        1,
      ]),
    );
  });

  it("si otra captura ya lo inserto (sin fila) devuelve null: no se avisa dos veces", async () => {
    expect(
      await insertarMensajeBuzon(txFalso({ rows: [] }).tx, ENTRADA),
    ).toBeNull();
  });

  it("un rechazo del trigger de aviso (42501) sale como BuzonRepoError con solo el SQLSTATE", async () => {
    const e = await insertarMensajeBuzon(
      txFalso(errorPg("42501")).tx,
      ENTRADA,
    ).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BuzonRepoError);
    expect((e as BuzonRepoError).codigo).toBe("42501");
    expect(JSON.stringify(e) + (e as Error).message).not.toContain("CANARIO");
  });
});

describe("conocidosBuzon", () => {
  it("devuelve un Map por id de SUNAT con el id y si SUNAT lo tenia leido", async () => {
    const { tx, llamadas } = txFalso({
      rows: [
        { id: M, id_sunat: "S-1", leido_sunat: true },
        { id: A, id_sunat: "S-2", leido_sunat: false },
      ],
    });
    const r = await conocidosBuzon(tx, C, ["S-1", "S-2", "S-3"]);
    expect(r.get("S-1")).toEqual({ id: M, leidoEnSunat: true });
    expect(r.get("S-2")).toEqual({ id: A, leidoEnSunat: false });
    expect(r.has("S-3")).toBe(false);
    expect(llamadas[0]!.valores).toEqual(
      expect.arrayContaining([C, ["S-1", "S-2", "S-3"]]),
    );
  });

  it("sin ids no consulta", async () => {
    const { tx, llamadas } = txFalso({ rows: [] });
    expect((await conocidosBuzon(tx, C, [])).size).toBe(0);
    expect(llamadas).toHaveLength(0);
  });
});

describe("actualizarConocidosBuzon", () => {
  it("actualiza leido_sunat y ultima_captura_en en una sola sentencia y devuelve cuantos cambio", async () => {
    const { tx, llamadas } = txFalso({ rows: [], rowCount: 2 });
    expect(
      await actualizarConocidosBuzon(tx, C, [
        { idSunat: "S-1", leidoEnSunat: true },
        { idSunat: "S-2", leidoEnSunat: false },
      ]),
    ).toBe(2);
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]!.texto).toMatch(/update buzon_mensaje/i);
    expect(llamadas[0]!.texto).toMatch(/leido_sunat/);
    expect(llamadas[0]!.texto).toMatch(/ultima_captura_en/);
    expect(llamadas[0]!.texto).not.toMatch(/categoria|critico|avisado|asunto/);
  });

  it("sin items no consulta y devuelve 0", async () => {
    const { tx, llamadas } = txFalso({ rows: [] });
    expect(await actualizarConocidosBuzon(tx, C, [])).toBe(0);
    expect(llamadas).toHaveLength(0);
  });
});

describe("guardarEstadoCapturaBuzon", () => {
  it("hace upsert del estado con el cursor pendiente y sincronizado_en solo al sincronizar", async () => {
    const { tx, llamadas } = txFalso({ rows: [] });
    await guardarEstadoCapturaBuzon(tx, C, {
      cursorPendiente: "pagina-4",
      sincronizado: false,
    });
    expect(llamadas[0]!.texto).toMatch(/buzon_estado_cliente/);
    expect(llamadas[0]!.texto).toMatch(/on conflict/i);
    expect(llamadas[0]!.texto).toMatch(/ultima_captura_en/);
    expect(llamadas[0]!.valores).toEqual(
      expect.arrayContaining([C, "pagina-4"]),
    );
    expect(llamadas[0]!.texto).not.toMatch(
      /ultima_programada_en|ultima_solicitud_en/,
    );
  });

  it("un error de pg sale como BuzonRepoError", async () => {
    const e = await guardarEstadoCapturaBuzon(txFalso(errorPg("23503")).tx, C, {
      cursorPendiente: null,
      sincronizado: true,
    }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BuzonRepoError);
    expect((e as BuzonRepoError).codigo).toBe("23503");
  });
});

describe("guardarContenidoBuzon", () => {
  const RUTA = `buzon/t/${C}/${A}.txt`;
  const base = {
    clienteId: C,
    mensajeId: M,
    contenidoRuta: RUTA,
    contenidoBytes: 321,
    marcoLeido: true,
  };
  const adjunto = (n: number) => ({
    idSunat: `ADJ-${n}`,
    nombre: `f${n}.pdf`,
    mime: "application/pdf",
    tamano: 100 + n,
    sha256: new Uint8Array(32).fill(n),
    ruta: `buzon/t/${C}/${A}-${n}.pdf`,
    omitido: null,
  });

  it("inserta los adjuntos (ON CONFLICT DO NOTHING) ANTES de fijar contenido_ruta: el trigger de auditoria cuenta lo ya guardado", async () => {
    const omitido = {
      idSunat: "ADJ-9",
      nombre: "enorme.zip",
      mime: null,
      tamano: null,
      sha256: null,
      ruta: null,
      omitido: "tamano" as const,
    };
    const { tx, llamadas } = txFalso({ rows: [], rowCount: 1 });
    await guardarContenidoBuzon(tx, {
      ...base,
      adjuntos: [adjunto(1), adjunto(2), omitido],
    });
    const textos = llamadas.map((l) => l.texto);
    const iUpdate = textos.findIndex((t) => /update buzon_mensaje/i.test(t));
    expect(iUpdate).toBe(textos.length - 1);
    const inserts = textos.filter((t) => /insert into buzon_adjunto/i.test(t));
    expect(inserts.length).toBeGreaterThanOrEqual(1);
    for (const t of inserts) expect(t).toMatch(/on conflict[^;]*do nothing/i);
    expect(llamadas[iUpdate]!.valores).toEqual(
      expect.arrayContaining([M, RUTA, 321]),
    );
    expect(llamadas[iUpdate]!.texto).toMatch(/contenido_ruta/);
    expect(llamadas[iUpdate]!.texto).toMatch(/leido_sunat/);
  });

  it("la ruta, el nombre y los hashes viajan como parametros, nunca en el texto", async () => {
    const { tx, llamadas } = txFalso({ rows: [], rowCount: 1 });
    await guardarContenidoBuzon(tx, { ...base, adjuntos: [adjunto(1)] });
    for (const l of llamadas) {
      expect(l.texto).not.toContain(RUTA);
      expect(l.texto).not.toContain("f1.pdf");
    }
  });

  it("sin adjuntos solo fija el contenido; marcoLeido = false no toca leido_sunat", async () => {
    const { tx, llamadas } = txFalso({ rows: [], rowCount: 1 });
    await guardarContenidoBuzon(tx, {
      ...base,
      marcoLeido: false,
      adjuntos: [],
    });
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]!.texto).toMatch(/update buzon_mensaje/i);
    expect(llamadas[0]!.valores).not.toContain(true);
  });

  it("un error de pg sale como BuzonRepoError con solo el SQLSTATE", async () => {
    const e = await guardarContenidoBuzon(txFalso(errorPg("42501")).tx, {
      ...base,
      adjuntos: [],
    }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BuzonRepoError);
    expect((e as BuzonRepoError).codigo).toBe("42501");
    expect(JSON.stringify(e) + (e as Error).message).not.toContain("CANARIO");
  });
});

describe("auditarBuzon", () => {
  it("llama a buzon_auditar(accion, cliente, mensaje, adjunto) con parametros tipados", async () => {
    const { tx, llamadas } = txFalso({ rows: [{ buzon_auditar: null }] });
    await auditarBuzon(tx, "buzon.adjunto_descargado", {
      clienteId: C,
      mensajeId: M,
      adjuntoId: A,
    });
    expect(llamadas[0]!.texto).toMatch(
      /buzon_auditar\(\$1::text, \$2::uuid, \$3::uuid, \$4::uuid\)/,
    );
    expect(llamadas[0]!.valores).toEqual(["buzon.adjunto_descargado", C, M, A]);
  });

  it("mensaje y adjunto omitidos viajan como null", async () => {
    const { tx, llamadas } = txFalso({ rows: [] });
    await auditarBuzon(tx, "buzon.captura_solicitada", { clienteId: C });
    expect(llamadas[0]!.valores).toEqual([
      "buzon.captura_solicitada",
      C,
      null,
      null,
    ]);
  });

  it("un rechazo (23503, 22023) sale como BuzonRepoError", async () => {
    const e = await auditarBuzon(
      txFalso(errorPg("23503")).tx,
      "buzon.contenido_visto",
      { clienteId: C, mensajeId: M },
    ).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BuzonRepoError);
    expect((e as BuzonRepoError).codigo).toBe("23503");
  });
});
