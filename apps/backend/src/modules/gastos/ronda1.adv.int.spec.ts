/* eslint-disable @typescript-eslint/no-explicit-any -- filas de BD y cuerpos JSON dinámicos en pruebas */
// Spec 027 · T15 (ronda adversarial 1, HTTP). Caja negra con spec.md (R-1, R-6, R-7, R-11, R-12, R-14, D-3, D-7; CA-3, CA-7 a CA-9, CA-12,
// CA-18) y el plan («Contratos: HTTP»); caja blanca de `modules/gastos/*` y 0070 (advisory `gnd:<tenant>`, `gnd_aprender`). Catálogo 04 §2.3:
// aislamiento (ids de A en rutas de B, compra de otro cliente, caché de CIIU), permisos y alcance (desasignado y desactivado con sesión viva,
// plataforma sin alta), límite y concurrencia (2.000 con pedidos simultáneos de agregar, reactivar y aprender), cola (claves extra, otro
// estudio, ráfaga de pedidos) y D-7 (un R-GP sin palabra guardado antes no se puede aceptar). Cada fallo es un hallazgo H-027-1-n.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoGastos,
  base,
  compraConXml,
  GLOSA_XML,
  inexistente,
  NO_ENCONTRADO,
  PERIODO,
  PERMISO_DENEGADO,
  RUTA_PLATAFORMA,
  rutaAprender,
  rutaCategorias,
  rutaPalabra,
  rutaPalabras,
  rutaPlataformaPalabra,
  rutaReevaluar,
  rutaUmbral,
  SOLICITUD_INVALIDA,
  type Actor,
  type BancoGastos,
  type Estudio,
  type OpcionesCompraXml,
} from "../../../test/soporte-gastos.js";
import { prepararStorage, type StoragePrueba } from "../../../test/soporte-xml.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 120_000 });

let st: StoragePrueba;
let v: BancoGastos;

beforeAll(async () => {
  st = prepararStorage();
  v = await abrirBancoGastos();
});
afterAll(async () => {
  await v?.cerrar();
  st?.restaurar();
});

interface Banco027 {
  est: Estudio;
  contador: Actor;
}
const abrir = async (): Promise<Banco027> => {
  const est = await v.estudio();
  return { est, contador: await v.b.c.p.b.miembro(est.tenantId, "contador") };
};
const FERRETERIA = "4752";
const TIENDA_ROPA = "4771";
const unica = (p: string): string => `${p}${Math.random().toString(36).slice(2, 7)}${Date.now().toString(36)}`.replace(/[^a-z0-9]/g, "");
const conGlosa = (b: Banco027, glosa: string, o: OpcionesCompraXml = {}) =>
  compraConXml(v, b.est, b.contador, { ...o, cambios: [[GLOSA_XML[o.xml ?? "5070"], glosa]] });
const excluir = async (a: Actor, x: { c: { id: string }; id: string }) => {
  const r = await v.llamar(a, "POST", `${base(x.c.id)}/${x.id}/excluir`, { versionBase: 1 });
  expect(r.status, r.text).toBe(200);
};
const propias = async (tenantId: string) => (await v.propiasBd(tenantId)).map((p: any) => p.palabra).sort();
const activas = async (tenantId: string) =>
  Number((await v.b.sql("select count(*)::int as n from gnd_palabra_estudio where tenant_id = $1 and activa", [tenantId]))[0].n);
const no5xx = (rs: { status: number; text?: string }[]) => {
  for (const r of rs) expect(r.status, r.text).toBeLessThan(500);
};

describe("T15 · aislamiento A/B (R-6, CA-7)", () => {
  it("palabra, cliente y compra de A en rutas de B, y compra de otro cliente del mismo estudio al aprender: 404 igual que inexistente y nada cambia", async () => {
    const A = await abrir();
    const B = await abrir();
    const idA = await v.sembrarPropia(A.est.tenantId, { palabra: unica("aisla"), categoria: "juguetes", creadoPor: A.est.titular.id });
    const filaAntes = (await v.propiasBd(A.est.tenantId)).find((p: any) => p.id === idA);

    const ajena = await v.http(B.est.titular, "PUT", rutaPalabra(idA), { activa: false, version: 1 });
    const nada = await v.http(B.est.titular, "PUT", rutaPalabra(inexistente()), { activa: false, version: 1 });
    expect([ajena.status, ajena.body]).toEqual([404, NO_ENCONTRADO]);
    expect([nada.status, nada.body]).toEqual([404, NO_ENCONTRADO]);
    expect((await v.propiasBd(A.est.tenantId)).find((p: any) => p.id === idA)).toEqual(filaAntes);

    // Compra excluida y con XML de A: B no la propone ni la aprende, ni por la ruta de A ni colgándola de un cliente propio.
    const xa = await conGlosa(A, "AUDIFONOS BLUETOOTH JBL");
    await excluir(A.contador, xa);
    const xb = await conGlosa(B, "CEMENTO GRIS");
    await excluir(B.contador, xb);
    const cuerpo = { terminos: [{ termino: unica("fuga"), categoria: "entretenimiento" }] };
    const intentos = [
      await v.http(B.est.titular, "GET", rutaAprender(xa.c.id, PERIODO, xa.id)),
      await v.http(B.est.titular, "POST", rutaAprender(xa.c.id, PERIODO, xa.id), cuerpo),
      await v.http(B.est.titular, "GET", rutaAprender(xb.c.id, PERIODO, xa.id)),
      await v.http(B.est.titular, "POST", rutaAprender(xb.c.id, PERIODO, xa.id), cuerpo),
    ];
    for (const r of intentos) expect([r.status, r.body], r.text).toEqual([404, NO_ENCONTRADO]);

    // Mismo estudio: la compra excluida del cliente 1 colgada de la ruta del cliente 2 (que el contador también ve).
    const otra = await conGlosa(A, "CEMENTO GRIS");
    const cruzada = await v.http(A.est.titular, "POST", rutaAprender(otra.c.id, PERIODO, xa.id), cuerpo);
    expect([cruzada.status, cruzada.body], cruzada.text).toEqual([404, NO_ENCONTRADO]);
    expect(await propias(B.est.tenantId)).toEqual([]);
    expect((await propias(A.est.tenantId)).some((p) => p.startsWith("fuga"))).toBe(false);
  });

  it("la caché de CIIU de A no puntúa en B: la misma compra suma S2 y S3 en A y solo S1 en B (R-14, «cada estudio consulta por su cuenta»)", async () => {
    const A = await abrir();
    const B = await abrir();
    const xa = await conGlosa(A, "ZAPATILLA URBANA T42", { ciiuCliente: FERRETERIA, ciiuProveedor: TIENDA_ROPA });
    const xb = await conGlosa(B, "ZAPATILLA URBANA T42");
    const [ga] = await v.hallazgosGp(xa.id);
    const [gb] = await v.hallazgosGp(xb.id);
    expect(ga.sugerencia.senales.map((s: any) => s.codigo)).toEqual(["S1", "S2", "S3"]);
    expect(gb.sugerencia.senales.map((s: any) => s.codigo)).toEqual(["S1"]);
    expect(await v.ciiuBd(B.est.tenantId)).toEqual([]);
  });
});

describe("T15 · permisos y alcance con sesión viva (D-3, CA-8)", () => {
  it("Contador desasignado con sesión viva: aprender, proponer y categorías del cliente dan 404 y no guardan nada", async () => {
    const A = await abrir();
    const x = await conGlosa(A, "AUDIFONOS BLUETOOTH JBL");
    await excluir(A.contador, x);
    expect((await v.http(A.contador, "GET", rutaAprender(x.c.id, PERIODO, x.id))).status).toBe(200);
    await v.b.sql("delete from asignacion where tenant_id = $1 and cliente_id = $2 and usuario_id = $3", [A.est.tenantId, x.c.id, A.contador.id]);
    const rs = [
      await v.http(A.contador, "GET", rutaAprender(x.c.id, PERIODO, x.id)),
      await v.http(A.contador, "POST", rutaAprender(x.c.id, PERIODO, x.id), { terminos: [{ termino: "audifonos", categoria: "entretenimiento" }] }),
      await v.http(A.contador, "PUT", rutaCategorias(x.c.id), { permitidas: ["juguetes"], quitadas: [], version: 0 }),
      await v.http(A.contador, "POST", rutaReevaluar(x.c.id, PERIODO)),
    ];
    for (const r of rs) expect([r.status, r.body], r.text).toEqual([404, NO_ENCONTRADO]);
    expect(await propias(A.est.tenantId)).toEqual([]);
    expect(await v.categoriasBd(A.est.tenantId, x.c.id)).toEqual([]);
  });

  it("Administrador desactivado a mitad (sesión viva): agregar palabra, umbral y global no escriben nada", async () => {
    const A = await abrir();
    const adm = await v.b.c.p.b.miembro(A.est.tenantId, "admin");
    const palabra = unica("desac");
    expect((await v.http(adm, "GET", "/estudio/reglas-motor/gastos")).status).toBe(200);
    await v.b.sql("update membresia set desactivada_en = now() where tenant_id = $1 and usuario_id = $2", [A.est.tenantId, adm.id]);
    const rs = [
      await v.http(adm, "POST", rutaPalabras(), { palabra, categoria: "juguetes" }),
      await v.http(adm, "PUT", rutaUmbral(), { umbral: 9, version: 0 }),
      await v.http(adm, "PUT", `/estudio/reglas-motor/gastos/globales/${await v.idGlobal("polo")}`, { activa: false }),
    ];
    for (const r of rs) expect([401, 403], r.text).toContain(r.status);
    expect(await propias(A.est.tenantId)).toEqual([]);
    expect(await v.configBd(A.est.tenantId)).toEqual([]);
    expect(await v.desactivadasBd(A.est.tenantId)).toEqual([]);
  });

  it("plataforma: el Dueño de un estudio recibe 403; un super-admin al que le quitan el alta con la sesión viva recibe 403 y no escribe", async () => {
    const A = await abrir();
    const palabra = unica("plat");
    for (const [m, r, c] of [
      ["GET", RUTA_PLATAFORMA, undefined],
      ["POST", RUTA_PLATAFORMA, { palabra, categoria: "juguetes" }],
    ] as const) {
      const resp = await v.http(A.est.titular, m, r, c);
      expect([resp.status, resp.body], resp.text).toEqual([403, PERMISO_DENEGADO]);
    }
    const sa = await v.superAdmin();
    expect((await v.plataforma(sa, "GET", RUTA_PLATAFORMA)).status).toBe(200);
    const id = await v.idGlobal("polo");
    const antes = await v.globalBd("polo");
    await v.b.sql("delete from admin_plataforma where usuario_id = $1", [sa.id]);
    const rs = [
      await v.plataforma(sa, "POST", RUTA_PLATAFORMA, { palabra, categoria: "juguetes" }),
      await v.plataforma(sa, "PUT", rutaPlataformaPalabra(id), { categoria: "juguetes", excepciones: [], activa: false, version: antes.version }),
    ];
    for (const r of rs) expect([401, 403], r.text).toContain(r.status);
    expect(await v.globalBd(palabra)).toBeNull();
    expect(await v.globalBd("polo")).toEqual(antes);
  });
});

describe("T15 · límite de 2.000 y concurrencia (R-4, CA-9; 04 §2.3 límites)", () => {
  it("con 1.997 activas, 3 agregados, 1 reactivación y un aprender de 2 términos a la vez: termina en 2.000 exactas, sin 5xx, el resto 409 limite_palabras", async () => {
    const L = await abrir();
    const x = await conGlosa(L, "AUDIFONOS BLUETOOTH JBL");
    await excluir(L.contador, x);
    await v.sembrarPropiasMasivas(L.est.tenantId, 1997, L.est.titular.id);
    const dormida = await v.sembrarPropia(L.est.tenantId, { palabra: unica("dormida"), categoria: "juguetes", creadoPor: L.est.titular.id, activa: false } as any);
    const dueno = L.est.titular;
    const rs = await Promise.all([
      v.http(dueno, "POST", rutaPalabras(), { palabra: unica("conc"), categoria: "juguetes" }),
      v.http(dueno, "POST", rutaPalabras(), { palabra: unica("conc"), categoria: "juguetes" }),
      v.http(dueno, "POST", rutaPalabras(), { palabra: unica("conc"), categoria: "juguetes" }),
      v.http(dueno, "PUT", rutaPalabra(dormida), { activa: true, version: 1 }),
      v.http(dueno, "POST", rutaAprender(x.c.id, PERIODO, x.id), {
        terminos: [
          { termino: unica("apr"), categoria: "entretenimiento" },
          { termino: unica("apr"), categoria: "entretenimiento" },
        ],
      }),
    ]);
    no5xx(rs);
    for (const r of rs) if (r.status >= 400) expect([r.status, r.body], r.text).toEqual([409, { codigo: "limite_palabras" }]);
    expect(await activas(L.est.tenantId)).toBe(2000);
  });
});

describe("T15 · «Volver a evaluar» (R-12, CA-12; cola)", () => {
  it("claves extra en el cuerpo, periodo mal formado, cliente de otro estudio: 400/400/404 y ningún trabajo", async () => {
    const A = await abrir();
    const B = await abrir();
    const c = await v.cliente(A.est, { responsable: A.contador.id });
    const cb = await v.cliente(B.est, { responsable: B.contador.id });
    const rs = [
      [await v.http(A.contador, "POST", rutaReevaluar(c.id, PERIODO), { periodo: PERIODO }), 400, SOLICITUD_INVALIDA],
      [await v.http(A.contador, "POST", rutaReevaluar(c.id, PERIODO), { __proto__: { x: 1 }, clienteId: cb.id }), 400, SOLICITUD_INVALIDA],
      [await v.http(A.contador, "POST", rutaReevaluar(c.id, "202613")), 400, SOLICITUD_INVALIDA],
      [await v.http(A.est.titular, "POST", rutaReevaluar(cb.id, PERIODO)), 404, NO_ENCONTRADO],
    ] as const;
    for (const [r, s, b] of rs) expect([r.status, r.body], r.text).toEqual([s, b]);
    expect(await v.trabajosReevaluar(A.est.tenantId, c.id)).toEqual([]);
    expect(await v.trabajosReevaluar(B.est.tenantId, cb.id)).toEqual([]);
  });

  it("una ráfaga de 40 pedidos simultáneos del mismo cliente y periodo: todos 202 con el mismo trabajo y uno solo en la cola", async () => {
    const A = await abrir();
    const c = await v.cliente(A.est, { responsable: A.contador.id });
    const rs = await Promise.all(Array.from({ length: 40 }, () => v.http(A.contador, "POST", rutaReevaluar(c.id, PERIODO))));
    no5xx(rs);
    expect(rs.map((r) => r.status)).toEqual(rs.map(() => 202));
    expect(new Set(rs.map((r) => r.body.trabajoId)).size).toBe(1);
    expect(await v.trabajosReevaluar(A.est.tenantId, c.id)).toHaveLength(1);
  });
});

describe("T15 · D-7: un R-GP sin palabra guardado antes no se acepta (R-1, R-11, CA-18)", () => {
  it("hallazgo legado {palabra: null} de una compra sin palabra (solo S2): aceptar con confirmar da 409 revisar_de_nuevo y no excluye", async () => {
    const A = await abrir();
    const x = await conGlosa(A, "SERVICIO DE CEMENTO", { ciiuCliente: FERRETERIA, ciiuProveedor: TIENDA_ROPA });
    expect(await v.hallazgosGp(x.id)).toEqual([]);
    // Lo que guardaba la evaluación antes de D-7: R-GP por S2 (+3) con umbral 3.
    await v.b.sql(
      `insert into compra_hallazgo (tenant_id, compra_id, version_n, evaluacion_n, regla, sugerencia, lecturas, requiere_confirmacion)
       select c.tenant_id, c.id, c.version_vigente, (select max(e.n) from compra_evaluacion e where e.compra_id = c.id and e.version_n = c.version_vigente),
              'R-GP', $2::jsonb, '{}'::jsonb, true
         from compra c where c.id = $1`,
      [x.id, JSON.stringify({ tipo: "excluir", palabra: null, categoria: null, puntaje: 3, senales: [{ codigo: "S2", puntos: 3 }] })],
    );
    expect(await v.hallazgosGp(x.id)).toHaveLength(1);
    const antes = await v.foto(x.c.id);
    const r = await v.llamar(A.contador, "POST", `${base(x.c.id)}/${x.id}/sugerencias/aceptar`, { versionBase: 1, regla: "R-GP", confirmar: true });
    expect([r.status, r.body], r.text).toEqual([409, { codigo: "revisar_de_nuevo" }]);
    expect(await v.foto(x.c.id)).toEqual(antes);
  });
});
