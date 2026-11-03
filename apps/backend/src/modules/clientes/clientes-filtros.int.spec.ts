/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON dinámicos en pruebas */
// Spec 007a (T3, rojo): listado con filtros (D7, D11; CA-6) y su combinación con el alcance (D3, CA-3).
// Contrato (plan: HTTP): GET /clientes?responsable=<usuarioId|ninguno>&credencial=<estado>&archivados=1&q=<texto>.
// Los filtros se combinan con AND y con el alcance del usuario. `credencial` coincide si alguno de los dos tipos (sol, sire_api)
// está en ese estado; `no_configurada` = tipo sin fila. `q` busca prefijo de RUC o fragmento de razón social (sin distinguir
// mayúsculas), con `%`, `_`, `\` y comillas como texto literal; máx. 100 caracteres. `archivados=1` AÑADE los archivados a los
// activos (así lo usa la casilla «Mostrar archivados» del listado, T4). Orden por razón social e id. Cada fila es un ClienteDto
// con el estado de ambas credenciales (nunca un secreto).
// Rojo: los filtros, el DTO ampliado y las columnas de `cliente` (`archivado_at`, perfil) aún no existen (T5, T7, T9).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirBancoClientes, type Actor, type BancoClientes, type EstadoCred, type Estudio } from "../../../test/soporte-clientes.js";

let c: BancoClientes;
let E: Estudio;
let admin: Actor;
let u1: Actor; // contador
let u2: Actor; // asistente
let lectura: Actor;
let ajeno: Estudio;

type Clave = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I" | "J" | "K" | "M1" | "M2";
interface Fx {
  clave: Clave;
  razon: string;
  resp?: "u1" | "u2";
  colab?: ("u1" | "u2")[];
  sol?: EstadoCred;
  sire?: EstadoCred;
  arch?: boolean;
  id: string;
  ruc: string;
}
const DEF: Omit<Fx, "id" | "ruc">[] = [
  { clave: "A", razon: "Alfa Norte SAC", resp: "u1", sol: "verificada" },
  { clave: "B", razon: "Beta Sur SAC", resp: "u1", sol: "invalida", sire: "verificada" },
  { clave: "C", razon: "Gamma Centro SAC", resp: "u2", sol: "configurada", sire: "configurada" },
  { clave: "D", razon: "Delta Libre SAC", colab: ["u2"] },
  { clave: "E", razon: "Epsilon Archivada SAC", resp: "u1", sol: "verificada", arch: true },
  { clave: "F", razon: "Zeta Archivada SAC", sire: "invalida", arch: true },
  { clave: "G", razon: "100% Peru SAC" },
  { clave: "H", razon: "Under_score SAC" },
  { clave: "I", razon: `O'Brien "Quote" SAC` },
  { clave: "J", razon: "Distribuidora Omega SAC", sol: "verificada" },
  { clave: "K", razon: "Backslash\\Case SAC", colab: ["u1"] },
  { clave: "M1", razon: "Mellizo SAC" },
  { clave: "M2", razon: "Mellizo SAC" },
];
let FX: Fx[] = [];
const por = (k: Clave) => FX.find((f) => f.clave === k)!;
const idsDe = (...ks: Clave[]) => ks.map((k) => por(k).id).sort();
const uid = (u: "u1" | "u2" | undefined) => (u === "u1" ? u1.id : u === "u2" ? u2.id : undefined);

/** Modelo en memoria de lo que debe salir (semántica de D7), para cualquier combinación de filtros y alcance. */
function esperado(f: { responsable?: string; credencial?: EstadoCred; archivados?: boolean; q?: string }, visibles?: Set<Clave>): string[] {
  return FX.filter((x) => {
    if (visibles && !visibles.has(x.clave)) return false;
    if (!f.archivados && x.arch) return false;
    if (f.responsable === "ninguno" && x.resp) return false;
    if (f.responsable && f.responsable !== "ninguno" && uid(x.resp) !== f.responsable) return false;
    if (f.credencial && ![x.sol ?? "no_configurada", x.sire ?? "no_configurada"].includes(f.credencial)) return false;
    if (f.q !== undefined && !(x.ruc.startsWith(f.q) || x.razon.toLowerCase().includes(f.q.toLowerCase()))) return false;
    return true;
  })
    .map((x) => x.id)
    .sort();
}
const consulta = (f: Record<string, string | undefined>) => {
  const qs = Object.entries(f)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`)
    .join("&");
  return `/clientes${qs ? `?${qs}` : ""}`;
};
const listar = async (a: Actor, f: Record<string, string | undefined> = {}) => {
  const r = await c.p.b.llamar(a, "GET", consulta(f));
  expect(r.status, `${consulta(f)} -> ${r.text}`).toBe(200);
  return r.body as any[];
};
const idsOrdenados = (filas: any[]) => filas.map((x) => x.id).sort();

beforeAll(async () => {
  c = await abrirBancoClientes();
  E = await c.p.b.estudio();
  ajeno = await c.p.b.estudio();
  admin = await c.p.b.miembro(E.tenantId, "admin");
  u1 = await c.p.b.miembro(E.tenantId, "contador");
  u2 = await c.p.b.miembro(E.tenantId, "asistente");
  lectura = await c.p.b.miembro(E.tenantId, "lectura");
  for (const d of DEF) {
    const s = await c.sembrar(E.tenantId, {
      razonSocial: d.razon,
      responsable: uid(d.resp),
      colaboradores: (d.colab ?? []).map((u) => uid(u)!),
      sol: d.sol,
      sireApi: d.sire,
      archivado: d.arch,
    });
    FX.push({ ...d, id: s.id, ruc: s.ruc });
  }
  // Perfil fiscal resumido de A para comprobar que viaja en cada fila.
  await c.p.sql("update cliente set regimen = 'rmt', zona = 'amazonia', ventas_mixtas = true, moneda_habitual = 'USD' where id = $1", [por("A").id]);
  // Un cliente de otro estudio con el mismo estado y nombre parecido: nunca debe aparecer.
  await c.sembrar(ajeno.tenantId, { razonSocial: "Alfa Ajena SAC", sol: "verificada", responsable: undefined });
}, 120_000);
afterAll(async () => {
  FX = [];
  await c?.cerrar();
});

describe("CA-6 · sin filtros: activos del alcance, ordenados, con el ClienteDto de la fila", () => {
  it("el Dueño ve todos los activos y ningún archivado ni cliente de otro estudio", async () => {
    const r = await listar(E.titular);
    expect(idsOrdenados(r)).toEqual(esperado({}));
    expect(r.some((x) => x.archivado)).toBe(false);
    expect(r.map((x) => x.razonSocial)).not.toContain("Alfa Ajena SAC");
  });

  it("orden por razón social y, a igual razón social, por id", async () => {
    const r = await listar(E.titular);
    const plano = ["A", "B", "D", "J", "C"].map((k) => por(k as Clave).id);
    const posiciones = plano.map((id) => r.findIndex((x) => x.id === id));
    expect(posiciones.every((p) => p >= 0)).toBe(true);
    expect([...posiciones].sort((x, y) => x - y)).toEqual(posiciones); // Alfa < Beta < Delta < Distribuidora < Gamma
    const mellizos = r.filter((x) => x.razonSocial === "Mellizo SAC").map((x) => x.id);
    expect(mellizos).toEqual([por("M1").id, por("M2").id].sort());
  });

  it("cada fila trae responsable, perfil fiscal, estado de ambas credenciales y ningún secreto", async () => {
    const r = await c.p.b.llamar(E.titular, "GET", "/clientes");
    const a = r.body.find((x: any) => x.id === por("A").id);
    expect(a).toMatchObject({
      ruc: por("A").ruc,
      razonSocial: "Alfa Norte SAC",
      archivado: false,
      responsable: { id: u1.id, nombre: expect.any(String) },
      perfil: { regimen: "rmt", zona: "amazonia", ventasExoneradas: false, ventasMixtas: true, monedaHabitual: "USD" },
      credenciales: { sol: "verificada", sire_api: "no_configurada" },
    });
    const b = r.body.find((x: any) => x.id === por("B").id);
    expect(b.credenciales).toEqual({ sol: "invalida", sire_api: "verificada" });
    expect(r.body.find((x: any) => x.id === por("D").id).responsable).toBeNull(); // colaborador no es responsable
    expect(r.text).not.toMatch(/ciphertext|nonce|dek_envuelta|"tag"|kek|secret|clave_sol/i);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
  });
});

describe("CA-6 · cada filtro por separado (D7)", () => {
  it("responsable=<usuarioId> deja los clientes cuyo responsable es ese usuario", async () => {
    expect(idsOrdenados(await listar(E.titular, { responsable: u1.id }))).toEqual(idsDe("A", "B"));
    expect(idsOrdenados(await listar(E.titular, { responsable: u2.id }))).toEqual(idsDe("C"));
  });

  it("responsable=ninguno deja los activos sin responsable (un colaborador no cuenta como responsable)", async () => {
    const r = idsOrdenados(await listar(E.titular, { responsable: "ninguno" }));
    expect(r).toEqual(esperado({ responsable: "ninguno" }));
    expect(r).toEqual(expect.arrayContaining(idsDe("D", "K", "J")));
    expect(r).not.toContain(por("A").id);
  });

  it("responsable de otro estudio o de un usuario sin clientes da lista vacía, no 404", async () => {
    const ajenoUsuario = await c.p.b.miembro(ajeno.tenantId, "contador", { sesion: false });
    expect(await listar(E.titular, { responsable: ajenoUsuario.id })).toEqual([]);
    expect(await listar(E.titular, { responsable: lectura.id })).toEqual([]);
  });

  it.each(["no_configurada", "configurada", "verificada", "invalida"] as const)("credencial=%s coincide si alguno de los dos tipos está en ese estado", async (estado) => {
    expect(idsOrdenados(await listar(E.titular, { credencial: estado }))).toEqual(esperado({ credencial: estado }));
  });

  it("credencial: ejemplos concretos (verificada = SOL de A o SIRE de B; no_configurada = tipo sin fila)", async () => {
    expect(idsOrdenados(await listar(E.titular, { credencial: "verificada" }))).toEqual(idsDe("A", "B", "J"));
    expect(idsOrdenados(await listar(E.titular, { credencial: "invalida" }))).toEqual(idsDe("B"));
    expect(idsOrdenados(await listar(E.titular, { credencial: "configurada" }))).toEqual(idsDe("C"));
    const sinFila = idsOrdenados(await listar(E.titular, { credencial: "no_configurada" }));
    expect(sinFila).toEqual(expect.arrayContaining(idsDe("A", "D", "J"))); // A y J: SIRE sin fila; D: ninguna
    expect(sinFila).not.toContain(por("C").id);
    expect(sinFila).not.toContain(por("B").id); // B tiene las dos filas
  });

  it("archivados=1 añade los archivados a los activos; sin él no aparecen", async () => {
    const con = await listar(E.titular, { archivados: "1" });
    expect(idsOrdenados(con)).toEqual(esperado({ archivados: true }));
    expect(con.filter((x) => x.archivado).map((x) => x.id).sort()).toEqual(idsDe("E", "F"));
    expect(con.filter((x) => !x.archivado).length).toBe(esperado({}).length);
    expect(idsOrdenados(await listar(E.titular))).not.toEqual(expect.arrayContaining(idsDe("E")));
  });

  it("q por prefijo de RUC: el RUC completo, su prefijo, pero no un fragmento del medio", async () => {
    const a = por("A");
    expect(idsOrdenados(await listar(E.titular, { q: a.ruc }))).toEqual(idsDe("A"));
    expect(idsOrdenados(await listar(E.titular, { q: a.ruc.slice(0, 10) }))).toEqual(esperado({ q: a.ruc.slice(0, 10) }));
    expect(await listar(E.titular, { q: a.ruc.slice(3, 9) })).toEqual([]);
  });

  it("q por fragmento de razón social, sin distinguir mayúsculas", async () => {
    expect(idsOrdenados(await listar(E.titular, { q: "Alfa" }))).toEqual(idsDe("A"));
    expect(idsOrdenados(await listar(E.titular, { q: "alfa norte" }))).toEqual(idsDe("A"));
    expect(idsOrdenados(await listar(E.titular, { q: "fa NOR" }))).toEqual(idsDe("A")); // fragmento del medio
    expect(idsOrdenados(await listar(E.titular, { q: "omega" }))).toEqual(idsDe("J"));
    expect(idsOrdenados(await listar(E.titular, { q: "Mellizo" }))).toEqual(idsDe("M1", "M2"));
    expect(await listar(E.titular, { q: "Archivada" })).toEqual([]); // archivados fuera sin archivados=1
    expect(idsOrdenados(await listar(E.titular, { q: "Archivada", archivados: "1" }))).toEqual(idsDe("E", "F"));
  });

  it("q no encuentra clientes de otro estudio", async () => {
    expect(await listar(E.titular, { q: "Ajena" })).toEqual([]);
  });
});

describe("CA-6 · q con comodines, comillas y barras no altera la consulta", () => {
  it.each([
    ["%", ["G"]],
    ["_", ["H"]],
    ["100%", ["G"]],
    ["Under_s", ["H"]],
    ["Under%", []],
    ["U_der", []],
    ["%%", []],
    ["\\", ["K"]],
    ["Backslash\\", ["K"]],
    ["'", ["I"]],
    ['"', ["I"]],
    ["O'Brien", ["I"]],
    ["' OR '1'='1", []],
    ["'; DROP TABLE cliente; --", []],
    ['" OR 1=1 --', []],
    ["%' OR 1=1 --", []],
  ] as [string, Clave[]][])("q=%j es texto literal", async (q, claves) => {
    const antes = await c.total(E.tenantId);
    const r = await listar(E.titular, { q });
    expect(idsOrdenados(r)).toEqual(idsDe(...claves));
    expect(idsOrdenados(r)).toEqual(esperado({ q }));
    expect(await c.total(E.tenantId)).toBe(antes);
  });

  it("un comodín no revela clientes ajenos al alcance: el asistente con q=% no ve más que sus clientes", async () => {
    const r = await listar(u2, { q: "%" });
    expect(r).toEqual([]);
    const todos = await listar(u2, { q: "_" });
    expect(todos).toEqual([]);
  });

  it("q de 100 caracteres es válido y de 101 da 400 solicitud_invalida", async () => {
    expect(await listar(E.titular, { q: "a".repeat(100) })).toEqual([]);
    const larga = await c.p.b.llamar(E.titular, "GET", consulta({ q: "a".repeat(101) }));
    expect(larga.status).toBe(400);
    expect(larga.body).toEqual({ codigo: "solicitud_invalida" });
  });

  it("un NUL o caracteres de control en q nunca producen 500", async () => {
    for (const q of ["a\u0000b", "\u0000", "a\nb", "‮"]) {
      const r = await c.p.b.llamar(E.titular, "GET", consulta({ q }));
      expect(r.status, JSON.stringify(q)).toBeLessThan(500);
      expect([200, 400]).toContain(r.status);
    }
  });

  it("q vacío equivale a no filtrar por texto", async () => {
    const r = await c.p.b.llamar(E.titular, "GET", "/clientes?q=");
    expect([200, 400]).toContain(r.status);
    if (r.status === 200) expect(idsOrdenados(r.body)).toEqual(esperado({}));
  });
});

describe("CA-6 · parámetros inválidos: 400 solicitud_invalida, sin eco", () => {
  it.each([
    ["responsable no uuid", "responsable=juan"],
    ["responsable vacío", "responsable="],
    ["credencial fuera del catálogo", "credencial=caducada"],
    ["credencial vacía", "credencial="],
  ])("%s", async (_n, qs) => {
    const r = await c.p.b.llamar(E.titular, "GET", `/clientes?${qs}`);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
  });

  it("los parámetros desconocidos (tenantId, usuarioId) se ignoran y no amplían el alcance", async () => {
    const r = await listar(u2, { tenantId: ajeno.tenantId, usuarioId: E.titular.id });
    expect(idsOrdenados(r)).toEqual(esperado({}, new Set<Clave>(["C", "D"])));
  });
});

describe("CA-6 · combinaciones (AND)", () => {
  const casos: [string, Record<string, string | undefined>][] = [
    ["responsable + credencial", { responsable: "U1", credencial: "verificada" }],
    ["responsable + credencial inválida", { responsable: "U1", credencial: "invalida" }],
    ["responsable + archivados", { responsable: "U1", archivados: "1" }],
    ["responsable + credencial + archivados", { responsable: "U1", credencial: "verificada", archivados: "1" }],
    ["ninguno + credencial + archivados", { responsable: "ninguno", credencial: "invalida", archivados: "1" }],
    ["ninguno + no_configurada", { responsable: "ninguno", credencial: "no_configurada" }],
    ["q + responsable", { q: "Beta", responsable: "U1" }],
    ["q + responsable distinto", { q: "Beta", responsable: "U2" }],
    ["q + credencial", { q: "a", credencial: "verificada" }],
    ["q + archivados", { q: "Zeta", archivados: "1" }],
    ["los cuatro", { q: "SAC", responsable: "U1", credencial: "verificada", archivados: "1" }],
    ["los cuatro sin coincidencias", { q: "Gamma", responsable: "U1", credencial: "verificada", archivados: "1" }],
  ];
  it.each(casos)("%s", async (_n, f) => {
    const filtros: Record<string, string | undefined> = { ...f, responsable: f.responsable === "U1" ? u1.id : f.responsable === "U2" ? u2.id : f.responsable };
    const r = await listar(E.titular, filtros);
    expect(idsOrdenados(r)).toEqual(
      esperado({
        responsable: filtros.responsable,
        credencial: filtros.credencial as EstadoCred | undefined,
        archivados: filtros.archivados === "1",
        q: filtros.q,
      }),
    );
  });

  it("ejemplos concretos de la combinación", async () => {
    expect(idsOrdenados(await listar(E.titular, { responsable: u1.id, credencial: "verificada" }))).toEqual(idsDe("A", "B"));
    expect(idsOrdenados(await listar(E.titular, { responsable: u1.id, credencial: "verificada", archivados: "1" }))).toEqual(idsDe("A", "B", "E"));
    expect(idsOrdenados(await listar(E.titular, { responsable: "ninguno", credencial: "invalida", archivados: "1" }))).toEqual(idsDe("F"));
    expect(await listar(E.titular, { q: "Beta", responsable: u2.id })).toEqual([]);
    expect(idsOrdenados(await listar(E.titular, { q: "Beta", responsable: u1.id }))).toEqual(idsDe("B"));
  });
});

describe("CA-6 · los filtros se combinan con el alcance del usuario (D3, CA-3)", () => {
  it("Administrador ve lo mismo que el Dueño con cualquier filtro", async () => {
    for (const f of [{}, { responsable: u1.id }, { credencial: "verificada" }, { archivados: "1" }, { q: "Alfa" }]) {
      expect(idsOrdenados(await listar(admin, f))).toEqual(idsOrdenados(await listar(E.titular, f)));
    }
  });

  it("el contador (A y B como responsable, K como colaborador, E archivado) solo filtra dentro de lo suyo", async () => {
    const visibles = new Set<Clave>(["A", "B", "E", "K"]);
    for (const f of [
      {},
      { archivados: "1" },
      { credencial: "verificada" },
      { credencial: "no_configurada" },
      { responsable: "ninguno" },
      { responsable: u1.id },
      { responsable: u1.id, archivados: "1" },
      { q: "SAC" },
      { q: "SAC", archivados: "1" },
      { q: "Gamma" },
    ] as Record<string, string>[]) {
      const r = await listar(u1, f);
      expect(idsOrdenados(r), consulta(f)).toEqual(
        esperado({ responsable: f.responsable, credencial: f.credencial as EstadoCred | undefined, archivados: f.archivados === "1", q: f.q }, visibles),
      );
    }
    expect(idsOrdenados(await listar(u1, { archivados: "1" }))).toEqual(idsDe("A", "B", "E", "K"));
  });

  it("el asistente (C responsable, D colaborador) no sale de sus dos clientes con ningún filtro", async () => {
    const visibles = new Set<Clave>(["C", "D"]);
    expect(idsOrdenados(await listar(u2))).toEqual(idsDe("C", "D"));
    expect(idsOrdenados(await listar(u2, { credencial: "no_configurada" }))).toEqual(idsDe("D"));
    expect(idsOrdenados(await listar(u2, { responsable: "ninguno" }))).toEqual(idsDe("D"));
    expect(idsOrdenados(await listar(u2, { responsable: u2.id }))).toEqual(idsDe("C"));
    expect(await listar(u2, { responsable: u1.id })).toEqual([]);
    expect(await listar(u2, { credencial: "verificada" })).toEqual([]);
    expect(await listar(u2, { q: "Alfa" })).toEqual([]);
    expect(idsOrdenados(await listar(u2, { archivados: "1" }))).toEqual(esperado({ archivados: true }, visibles));
  });

  it("un archivado deja de estar en el listado de quien lo tenía al archivarlo y vuelve con archivados=1", async () => {
    const extra = await c.sembrar(E.tenantId, { razonSocial: "Zulu Temporal SAC", responsable: u2.id });
    expect((await listar(u2)).map((x) => x.id)).toContain(extra.id);
    expect((await c.p.b.llamar(E.titular, "POST", `/clientes/${extra.id}/archivar`)).status).toBe(200);
    expect((await listar(u2)).map((x) => x.id)).not.toContain(extra.id);
    expect((await listar(u2, { archivados: "1" })).map((x) => x.id)).toContain(extra.id);
    expect((await c.p.b.llamar(E.titular, "POST", `/clientes/${extra.id}/reactivar`)).status).toBe(200);
    expect((await listar(u2)).map((x) => x.id)).toContain(extra.id);
  });

  it("lectura sin asignaciones recibe lista vacía con cualquier filtro, y lectura con permiso clientes.ver no escribe", async () => {
    for (const f of [{}, { archivados: "1" }, { responsable: "ninguno" }, { credencial: "no_configurada" }, { q: "%" }]) {
      expect(await listar(lectura, f)).toEqual([]);
    }
    const r = await c.p.b.llamar(lectura, "POST", "/clientes", { ruc: "20123456786" });
    expect(r.status).toBe(403);
  });

  it("el estudio sale de la sesión: los filtros no cruzan a otro estudio", async () => {
    const delAjeno = await listar(ajeno.titular, { q: "Alfa" });
    expect(delAjeno.map((x) => x.razonSocial)).toEqual(["Alfa Ajena SAC"]);
    expect(idsOrdenados(await listar(E.titular, { q: "Alfa" }))).toEqual(idsDe("A"));
  });
});
