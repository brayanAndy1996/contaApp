"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { CircleAlert, CircleCheck } from "lucide-react";
import {
  ETIQUETA_ROL,
  MENSAJES,
  ROLES,
  cargarYo,
  fechaCorta,
  mensajeDeError,
  puedeOtorgar,
  puedeTocar,
  tiene,
  type Miembro,
  type Rol,
  type Yo,
} from "../../../lib/acceso";
import { api, type RespuestaApi } from "../../../lib/api";
import { UsoPlan } from "../../../components/uso-plan";
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
} from "../../../components/ui";
import { MENSAJES_PLAN } from "../../../lib/planes";

// Usuarios del estudio (spec 005, CA-15): miembros, invitaciones y sus acciones. Todo se decide en
// el servidor; aquí solo se oculta lo que el rol no puede hacer (RNF-007).

interface Invitacion {
  id: string;
  correo: string;
  rol: Rol;
  creadaEn: string;
  venceEn: string;
  vencida: boolean;
}

const INVITACION_ENVIADA = "Invitación enviada.";

export default function Usuarios() {
  const [yo, setYo] = useState<Yo | null>(null);
  const [cargado, setCargado] = useState(false);
  const [miembros, setMiembros] = useState<Miembro[]>([]);
  const [invitaciones, setInvitaciones] = useState<Invitacion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [correo, setCorreo] = useState("");
  const [rolNuevo, setRolNuevo] = useState<Rol>("lectura");
  const [ocupado, setOcupado] = useState(false);
  // Un 409 cupo_usuarios añade el aviso de cómo subir de plan (D8), además del mensaje del servidor.
  const [cupoAgotado, setCupoAgotado] = useState(false);

  const recargarMiembros = useCallback(async () => {
    const r = await api<Miembro[]>("/usuarios");
    if (r.ok && r.datos) setMiembros(r.datos);
    else if (r.status !== 401) setError(mensajeDeError(r.status, r.datos));
  }, []);

  const recargarInvitaciones = useCallback(async () => {
    const r = await api<Invitacion[]>("/invitaciones");
    if (r.ok && r.datos) setInvitaciones(r.datos);
    else if (r.status !== 401) setError(mensajeDeError(r.status, r.datos));
  }, []);

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
      if (!tiene(actual, "usuarios.ver")) return;
      await Promise.all([recargarMiembros(), recargarInvitaciones()]);
    })().catch(() => {
      if (vigente) {
        setCargado(true);
        setError(MENSAJES.errorGeneral);
      }
    });
    return () => {
      vigente = false;
    };
  }, [recargarMiembros, recargarInvitaciones]);

  /** Ejecuta una acción; si sale bien recarga lo indicado, si no muestra un mensaje genérico. */
  async function ejecutar(
    accion: () => Promise<RespuestaApi<{ codigo?: string }>>,
    recargar: Array<() => Promise<void>>,
    exito?: string,
  ): Promise<boolean> {
    setError(null);
    setAviso(null);
    setCupoAgotado(false);
    setOcupado(true);
    try {
      const r = await accion();
      if (!r.ok) {
        if (r.status !== 401) {
          setError(mensajeDeError(r.status, r.datos));
          setCupoAgotado(
            r.status === 409 && r.datos?.codigo === "cupo_usuarios",
          );
        }
        return false;
      }
      if (exito) setAviso(exito);
      await Promise.all(recargar.map((f) => f()));
      return true;
    } catch {
      setError(MENSAJES.errorGeneral);
      return false;
    } finally {
      setOcupado(false);
    }
  }

  async function invitar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    const ok = await ejecutar(
      () =>
        api("/invitaciones", {
          method: "POST",
          body: { correo, rol: rolNuevo },
        }),
      [recargarInvitaciones],
      INVITACION_ENVIADA,
    );
    if (ok) setCorreo("");
  }

  if (!cargado) return <main className="p-4 text-tinta-suave sm:p-6">Cargando…</main>;

  const puedeVer = tiene(yo, "usuarios.ver");
  const gestiona = tiene(yo, "usuarios.gestionar");
  const rolActor = yo?.rol ?? "lectura";
  const rolesOtorgables = ROLES.filter((r) => puedeOtorgar(rolActor, r));

  return (
    <main className="flex min-w-0 flex-col gap-6 p-4 sm:p-6">
      <EncabezadoPagina titulo="Usuarios" />
      {error && (
        <Alert tono="error" role="alert">
          <CircleAlert aria-hidden="true" />
          <div className="flex flex-col gap-1 [&_p]:m-0">
            <p>{error}</p>
            {cupoAgotado && <p>{MENSAJES_PLAN.subirDePlan}</p>}
          </div>
        </Alert>
      )}
      {aviso && (
        <Alert tono="ok" role="status">
          <CircleCheck aria-hidden="true" />
          <p className="m-0">{aviso}</p>
        </Alert>
      )}
      {yo && !puedeVer && <p className="m-0 text-tinta-media">{MENSAJES.sinPermiso}</p>}
      {yo && puedeVer && (
        <>
          <UsoPlan />
          <Card className="p-4 sm:p-6">
            <CardTitle>Miembros</CardTitle>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Nombre</TableHead>
                  <TableHead>Correo</TableHead>
                  <TableHead>Rol</TableHead>
                  <TableHead>Estado</TableHead>
                  {gestiona && <TableHead>Acciones</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {miembros.map((m) => {
                  const accionable =
                    gestiona && !m.esYo && puedeTocar(rolActor, m.rol);
                  return (
                    <TableRow key={m.usuarioId}>
                      <TableCell>{m.nombre}</TableCell>
                      <TableCell>{m.correo}</TableCell>
                      <TableCell>
                        <Badge tono="info">{ETIQUETA_ROL[m.rol]}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge tono={m.activo ? "ok" : "neutro"}>
                          {m.activo ? "Activo" : "Desactivado"}
                        </Badge>
                      </TableCell>
                      {gestiona && (
                        <TableCell>
                          <div className="flex flex-wrap items-center gap-2">
                            {accionable && m.activo && (
                              <>
                                <Select
                                  aria-label="Cambiar rol"
                                  value={m.rol}
                                  disabled={ocupado}
                                  onChange={(e) =>
                                    void ejecutar(
                                      () =>
                                        api(`/usuarios/${m.usuarioId}/rol`, {
                                          method: "PATCH",
                                          body: { rol: e.target.value },
                                        }),
                                      [recargarMiembros],
                                    )
                                  }
                                  className="h-8 w-auto max-lg:h-11"
                                >
                                  {rolesOtorgables.map((r) => (
                                    <option key={r} value={r}>
                                      {ETIQUETA_ROL[r]}
                                    </option>
                                  ))}
                                </Select>
                                <Button
                                  variant="secundario"
                                  size="sm"
                                  disabled={ocupado}
                                  onClick={() =>
                                    void ejecutar(
                                      () =>
                                        api(
                                          `/usuarios/${m.usuarioId}/desactivar`,
                                          { method: "POST" },
                                        ),
                                      [recargarMiembros],
                                    )
                                  }
                                  className="max-lg:h-11"
                                >
                                  Desactivar
                                </Button>
                              </>
                            )}
                            {accionable && !m.activo && (
                              <Button
                                variant="secundario"
                                size="sm"
                                disabled={ocupado}
                                onClick={() =>
                                  void ejecutar(
                                    () =>
                                      api(`/usuarios/${m.usuarioId}/reactivar`, {
                                        method: "POST",
                                      }),
                                    [recargarMiembros],
                                  )
                                }
                                className="max-lg:h-11"
                              >
                                Reactivar
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Card>

          <Card className="p-4 sm:p-6">
            <CardTitle>Invitaciones</CardTitle>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Correo</TableHead>
                  <TableHead>Rol</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead>Vence</TableHead>
                  {gestiona && <TableHead>Acciones</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {invitaciones.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell>{i.correo}</TableCell>
                    <TableCell>
                      <Badge tono="info">{ETIQUETA_ROL[i.rol]}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge tono={i.vencida ? "aviso" : "neutro"}>
                        {i.vencida ? "Vencida" : "Pendiente"}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{fechaCorta(i.venceEn)}</TableCell>
                    {gestiona && (
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-2">
                          {puedeTocar(rolActor, i.rol) && (
                            <>
                              <Button
                                variant="secundario"
                                size="sm"
                                disabled={ocupado}
                                onClick={() =>
                                  void ejecutar(
                                    () =>
                                      api(`/invitaciones/${i.id}/reenviar`, {
                                        method: "POST",
                                      }),
                                    [recargarInvitaciones],
                                  )
                                }
                                className="max-lg:h-11"
                              >
                                Reenviar
                              </Button>
                              <Button
                                variant="secundario"
                                size="sm"
                                disabled={ocupado}
                                onClick={() =>
                                  void ejecutar(
                                    () =>
                                      api(`/invitaciones/${i.id}/revocar`, {
                                        method: "POST",
                                      }),
                                    [recargarInvitaciones],
                                  )
                                }
                                className="max-lg:h-11"
                              >
                                Revocar
                              </Button>
                            </>
                          )}
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>

          {gestiona && (
            <Card className="max-w-md p-4 sm:p-6">
              <form onSubmit={invitar} className="flex flex-col gap-4">
                <CardTitle>Invitar a una persona</CardTitle>
                <Label>
                  Correo
                  <Input
                    type="email"
                    autoComplete="off"
                    required
                    value={correo}
                    onChange={(e) => setCorreo(e.target.value)}
                    className="max-lg:h-11"
                  />
                </Label>
                <Label>
                  Rol
                  <Select
                    value={rolNuevo}
                    onChange={(e) => setRolNuevo(e.target.value as Rol)}
                    className="max-lg:h-11"
                  >
                    {rolesOtorgables.map((r) => (
                      <option key={r} value={r}>
                        {ETIQUETA_ROL[r]}
                      </option>
                    ))}
                  </Select>
                </Label>
                <Button type="submit" disabled={ocupado} className="max-lg:h-11">
                  Invitar
                </Button>
              </form>
            </Card>
          )}
        </>
      )}
    </main>
  );
}
