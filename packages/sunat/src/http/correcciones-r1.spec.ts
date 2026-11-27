/**
 * Spec 041 · T12 · Variantes de los hallazgos de la ronda adversarial 1 (H-041-1-1 a H-041-1-3) que
 * `ronda1.adv.spec.ts` no recorre: parte repetida con otra mayúscula, `expires_in` fuera de rango y espacios Unicode
 * en celdas numéricas de compras.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ErrorDatosSire, ErrorPortalSire, HttpSireApiClient, HttpSireAuth, type TokenSire } from "../index.js";
import {
  CANARIOS,
  PERIODO,
  RUC,
  RUTAS,
  credencial,
  crearEntorno,
  cuerpoToken,
  fixture,
  guionarFlujo,
  relojVirtual,
  zip,
  type EntornoFalso,
  type RelojVirtual,
} from "./pruebas/ayudas-http.js";
import { conCelda } from "./pruebas/ayudas-txt.js";
import { celda, fecha, monto, tipoCambio } from "./txt/valores.js";

const TOKEN: TokenSire = { token: CANARIOS.token, expiraEn: new Date("2026-11-27T16:00:00.000Z") };
const TXT_C = "20700000002-20261101-1030-propuesta.txt";

let ent: EntornoFalso;
let reloj: RelojVirtual;
beforeEach(async () => {
  ent = await crearEntorno();
  reloj = relojVirtual();
});
afterEach(async () => {
  await ent.cerrar();
});

describe("H-041-1-1 · parte repetida en archivoReporte", () => {
  it("la misma parte con otra mayúscula -> ErrorPortalSire respuesta_inesperada sin descargar", async () => {
    const z = zip(TXT_C, fixture("compras-propuesta-202610.txt"));
    guionarFlujo(ent.sire, { libro: "compras", numTicket: "202610000001", partes: [{ nombre: "P1.zip", zip: z }, { nombre: "p1.zip", zip: z }] });
    const c = new HttpSireApiClient({ urlsDePrueba: ent.urlsDePrueba, ahora: reloj.ahora, dormir: reloj.dormir });
    const e = await c.descargarPropuesta(TOKEN, { ruc: RUC, periodo: PERIODO, libro: "compras" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ErrorPortalSire);
    expect((e as ErrorPortalSire).detalle).toBe("respuesta_inesperada");
    expect(ent.sire.peticionesDe("GET", RUTAS.archivo)).toHaveLength(0);
  });

  it("dos partes distintas siguen descargándose (control)", async () => {
    guionarFlujo(ent.sire, {
      libro: "compras",
      numTicket: "202610000001",
      partes: [
        { nombre: "p1.zip", zip: zip(TXT_C, fixture("compras-propuesta-202610-parte1.txt")) },
        { nombre: "p2.zip", zip: zip(TXT_C, fixture("compras-propuesta-202610-parte2.txt")) },
      ],
    });
    const c = new HttpSireApiClient({ urlsDePrueba: ent.urlsDePrueba, ahora: reloj.ahora, dormir: reloj.dormir });
    const r = await c.descargarPropuesta(TOKEN, { ruc: RUC, periodo: PERIODO, libro: "compras" });
    expect(r.filas.length).toBeGreaterThan(0);
    expect(ent.sire.peticionesDe("GET", RUTAS.archivo)).toHaveLength(2);
  });
});

describe("H-041-1-2 · expires_in del token", () => {
  const auth = () => new HttpSireAuth({ urlsDePrueba: ent.urlsDePrueba, ahora: reloj.ahora, dormir: reloj.dormir });

  it("0, no entero, sobre el tope, Infinity/NaN (llegan como null) -> ErrorPortalSire", async () => {
    const fallos: string[] = [];
    for (const v of [0, -1, 1.5, 86_401, Number.MAX_SAFE_INTEGER, Infinity, NaN, "1e3", true]) {
      ent.seguridad.reiniciar();
      ent.seguridad.guionar("POST", RUTAS.token(), { json: cuerpoToken({ expires_in: v }) });
      const e = await auth().obtenerToken(credencial()).catch((x: unknown) => x);
      if (!(e instanceof ErrorPortalSire)) fallos.push(String(v));
    }
    expect(fallos).toEqual([]);
  });

  it("el tope (86400 s) se acepta con fecha válida", async () => {
    ent.seguridad.guionar("POST", RUTAS.token(), { json: cuerpoToken({ expires_in: 86_400 }) });
    const t = await auth().obtenerToken(credencial());
    expect(t.expiraEn.getTime()).toBe(reloj.ahora().getTime() + 86_400_000);
  });
});

describe("H-041-1-3 · celdas numéricas solo ASCII", () => {
  const espacios = [" ", " ", " ", "　", "﻿", "​"];

  it("celda recorta solo espacios y tabuladores ASCII", () => {
    expect(celda([" \t500 \t"], 0)).toBe("500");
    expect(celda(["500 "], 0)).toBe("500 ");
  });

  it("monto, tipo de cambio y fecha con espacio Unicode -> fila_invalida", () => {
    const fallos: string[] = [];
    for (const s of espacios) {
      for (const [n, fn] of [
        ["monto", () => monto(celda([`500${s}`], 0), "PEN")],
        ["monto izq", () => monto(celda([`${s}500`], 0), "PEN")],
        ["tipoCambio", () => tipoCambio(celda([`3.300${s}`], 0))],
        ["fecha", () => fecha(celda([`05/10/2026${s}`], 0))],
      ] as const) {
        try {
          fn();
          fallos.push(`${n} ${JSON.stringify(s)}`);
        } catch (e) {
          if (!(e instanceof ErrorDatosSire) || e.detalle !== "fila_invalida") fallos.push(`${n} ${JSON.stringify(s)}`);
        }
      }
    }
    expect(fallos).toEqual([]);
    expect(monto(celda([" 500 "], 0), "PEN")).toBe("500.00");
  });

  it("compras: NBSP en un monto o en el Periodo -> ErrorDatosSire", async () => {
    const c = new HttpSireApiClient({ urlsDePrueba: ent.urlsDePrueba, ahora: reloj.ahora, dormir: reloj.dormir });
    const fallos: string[] = [];
    for (const [col, v, detalle] of [
      ["BI Gravado DG", "100.00 ", "fila_invalida"],
      ["Periodo", `${PERIODO} `, "respuesta_ajena"],
    ] as const) {
      ent.sire.reiniciar();
      const txt = conCelda(fixture("compras-propuesta-202610.txt"), 1, col, v);
      guionarFlujo(ent.sire, { libro: "compras", numTicket: "202610000001", partes: [{ nombre: "p1.zip", zip: zip(TXT_C, txt) }] });
      const e = await c.descargarPropuesta(TOKEN, { ruc: RUC, periodo: PERIODO, libro: "compras" }).catch((x: unknown) => x);
      if (!(e instanceof ErrorDatosSire) || e.detalle !== detalle) fallos.push(col);
    }
    expect(fallos).toEqual([]);
  });
});
