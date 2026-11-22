// Spec 027 · T1 (rojo). Puntaje de sospecha (R-2, R-3; CA-1, CA-2, CA-5, CA-6; plan, Contratos: domain `puntaje.ts`):
// `puntuarGastoPersonal({glosas, fechaEmision | null, proveedor, esNuevo}, ctx) → {puntaje, senales, palabra, categoria}`.
// Los periodos (`abierto`, M−6/M−7, M−12/M−13) los resuelve el lector de `packages/db` (T4): aquí el historial son conteos.
import { describe, expect, it } from "vitest";
import {
  FECHA_DOMINGO,
  FECHA_FERIADO,
  FECHA_HABIL,
  FECHA_SABADO,
  OTRO_PROV,
  PROV,
  congelar,
  contextoGastos,
  contextoNeutro,
  entrada,
} from "../../tests/ayudas/gastos";
import type { ContextoPlano, EntradaPuntaje } from "../../tests/ayudas/gastos";
import { puntuarGastoPersonal } from "../index";

const puntuar = (e: Partial<EntradaPuntaje> = {}, c: Partial<ContextoPlano> = {}) => puntuarGastoPersonal(entrada(e), contextoGastos(c));
const neutro = (e: Partial<EntradaPuntaje> = {}, c: Partial<ContextoPlano> = {}) =>
  puntuarGastoPersonal(entrada({ fechaEmision: null, ...e }), contextoNeutro(c));
const codigos = (r: { senales: readonly { codigo: string }[] }): string[] => r.senales.map((s) => s.codigo);
const senal = (r: { senales: readonly { codigo: string }[] }, codigo: string) => r.senales.find((s) => s.codigo === codigo);
const SIN_COINCIDENCIA = ["servicio de cemento"];
const hist = (aceptadas6: number, excluidas6: number, excluidas12: number, proveedor = PROV) => [
  { proveedor: { ...proveedor }, aceptadas6, excluidas6, excluidas12 },
];

describe("CA-1 · caso real zapatilla (ferretería 4752 compra a tienda de ropa 4771, glosa «ZAPATILLA URBANA T42», miércoles)", () => {
  it("puntaje 8: palabra clave, rubro del proveedor no relacionado y categoría no permitida para el giro (D-6)", () => {
    const r = puntuar();
    expect(r.puntaje).toBe(8);
    expect(codigos(r)).toEqual(["S1", "S2", "S3"]);
    expect(senal(r, "S1")).toMatchObject({ puntos: 3, palabra: "zapatilla", items: { coinciden: 1, total: 1 } });
    expect(senal(r, "S2")).toMatchObject({ puntos: 3 });
    expect(senal(r, "S3")).toMatchObject({ puntos: 2, categoria: "calzado-ropa" });
  });

  it("devuelve la palabra y la categoría de S1 para la sugerencia", () => {
    const r = puntuar();
    expect(r.palabra).toBe("zapatilla");
    expect(r.categoria).toBe("calzado-ropa");
  });

  it("puntaje 9 si el proveedor es nuevo (S5)", () => {
    const r = puntuar({ esNuevo: true });
    expect(r.puntaje).toBe(9);
    expect(codigos(r)).toEqual(["S1", "S2", "S3", "S5"]);
  });

  it("con calzado-ropa permitida en el ajuste del cliente: puntaje 6 y sin S3", () => {
    const r = puntuar({}, { categoriasCliente: { permitidas: ["calzado-ropa"], quitadas: [] } });
    expect(r.puntaje).toBe(6);
    expect(codigos(r)).toEqual(["S1", "S2"]);
  });

  it("el puntaje es un entero y es la suma de los puntos de las señales", () => {
    const r = puntuar({ esNuevo: true });
    expect(Number.isInteger(r.puntaje)).toBe(true);
    expect(r.senales.reduce((a, s) => a + s.puntos, 0)).toBe(r.puntaje);
  });
});

describe("CA-2 · S7 historial de aceptación (−4) y S6 historial de exclusiones (+4)", () => {
  it("3 compras aceptadas en M−6..M−1 y ninguna excluida: el puntaje baja en 4 (8 → 4)", () => {
    const r = puntuar({}, { historial: hist(3, 0, 0) });
    expect(r.puntaje).toBe(4);
    expect(codigos(r)).toEqual(["S1", "S2", "S3", "S7"]);
    expect(senal(r, "S7")).toMatchObject({ puntos: -4 });
  });

  it("proveedor sin CIIU en caché (S1 + S3 − 4 = 1): puntaje 1, bajo el umbral 3 (sin hallazgo en R-GP)", () => {
    const r = puntuar({}, { ciiuProveedores: [{ proveedor: { ...PROV }, ciiu: null }], historial: hist(3, 0, 0) });
    expect(r.puntaje).toBe(1);
    expect(codigos(r)).toEqual(["S1", "S3", "S7"]);
  });

  it("con 2 compras aceptadas vuelve a 8 (no hay S7)", () => {
    const r = puntuar({}, { historial: hist(2, 0, 0) });
    expect(r.puntaje).toBe(8);
    expect(senal(r, "S7")).toBeUndefined();
  });

  it("con una de ellas excluida (3 aceptadas y 1 excluida en los 6 periodos) vuelve a 8: sin S7", () => {
    const r = puntuar({}, { historial: hist(3, 1, 1) });
    expect(r.puntaje).toBe(8);
    expect(codigos(r)).toEqual(["S1", "S2", "S3"]);
  });

  it("el historial de otro proveedor no se aplica", () => {
    const r = puntuar({}, { historial: hist(5, 0, 0, OTRO_PROV) });
    expect(r.puntaje).toBe(8);
  });
});

describe("CA-5 · S1 palabra clave (+3 por ítem coincidente, tope +6)", () => {
  it.each([
    [1, 3],
    [2, 6],
    [3, 6],
  ])("%i ítems coincidentes → %i puntos, «n de m» con n y m", (n, puntos) => {
    const glosas = ["ZAPATILLA URBANA", "polo azul", "perfume dulce"].slice(0, n);
    const r = neutro({ glosas });
    expect(r.puntaje).toBe(puntos);
    expect(senal(r, "S1")).toMatchObject({ puntos, items: { coinciden: n, total: n } });
  });

  it("ítems sin coincidencia cuentan en el total (3 de 4 ítems)", () => {
    const r = neutro({ glosas: ["zapatilla", "cable usb", "polo", "perfume"] });
    expect(senal(r, "S1")).toMatchObject({ puntos: 6, items: { coinciden: 3, total: 4 } });
  });

  it("un ítem con dos palabras coincidentes suma +3 una sola vez", () => {
    const r = neutro({ glosas: ["zapatilla con polo"] });
    expect(senal(r, "S1")).toMatchObject({ puntos: 3, items: { coinciden: 1, total: 1 } });
  });

  it("la palabra es la menor en orden de código entre los ítems coincidentes, sin importar el orden de los ítems", () => {
    expect(neutro({ glosas: ["ZAPATILLA", "POLO"] }).palabra).toBe("polo");
    expect(neutro({ glosas: ["POLO", "ZAPATILLA"] }).palabra).toBe("polo");
    expect(neutro({ glosas: ["zapatilla con polo", "zapatilla"] }).palabra).toBe("polo");
    expect(senal(neutro({ glosas: ["ZAPATILLA", "POLO"] }), "S1")).toMatchObject({ palabra: "polo" });
  });

  it("la categoría de la sugerencia es la de la palabra elegida", () => {
    const r = neutro({ glosas: ["peluche", "zapatilla"] });
    expect(r.palabra).toBe("peluche");
    expect(r.categoria).toBe("juguetes");
  });

  it("una excepción anula la palabra en su ítem: «zapatilla de seguridad» no puntúa", () => {
    const r = neutro({ glosas: ["zapatilla de seguridad"] });
    expect(r.puntaje).toBe(0);
    expect(r.senales).toEqual([]);
    expect(r.palabra).toBeNull();
    expect(r.categoria).toBeNull();
  });

  it("la excepción de un ítem no anula la palabra de otro ítem", () => {
    const r = neutro({ glosas: ["zapatilla urbana", "casco de seguridad"] });
    expect(senal(r, "S1")).toMatchObject({ puntos: 3, items: { coinciden: 1, total: 2 } });
  });

  it("un ítem anulado por excepción no cuenta en «n de m»", () => {
    const r = neutro({ glosas: ["zapatilla de seguridad", "zapatilla urbana"] });
    expect(senal(r, "S1")).toMatchObject({ puntos: 3, items: { coinciden: 1, total: 2 } });
    expect(r.palabra).toBe("zapatilla");
  });

  it("«polo a tierra» no puntúa; «zapata de concreto» tampoco (CA-4)", () => {
    expect(neutro({ glosas: ["polo a tierra"] }).puntaje).toBe(0);
    expect(neutro({ glosas: ["zapata de concreto"] }).puntaje).toBe(0);
  });

  it("sin glosas o sin coincidencias: sin S1 y palabra y categoría nulas", () => {
    for (const glosas of [[], SIN_COINCIDENCIA, [""]]) {
      const r = neutro({ glosas });
      expect(r.puntaje).toBe(0);
      expect(r.senales).toEqual([]);
      expect(r.palabra).toBeNull();
      expect(r.categoria).toBeNull();
    }
  });

  it("la señal de S1 nunca pasa de +6 aunque haya 20 ítems", () => {
    const r = neutro({ glosas: Array.from({ length: 20 }, () => "zapatilla") });
    expect(senal(r, "S1")).toMatchObject({ puntos: 6, items: { coinciden: 20, total: 20 } });
  });
});

describe("CA-5 · S2 rubro del proveedor no relacionado (+3)", () => {
  const conCiiu = (cliente: string | null, proveedor: string | null): Partial<ContextoPlano> => ({
    ciiuCliente: cliente,
    ciiuProveedores: [{ proveedor: { ...PROV }, ciiu: proveedor }],
  });

  it("proveedor de la lista base (4771) y grupo distinto del cliente (475): +3", () => {
    const r = puntuar({ glosas: SIN_COINCIDENCIA }, conCiiu("4752", "4771"));
    expect(r.puntaje).toBe(3);
    expect(codigos(r)).toEqual(["S2"]);
    expect(r.palabra).toBeNull();
  });

  it("restaurante (5610) para un cliente que no lo es: +3", () => {
    expect(puntuar({ glosas: SIN_COINCIDENCIA }, conCiiu("4752", "5610")).puntaje).toBe(3);
  });

  it("el mismo grupo de 3 dígitos (4771 y 4772): 0", () => {
    expect(puntuar({ glosas: SIN_COINCIDENCIA }, conCiiu("4772", "4771")).puntaje).toBe(0);
    expect(puntuar({ glosas: SIN_COINCIDENCIA }, conCiiu("4771", "4771")).puntaje).toBe(0);
  });

  it("un rubro que no está en la lista base (ferretería 4752) no suma", () => {
    expect(puntuar({ glosas: SIN_COINCIDENCIA }, conCiiu("4771", "4752")).puntaje).toBe(0);
  });

  it("sin CIIU del proveedor, sin su fila o sin CIIU del cliente: 0", () => {
    expect(puntuar({ glosas: SIN_COINCIDENCIA }, conCiiu("4752", null)).puntaje).toBe(0);
    expect(puntuar({ glosas: SIN_COINCIDENCIA }, { ciiuProveedores: [] }).puntaje).toBe(0);
    expect(puntuar({ glosas: SIN_COINCIDENCIA }, conCiiu(null, "4771")).puntaje).toBe(0);
  });

  it("el CIIU de otro proveedor no se aplica", () => {
    expect(puntuar({ glosas: SIN_COINCIDENCIA }, { ciiuProveedores: [{ proveedor: { ...OTRO_PROV }, ciiu: "4771" }] }).puntaje).toBe(0);
  });
});

describe("CA-5 · S3 categoría no permitida para el giro (+2 una vez por compra)", () => {
  const ferreteria = (over: Partial<ContextoPlano> = {}): Partial<ContextoPlano> => ({ ciiuProveedores: [], ...over });

  it("cliente de sección G sin ajuste: +2 aunque haya dos categorías no permitidas (una vez por compra)", () => {
    const r = puntuar({ glosas: ["zapatilla", "perfume"], fechaEmision: null }, ferreteria());
    expect(senal(r, "S3")).toMatchObject({ puntos: 2 });
    expect(r.senales.filter((s) => s.codigo === "S3")).toHaveLength(1);
    expect(r.puntaje).toBe(6 + 2);
  });

  it("la categoría de S3 es la menor en orden de código entre las no permitidas", () => {
    const r = puntuar({ glosas: ["perfume", "zapatilla"], fechaEmision: null }, ferreteria());
    expect(senal(r, "S3")).toMatchObject({ categoria: "calzado-ropa" });
  });

  it("permitir una de las dos deja S3 con la otra; permitir las dos lo quita", () => {
    const una = puntuar(
      { glosas: ["zapatilla", "perfume"], fechaEmision: null },
      ferreteria({ categoriasCliente: { permitidas: ["calzado-ropa"], quitadas: [] } }),
    );
    expect(senal(una, "S3")).toMatchObject({ puntos: 2, categoria: "cuidado-personal" });
    const dos = puntuar(
      { glosas: ["zapatilla", "perfume"], fechaEmision: null },
      ferreteria({ categoriasCliente: { permitidas: ["calzado-ropa", "cuidado-personal"], quitadas: [] } }),
    );
    expect(senal(dos, "S3")).toBeUndefined();
    expect(dos.puntaje).toBe(6);
  });

  it("cliente de sección C (manufactura) sin ajuste: +2; con la categoría permitida en el ajuste: 0 (D-6)", () => {
    expect(codigos(puntuar({ glosas: ["zapatilla"], fechaEmision: null }, ferreteria({ ciiuCliente: "1410" })))).toEqual(["S1", "S3"]);
    const permitida = puntuar(
      { glosas: ["zapatilla"], fechaEmision: null },
      ferreteria({ ciiuCliente: "1410", categoriasCliente: { permitidas: ["calzado-ropa"], quitadas: [] } }),
    );
    expect(codigos(permitida)).toEqual(["S1"]);
  });

  it("categoría permitida por la matriz base (alimentos-personales en un restaurante, sección I): 0; quitada en el ajuste: +2", () => {
    const base = puntuar({ glosas: ["chocolate"], fechaEmision: null }, ferreteria({ ciiuCliente: "5610" }));
    expect(senal(base, "S3")).toBeUndefined();
    expect(base.puntaje).toBe(3);
    const quitada = puntuar(
      { glosas: ["chocolate"], fechaEmision: null },
      ferreteria({ ciiuCliente: "5610", categoriasCliente: { permitidas: [], quitadas: ["alimentos-personales"] } }),
    );
    expect(senal(quitada, "S3")).toMatchObject({ puntos: 2, categoria: "alimentos-personales" });
    expect(quitada.puntaje).toBe(5);
  });

  it("cliente sin CIIU y sin ajuste: 0; con una categoría quitada en el ajuste: +2 (R-13)", () => {
    expect(senal(neutro({ glosas: ["zapatilla"] }), "S3")).toBeUndefined();
    const quitada = neutro({ glosas: ["zapatilla"] }, { categoriasCliente: { permitidas: [], quitadas: ["calzado-ropa"] } });
    expect(senal(quitada, "S3")).toMatchObject({ puntos: 2, categoria: "calzado-ropa" });
  });

  it("sin palabra coincidente no hay S3, ni en sección G", () => {
    expect(senal(puntuar({ glosas: SIN_COINCIDENCIA, fechaEmision: null }, ferreteria()), "S3")).toBeUndefined();
  });

  it("una palabra anulada por excepción no genera S3", () => {
    expect(senal(puntuar({ glosas: ["zapatilla de seguridad"], fechaEmision: null }, ferreteria()), "S3")).toBeUndefined();
  });
});

describe("CA-5 · S4 fecha de emisión no laborable con comercio minorista o restaurante (+1)", () => {
  const prov = (ciiu: string | null): Partial<ContextoPlano> => ({ ciiuCliente: null, ciiuProveedores: [{ proveedor: { ...PROV }, ciiu }] });
  const r = (fechaEmision: string | null, ciiu: string | null) => puntuar({ glosas: SIN_COINCIDENCIA, fechaEmision }, prov(ciiu));

  it.each([
    ["sábado", FECHA_SABADO],
    ["domingo", FECHA_DOMINGO],
    ["feriado de la lista (martes)", FECHA_FERIADO],
  ])("restaurante (5610) en %s: +1", (_n, fecha) => {
    const x = r(fecha, "5610");
    expect(x.puntaje).toBe(1);
    expect(codigos(x)).toEqual(["S4"]);
    expect(senal(x, "S4")).toMatchObject({ puntos: 1 });
  });

  it("comercio minorista (4771) en fin de semana: +1", () => {
    expect(r(FECHA_SABADO, "4771").puntaje).toBe(1);
  });

  it("un proveedor que no es minorista ni restaurante (mayorista 4663) en sábado o feriado: 0", () => {
    expect(r(FECHA_SABADO, "4663").puntaje).toBe(0);
    expect(r(FECHA_FERIADO, "4663").puntaje).toBe(0);
  });

  it("día hábil: 0", () => {
    expect(r(FECHA_HABIL, "5610").puntaje).toBe(0);
  });

  it("sin CIIU del proveedor o sin fecha de emisión: 0", () => {
    expect(r(FECHA_SABADO, null).puntaje).toBe(0);
    expect(r(null, "5610").puntaje).toBe(0);
  });

  it("año sin lista: solo cuenta el fin de semana (2028)", () => {
    expect(r("2028-03-11", "5610").puntaje).toBe(1); // sábado
    expect(r("2028-12-25", "5610").puntaje).toBe(0); // Navidad, lunes: sin lista
  });
});

describe("CA-5 · S5 proveedor nuevo (+1)", () => {
  it("proveedor nuevo: +1; conocido: 0", () => {
    const nuevo = neutro({ glosas: SIN_COINCIDENCIA, esNuevo: true });
    expect(nuevo.puntaje).toBe(1);
    expect(codigos(nuevo)).toEqual(["S5"]);
    expect(neutro({ glosas: SIN_COINCIDENCIA, esNuevo: false }).puntaje).toBe(0);
  });
});

describe("CA-5 · S6 historial de exclusiones (+4) y S7 historial de aceptación (−4)", () => {
  const h = (aceptadas6: number, excluidas6: number, excluidas12: number): Partial<ContextoPlano> => ({ historial: hist(aceptadas6, excluidas6, excluidas12) });

  it("S6: 2 excluidas en los 12 periodos anteriores: +4", () => {
    const r = neutro({ glosas: SIN_COINCIDENCIA }, h(0, 0, 2));
    expect(r.puntaje).toBe(4);
    expect(codigos(r)).toEqual(["S6"]);
  });

  it("S6: 1 excluida no suma; 3 o 5 suman +4 una sola vez", () => {
    expect(neutro({ glosas: SIN_COINCIDENCIA }, h(0, 0, 1)).puntaje).toBe(0);
    expect(neutro({ glosas: SIN_COINCIDENCIA }, h(0, 2, 3)).puntaje).toBe(4);
    expect(neutro({ glosas: SIN_COINCIDENCIA }, h(0, 5, 5)).puntaje).toBe(4);
  });

  it("S7: 3 aceptadas en 6 periodos y ninguna excluida: −4 (el puntaje puede ser negativo)", () => {
    const r = neutro({ glosas: SIN_COINCIDENCIA }, h(3, 0, 0));
    expect(r.puntaje).toBe(-4);
    expect(codigos(r)).toEqual(["S7"]);
  });

  it("S7: 2 aceptadas no bajan; 3 aceptadas con una excluida en los 6 periodos tampoco", () => {
    expect(neutro({ glosas: SIN_COINCIDENCIA }, h(2, 0, 0)).puntaje).toBe(0);
    expect(neutro({ glosas: SIN_COINCIDENCIA }, h(3, 1, 1)).puntaje).toBe(0);
  });

  it("S6 y S7 nunca a la vez: con 2 excluidas en 12 meses (ninguna en 6) y 5 aceptadas, solo S6", () => {
    const r = neutro({ glosas: SIN_COINCIDENCIA }, h(5, 0, 2));
    expect(codigos(r)).toEqual(["S6"]);
    expect(r.puntaje).toBe(4);
  });

  it.each([
    [0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0], [6, 0, 0], [3, 1, 1], [3, 0, 2], [3, 2, 2], [0, 0, 2], [6, 3, 5], [4, 0, 1],
  ])("aceptadas6=%i excluidas6=%i excluidas12=%i: no hay S6 y S7 a la vez", (a, e6, e12) => {
    const c = codigos(neutro({ glosas: SIN_COINCIDENCIA }, h(a, e6, e12)));
    expect(c.includes("S6") && c.includes("S7")).toBe(false);
  });
});

describe("todas las señales juntas · orden S1…S7 y suma", () => {
  it("S1 + S2 + S3 + S4 + S5 + S6 = 14, en orden de código", () => {
    const r = puntuar({ glosas: ["ZAPATILLA"], fechaEmision: FECHA_SABADO, esNuevo: true }, { historial: hist(0, 2, 2) });
    expect(r.puntaje).toBe(3 + 3 + 2 + 1 + 1 + 4);
    expect(codigos(r)).toEqual(["S1", "S2", "S3", "S4", "S5", "S6"]);
  });

  it("S1 + S2 + S3 + S4 + S5 − S7 = 10, con S7 al final", () => {
    const r = puntuar({ glosas: ["ZAPATILLA"], fechaEmision: FECHA_SABADO, esNuevo: true }, { historial: hist(3, 0, 0) });
    expect(r.puntaje).toBe(3 + 3 + 2 + 1 + 1 - 4);
    expect(codigos(r)).toEqual(["S1", "S2", "S3", "S4", "S5", "S7"]);
  });
});

describe("CA-6 y R-5 · entrada no muta, determinismo y sin texto de la glosa", () => {
  it("la entrada y el contexto congelados no lanzan y el resultado es el mismo en dos llamadas", () => {
    const e = congelar(entrada({ glosas: ["ZAPATILLA", "polo"], esNuevo: true }));
    const c = congelar(contextoGastos({ historial: hist(3, 0, 0) }));
    const a = puntuarGastoPersonal(e, c);
    const b = puntuarGastoPersonal(e, c);
    expect(b).toEqual(a);
  });

  it("no muta los arreglos recibidos", () => {
    const glosas = ["ZAPATILLA", "polo"];
    const copia = [...glosas];
    puntuarGastoPersonal(entrada({ glosas }), contextoGastos());
    expect(glosas).toEqual(copia);
  });

  it("el resultado no copia texto de la glosa salvo la palabra del diccionario (<script>, canarios)", () => {
    const r = puntuar({ glosas: ["ZAPATILLAS <script>alert(1)</script> CANARIO-URBANAS"] });
    const json = JSON.stringify(r).toLowerCase();
    for (const prohibido of ["script", "alert", "canario", "urbanas"]) expect(json).not.toContain(prohibido);
    expect(r.palabra).toBe("zapatilla");
  });
});
