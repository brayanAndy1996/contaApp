"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import {
  Suspense,
  useCallback,
  useEffect,
  useState,
  type FormEvent,
} from "react";
import { clienteEditarSchema, type PerfilFiscal } from "@contapp/shared";
import {
  DatosFiscales,
  DatosFiscalesLectura,
} from "../../../../components/datos-fiscales";
import { RevisarBuzon } from "../../../../components/buzon/revisar-buzon";
import { CredencialesCliente } from "../../../../components/credenciales-cliente";
import { UsoPlan } from "../../../../components/uso-plan";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardTitle,
  EncabezadoPagina,
  Input,
  Label,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  enlace,
  panelDialogo,
  velo,
} from "../../../../components/ui";
import { api } from "../../../../lib/api";
import {
  MENSAJES,
  cargarYo,
  mensajeDeError,
  tiene,
  usePuede,
  type Miembro,
} from "../../../../lib/acceso";
import {
  archivarCliente,
  editarCliente,
  reactivarCliente,
  type ClienteDto,
} from "../../../../lib/clientes";
import { MENSAJES_BUZON } from "../../../../lib/buzon";
import { MENSAJES_PRORRATA, PERMISO_PRORRATA_VER } from "../../../../lib/prorrata";
import { MENSAJES_COMPRAS } from "../../../../lib/compras";
import { MENSAJES_PLAN } from "../../../../lib/planes";
import { MENSAJES_REGLAS } from "../../../../lib/reglas";
import { MENSAJES_REGISTRO } from "../../../../lib/registro";
import { cn } from "../../../../lib/utils";

// Detalle de un cliente (spec 005, CA-5, CA-7, CA-15, D18; spec 007a, D1, D3, D5; CA-4, CA-5, CA-9).
// El 404 es el mismo para cliente inexistente, ajeno o no asignado: no se distingue en pantalla.
// Datos fiscales: editables con `clientes.editar` mientras el cliente esté activo; si no, en texto.
// Archivar y reactivar piden confirmación (`clientes.archivar`). Archivado = solo lectura (D5): sin
// formulario de asignación ni «Quitar», pero la lista de asignados sigue visible.

const MENSAJES_DETALLE = {
  clienteArchivado: "El cliente está archivado y es de solo lectura.",
  datosInvalidos: "Revisa los datos fiscales.",
  datosGuardados: "Datos guardados.",
} as const;

type Accion = "archivar" | "reactivar";

const TEXTO_ACCION: Record<Accion, { titulo: string; cuerpo: string }> = {
  archivar: {
    titulo: "¿Archivar este cliente?",
    cuerpo:
      "Libera su lugar en el cupo de RUCs. Quedará de solo lectura hasta que lo reactives; sus credenciales se conservan.",
  },
  reactivar: {
    titulo: "¿Reactivar este cliente?",
    cuerpo:
      "Volverá a ocupar un lugar en el cupo de RUCs de tu plan. Si no hay cupo libre, no se reactiva.",
  },
};

interface Asignacion {
  usuarioId: string;
  nombre: string;
  tipo: "responsable" | "colaborador";
}

type Tipo = "colaborador" | "responsable";
type Anterior = "colaborador" | "retirar";

const ETIQUETA_TIPO: Record<Asignacion["tipo"], string> = {
  responsable: "Responsable",
  colaborador: "Colaborador",
};

const codigoDe = (datos: unknown): string | undefined =>
  (datos as { codigo?: string } | null)?.codigo;

/** Formulario de datos fiscales, solo con cliente activo y `clientes.editar`. Su borrador arranca del DTO. */
function FormularioFiscal({
  cliente,
  onCambio,
}: {
  cliente: ClienteDto;
  onCambio: (cliente: ClienteDto) => void;
}) {
  const [razonSocial, setRazonSocial] = useState(cliente.razonSocial);
  const [perfil, setPerfil] = useState<PerfilFiscal>(cliente.perfil);
  const [ocupado, setOcupado] = useState(false);
  const [guardado, setGuardado] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function guardar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    setGuardado(false);
    const valido = clienteEditarSchema.safeParse({
      razonSocial: razonSocial.trim(),
      perfil,
    });
    if (!valido.success) {
      setError(MENSAJES_DETALLE.datosInvalidos);
      return;
    }
    setOcupado(true);
    setError(null);
    try {
      const r = await editarCliente(cliente.id, valido.data);
      if (r.ok && r.datos) {
        setRazonSocial(r.datos.razonSocial);
        setPerfil(r.datos.perfil);
        setGuardado(true);
        onCambio(r.datos);
      } else if (
        r.status === 409 &&
        codigoDe(r.datos) === "cliente_archivado"
      ) {
        onCambio({ ...cliente, archivado: true });
      } else if (r.status !== 401) {
        setError(
          r.status === 400
            ? MENSAJES_DETALLE.datosInvalidos
            : mensajeDeError(r.status, r.datos),
        );
      }
    } catch {
      setError(MENSAJES.errorGeneral);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <form onSubmit={guardar} noValidate className="flex flex-col gap-4">
      <Label>
        Razón social
        <Input
          type="text"
          value={razonSocial}
          disabled={ocupado}
          onChange={(e) => setRazonSocial(e.target.value)}
          className="max-lg:h-11"
        />
      </Label>

      <DatosFiscales
        perfil={perfil}
        onChange={setPerfil}
        deshabilitado={ocupado}
      />

      {error && (
        <Alert tono="error" role="alert">
          {error}
        </Alert>
      )}
      {guardado && (
        <Alert tono="ok" role="status">
          {MENSAJES_DETALLE.datosGuardados}
        </Alert>
      )}

      <Button type="submit" disabled={ocupado} className="self-start max-lg:h-11">
        Guardar datos fiscales
      </Button>
    </form>
  );
}

function DetalleCliente() {
  const { clienteId } = useParams<{ clienteId: string }>();
  const puedeEditar = usePuede("clientes.editar");
  const puedeArchivar = usePuede("clientes.archivar");
  const puedeCredenciales = usePuede("credenciales.editar");
  const puedeVerReglas = usePuede("reglas.ver");
  const puedeVerBuzon = usePuede("buzon.ver");
  const puedeVerProrrata = usePuede(PERMISO_PRORRATA_VER);
  const [cliente, setCliente] = useState<ClienteDto | null>(null);
  const [cargado, setCargado] = useState(false);
  const [asigna, setAsigna] = useState(false);
  const [asignaciones, setAsignaciones] = useState<Asignacion[]>([]);
  const [miembros, setMiembros] = useState<Miembro[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [usuarioId, setUsuarioId] = useState("");
  const [tipo, setTipo] = useState<Tipo>("colaborador");
  const [anterior, setAnterior] = useState<Anterior>("colaborador");
  const [ocupado, setOcupado] = useState(false);
  const [accion, setAccion] = useState<Accion | null>(null);
  const [ocupadoAccion, setOcupadoAccion] = useState(false);
  const [errorAccion, setErrorAccion] = useState<string | null>(null);
  const [mostrarUso, setMostrarUso] = useState(false);

  const recargarAsignaciones = useCallback(async () => {
    const r = await api<Asignacion[]>(`/clientes/${clienteId}/asignaciones`);
    if (r.ok && r.datos) setAsignaciones(r.datos);
    else if (r.status !== 401) setError(mensajeDeError(r.status, r.datos));
  }, [clienteId]);

  useEffect(() => {
    let vigente = true;
    (async () => {
      const { yo, status } = await cargarYo();
      if (!vigente) return;
      if (!yo) {
        if (status !== 401) setError(mensajeDeError(status, null));
        setCargado(true);
        return;
      }
      if (!tiene(yo, "clientes.ver")) {
        setError(MENSAJES.sinPermiso);
        setCargado(true);
        return;
      }
      const c = await api<ClienteDto>(`/clientes/${clienteId}`);
      if (!vigente) return;
      setCargado(true);
      if (!c.ok || !c.datos) {
        if (c.status !== 401) setError(mensajeDeError(c.status, c.datos));
        return;
      }
      setCliente(c.datos);
      if (!tiene(yo, "clientes.asignar")) return;
      setAsigna(true);
      await Promise.all([
        recargarAsignaciones(),
        api<Miembro[]>("/usuarios").then((r) => {
          if (vigente && r.ok && r.datos) setMiembros(r.datos);
        }),
      ]);
    })().catch(() => {
      if (vigente) {
        setCargado(true);
        setError(MENSAJES.errorGeneral);
      }
    });
    return () => {
      vigente = false;
    };
  }, [clienteId, recargarAsignaciones]);

  const archivado = cliente?.archivado === true;
  const editable = cliente !== null && !archivado && puedeEditar === true;

  const hayOtroResponsable = asignaciones.some(
    (a) => a.tipo === "responsable" && a.usuarioId !== usuarioId,
  );

  async function asignar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    if (!usuarioId) return;
    setOcupado(true);
    setError(null);
    try {
      const r = await api<{ codigo?: string }>(
        `/clientes/${clienteId}/asignaciones/${usuarioId}`,
        {
          method: "PUT",
          body: {
            tipo,
            ...(tipo === "responsable" && hayOtroResponsable
              ? { anterior }
              : {}),
          },
        },
      );
      if (!r.ok) {
        if (r.status !== 401) setError(mensajeDeError(r.status, r.datos));
        return;
      }
      await recargarAsignaciones();
    } catch {
      setError(MENSAJES.errorGeneral);
    } finally {
      setOcupado(false);
    }
  }

  async function quitar(id: string) {
    setOcupado(true);
    setError(null);
    try {
      const r = await api<{ codigo?: string }>(
        `/clientes/${clienteId}/asignaciones/${id}`,
        { method: "DELETE" },
      );
      if (!r.ok) {
        if (r.status !== 401) setError(mensajeDeError(r.status, r.datos));
        return;
      }
      await recargarAsignaciones();
    } catch {
      setError(MENSAJES.errorGeneral);
    } finally {
      setOcupado(false);
    }
  }

  async function ejecutarAccion() {
    if (!accion) return;
    setOcupadoAccion(true);
    setErrorAccion(null);
    setMostrarUso(false);
    try {
      const r =
        accion === "archivar"
          ? await archivarCliente(clienteId)
          : await reactivarCliente(clienteId);
      if (r.ok && r.datos) {
        setCliente(r.datos);
      } else if (r.status === 409 && codigoDe(r.datos) === "cupo_rucs") {
        setErrorAccion(MENSAJES_PLAN.limiteRucs);
        setMostrarUso(true);
      } else if (r.status === 409 && codigoDe(r.datos) === "sin_plan") {
        setErrorAccion(MENSAJES_REGISTRO.sinPlan);
      } else if (r.status !== 401) {
        setErrorAccion(mensajeDeError(r.status, r.datos));
      }
    } catch {
      setErrorAccion(MENSAJES.errorGeneral);
    } finally {
      setAccion(null);
      setOcupadoAccion(false);
    }
  }

  if (!cargado) return <main className="p-6 text-tinta-suave">Cargando…</main>;

  const hrefCliente = cliente ? encodeURIComponent(cliente.id) : "";
  const enlaceNav = cn(enlace, "max-lg:inline-flex max-lg:min-h-11 max-lg:items-center");

  return (
    <main className="flex flex-col gap-6 p-6">
      {error && (
        <Alert tono="error" role="alert">
          {error}
        </Alert>
      )}
      {cliente && (
        <EncabezadoPagina
          titulo={cliente.razonSocial}
          descripcion={
            <>
              RUC <span className="font-mono">{cliente.ruc}</span>
            </>
          }
          acciones={
            // Registros del cliente: Compras (spec 015, D-1), Ventas (spec 038, P-4), Reglas aprendidas, Buzón SOL (023) y Prorrata (026).
            <nav
              aria-label="Registros del cliente"
              className="flex flex-wrap items-center gap-x-2 text-sm"
            >
              <Link href={`/clientes/${hrefCliente}/compras`} className={enlaceNav}>
                {MENSAJES_COMPRAS.enlaceCompras}
              </Link>
              {" · "}
              <Link href={`/clientes/${hrefCliente}/ventas`} className={enlaceNav}>
                {MENSAJES_COMPRAS.enlaceVentas}
              </Link>
              {puedeVerReglas === true && (
                <>
                  {" · "}
                  <Link href={`/clientes/${hrefCliente}/reglas`} className={enlaceNav}>
                    {MENSAJES_REGLAS.enlaceReglasCliente}
                  </Link>
                </>
              )}
              {puedeVerBuzon === true && (
                <>
                  {" · "}
                  <Link href={`/clientes/${hrefCliente}/buzon`} className={enlaceNav}>
                    {MENSAJES_BUZON.enlaceBuzon}
                  </Link>
                </>
              )}
              {puedeVerProrrata === true && (
                <>
                  {" · "}
                  <Link href={`/clientes/${hrefCliente}/prorrata`} className={enlaceNav}>
                    {MENSAJES_PRORRATA.enlaceProrrata}
                  </Link>
                </>
              )}
            </nav>
          }
        />
      )}
      {archivado && (
        <Alert tono="aviso" role="status" className="w-full max-w-xl">
          {MENSAJES_DETALLE.clienteArchivado}
        </Alert>
      )}
      {cliente && puedeArchivar === true && (
        <div className="flex w-full max-w-xl flex-col gap-3">
          <Button
            type="button"
            variant="secundario"
            disabled={ocupadoAccion}
            onClick={() => setAccion(archivado ? "reactivar" : "archivar")}
            className="self-start max-lg:h-11"
          >
            {archivado ? "Reactivar" : "Archivar"}
          </Button>
          {errorAccion && (
            <Alert tono="error" role="alert">
              {errorAccion}
            </Alert>
          )}
          {mostrarUso && (
            <UsoPlan
              avisoRucsAnunciado={errorAccion === MENSAJES_PLAN.limiteRucs}
            />
          )}
        </div>
      )}
      {cliente && puedeVerBuzon === true && (
        <RevisarBuzon clienteId={cliente.id} archivado={archivado} />
      )}
      {cliente?.perfil && (
        <Card aria-label="Datos fiscales" className="w-full max-w-xl">
          <CardTitle>Datos fiscales</CardTitle>
          {editable ? (
            <FormularioFiscal cliente={cliente} onCambio={setCliente} />
          ) : (
            <DatosFiscalesLectura perfil={cliente.perfil} />
          )}
        </Card>
      )}
      {cliente && (
        <CredencialesCliente
          clienteId={cliente.id}
          editable={!archivado && puedeCredenciales === true}
        />
      )}
      {cliente && asigna && (
        <Card className="max-w-3xl">
          <CardTitle>Asignaciones</CardTitle>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Nombre</TableHead>
                <TableHead>Tipo</TableHead>
                {!archivado && <TableHead>Acciones</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {asignaciones.map((a) => (
                <TableRow key={a.usuarioId}>
                  <TableCell>{a.nombre}</TableCell>
                  <TableCell>
                    <Badge tono={a.tipo === "responsable" ? "primario" : "neutro"}>
                      {ETIQUETA_TIPO[a.tipo]}
                    </Badge>
                  </TableCell>
                  {!archivado && (
                    <TableCell>
                      <Button
                        type="button"
                        variant="secundario"
                        size="sm"
                        disabled={ocupado}
                        onClick={() => void quitar(a.usuarioId)}
                        className="max-lg:h-11"
                      >
                        Quitar
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {!archivado && (
            <form onSubmit={asignar} className="flex flex-wrap items-end gap-3">
              <Label className="w-full sm:w-auto">
                Usuario
                <Select
                  value={usuarioId}
                  onChange={(e) => setUsuarioId(e.target.value)}
                  className="max-lg:h-11 sm:w-56"
                >
                  <option value="">Elige un usuario</option>
                  {miembros
                    .filter((m) => m.activo)
                    .map((m) => (
                      <option key={m.usuarioId} value={m.usuarioId}>
                        {m.nombre}
                      </option>
                    ))}
                </Select>
              </Label>
              <Label className="w-full sm:w-auto">
                Tipo
                <Select
                  value={tipo}
                  onChange={(e) => setTipo(e.target.value as Tipo)}
                  className="max-lg:h-11 sm:w-44"
                >
                  <option value="colaborador">Colaborador</option>
                  <option value="responsable">Responsable</option>
                </Select>
              </Label>
              {tipo === "responsable" && hayOtroResponsable && (
                <Label className="w-full sm:w-auto">
                  Responsable anterior
                  <Select
                    value={anterior}
                    onChange={(e) => setAnterior(e.target.value as Anterior)}
                    className="max-lg:h-11 sm:w-52"
                  >
                    <option value="colaborador">Pasa a colaborador</option>
                    <option value="retirar">Se retira</option>
                  </Select>
                </Label>
              )}
              <Button type="submit" disabled={ocupado || !usuarioId} className="max-lg:h-11">
                Asignar
              </Button>
            </form>
          )}
        </Card>
      )}

      {accion && (
        <>
          <div aria-hidden="true" className={velo} />
          <div
            role="alertdialog"
            aria-labelledby="titulo-accion"
            aria-describedby="cuerpo-accion"
            className={panelDialogo}
          >
            <h2 id="titulo-accion" className="m-0 font-titulo text-lg font-bold">
              {TEXTO_ACCION[accion].titulo}
            </h2>
            <p id="cuerpo-accion" className="m-0 text-sm text-tinta-media">
              {TEXTO_ACCION[accion].cuerpo}
            </p>
            <div className="flex flex-wrap justify-end gap-3">
              <Button
                type="button"
                variant="secundario"
                disabled={ocupadoAccion}
                onClick={() => setAccion(null)}
                className="max-lg:h-11"
              >
                Cancelar
              </Button>
              <Button
                type="button"
                disabled={ocupadoAccion}
                onClick={() => void ejecutarAccion()}
                className="max-lg:h-11"
              >
                Confirmar
              </Button>
            </div>
          </div>
        </>
      )}
    </main>
  );
}

// `useParams()` es un dato de la URL en tiempo de petición: Next exige un límite de Suspense.
export default function Pagina() {
  return (
    <Suspense fallback={<main className="p-6 text-tinta-suave">Cargando…</main>}>
      <DetalleCliente />
    </Suspense>
  );
}
