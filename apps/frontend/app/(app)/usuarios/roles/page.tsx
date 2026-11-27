"use client";

import { useCallback, useEffect, useState } from "react";
import { CircleAlert, CircleCheck } from "lucide-react";
import {
  ETIQUETA_ROL,
  MENSAJES,
  cargarYo,
  mensajeDeError,
  tiene,
  type Yo,
} from "../../../../lib/acceso";
import { api } from "../../../../lib/api";
import {
  ETIQUETA_ALCANCE,
  MENSAJES_ROLES,
  cargarRoles,
  mensajeDeErrorRol,
  type ListaRoles,
  type RolPropio,
} from "../../../../lib/roles";
import {
  Alert,
  Button,
  Card,
  CardTitle,
  EncabezadoPagina,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../../components/ui";
import { FormularioRol } from "./formulario-rol";

// Equipo → Roles (spec 030): roles de sistema (solo lectura) y roles propios del estudio con su formulario. Todo se
// decide en el servidor; aquí solo se oculta lo que el actor no puede hacer (RNF-007).

/** Qué formulario está abierto: crear, o editar el rol con ese id. */
type Formulario = { modo: "crear" } | { modo: "editar"; id: string };

export default function Roles() {
  const [yo, setYo] = useState<Yo | null>(null);
  const [cargado, setCargado] = useState(false);
  const [lista, setLista] = useState<ListaRoles | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [formulario, setFormulario] = useState<Formulario | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const recargar = useCallback(async () => {
    const r = await cargarRoles();
    if (r.ok && r.datos) {
      setLista(r.datos);
      return;
    }
    if (r.status !== 401) setError(mensajeDeError(r.status, r.datos));
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
      if (!tiene(actual, "roles.gestionar")) return;
      await recargar();
    })().catch(() => {
      if (vigente) {
        setCargado(true);
        setError(MENSAJES.errorGeneral);
      }
    });
    return () => {
      vigente = false;
    };
  }, [recargar]);

  async function eliminar(rol: RolPropio) {
    setError(null);
    setAviso(null);
    setOcupado(true);
    try {
      const r = await api(`/roles/${rol.id}`, { method: "DELETE" });
      if (!r.ok) {
        if (r.status !== 401) setError(mensajeDeErrorRol(r.status, r.datos));
        return;
      }
      setAviso(MENSAJES_ROLES.rolEliminado);
      await recargar();
    } catch {
      setError(MENSAJES.errorGeneral);
    } finally {
      setOcupado(false);
    }
  }

  async function alGuardar(mensaje: string) {
    setFormulario(null);
    setAviso(mensaje);
    await recargar();
  }

  function abrir(destino: Formulario) {
    setError(null);
    setAviso(null);
    setFormulario(destino);
  }

  if (!cargado)
    return <main className="p-4 text-tinta-suave sm:p-6">{MENSAJES_ROLES.cargando}</main>;

  const gestiona = tiene(yo, "roles.gestionar");
  const enEdicion =
    formulario?.modo === "editar"
      ? lista?.propios.find((p) => p.id === formulario.id)
      : undefined;
  const formularioAbierto =
    yo && lista && (formulario?.modo === "crear" || enEdicion);

  return (
    <main className="flex min-w-0 flex-col gap-6 p-4 sm:p-6">
      <EncabezadoPagina
        titulo={MENSAJES_ROLES.titulo}
        acciones={
          gestiona ? (
            <Button
              disabled={ocupado}
              onClick={() => abrir({ modo: "crear" })}
              className="max-lg:h-11"
            >
              {MENSAJES_ROLES.crear}
            </Button>
          ) : null
        }
      />
      {error && (
        <Alert tono="error" role="alert">
          <CircleAlert aria-hidden="true" />
          <p>{error}</p>
        </Alert>
      )}
      {aviso && (
        <Alert tono="ok" role="status">
          <CircleCheck aria-hidden="true" />
          <p className="m-0">{aviso}</p>
        </Alert>
      )}
      {yo && !gestiona && (
        <p className="m-0 text-tinta-media">{MENSAJES.sinPermiso}</p>
      )}
      {yo && lista && formularioAbierto && (
        <FormularioRol
          key={enEdicion?.id ?? "nuevo"}
          rol={enEdicion ?? null}
          lista={lista}
          yo={yo}
          alError={setError}
          alGuardar={alGuardar}
          alCancelar={() => setFormulario(null)}
        />
      )}
      {yo && lista && gestiona && (
        <>
          <Card className="p-4 sm:p-6">
            <CardTitle>{MENSAJES_ROLES.tablaSistema}</CardTitle>
            <Table aria-label={MENSAJES_ROLES.tablaSistema}>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Rol</TableHead>
                  <TableHead>Alcance</TableHead>
                  <TableHead>Permisos</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lista.sistema.map((s) => (
                  <TableRow key={s.rol}>
                    <TableCell>{ETIQUETA_ROL[s.rol]}</TableCell>
                    <TableCell>{ETIQUETA_ALCANCE[s.alcance]}</TableCell>
                    <TableCell>{s.permisos.length} permisos</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>

          <Card className="p-4 sm:p-6">
            <CardTitle>{MENSAJES_ROLES.tablaPropios}</CardTitle>
            {lista.propios.length === 0 ? (
              <p className="m-0 text-tinta-media">{MENSAJES_ROLES.sinPropios}</p>
            ) : (
              <Table aria-label={MENSAJES_ROLES.tablaPropios}>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Nombre</TableHead>
                    <TableHead>Alcance</TableHead>
                    <TableHead>Miembros</TableHead>
                    <TableHead>Invitaciones</TableHead>
                    <TableHead>Acciones</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lista.propios.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell>{p.nombre}</TableCell>
                      <TableCell>{ETIQUETA_ALCANCE[p.alcance]}</TableCell>
                      <TableCell numerico>{p.miembros}</TableCell>
                      <TableCell numerico>{p.invitaciones}</TableCell>
                      <TableCell>
                        {/* U2: nadie edita ni elimina el rol que tiene asignado. */}
                        {yo.rolPropio?.id !== p.id && (
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              variant="secundario"
                              size="sm"
                              disabled={ocupado}
                              onClick={() => abrir({ modo: "editar", id: p.id })}
                              className="max-lg:h-11"
                            >
                              {MENSAJES_ROLES.editar}
                            </Button>
                            <Button
                              variant="secundario"
                              size="sm"
                              disabled={ocupado}
                              onClick={() => void eliminar(p)}
                              className="max-lg:h-11"
                            >
                              {MENSAJES_ROLES.eliminar}
                            </Button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>
        </>
      )}
    </main>
  );
}
