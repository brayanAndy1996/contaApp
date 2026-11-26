// Spec 028 · T1 (rojo). `armarCorreoResumen` y `resumenVacio` (R-13, D-5, D-6; CA-4, CA-7; plan, Contratos: domain `resumen.ts`).
// Entrada: {estudio, dia, clientes: {razonSocial, nuevos, criticosNuevos, pendientesAtender, compras, ventas}[], clientesMas, periodo, diferidos, enlaces}.
// Contratos fijados por T1 que el plan no precisa (se anotan en el resultado de la tarea):
//  - `dia` = «AAAA-MM-DD» (lo que devuelve `diaLima`); `periodo` = «AAAAMM» (lo que devuelve `periodoAnteriorLima`) y se muestra «AAAA-MM» (R-6).
//  - `enlaces` = {pantalla, baja} (misma forma que el aviso; el resumen no lleva enlaces por cliente porque el cliente no trae id).
//  - Línea de cliente: «<N> nuevo(s), <N> crítico(s), <N> pendiente(s) de atender» (singular con 1) y «Compras: <estado> · Ventas: <estado>»,
//    con estados «sin descargar», «abierto», «revisado»; un libro en `null` (generado: no pendiente) no aparece.
//  - La función ordena (R-13: críticos nuevos ↓, nuevos ↓, razón social con localeCompare("es")), muestra 50 clientes como máximo y
//    «y N clientes más» (singular «y 1 cliente más») con N = `clientesMas` + los que pasen de 50 en `clientes`.
//  - Sección de diferidos con el encabezado «Avisos que no te enviamos al momento» y una línea «<etiqueta>: <cantidad>» por tipo, con las
//    etiquetas «Coactivas y avisos críticos del buzón», «Clave SOL inválida» y «Límite del plan». Sin diferidos no hay sección.
//  - Asunto: empieza con «Resumen diario» e incluye el nombre del estudio limpiado a 60 (D-5). Pie «<estudio> · ContApp» (D-5).
//  - Claves extra (p. ej. `ruc` en un cliente) → lanza; conteos negativos o no enteros → lanza; con cualquier texto de usuario no lanza.
import { describe, expect, it } from "vitest";
import { armarCorreoResumen, resumenVacio } from "../index";
import { ENLACES, cliente, contar, entradaResumen, esperarHtmlSeguro, textoVisible, esperarLanza } from "../../tests/ayudas/correo";

describe("armarCorreoResumen · CA-4 (Contador con A y B visibles)", () => {
  const A = cliente("Alfa Importaciones SAC", { nuevos: 3, criticosNuevos: 1, pendientesAtender: 5 });
  const B = cliente("Beta Servicios EIRL", { compras: "abierto", ventas: "sin_descargar" });

  it("A «3 nuevos, 1 crítico, 5 pendientes de atender» y B «Compras: abierto · Ventas: sin descargar»", () => {
    const r = armarCorreoResumen(entradaResumen([A, B]));
    expect(r.texto).toContain("Alfa Importaciones SAC");
    expect(r.texto).toContain("3 nuevos, 1 crítico, 5 pendientes de atender");
    expect(r.texto).toContain("Beta Servicios EIRL");
    expect(r.texto).toContain("Compras: abierto · Ventas: sin descargar");
    expect(r.texto).toContain("2026-10"); // periodo mostrado «AAAA-MM»
    expect(r.html).toContain("Alfa Importaciones SAC");
    expect(r.html).toContain("Beta Servicios EIRL");
    expect(r.html).toContain("2026-10");
  });

  it("lleva el pie con el estudio, el enlace de la app y el de baja; asunto con el estudio", () => {
    const r = armarCorreoResumen(entradaResumen([A, B], { estudio: "Estudio Quispe & Asociados" }));
    expect(r.asunto).toMatch(/^Resumen diario/);
    expect(r.asunto).toContain("Estudio Quispe & Asociados");
    expect(r.texto).toContain("Estudio Quispe & Asociados · ContApp");
    expect(r.html).toContain("Estudio Quispe &amp; Asociados · ContApp");
    expect(r.texto).toContain(ENLACES.pantalla);
    expect(r.texto).toContain(ENLACES.baja);
    expect(r.html).toContain(`href="${ENLACES.baja}"`);
    esperarHtmlSeguro(r.html);
  });

  it("no inventa datos: sin «null», «undefined», «NaN» ni «RUC»", () => {
    const r = armarCorreoResumen(entradaResumen([A, B]));
    for (const s of [r.asunto, r.texto, textoVisible(r.html)]) expect(s).not.toMatch(/\bnull\b|undefined|NaN|RUC/);
  });

  it("estados de periodo: «sin descargar», «abierto» y «revisado»", () => {
    const r = armarCorreoResumen(
      entradaResumen([
        cliente("Uno SAC", { compras: "revisado", ventas: "sin_descargar" }),
        cliente("Dos SAC", { compras: "sin_descargar", ventas: "abierto" }),
      ]),
    );
    expect(r.texto).toContain("Compras: revisado · Ventas: sin descargar");
    expect(r.texto).toContain("Compras: sin descargar · Ventas: abierto");
    expect(r.html).toContain("revisado");
    expect(r.html).toContain("sin descargar");
  });

  it("un libro generado (null) no aparece: solo «Compras: abierto»", () => {
    const r = armarCorreoResumen(entradaResumen([cliente("Uno SAC", { nuevos: 1, compras: "abierto", ventas: null })]));
    expect(r.texto).toContain("Compras: abierto");
    expect(r.texto).not.toContain("Ventas:");
    const v = armarCorreoResumen(entradaResumen([cliente("Dos SAC", { nuevos: 1, compras: null, ventas: "sin_descargar" })]));
    expect(v.texto).toContain("Ventas: sin descargar");
    expect(v.texto).not.toContain("Compras:");
  });

  it("singular con 1: «1 nuevo» y «1 pendiente de atender»", () => {
    const r = armarCorreoResumen(entradaResumen([cliente("Uno SAC", { nuevos: 1, criticosNuevos: 0, pendientesAtender: 1 })]));
    expect(r.texto).toMatch(/\b1 nuevo(?!s)/);
    expect(r.texto).toMatch(/\b1 pendiente(?!s) de atender/);
    const plural = armarCorreoResumen(entradaResumen([cliente("Dos SAC", { nuevos: 2, criticosNuevos: 2, pendientesAtender: 2 })]));
    expect(plural.texto).toContain("2 nuevos, 2 críticos, 2 pendientes de atender");
  });
});

describe("armarCorreoResumen · orden y tope de clientes · R-13", () => {
  const nombres = (s: string): string[] => [...s.matchAll(/(?:Álamo|Beta|Zeta|Ñandú|Nube|Mayor|Medio|Menor)[A-Za-záéíóúñ ]*?SAC/g)].map((m) => m[0]);

  it("críticos nuevos ↓, luego nuevos ↓, luego razón social (es: «Álamo» antes de «Beta» y «Ñ» después de «N»)", () => {
    const clientes = [
      cliente("Zeta SAC", { nuevos: 5 }),
      cliente("Menor SAC", { nuevos: 1, criticosNuevos: 0 }),
      cliente("Mayor SAC", { nuevos: 2, criticosNuevos: 2 }),
      cliente("Medio SAC", { nuevos: 9, criticosNuevos: 1 }),
      cliente("Ñandú SAC", { nuevos: 5 }),
      cliente("Álamo SAC", { nuevos: 5 }),
      cliente("Nube SAC", { nuevos: 5 }),
      cliente("Beta SAC", { nuevos: 5 }),
    ];
    const esperado = ["Mayor SAC", "Medio SAC", "Álamo SAC", "Beta SAC", "Nube SAC", "Ñandú SAC", "Zeta SAC", "Menor SAC"];
    const r = armarCorreoResumen(entradaResumen(clientes));
    expect(nombres(r.texto)).toEqual(esperado);
    expect(nombres(textoVisible(r.html))).toEqual(esperado);
  });

  it("51 clientes → 50 y «y 1 cliente más» (se omite el último del orden)", () => {
    const clientes = Array.from({ length: 51 }, (_, i) => cliente(`Cliente-${String(i).padStart(2, "0")}-SAC`, { nuevos: 100 - i, criticosNuevos: 0 }));
    const r = armarCorreoResumen(entradaResumen(clientes));
    expect(contar(r.texto, /Cliente-\d\d-SAC/g)).toBe(50);
    expect(contar(r.html, /Cliente-\d\d-SAC/g)).toBe(50);
    expect(r.texto).not.toContain("Cliente-50-SAC");
    expect(r.html).not.toContain("Cliente-50-SAC");
    expect(r.texto).toContain("y 1 cliente más");
    expect(r.texto).not.toContain("y 1 clientes más");
    expect(r.html).toContain("y 1 cliente más");
  });

  it("50 clientes y `clientesMas` 12 → «y 12 clientes más»; 60 clientes y `clientesMas` 5 → «y 15 clientes más»", () => {
    const cincuenta = Array.from({ length: 50 }, (_, i) => cliente(`Cliente-${String(i).padStart(2, "0")}-SAC`, { nuevos: 1 }));
    const a = armarCorreoResumen(entradaResumen(cincuenta, { clientesMas: 12 }));
    expect(contar(a.texto, /Cliente-\d\d-SAC/g)).toBe(50);
    expect(a.texto).toContain("y 12 clientes más");
    expect(a.html).toContain("y 12 clientes más");
    const sesenta = Array.from({ length: 60 }, (_, i) => cliente(`Cliente-${String(i).padStart(2, "0")}-SAC`, { nuevos: 1 }));
    const b = armarCorreoResumen(entradaResumen(sesenta, { clientesMas: 5 }));
    expect(contar(b.texto, /Cliente-\d\d-SAC/g)).toBe(50);
    expect(b.texto).toContain("y 15 clientes más");
  });

  it("sin cliente de más no hay «clientes más»", () => {
    const r = armarCorreoResumen(entradaResumen([cliente("Uno SAC", { nuevos: 1 })]));
    expect(r.texto).not.toMatch(/clientes? más/);
    expect(r.html).not.toMatch(/clientes? más/);
  });
});

describe("armarCorreoResumen · avisos diferidos · R-14", () => {
  const diferidos = [
    { tipo: "buzon_critico", cantidad: 7 },
    { tipo: "credencial_invalida", cantidad: 2 },
    { tipo: "plan_limite", cantidad: 1 },
  ];

  it("sección «Avisos que no te enviamos al momento» con una línea por tipo y su cantidad", () => {
    const r = armarCorreoResumen(entradaResumen([cliente("Uno SAC", { nuevos: 1 })], { diferidos }));
    expect(r.texto).toContain("Avisos que no te enviamos al momento");
    expect(r.texto).toMatch(/Coactivas y avisos críticos del buzón[^\n]*\b7\b/);
    expect(r.texto).toMatch(/Clave SOL inválida[^\n]*\b2\b/);
    expect(r.texto).toMatch(/Límite del plan[^\n]*\b1\b/);
    expect(r.html).toContain("Avisos que no te enviamos al momento");
    expect(r.html).toContain("Coactivas y avisos críticos del buzón");
  });

  it("el resumen puede llevar solo diferidos (sin clientes) y sale", () => {
    const r = armarCorreoResumen(entradaResumen([], { diferidos: [diferidos[0]] }));
    expect(r.texto).toContain("Avisos que no te enviamos al momento");
    expect(r.texto).toMatch(/Coactivas y avisos críticos del buzón[^\n]*\b7\b/);
  });

  it("sin diferidos no hay sección", () => {
    const r = armarCorreoResumen(entradaResumen([cliente("Uno SAC", { nuevos: 1 })]));
    expect(r.texto).not.toContain("Avisos que no te enviamos al momento");
    expect(r.html).not.toContain("Avisos que no te enviamos al momento");
  });
});

describe("armarCorreoResumen · saneo de textos de usuario · CA-7", () => {
  const HOSTIL = "<img src=x onerror=alert(1)>";

  it("razón social y nombre del estudio con HTML salen escapados", () => {
    const r = armarCorreoResumen(entradaResumen([cliente(HOSTIL, { nuevos: 1 })], { estudio: `${HOSTIL} Estudio` }));
    expect(r.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(r.html).not.toMatch(/<img/i);
    esperarHtmlSeguro(r.html);
  });

  it("estudio con «\\r\\nBcc: x@y», NUL y bidi: el asunto queda en una línea, limpio", () => {
    const r = armarCorreoResumen(entradaResumen([cliente("Uno SAC", { nuevos: 1 })], { estudio: "Quispe\r\nBcc: x@y\u0000\u202e\u200b" }));
    expect(r.asunto).not.toMatch(/[\r\n\u0000\u202e\u200b]/);
    expect(r.texto).not.toMatch(/[\u0000\u202e\u200b]/);
    expect(r.html).not.toMatch(/[\u0000\u202e\u200b]/);
  });

  it("estudio de 300 caracteres: en el asunto va recortado a 60 con «…»", () => {
    const r = armarCorreoResumen(entradaResumen([cliente("Uno SAC", { nuevos: 1 })], { estudio: "a".repeat(300) }));
    expect(r.asunto).toContain(`${"a".repeat(59)}…`);
    expect(r.asunto).not.toContain("a".repeat(60));
    expect(r.asunto).not.toMatch(/[\r\n]/);
  });

  it("razón social con «\\r\\nBcc» no abre líneas nuevas en el texto de la línea del cliente", () => {
    const r = armarCorreoResumen(entradaResumen([cliente("ACME\r\nBcc: x@y", { nuevos: 1 })]));
    expect(r.texto).not.toMatch(/^Bcc:/m);
  });
});

describe("armarCorreoResumen · entradas fuera de contrato (R-6)", () => {
  it("claves extra se rechazan: RUC, asunto o remitente de mensajes no son campos del contrato", () => {
    esperarLanza(() => armarCorreoResumen(entradaResumen([cliente("Uno SAC", { ruc: "20100070970" })])));
    esperarLanza(() => armarCorreoResumen(entradaResumen([cliente("Uno SAC", { asunto: "RESOLUCIÓN" })])));
    esperarLanza(() => armarCorreoResumen(entradaResumen([cliente("Uno SAC")], { remitente: "x@y.com" })));
    esperarLanza(() => armarCorreoResumen(entradaResumen([cliente("Uno SAC")], { enlaces: { ...ENLACES, otro: "https://x.test" } })));
    esperarLanza(() => armarCorreoResumen(entradaResumen([cliente("Uno SAC")], { diferidos: [{ tipo: "buzon_critico", cantidad: 1, ruc: "1" }] })));
  });

  it.each([
    ["nuevos negativo", { nuevos: -1 }],
    ["nuevos decimal", { nuevos: 1.5 }],
    ["criticosNuevos negativo", { criticosNuevos: -1 }],
    ["pendientesAtender decimal", { pendientesAtender: 0.5 }],
    ["estado desconocido", { compras: "pendiente" }],
  ])("%s → lanza", (_n, extra) => {
    esperarLanza(() => armarCorreoResumen(entradaResumen([cliente("Uno SAC", extra)])));
  });

  it("clientesMas negativo, diferido con tipo fuera de U-1, día o periodo mal formados → lanza", () => {
    esperarLanza(() => armarCorreoResumen(entradaResumen([cliente("Uno SAC")], { clientesMas: -1 })));
    esperarLanza(() => armarCorreoResumen(entradaResumen([cliente("Uno SAC")], { diferidos: [{ tipo: "trabajo_terminado", cantidad: 1 }] })));
    esperarLanza(() => armarCorreoResumen(entradaResumen([cliente("Uno SAC")], { dia: "24/11/2026" })));
    esperarLanza(() => armarCorreoResumen(entradaResumen([cliente("Uno SAC")], { periodo: "2026-10" })));
  });

  it("enlaces que no son http(s) se rechazan", () => {
    esperarLanza(() => armarCorreoResumen(entradaResumen([cliente("Uno SAC")], { enlaces: { ...ENLACES, baja: "javascript:alert(1)" } })));
  });

  it("no muta la entrada (ni reordena el arreglo de clientes recibido)", () => {
    const entrada = entradaResumen([cliente("Zeta SAC", { nuevos: 1 }), cliente("Alfa SAC", { nuevos: 9, criticosNuevos: 3 })]);
    const copia = structuredClone(entrada);
    armarCorreoResumen(entrada);
    expect(entrada).toEqual(copia);
  });
});

describe("resumenVacio · R-13, U-7", () => {
  it("sin clientes, sin periodos y sin diferidos → vacío", () => {
    expect(resumenVacio(entradaResumen([]))).toBe(true);
  });

  it("los pendientes de atender solos no lo disparan (siguen vacío)", () => {
    expect(resumenVacio(entradaResumen([cliente("Uno SAC", { pendientesAtender: 4 })]))).toBe(true);
  });

  it("clientes sin mensajes nuevos ni periodos pendientes (periodo `generado` en ambos libros) → vacío", () => {
    const r = entradaResumen([cliente("Uno SAC", { compras: null, ventas: null, pendientesAtender: 2 }), cliente("Dos SAC")]);
    expect(resumenVacio(r)).toBe(true);
  });

  it("un mensaje nuevo basta", () => {
    expect(resumenVacio(entradaResumen([cliente("Uno SAC", { nuevos: 1 })]))).toBe(false);
  });

  it("un periodo pendiente basta (en compras o en ventas, cualquier estado)", () => {
    expect(resumenVacio(entradaResumen([cliente("Uno SAC", { compras: "sin_descargar" })]))).toBe(false);
    expect(resumenVacio(entradaResumen([cliente("Uno SAC", { ventas: "abierto" })]))).toBe(false);
    expect(resumenVacio(entradaResumen([cliente("Uno SAC", { ventas: "revisado" })]))).toBe(false);
  });

  it("un aviso diferido basta; una cantidad 0 no cuenta", () => {
    expect(resumenVacio(entradaResumen([], { diferidos: [{ tipo: "buzon_critico", cantidad: 3 }] }))).toBe(false);
    expect(resumenVacio(entradaResumen([], { diferidos: [{ tipo: "buzon_critico", cantidad: 0 }] }))).toBe(true);
  });

  it("no muta la entrada", () => {
    const entrada = entradaResumen([cliente("Uno SAC", { nuevos: 1 })]);
    const copia = structuredClone(entrada);
    resumenVacio(entrada);
    expect(entrada).toEqual(copia);
  });
});
