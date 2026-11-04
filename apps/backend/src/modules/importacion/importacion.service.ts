import { HttpException, Inject, Injectable } from "@nestjs/common";
import { cifrarCredencial } from "@contapp/crypto";
import {
  asignar,
  bloquearMiembros,
  crearCliente,
  guardarSobre,
  listarMiembros,
  rucsExistentes,
  type ContappDb,
  type MiembroEstado,
  type MiembroListado,
  type Tx,
} from "@contapp/db";
import {
  tienePermiso,
  validarRuc,
  type InformeImportacion,
  type MotivoFilaImportacion,
  type Rol,
  type VistaPrevia as VistaPreviaDto,
} from "@contapp/shared";
import { randomUUID } from "node:crypto";
import { AccesoError } from "../acceso/errores.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { encolarConsultasRuc } from "../clientes/consulta-ruc.js";
import { contextoDe } from "../clientes/contexto.js";
import { KEY_WRAPPER, type ObtenerKeyWrapper } from "../credenciales/key-wrapper.js";
import { CUPO_RUCS, type CupoRucs } from "../planes/cupo/cupo-rucs.js";
import { Encolador } from "../trabajos/encolador.js";
import { leerCsv } from "./lector-csv.js";
import { leerXlsx } from "./lector-xlsx.js";
import { ErrorArchivo, LIMITES, type ArchivoLeido, type FilaLeida } from "./tipos.js";
import {
  aVistaPrevia,
  rucVisible,
  validarFilas,
  type ContextoValidacion,
  type FilaValidada,
  type Motivo,
} from "./validar-filas.js";

/** Largo máximo de la razón social (CHECK de la BD). */
const RAZON_SOCIAL_MAX = 200;
const CONTROL = /[\u0000-\u001f\u007f]/g;

interface Sobre {
  tipo: "sol" | "sire_api";
  sobre: Awaited<ReturnType<typeof cifrarCredencial>>;
}
interface Preparada {
  id: string;
  sobres: Sobre[];
}
type MiembrosPorCorreo = ContextoValidacion["miembros"];

/** Error del archivo -> `{codigo}` con 400 (413 si es demasiado grande); nunca con el contenido de una celda. */
function errorHttp(e: ErrorArchivo): HttpException {
  return new HttpException(
    { codigo: e.codigo },
    e.codigo === "archivo_demasiado_grande" ? 413 : 400,
  );
}

/** Razón social apta para la BD: sin controles, recortada y de a lo más 200 caracteres. */
function razonSocialDe(texto: string): string | undefined {
  const limpia = Array.from(texto.replace(CONTROL, " ").trim())
    .slice(0, RAZON_SOCIAL_MAX)
    .join("")
    .trim();
  return limpia === "" ? undefined : limpia;
}

const traeClaves = (f: FilaLeida): boolean =>
  f.usuarioSol !== "" || f.claveSol !== "" || f.clientId !== "" || f.clientSecret !== "";

/**
 * El actor, releído en la transacción (o en la lectura de la vista previa), sigue activo y puede crear clientes; si el
 * archivo trae claves, además puede editar credenciales (D3).
 */
function exigirActor(actor: Pick<MiembroEstado, "rol" | "activo"> | null, conClaves: boolean): void {
  if (actor === null || !actor.activo) throw new AccesoError("estudio_requerido");
  const rol = actor.rol as Rol;
  if (!tienePermiso(rol, "clientes.crear")) throw new AccesoError("permiso_denegado");
  if (conClaves && !tienePermiso(rol, "credenciales.editar")) throw new AccesoError("permiso_denegado");
}

/** `motivos` del lector son objetos; HTTP lleva `string[]` y `archivado` en la fila (plan 007b: Contratos). */
function aDto(v: ReturnType<typeof aVistaPrevia>): VistaPreviaDto {
  return {
    ...v,
    filas: v.filas.map((f) => {
      const archivado = f.motivos.some((m) => m.archivado === true);
      return {
        n: f.n,
        ruc: f.ruc,
        estado: f.estado,
        motivos: f.motivos.map((m) => m.codigo),
        tieneSol: f.tieneSol,
        tieneSire: f.tieneSire,
        ...(archivado ? { archivado: true } : {}),
      };
    }),
  };
}

function noImportada(f: { n: number; ruc: string }, motivo: Motivo | { codigo: MotivoFilaImportacion; archivado?: boolean }) {
  return {
    n: f.n,
    ruc: rucVisible(f.ruc),
    motivo: motivo.codigo,
    ...(motivo.archivado === true ? { archivado: true } : {}),
  };
}

/**
 * Importación de clientes desde `.xlsx`/`.csv` (RF-030 parcial; spec 007b, D7 a D9). El archivo llega crudo, vive solo en
 * memoria y nunca se registra. Orden de bloqueo de 005 (plan: Decisiones): `bloquearMiembros` -> `CupoRucs.libres` (toma
 * el bloqueo del cupo) -> `reservar(n)` -> `cliente` -> `credencial` -> `asignacion`. Las claves se cifran ANTES de la
 * transacción (no se llama al proveedor de llaves con el bloqueo tomado) con el id final del cliente en la AAD; las
 * consultas de RUC se encolan DESPUÉS del commit.
 */
@Injectable()
export class ImportacionService {
  constructor(
    @Inject(DB) private readonly db: Pick<ContappDb, "withTenant">,
    @Inject(CUPO_RUCS) private readonly cupo: CupoRucs,
    @Inject(KEY_WRAPPER) private readonly obtenerWrapper: ObtenerKeyWrapper,
    @Inject(Encolador) private readonly encolador: Pick<Encolador, "encolarLote">,
  ) {}

  /** No escribe nada: valida el archivo contra el estudio y devuelve lo que `confirmar` haría. */
  async vistaPrevia(sesion: SesionResuelta, cuerpo: unknown): Promise<VistaPreviaDto> {
    const ctx = contextoDe(sesion);
    const { filas } = this.leer(cuerpo);
    const conClaves = filas.some(traeClaves);
    const { validadas, cupoLibre } = await this.db.withTenant(ctx, async (tx) => {
      const lectura = await this.leerEstudio(tx, filas);
      const actor = lectura.miembros.get(sesion.usuarioId.toLowerCase()) ?? null;
      exigirActor(actor, conClaves);
      return {
        validadas: validarFilas(filas, lectura.contexto),
        cupoLibre: await this.cupo.libres(tx, ctx.tenantId),
      };
    });
    return aDto(aVistaPrevia(validadas, cupoLibre));
  }

  async confirmar(sesion: SesionResuelta, cuerpo: unknown): Promise<InformeImportacion> {
    const ctx = contextoDe(sesion);
    const { filas } = this.leer(cuerpo);
    const conClaves = filas.some(traeClaves);

    // 1. Lectura sin bloqueos: veredicto provisional y quiénes son los responsables.
    const lectura = await this.db.withTenant(ctx, async (tx) => {
      const l = await this.leerEstudio(tx, filas);
      exigirActor(l.miembros.get(sesion.usuarioId.toLowerCase()) ?? null, conClaves);
      return l;
    });
    const provisional = validarFilas(filas, lectura.contexto);
    const candidatas = provisional.filter((f) => f.estado === "valida");

    // 2. Preparación pesada fuera de la transacción: id final del cliente y cifrado de las claves.
    const preparadas = new Map<number, Preparada>();
    for (const c of candidatas) {
      preparadas.set(c.n, await this.preparar(ctx.tenantId, c.fila));
    }

    // 3. Transacción: solo SQL.
    const { creados, noImportadas } = await this.db.withTenant(ctx, async (tx) => {
      const ids = [sesion.usuarioId, ...candidatas.flatMap((c) => (c.responsableId === null ? [] : [c.responsableId]))];
      const bloqueados = await bloquearMiembros(tx, ids);
      exigirActor(bloqueados.get(sesion.usuarioId.toLowerCase()) ?? null, conClaves);
      const libres = await this.cupo.libres(tx, ctx.tenantId);

      // Revalidación con lo que hay ahora y con los responsables bloqueados (rol y estado actuales).
      const existentes = await rucsExistentes(
        tx,
        candidatas.map((c) => c.ruc),
      );
      const miembros = new Map<string, { usuarioId: string; rol: Rol }>();
      for (const [correo, m] of lectura.contexto.miembros) {
        const b = bloqueados.get(m.usuarioId.toLowerCase());
        if (b?.activo === true) miembros.set(correo, { usuarioId: m.usuarioId, rol: b.rol as Rol });
      }
      const revalidadas = validarFilas(
        candidatas.map((c) => c.fila),
        { existentes: new Map(existentes.map((e) => [e.ruc, { archivado: e.archivado }])), miembros },
      );

      const aCrear = revalidadas.filter((f) => f.estado === "valida");
      const n = Math.min(aCrear.length, libres);
      await this.cupo.reservar(tx, ctx.tenantId, n);

      const creados: string[] = [];
      for (const f of aCrear.slice(0, n)) {
        const prep = preparadas.get(f.n) as Preparada;
        const razonSocial = razonSocialDe(f.fila.razonSocial);
        await crearCliente(tx, ctx.tenantId, {
          id: prep.id,
          ruc: f.ruc,
          ...(razonSocial === undefined ? {} : { razonSocial }),
        });
        for (const s of prep.sobres) await guardarSobre(tx, { clienteId: prep.id, tipo: s.tipo, sobre: s.sobre });
        if (f.responsableId !== null) {
          await asignar(tx, { clienteId: prep.id, usuarioId: f.responsableId, tipo: "responsable" });
        }
        creados.push(prep.id);
      }

      const noImportadas = [
        ...provisional.filter((f) => f.estado === "error").map((f) => noImportada(f, f.motivos[0] as Motivo)),
        ...revalidadas.filter((f) => f.estado === "error").map((f) => noImportada(f, f.motivos[0] as Motivo)),
        ...aCrear.slice(n).map((f) => noImportada(f, { codigo: "cupo_rucs" })),
      ].sort((a, b) => a.n - b.n);
      return { creados, noImportadas };
    });

    // 4. Tras el commit y sin propagar su fallo: las consultas de RUC (reserva del 50 % de la cola).
    const lote = await encolarConsultasRuc(this.encolador, ctx, creados);
    return {
      creadas: creados.length,
      noImportadas,
      consultasEncoladas: lote.encoladas,
      consultasOmitidas: lote.omitidas,
    };
  }

  /** Formato por contenido: la firma `PK` es un `.xlsx` (zip); lo demás se lee como `.csv`. Todo en memoria. */
  private leer(cuerpo: unknown): ArchivoLeido {
    const bytes = Buffer.isBuffer(cuerpo) ? cuerpo : Buffer.alloc(0);
    try {
      if (bytes.length > LIMITES.maxBytes) throw new ErrorArchivo("archivo_demasiado_grande");
      const zip = bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
      return zip ? leerXlsx(bytes) : leerCsv(bytes);
    } catch (e) {
      // Un archivo que el lector no entiende es un 400, nunca un 500 ni un mensaje con su contenido.
      throw errorHttp(e instanceof ErrorArchivo ? e : new ErrorArchivo("archivo_invalido"));
    }
  }

  /** Miembros y RUC existentes que el veredicto necesita; solo se consultan RUC con forma válida. */
  private async leerEstudio(
    tx: Tx,
    filas: readonly FilaLeida[],
  ): Promise<{ miembros: Map<string, MiembroListado>; contexto: ContextoValidacion }> {
    const todos = await listarMiembros(tx);
    const rucs = [...new Set(filas.map((f) => f.ruc).filter((r) => validarRuc(r)))];
    const existentes = await rucsExistentes(tx, rucs);
    const activos: MiembrosPorCorreo = new Map(
      todos.filter((m) => m.activo).map((m) => [m.correo.toLowerCase(), { usuarioId: m.usuarioId, rol: m.rol as Rol }]),
    );
    return {
      miembros: new Map(todos.map((m) => [m.usuarioId.toLowerCase(), m])),
      contexto: {
        existentes: new Map(existentes.map((e) => [e.ruc, { archivado: e.archivado }])),
        miembros: activos,
      },
    };
  }

  private async preparar(tenantId: string, fila: FilaValidada["fila"]): Promise<Preparada> {
    const id = randomUUID();
    const sobres: Sobre[] = [];
    if (fila.usuarioSol !== "" && fila.claveSol !== "") {
      sobres.push({
        tipo: "sol",
        sobre: await this.cifrar({ tenantId, clienteId: id, tipo: "sol" }, { usuario: fila.usuarioSol, clave: fila.claveSol }),
      });
    }
    if (fila.clientId !== "" && fila.clientSecret !== "") {
      sobres.push({
        tipo: "sire_api",
        sobre: await this.cifrar(
          { tenantId, clienteId: id, tipo: "sire_api" },
          { clientId: fila.clientId, clientSecret: fila.clientSecret },
        ),
      });
    }
    return { id, sobres };
  }

  private async cifrar(
    aad: { tenantId: string; clienteId: string; tipo: "sol" | "sire_api" },
    valor: { usuario: string; clave: string } | { clientId: string; clientSecret: string },
  ): Promise<Sobre["sobre"]> {
    try {
      return await cifrarCredencial(this.obtenerWrapper(), aad, valor);
    } catch {
      // Sin `cause` ni mensaje: el error de cifrado podría arrastrar parte del secreto.
      throw new HttpException({ codigo: "error_interno" }, 500);
    }
  }
}
