/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 007b (T4, rojo): importación de clientes por HTTP (D7 a D9; CA-1, CA-2, CA-8 y la plantilla de T12b).
// Contrato (plan: HTTP; `Cache-Control: no-store`; el cuerpo es el archivo crudo `.xlsx`/`.csv`, `application/octet-stream`,
// ≤ 2 MB; el formato se detecta por el contenido; el estudio sale de la sesión):
//  - GET  /clientes/importacion/plantilla    `clientes.crear` -> 200 `.xlsx` (hoja de datos con la cabecera, sin filas).
//  - POST /clientes/importacion/vista-previa `clientes.crear` -> 200 `VistaPrevia` · 400 `archivo_invalido` |
//    `columnas_faltantes` | `demasiadas_filas` · 413. No escribe nada.
//  - POST /clientes/importacion/confirmar    igual            -> 200 `Informe {creadas, noImportadas[{n, ruc, motivo,
//    archivado?}], consultasEncoladas, consultasOmitidas}`. Revalida todo dentro de la transacción de cupo.
// Cabecera: RUC, Razón social, Usuario SOL, Clave SOL, client_id, client_secret, Responsable (correo del miembro activo
// que puede ser responsable, P1 a). `n` es la fila del archivo (la primera de datos es la 2).
// La regla «credenciales.editar si el archivo trae claves» no se separa de `clientes.crear` con los roles de sistema (quien
// tiene `credenciales.editar` sin `clientes.crear`, el contador, ya recibe 403 por lo segundo): se prueba que el contador
// recibe 403 también con claves, y la combinación fina queda para el servicio (T12).
// Los claves de los archivos son canarios: no pueden salir en respuestas, logs ni archivos del directorio temporal, y las
// guardadas se abren con `abrirSobreMock` (AAD de tenant, cliente y tipo). Rojo: las rutas de vista previa y confirmar
// aún no existen (T12).
import { randomUUID } from "node:crypto";
import { informeImportacionSchema, vistaPreviaSchema } from "@contapp/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  abrirBancoCola,
  abrirSobreMock,
  archivosNuevosConCanario,
  canario,
  filtrados,
  instantaneaTmp,
  pedirBin,
  type Actor,
  type BancoCola,
  type Estudio,
} from "../../../test/soporte-credenciales.js";
import {
  CABECERA,
  csv,
  DOCTYPE_LOLS,
  DOCTYPE_XXE,
  entradasDe,
  filaDatos,
  rucConPrefijo,
  xlsx,
  xlsxBomba,
  xlsxConDatos,
  xlsxConRuta,
  xlsxMilesDeEntradas,
  type DatosFila,
} from "../../../test/soporte-importacion.js";
import { capturarLogs } from "../../../test/soporte.js";
import { leerXlsx } from "./lector-xlsx.js";

const VISTA = "/clientes/importacion/vista-previa";
const CONFIRMAR = "/clientes/importacion/confirmar";
const PLANTILLA = "/clientes/importacion/plantilla";

let b: BancoCola;
let serie = 1 + (process.pid % 997) * 1000;
const ruc = (prefijo = "20") => rucConPrefijo(prefijo, serie++);
const rucMalo = () => {
  const bueno = ruc();
  return `${bueno.slice(0, 10)}${(Number(bueno[10]) + 1) % 10}`;
};

beforeAll(async () => {
  b = await abrirBancoCola();
});
afterAll(async () => {
  await b?.cerrar();
});

const bin = (a: Actor, metodo: "GET" | "POST", ruta: string, bytes?: Uint8Array) =>
  pedirBin(b.c.p.b.h, a, metodo, ruta, bytes);
const previa = (a: Actor, bytes: Uint8Array) => bin(a, "POST", VISTA, bytes);
const confirmar = (a: Actor, bytes: Uint8Array) => bin(a, "POST", CONFIRMAR, bytes);
const nuevoCsv = (datos: DatosFila[], o?: Parameters<typeof csv>[1]) => csv([[...CABECERA], ...datos.map(filaDatos)], o);
const porN = (xs: any[]) => Object.fromEntries(xs.map((x) => [x.n, x]));
const clientesDe = (t: string) =>
  b.sql("select id, ruc, razon_social, archivado_at from cliente where tenant_id = $1 order by created_at, ruc", [t]);
const asignacionesDe = (t: string) => b.sql("select cliente_id, usuario_id, tipo from asignacion where tenant_id = $1", [t]);
const credencialesDe = (t: string) => b.sql("select * from credencial where tenant_id = $1 order by created_at", [t]);

/** Estudio con plan de `maxRucs`, un miembro que puede ser responsable (asistente) y otro que no (lectura). */
async function estudio(maxRucs: number) {
  const E: Estudio = await b.estudioCon(maxRucs);
  const asistente = await b.c.p.b.miembro(E.tenantId, "asistente", { sesion: false });
  const lectura = await b.c.p.b.miembro(E.tenantId, "lectura", { sesion: false });
  return { E, asistente, lectura };
}

describe("plantilla (T12b): GET /clientes/importacion/plantilla", () => {
  it("Dueño y Administrador la descargan: .xlsx con Content-Disposition, no-store y solo la cabecera", async () => {
    const { E } = await estudio(5);
    const admin = await b.c.p.b.miembro(E.tenantId, "admin");
    for (const a of [E.titular, admin]) {
      const r = await bin(a, "GET", PLANTILLA);
      expect(r.status, a.rol).toBe(200);
      expect(String(r.headers["content-type"])).toMatch(/spreadsheetml\.sheet/);
      expect(String(r.headers["content-disposition"])).toMatch(/attachment;.*\.xlsx/);
      expect(r.headers["cache-control"]).toMatch(/no-store/);
      expect(r.bytes.subarray(0, 2).toString("latin1")).toBe("PK");
      expect(Object.keys(entradasDe(r.bytes)).some((n) => n.startsWith("xl/worksheets/"))).toBe(true);
      expect(leerXlsx(r.bytes).filas).toEqual([]); // el lector la acepta y no trae filas de datos
    }
  });

  it("no lleva datos de ningún estudio (razones sociales, RUC ni nombres de miembros)", async () => {
    const { E } = await estudio(5);
    const razon = canario("razon-social");
    const sembrado = await b.c.sembrar(E.tenantId, { razonSocial: razon });
    const r = await bin(E.titular, "GET", PLANTILLA);
    expect(r.status).toBe(200);
    const todo = Object.values(entradasDe(r.bytes)).join("\n");
    expect(todo).not.toContain(razon);
    expect(todo).not.toContain(sembrado.ruc);
    expect(todo).not.toContain(E.tenantId);
    expect(todo).not.toContain(E.titular.correo);
  });

  it("contador, asistente y lectura reciben 403 permiso_denegado", async () => {
    const { E } = await estudio(5);
    for (const rol of ["contador", "asistente", "lectura"] as const) {
      const a = await b.c.p.b.miembro(E.tenantId, rol);
      const r = await bin(a, "GET", PLANTILLA);
      expect(r.status, rol).toBe(403);
      expect(r.json).toEqual({ codigo: "permiso_denegado" });
    }
  });

  it("subirla intacta no crea nada: vista previa sin filas y confirmar con 0 creadas", async () => {
    const { E } = await estudio(5);
    const bytes = (await bin(E.titular, "GET", PLANTILLA)).bytes;
    const v = await previa(E.titular, bytes);
    expect(v.status, v.texto).toBe(200);
    expect(vistaPreviaSchema.safeParse(v.json).success).toBe(true);
    expect(v.json).toMatchObject({ filas: [], validas: 0, conError: 0 });
    const c = await confirmar(E.titular, bytes);
    expect(c.status, c.texto).toBe(200);
    expect(c.json).toMatchObject({ creadas: 0, noImportadas: [] });
    expect(await clientesDe(E.tenantId)).toEqual([]);
  });
});

describe("CA-1 · vista previa: errores por fila, cupo y excedentes, claves como tieneSol/tieneSire (••••), sin escribir", () => {
  it("cada motivo de fila sale con su código; las válidas llevan los indicadores; ninguna clave en la respuesta", async () => {
    const { E, asistente, lectura } = await estudio(6);
    const existente = await b.c.sembrar(E.tenantId, { razonSocial: "Existente SAC" }); // activo: ocupa 1 de 6
    const k = { claveSol: canario("clave-sol"), secreto: canario("client-secret"), otra: canario("clave-incompleta") };
    const r1 = ruc();
    const archivo = xlsxConDatos([
      { ruc: r1, razonSocial: "ACME SAC", usuarioSol: "ACMEUSR", claveSol: k.claveSol, clientId: "id-acme", clientSecret: k.secreto, responsable: asistente.correo }, // 2 válida con ambas
      { ruc: ruc() }, // 3 válida solo RUC
      { ruc: rucMalo() }, // 4 ruc_invalido (dígito verificador)
      { ruc: ruc("11") }, // 5 ruc_invalido (prefijo no permitido)
      { ruc: r1 }, // 6 duplicado_en_archivo
      { ruc: existente.ruc }, // 7 duplicado (existe en el estudio)
      { ruc: ruc(), responsable: `nadie-${randomUUID()}@ejemplo.test` }, // 8 responsable_inexistente
      { ruc: ruc(), responsable: lectura.correo }, // 9 responsable_no_asignable (rol lectura)
      { ruc: ruc(), usuarioSol: "SOLO-USUARIO", claveSol: "" }, // 10 credencial_incompleta (par SOL a medias)
      { ruc: ruc(), clientId: "solo-id", clientSecret: "" }, // 11 credencial_incompleta (par SIRE a medias)
      { ruc: ruc(), razonSocial: "Otra SAC", clientId: "id-2", clientSecret: k.otra }, // 12 válida con SIRE
    ]);
    const antes = await clientesDe(E.tenantId);
    const { resultado: r, logs } = await capturarLogs(() => previa(E.titular, archivo));
    expect(r.status, r.texto).toBe(200);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(vistaPreviaSchema.safeParse(r.json).success, r.texto).toBe(true);
    const f = porN(r.json.filas);
    expect(Object.keys(f).map(Number).sort((a, c) => a - c)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(f[2]).toMatchObject({ ruc: r1, estado: "valida", motivos: [], tieneSol: true, tieneSire: true });
    expect(f[3]).toMatchObject({ estado: "valida", motivos: [], tieneSol: false, tieneSire: false });
    expect(f[4]).toMatchObject({ estado: "error", motivos: ["ruc_invalido"] });
    expect(f[5]).toMatchObject({ estado: "error", motivos: ["ruc_invalido"] });
    expect(f[6]).toMatchObject({ estado: "error", motivos: ["duplicado_en_archivo"] });
    expect(f[7]).toMatchObject({ ruc: existente.ruc, estado: "error", motivos: ["duplicado"] });
    expect(f[8]).toMatchObject({ estado: "error", motivos: ["responsable_inexistente"] });
    expect(f[9]).toMatchObject({ estado: "error", motivos: ["responsable_no_asignable"] });
    expect(f[10]).toMatchObject({ estado: "error", motivos: ["credencial_incompleta"] });
    expect(f[11]).toMatchObject({ estado: "error", motivos: ["credencial_incompleta"] });
    expect(f[12]).toMatchObject({ estado: "valida", motivos: [], tieneSol: false, tieneSire: true });
    expect(r.json).toMatchObject({ validas: 3, conError: 8, cupoLibre: 5, excedentes: 0 });
    // Ninguna clave: ni en el cuerpo, ni en las cabeceras, ni en los logs; los campos de la fila son solo los del contrato.
    expect(filtrados(Object.values(k), r.texto, r.headers, logs)).toEqual([]);
    for (const fila of r.json.filas) {
      expect(Object.keys(fila).sort()).toEqual(expect.arrayContaining(["estado", "motivos", "n", "ruc", "tieneSire", "tieneSol"]));
      expect(Object.keys(fila).every((c) => ["archivado", "estado", "motivos", "n", "ruc", "tieneSire", "tieneSol"].includes(c))).toBe(true);
    }
    // No escribe nada: ni clientes, ni credenciales, ni asignaciones, ni trabajos.
    expect(await clientesDe(E.tenantId)).toEqual(antes);
    expect(await credencialesDe(E.tenantId)).toEqual([]);
    expect(await asignacionesDe(E.tenantId)).toEqual([]);
    expect(await b.trabajos(E.tenantId, "cliente.consultar_ruc")).toEqual([]);
  });

  it("cupo restante y excedentes: 4 válidas con 2 cupos libres dan cupoLibre 2 y excedentes 2", async () => {
    const { E } = await estudio(3);
    await b.c.sembrar(E.tenantId); // 1 de 3
    const r = await previa(E.titular, xlsxConDatos([{ ruc: ruc() }, { ruc: ruc() }, { ruc: ruc() }, { ruc: ruc() }]));
    expect(r.status, r.texto).toBe(200);
    expect(r.json).toMatchObject({ validas: 4, conError: 0, cupoLibre: 2, excedentes: 2 });
  });

  it("un RUC archivado en el estudio es 'duplicado' con archivado: true (sugerir reactivar) y no consume cupo; el activo no lleva la marca", async () => {
    const { E } = await estudio(4);
    const archivado = await b.c.sembrar(E.tenantId, { archivado: true });
    const activo = await b.c.sembrar(E.tenantId);
    const r = await previa(E.titular, xlsxConDatos([{ ruc: archivado.ruc }, { ruc: activo.ruc }, { ruc: ruc() }]));
    expect(r.status, r.texto).toBe(200);
    const f = porN(r.json.filas);
    expect(f[2]).toMatchObject({ estado: "error", motivos: ["duplicado"], archivado: true });
    expect(f[3]).toMatchObject({ estado: "error", motivos: ["duplicado"] });
    expect(f[3].archivado ?? false).toBe(false);
    expect(r.json).toMatchObject({ validas: 1, cupoLibre: 3 });
  });

  it("un RUC de otro estudio no es duplicado ni consume el cupo de este (aislamiento)", async () => {
    const { E } = await estudio(3);
    const otro = await estudio(3);
    const compartido = await b.c.sembrar(otro.E.tenantId);
    const r = await previa(E.titular, xlsxConDatos([{ ruc: compartido.ruc }]));
    expect(r.json).toMatchObject({ validas: 1, conError: 0, cupoLibre: 3 });
    // y un responsable de otro estudio no existe para este
    const r2 = await previa(E.titular, xlsxConDatos([{ ruc: ruc(), responsable: otro.E.titular.correo }]));
    expect(porN(r2.json.filas)[2].motivos).toEqual(["responsable_inexistente"]);
  });

  it("el mismo contenido en .csv con ';' y BOM da el mismo veredicto que en .xlsx", async () => {
    const { E, asistente } = await estudio(6);
    const datos: DatosFila[] = [
      { ruc: ruc(), razonSocial: "Ñandú SAC", responsable: asistente.correo },
      { ruc: rucMalo() },
      { ruc: ruc(), usuarioSol: "U", claveSol: canario("k") },
    ];
    const x = await previa(E.titular, xlsxConDatos(datos));
    for (const o of [{ sep: ";" as const, bom: true }, { sep: "," as const }]) {
      const c = await previa(E.titular, nuevoCsv(datos, o));
      expect(c.status, c.texto).toBe(200);
      expect(c.json).toEqual(x.json);
    }
  });

  it("sin clientes.crear (contador, asistente, lectura) da 403 y no se evalúa el archivo; con claves, igual", async () => {
    const { E } = await estudio(5);
    const archivo = xlsxConDatos([{ ruc: ruc(), usuarioSol: "U", claveSol: canario("k") }]);
    for (const rol of ["contador", "asistente", "lectura"] as const) {
      const a = await b.c.p.b.miembro(E.tenantId, rol);
      for (const ruta of [VISTA, CONFIRMAR]) {
        const r = await bin(a, "POST", ruta, archivo);
        expect(r.status, `${rol} ${ruta}`).toBe(403);
        expect(r.json).toEqual({ codigo: "permiso_denegado" });
      }
    }
    expect(await clientesDe(E.tenantId)).toEqual([]);
    expect(await credencialesDe(E.tenantId)).toEqual([]);
  });
});

describe("CA-2 · archivos hostiles o fuera de límites: se rechazan o se marcan por fila, sin 500 ni consumo desmedido", () => {
  const MALAS = [400, 413];
  const CODIGOS_400 = ["archivo_invalido", "columnas_faltantes", "demasiadas_filas"];

  it("fórmula real <f> y texto que empieza con = + - @ en razón social, usuario SOL, client_id o responsable: celda_peligrosa por fila", async () => {
    const { E } = await estudio(10);
    const archivo = xlsx([
      [...CABECERA],
      filaDatos({ ruc: ruc() }),
      [ruc(), { f: "1+1", v: "2" }, "", "", "", "", ""], // fórmula real en razón social
      filaDatos({ ruc: ruc(), razonSocial: '=HYPERLINK("http://x.test","clic")' }),
      filaDatos({ ruc: ruc(), usuarioSol: "+cmd|' /C calc'!A0", claveSol: "k" }),
      filaDatos({ ruc: ruc(), clientId: "@SUM(1+1)", clientSecret: "s" }),
      filaDatos({ ruc: ruc(), responsable: "-2+3@x.test" }),
    ]);
    const r = await previa(E.titular, archivo);
    expect(r.status, r.texto).toBe(200);
    const f = porN(r.json.filas);
    expect(f[2]).toMatchObject({ estado: "valida" });
    for (const n of [3, 4, 5, 6, 7]) expect(f[n], `fila ${n}`).toMatchObject({ estado: "error", motivos: ["celda_peligrosa"] });
    expect(r.json).toMatchObject({ validas: 1, conError: 5 });
    expect((await confirmar(E.titular, archivo)).json).toMatchObject({ creadas: 1 });
    // Un carácter de control en un .csv también se rechaza por fila.
    const csvControl = await previa(E.titular, nuevoCsv([{ ruc: ruc(), razonSocial: "con\u0007control" }, { ruc: ruc() }]));
    expect(csvControl.status, csvControl.texto).toBe(200);
    expect(porN(csvControl.json.filas)[2]).toMatchObject({ estado: "error", motivos: ["celda_peligrosa"] });
    expect(porN(csvControl.json.filas)[3]).toMatchObject({ estado: "valida" });
  });

  it("las claves aceptan cualquier carácter imprimible: 'clave' y 'client_secret' que empiezan con = - @ son válidas y se cifran tal cual", async () => {
    const { E } = await estudio(10);
    const claves = [`=${canario("a")}`, `-${canario("b")}`, `@${canario("c")}`];
    const filas = claves.map((c, i) => ({ ruc: ruc(), usuarioSol: `U${i}`, claveSol: c, clientId: `I${i}`, clientSecret: c }));
    const archivo = xlsxConDatos(filas);
    const v = await previa(E.titular, archivo);
    expect(v.json.filas.map((x: any) => x.estado)).toEqual(["valida", "valida", "valida"]);
    expect(filtrados(claves, v.texto)).toEqual([]);
    const c = await confirmar(E.titular, archivo);
    expect(c.json).toMatchObject({ creadas: 3 });
    const creados = await clientesDe(E.tenantId);
    for (const [i, cliente] of creados.entries()) {
      const sobres = await b.credenciales(cliente.id);
      const sol = sobres.find((s) => s.tipo === "sol");
      const sire = sobres.find((s) => s.tipo === "sire_api");
      expect(abrirSobreMock(sol, { tenantId: E.tenantId, clienteId: cliente.id, tipo: "sol" })).toEqual({ usuario: `U${i}`, clave: claves[i] });
      expect(abrirSobreMock(sire, { tenantId: E.tenantId, clienteId: cliente.id, tipo: "sire_api" })).toEqual({ clientId: `I${i}`, clientSecret: claves[i] });
    }
  });

  it("solo se lee la primera hoja", async () => {
    const { E } = await estudio(10);
    const otra = [[...CABECERA], filaDatos({ ruc: ruc() }), filaDatos({ ruc: ruc() })];
    const r = await previa(E.titular, xlsx([[...CABECERA], filaDatos({ ruc: ruc() })], { hojasExtra: [otra] }));
    expect(r.status, r.texto).toBe(200);
    expect(r.json.filas).toHaveLength(1);
  });

  it("1.000 filas es el borde permitido (200); 1.001 filas da 400 demasiadas_filas", async () => {
    const { E } = await estudio(10);
    const filas = Array.from({ length: 1001 }, (_, i) => ({ ruc: rucConPrefijo("20", 900_000 + i) }));
    const ok = await previa(E.titular, nuevoCsv(filas.slice(0, 1000)));
    expect(ok.status, ok.texto.slice(0, 200)).toBe(200);
    expect(ok.json.filas).toHaveLength(1000);
    for (const bytes of [nuevoCsv(filas), xlsxConDatos(filas)]) {
      const r = await previa(E.titular, bytes);
      expect(r.status).toBe(400);
      expect(r.json).toEqual({ codigo: "demasiadas_filas" });
      expect((await confirmar(E.titular, bytes)).status).toBe(400);
    }
    expect(await clientesDe(E.tenantId)).toEqual([]);
  });

  it("más de 2 MB da 413 y no se crea nada", async () => {
    const { E } = await estudio(10);
    const grande = Buffer.alloc(2 * 1024 * 1024 + 1, 0x41);
    for (const ruta of [VISTA, CONFIRMAR]) {
      const r = await bin(E.titular, "POST", ruta, grande);
      expect(r.status, ruta).toBe(413);
    }
    expect(await clientesDe(E.tenantId)).toEqual([]);
  });

  it("vacío, bytes sin sentido y .xlsx truncado dan 400 con un código de archivo, nunca 500", async () => {
    const { E } = await estudio(10);
    const valido = xlsxConDatos([{ ruc: ruc() }]);
    const casos: [string, Uint8Array][] = [
      ["vacío", new Uint8Array(0)],
      ["binario no válido", Uint8Array.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0x81, 0x00, 0x00, 0x9f])],
      ["zip truncado", valido.subarray(0, Math.floor(valido.length / 2))],
      ["solo la firma PK", Uint8Array.from([0x50, 0x4b, 0x03, 0x04])],
    ];
    for (const [nombre, bytes] of casos) {
      const r = await previa(E.titular, bytes);
      expect(r.status, nombre).toBe(400);
      expect(CODIGOS_400, nombre).toContain(r.json?.codigo);
    }
    expect(await clientesDe(E.tenantId)).toEqual([]);
  });

  it("falta una columna de la cabecera: 400 columnas_faltantes", async () => {
    const { E } = await estudio(10);
    const sinClaveSol = [CABECERA.filter((c) => c !== "Clave SOL"), [ruc(), "X", "U", "I", "S", ""]];
    for (const bytes of [xlsx(sinClaveSol), csv(sinClaveSol)]) {
      const r = await previa(E.titular, bytes);
      expect(r.status).toBe(400);
      expect(r.json).toEqual({ codigo: "columnas_faltantes" });
    }
  });

  it("bomba de descompresión (declara poco y expande 30 MB; miles de entradas; rutas con '..'): rechazada rápido, sin 500", async () => {
    const { E } = await estudio(10);
    const casos: [string, Uint8Array][] = [
      ["bomba con tamaño falsificado", xlsxBomba(30 * 1024 * 1024, true)],
      ["bomba con tamaño honesto", xlsxBomba(30 * 1024 * 1024, false)],
      ["miles de entradas", xlsxMilesDeEntradas(5000)],
      ["ruta con ..", xlsxConRuta("../../etc/evil.xml")],
      ["ruta absoluta", xlsxConRuta("/etc/evil.xml")],
    ];
    for (const [nombre, bytes] of casos) {
      const t0 = Date.now();
      const r = await previa(E.titular, bytes);
      expect(MALAS, `${nombre}: ${r.status} ${r.texto.slice(0, 120)}`).toContain(r.status);
      expect(Date.now() - t0, nombre).toBeLessThan(10_000);
    }
    expect(await clientesDe(E.tenantId)).toEqual([]);
  });

  it("XXE, <!DOCTYPE> y entidades en la hoja o en las cadenas: 400 archivo_invalido y ni rastro del archivo local", async () => {
    const { E } = await estudio(10);
    const datos = [{ ruc: ruc() }];
    for (const [nombre, bytes] of [
      ["XXE en la hoja", xlsxConDatos(datos, { doctypeHoja: DOCTYPE_XXE })],
      ["XXE en las cadenas", xlsxConDatos(datos, { doctypeCadenas: DOCTYPE_XXE })],
      ["billion laughs", xlsxConDatos(datos, { doctypeHoja: DOCTYPE_LOLS })],
    ] as const) {
      const r = await previa(E.titular, bytes);
      expect(r.status, nombre).toBe(400);
      expect(r.json, nombre).toEqual({ codigo: "archivo_invalido" });
      expect(r.texto).not.toMatch(/root:|\/bin\//);
    }
  });

  it("filas repetidas: vale la primera y las demás son duplicado_en_archivo (xlsx y csv)", async () => {
    const { E } = await estudio(10);
    const repetido = ruc();
    const datos = [{ ruc: repetido }, { ruc: ruc() }, { ruc: repetido }, { ruc: repetido }];
    for (const bytes of [xlsxConDatos(datos), nuevoCsv(datos)]) {
      const f = porN((await previa(E.titular, bytes)).json.filas);
      expect(f[2].estado).toBe("valida");
      expect(f[4]).toMatchObject({ estado: "error", motivos: ["duplicado_en_archivo"] });
      expect(f[5]).toMatchObject({ estado: "error", motivos: ["duplicado_en_archivo"] });
    }
  });

  it("los números y los espacios en el RUC se leen bien (celda numérica o con espacios alrededor)", async () => {
    const { E } = await estudio(10);
    const r1 = ruc();
    const r2 = ruc();
    const archivo = xlsx([[...CABECERA], [Number(r1), "", "", "", "", "", ""], [` ${r2} `, "", "", "", "", "", ""]]);
    const r = await previa(E.titular, archivo);
    expect(r.status, r.texto).toBe(200);
    expect(r.json.filas.map((f: any) => [f.estado, f.ruc])).toEqual([
      ["valida", r1],
      ["valida", r2],
    ]);
  });
});

describe("CA-1 · confirmar: crea las filas válidas, cifra las claves con la AAD final y no deja el archivo en disco ni en logs", () => {
  it("clientes, responsable, razón social provisional, credenciales cifradas e informe", async () => {
    const { E, asistente, lectura } = await estudio(6);
    const existente = await b.c.sembrar(E.tenantId, { razonSocial: "Existente SAC" });
    const k = {
      usuario: canario("usuario-sol"),
      claveSol: canario("clave-sol"),
      clientId: canario("client-id"),
      secreto: canario("client-secret"),
      duplicada: canario("clave-del-duplicado"),
      invalida: canario("clave-de-fila-invalida"),
    };
    const r1 = ruc();
    const r2 = ruc();
    const r3 = ruc();
    const archivo = xlsxConDatos([
      { ruc: r1, razonSocial: "ACME SAC", usuarioSol: k.usuario, claveSol: k.claveSol, clientId: k.clientId, clientSecret: k.secreto, responsable: asistente.correo },
      { ruc: r2 },
      { ruc: rucMalo(), usuarioSol: "X", claveSol: k.invalida },
      { ruc: existente.ruc, usuarioSol: "Y", claveSol: k.duplicada },
      { ruc: ruc(), responsable: lectura.correo },
      { ruc: r3, razonSocial: "Tres SAC", clientId: "i3", clientSecret: "s3" },
    ]);
    const tmpAntes = instantaneaTmp();
    const { resultado: r, logs } = await capturarLogs(() => confirmar(E.titular, archivo));
    expect(r.status, r.texto).toBe(200);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(informeImportacionSchema.safeParse(r.json).success, r.texto).toBe(true);
    expect(r.json.creadas).toBe(3);
    expect(porN(r.json.noImportadas)).toMatchObject({
      4: { motivo: "ruc_invalido" },
      5: { ruc: existente.ruc, motivo: "duplicado" },
      6: { motivo: "responsable_no_asignable" },
    });
    expect(r.json.noImportadas).toHaveLength(3);
    expect(r.json.consultasEncoladas + r.json.consultasOmitidas).toBe(3);

    // Clientes creados, en el orden del archivo; la razón social vacía queda como la provisional «RUC <ruc>» (007a D1).
    const todos = await clientesDe(E.tenantId);
    const creados = todos.filter((c) => c.id !== existente.id);
    expect(creados.map((c) => c.ruc).sort()).toEqual([r1, r2, r3].sort());
    const por = Object.fromEntries(creados.map((c) => [c.ruc, c]));
    expect(por[r1]!.razon_social).toBe("ACME SAC");
    expect(por[r2]!.razon_social).toBe(`RUC ${r2}`);
    expect(por[r3]!.razon_social).toBe("Tres SAC");
    expect(todos.find((c) => c.id === existente.id)!.razon_social).toBe("Existente SAC"); // el existente no se toca

    // Responsable por correo; sin responsable en las demás.
    expect(await asignacionesDe(E.tenantId)).toEqual([{ cliente_id: por[r1]!.id, usuario_id: asistente.id, tipo: "responsable" }]);

    // Credenciales: solo las de las filas creadas, abiertas con la AAD (tenant, cliente final, tipo).
    const filas = await credencialesDe(E.tenantId);
    expect(filas.map((c) => `${c.cliente_id}:${c.tipo}:${c.estado}`).sort()).toEqual(
      [`${por[r1]!.id}:sol:configurada`, `${por[r1]!.id}:sire_api:configurada`, `${por[r3]!.id}:sire_api:configurada`].sort(),
    );
    const sobreDe = (clienteId: string, tipo: "sol" | "sire_api") => filas.find((c) => c.cliente_id === clienteId && c.tipo === tipo)!;
    const abrir = (clienteId: string, tipo: "sol" | "sire_api") =>
      abrirSobreMock(sobreDe(clienteId, tipo), { tenantId: E.tenantId, clienteId, tipo });
    expect(abrir(por[r1]!.id, "sol")).toEqual({ usuario: k.usuario, clave: k.claveSol });
    expect(abrir(por[r1]!.id, "sire_api")).toEqual({ clientId: k.clientId, clientSecret: k.secreto });
    expect(abrir(por[r3]!.id, "sire_api")).toEqual({ clientId: "i3", clientSecret: "s3" });
    // El sobre de un cliente no se abre con el id de otro.
    expect(abrirSobreMock(sobreDe(por[r1]!.id, "sol"), { tenantId: E.tenantId, clienteId: por[r3]!.id, tipo: "sol" })).toBeNull();

    // Ninguna clave en respuesta, logs ni disco; y las de filas rechazadas no se guardan en ninguna parte.
    const todas = Object.values(k);
    expect(filtrados(todas, r.texto, r.headers, logs)).toEqual([]);
    expect(archivosNuevosConCanario(tmpAntes, todas)).toEqual([]);
    for (const c of filas) {
      for (const campo of ["ciphertext", "nonce", "tag", "dek_envuelta"]) {
        expect(todas.some((t) => (c[campo] as Buffer).includes(t))).toBe(false);
      }
    }
  });

  it("el Administrador también importa (clientes.crear); el Dueño de otro estudio no ve ni toca este", async () => {
    const { E } = await estudio(5);
    const admin = await b.c.p.b.miembro(E.tenantId, "admin");
    const otro = await estudio(5);
    const r = await confirmar(admin, xlsxConDatos([{ ruc: ruc() }]));
    expect(r.status, r.texto).toBe(200);
    expect(r.json.creadas).toBe(1);
    expect(await clientesDe(otro.E.tenantId)).toEqual([]);
  });

  it("confirmar revalida dentro de la transacción: un RUC dado de alta después de la vista previa sale como duplicado, no como 500", async () => {
    const { E } = await estudio(5);
    const r1 = ruc();
    const r2 = ruc();
    const archivo = xlsxConDatos([{ ruc: r1 }, { ruc: r2 }]);
    const v = await previa(E.titular, archivo);
    expect(v.json).toMatchObject({ validas: 2, conError: 0 });
    // Entre la vista previa y la confirmación alguien crea r1 por el formulario.
    expect((await b.c.crear(E.titular, { ruc: r1, razonSocial: "Colado SAC" })).status).toBe(201);
    const c = await confirmar(E.titular, archivo);
    expect(c.status, c.texto).toBe(200);
    expect(c.json.creadas).toBe(1);
    expect(c.json.noImportadas).toEqual([expect.objectContaining({ n: 2, ruc: r1, motivo: "duplicado" })]);
    expect((await clientesDe(E.tenantId)).filter((x) => x.ruc === r1)).toHaveLength(1);
  });
});

describe("CA-8 · importación parcial: válidas en orden de archivo hasta el cupo; existentes como duplicado; el resto cupo_rucs", () => {
  it("activo y archivado existentes salen como duplicado (el archivado con la sugerencia de reactivar) y las excedentes como cupo_rucs", async () => {
    const { E } = await estudio(4);
    const activo = await b.c.sembrar(E.tenantId, { razonSocial: "Activo SAC" }); // ocupa 1 → quedan 3
    const archivado = await b.c.sembrar(E.tenantId, { razonSocial: "Archivado SAC", archivado: true }); // no consume
    const [v1, v2, v3, v4, v5] = [ruc(), ruc(), ruc(), ruc(), ruc()];
    const archivo = xlsxConDatos([
      { ruc: v1 }, // 2
      { ruc: activo.ruc, razonSocial: "Cambiado" }, // 3 duplicado
      { ruc: v2 }, // 4
      { ruc: archivado.ruc, razonSocial: "Cambiado" }, // 5 duplicado (archivado)
      { ruc: v3 }, // 6
      { ruc: v4 }, // 7 cupo_rucs
      { ruc: v5 }, // 8 cupo_rucs
    ]);
    const v = await previa(E.titular, archivo);
    expect(v.json).toMatchObject({ validas: 5, conError: 2, cupoLibre: 3, excedentes: 2 });
    expect(porN(v.json.filas)[5]).toMatchObject({ motivos: ["duplicado"], archivado: true });

    const r = await confirmar(E.titular, archivo);
    expect(r.status, r.texto).toBe(200);
    expect(informeImportacionSchema.safeParse(r.json).success).toBe(true);
    expect(r.json.creadas).toBe(3);
    const nI = porN(r.json.noImportadas);
    expect(Object.keys(nI).map(Number).sort((a, c) => a - c)).toEqual([3, 5, 7, 8]);
    expect(nI[3]).toMatchObject({ ruc: activo.ruc, motivo: "duplicado" });
    expect(nI[3].archivado ?? false).toBe(false);
    expect(nI[5]).toMatchObject({ ruc: archivado.ruc, motivo: "duplicado", archivado: true });
    expect(nI[7]).toMatchObject({ ruc: v4, motivo: "cupo_rucs" });
    expect(nI[8]).toMatchObject({ ruc: v5, motivo: "cupo_rucs" });

    // Se crearon exactamente las tres primeras válidas, en el orden del archivo, y el cupo no se excede.
    const nuevos = (await clientesDe(E.tenantId)).filter((c) => ![activo.id, archivado.id].includes(c.id)).map((c) => c.ruc);
    expect(nuevos.sort()).toEqual([v1, v2, v3].sort());
    expect(await b.c.activos(E.tenantId)).toBe(4);
    // Los existentes no cambian (D9): ni razón social ni estado de archivo.
    const ex = Object.fromEntries((await clientesDe(E.tenantId)).map((c) => [c.id, c]));
    expect(ex[activo.id].razon_social).toBe("Activo SAC");
    expect(ex[archivado.id]).toMatchObject({ razon_social: "Archivado SAC" });
    expect(ex[archivado.id].archivado_at).not.toBeNull();
  });

  it("con el cupo agotado no se crea nada y todas las válidas salen como cupo_rucs (200, no 409)", async () => {
    const { E } = await estudio(2);
    await b.c.sembrar(E.tenantId);
    await b.c.sembrar(E.tenantId);
    const [a, c] = [ruc(), ruc()];
    const r = await confirmar(E.titular, xlsxConDatos([{ ruc: a }, { ruc: c }]));
    expect(r.status, r.texto).toBe(200);
    expect(r.json.creadas).toBe(0);
    expect([...r.json.noImportadas].sort((x: any, y: any) => x.n - y.n).map((x: any) => [x.n, x.motivo])).toEqual([
      [2, "cupo_rucs"],
      [3, "cupo_rucs"],
    ]);
    expect(await b.c.activos(E.tenantId)).toBe(2);
  });

  it("las filas con error no ocupan cupo: 2 inválidas + 2 válidas con 2 cupos libres crean las 2 válidas", async () => {
    const { E } = await estudio(2);
    const r = await confirmar(E.titular, xlsxConDatos([{ ruc: rucMalo() }, { ruc: ruc() }, { ruc: ruc("30") }, { ruc: ruc() }]));
    expect(r.json.creadas).toBe(2);
    expect([...r.json.noImportadas].sort((x: any, y: any) => x.n - y.n).map((x: any) => x.motivo)).toEqual(["ruc_invalido", "ruc_invalido"]);
  });
});
