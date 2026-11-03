/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON dinámicos en pruebas */
// Spec 007a (T3, rojo): rutas de alta y edición de clientes y cupo de RUCs.
// Cubre CA-1 (RUC, razón social provisional, responsableId), CA-2 (cupo al crear, ruc_duplicado, sin_plan),
// CA-4 (catálogo del perfil fiscal) y los permisos clientes.crear/editar/archivar (D3).
// Contrato (plan: HTTP): POST /clientes -> 201 ClienteDto · 400 `solicitud_invalida` · 409 `cupo_rucs` | `ruc_duplicado` |
// `sin_plan`; PATCH /clientes/:id -> 200 · 400 · 404 · 409 `cliente_archivado`. Errores `{codigo}` y `Cache-Control: no-store`.
// Rojo: POST/PATCH/archivar/reactivar aún no existen, ni las columnas de perfil de `cliente` (T5, T9).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  abrirBancoClientes,
  PERFIL_POR_DEFECTO,
  rucConVerificadorMalo,
  rucValido,
  type Actor,
  type BancoClientes,
  type Estudio,
} from "../../../test/soporte-clientes.js";
import { forma } from "../../../test/soporte.js";

let c: BancoClientes;
let E: Estudio; // plan sin límite práctico (corporativo)
let admin: Actor;
let contador: Actor;
let asistente: Actor;
let lectura: Actor;

beforeAll(async () => {
  c = await abrirBancoClientes();
  E = await c.p.b.estudio();
  admin = await c.p.b.miembro(E.tenantId, "admin");
  contador = await c.p.b.miembro(E.tenantId, "contador");
  asistente = await c.p.b.miembro(E.tenantId, "asistente");
  lectura = await c.p.b.miembro(E.tenantId, "lectura");
});
afterAll(async () => {
  await c?.cerrar();
});

const llamar = (a: Actor, m: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", ruta: string, cuerpo?: unknown) => c.p.b.llamar(a, m, ruta, cuerpo);
const CLAVES_DTO = [
  "archivado",
  "condicionContribuyente",
  "credenciales",
  "estadoContribuyente",
  "id",
  "perfil",
  "razonSocial",
  "responsable",
  "ruc",
];
const PERFIL_COMPLETO = { regimen: "rmt", zona: "amazonia", ventasExoneradas: true, ventasMixtas: true, monedaHabitual: "USD" } as const;

describe("CA-1 · RUC inválido: 400 y no se escribe nada (D2)", () => {
  const malos: [string, unknown][] = [
    ["dígito verificador equivocado", rucConVerificadorMalo()],
    ["prefijo no permitido (30)", "30123456789"],
    ["prefijo no permitido (11)", "11111111111"],
    ["10 dígitos", rucValido().slice(0, 10)],
    ["12 dígitos", `${rucValido()}0`],
    ["con letras", "2012345678a"],
    ["con espacios", ` ${rucValido()}`],
    ["con guion", `${rucValido().slice(0, 4)}-${rucValido().slice(4)}`],
    ["vacío", ""],
    ["dígitos Unicode no ASCII", "２０１２３４５６７８９"],
    ["número en lugar de texto", 20123456789],
    ["null", null],
  ];
  it.each(malos)("RUC con %s da 400 solicitud_invalida", async (_nombre, ruc) => {
    const antes = await c.total(E.tenantId);
    const r = await c.crear(E.titular, { ruc });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect(await c.total(E.tenantId)).toBe(antes);
  });

  it("sin RUC, cuerpo vacío o no objeto dan 400 y no escriben", async () => {
    const antes = await c.total(E.tenantId);
    for (const cuerpo of [{}, { razonSocial: "Sin RUC SAC" }, [], "texto", 7]) {
      const r = await c.crear(E.titular, cuerpo);
      expect(r.status, JSON.stringify(cuerpo)).toBe(400);
      expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    }
    expect(await c.total(E.tenantId)).toBe(antes);
  });

  it("acepta los cinco prefijos permitidos (10, 15, 16, 17, 20)", async () => {
    for (const prefijo of ["10", "15", "16", "17", "20"] as const) {
      const ruc = rucValido(prefijo);
      const r = await c.crear(E.titular, { ruc, razonSocial: `Prefijo ${prefijo} SAC` });
      expect(r.status, `${prefijo}: ${r.text}`).toBe(201);
      expect(r.body.ruc).toBe(ruc);
    }
  });

  it("el 400 del RUC no se anticipa al permiso: sin clientes.crear el RUC inválido da 403", async () => {
    const r = await c.crear(asistente, { ruc: "123" });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ codigo: "permiso_denegado" });
  });
});

describe("CA-1 · alta correcta, razón social provisional y lectura posterior", () => {
  it("201 con el ClienteDto completo, no-store, y el cliente aparece en el listado y en el detalle", async () => {
    const ruc = rucValido();
    const r = await c.crear(E.titular, { ruc, razonSocial: "Comercial Los Andes SAC" });
    expect(r.status).toBe(201);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(Object.keys(r.body).sort()).toEqual(CLAVES_DTO);
    expect(r.body).toMatchObject({
      ruc,
      razonSocial: "Comercial Los Andes SAC",
      archivado: false,
      estadoContribuyente: null,
      condicionContribuyente: null,
      perfil: PERFIL_POR_DEFECTO,
      responsable: null,
      credenciales: { sol: "no_configurada", sire_api: "no_configurada" },
    });
    expect(r.body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    const lista = await llamar(E.titular, "GET", "/clientes");
    expect(lista.status).toBe(200);
    expect(lista.body.find((x: any) => x.id === r.body.id)).toEqual(r.body);
    const detalle = await llamar(E.titular, "GET", `/clientes/${r.body.id}`);
    expect(detalle.status).toBe(200);
    expect(detalle.body).toEqual(r.body);
    expect((await c.fila(r.body.id)).tenant_id).toBe(E.tenantId);
  });

  it("sin razón social queda «RUC <número>»; con razón social vacía o de 201 caracteres, 400", async () => {
    const ruc = rucValido();
    const r = await c.crear(E.titular, { ruc });
    expect(r.status).toBe(201);
    expect(r.body.razonSocial).toBe(`RUC ${ruc}`);
    expect((await c.fila(r.body.id)).razon_social).toBe(`RUC ${ruc}`);

    for (const razonSocial of ["", "x".repeat(201), 5]) {
      const mala = await c.crear(E.titular, { ruc: rucValido(), razonSocial });
      expect(mala.status, String(razonSocial).slice(0, 10)).toBe(400);
      expect(mala.body).toEqual({ codigo: "solicitud_invalida" });
    }
    const borde = await c.crear(E.titular, { ruc: rucValido(), razonSocial: "y".repeat(200) });
    expect(borde.status).toBe(201);
  });

  it("claves desconocidas se descartan: id, tenantId, archivadoAt, estados de contribuyente y credenciales no se aceptan del cliente HTTP", async () => {
    const otroEstudio = await c.p.b.estudio();
    const idForzado = randomUUID();
    const r = await c.crear(E.titular, {
      ruc: rucValido(),
      razonSocial: "Descarte SAC",
      id: idForzado,
      tenantId: otroEstudio.tenantId,
      archivadoAt: new Date().toISOString(),
      archivado: true,
      estadoContribuyente: "ACTIVO",
      condicionContribuyente: "HABIDO",
      credenciales: { sol: "verificada", sire_api: "verificada" },
    });
    expect(r.status).toBe(201);
    expect(r.body.id).not.toBe(idForzado);
    expect(r.body.archivado).toBe(false);
    expect(r.body.estadoContribuyente).toBeNull();
    expect(r.body.condicionContribuyente).toBeNull();
    expect(r.body.credenciales).toEqual({ sol: "no_configurada", sire_api: "no_configurada" });
    const fila = await c.fila(r.body.id);
    expect(fila.tenant_id).toBe(E.tenantId);
    expect(fila.archivado_at).toBeNull();
  });

  it("el estudio sale solo de la sesión: un cliente creado con X-Estudio de otro estudio se rechaza sin escribir", async () => {
    const otro = await c.p.b.estudio();
    const antes = await c.total(otro.tenantId);
    const r = await c.p.b.llamar(E.titular, "POST", "/clientes", { ruc: rucValido(), razonSocial: "Desfasado SAC" }, { estudio: otro.tenantId });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ codigo: "estudio_desfasado" });
    expect(await c.total(otro.tenantId)).toBe(antes);
  });

  it("Administrador también puede crear; el alta con perfil lo guarda y se lee igual al recargar (CA-4)", async () => {
    const r = await c.crear(admin, { ruc: rucValido(), razonSocial: "Perfil Completo SAC", perfil: PERFIL_COMPLETO });
    expect(r.status).toBe(201);
    expect(r.body.perfil).toEqual(PERFIL_COMPLETO);
    const lectura1 = await llamar(admin, "GET", `/clientes/${r.body.id}`);
    expect(lectura1.body.perfil).toEqual(PERFIL_COMPLETO);
    const fila = await c.fila(r.body.id);
    expect(fila).toMatchObject({ regimen: "rmt", zona: "amazonia", ventas_exoneradas: true, ventas_mixtas: true, moneda_habitual: "USD" });
  });
});

describe("CA-1 · responsableId (D3, regla D18 de 005)", () => {
  it("con un responsableId válido el cliente queda asignado a ese usuario como responsable", async () => {
    const r = await c.crear(E.titular, { ruc: rucValido(), razonSocial: "Con Responsable SAC", responsableId: contador.id });
    expect(r.status).toBe(201);
    expect(r.body.responsable).toEqual({ id: contador.id, nombre: expect.any(String) });
    expect(await c.asignaciones(r.body.id)).toEqual([{ usuario_id: contador.id, tipo: "responsable" }]);
    // El contador ve el cliente recién asignado (alcance por asignación).
    expect((await llamar(contador, "GET", `/clientes/${r.body.id}`)).status).toBe(200);
  });

  it("un asistente también puede ser responsable (tiene sire.clasificar)", async () => {
    const r = await c.crear(E.titular, { ruc: rucValido(), responsableId: asistente.id });
    expect(r.status).toBe(201);
    expect(r.body.responsable?.id).toBe(asistente.id);
  });

  it("responsableId que no es UUID da 400 y no escribe", async () => {
    const antes = await c.total(E.tenantId);
    for (const responsableId of ["no-es-uuid", "", 7]) {
      const r = await c.crear(E.titular, { ruc: rucValido(), responsableId });
      expect(r.status, String(responsableId)).toBe(400);
      expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    }
    expect(await c.total(E.tenantId)).toBe(antes);
  });

  it("quien no puede ser responsable (lectura) o está desactivado da 409 miembro_no_asignable y no escribe nada", async () => {
    const off = await c.p.b.miembro(E.tenantId, "contador", { sesion: false });
    await c.p.sql("update membresia set desactivada_en = now() where tenant_id = $1 and usuario_id = $2", [E.tenantId, off.id]);
    const antes = await c.total(E.tenantId);
    for (const u of [lectura.id, off.id]) {
      const r = await c.crear(E.titular, { ruc: rucValido(), responsableId: u });
      expect(r.status).toBe(409);
      expect(r.body).toEqual({ codigo: "miembro_no_asignable" });
    }
    expect(await c.total(E.tenantId)).toBe(antes);
  });

  it("un usuario de otro estudio o inexistente da 404 no_encontrado (como en 005) y no se crea el cliente ni se asigna a nadie", async () => {
    const otro = await c.p.b.estudio();
    const ajeno = await c.p.b.miembro(otro.tenantId, "contador", { sesion: false });
    // Control positivo: la ruta existe y acepta un responsable válido.
    expect((await c.crear(E.titular, { ruc: rucValido(), responsableId: contador.id })).status).toBe(201);
    const antes = await c.total(E.tenantId);
    for (const responsableId of [ajeno.id, randomUUID()]) {
      const r = await c.crear(E.titular, { ruc: rucValido(), responsableId });
      expect(r.status, `${r.status} ${r.text}`).toBe(404);
      expect(r.body).toEqual({ codigo: "no_encontrado" });
    }
    expect(await c.total(E.tenantId)).toBe(antes);
    expect(await c.p.sql("select 1 from asignacion where tenant_id = $1 and usuario_id = $2", [E.tenantId, ajeno.id])).toEqual([]);
  });
});

describe("CA-2 · ruc_duplicado (unique (tenant_id, ruc), también contra un archivado)", () => {
  it("el mismo RUC en el mismo estudio da 409 ruc_duplicado y no escribe ni asigna", async () => {
    const ruc = rucValido();
    expect((await c.crear(E.titular, { ruc, razonSocial: "Primero SAC" })).status).toBe(201);
    const antes = await c.total(E.tenantId);
    const r = await c.crear(E.titular, { ruc, razonSocial: "Segundo SAC", responsableId: contador.id });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ codigo: "ruc_duplicado" });
    expect(await c.total(E.tenantId)).toBe(antes);
    expect(r.text).not.toContain("Segundo SAC");
  });

  it("el mismo RUC en otro estudio sí se puede dar de alta", async () => {
    const ruc = rucValido();
    const otro = await c.p.b.estudio();
    expect((await c.crear(E.titular, { ruc })).status).toBe(201);
    expect((await c.crear(otro.titular, { ruc })).status).toBe(201);
  });

  it("también si el existente está archivado: 409 ruc_duplicado (no 201 ni cupo_rucs)", async () => {
    const { id, ruc } = await c.sembrar(E.tenantId, { archivado: true });
    const r = await c.crear(E.titular, { ruc });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ codigo: "ruc_duplicado" });
    expect((await c.fila(id)).archivado_at).not.toBeNull();
  });
});

describe("CA-2 · cupo de RUCs al crear (D4)", () => {
  it("con el cupo lleno: 409 cupo_rucs sin datos del plan, nada escrito (ni cliente ni asignación)", async () => {
    const F = await c.estudioCon(3);
    const resp = await c.p.b.miembro(F.tenantId, "contador", { sesion: false });
    for (let i = 0; i < 3; i++) expect((await c.crear(F.titular, { ruc: rucValido() })).status).toBe(201);
    const r = await c.crear(F.titular, { ruc: rucValido(), responsableId: resp.id });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ codigo: "cupo_rucs" });
    expect(await c.total(F.tenantId)).toBe(3);
    expect(await c.p.sql("select 1 from asignacion where tenant_id = $1", [F.tenantId])).toEqual([]);
    const uso = await c.uso(F.titular);
    expect(uso.body.rucs).toMatchObject({ usados: 3, limite: 3, libres: 0 });
  });

  it("los archivados no cuentan: con 2 archivados y límite 2 entran 2 activos y el tercero da cupo_rucs", async () => {
    const F = await c.estudioCon(2);
    await c.sembrar(F.tenantId, { archivado: true });
    await c.sembrar(F.tenantId, { archivado: true });
    expect((await c.crear(F.titular, { ruc: rucValido() })).status).toBe(201);
    expect((await c.crear(F.titular, { ruc: rucValido() })).status).toBe(201);
    const r = await c.crear(F.titular, { ruc: rucValido() });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ codigo: "cupo_rucs" });
    expect(await c.activos(F.tenantId)).toBe(2);
    expect(await c.total(F.tenantId)).toBe(4);
  });

  it("archivar libera el cupo: /plan/uso cuenta solo activos y el alta siguiente entra", async () => {
    const F = await c.estudioCon(2);
    const a = (await c.crear(F.titular, { ruc: rucValido() })).body;
    await c.crear(F.titular, { ruc: rucValido() });
    expect((await c.uso(F.titular)).body.rucs).toMatchObject({ usados: 2, libres: 0 });
    expect((await c.crear(F.titular, { ruc: rucValido() })).body).toEqual({ codigo: "cupo_rucs" });

    const arch = await llamar(F.titular, "POST", `/clientes/${a.id}/archivar`);
    expect(arch.status).toBe(200);
    expect((await c.uso(F.titular)).body.rucs).toMatchObject({ usados: 1, libres: 1 });
    expect((await c.crear(F.titular, { ruc: rucValido() })).status).toBe(201);
    expect((await c.uso(F.titular)).body.rucs).toMatchObject({ usados: 2, libres: 0 });
  });

  it("el borde entra: con límite 1 y 0 activos se crea uno; el segundo no", async () => {
    const F = await c.estudioCon(1);
    expect((await c.crear(F.titular, { ruc: rucValido() })).status).toBe(201);
    expect((await c.crear(F.titular, { ruc: rucValido() })).status).toBe(409);
  });

  it("sin suscripción falla cerrado: 409 sin_plan y no escribe", async () => {
    const sinPlan = await c.p.estudio(null);
    const r = await c.crear(sinPlan.titular, { ruc: rucValido() });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ codigo: "sin_plan" });
    expect(await c.total(sinPlan.tenantId)).toBe(0);
  });

  it("el límite se relee en cada petición: subir el plan en BD habilita el alta sin reiniciar", async () => {
    const plan = await c.p.plan({ maxRucs: 1, maxUsuarios: null });
    const F = await c.p.estudio(plan);
    expect((await c.crear(F.titular, { ruc: rucValido() })).status).toBe(201);
    expect((await c.crear(F.titular, { ruc: rucValido() })).status).toBe(409);
    await c.p.editarPlan(plan, { max_rucs: 2 });
    expect((await c.crear(F.titular, { ruc: rucValido() })).status).toBe(201);
  });

  it("el cupo de un estudio no se ve afectado por los clientes de otro (RLS)", async () => {
    const lleno = await c.estudioCon(1);
    const libre = await c.estudioCon(1);
    expect((await c.crear(lleno.titular, { ruc: rucValido() })).status).toBe(201);
    expect((await c.crear(libre.titular, { ruc: rucValido() })).status).toBe(201);
  });
});

describe("CA-4 · datos fiscales: catálogo y lectura al recargar (D1)", () => {
  let id: string;
  beforeAll(async () => {
    id = (await c.sembrar(E.tenantId, { razonSocial: "Fiscal SAC" })).id;
  });
  const patch = (cuerpo: unknown, a: Actor = E.titular) => llamar(a, "PATCH", `/clientes/${id}`, cuerpo);

  it("PATCH con un perfil válido responde 200 con el DTO y se lee igual al recargar", async () => {
    const r = await patch({ perfil: PERFIL_COMPLETO });
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(r.body.perfil).toEqual(PERFIL_COMPLETO);
    expect((await llamar(E.titular, "GET", `/clientes/${id}`)).body.perfil).toEqual(PERFIL_COMPLETO);
    expect((await llamar(E.titular, "GET", "/clientes")).body.find((x: any) => x.id === id).perfil).toEqual(PERFIL_COMPLETO);
    expect(await c.fila(id)).toMatchObject({ regimen: "rmt", zona: "amazonia", ventas_exoneradas: true, ventas_mixtas: true, moneda_habitual: "USD" });
  });

  it("cada régimen del catálogo, y «sin definir» (null), se aceptan", async () => {
    for (const regimen of ["rg", "rmt", "rer", "nrus", null] as const) {
      const r = await patch({ perfil: { ...PERFIL_POR_DEFECTO, regimen } });
      expect(r.status, String(regimen)).toBe(200);
      expect(r.body.perfil.regimen).toBe(regimen);
    }
  });

  it.each([
    ["régimen fuera del catálogo", { regimen: "mype" }],
    ["régimen vacío", { regimen: "" }],
    ["zona fuera del catálogo", { zona: "selva" }],
    ["zona nula", { zona: null }],
    ["moneda fuera del catálogo", { monedaHabitual: "EUR" }],
    ["moneda en minúsculas", { monedaHabitual: "pen" }],
    ["ventasExoneradas no booleano", { ventasExoneradas: "si" }],
    ["ventasMixtas no booleano", { ventasMixtas: 1 }],
  ])("%s da 400 solicitud_invalida y no cambia nada", async (_n, cambio) => {
    const antes = await c.fila(id);
    const r = await patch({ perfil: { ...PERFIL_POR_DEFECTO, ...cambio } });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect(await c.fila(id)).toEqual(antes);
  });

  it("un perfil incompleto o que no es objeto da 400", async () => {
    for (const perfil of [{ regimen: "rg" }, "rg", []]) {
      const r = await patch({ perfil });
      expect(r.status, JSON.stringify(perfil)).toBe(400);
    }
  });

  it("los mismos valores fuera del catálogo dan 400 al crear y no escriben", async () => {
    const antes = await c.total(E.tenantId);
    for (const perfil of [
      { ...PERFIL_POR_DEFECTO, regimen: "mype" },
      { ...PERFIL_POR_DEFECTO, zona: "selva" },
      { ...PERFIL_POR_DEFECTO, monedaHabitual: "EUR" },
    ]) {
      const r = await c.crear(E.titular, { ruc: rucValido(), perfil });
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    }
    expect(await c.total(E.tenantId)).toBe(antes);
  });

  it("PATCH edita la razón social (1–200) y rechaza vacía o de 201", async () => {
    const r = await patch({ razonSocial: "Razón Nueva S.A.C." });
    expect(r.status).toBe(200);
    expect(r.body.razonSocial).toBe("Razón Nueva S.A.C.");
    expect((await c.fila(id)).razon_social).toBe("Razón Nueva S.A.C.");
    for (const razonSocial of ["", "x".repeat(201)]) expect((await patch({ razonSocial })).status).toBe(400);
    expect((await patch({ razonSocial: "z".repeat(200) })).status).toBe(200);
  });

  it("el RUC es inmutable y los estados del contribuyente no se editan por HTTP (claves descartadas)", async () => {
    const antes = await c.fila(id);
    const r = await patch({ ruc: rucValido(), estadoContribuyente: "ACTIVO", condicionContribuyente: "HABIDO", archivadoAt: "2026-01-01T00:00:00Z", tenantId: randomUUID() });
    expect(r.status).toBe(200);
    expect(r.body.ruc).toBe(antes.ruc);
    expect(r.body.estadoContribuyente).toBeNull();
    expect(r.body.condicionContribuyente).toBeNull();
    const despues = await c.fila(id);
    expect(despues.ruc).toBe(antes.ruc);
    expect(despues.tenant_id).toBe(E.tenantId);
    expect(despues.archivado_at).toBeNull();
  });

  it("Administrador edita; PATCH solo de la razón social conserva el perfil", async () => {
    await patch({ perfil: PERFIL_COMPLETO });
    const r = await patch({ razonSocial: "Solo Nombre SAC" }, admin);
    expect(r.status).toBe(200);
    expect(r.body.perfil).toEqual(PERFIL_COMPLETO);
  });
});

describe("Permisos (D3): crear, editar y archivar/reactivar; lectura no escribe", () => {
  let id: string;
  let idArchivado: string;
  beforeAll(async () => {
    id = (await c.sembrar(E.tenantId, { razonSocial: "Permisos SAC" })).id;
    // Todos ven el cliente: así el 403 no puede confundirse con un 404 de alcance.
    for (const u of [contador, asistente, lectura]) await c.p.sql("insert into asignacion (tenant_id, cliente_id, usuario_id, tipo) values ($1, $2, $3, 'colaborador')", [E.tenantId, id, u.id]);
    idArchivado = (await c.sembrar(E.tenantId, { archivado: true })).id;
  });

  it.each(["contador", "asistente", "lectura"] as const)("%s no puede crear, editar, archivar ni reactivar: 403 permiso_denegado y no cambia nada", async (rol) => {
    const a = { contador, asistente, lectura }[rol];
    const antes = await c.fila(id);
    const total = await c.total(E.tenantId);
    const rs = [
      await c.crear(a, { ruc: rucValido() }),
      await llamar(a, "PATCH", `/clientes/${id}`, { razonSocial: "Cambiado" }),
      await llamar(a, "POST", `/clientes/${id}/archivar`),
      await llamar(a, "POST", `/clientes/${idArchivado}/reactivar`),
    ];
    for (const r of rs) {
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ codigo: "permiso_denegado" });
    }
    expect(await c.fila(id)).toEqual(antes);
    expect((await c.fila(idArchivado)).archivado_at).not.toBeNull();
    expect(await c.total(E.tenantId)).toBe(total);
  });

  it("el permiso se exige antes de mirar el cliente: 403 idéntico exista, esté asignado o no", async () => {
    const casos = [id, randomUUID(), "no-es-un-uuid"];
    for (const [metodo, sufijo] of [["PATCH", ""], ["POST", "/archivar"], ["POST", "/reactivar"]] as const) {
      const formas = [];
      for (const cid of casos) formas.push(forma(await llamar(lectura, metodo, `/clientes/${cid}${sufijo}`, metodo === "PATCH" ? { razonSocial: "x" } : undefined)));
      for (const f of formas) expect(f).toEqual(formas[0]);
      expect(formas[0]!.status).toBe(403);
    }
  });

  it("lectura sí lista y abre sus clientes (clientes.ver) pero no escribe", async () => {
    expect((await llamar(lectura, "GET", `/clientes/${id}`)).status).toBe(200);
    expect((await llamar(lectura, "GET", "/clientes")).body.map((x: any) => x.id)).toContain(id);
  });

  it("Dueño y Administrador sí archivan y reactivan", async () => {
    const a = await c.sembrar(E.tenantId);
    expect((await llamar(admin, "POST", `/clientes/${a.id}/archivar`)).status).toBe(200);
    expect((await llamar(E.titular, "POST", `/clientes/${a.id}/reactivar`)).status).toBe(200);
  });
});
