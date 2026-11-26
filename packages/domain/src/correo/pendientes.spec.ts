// Spec 028 · T1 (rojo). `armarCorreoPendientes` (R-14, U-17; plan, Contratos: domain `pendientes.ts`): el correo «Avisos pendientes» de quien tiene
// el resumen apagado y avisos diferidos por el tope diario, uno por tipo (con la baja de ese tipo) a la hora del resumen.
// Contratos fijados por T1 que el plan no precisa: entrada {estudio, diferidos: {tipo, cantidad}[≥ 1], enlaces: {pantalla, baja}}; asunto «Avisos pendientes · <etiqueta>»
// con la etiqueta del tipo si es uno solo («Coactivas y avisos críticos del buzón», «Clave SOL inválida», «Límite del plan»), o solo «Avisos pendientes» si hay varios;
// una línea «<etiqueta>: <cantidad>» por tipo; pie «<estudio> · ContApp»; mismas reglas de saneo, claves extra y enlaces que el aviso.
import { describe, expect, it } from "vitest";
import { armarCorreoPendientes } from "../index";
import { ENLACES, entradaPendientes, esperarHtmlSeguro, textoVisible, esperarLanza } from "../../tests/ayudas/correo";

describe("armarCorreoPendientes · R-14", () => {
  it("un tipo: asunto con su etiqueta, la cantidad y los enlaces", () => {
    const r = armarCorreoPendientes(entradaPendientes([{ tipo: "buzon_critico", cantidad: 12 }]));
    expect(r.asunto).toBe("Avisos pendientes · Coactivas y avisos críticos del buzón");
    expect(r.texto).toMatch(/Coactivas y avisos críticos del buzón[^\n]*\b12\b/);
    expect(r.texto).toContain(ENLACES.pantalla);
    expect(r.texto).toContain(ENLACES.baja);
    expect(r.html).toContain("12");
    expect(r.html).toContain(`href="${ENLACES.baja}"`);
    esperarHtmlSeguro(r.html);
  });

  it("etiquetas de los otros dos tipos", () => {
    expect(armarCorreoPendientes(entradaPendientes([{ tipo: "credencial_invalida", cantidad: 3 }])).asunto).toBe("Avisos pendientes · Clave SOL inválida");
    expect(armarCorreoPendientes(entradaPendientes([{ tipo: "plan_limite", cantidad: 1 }])).asunto).toBe("Avisos pendientes · Límite del plan");
  });

  it("varios tipos: asunto «Avisos pendientes» y una línea por tipo", () => {
    const r = armarCorreoPendientes(
      entradaPendientes([
        { tipo: "buzon_critico", cantidad: 4 },
        { tipo: "credencial_invalida", cantidad: 6 },
      ]),
    );
    expect(r.asunto).toBe("Avisos pendientes");
    expect(r.texto).toMatch(/Coactivas y avisos críticos del buzón[^\n]*\b4\b/);
    expect(r.texto).toMatch(/Clave SOL inválida[^\n]*\b6\b/);
  });

  it("pie con el estudio, escapado en el HTML y en una sola línea en el texto", () => {
    const r = armarCorreoPendientes(entradaPendientes([{ tipo: "buzon_critico", cantidad: 2 }], { estudio: "Estudio Quispe & <b>Asociados</b>" }));
    expect(r.texto).toContain("Estudio Quispe & <b>Asociados</b> · ContApp");
    expect(r.html).toContain("Estudio Quispe &amp; &lt;b&gt;Asociados&lt;/b&gt; · ContApp");
    esperarHtmlSeguro(r.html);
  });

  it("estudio hostil: sin CR/LF en el asunto, sin NUL ni bidi, sin etiquetas vivas", () => {
    const r = armarCorreoPendientes(
      entradaPendientes([{ tipo: "plan_limite", cantidad: 2 }], { estudio: "<img src=x onerror=alert(1)>\r\nBcc: x@y\u0000\u202e" }),
    );
    expect(r.asunto).not.toMatch(/[\r\n\u0000\u202e]/);
    expect(r.texto).not.toMatch(/[\u0000\u202e]/);
    expect(r.html).not.toMatch(/<img/i);
    esperarHtmlSeguro(r.html);
    for (const s of [r.asunto, r.texto, textoVisible(r.html)]) expect(s).not.toMatch(/\bnull\b|undefined|NaN/);
  });

  it("claves extra, tipo fuera de U-1, cantidad inválida o sin diferidos → lanza", () => {
    esperarLanza(() => armarCorreoPendientes(entradaPendientes([{ tipo: "buzon_critico", cantidad: 1 }], { ruc: "20100070970" })));
    esperarLanza(() => armarCorreoPendientes(entradaPendientes([{ tipo: "buzon_critico", cantidad: 1, asunto: "x" }])));
    esperarLanza(() => armarCorreoPendientes(entradaPendientes([{ tipo: "trabajo_terminado", cantidad: 1 }])));
    esperarLanza(() => armarCorreoPendientes(entradaPendientes([{ tipo: "buzon_critico", cantidad: -1 }])));
    esperarLanza(() => armarCorreoPendientes(entradaPendientes([{ tipo: "buzon_critico", cantidad: 1.5 }])));
    esperarLanza(() => armarCorreoPendientes(entradaPendientes([])));
  });

  it("enlace que no es http(s) → lanza", () => {
    esperarLanza(() =>
      armarCorreoPendientes(entradaPendientes([{ tipo: "buzon_critico", cantidad: 1 }], { enlaces: { ...ENLACES, baja: "javascript:alert(1)" } })),
    );
  });

  it("no muta la entrada", () => {
    const entrada = entradaPendientes([{ tipo: "buzon_critico", cantidad: 2 }]);
    const copia = structuredClone(entrada);
    armarCorreoPendientes(entrada);
    expect(entrada).toEqual(copia);
  });
});
