import { describe, expect, it } from "vitest";
import { TIPOS_AVISO_SEGURIDAD, avisoSeguridad } from "./seguridad.js";

// Spec 029 (T10a, U8, CA-10): bordes de `avisoSeguridad` que no dependen de la zona horaria del equipo: fecha invalida,
// valores opcionales ausentes y la fecha en hora de Lima (UTC-5, sin horario de verano).
const AHORA = new Date("2026-11-25T15:00:00.000Z");

describe("avisoSeguridad: fecha", () => {
  it.each(TIPOS_AVISO_SEGURIDAD)("%s: una fecha invalida no rompe el aviso ni imprime «NaN» o «Invalid»", (tipo) => {
    const { asunto, texto } = avisoSeguridad(tipo, { ocurridoEn: new Date("no-es-fecha") });
    expect(asunto.length).toBeGreaterThan(0);
    expect(texto).toContain("Fecha: fecha no disponible");
    expect(texto).not.toMatch(/NaN|Invalid/i);
  });

  it("la fecha se muestra en hora de Lima: 15:00 UTC es 10:00 del mismo dia", () => {
    const { texto } = avisoSeguridad("totp_activado", { ocurridoEn: AHORA });
    expect(texto).toContain("Fecha: 25/11/2026 10:00 (hora de Lima)");
  });

  it("cerca de medianoche UTC el dia es el de Lima (00:30 UTC del 26 es 19:30 del 25)", () => {
    const { texto } = avisoSeguridad("totp_activado", { ocurridoEn: new Date("2026-11-26T00:30:00.000Z") });
    expect(texto).toContain("Fecha: 25/11/2026 19:30 (hora de Lima)");
  });
});

describe("avisoSeguridad: datos opcionales", () => {
  it.each([undefined, null, "", "   ", "\u0000‮\n"])("nombre %j: saluda sin nombre", (nombre) => {
    const { texto } = avisoSeguridad("totp_desactivado", { nombre, ocurridoEn: AHORA });
    expect(texto.startsWith("Hola:\n")).toBe(true);
  });

  it("con nombre, dispositivo y red los muestra; sin ellos (o vacios) no deja lineas sueltas", () => {
    const con = avisoSeguridad("recuperacion_usada", { nombre: "Ana", ocurridoEn: AHORA, dispositivo: "Chrome en Windows", ip: "203.0.113.0/24" }).texto;
    expect(con).toContain("Hola, Ana:");
    expect(con).toContain("Dispositivo: Chrome en Windows");
    expect(con).toContain("Red: 203.0.113.0/24");
    for (const vacio of [undefined, null, "", "  "]) {
      const sin = avisoSeguridad("recuperacion_usada", { ocurridoEn: AHORA, dispositivo: vacio, ip: vacio }).texto;
      expect(sin).not.toContain("Dispositivo:");
      expect(sin).not.toContain("Red:");
    }
  });

  it("un valor que no es texto (numero, objeto) se ignora en vez de romper", () => {
    const { texto } = avisoSeguridad("totp_restablecido", {
      nombre: 42 as unknown as string,
      dispositivo: { x: 1 } as unknown as string,
      ip: [] as unknown as string,
      ocurridoEn: AHORA,
    });
    expect(texto.startsWith("Hola:\n")).toBe(true);
    expect(texto).not.toMatch(/Dispositivo:|Red:|\[object/);
  });
});
