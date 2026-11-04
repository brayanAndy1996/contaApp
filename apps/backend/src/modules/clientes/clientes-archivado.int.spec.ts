/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON dinámicos en pruebas */
// Spec 007a (T3, rojo): alcance (CA-3), archivar/reactivar (CA-2, CA-5) y carreras HTTP (CA-7).
// Contrato (plan: HTTP): POST /clientes/:id/archivar -> 200 ClienteDto (idempotente) · 404; POST .../reactivar -> 200 · 404 ·
// 409 `cupo_rucs`; PATCH y asignar sobre un archivado -> 409 `cliente_archivado`; todo `:clienteId` pasa por
// `ClienteScopeGuard` (inexistente, ajeno y no asignado dan el mismo 404). El despacho que cancela trabajos de un archivado
// (revalidarEncolado, CA-5) lo prueban tests/aislamiento/clientes-funciones.spec.ts y las de 008 (T1, T8).
// Rojo: las rutas, la tabla `cliente` ampliada (`archivado_at`) y la regla «cliente_archivado» aún no existen (T5, T8, T9).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  abrirBancoClientes,
  rucValido,
  type Actor,
  type BancoClientes,
  type Estudio,
} from "../../../test/soporte-clientes.js";
import { forma } from "../../../test/soporte.js";

let c: BancoClientes;
beforeAll(async () => {
  c = await abrirBancoClientes();
});
afterAll(async () => {
  await c?.cerrar();
});

const llamar = (a: Actor, m: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", ruta: string, cuerpo?: unknown) => c.p.b.llamar(a, m, ruta, cuerpo);
const archivar = (a: Actor, id: string) => llamar(a, "POST", `/clientes/${id}/archivar`);
const reactivar = (a: Actor, id: string) => llamar(a, "POST", `/clientes/${id}/reactivar`);
const ids = (r: { body: any }): string[] => r.body.map((x: any) => x.id);

describe("CA-3 · asistente con 15 de 120 clientes: listado, búsqueda y URL ajena", () => {
  let E: Estudio;
  let ajeno: Estudio;
  let asistente: Actor;
  let contador: Actor;
  let propios: string[];
  let rucsPropios: string[];
  let noPropios: { id: string; ruc: string; razonSocial: string }[];
  let clienteAjeno: string;

  beforeAll(async () => {
    E = await c.p.b.estudio();
    ajeno = await c.p.b.estudio();
    asistente = await c.p.b.miembro(E.tenantId, "asistente");
    contador = await c.p.b.miembro(E.tenantId, "contador");
    clienteAjeno = (await c.sembrar(ajeno.tenantId, { razonSocial: "Cliente Ajeno SAC" })).id;
    const todos: { id: string; ruc: string; razonSocial: string }[] = [];
    for (let i = 0; i < 120; i++) {
      const razonSocial = `Cliente ${String(i + 1).padStart(3, "0")} SAC`;
      const colaboradores = i < 14 ? [asistente.id] : [];
      const s = await c.sembrar(E.tenantId, { razonSocial, responsable: i === 14 ? asistente.id : undefined, colaboradores });
      todos.push({ ...s, razonSocial });
    }
    propios = todos.slice(0, 15).map((x) => x.id);
    rucsPropios = todos.slice(0, 15).map((x) => x.ruc);
    noPropios = todos.slice(15);
    await c.p.sql("insert into asignacion (tenant_id, cliente_id, usuario_id, tipo) values ($1, $2, $3, 'responsable')", [E.tenantId, todos[20]!.id, contador.id]);
  }, 120_000);

  it("lista exactamente sus 15, ordenados por razón social, con el ClienteDto completo", async () => {
    const r = await llamar(asistente, "GET", "/clientes");
    expect(r.status).toBe(200);
    expect(ids(r).sort()).toEqual([...propios].sort());
    const nombres = r.body.map((x: any) => x.razonSocial);
    expect(nombres).toEqual([...nombres].sort());
    expect(Object.keys(r.body[0]).sort()).toEqual(
      ["archivado", "condicionContribuyente", "credenciales", "estadoContribuyente", "id", "perfil", "razonSocial", "responsable", "ruc"],
    );
    expect(r.body[14].responsable).toEqual({ id: asistente.id, nombre: expect.any(String) });
    expect(r.body[0].responsable).toBeNull();
    expect(r.body[0].credenciales).toEqual({ sol: "no_configurada", sire_api: "no_configurada" });
  });

  it("buscar por RUC o por razón social de un cliente ajeno no lo revela; los propios sí salen", async () => {
    for (const x of [noPropios[0]!, noPropios[50]!]) {
      expect((await llamar(asistente, "GET", `/clientes?q=${encodeURIComponent(x.ruc)}`)).body).toEqual([]);
      expect((await llamar(asistente, "GET", `/clientes?q=${encodeURIComponent(x.razonSocial)}`)).body).toEqual([]);
    }
    const propio = await llamar(asistente, "GET", `/clientes?q=${rucsPropios[3]}`);
    expect(ids(propio)).toEqual([propios[3]]);
    // «Cliente 0» coincide con 100+ de 120; el asistente solo ve los suyos.
    expect(ids(await llamar(asistente, "GET", "/clientes?q=Cliente"))).toHaveLength(15);
  });

  it("los filtros no amplían el alcance: responsable=ninguno y archivados=1 siguen dentro de los 15", async () => {
    for (const q of ["responsable=ninguno", "archivados=1", `responsable=${contador.id}`, "credencial=no_configurada"]) {
      const r = await llamar(asistente, "GET", `/clientes?${q}`);
      expect(r.status, q).toBe(200);
      for (const id of ids(r)) expect(propios, q).toContain(id);
    }
    expect(ids(await llamar(asistente, "GET", `/clientes?responsable=${contador.id}`))).toEqual([]);
  });

  it("GET de un cliente ajeno, de otro estudio, inexistente o con id mal formado da el mismo 404 (código, cuerpo y cabeceras)", async () => {
    const casos = [noPropios[0]!.id, clienteAjeno, randomUUID(), "no-es-un-uuid", "0"];
    const formas = [];
    for (const id of casos) formas.push(forma(await llamar(asistente, "GET", `/clientes/${id}`)));
    for (const f of formas) expect(f).toEqual(formas[0]);
    expect(formas[0]!.status).toBe(404);
    expect(formas[0]!.body).toEqual({ codigo: "no_encontrado" });
    expect((await llamar(asistente, "GET", `/clientes/${propios[0]}`)).status).toBe(200);
    expect((await llamar(E.titular, "GET", `/clientes/${noPropios[0]!.id}`)).status).toBe(200);
  });

  it("PATCH, archivar y reactivar: para quien carece del permiso el 403 es el mismo exista, esté asignado o no", async () => {
    const casos = [propios[0]!, noPropios[0]!.id, clienteAjeno, randomUUID(), "no-es-un-uuid"];
    for (const [metodo, sufijo] of [["PATCH", ""], ["POST", "/archivar"], ["POST", "/reactivar"]] as const) {
      const formas = [];
      for (const id of casos) formas.push(forma(await llamar(asistente, metodo, `/clientes/${id}${sufijo}`, metodo === "PATCH" ? { razonSocial: "x" } : undefined)));
      for (const f of formas) expect(f, `${metodo}${sufijo}`).toEqual(formas[0]);
      expect(formas[0]!.status).toBe(403);
    }
  });

  it("para quien sí tiene el permiso (Dueño), ajeno de otro estudio, inexistente y no-uuid dan el mismo 404 en PATCH, archivar y reactivar", async () => {
    const casos = [clienteAjeno, randomUUID(), "no-es-un-uuid", "0"];
    const filas = await c.p.sql("select id, archivado_at from cliente where id = $1", [clienteAjeno]);
    // Control positivo: las rutas existen y el Dueño las usa sobre un cliente propio (si no, todo daría 404 por ruta ausente).
    const propio = noPropios[10]!.id;
    expect((await llamar(E.titular, "PATCH", `/clientes/${propio}`, { razonSocial: "Control SAC" })).status).toBe(200);
    expect((await archivar(E.titular, propio)).status).toBe(200);
    expect((await reactivar(E.titular, propio)).status).toBe(200);
    for (const [metodo, sufijo] of [["GET", ""], ["PATCH", ""], ["POST", "/archivar"], ["POST", "/reactivar"]] as const) {
      const formas = [];
      for (const id of casos) formas.push(forma(await llamar(E.titular, metodo, `/clientes/${id}${sufijo}`, metodo === "PATCH" ? { razonSocial: "x" } : undefined)));
      for (const f of formas) expect(f, `${metodo}${sufijo}`).toEqual(formas[0]);
      expect(formas[0]!.status, `${metodo}${sufijo}`).toBe(404);
      expect(formas[0]!.body).toEqual({ codigo: "no_encontrado" });
    }
    // El cliente del otro estudio no se tocó.
    expect(await c.p.sql("select id, archivado_at from cliente where id = $1", [clienteAjeno])).toEqual(filas);
  });

  it("el 404 no distingue la rama: ajeno con el cupo lleno da 404 y no 409", async () => {
    const F = await c.estudioCon(1);
    expect((await c.crear(F.titular, { ruc: rucValido() })).status).toBe(201);
    const ajenoArchivado = await c.sembrar(ajeno.tenantId, { archivado: true });
    const r = await reactivar(F.titular, ajenoArchivado.id);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ codigo: "no_encontrado" });
  });
});

describe("CA-5 · archivar: solo lectura, fuera del listado, credenciales intactas", () => {
  let E: Estudio;
  let admin: Actor;
  let contador: Actor;
  beforeAll(async () => {
    E = await c.p.b.estudio();
    admin = await c.p.b.miembro(E.tenantId, "admin");
    contador = await c.p.b.miembro(E.tenantId, "contador");
  });

  it("archivar responde 200 con archivado=true, es idempotente y no cambia archivado_at al repetirse", async () => {
    const { id } = await c.sembrar(E.tenantId, { razonSocial: "Para Archivar SAC" });
    const r = await archivar(E.titular, id);
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(r.body).toMatchObject({ id, archivado: true, razonSocial: "Para Archivar SAC" });
    const primera = (await c.fila(id)).archivado_at;
    expect(primera).not.toBeNull();
    const otra = await archivar(admin, id);
    expect(otra.status).toBe(200);
    expect(otra.body.archivado).toBe(true);
    expect((await c.fila(id)).archivado_at).toEqual(primera);
  });

  it("el archivado sale del listado salvo archivados=1, y sigue abierto en solo lectura por su URL", async () => {
    const act = await c.sembrar(E.tenantId, { razonSocial: "Activo Visible SAC" });
    const arc = await c.sembrar(E.tenantId, { razonSocial: "Archivado Oculto SAC", archivado: true });
    const normal = await llamar(E.titular, "GET", "/clientes");
    expect(ids(normal)).toContain(act.id);
    expect(ids(normal)).not.toContain(arc.id);
    const con = await llamar(E.titular, "GET", "/clientes?archivados=1");
    expect(ids(con)).toContain(arc.id);
    expect(con.body.find((x: any) => x.id === arc.id).archivado).toBe(true);
    const detalle = await llamar(E.titular, "GET", `/clientes/${arc.id}`);
    expect(detalle.status).toBe(200);
    expect(detalle.body.archivado).toBe(true);
  });

  it("PATCH sobre un archivado da 409 cliente_archivado y no cambia nada (aunque los datos sean válidos)", async () => {
    const { id } = await c.sembrar(E.tenantId, { razonSocial: "Congelado SAC", archivado: true });
    const antes = await c.fila(id);
    for (const cuerpo of [{ razonSocial: "Otro nombre" }, { perfil: { regimen: "rg", zona: "general", ventasExoneradas: false, ventasMixtas: false, monedaHabitual: "PEN" } }]) {
      const r = await llamar(E.titular, "PATCH", `/clientes/${id}`, cuerpo);
      expect(r.status).toBe(409);
      expect(r.body).toEqual({ codigo: "cliente_archivado" });
    }
    expect(await c.fila(id)).toEqual(antes);
  });

  it("asignar (individual y masiva) sobre un archivado da 409 cliente_archivado y no escribe; la masiva es todo o nada", async () => {
    const vivo = await c.sembrar(E.tenantId, { razonSocial: "Vivo SAC" });
    const arc = await c.sembrar(E.tenantId, { razonSocial: "Archivado Asignar SAC", archivado: true });
    const individual = await llamar(E.titular, "PUT", `/clientes/${arc.id}/asignaciones/${contador.id}`, { tipo: "colaborador" });
    expect(individual.status).toBe(409);
    expect(individual.body).toEqual({ codigo: "cliente_archivado" });

    const porUsuario = await llamar(E.titular, "POST", "/asignaciones/por-usuario", { usuarioId: contador.id, clienteIds: [vivo.id, arc.id], tipo: "colaborador" });
    expect(porUsuario.status).toBe(409);
    expect(porUsuario.body).toEqual({ codigo: "cliente_archivado" });
    const porCliente = await llamar(E.titular, "POST", "/asignaciones/por-cliente", { clienteId: arc.id, usuarioIds: [contador.id] });
    expect(porCliente.status).toBe(409);
    expect(porCliente.body).toEqual({ codigo: "cliente_archivado" });

    expect(await c.asignaciones(arc.id)).toEqual([]);
    expect(await c.asignaciones(vivo.id)).toEqual([]); // el lote no aplicó ni al cliente vivo
    // Un cliente vivo sí se asigna.
    expect((await llamar(E.titular, "PUT", `/clientes/${vivo.id}/asignaciones/${contador.id}`, { tipo: "colaborador" })).status).toBe(200);
  });

  it("archivar no toca las credenciales: mismas filas, mismo sobre cifrado y mismo estado; el DTO solo muestra el estado", async () => {
    const { id } = await c.sembrar(E.tenantId, { razonSocial: "Con Credenciales SAC", sol: "verificada", sireApi: "invalida" });
    const antes = await c.huellaCredenciales(id);
    expect(antes).toHaveLength(2);
    const r = await archivar(E.titular, id);
    expect(r.status).toBe(200);
    expect(r.body.credenciales).toEqual({ sol: "verificada", sire_api: "invalida" });
    expect(r.text).not.toMatch(/ciphertext|nonce|dek|tag|secret|clave/i);
    expect(await c.huellaCredenciales(id)).toEqual(antes);
    const rr = await reactivar(E.titular, id);
    expect(rr.status).toBe(200);
    expect(await c.huellaCredenciales(id)).toEqual(antes); // al reactivar no se reingresan
    expect(rr.body.credenciales).toEqual({ sol: "verificada", sire_api: "invalida" });
  });

  it("archivar conserva las asignaciones y reactivar devuelve al cliente al listado de quien lo tenía", async () => {
    const { id } = await c.sembrar(E.tenantId, { razonSocial: "Conserva Asignación SAC", responsable: contador.id });
    expect(ids(await llamar(contador, "GET", "/clientes"))).toContain(id);
    expect((await archivar(E.titular, id)).status).toBe(200);
    expect(ids(await llamar(contador, "GET", "/clientes"))).not.toContain(id);
    expect(await c.asignaciones(id)).toEqual([{ usuario_id: contador.id, tipo: "responsable" }]);
    const rr = await reactivar(E.titular, id);
    expect(rr.status).toBe(200);
    expect(rr.body.archivado).toBe(false);
    expect(rr.body.responsable?.id).toBe(contador.id);
    expect(ids(await llamar(contador, "GET", "/clientes"))).toContain(id);
  });

  it("reactivar devuelve la edición: PATCH vuelve a funcionar", async () => {
    const { id } = await c.sembrar(E.tenantId, { razonSocial: "Reactivable SAC", archivado: true });
    expect((await llamar(E.titular, "PATCH", `/clientes/${id}`, { razonSocial: "Nuevo" })).status).toBe(409);
    const rr = await reactivar(E.titular, id);
    expect(rr.status).toBe(200);
    expect(rr.headers["cache-control"]).toMatch(/no-store/);
    expect(rr.body.archivado).toBe(false);
    expect((await c.fila(id)).archivado_at).toBeNull();
    const p = await llamar(E.titular, "PATCH", `/clientes/${id}`, { razonSocial: "Nuevo" });
    expect(p.status).toBe(200);
    expect(p.body.razonSocial).toBe("Nuevo");
  });
});

describe("CA-2 · reactivar respeta el cupo (D4)", () => {
  it("con el cupo lleno: 409 cupo_rucs y el cliente sigue archivado, sin escribir nada", async () => {
    const F = await c.estudioCon(2);
    const a = await c.sembrar(F.tenantId, { archivado: true });
    await c.sembrar(F.tenantId);
    await c.sembrar(F.tenantId);
    const antes = await c.fila(a.id);
    const r = await reactivar(F.titular, a.id);
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ codigo: "cupo_rucs" });
    expect(await c.fila(a.id)).toEqual(antes);
    expect(await c.activos(F.tenantId)).toBe(2);
    expect((await c.uso(F.titular)).body.rucs).toMatchObject({ usados: 2, limite: 2, libres: 0 });
  });

  it("archivar otro libera el cupo y entonces reactivar entra; /plan/uso sigue la cuenta de activos", async () => {
    const F = await c.estudioCon(2);
    const arc = await c.sembrar(F.tenantId, { archivado: true });
    const x = await c.sembrar(F.tenantId);
    await c.sembrar(F.tenantId);
    expect((await reactivar(F.titular, arc.id)).status).toBe(409);
    expect((await archivar(F.titular, x.id)).status).toBe(200);
    expect((await c.uso(F.titular)).body.rucs).toMatchObject({ usados: 1, libres: 1 });
    expect((await reactivar(F.titular, arc.id)).status).toBe(200);
    expect((await c.uso(F.titular)).body.rucs).toMatchObject({ usados: 2, libres: 0 });
    expect(await c.activos(F.tenantId)).toBe(2);
  });

  it("archivar no pide cupo: se puede archivar con el plan bajado por debajo del uso", async () => {
    const plan = await c.p.plan({ maxRucs: 4, maxUsuarios: null });
    const F = await c.p.estudio(plan);
    const a = await c.sembrar(F.tenantId);
    await c.sembrar(F.tenantId);
    await c.sembrar(F.tenantId);
    await c.p.editarPlan(plan, { max_rucs: 1 });
    expect((await c.crear(F.titular, { ruc: rucValido() })).status).toBe(409);
    expect((await archivar(F.titular, a.id)).status).toBe(200);
    expect(await c.activos(F.tenantId)).toBe(2);
  });

  it("sin suscripción, reactivar falla cerrado con 409 sin_plan y no escribe", async () => {
    const F = await c.p.estudio(null);
    const a = await c.sembrar(F.tenantId, { archivado: true });
    const r = await reactivar(F.titular, a.id);
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ codigo: "sin_plan" });
    expect((await c.fila(a.id)).archivado_at).not.toBeNull();
  });
});

describe("CA-7 · carreras HTTP: sin 500, sin interbloqueos y el cupo nunca se excede", () => {
  const sin500 = (rs: { status: number; text: string }[]) =>
    expect(rs.filter((r) => r.status >= 500).map((r) => `${r.status} ${r.text}`)).toEqual([]);
  const codigo = (r: { body: any }) => r.body?.codigo as string | undefined;

  it("seis altas simultáneas con dos cupos libres: entran exactamente dos, el resto da cupo_rucs", async () => {
    for (let ronda = 0; ronda < 3; ronda++) {
      const F = await c.estudioCon(5);
      for (let i = 0; i < 3; i++) await c.sembrar(F.tenantId);
      const rs = await Promise.all(Array.from({ length: 6 }, () => c.crear(F.titular, { ruc: rucValido() })));
      sin500(rs);
      expect(rs.filter((r) => r.status === 201), `ronda ${ronda}`).toHaveLength(2);
      expect(rs.filter((r) => r.status === 409).every((r) => codigo(r) === "cupo_rucs")).toBe(true);
      expect(await c.activos(F.tenantId)).toBe(5);
    }
  });

  it("el mismo RUC en cuatro altas simultáneas: un solo ganador y el resto ruc_duplicado", async () => {
    const F = await c.estudioCon(10);
    const ruc = rucValido();
    const rs = await Promise.all(Array.from({ length: 4 }, () => c.crear(F.titular, { ruc })));
    sin500(rs);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409).map(codigo)).toEqual(["ruc_duplicado", "ruc_duplicado", "ruc_duplicado"]);
    expect(await c.total(F.tenantId)).toBe(1);
  });

  it("reactivar y crear a la vez con un solo cupo libre: gana uno y el otro da cupo_rucs", async () => {
    for (let ronda = 0; ronda < 3; ronda++) {
      const F = await c.estudioCon(3);
      const arc = await c.sembrar(F.tenantId, { archivado: true });
      await c.sembrar(F.tenantId);
      await c.sembrar(F.tenantId);
      const [rr, cc] = await Promise.all([reactivar(F.titular, arc.id), c.crear(F.titular, { ruc: rucValido() })]);
      sin500([rr, cc]);
      expect([200, 409], `ronda ${ronda}: reactivar`).toContain(rr.status);
      expect([201, 409], `ronda ${ronda}: crear`).toContain(cc.status);
      expect([rr.status, cc.status].filter((s) => s === 409), `ronda ${ronda}`).toHaveLength(1);
      expect(await c.activos(F.tenantId)).toBe(3);
    }
  });

  it("dos reactivaciones simultáneas con un cupo libre: entra una", async () => {
    const F = await c.estudioCon(2);
    const a = await c.sembrar(F.tenantId, { archivado: true });
    const b = await c.sembrar(F.tenantId, { archivado: true });
    await c.sembrar(F.tenantId);
    const rs = await Promise.all([reactivar(F.titular, a.id), reactivar(F.titular, b.id)]);
    sin500(rs);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await c.activos(F.tenantId)).toBe(2);
  });

  it("archivar, reactivar y asignar sobre los mismos clientes, repetido: ningún 500 ni 40P01 y el estado final es coherente", async () => {
    const F = await c.estudioCon(20);
    const u1 = await c.p.b.miembro(F.tenantId, "contador", { sesion: false });
    const u2 = await c.p.b.miembro(F.tenantId, "asistente", { sesion: false });
    const a = await c.sembrar(F.tenantId, { razonSocial: "Carrera A" });
    const b = await c.sembrar(F.tenantId, { razonSocial: "Carrera B", archivado: true });
    const cc = await c.sembrar(F.tenantId, { razonSocial: "Carrera C" });
    const permitido = new Set([200, 201, 204, 409]); // 201: c.crear (CA-1)
    for (let ronda = 0; ronda < 12; ronda++) {
      const rs = await Promise.all([
        archivar(F.titular, a.id),
        reactivar(F.titular, b.id),
        archivar(F.titular, cc.id),
        reactivar(F.titular, a.id),
        llamar(F.titular, "PUT", `/clientes/${a.id}/asignaciones/${u1.id}`, { tipo: "colaborador" }),
        llamar(F.titular, "PUT", `/clientes/${b.id}/asignaciones/${u2.id}`, { tipo: "colaborador" }),
        llamar(F.titular, "POST", "/asignaciones/por-usuario", { usuarioId: u1.id, clienteIds: [a.id, b.id, cc.id], tipo: "colaborador" }),
        llamar(F.titular, "POST", "/asignaciones/por-cliente", { clienteId: cc.id, usuarioIds: [u1.id, u2.id] }),
        llamar(F.titular, "PATCH", `/clientes/${b.id}`, { razonSocial: `Carrera B ${ronda}` }),
        c.crear(F.titular, { ruc: rucValido(), responsableId: u1.id }),
      ]);
      sin500(rs);
      for (const r of rs) {
        expect(permitido.has(r.status), `ronda ${ronda}: ${r.status} ${r.text}`).toBe(true);
        if (r.status === 409) expect(["cliente_archivado", "cupo_rucs"], r.text).toContain(codigo(r));
      }
      expect(await c.activos(F.tenantId)).toBeLessThanOrEqual(20);
    }
    // El archivado y las asignaciones de un cliente archivado nunca quedan a medias: lo archivado no tiene asignaciones nuevas
    // creadas después de archivar (no se puede comprobar el orden), pero cada cliente tiene a lo sumo una fila por usuario.
    const dup = await c.p.sql(
      "select cliente_id, usuario_id, count(*)::int n from asignacion where tenant_id = $1 group by 1, 2 having count(*) > 1",
      [F.tenantId],
    );
    expect(dup).toEqual([]);
  }, 60_000);

  it("archivar y reactivar el mismo cliente a la vez, muchas veces: sin 500 y el estado coincide con la última respuesta exitosa", async () => {
    const F = await c.estudioCon(3);
    const a = await c.sembrar(F.tenantId, { razonSocial: "Parpadeo" });
    for (let ronda = 0; ronda < 15; ronda++) {
      const rs = await Promise.all([archivar(F.titular, a.id), reactivar(F.titular, a.id), archivar(F.titular, a.id), reactivar(F.titular, a.id)]);
      sin500(rs);
      for (const r of rs) expect([200, 409], r.text).toContain(r.status);
      const fila = await c.fila(a.id);
      expect(await c.activos(F.tenantId)).toBe(fila.archivado_at === null ? 1 : 0);
    }
  }, 60_000);

  it("la suma de activos nunca excede el límite aunque se mezclen altas, reactivaciones y archivados (varias rondas)", async () => {
    const F = await c.estudioCon(6);
    const arch = [] as string[];
    for (let i = 0; i < 4; i++) arch.push((await c.sembrar(F.tenantId, { archivado: true })).id);
    for (let i = 0; i < 2; i++) await c.sembrar(F.tenantId);
    for (let ronda = 0; ronda < 5; ronda++) {
      const rs = await Promise.all([
        ...arch.map((id) => reactivar(F.titular, id)),
        c.crear(F.titular, { ruc: rucValido() }),
        c.crear(F.titular, { ruc: rucValido() }),
      ]);
      sin500(rs);
      if (ronda === 0) {
        // 6 competidores (4 reactivaciones + 2 altas) por 4 cupos libres: se llenan los cupos, sin excederse.
        expect(rs.filter((r) => r.status === 200 || r.status === 201)).toHaveLength(4);
        expect(rs.filter((r) => r.status === 409).every((r) => codigo(r) === "cupo_rucs")).toBe(true);
        expect(await c.activos(F.tenantId)).toBe(6);
      }
      expect(await c.activos(F.tenantId)).toBeLessThanOrEqual(6);
      expect((await c.uso(F.titular)).body.rucs.usados).toBeLessThanOrEqual(6);
      // Se vuelve a archivar todo lo activo para que la ronda siguiente compita otra vez.
      const activos = await c.p.sql<{ id: string }>("select id from cliente where tenant_id = $1 and archivado_at is null", [F.tenantId]);
      await Promise.all(activos.slice(2).map((f) => archivar(F.titular, f.id)));
    }
  }, 60_000);
});
