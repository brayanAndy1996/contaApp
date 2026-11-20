"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import {
  MENSAJES,
  cargarYo,
  mensajeDeError,
  tiene,
  type Miembro,
  type Yo,
} from "../../../lib/acceso";
import { api } from "../../../lib/api";
import { IndicadorBuzon } from "../../../components/clientes/indicador-buzon";
import { ETIQUETA_ESTADO, listarClientes } from "../../../lib/clientes";
import {
  FILTROS_VACIOS,
  FiltrosClientes,
  filtrosDeEstado,
  type EstadoFiltros,
} from "../../../components/filtros-clientes";
import {
  Alert,
  Badge,
  Button,
  EncabezadoPagina,
  Label,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  buttonVariants,
  enlace,
} from "../../../components/ui";
import { cn } from "../../../lib/utils";
import type { ClienteDto, EstadoCredencial } from "@contapp/shared";

// Clientes visibles para el usuario (el backend ya filtra por alcance), filtros (spec 007a, D7, CA-9) y
// asignación masiva (spec 005, CA-5, CA-8, CA-15, D20). Sin cálculos: solo muestra y envía lo elegido.

const ESPERA_BUSQUEDA_MS = 400;

// Fila del listado: `ClienteDto`; credenciales y archivado se leen con tolerancia (las pruebas de 005
// responden filas mínimas sin ellos).
type Fila = Omit<ClienteDto, "credenciales" | "archivado"> &
  Partial<Pick<ClienteDto, "credenciales" | "archivado">>;

// El estado se distingue por texto y por tono (el color nunca es la única señal).
const TONO_ESTADO = {
  no_configurada: "neutro",
  configurada: "info",
  verificada: "ok",
  invalida: "error",
} as const satisfies Record<EstadoCredencial, "neutro" | "info" | "ok" | "error">;

type Tipo = "colaborador" | "responsable";
type Anterior = "colaborador" | "retirar";

export default function Clientes() {
  const [yo, setYo] = useState<Yo | null>(null);
  const [cargado, setCargado] = useState(false);
  const [clientes, setClientes] = useState<Fila[]>([]);
  const [miembros, setMiembros] = useState<Miembro[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());
  const [usuarioId, setUsuarioId] = useState("");
  const [tipo, setTipo] = useState<Tipo>("colaborador");
  const [anterior, setAnterior] = useState<Anterior>("colaborador");
  const [enviando, setEnviando] = useState(false);

  const [filtros, setFiltros] = useState<EstadoFiltros>(FILTROS_VACIOS);
  const [qEnviada, setQEnviada] = useState("");
  const [version, setVersion] = useState(0);

  const puedeVerClientes = tiene(yo, "clientes.ver");
  const { responsable, credencial, archivados, conMensajesNuevos } = filtros;

  // La búsqueda por texto se envía un momento después de dejar de escribir.
  useEffect(() => {
    const t = setTimeout(
      () => setQEnviada(filtros.q.trim()),
      ESPERA_BUSQUEDA_MS,
    );
    return () => clearTimeout(t);
  }, [filtros.q]);

  // Pide el listado con los filtros activos; una respuesta tardía de una consulta anterior se descarta.
  useEffect(() => {
    if (!puedeVerClientes) return;
    let vigente = true;
    listarClientes(
      filtrosDeEstado({ responsable, credencial, archivados, q: qEnviada, conMensajesNuevos }),
    )
      .then((r) => {
        if (!vigente) return;
        if (r.ok && r.datos) {
          const lista = r.datos;
          setClientes(lista);
          setSeleccion((previa) => {
            const visibles = new Set(lista.map((c) => c.id));
            return new Set([...previa].filter((id) => visibles.has(id)));
          });
        } else if (r.status !== 401) {
          setError(mensajeDeError(r.status, r.datos));
        }
      })
      .catch(() => {
        if (vigente) setError(MENSAJES.errorGeneral);
      });
    return () => {
      vigente = false;
    };
  }, [
    puedeVerClientes,
    responsable,
    credencial,
    archivados,
    conMensajesNuevos,
    qEnviada,
    version,
  ]);

  useEffect(() => {
    let vigente = true;
    (async () => {
      const { yo: actual, status } = await cargarYo();
      if (!vigente) return;
      setYo(actual);
      setCargado(true);
      if (!actual) {
        if (status !== 401) setError(mensajeDeError(status, null));
        return;
      }
      if (!tiene(actual, "clientes.ver")) return;
      if (tiene(actual, "clientes.asignar") || tiene(actual, "usuarios.ver")) {
        const r = await api<Miembro[]>("/usuarios");
        if (vigente && r.ok && r.datos) setMiembros(r.datos);
      }
    })().catch(() => {
      if (vigente) {
        setCargado(true);
        setError(MENSAJES.errorGeneral);
      }
    });
    return () => {
      vigente = false;
    };
  }, []);

  function alternar(id: string) {
    setSeleccion((previa) => {
      const nueva = new Set(previa);
      if (nueva.has(id)) nueva.delete(id);
      else nueva.add(id);
      return nueva;
    });
  }

  async function asignar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    if (seleccion.size === 0 || !usuarioId) return;
    setEnviando(true);
    setError(null);
    setAviso(null);
    try {
      const r = await api<{ asignados: number; codigo?: string }>(
        "/asignaciones/por-usuario",
        {
          method: "POST",
          body: {
            usuarioId,
            clienteIds: [...seleccion],
            tipo,
            ...(tipo === "responsable" ? { anterior } : {}),
          },
        },
      );
      if (!r.ok) {
        if (r.status !== 401) setError(mensajeDeError(r.status, r.datos));
        return;
      }
      setAviso(`Clientes asignados: ${r.datos?.asignados ?? seleccion.size}`);
      setSeleccion(new Set());
      setVersion((v) => v + 1);
    } catch {
      setError(MENSAJES.errorGeneral);
    } finally {
      setEnviando(false);
    }
  }

  if (!cargado) return <main className="p-6 text-tinta-suave">Cargando…</main>;

  const puedeVer = puedeVerClientes;
  const asigna = tiene(yo, "clientes.asignar");
  const crea = tiene(yo, "clientes.crear");
  const archiva = tiene(yo, "clientes.archivar");
  const verBuzon = tiene(yo, "buzon.ver");
  const activos = miembros.filter((m) => m.activo);

  return (
    <main className="flex flex-col gap-6 p-6">
      <EncabezadoPagina
        titulo="Clientes"
        acciones={
          crea && (
            <>
              <Link
                href="/clientes/importar"
                className={cn(buttonVariants({ variant: "secundario" }), "max-lg:h-11")}
              >
                Importar clientes
              </Link>
              <Link
                href="/clientes/nuevo"
                className={cn(buttonVariants({ variant: "primario" }), "max-lg:h-11")}
              >
                Nuevo cliente
              </Link>
            </>
          )
        }
      />
      {error && (
        <Alert tono="error" role="alert">
          {error}
        </Alert>
      )}
      {aviso && (
        <Alert tono="ok" role="status">
          {aviso}
        </Alert>
      )}
      {yo && !puedeVer && <p className="m-0 text-tinta-media">{MENSAJES.sinPermiso}</p>}
      {yo && puedeVer && (
        <FiltrosClientes
          valor={filtros}
          onCambio={setFiltros}
          responsables={activos}
          conBuzon={verBuzon}
        />
      )}
      {yo && puedeVer && (
        <form onSubmit={asignar} className="flex flex-col gap-4">
          <div className="overflow-hidden rounded-tarjeta border border-linea bg-hoja shadow-tarjeta">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  {asigna && <TableHead aria-label="Selección" />}
                  <TableHead>RUC</TableHead>
                  <TableHead>Razón social</TableHead>
                  <TableHead>Responsable</TableHead>
                  <TableHead>Credenciales</TableHead>
                  {verBuzon && <TableHead>Buzón</TableHead>}
                  {archiva && <TableHead>Acciones</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {clientes.map((c) => (
                  <TableRow key={c.id}>
                    {asigna && (
                      <TableCell>
                        {/* Bajo 1024 px la etiqueta envolvente da 44 × 44 px de área táctil. */}
                        <label className="flex items-center justify-center max-lg:-m-2 max-lg:size-11">
                          <input
                            type="checkbox"
                            aria-label={`Seleccionar ${c.razonSocial}`}
                            checked={seleccion.has(c.id)}
                            disabled={c.archivado}
                            onChange={() => alternar(c.id)}
                            className="size-5 cursor-pointer accent-primario disabled:cursor-not-allowed disabled:opacity-45 max-lg:size-6"
                          />
                        </label>
                      </TableCell>
                    )}
                    <TableCell className="font-mono">{c.ruc}</TableCell>
                    <TableCell>
                      <Link href={`/clientes/${c.id}`} className={cn(enlace, "font-semibold")}>
                        {c.razonSocial}
                      </Link>
                    </TableCell>
                    <TableCell>{c.responsable?.nombre ?? MENSAJES.sinResponsable}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1.5">
                        {c.archivado && <Badge tono="neutro">Archivado</Badge>}
                        {c.credenciales && (
                          <>
                            <Badge tono={TONO_ESTADO[c.credenciales.sol]}>
                              SOL: {ETIQUETA_ESTADO[c.credenciales.sol]}
                            </Badge>
                            <Badge tono={TONO_ESTADO[c.credenciales.sire_api]}>
                              SIRE API: {ETIQUETA_ESTADO[c.credenciales.sire_api]}
                            </Badge>
                          </>
                        )}
                      </div>
                    </TableCell>
                    {verBuzon && (
                      <TableCell>
                        <IndicadorBuzon clienteId={c.id} buzon={c.buzon} />
                      </TableCell>
                    )}
                    {archiva && (
                      <TableCell>
                        <Link href={`/clientes/${c.id}`} className={enlace}>
                          {c.archivado ? "Reactivar" : "Archivar"}
                        </Link>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {asigna && (
            <div className="flex flex-wrap items-end gap-3">
              <Label className="w-full sm:w-auto">
                Usuario
                <Select
                  value={usuarioId}
                  onChange={(e) => setUsuarioId(e.target.value)}
                  className="max-lg:h-11 sm:w-56"
                >
                  <option value="">Elige un usuario</option>
                  {activos.map((m) => (
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
              {tipo === "responsable" && (
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
              <Button
                type="submit"
                disabled={enviando || seleccion.size === 0 || !usuarioId}
                className="max-lg:h-11"
              >
                Asignar seleccionados
              </Button>
            </div>
          )}
        </form>
      )}
    </main>
  );
}
