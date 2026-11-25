// Spec 028 · T19 (correcciones de la ronda adversarial 2, rojo; tester · sonnet). Dominio de correo, solo por su contrato público:
//  - H-028-2-5: el asunto del aviso agrupado cuenta los clientes distintos de TODOS los avisos del envío, no solo los de las 20 líneas.
//  - H-028-2-6 (decisión del usuario, 2026-11-24): lo que parezca URL o dominio dentro de un texto de usuario (razón social, nombre del
//    estudio, categoría, recurso) sale neutralizado en asunto, texto y HTML para que el cliente de correo no lo enlace, p. ej.
//    `www.ejemplo.com` → `www[.]ejemplo[.]com` y `http://ejemplo.com` → `http[:]//ejemplo[.]com`. El nombre sigue legible: un texto sin URL
//    ni dominio sale idéntico (sin cambiar S.A.C., E.I.R.L., cifras ni nombres comunes). Los únicos enlaces son los dos de la app.
//    No se fija DÓNDE se neutraliza (otra función exportada o dentro de `limpiarLinea`): solo lo que sale de `armarCorreo*`.
import { describe, expect, it } from "vitest";
import { armarCorreoAviso, armarCorreoPendientes, armarCorreoResumen, escaparHtml } from "../index";
import {
  ENLACES,
  avisoBuzon,
  cliente,
  entradaAviso,
  entradaPendientes,
  entradaResumen,
  esperarHtmlSeguro,
  textoVisible,
} from "../../tests/ayudas/correo";

const PREFIJO = "Coactiva y avisos críticos del buzón · ";

describe("H-028-2-5 · el asunto cuenta los clientes de todos los avisos, no solo los de las 20 líneas", () => {
  it("25 avisos del cliente 1 y uno del cliente 2 fuera de las 20 líneas: «2 clientes», no el nombre del primero", () => {
    const avisos = [...Array.from({ length: 25 }, () => avisoBuzon(1)), avisoBuzon(2)];
    const r = armarCorreoAviso(entradaAviso(avisos));
    expect(r.asunto).toBe(`${PREFIJO}2 clientes`);
    expect(r.texto).toContain("y 6 avisos más");
  });

  it("20 avisos del cliente 1 y, después de la línea 20, uno de otros dos clientes: «3 clientes»", () => {
    const avisos = [...Array.from({ length: 20 }, () => avisoBuzon(1)), avisoBuzon(2), avisoBuzon(3)];
    expect(armarCorreoAviso(entradaAviso(avisos)).asunto).toBe(`${PREFIJO}3 clientes`);
  });

  it("40 clientes de un aviso cada uno: «40 clientes» aunque se listen 20 líneas", () => {
    const avisos = Array.from({ length: 40 }, (_, i) => avisoBuzon(i + 1));
    expect(armarCorreoAviso(entradaAviso(avisos)).asunto).toBe(`${PREFIJO}40 clientes`);
  });

  it("clave SOL inválida: el mismo conteo («Clave SOL inválida · 3 clientes»)", () => {
    const avisos = [...Array.from({ length: 21 }, () => avisoBuzon(1, { categoria: null })), avisoBuzon(2, { categoria: null }), avisoBuzon(3, { categoria: null })];
    expect(armarCorreoAviso(entradaAviso(avisos, { tipo: "credencial_invalida" })).asunto).toBe("Clave SOL inválida · 3 clientes");
  });

  it("control: 30 avisos del mismo cliente siguen nombrando al cliente", () => {
    const avisos = Array.from({ length: 30 }, () => avisoBuzon(1));
    expect(armarCorreoAviso(entradaAviso(avisos)).asunto).toBe(`${PREFIJO}Cliente-1-SAC`);
  });
});

// ---- H-028-2-6 ----------------------------------------------------------------------------------------------------------------------

/** Lo que un cliente de correo convierte en enlace: `esquema://…`, `www.…` o un dominio con TLD de 2+ letras (también tras «@»). */
const ENLAZABLE =
  /(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.)\S+|\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}\b/giu;
/** Enlazables que quedan en `t` una vez retirados los enlaces de la app (los únicos que se admiten). */
const enlazables = (t: string): string[] => (t.split(ENLACES.pantalla).join(" ").split(ENLACES.baja).join(" ").match(ENLAZABLE) ?? []).filter((x) => x !== "");

type Armado = { asunto: string; texto: string; html: string };
const sinEnlazables = (r: Armado): { asunto: string[]; texto: string[]; html: string[] } => ({
  asunto: enlazables(r.asunto),
  texto: enlazables(r.texto),
  html: enlazables(textoVisible(r.html)),
});
const LIMPIO = { asunto: [], texto: [], html: [] };

/** Cada superficie del correo con un texto de usuario hostil en cada campo que acepta (razón social, estudio, categoría, recurso). */
const superficies: [string, (t: string) => Armado][] = [
  ["aviso (razón social)", (t) => armarCorreoAviso(entradaAviso([avisoBuzon(1, { razonSocial: t })]))],
  ["aviso (categoría)", (t) => armarCorreoAviso(entradaAviso([avisoBuzon(1, { categoria: t })]))],
  ["aviso (estudio)", (t) => armarCorreoAviso(entradaAviso([avisoBuzon(1)], { estudio: t }))],
  [
    "aviso de plan (recurso)",
    (t) => armarCorreoAviso(entradaAviso([{ razonSocial: null, categoria: null, recurso: t, porcentaje: 85, fecha: new Date("2026-11-24T12:05:00Z") }], { tipo: "plan_limite" })),
  ],
  ["resumen (razón social)", (t) => armarCorreoResumen(entradaResumen([cliente(t, { nuevos: 2 })]))],
  ["resumen (estudio)", (t) => armarCorreoResumen(entradaResumen([cliente("Cliente SAC", { nuevos: 2 })], { estudio: t }))],
  ["pendientes (estudio)", (t) => armarCorreoPendientes(entradaPendientes([{ tipo: "buzon_critico", cantidad: 3 }], { estudio: t }))],
];

/** Texto con los invisibles y controles escapados (para los títulos de las pruebas). */
const ver = (s: string): string => s.replace(/[\p{Cc}\p{Cf}]/gu, (c) => `\\u${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`);

const HOSTILES = [
  "www.ejemplo.com",
  "WWW.EJEMPLO.COM",
  "http://ejemplo.com",
  "https://sunat-pagos.example/pagar",
  "HTTPS://EJEMPLO.COM/X?a=1&b=2",
  "ftp://archivos.ejemplo.org/a",
  "ejemplo.com",
  "pagos.sunat-ejemplo.com.pe",
  "ejemplo.com/pagar?id=1",
  "cobros@ejemplo.com",
  "mailto:cobros@ejemplo.com",
  "PAGUE EN https://sunat-pagos.example/pagar O www.sunat-pagos.example",
  "PAGUEEN www.ejemplo.com,AHORA",
  "www.ejem\u200Bplo.com", // ancho cero dentro del dominio: tras limpiar es un dominio
  "ejemplo\u202E.com", // bidi
  "ejemplo\r\n.com",
];

describe("H-028-2-6 · texto de usuario con URL o dominio: nada enlazable en asunto, texto ni HTML", () => {
  describe.each(superficies)("%s", (_nombre, armar) => {
    it.each(HOSTILES.map((h) => [ver(h), h] as const))("%s no deja nada que un cliente de correo enlace", (_titulo, hostil) => {
      const r = armar(`Cliente ${hostil} SAC`);
      expect(sinEnlazables(r)).toEqual(LIMPIO);
    });

    it("el HTML sigue seguro: solo los dos enlaces de la app como href", () => {
      esperarHtmlSeguro(armar("Cobro https://ejemplo.com/x y www.ejemplo.com").html);
    });
  });

  it("el nombre sigue legible: www.ejemplo.com → www[.]ejemplo[.]com y http://ejemplo.com → http[:]//ejemplo[.]com, en asunto, texto y HTML", () => {
    const www = armarCorreoAviso(entradaAviso([avisoBuzon(1, { razonSocial: "PAGUE EN www.ejemplo.com YA" })]));
    expect(www.asunto).toBe(`${PREFIJO}PAGUE EN www[.]ejemplo[.]com YA`);
    expect(www.texto).toContain("PAGUE EN www[.]ejemplo[.]com YA");
    expect(www.html).toContain("PAGUE EN www[.]ejemplo[.]com YA");
    const http = armarCorreoAviso(entradaAviso([avisoBuzon(1, { razonSocial: "VER http://ejemplo.com HOY" })]));
    expect(http.asunto).toBe(`${PREFIJO}VER http[:]//ejemplo[.]com HOY`);
    expect(http.texto).toContain("VER http[:]//ejemplo[.]com HOY");
    expect(http.html).toContain("VER http[:]//ejemplo[.]com HOY");
    const https = armarCorreoAviso(entradaAviso([avisoBuzon(1, { razonSocial: "https://sunat-pagos.example/pagar" })]));
    expect(https.texto).toContain("https[:]//sunat-pagos[.]example/pagar");
  });

  it("el nombre del estudio con un dominio también se neutraliza (asunto del resumen y pie «<estudio> · ContApp»)", () => {
    const r = armarCorreoResumen(entradaResumen([cliente("Cliente SAC", { nuevos: 1 })], { estudio: "Contadores www.estudio-ejemplo.com SAC" }));
    expect(r.asunto).toContain("Contadores www[.]estudio-ejemplo[.]com SAC");
    expect(r.texto).toContain("Contadores www[.]estudio-ejemplo[.]com SAC · ContApp");
    expect(r.html).toContain("Contadores www[.]estudio-ejemplo[.]com SAC · ContApp");
  });

  it("un dominio cortado por el límite de largo del asunto tampoco queda enlazable (todas las longitudes)", () => {
    for (let k = 30; k <= 62; k++) {
      const r = armarCorreoAviso(entradaAviso([avisoBuzon(1, { razonSocial: `${"A".repeat(k)} ejemplo.com` })]));
      expect(enlazables(r.asunto), `con ${k} caracteres antes del dominio`).toEqual([]);
      expect(sinEnlazables(r).texto).toEqual([]);
    }
  });

  it("los enlaces de la app (`/ir`, `/baja`) llegan intactos al texto y al HTML aunque haya textos con dominios", () => {
    for (const [, armar] of superficies) {
      const r = armar("Cliente www.ejemplo.com SAC");
      expect(r.texto).toContain(ENLACES.pantalla);
      expect(r.texto).toContain(ENLACES.baja);
      expect(r.html).toContain(`href="${escaparHtml(ENLACES.pantalla)}"`);
      expect(r.html).toContain(`href="${escaparHtml(ENLACES.baja)}"`);
    }
  });

  it.each([
    "Distribuidora Andina S.A.C.",
    "Grupo A.B. Peñafiel E.I.R.L.",
    "Cliente-1-SAC",
    "J. P. Morgan & Co.",
    "Ñandú Ltda. del Sur",
    "INVERSIONES 2.5 SAC",
    "Estudio Quispe & Asociados",
    "Comercial Los Andes S.R.L.",
  ])("un nombre sin URL ni dominio sale igual que hoy: %j", (nombre) => {
    const r = armarCorreoAviso(entradaAviso([avisoBuzon(1, { razonSocial: nombre })], { estudio: nombre }));
    expect(r.asunto).toBe(`${PREFIJO}${nombre}`);
    expect(r.texto).toContain(`- ${nombre} · Coactiva ·`);
    expect(r.texto).toContain(`${nombre} · ContApp`);
    expect(r.html).toContain(escaparHtml(nombre));
  });
});
