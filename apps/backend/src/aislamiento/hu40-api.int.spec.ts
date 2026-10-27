/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// T5 (005) · CA-12 / HU-40 por API: dos estudios (A y B), cada uno con un Dueño y un asistente.
// Un usuario de A llama a TODAS las rutas registradas de 004 y 005 con IDs de B (cliente, usuario,
// membresía, invitación, asignación) en URL, cuerpo y lotes mezclados con IDs propios: siempre 404/403
// o listas sin datos de B, y la BD de B queda intacta. Simétrica (B contra A). La lista de rutas sale de
// las rutas registradas en Express: una ruta nueva sin caso hace fallar la prueba "toda ruta tiene caso".
// Rojo: las rutas, tablas y roles de 005 aún no existen (T7 a T11).
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  abrirHarness,
  COOKIE,
  cookieSesion,
  nombreTenant,
  PWD,
  seedAuth,
  type Harness,
  type Peticion,
  type Resp,
} from "../../test/soporte.js";

/* ---------------------------------- Tipos ---------------------------------- */
interface Actor {
  rol: "dueno" | "asistente";
  id: string;
  correo: string;
  contrasena: string;
  nombre: string;
  membresiaId: string;
}
interface Recursos {
  tenantId: string;
  nombre: string;
  dueno: Actor;
  asistente: Actor;
  /** Clientes creados por la prueba (la asistente es responsable del primero). */
  clientes: [string, string];
  /** Marcadores de datos propios de este estudio que no deben verse desde el otro. */
  ids: string[];
  correos: string[];
  otros: string[];
  asignacionId: string;
  invitacionId: string;
  invitacionCorreo: string;
  tokenHash: Buffer;
}
interface Sesion {
  cookie: string;
  csrf: string;
}
interface Pet {
  metodo?: Peticion["metodo"];
  ruta: string;
  cuerpo?: unknown;
}
interface Esperado {
  dueno: number[];
  asistente: number[];
}
interface Contexto {
  yo: Actor;
  mio: Recursos;
  ajeno: Recursos;
  pedir(p: Pet, o?: { estudio?: string | null }): Promise<Resp>;
}
interface Caso {
  /** `METODO /ruta/:param`, igual que la ruta registrada en Express. */
  ruta: string;
  esperado: Esperado;
  /** Sin sesión, cookie ni `X-Estudio` (rutas `@Publico`). */
  publica?: boolean;
  /** La respuesta repite lo que el atacante envió (correo): no cuenta como fuga. */
  eco?: boolean;
  construir(c: Contexto): Pet[];
  /** Comprobaciones propias del caso, tras las peticiones. */
  extra?(c: Contexto, respuestas: Resp[]): Promise<void>;
  /** Limpieza propia del caso (se ejecuta siempre). */
  despues?(c: Contexto): Promise<void>;
}

/* --------------------------------- Estado ---------------------------------- */
let h: Harness;
let A: Recursos;
let B: Recursos;
let registradas: string[] = [];
const sufijo = randomBytes(4).toString("hex");

const todos = (...n: number[]): Esperado => ({ dueno: n, asistente: n });
const E404: Esperado = { dueno: [404], asistente: [403, 404] };
const ELISTA: Esperado = { dueno: [200], asistente: [200, 403] };

/* ----------------------------- Rutas registradas ---------------------------- */
function enumerarRutas(): string[] {
  const instancia: any = h.app.getHttpAdapter().getInstance();
  const pila: any[] = instancia.router?.stack ?? instancia._router?.stack ?? [];
  const salida = new Set<string>();
  for (const capa of pila) {
    const ruta = capa.route;
    if (!ruta) continue;
    for (const [metodo, activo] of Object.entries<boolean>(
      ruta.methods ?? {},
    )) {
      if (activo && !["head", "options", "_all"].includes(metodo)) {
        salida.add(`${metodo.toUpperCase()} ${String(ruta.path)}`);
      }
    }
  }
  return [...salida].sort();
}

/* ------------------------------- Preparación -------------------------------- */
const hex = () => randomBytes(5).toString("hex");

async function prepararEstudio(
  tenantId: string,
  etiqueta: "A" | "B",
): Promise<Recursos> {
  const nombre = nombreTenant(tenantId);
  const crear = async (rol: Actor["rol"]): Promise<Actor> => {
    const u = await h.crearUsuario({ estudios: [] });
    const nom = `HU40 ${etiqueta} ${rol} ${sufijo}`;
    await h.sql("update usuario set nombre = $2 where id = $1", [u.id, nom]);
    const m = await h.sql(
      "insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, $3) returning id",
      [tenantId, u.id, rol],
    );
    return {
      rol,
      id: u.id,
      correo: u.correo,
      contrasena: u.contrasena,
      nombre: nom,
      membresiaId: m[0].id,
    };
  };
  const dueno = await crear("dueno");
  const asistente = await crear("asistente");

  const clientes: string[] = [];
  for (const n of [1, 2]) {
    const razon = `HU40 ${etiqueta} cliente ${n} ${sufijo}`;
    const ruc = `2${String(Math.floor(Math.random() * 1e10)).padStart(10, "0")}`;
    const f = await h.sql(
      "insert into cliente (tenant_id, ruc, razon_social) values ($1, $2, $3) returning id",
      [tenantId, ruc, razon],
    );
    clientes.push(f[0].id);
  }
  const asig = await h.sql(
    "insert into asignacion (tenant_id, cliente_id, usuario_id, tipo) values ($1, $2, $3, 'responsable') returning id",
    [tenantId, clientes[0], asistente.id],
  );
  const tokenHash = createHash("sha256").update(randomBytes(32)).digest();
  const invitacionCorreo = `inv${hex()}@hu40-${etiqueta.toLowerCase()}.contapp.test`;
  const inv = await h.sql(
    `insert into invitacion (tenant_id, correo, rol, invitado_por, token_hash, vence_en)
     values ($1, $2, 'lectura', $3, $4, now() + interval '72 hours') returning id`,
    [tenantId, invitacionCorreo, dueno.id, tokenHash],
  );
  return {
    tenantId,
    nombre,
    dueno,
    asistente,
    clientes: [clientes[0]!, clientes[1]!],
    ids: [],
    correos: [],
    otros: [],
    asignacionId: asig[0].id,
    invitacionId: inv[0].id,
    invitacionCorreo,
    tokenHash,
  };
}

/** Marcadores: todo lo que existe en `de` y no en `contra` (los usuarios de ambos, como uAB, no cuentan). */
async function calcularMarcadores(
  de: Recursos,
  contra: Recursos,
): Promise<void> {
  const clientesDe = await h.sql(
    "select id, ruc, razon_social from cliente where tenant_id = $1",
    [de.tenantId],
  );
  const rucsContra = new Set(
    (
      await h.sql("select ruc from cliente where tenant_id = $1", [
        contra.tenantId,
      ])
    ).map((f) => f.ruc),
  );
  const usuariosDe = await h.sql(
    `select u.id, u.email, u.nombre from usuario u join membresia m on m.usuario_id = u.id
      where m.tenant_id = $1
        and not exists (select 1 from membresia x where x.usuario_id = u.id and x.tenant_id = $2)`,
    [de.tenantId, contra.tenantId],
  );
  const invitaciones = await h.sql(
    "select id, correo from invitacion where tenant_id = $1",
    [de.tenantId],
  );
  const ids = new Set<string>([
    de.tenantId,
    de.dueno.membresiaId,
    de.asistente.membresiaId,
    de.asignacionId,
  ]);
  const correos = new Set<string>([de.invitacionCorreo]);
  const otros = new Set<string>([de.nombre]);
  for (const f of clientesDe) {
    ids.add(f.id);
    otros.add(f.razon_social);
    if (!rucsContra.has(f.ruc)) otros.add(f.ruc);
  }
  for (const f of usuariosDe) {
    ids.add(f.id);
    correos.add(f.email);
    // Solo los nombres propios de la prueba: los del seed ("Usuario A") son subcadena de otros ("Usuario AB").
    if (String(f.nombre).startsWith("HU40")) otros.add(f.nombre);
  }
  for (const f of invitaciones) {
    ids.add(f.id);
    correos.add(f.correo);
  }
  de.ids = [...ids];
  de.correos = [...correos];
  de.otros = [...otros].filter((x) => typeof x === "string" && x.length >= 4);
}

/* -------------------------------- Instantáneas ------------------------------ */
/** Estado de la BD de un estudio, limitado a lo que creó esta prueba (robusto ante otras suites). */
async function instantanea(
  r: Recursos,
  completo: boolean,
): Promise<Record<string, unknown>> {
  const uids = [r.dueno.id, r.asistente.id];
  const q = async (texto: string, valores: unknown[]) =>
    (await h.sql(texto, valores)).map((f) => f.j);
  const s: Record<string, unknown> = {
    membresia: await q(
      "select to_jsonb(m) j from membresia m where tenant_id = $1 and usuario_id = any($2::uuid[]) order by id",
      [r.tenantId, uids],
    ),
    cliente: await q(
      "select to_jsonb(c) j from cliente c where tenant_id = $1 and id = any($2::uuid[]) order by id",
      [r.tenantId, r.clientes],
    ),
    asignacion: await q(
      `select to_jsonb(a) j from asignacion a
        where tenant_id = $1 and (cliente_id = any($2::uuid[]) or usuario_id = any($3::uuid[])) order by id`,
      [r.tenantId, r.clientes, uids],
    ),
  };
  if (completo) {
    s.usuario = await q(
      "select to_jsonb(u) j from usuario u where id = any($1::uuid[]) order by id",
      [uids],
    );
    s.invitacion = await q(
      "select to_jsonb(i) j from invitacion i where tenant_id = $1 and (id = $2 or invitado_por = any($3::uuid[])) order by id",
      [r.tenantId, r.invitacionId, uids],
    );
    s.sesion = await q(
      "select to_jsonb(s) j from auth.sesion s where usuario_id = any($1::uuid[]) order by id",
      [uids],
    );
  }
  return s;
}

/* --------------------------------- Sesiones --------------------------------- */
async function abrirSesion(u: Actor, tenantId: string): Promise<Sesion> {
  await h.reiniciarIntentos(u.correo);
  const s = await h.entrar(u);
  const e = await h.pedir({
    ruta: "/auth/estudio",
    cuerpo: { tenantId },
    cookie: s.cookie,
    csrf: s.csrf,
  });
  if (e.status !== 200)
    throw new Error(`no se pudo elegir el estudio de prueba: HTTP ${e.status}`);
  const cookie = `${COOKIE}=${cookieSesion(e)!.valor}`;
  const ses = await h.pedir({ ruta: "/auth/sesion", cookie });
  if (ses.status !== 200)
    throw new Error(`GET /auth/sesion fallido: HTTP ${ses.status}`);
  return { cookie, csrf: ses.body.csrf };
}

/** Fugas de datos del otro estudio en una respuesta (ids, correos, nombres, razones sociales, RUC). */
function fugas(r: Resp, ajeno: Recursos, caso: Caso): string[] {
  const texto = `${r.text}\n${JSON.stringify(r.body)}`.toLowerCase();
  const marcas = [
    ...ajeno.ids,
    ...(caso.eco ? [] : ajeno.correos),
    ...ajeno.otros,
  ];
  return marcas.filter((m) => texto.includes(m.toLowerCase()));
}

const lista = (r: Resp): any[] => (Array.isArray(r.body) ? r.body : []);

/* ------------------------------- Casos por ruta ----------------------------- */
const base64url = (b: Buffer) => b.toString("base64url");
const idsDeUsuario = (a: Recursos) => [
  a.dueno.id,
  a.asistente.id,
  a.asistente.membresiaId,
  a.asignacionId,
];
const idsDeCliente = (a: Recursos) => [
  ...a.clientes,
  a.asignacionId,
  a.invitacionId,
];
const tokensDeB = (a: Recursos) => [
  a.tokenHash.toString("hex"),
  base64url(a.tokenHash),
  a.invitacionId,
];
const contrasenaMala = "incorrecta-HU40-aaaaaaaa";

const CASOS: Caso[] = [
  /* ---------- 004 ---------- */
  {
    ruta: "POST /auth/login",
    publica: true,
    esperado: todos(401),
    construir: (c) => [
      {
        ruta: "/auth/login",
        cuerpo: { correo: c.ajeno.dueno.correo, contrasena: contrasenaMala },
      },
    ],
    despues: async (c) => h.reiniciarIntentos(c.ajeno.dueno.correo),
  },
  {
    ruta: "POST /auth/logout",
    esperado: todos(204),
    construir: () => [{ metodo: "POST", ruta: "/auth/logout" }],
  },
  {
    ruta: "GET /auth/sesion",
    esperado: todos(200),
    construir: () => [{ ruta: "/auth/sesion" }],
    extra: async (c, [r]) => {
      expect(r?.body.usuario.id).toBe(c.yo.id);
      expect(r?.body.estudioActivo?.id).toBe(c.mio.tenantId);
    },
  },
  {
    ruta: "GET /auth/estudios",
    esperado: todos(200),
    construir: () => [{ ruta: "/auth/estudios" }],
    extra: async (c, [r]) =>
      expect(lista(r!).map((e) => e.id)).toEqual([c.mio.tenantId]),
  },
  {
    ruta: "POST /auth/estudio",
    esperado: todos(403, 404),
    construir: (c) => [
      { ruta: "/auth/estudio", cuerpo: { tenantId: c.ajeno.tenantId } },
    ],
    extra: async (c) => {
      // La sesión sigue en el estudio propio: el intento no la movió.
      const r = await c.pedir({ ruta: "/estudio/actual" });
      expect(r.status).toBe(200);
      expect(r.body.id).toBe(c.mio.tenantId);
    },
  },
  {
    ruta: "POST /auth/sesiones/cerrar-todas",
    esperado: todos(204),
    construir: () => [{ metodo: "POST", ruta: "/auth/sesiones/cerrar-todas" }],
  },
  {
    ruta: "POST /auth/recuperar",
    publica: true,
    esperado: todos(202),
    construir: (c) => [
      { ruta: "/auth/recuperar", cuerpo: { correo: c.ajeno.dueno.correo } },
    ],
    extra: async (c, [r]) => {
      // Misma respuesta que para un correo inexistente: no revela quién es miembro de otro estudio.
      const inexistente = await c.pedir({
        ruta: "/auth/recuperar",
        cuerpo: { correo: h.correoInexistente() },
      });
      expect({ status: r!.status, body: r!.body }).toEqual({
        status: inexistente.status,
        body: inexistente.body,
      });
    },
  },
  {
    ruta: "POST /auth/recuperar/restablecer",
    publica: true,
    esperado: todos(400),
    construir: (c) => [
      {
        ruta: "/auth/recuperar/restablecer",
        cuerpo: { token: base64url(randomBytes(32)), contrasena: PWD },
      },
      {
        ruta: "/auth/recuperar/restablecer",
        cuerpo: { token: c.ajeno.tokenHash.toString("hex"), contrasena: PWD },
      },
    ],
  },
  {
    ruta: "POST /auth/contrasena",
    esperado: todos(400, 401, 403),
    construir: (c) => [
      {
        ruta: "/auth/contrasena",
        cuerpo: {
          actual: contrasenaMala,
          nueva: "Otra-Contrasena-HU40-ñ-1",
          usuarioId: c.ajeno.dueno.id,
        },
      },
    ],
    despues: async (c) => h.reiniciarIntentos(c.yo.correo),
  },
  {
    ruta: "GET /estudio/actual",
    esperado: todos(200),
    construir: () => [{ ruta: "/estudio/actual" }],
    extra: async (c, [r]) => expect(r?.body.id).toBe(c.mio.tenantId),
  },

  /* ---------- 005 ---------- */
  {
    ruta: "GET /acceso/yo",
    esperado: todos(200),
    construir: () => [{ ruta: "/acceso/yo" }],
    extra: async (c, [r]) => expect(r?.body.rol).toBe(c.yo.rol),
  },
  {
    ruta: "GET /usuarios",
    esperado: ELISTA,
    construir: (c) => [
      { ruta: "/usuarios" },
      {
        ruta: `/usuarios?tenantId=${c.ajeno.tenantId}&estudio=${c.ajeno.tenantId}`,
      },
    ],
  },
  {
    ruta: "PATCH /usuarios/:usuarioId/rol",
    esperado: E404,
    construir: (c) =>
      idsDeUsuario(c.ajeno).map((id) => ({
        metodo: "PATCH" as const,
        ruta: `/usuarios/${id}/rol`,
        cuerpo: { rol: "lectura", tenantId: c.ajeno.tenantId },
      })),
  },
  {
    ruta: "POST /usuarios/:usuarioId/desactivar",
    esperado: E404,
    construir: (c) =>
      idsDeUsuario(c.ajeno).map((id) => ({
        metodo: "POST" as const,
        ruta: `/usuarios/${id}/desactivar`,
      })),
  },
  {
    ruta: "POST /usuarios/:usuarioId/reactivar",
    esperado: E404,
    construir: (c) =>
      idsDeUsuario(c.ajeno).map((id) => ({
        metodo: "POST" as const,
        ruta: `/usuarios/${id}/reactivar`,
      })),
  },
  {
    ruta: "GET /invitaciones",
    esperado: ELISTA,
    construir: (c) => [
      { ruta: "/invitaciones" },
      { ruta: `/invitaciones?tenantId=${c.ajeno.tenantId}` },
    ],
  },
  {
    // Invitar a un correo que está en B (miembro o con invitación pendiente en B) responde igual que a
    // cualquier otro: sin 409 que delate a B. El correo enviado se repite en la respuesta (eco).
    ruta: "POST /invitaciones",
    esperado: { dueno: [201], asistente: [403] },
    eco: true,
    construir: (c) => [
      {
        ruta: "/invitaciones",
        cuerpo: {
          correo: c.ajeno.dueno.correo,
          rol: "lectura",
          tenantId: c.ajeno.tenantId,
          invitadoPor: c.ajeno.dueno.id,
        },
      },
      {
        ruta: "/invitaciones",
        cuerpo: {
          correo: c.ajeno.invitacionCorreo,
          rol: "lectura",
          tenantId: c.ajeno.tenantId,
        },
      },
    ],
    despues: async (c) => {
      // Borra lo que la propia prueba creó en el estudio atacante (invitaciones por correo del otro).
      await h.sql(
        "delete from invitacion where tenant_id = $1 and invitado_por = $2 and id <> $3",
        [c.mio.tenantId, c.mio.dueno.id, c.mio.invitacionId],
      );
    },
  },
  {
    ruta: "POST /invitaciones/:invitacionId/reenviar",
    esperado: E404,
    construir: (c) =>
      [
        c.ajeno.invitacionId,
        c.ajeno.asistente.membresiaId,
        c.ajeno.asignacionId,
      ].map((id) => ({
        metodo: "POST" as const,
        ruta: `/invitaciones/${id}/reenviar`,
      })),
  },
  {
    ruta: "POST /invitaciones/:invitacionId/revocar",
    esperado: E404,
    construir: (c) =>
      [
        c.ajeno.invitacionId,
        c.ajeno.asistente.membresiaId,
        c.ajeno.asignacionId,
      ].map((id) => ({
        metodo: "POST" as const,
        ruta: `/invitaciones/${id}/revocar`,
      })),
  },
  {
    ruta: "POST /invitaciones/consultar",
    publica: true,
    esperado: todos(400),
    construir: (c) =>
      tokensDeB(c.ajeno).map((token) => ({
        ruta: "/invitaciones/consultar",
        cuerpo: { token },
      })),
  },
  {
    ruta: "POST /invitaciones/aceptar",
    publica: true,
    esperado: todos(400),
    construir: (c) =>
      tokensDeB(c.ajeno).map((token) => ({
        ruta: "/invitaciones/aceptar",
        cuerpo: {
          token,
          nombre: "Intruso HU40",
          contrasena: PWD,
          tenantId: c.ajeno.tenantId,
          rol: "dueno",
        },
      })),
    extra: async () => {
      const f = await h.sql(
        "select count(*)::int n from usuario where nombre = 'Intruso HU40'",
      );
      expect(f[0].n).toBe(0);
    },
  },
  {
    ruta: "POST /invitaciones/aceptar-con-sesion",
    esperado: todos(400),
    construir: (c) =>
      tokensDeB(c.ajeno).map((token) => ({
        ruta: "/invitaciones/aceptar-con-sesion",
        cuerpo: { token, tenantId: c.ajeno.tenantId },
      })),
    extra: async (c) => {
      const f = await h.sql(
        "select count(*)::int n from membresia where usuario_id = $1",
        [c.yo.id],
      );
      expect(f[0].n).toBe(1); // sigue con su única membresía
    },
  },
  {
    ruta: "GET /clientes",
    esperado: todos(200),
    construir: (c) => [
      { ruta: "/clientes" },
      { ruta: `/clientes?tenantId=${c.ajeno.tenantId}` },
    ],
  },
  {
    ruta: "GET /clientes/:clienteId",
    esperado: E404,
    construir: (c) =>
      idsDeCliente(c.ajeno).map((id) => ({ ruta: `/clientes/${id}` })),
  },
  {
    ruta: "GET /clientes/:clienteId/asignaciones",
    esperado: E404,
    construir: (c) =>
      idsDeCliente(c.ajeno).map((id) => ({
        ruta: `/clientes/${id}/asignaciones`,
      })),
  },
  {
    ruta: "PUT /clientes/:clienteId/asignaciones/:usuarioId",
    esperado: E404,
    construir: (c) => {
      const cuerpo = { tipo: "colaborador", tenantId: c.ajeno.tenantId };
      const combos: [string, string][] = [
        [c.ajeno.clientes[0], c.yo.id], // cliente ajeno, usuario propio
        [c.mio.clientes[1], c.ajeno.asistente.id], // cliente propio, usuario ajeno
        [c.ajeno.clientes[0], c.ajeno.asistente.id], // todo ajeno
        [c.ajeno.clientes[1], c.ajeno.dueno.id],
        [c.mio.clientes[1], c.ajeno.asistente.membresiaId], // id de membresía en vez de usuario
        [c.mio.clientes[1], c.ajeno.asignacionId], // id de asignación en vez de usuario
      ];
      return [
        ...combos.map(([cl, us]) => ({
          metodo: "PUT" as const,
          ruta: `/clientes/${cl}/asignaciones/${us}`,
          cuerpo,
        })),
        {
          metodo: "PUT" as const,
          ruta: `/clientes/${c.mio.clientes[1]}/asignaciones/${c.ajeno.dueno.id}`,
          cuerpo: { tipo: "responsable", anterior: "retirar" },
        },
      ];
    },
  },
  {
    ruta: "DELETE /clientes/:clienteId/asignaciones/:usuarioId",
    esperado: E404,
    construir: (c) => {
      const combos: [string, string][] = [
        [c.ajeno.clientes[0], c.ajeno.asistente.id], // la asignación real de B
        [c.ajeno.clientes[0], c.yo.id],
        [c.mio.clientes[0], c.ajeno.asistente.id],
        [c.mio.clientes[0], c.ajeno.asignacionId],
        [c.ajeno.asignacionId, c.ajeno.asistente.id],
      ];
      return combos.map(([cl, us]) => ({
        metodo: "DELETE" as const,
        ruta: `/clientes/${cl}/asignaciones/${us}`,
      }));
    },
  },
  {
    ruta: "POST /asignaciones/por-usuario",
    esperado: E404,
    construir: (c) => {
      const p = (usuarioId: string, clienteIds: string[]): Pet => ({
        metodo: "POST",
        ruta: "/asignaciones/por-usuario",
        cuerpo: {
          usuarioId,
          clienteIds,
          tipo: "colaborador",
          tenantId: c.ajeno.tenantId,
        },
      });
      return [
        p(c.mio.asistente.id, [c.mio.clientes[1], c.ajeno.clientes[0]]), // lote mezclado: nada se aplica
        p(c.mio.asistente.id, [c.ajeno.clientes[0], c.ajeno.clientes[1]]),
        p(c.ajeno.asistente.id, [c.mio.clientes[0], c.mio.clientes[1]]), // usuario ajeno
        p(c.ajeno.asistente.id, [c.ajeno.clientes[0]]),
        p(c.mio.dueno.id, [c.mio.clientes[1], c.ajeno.asignacionId]), // id de asignación en el lote
        p(c.ajeno.asistente.membresiaId, [c.mio.clientes[1]]), // id de membresía como usuario
      ];
    },
  },
  {
    ruta: "POST /asignaciones/por-cliente",
    esperado: E404,
    construir: (c) => {
      const p = (clienteId: string, usuarioIds: string[]): Pet => ({
        metodo: "POST",
        ruta: "/asignaciones/por-cliente",
        cuerpo: { clienteId, usuarioIds, tenantId: c.ajeno.tenantId },
      });
      return [
        p(c.mio.clientes[1], [c.mio.dueno.id, c.ajeno.asistente.id]), // lote mezclado: nada se aplica
        p(c.ajeno.clientes[0], [c.mio.asistente.id]),
        p(c.ajeno.clientes[0], [c.ajeno.asistente.id, c.ajeno.dueno.id]),
        p(c.mio.clientes[1], [
          c.ajeno.asistente.membresiaId,
          c.ajeno.asignacionId,
        ]),
      ];
    },
  },
];

const POR_RUTA = new Map(CASOS.map((c) => [c.ruta, c]));

/* ---------------------------------- Pruebas --------------------------------- */
beforeAll(async () => {
  h = await abrirHarness();
  const s = seedAuth();
  A = await prepararEstudio(s.tenantA, "A");
  B = await prepararEstudio(s.tenantB, "B");
  await calcularMarcadores(A, B);
  await calcularMarcadores(B, A);
  registradas = enumerarRutas();
});

afterAll(async () => {
  if (!h) return;
  const usuarios = [A, B]
    .filter(Boolean)
    .flatMap((r) => [r.dueno.id, r.asistente.id]);
  const clientes = [A, B].filter(Boolean).flatMap((r) => r.clientes);
  await h
    .sql("delete from invitacion where invitado_por = any($1::uuid[])", [
      usuarios,
    ])
    .catch(() => undefined);
  await h
    .sql(
      "delete from asignacion where usuario_id = any($1::uuid[]) or cliente_id = any($2::uuid[])",
      [usuarios, clientes],
    )
    .catch(() => undefined);
  await h
    .sql("delete from cliente where id = any($1::uuid[])", [clientes])
    .catch(() => undefined);
  await h.cerrar();
});

describe("HU-40 por API · cobertura de rutas (CA-12)", () => {
  it("la enumeración de rutas registradas funciona (incluye las de 004)", () => {
    expect(registradas.length).toBeGreaterThan(0);
    expect(registradas).toContain("POST /auth/login");
    expect(registradas).toContain("GET /estudio/actual");
  });

  it("toda ruta registrada tiene un caso (una ruta nueva sin caso rompe la prueba)", () => {
    expect(registradas.filter((r) => !POR_RUTA.has(r))).toEqual([]);
  });

  it("todo caso apunta a una ruta registrada (las rutas de 005 existen)", () => {
    expect(
      CASOS.map((c) => c.ruta).filter((r) => !registradas.includes(r)),
    ).toEqual([]);
  });
});

describe("HU-40 por API · las pruebas no son vacías (controles con datos propios)", () => {
  it("el Dueño de cada estudio ve sus clientes, usuarios e invitaciones, y la asistente solo su cliente asignado", async () => {
    for (const [mio, ajeno] of [
      [A, B],
      [B, A],
    ] as const) {
      const d = await abrirSesion(mio.dueno, mio.tenantId);
      const pedir = (ruta: string) =>
        h.pedir({
          ruta,
          cookie: d.cookie,
          csrf: d.csrf,
          estudio: mio.tenantId,
        });
      const clientes = await pedir("/clientes");
      expect(clientes.status).toBe(200);
      expect(lista(clientes).map((x) => x.id)).toEqual(
        expect.arrayContaining(mio.clientes),
      );
      expect(lista(clientes).map((x) => x.id)).not.toEqual(
        expect.arrayContaining(ajeno.clientes),
      );
      expect((await pedir(`/clientes/${mio.clientes[0]}`)).status).toBe(200);
      expect(
        (await pedir(`/clientes/${mio.clientes[0]}/asignaciones`)).status,
      ).toBe(200);
      const usuarios = await pedir("/usuarios");
      expect(usuarios.status).toBe(200);
      expect(lista(usuarios).map((x) => x.usuarioId)).toEqual(
        expect.arrayContaining([mio.dueno.id, mio.asistente.id]),
      );
      const invitaciones = await pedir("/invitaciones");
      expect(invitaciones.status).toBe(200);
      expect(lista(invitaciones).map((x) => x.id)).toContain(mio.invitacionId);

      const a = await abrirSesion(mio.asistente, mio.tenantId);
      const suyos = await h.pedir({
        ruta: "/clientes",
        cookie: a.cookie,
        csrf: a.csrf,
        estudio: mio.tenantId,
      });
      expect(suyos.status).toBe(200);
      expect(lista(suyos).map((x) => x.id)).toEqual([mio.clientes[0]]);
    }
  });
});

const COMBOS = [
  {
    nombre: "Dueño de A contra B",
    rol: "dueno" as const,
    mio: () => A,
    ajeno: () => B,
  },
  {
    nombre: "asistente de A contra B",
    rol: "asistente" as const,
    mio: () => A,
    ajeno: () => B,
  },
  {
    nombre: "Dueño de B contra A",
    rol: "dueno" as const,
    mio: () => B,
    ajeno: () => A,
  },
  {
    nombre: "asistente de B contra A",
    rol: "asistente" as const,
    mio: () => B,
    ajeno: () => A,
  },
];
const ESTATUS_X_ESTUDIO_AJENO = [403, 404, 409];

for (const combo of COMBOS) {
  describe(`HU-40 por API · ${combo.nombre}`, () => {
    for (const caso of CASOS) {
      it(caso.ruta, async () => {
        // Sin esto, un 404 por ruta inexistente pasaría como "aislamiento".
        expect(
          registradas,
          `la ruta ${caso.ruta} no está registrada`,
        ).toContain(caso.ruta);

        const mio = combo.mio();
        const ajeno = combo.ajeno();
        const yo = mio[combo.rol];
        const sesion = caso.publica
          ? null
          : await abrirSesion(yo, mio.tenantId);
        const pedir: Contexto["pedir"] = (p, o = {}) => {
          const estudio = o.estudio === undefined ? mio.tenantId : o.estudio;
          return h.pedir({
            metodo: p.metodo,
            ruta: p.ruta,
            cuerpo: p.cuerpo,
            ...(sesion ? { cookie: sesion.cookie, csrf: sesion.csrf } : {}),
            ...(sesion && estudio ? { estudio } : {}),
          });
        };
        const c: Contexto = { yo, mio, ajeno, pedir };

        const ajenoAntes = await instantanea(ajeno, true);
        const propioAntes = await instantanea(mio, false);
        expect(
          ajenoAntes.cliente,
          "instantánea vacía: la prueba sería vacía",
        ).toHaveLength(2);

        try {
          const esperados = caso.esperado[combo.rol];
          const peticiones = caso.construir(c);
          const respuestas: Resp[] = [];
          for (const p of peticiones) {
            const r = await pedir(p);
            respuestas.push(r);
            const id = `${p.metodo ?? "GET"} ${p.ruta}`;
            expect(
              esperados,
              `${id} respondió ${r.status} ${JSON.stringify(r.body)}`,
            ).toContain(r.status);
            expect(
              fugas(r, ajeno, caso),
              `${id}: datos del otro estudio en la respuesta`,
            ).toEqual([]);
          }

          // Una petición con `X-Estudio` del otro estudio nunca llega al negocio (rutas con estudio).
          if (!caso.publica && !caso.ruta.includes(" /auth/")) {
            const r = await pedir(peticiones[0]!, { estudio: ajeno.tenantId });
            expect(
              ESTATUS_X_ESTUDIO_AJENO,
              `X-Estudio ajeno respondió ${r.status}`,
            ).toContain(r.status);
            expect(fugas(r, ajeno, caso)).toEqual([]);
          }

          if (caso.extra) await caso.extra(c, respuestas);

          // La BD del otro estudio queda intacta y el lote mezclado no aplicó nada en el propio.
          expect(await instantanea(ajeno, true)).toEqual(ajenoAntes);
          expect(await instantanea(mio, false)).toEqual(propioAntes);
        } finally {
          if (caso.despues) await caso.despues(c);
        }
      });
    }
  });
}
