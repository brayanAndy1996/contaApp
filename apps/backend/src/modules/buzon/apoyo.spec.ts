import { describe, expect, it } from "vitest";
import {
  disposicionAdjunta,
  ENFRIAMIENTO_MS,
  esperaDeEnfriamiento,
  mimeSeguro,
  rutaDelCliente,
} from "./apoyo.js";

const T = "0190a000-0000-7000-8000-0000000000a1";
const C = "0190a000-0000-7000-8000-0000000000c1";
const U = "0190a000-0000-7000-8000-0000000000e1";
const ahora = Date.parse("2026-11-17T15:00:00Z");
const estado = (solicitud: number | null, captura: number | null) => ({
  ultimaProgramadaEn: null,
  ultimaSolicitudEn: solicitud === null ? null : new Date(ahora - solicitud * 60_000),
  ultimaCapturaEn: captura === null ? null : new Date(ahora - captura * 60_000),
  sincronizadoEn: null,
  cursorPendiente: null,
});

describe("esperaDeEnfriamiento", () => {
  it("cuenta la más reciente de solicitud y captura, en segundos enteros de 1 a 600", () => {
    expect(esperaDeEnfriamiento(estado(9, null), ahora)).toBe(60);
    expect(esperaDeEnfriamiento(estado(11, 2), ahora)).toBe(480);
    expect(esperaDeEnfriamiento(estado(0, null), ahora)).toBe(ENFRIAMIENTO_MS / 1000);
    expect(esperaDeEnfriamiento(estado(-5, null), ahora)).toBe(600);
  });

  it("la captura terminada por credencial inválida y lo anterior a ella no cuentan; lo posterior sí", () => {
    const falla = new Date(ahora - 30_000);
    expect(esperaDeEnfriamiento(estado(1, 0.6), ahora, falla)).toBeNull();
    expect(esperaDeEnfriamiento(estado(1, 0.1), ahora, falla)).toBe(594);
    expect(esperaDeEnfriamiento(estado(1, null), ahora, null)).toBe(540);
  });

  it("sin solicitud ni captura, o pasados los 10 min, no hay espera", () => {
    expect(esperaDeEnfriamiento(estado(null, null), ahora)).toBeNull();
    expect(esperaDeEnfriamiento(estado(10, 30), ahora)).toBeNull();
  });
});

describe("rutaDelCliente", () => {
  const ok = `buzon/${T}/${C}/${U}.pdf`;
  it("acepta solo rutas de buzón del estudio y cliente", () => {
    expect(rutaDelCliente(ok, T, C)).toBe(true);
    expect(rutaDelCliente(ok, T, U)).toBe(false);
    expect(rutaDelCliente(ok, U, C)).toBe(false);
    expect(rutaDelCliente(`xml/${T}/${C}/${U}.xml`, T, C)).toBe(false);
    expect(rutaDelCliente(`buzon/${T}/${C}/../${U}.pdf`, T, C)).toBe(false);
    expect(rutaDelCliente("", T, C)).toBe(false);
  });
});

describe("cabeceras del adjunto", () => {
  it("el MIME de la fila solo si tiene forma tipo/subtipo", () => {
    expect(mimeSeguro("application/pdf")).toBe("application/pdf");
    expect(mimeSeguro("text/html\r\nX: 1")).toBe("application/octet-stream");
    expect(mimeSeguro(null)).toBe("application/octet-stream");
  });

  it("attachment con respaldo ASCII y filename* codificado", () => {
    const d = disposicionAdjunta("Resolución (1)'.pdf");
    expect(d).toMatch(/^attachment; filename="Resoluci_n__1__.pdf"; filename\*=UTF-8''/);
    expect(d).toContain("Resoluci%C3%B3n%20%281%29%27.pdf");
    expect(d).not.toMatch(/[\r\n]/);
  });
});
