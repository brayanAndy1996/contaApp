import { describe, expect, it } from "vitest";
import * as indice from "./index.js";
import {
  TIPOS_AVISO_SEGURIDAD,
  avisoSeguridad,
  type TipoAvisoSeguridad,
} from "./seguridad.js";

// Spec 029 (U8, CA-6, CA-10). Contrato de `packages/correo/src/seguridad.ts` (puro, sin IO):
//   TIPOS_AVISO_SEGURIDAD = ["totp_activado", "totp_desactivado", "recuperacion_usada", "totp_restablecido"]
//   avisoSeguridad(tipo, { nombre?: string | null; ocurridoEn: Date; dispositivo?: string | null; ip?: string | null })
//       : { asunto: string; texto: string }          // texto plano; el llamador pone `para`
// Reglas: español; asunto de una sola línea; SIN códigos (TOTP ni de recuperación), secretos, URI otpauth
// ni enlaces; los valores insertados (nombre, dispositivo, ip) se escapan: sin caracteres de control ni
// saltos de línea, y acotados en largo. Se exporta desde el índice del paquete.
const AHORA = new Date("2026-11-25T15:00:00.000Z");
const DATOS = {
  nombre: "Ana Pérez",
  ocurridoEn: AHORA,
  dispositivo: "Chrome en Windows",
  ip: "203.0.113.0/24",
};

const ASUNTO_ESPERADO: Record<TipoAvisoSeguridad, RegExp> = {
  totp_activado: /activ/i,
  totp_desactivado: /desactiv/i,
  recuperacion_usada: /recuperaci/i,
  totp_restablecido: /restablec/i,
};

describe("TIPOS_AVISO_SEGURIDAD", () => {
  it("son los cuatro avisos de U8", () => {
    expect([...TIPOS_AVISO_SEGURIDAD]).toEqual([
      "totp_activado",
      "totp_desactivado",
      "recuperacion_usada",
      "totp_restablecido",
    ]);
  });
});

describe.each(TIPOS_AVISO_SEGURIDAD.map((t) => [t] as const))(
  "avisoSeguridad(%s)",
  (tipo) => {
    const aviso = avisoSeguridad(tipo, DATOS);

    it("tiene asunto en español de una sola línea que dice qué pasó", () => {
      expect(aviso.asunto).toMatch(ASUNTO_ESPERADO[tipo]);
      expect(aviso.asunto.trim().length).toBeGreaterThan(5);
      expect(aviso.asunto).not.toMatch(/[\r\n]/);
      expect(aviso.asunto.length).toBeLessThanOrEqual(120);
    });

    it("tiene texto plano con el saludo, la fecha del evento y el dispositivo", () => {
      expect(aviso.texto).toContain("Ana Pérez");
      expect(aviso.texto).toContain("2026");
      expect(aviso.texto).toContain("Chrome en Windows");
      expect(aviso.texto).not.toMatch(/<[a-z/!][^>]*>/i);
    });

    it("no lleva códigos, secretos, URI ni enlaces (CA-10)", () => {
      const todo = `${aviso.asunto}\n${aviso.texto}`;
      expect(todo).not.toMatch(/https?:\/\//i);
      expect(todo).not.toMatch(/\bwww\./i);
      expect(todo).not.toMatch(/otpauth/i);
      expect(todo).not.toMatch(/(?<![\d.:/-])\d{6}(?![\d.:/-])/); // código TOTP de 6 dígitos
      expect(todo).not.toMatch(/\b[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}\b/); // código de recuperación
      expect(todo).not.toMatch(/secret=/i);
    });

    it("es determinista", () => {
      expect(avisoSeguridad(tipo, DATOS)).toEqual(aviso);
    });
  },
);

describe("avisoSeguridad: diferencias entre tipos", () => {
  it("los cuatro asuntos y los cuatro textos son distintos", () => {
    const avisos = TIPOS_AVISO_SEGURIDAD.map((t) => avisoSeguridad(t, DATOS));
    expect(new Set(avisos.map((a) => a.asunto)).size).toBe(4);
    expect(new Set(avisos.map((a) => a.texto)).size).toBe(4);
  });

  it("el restablecimiento por el operador no atribuye el hecho a un dispositivo del usuario", () => {
    const { texto } = avisoSeguridad("totp_restablecido", {
      nombre: "Ana",
      ocurridoEn: AHORA,
    });
    expect(texto).not.toMatch(/undefined|null/);
    expect(texto).toMatch(/Ana/);
  });
});

describe("avisoSeguridad: datos opcionales", () => {
  it.each(TIPOS_AVISO_SEGURIDAD.map((t) => [t] as const))(
    "%s sin nombre, dispositivo ni IP no imprime «undefined» ni «null»",
    (tipo) => {
      for (const datos of [
        { ocurridoEn: AHORA },
        { nombre: null, ocurridoEn: AHORA, dispositivo: null, ip: null },
        { nombre: "", ocurridoEn: AHORA, dispositivo: "", ip: "" },
      ]) {
        const { asunto, texto } = avisoSeguridad(tipo, datos);
        expect(`${asunto}\n${texto}`).not.toMatch(/undefined|null|\[object/i);
        expect(texto.trim().length).toBeGreaterThan(20);
      }
    },
  );

  it("muestra la IP truncada cuando se da", () => {
    const { texto } = avisoSeguridad("totp_activado", DATOS);
    expect(texto).toContain("203.0.113.0/24");
  });
});

describe("avisoSeguridad: valores hostiles se escapan (texto plano)", () => {
  const HOSTIL = {
    nombre: "Ana\r\nBcc: victima@x.pe\r\n\r\nSubject: otro",
    ocurridoEn: AHORA,
    dispositivo: "Chrome\r\nX-Inyectado: 1\u0000‮",
    ip: "1.2.3.0/24\nlinea",
  };

  it.each(TIPOS_AVISO_SEGURIDAD.map((t) => [t] as const))(
    "%s: el asunto no admite saltos de línea ni caracteres de control",
    (tipo) => {
      const { asunto } = avisoSeguridad(tipo, HOSTIL);
      expect(asunto).not.toMatch(/[\u0000-\u001f\u007f‮]/);
    },
  );

  it.each(TIPOS_AVISO_SEGURIDAD.map((t) => [t] as const))(
    "%s: ningún valor insertado abre una cabecera o línea nueva",
    (tipo) => {
      const { asunto, texto } = avisoSeguridad(tipo, HOSTIL);
      expect(texto).not.toMatch(
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‮]/,
      );
      expect(texto).not.toMatch(/\r/);
      expect(texto).not.toMatch(/^Bcc:/im);
      expect(texto).not.toMatch(/^Subject:/im);
      expect(texto).not.toMatch(/^X-Inyectado:/im);
      expect(`${asunto}${texto}`).not.toMatch(/\n\s*\n\s*Subject:/i);
    },
  );

  it("un nombre larguísimo no desborda el asunto ni el texto", () => {
    const largo = "N".repeat(50_000);
    const { asunto, texto } = avisoSeguridad("totp_activado", {
      ...DATOS,
      nombre: largo,
      dispositivo: largo,
    });
    expect(asunto.length).toBeLessThanOrEqual(120);
    expect(texto.length).toBeLessThan(2_000);
  });
});

describe("índice del paquete", () => {
  it("exporta avisoSeguridad y TIPOS_AVISO_SEGURIDAD", () => {
    expect(indice.avisoSeguridad).toBe(avisoSeguridad);
    expect(indice.TIPOS_AVISO_SEGURIDAD).toBe(TIPOS_AVISO_SEGURIDAD);
  });
});
