// Spec 028 · T1 (rojo). `armarCorreoAviso` (R-6, R-7, R-14; CA-7, CA-9; plan, Contratos: domain `aviso.ts`).
// Entrada: {tipo, estudio, avisos: {razonSocial | null, categoria | null, recurso?, porcentaje?, fecha: Date}[≥ 1], total, enlaces: {pantalla, baja}}.
// Contratos fijados por T1 que el plan no precisa (se anotan en el resultado de la tarea):
//  - `categoria` y `recurso` llegan ya como texto para mostrar («Coactiva», «clientes»); el dominio solo los limpia y escapa.
//  - Asunto de `buzon_critico`/`credencial_invalida`: «<prefijo> · <razón social limpiada a 60 | «N clientes»>» (razón social si todos los
//    avisos listados son de un mismo cliente; si no, «N clientes» con N = clientes distintos listados). `plan_limite`: «Tu estudio llegó al
//    <porcentaje> % de <recurso>». El nombre del estudio NO va en el asunto de los avisos: va en el pie «<estudio> · ContApp» (D-5).
//  - «y N avisos más» (singular «y 1 aviso más») con N = total − 20 cuando total > 20; las líneas listadas son min(20, avisos.length).
//  - Claves extra en la entrada, en un aviso o en `enlaces` (p. ej. `ruc`, `asunto`) → lanza; `avisos` vacío, tipo fuera de los tres
//    de U-1 (p. ej. `trabajo_terminado`) o un enlace que no sea http(s) → lanza. Con cualquier texto de usuario no lanza (todo se sanea).
import { describe, expect, it } from "vitest";
import { armarCorreoAviso } from "../index";
import { ENLACES, FECHA, avisoBuzon, contar, entradaAviso, esperarHtmlSeguro, textoVisible, esperarLanza } from "../../tests/ayudas/correo";

const PREFIJO_BUZON = "Coactiva y avisos críticos del buzón · ";

describe("armarCorreoAviso · asuntos fijos por tipo", () => {
  it("buzon_critico con un cliente → «Coactiva y avisos críticos del buzón · <razón social>»", () => {
    const r = armarCorreoAviso(entradaAviso([avisoBuzon(1)]));
    expect(r.asunto).toBe(`${PREFIJO_BUZON}Cliente-1-SAC`);
  });

  it("buzon_critico: varios avisos del mismo cliente conservan la razón social", () => {
    const r = armarCorreoAviso(entradaAviso([avisoBuzon(1), avisoBuzon(1), avisoBuzon(1)]));
    expect(r.asunto).toBe(`${PREFIJO_BUZON}Cliente-1-SAC`);
  });

  it("buzon_critico de tres clientes distintos → «… · 3 clientes»", () => {
    const r = armarCorreoAviso(entradaAviso([avisoBuzon(1), avisoBuzon(2), avisoBuzon(3), avisoBuzon(2)]));
    expect(r.asunto).toBe(`${PREFIJO_BUZON}3 clientes`);
  });

  it("credencial_invalida → «Clave SOL inválida · <razón social>» y «… · N clientes»", () => {
    const uno = armarCorreoAviso(entradaAviso([avisoBuzon(1, { categoria: null })], { tipo: "credencial_invalida" }));
    expect(uno.asunto).toBe("Clave SOL inválida · Cliente-1-SAC");
    const dos = armarCorreoAviso(entradaAviso([avisoBuzon(1, { categoria: null }), avisoBuzon(2, { categoria: null })], { tipo: "credencial_invalida" }));
    expect(dos.asunto).toBe("Clave SOL inválida · 2 clientes");
  });

  it("plan_limite → «Tu estudio llegó al 85 % de clientes»", () => {
    const aviso = { razonSocial: null, categoria: null, recurso: "clientes", porcentaje: 85, fecha: FECHA };
    const r = armarCorreoAviso(entradaAviso([aviso], { tipo: "plan_limite" }));
    expect(r.asunto).toBe("Tu estudio llegó al 85 % de clientes");
    expect(r.texto).toContain("85 %");
    expect(r.texto).toContain("clientes");
    expect(r.texto).not.toMatch(/null|undefined|NaN/);
  });

  it("plan_limite con avisos de dos recursos: el asunto sigue el patrón fijo", () => {
    const a = { razonSocial: null, categoria: null, recurso: "clientes", porcentaje: 80, fecha: FECHA };
    const b = { razonSocial: null, categoria: null, recurso: "usuarios", porcentaje: 90, fecha: FECHA };
    expect(armarCorreoAviso(entradaAviso([a, b], { tipo: "plan_limite" })).asunto).toMatch(/^Tu estudio llegó al \d+ % de \S+/);
  });
});

describe("armarCorreoAviso · cuerpo (R-6, R-7)", () => {
  it("lista razón social, categoría y fecha de Lima de cada aviso; lleva los enlaces y el pie con el estudio", () => {
    const r = armarCorreoAviso(entradaAviso([avisoBuzon(1)], { estudio: "Estudio Quispe & Asociados" }));
    expect(r.texto).toContain("Cliente-1-SAC");
    expect(r.texto).toContain("Coactiva");
    expect(r.texto).toContain("24/11/2026 07:06"); // FECHA + 1 min, en hora de Lima
    expect(r.texto).toContain(ENLACES.pantalla);
    expect(r.texto).toContain(ENLACES.baja);
    expect(r.texto).toContain("Estudio Quispe & Asociados · ContApp");
    expect(r.html).toContain("Cliente-1-SAC");
    expect(r.html).toContain("24/11/2026 07:06");
    expect(r.html).toContain("Estudio Quispe &amp; Asociados · ContApp");
  });

  it("los enlaces del HTML van escapados en el atributo (el «&» de la consulta)", () => {
    const r = armarCorreoAviso(entradaAviso([avisoBuzon(1)]));
    expect(r.html).toContain('href="https://app.contapp.test/ir?estudio=0b6f3c1e&amp;pantalla=buzon_cliente&amp;cliente=77ab01cd"');
    expect(r.html).toContain(`href="${ENLACES.baja}"`);
    esperarHtmlSeguro(r.html);
  });

  it("sin datos nulos ni indefinidos en ninguna parte", () => {
    const r = armarCorreoAviso(entradaAviso([avisoBuzon(1, { categoria: null }), avisoBuzon(2, { razonSocial: null })]));
    for (const s of [r.asunto, r.texto, textoVisible(r.html)]) expect(s).not.toMatch(/\bnull\b|undefined|NaN/);
  });

  it("el HTML es multiparte con el mismo contenido: tiene tabla, sin imágenes ni scripts", () => {
    const r = armarCorreoAviso(entradaAviso([avisoBuzon(1)]));
    expect(r.html).toMatch(/<table/i);
    esperarHtmlSeguro(r.html);
  });
});

describe("armarCorreoAviso · agrupación y tope de líneas · CA-9, R-14", () => {
  // Una línea por aviso = una fecha de Lima por aviso (la razón social también puede ir en el título; la fecha, solo en la línea).
  const nombres = (s: string): number => contar(s, /24\/11\/2026 07:\d\d/g);

  it("1 aviso: una línea y ningún «más»", () => {
    const r = armarCorreoAviso(entradaAviso([avisoBuzon(1)]));
    expect(nombres(r.texto)).toBe(1);
    expect(r.texto).not.toMatch(/aviso(s)? más/);
    expect(r.html).not.toMatch(/aviso(s)? más/);
  });

  it("20 avisos: 20 líneas y ningún «más»", () => {
    const avisos = Array.from({ length: 20 }, (_, i) => avisoBuzon(i + 1));
    const r = armarCorreoAviso(entradaAviso(avisos));
    expect(nombres(r.texto)).toBe(20);
    expect(nombres(r.html)).toBe(20);
    expect(r.texto).not.toMatch(/aviso(s)? más/);
  });

  it("50 avisos (total 50): 20 líneas y «y 30 avisos más», en texto y HTML", () => {
    const avisos = Array.from({ length: 50 }, (_, i) => avisoBuzon(i + 1));
    const r = armarCorreoAviso(entradaAviso(avisos));
    expect(nombres(r.texto)).toBe(20);
    expect(nombres(r.html)).toBe(20);
    expect(contar(r.texto, "y 30 avisos más")).toBe(1);
    expect(contar(r.html, "y 30 avisos más")).toBe(1);
  });

  it("entrega solo 20 avisos pero total 50: igual «y 30 avisos más»", () => {
    const avisos = Array.from({ length: 20 }, (_, i) => avisoBuzon(i + 1));
    const r = armarCorreoAviso(entradaAviso(avisos, { total: 50 }));
    expect(nombres(r.texto)).toBe(20);
    expect(r.texto).toContain("y 30 avisos más");
    expect(r.html).toContain("y 30 avisos más");
  });

  it("21 avisos: «y 1 aviso más» en singular", () => {
    const avisos = Array.from({ length: 21 }, (_, i) => avisoBuzon(i + 1));
    const r = armarCorreoAviso(entradaAviso(avisos));
    expect(nombres(r.texto)).toBe(20);
    expect(r.texto).toContain("y 1 aviso más");
    expect(r.texto).not.toContain("y 1 avisos más");
  });

  it("los 20 que se muestran son los primeros recibidos (orden de entrada)", () => {
    const avisos = Array.from({ length: 25 }, (_, i) => avisoBuzon(i + 1));
    const r = armarCorreoAviso(entradaAviso(avisos));
    expect(r.texto).toContain("Cliente-20-SAC");
    expect(r.texto).not.toContain("Cliente-21-SAC");
  });
});

describe("armarCorreoAviso · saneo de textos de usuario · CA-7", () => {
  const HOSTIL = "<img src=x onerror=alert(1)>";

  it("razón social con HTML: escapada en el HTML y sin etiquetas vivas", () => {
    const r = armarCorreoAviso(entradaAviso([avisoBuzon(1, { razonSocial: HOSTIL })]));
    expect(r.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(r.html).not.toMatch(/<img/i);
    esperarHtmlSeguro(r.html);
  });

  it("nombre del estudio con HTML: escapado en el pie", () => {
    const r = armarCorreoAviso(entradaAviso([avisoBuzon(1)], { estudio: `${HOSTIL} Estudio` }));
    expect(r.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(r.html).not.toMatch(/<img/i);
    esperarHtmlSeguro(r.html);
  });

  it("«\\r\\nBcc: x@y», NUL y bidi no llegan al asunto", () => {
    const r = armarCorreoAviso(entradaAviso([avisoBuzon(1, { razonSocial: "ACME\r\nBcc: x@y\u0000\u202e\u200b" })]));
    expect(r.asunto).not.toMatch(/[\r\n\u0000]/);
    expect(r.asunto).not.toMatch(/[\u202e\u200b]/);
    expect(r.asunto.startsWith(PREFIJO_BUZON)).toBe(true);
  });

  it("300 caracteres: la razón social del asunto se recorta a 60 con «…»", () => {
    const r = armarCorreoAviso(entradaAviso([avisoBuzon(1, { razonSocial: "a".repeat(300) })]));
    expect(r.asunto).toBe(`${PREFIJO_BUZON}${"a".repeat(59)}…`);
  });

  it("el texto plano no lleva NUL ni bidi aunque vengan en la entrada", () => {
    const r = armarCorreoAviso(entradaAviso([avisoBuzon(1, { razonSocial: "A\u0000B\u202eC" })], { estudio: "E\u0000\u200bF" }));
    expect(r.texto).not.toMatch(/[\u0000\u202e\u200b]/);
    expect(r.html).not.toMatch(/[\u0000\u202e\u200b]/);
  });

  it("categoría y recurso también se escapan en el HTML", () => {
    const r = armarCorreoAviso(entradaAviso([avisoBuzon(1, { categoria: "<script>alert(1)</script>" })]));
    expect(r.html).not.toMatch(/<script/i);
    expect(r.html).toContain("&lt;script&gt;");
    const p = armarCorreoAviso(
      entradaAviso([{ razonSocial: null, categoria: null, recurso: "<b>x</b>", porcentaje: 90, fecha: FECHA }], { tipo: "plan_limite" }),
    );
    expect(p.html).not.toMatch(/<b>/i);
  });
});

describe("armarCorreoAviso · entradas fuera de contrato", () => {
  it("claves extra se rechazan: ruc, asunto o contenido del mensaje no son campos del contrato (R-6)", () => {
    esperarLanza(() => armarCorreoAviso(entradaAviso([avisoBuzon(1)], { ruc: "20100070970" })));
    esperarLanza(() => armarCorreoAviso(entradaAviso([avisoBuzon(1, { ruc: "20100070970" })])));
    esperarLanza(() => armarCorreoAviso(entradaAviso([avisoBuzon(1, { asunto: "RESOLUCIÓN COACTIVA N.º 1" })])));
    esperarLanza(() => armarCorreoAviso(entradaAviso([avisoBuzon(1, { contenido: "texto del mensaje" })])));
    esperarLanza(() => armarCorreoAviso(entradaAviso([avisoBuzon(1)], { enlaces: { ...ENLACES, otro: "https://x.test" } })));
  });

  it("sin avisos, tipo fuera de U-1 o sin enlaces → lanza", () => {
    esperarLanza(() => armarCorreoAviso(entradaAviso([])));
    esperarLanza(() => armarCorreoAviso(entradaAviso([avisoBuzon(1)], { tipo: "trabajo_terminado" })));
    esperarLanza(() => armarCorreoAviso(entradaAviso([avisoBuzon(1)], { enlaces: { pantalla: ENLACES.pantalla } })));
  });

  it("enlaces que no son http(s) se rechazan (sin «javascript:» ni «data:»)", () => {
    esperarLanza(() => armarCorreoAviso(entradaAviso([avisoBuzon(1)], { enlaces: { ...ENLACES, pantalla: "javascript:alert(1)" } })));
    esperarLanza(() => armarCorreoAviso(entradaAviso([avisoBuzon(1)], { enlaces: { ...ENLACES, baja: "data:text/html,<script>1</script>" } })));
  });

  it("conteos inválidos (negativo, decimal, total menor que 1) → lanza", () => {
    esperarLanza(() => armarCorreoAviso(entradaAviso([avisoBuzon(1)], { total: 0 })));
    esperarLanza(() => armarCorreoAviso(entradaAviso([avisoBuzon(1)], { total: 1.5 })));
    esperarLanza(() => armarCorreoAviso(entradaAviso([avisoBuzon(1)], { total: -3 })));
  });

  it("no muta la entrada ni devuelve referencias a ella", () => {
    const entrada = entradaAviso([avisoBuzon(1), avisoBuzon(2)]);
    const copia = structuredClone(entrada);
    armarCorreoAviso(entrada);
    expect(entrada).toEqual(copia);
  });
});
