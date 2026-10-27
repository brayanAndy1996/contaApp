// Spec 005 · T17: pruebas propias de las correcciones de la ronda adversarial 2 en la BD (migración 0016 y
// `bloquearMiembros`). H-005-2a-2 = H-005-2b-2: `invitacion_aceptar_nueva` rechaza nombres con control (\p{Cc}) o
// formato (\p{Cf}) y sin letra ni dígito decimal, igual que el backend. H-005-2a-1/H-005-2b-1: orden global de
// bloqueo (una sentencia por usuario_id), con RLS.
import { bloquearMiembros } from "@contapp/db";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EscenarioAcceso } from "./acceso-soporte";
import { abrirAdmin, abrirApp, crearDb, hashFalso, llamar } from "./auth-soporte";
import type { ContappDb } from "./soporte";

let app: Pool;
let admin: Pool;
let ea: EscenarioAcceso;
let db: ContappDb;

beforeAll(() => {
  app = abrirApp(4);
  admin = abrirAdmin(4);
  ea = new EscenarioAcceso(admin);
  db = crearDb("contapp_backend", 2);
});
afterAll(async () => {
  await ea?.limpiar();
  await db?.close();
  await app?.end();
  await admin?.end();
});

const aceptar = async (tokenHash: Buffer, nombre: string): Promise<string> => {
  const r = await llamar(app, "select auth.invitacion_aceptar_nueva($1, $2, $3) as r", [tokenHash, nombre, hashFalso()]);
  return r.ok ? r.rows[0].r : `error ${r.code}`;
};

/** Todos los puntos de código de una categoría según el motor de Node (el mismo que valida en el backend). */
const categoria = (re: RegExp): number[] => {
  const r: number[] = [];
  for (let c = 1; c <= 0x10ffff; c++) if (c < 0xd800 || c > 0xdfff) if (re.test(String.fromCodePoint(c))) r.push(c);
  return r;
};

describe("H-005-2a-2 · nombre en invitacion_aceptar_nueva (0016)", () => {
  it("cada carácter de control o de formato de Node, dentro de un nombre válido -> 'invalida' sin consumir el token", async () => {
    const x = await ea.estudio();
    const d = await ea.miembro(x.id, "dueno");
    const inv = await ea.invitacion(x.id, { invitadoPor: d.id, rol: "lectura" });
    const aceptados: string[] = [];
    for (const c of [...categoria(/\p{Cc}/u), ...categoria(/\p{Cf}/u)]) {
      if ((await aceptar(inv.tokenHash, `Ana${String.fromCodePoint(c)}T17`)) !== "invalida") aceptados.push(c.toString(16));
    }
    expect(aceptados).toEqual([]);
    // El token estuvo vivo todo el tiempo: cada 'invalida' fue por el nombre.
    expect(await aceptar(inv.tokenHash, "Ana T17")).toBe("aceptada");
  }, 60_000);

  it("sin letra ni dígito -> 'invalida'; letras o dígitos de cualquier escritura -> 'aceptada'", async () => {
    const x = await ea.estudio();
    const d = await ea.miembro(x.id, "dueno");
    const casos: Record<string, string> = {
      signos: "-- . --",
      ideografico: "　　",
      combinante: "́",
      cjk: "李明",
      devanagari: "कि",
      digitoArabe: "٣",
      acentos: "José Ñúñez",
    };
    const vistos: Record<string, string> = {};
    for (const [k, nombre] of Object.entries(casos)) {
      const inv = await ea.invitacion(x.id, { invitadoPor: d.id, rol: "lectura" });
      vistos[k] = await aceptar(inv.tokenHash, nombre);
    }
    expect(vistos).toEqual({
      signos: "invalida",
      ideografico: "invalida",
      combinante: "invalida",
      cjk: "aceptada",
      devanagari: "aceptada",
      digitoArabe: "aceptada",
      acentos: "aceptada",
    });
  });

  it("dueño, search_path y ACL de la función siguen como en 0015", async () => {
    const r = await admin.query(
      `select p.proowner::regrole::text as dueno, p.proconfig, p.prosecdef,
              has_function_privilege('contapp_backend', p.oid, 'execute') as backend,
              has_function_privilege('contapp_worker', p.oid, 'execute') as worker,
              has_function_privilege('contapp_app', p.oid, 'execute') as app
         from pg_proc p where p.oid = 'auth.invitacion_aceptar_nueva(bytea, text, text)'::regprocedure`,
    );
    expect(r.rows[0]).toEqual({
      dueno: "contapp_auth",
      proconfig: ["search_path=pg_catalog, pg_temp"],
      prosecdef: true,
      backend: true,
      worker: false,
      app: false,
    });
  });
});

describe("bloquearMiembros (orden global de bloqueo)", () => {
  it("bloquea por ID normalizado (minúsculas, sin repetir), incluye desactivados y no ve otro estudio", async () => {
    const x = await ea.estudio();
    const y = await ea.estudio();
    const a = await ea.miembro(x.id, "admin");
    const b = await ea.miembro(x.id, "lectura");
    const ajeno = await ea.miembro(y.id, "dueno");
    await admin.query("update membresia set desactivada_en = now() where tenant_id = $1 and usuario_id = $2", [x.id, b.id]);
    const m = await db.withTenant({ tenantId: x.id }, (tx) =>
      bloquearMiembros(tx, [b.id.toUpperCase(), a.id, b.id, ajeno.id]),
    );
    expect(Object.fromEntries([...m].map(([k, v]) => [k, `${v.rol}/${v.activo}`]))).toEqual({
      [a.id]: "admin/true",
      [b.id]: "lectura/false",
    });
  });

  it("error: con un ID ajeno solamente devuelve un Map vacío (RLS)", async () => {
    const y = await ea.estudio();
    const x = await ea.estudio();
    const ajeno = await ea.miembro(y.id, "dueno");
    const m = await db.withTenant({ tenantId: x.id }, (tx) => bloquearMiembros(tx, [ajeno.id]));
    expect(m.size).toBe(0);
  });
});
