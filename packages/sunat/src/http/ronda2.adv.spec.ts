/**
 * Spec 041 · T13 · Ronda adversarial 2 (CAJA BLANCA). Ataques sacados de la implementación de `sire-api-client.http.ts`,
 * `transporte.ts`, `ticket.ts`, `almacen-tickets.ts` y `zip-seguro.ts`: limpieza del ticket guardado, presupuesto
 * total frente al timeout por petición, forma de la clave de reanudación, memoria entre partes y codificación entre partes.
 * Todo contra el servidor SUNAT falso en 127.0.0.1 con fixtures sintéticos; nada sale a internet ni duerme.
 */
import { randomBytes } from "node:crypto";
import { zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AlmacenTicketsMemoria,
  ErrorDatos,
  ErrorPortalSire,
  ErrorTransitorio,
  HttpSireApiClient,
  HttpSireAuth,
  TokenRechazadoError,
  type AlmacenTicketsSire,
  type LibroSire,
  type PropuestaSire,
  type TokenSire,
} from "../index.js";
import {
  CANARIOS,
  PERIODO,
  RUC,
  RUTAS,
  SECRETOS,
  archivo,
  credencial,
  crearEntorno,
  cuerpoTicket,
  cuerpoToken,
  fixture,
  registroTicket,
  relojVirtual,
  sinSecretos,
  zip,
  type EntornoFalso,
  type RelojVirtual,
} from "./pruebas/ayudas-http.js";
import { conCelda, leerTabla, soloFilas } from "./pruebas/ayudas-txt.js";

const TOKEN: TokenSire = { token: CANARIOS.token, expiraEn: new Date("2026-11-27T16:00:00.000Z") };
const TXT_C = "20700000002-20261101-1030-propuesta.txt";
const COMPRAS = () => fixture("compras-propuesta-202610.txt");
const CLAVE = "tenant-a:cliente-1";

let ent: EntornoFalso;
let reloj: RelojVirtual;
beforeEach(async () => {
  ent = await crearEntorno();
  reloj = relojVirtual();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await ent.cerrar();
});

/** Almacén en memoria que además anota cada llamada (clave y valor). */
class AlmacenEspia implements AlmacenTicketsSire {
  readonly llamadas: string[] = [];
  readonly interno: AlmacenTicketsMemoria;
  constructor(ahora: () => Date) {
    this.interno = new AlmacenTicketsMemoria(ahora);
  }
  leer(clave: string): Promise<string | null> {
    this.llamadas.push(`leer ${clave}`);
    return this.interno.leer(clave);
  }
  guardar(clave: string, numTicket: string, ttlMs: number): Promise<void> {
    this.llamadas.push(`guardar ${clave}=${numTicket} ttl=${ttlMs}`);
    return this.interno.guardar(clave, numTicket, ttlMs);
  }
  borrar(clave: string): Promise<void> {
    this.llamadas.push(`borrar ${clave}`);
    return this.interno.borrar(clave);
  }
}

function cliente(almacen?: AlmacenTicketsSire, f?: typeof fetch): HttpSireApiClient {
  return new HttpSireApiClient({
    urlsDePrueba: ent.urlsDePrueba,
    ahora: reloj.ahora,
    dormir: reloj.dormir,
    ...(almacen === undefined ? {} : { almacenTickets: almacen }),
    ...(f === undefined ? {} : { fetch: f }),
  });
}

async function intentar(p: Promise<PropuestaSire>): Promise<{ r?: PropuestaSire; e?: unknown }> {
  try {
    return { r: await p };
  } catch (e) {
    return { e };
  }
}

function forma(x: { r?: PropuestaSire; e?: unknown }): string {
  if (x.r !== undefined) return `ok(${x.r.filas.length} filas)`;
  const e = x.e as { constructor?: { name?: string }; detalle?: unknown };
  return `${e.constructor?.name ?? typeof e}:${String(e.detalle ?? "-")}`;
}

/** Exportar con tickets `T1`, `T2`… (cuenta las exportaciones). */
function guionarExportar(libro: LibroSire = "compras", periodo = PERIODO): () => number {
  let n = 0;
  ent.sire.guionar("GET", libro === "compras" ? RUTAS.exportarRce(periodo) : RUTAS.exportarRvie(periodo), () => ({
    json: { numTicket: `T${++n}` },
  }));
  return () => n;
}
/** Ticket listo con una parte, para el `numTicket` que se consulte. */
function ticketListo(nombres: string[] = ["p1.zip"]) {
  return (p: { query: Record<string, string> }) => ({
    json: cuerpoTicket([registroTicket(p.query["numTicket"] ?? "", "04", nombres.map((n) => archivo(n)))]),
  });
}
const zipCompras = () => zip(TXT_C, COMPRAS());
const pedir = (c: HttpSireApiClient, claveReanudacion: string | undefined = CLAVE, libro: LibroSire = "compras", periodo = PERIODO) =>
  c.descargarPropuesta(TOKEN, {
    ruc: RUC,
    periodo,
    libro,
    ...(claveReanudacion === undefined ? {} : { claveReanudacion }),
  });

// ── Limpieza y conservación del ticket guardado (P-4 c, CA-8) ───────────────────────────────────────────────
describe("adv2 · el reintento retoma el ticket sin exportar de nuevo", () => {
  it("401 en la PRIMERA consulta del ticket recién exportado: la renovación de 008 no debe exportar otra vez", async () => {
    const exportes = guionarExportar();
    ent.sire.guionar("GET", RUTAS.ticket, { estado: 401, json: { cod: "401" } }, ticketListo());
    ent.sire.guionar("GET", RUTAS.archivo, { bytes: zipCompras() });
    const almacen = new AlmacenEspia(reloj.ahora);

    // Intento 1 (token viejo) → TokenRechazadoError; `conToken` renueva y vuelve a llamar con la MISMA clave.
    const x1 = await intentar(pedir(cliente(almacen)));
    expect(x1.e).toBeInstanceOf(TokenRechazadoError);
    const x2 = await intentar(pedir(cliente(almacen)));
    expect(forma(x2)).toMatch(/^ok\(/);
    expect(exportes(), `exportaciones (almacén: ${almacen.llamadas.join(" · ")})`).toBe(1);
  });

  it("503 / ECONNRESET en la primera consulta del ticket recién exportado: el reintento de 008 no debe exportar otra vez", async () => {
    const fallos: string[] = [];
    for (const [caso, mala] of [
      ["503", { estado: 503 }],
      ["ECONNRESET", { cortar: true as const }],
    ] as const) {
      ent.sire.reiniciar();
      const exportes = guionarExportar();
      ent.sire.guionar("GET", RUTAS.ticket, mala, ticketListo());
      ent.sire.guionar("GET", RUTAS.archivo, { bytes: zipCompras() });
      const almacen = new AlmacenEspia(reloj.ahora);
      const x1 = await intentar(pedir(cliente(almacen)));
      if (!(x1.e instanceof ErrorTransitorio)) fallos.push(`${caso}: intento 1 -> ${forma(x1)}`);
      const x2 = await intentar(pedir(cliente(almacen)));
      if (x2.r === undefined) fallos.push(`${caso}: intento 2 -> ${forma(x2)}`);
      if (exportes() !== 1) fallos.push(`${caso}: ${exportes()} exportaciones`);
    }
    expect(fallos).toEqual([]);
  });

  it("ticket LISTO y 503 al bajar la parte: el ticket ya se borró del almacén y el reintento exporta de nuevo", async () => {
    const exportes = guionarExportar();
    ent.sire.guionar("GET", RUTAS.ticket, ticketListo());
    ent.sire.guionar("GET", RUTAS.archivo, { estado: 503 }, { bytes: zipCompras() });
    const almacen = new AlmacenEspia(reloj.ahora);

    const x1 = await intentar(pedir(cliente(almacen)));
    expect(x1.e).toBeInstanceOf(ErrorTransitorio);
    const x2 = await intentar(pedir(cliente(almacen)));
    expect(forma(x2)).toMatch(/^ok\(/);
    expect(exportes(), `exportaciones (almacén: ${almacen.llamadas.join(" · ")})`).toBe(1);
  });

  it("presupuesto agotado entre «ticket listo» y la descarga: ErrorTransitorio timeout pero el ticket ya no está guardado", async () => {
    const exportes = guionarExportar();
    ent.sire.guionar("GET", RUTAS.ticket, ticketListo());
    ent.sire.guionar("GET", RUTAS.archivo, { bytes: zipCompras() });
    const almacen = new AlmacenEspia(reloj.ahora);
    let lento = true;
    // La consulta del ticket «tarda» 95 s (más que el presupuesto de 90 s) solo en el primer intento.
    const fetchLento: typeof fetch = async (url, init) => {
      const r = await globalThis.fetch(url, init);
      if (lento && String(url).includes("consultaestadotickets")) {
        lento = false;
        reloj.avanzar(95_000);
      }
      return r;
    };
    const x1 = await intentar(pedir(cliente(almacen, fetchLento)));
    expect(x1.e).toBeInstanceOf(ErrorTransitorio);
    expect(ent.sire.peticionesDe("GET", RUTAS.archivo)).toHaveLength(0);
    const x2 = await intentar(pedir(cliente(almacen, fetchLento)));
    expect(forma(x2)).toMatch(/^ok\(/);
    expect(exportes(), `exportaciones (almacén: ${almacen.llamadas.join(" · ")})`).toBe(1);
  });

  it("ticket guardado que SUNAT ya no lista: no debe volverse ErrorDatos (permanente; 025 lo contaría «sin datos»)", async () => {
    const exportes = guionarExportar();
    // El portal ya no conoce el ticket viejo (vencido o purgado): responde sin registros para él.
    ent.sire.guionar("GET", RUTAS.ticket, (p) =>
      p.query["numTicket"] === "VIEJO1"
        ? { json: cuerpoTicket([]) }
        : { json: cuerpoTicket([registroTicket(p.query["numTicket"] ?? "", "04", [archivo("p1.zip")])]) },
    );
    ent.sire.guionar("GET", RUTAS.archivo, { bytes: zipCompras() });
    const almacen = new AlmacenEspia(reloj.ahora);
    // Clave de 5 partes del plan (H-4): {tenant}:{cliente}:{libro}:{periodo}:{operacion}.
    const claveAlmacen = `${CLAVE}:compras:${PERIODO}:propuesta`;
    await almacen.interno.guardar(claveAlmacen, "VIEJO1", 3_600_000);

    const x = await intentar(pedir(cliente(almacen)));
    expect(x.e, `resultado ${forma(x)}; exportaciones ${exportes()}`).not.toBeInstanceOf(ErrorDatos);
    // Decisión de la ronda 2: el ticket guardado SÍ se consulta; como SUNAT no lo lista, se borra y se exporta
    // una vez más en el mismo intento, y el flujo sigue con el ticket nuevo.
    const consultados = ent.sire.peticionesDe("GET", RUTAS.ticket).map((p) => p.query["numTicket"]);
    expect(consultados[0], `tickets consultados: ${consultados.join(", ")}`).toBe("VIEJO1");
    expect(almacen.llamadas, almacen.llamadas.join(" · ")).toContain(`borrar ${claveAlmacen}`);
    expect(exportes()).toBe(1);
    expect(forma(x)).toMatch(/^ok\(/);
  });
});

// ── Clave de reanudación ────────────────────────────────────────────────────────────────────────────────────
describe("adv2 · clave del almacén", () => {
  it("la clave que el cliente entrega al almacén nombra la operación (propuesta ≠ registro presentado de compras)", async () => {
    // importar-historial (025) pasa la MISMA claveReanudacion «{tenant}:{cliente}» que descargar-propuesta; sin la operación,
    // el ticket de la propuesta de compras y el del registro presentado del mismo periodo comparten clave.
    guionarExportar();
    ent.sire.guionar("GET", RUTAS.ticket, { json: cuerpoTicket([registroTicket("T1", "02")]) });
    const almacen = new AlmacenEspia(reloj.ahora);
    const x = await intentar(pedir(cliente(almacen)));
    expect(x.e).toBeInstanceOf(ErrorTransitorio);
    const guardadas = almacen.llamadas.filter((l) => l.startsWith("guardar "));
    expect(guardadas).toHaveLength(1);
    const clave = guardadas[0]!.slice("guardar ".length).split("=")[0]!;
    expect(clave.split(":"), clave).toHaveLength(5);
    expect(clave.endsWith(":propuesta"), clave).toBe(true);
  });

  it("un ticket pendiente no se retoma con otro estudio, cliente, libro ni periodo, y el almacén no ve secretos", async () => {
    const exportesC = guionarExportar("compras");
    const exportesV = guionarExportar("ventas");
    const exportesC9 = guionarExportar("compras", "202609");
    ent.sire.guionar("GET", RUTAS.ticket, (p) => ({ json: cuerpoTicket([registroTicket(p.query["numTicket"] ?? "", "02")]) }));
    const almacen = new AlmacenEspia(reloj.ahora);
    const base = await intentar(pedir(cliente(almacen)));
    expect(base.e).toBeInstanceOf(ErrorTransitorio);
    const casos: Array<[string, string, LibroSire, string]> = [
      ["otro estudio", "tenant-b:cliente-1", "compras", PERIODO],
      ["otro cliente", "tenant-a:cliente-2", "compras", PERIODO],
      ["otro libro", CLAVE, "ventas", PERIODO],
      ["otro periodo", CLAVE, "compras", "202609"],
    ];
    for (const [, clave, libro, periodo] of casos) {
      const x = await intentar(pedir(cliente(almacen), clave, libro, periodo));
      expect(x.e).toBeInstanceOf(ErrorTransitorio);
      sinSecretos(x.e);
    }
    expect([exportesC(), exportesV(), exportesC9()]).toEqual([3, 1, 1]);
    const visto = almacen.llamadas.join("\n");
    for (const s of SECRETOS) expect(visto).not.toContain(s);
  });
});

// ── Presupuesto total vs timeout por petición (P-8, CA-11) ──────────────────────────────────────────────────
describe("adv2 · presupuesto de la operación", () => {
  it("el timeout de cada petición no pasa de lo que queda del presupuesto de 90 s", async () => {
    guionarExportar();
    ent.sire.guionar("GET", RUTAS.ticket, ticketListo());
    ent.sire.guionar("GET", RUTAS.archivo, { bytes: zipCompras() });
    const timeouts: number[] = [];
    const original = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      timeouts.push(ms);
      return original(ms);
    });
    // La consulta del ticket «tarda» 85 s: quedan 5 s del presupuesto para descargar.
    const fetchLento: typeof fetch = async (url, init) => {
      const r = await globalThis.fetch(url, init);
      if (String(url).includes("consultaestadotickets")) reloj.avanzar(85_000);
      return r;
    };
    const x = await intentar(pedir(cliente(undefined, fetchLento)));
    expect(forma(x)).toMatch(/^ok\(|ErrorTransitorioSire/);
    // Peticiones: exportar, ticket, archivo. La del archivo empieza con 5 s de presupuesto restante.
    expect(timeouts.length).toBeGreaterThanOrEqual(3);
    expect(timeouts[2], `timeouts pedidos: ${timeouts.join(", ")}`).toBeLessThanOrEqual(5_000);
  });
});

// ── Memoria entre partes (CA-9, CA-10, CA-14) ───────────────────────────────────────────────────────────────
describe("adv2 · varias partes y memoria", () => {
  it("parte 1 corrupta: se detiene sin bajar (y retener) las partes siguientes", async () => {
    guionarExportar();
    ent.sire.guionar("GET", RUTAS.ticket, ticketListo(["p1.zip", "p2.zip", "p3.zip"]));
    ent.sire.guionar("GET", RUTAS.archivo, (p) =>
      p.query["nomArchivoReporte"] === "p1.zip" ? { bytes: randomBytes(4096) } : { bytes: zipCompras() },
    );
    const x = await intentar(pedir(cliente()));
    expect(x.e).toBeInstanceOf(ErrorPortalSire);
    expect(ent.sire.peticionesDe("GET", RUTAS.archivo).map((p) => p.query["nomArchivoReporte"])).toEqual(["p1.zip"]);
  });

  // CA-10 (decisión del usuario): tope de 64 MiB descomprimidos POR PARTE y 256 MiB ACUMULADOS en el periodo.
  // Relleno ASCII en una columna que no se mapea: en cada bloque de 16 KiB, 1 KiB hex aleatorio y el resto «A»
  // (razón ≈ 30:1, lejos de 200:1; cada ZIP de 60 MiB queda en ~2 MiB). Se arma una vez y se comparte entre partes.
  const relleno = (bytes: number): string => {
    const b = Buffer.alloc(bytes, 0x41);
    for (let o = 0; o < bytes; o += 16 * 1024) b.write(randomBytes(512).toString("hex"), o, "latin1");
    return b.toString("latin1");
  };
  const parteCon = (fila: number, r: string) =>
    zipSync({ [TXT_C]: [conCelda(soloFilas(COMPRAS(), [fila]), 1, "CAR SUNAT", r), { level: 1 }] });
  const servirPartes = (partes: Uint8Array[]) => {
    const nombres = partes.map((_, i) => `p${i + 1}.zip`);
    guionarExportar();
    ent.sire.guionar("GET", RUTAS.ticket, ticketListo(nombres));
    ent.sire.guionar("GET", RUTAS.archivo, (p) => ({ bytes: partes[nombres.indexOf(p.query["nomArchivoReporte"] ?? "")]! }));
    return nombres;
  };

  it("dos partes de 33 MiB descomprimidos (66 MiB acumulados) se aceptan: el tope de 64 MiB es por parte", async () => {
    const r = relleno(33 * 1024 * 1024);
    servirPartes([parteCon(1, r), parteCon(2, r)]);
    const x = await intentar(pedir(cliente()));
    expect(forma(x)).toBe("ok(2 filas)");
  }, 60_000);

  it("partes de 60 MiB (cada una bajo 64 MiB) que acumulan > 256 MiB -> zip_invalido al cruzar el tope, sin pedir más", async () => {
    const r = relleno(60 * 1024 * 1024);
    const partes = [1, 2, 3, 4, 5, 6].map((f) => parteCon(f, r));
    for (const p of partes) expect(p.length).toBeLessThan(8 * 1024 * 1024);
    servirPartes(partes);
    const x = await intentar(pedir(cliente()));
    expect(forma(x)).toBe("ErrorPortalSire:zip_invalido");
    // 4 × 60 = 240 MiB caben; la 5.ª (300 MiB acumulados) cruza los 256 MiB: se corta ahí y la 6.ª no se pide (H-6).
    expect(ent.sire.peticionesDe("GET", RUTAS.archivo).map((p) => p.query["nomArchivoReporte"])).toEqual([
      "p1.zip",
      "p2.zip",
      "p3.zip",
      "p4.zip",
      "p5.zip",
    ]);
  }, 120_000);
});

// ── Codificación entre partes (CA-4, CA-5, P-6) ─────────────────────────────────────────────────────────────
describe("adv2 · codificación entre partes", () => {
  it("parte 1 sin BOM y LF, parte 2 con BOM (o doble BOM) y CRLF: mismas filas que en una sola parte", async () => {
    const total = leerTabla(COMPRAS()).lineas.length - 1;
    const filas = Array.from({ length: total }, (_, i) => i + 1);
    const mitad = Math.ceil(total / 2);
    const p1 = soloFilas(COMPRAS(), filas.slice(0, mitad));
    const p2lf = Buffer.from(soloFilas(COMPRAS(), filas.slice(mitad))).toString("utf8").replace(/^﻿/, "");
    const p2crlf = p2lf.replace(/\n/g, "\r\n");

    guionarExportar();
    ent.sire.guionar("GET", RUTAS.ticket, ticketListo(["p1.zip"]));
    ent.sire.guionar("GET", RUTAS.archivo, { bytes: zipCompras() });
    const una = await pedir(cliente(), undefined);

    const fallos: string[] = [];
    for (const [caso, texto2] of [
      ["BOM+CRLF", `﻿${p2crlf}`],
      ["doble BOM+CRLF", `﻿﻿${p2crlf}`],
    ] as const) {
      ent.sire.reiniciar();
      guionarExportar();
      ent.sire.guionar("GET", RUTAS.ticket, ticketListo(["p1.zip", "p2.zip"]));
      const z1 = zip(TXT_C, p1);
      const z2 = zip(TXT_C, new Uint8Array(Buffer.from(texto2, "utf8")));
      ent.sire.guionar("GET", RUTAS.archivo, (p) => ({ bytes: p.query["nomArchivoReporte"] === "p1.zip" ? z1 : z2 }));
      const x = await intentar(pedir(cliente(), undefined));
      if (x.r === undefined) fallos.push(`${caso} -> ${forma(x)}`);
      else if (JSON.stringify(x.r.filas) !== JSON.stringify(una.filas)) fallos.push(`${caso} -> filas distintas`);
    }
    expect(fallos).toEqual([]);
  });
});

// ── Tope de 24 h de expires_in (H-041-1-2) ──────────────────────────────────────────────────────────────────
describe("adv2 · expires_in en el borde", () => {
  it("86400 s se acepta (expiraEn = +24 h exactas); 86401, 86400.5 y 0 no", async () => {
    const fallos: string[] = [];
    for (const [valor, ok] of [
      [86_400, true],
      [86_401, false],
      [86_400.5, false],
      [0, false],
    ] as const) {
      ent.seguridad.reiniciar();
      ent.seguridad.guionar("POST", RUTAS.token(), { json: cuerpoToken({ expires_in: valor }) });
      const a = new HttpSireAuth({ urlsDePrueba: ent.urlsDePrueba, ahora: reloj.ahora });
      try {
        const t = await a.obtenerToken(credencial());
        const delta = t.expiraEn.getTime() - reloj.ahora().getTime();
        if (!ok) fallos.push(`${valor} aceptado`);
        else if (delta !== valor * 1000) fallos.push(`${valor}: expiraEn a ${delta} ms`);
      } catch (e) {
        if (ok) fallos.push(`${valor} rechazado`);
        else sinSecretos(e);
      }
    }
    expect(fallos).toEqual([]);
  });
});
