"use client";

import { useState, type FormEvent } from "react";
import { ETIQUETA_ROL, type Yo } from "../../../../lib/acceso";
import { api } from "../../../../lib/api";
import {
  ETIQUETA_ALCANCE,
  MENSAJES_ROLES,
  PERMISOS_OFRECIDOS,
  mensajeDeErrorRol,
  permisosPorModulo,
  requisitosDe,
  validarFormularioRol,
  type Alcance,
  type CuerpoRol,
  type Impacto,
  type ListaRoles,
  type RolPropio,
} from "../../../../lib/roles";
import {
  Button,
  Card,
  CardTitle,
  Input,
  Label,
  Select,
} from "../../../../components/ui";

// Formulario de un rol propio (spec 030: crear o editar). La validación local (nombre y U3) usa los esquemas de
// `shared`; las casillas y el alcance que el actor no tiene solo se deshabilitan por comodidad (U2, U4): el servidor
// decide y responde 403 `escalada` si hace falta.

interface Props {
  /** `null` = crear; un rol propio = editarlo. */
  rol: RolPropio | null;
  lista: ListaRoles;
  yo: Yo;
  alError: (mensaje: string | null) => void;
  /** El servidor aceptó el cambio: la pantalla cierra el formulario, avisa y recarga. */
  alGuardar: (aviso: string) => Promise<void>;
  alCancelar: () => void;
}

const LINEAS_IMPACTO: Array<[keyof Impacto, (n: number) => string]> = [
  ["miembros", MENSAJES_ROLES.impactoMiembros],
  ["clientesSinResponsable", MENSAJES_ROLES.impactoSinResponsable],
  ["miembrosSinTotpExigidos", MENSAJES_ROLES.impactoTotp],
];

export function FormularioRol({
  rol,
  lista,
  yo,
  alError,
  alGuardar,
  alCancelar,
}: Props) {
  const [nombre, setNombre] = useState(rol?.nombre ?? "");
  const [alcance, setAlcance] = useState<Alcance>(rol?.alcance ?? "asignado");
  const [permisos, setPermisos] = useState<Set<string>>(
    () => new Set(rol?.permisos ?? []),
  );
  const [base, setBase] = useState("");
  const [ocupado, setOcupado] = useState(false);
  // Edición de un rol en uso: lo que se enviaría y el aviso de su impacto (U6, U8), a la espera de «Confirmar».
  const [pendiente, setPendiente] = useState<{
    cuerpo: CuerpoRol;
    lineas: string[];
  } | null>(null);

  const actorTiene = (p: string) => yo.permisos.includes(p);
  const actorGlobal = yo.alcance === "global";

  /** Cualquier cambio del formulario descarta el aviso de impacto: ya no corresponde a lo que se enviaría. */
  function cambiar(accion: () => void) {
    setPendiente(null);
    accion();
  }

  function partirDe(valor: string) {
    cambiar(() => {
      setBase(valor);
      const sistema = lista.sistema.find((s) => s.rol === valor);
      const propio = lista.propios.find((p) => p.id === valor);
      const origen = sistema ?? propio;
      if (!origen) return;
      setAlcance(origen.alcance);
      setPermisos(
        new Set(origen.permisos.filter((p) => PERMISOS_OFRECIDOS.includes(p))),
      );
    });
  }

  function alternar(permiso: string) {
    cambiar(() =>
      setPermisos((previos) => {
        const nuevos = new Set(previos);
        if (!nuevos.delete(permiso)) nuevos.add(permiso);
        return nuevos;
      }),
    );
  }

  async function guardar(cuerpo: CuerpoRol) {
    setOcupado(true);
    try {
      const r = rol
        ? await api(`/roles/${rol.id}`, { method: "PATCH", body: cuerpo })
        : await api("/roles", { method: "POST", body: cuerpo });
      if (!r.ok) {
        if (r.status !== 401) alError(mensajeDeErrorRol(r.status, r.datos));
        return;
      }
      await alGuardar(
        rol ? MENSAJES_ROLES.rolGuardado : MENSAJES_ROLES.rolCreado,
      );
    } catch {
      alError(mensajeDeErrorRol(500, null));
    } finally {
      setOcupado(false);
    }
  }

  async function enviar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    alError(null);
    const esBasePropia = !rol && lista.propios.some((p) => p.id === base);
    const validado = validarFormularioRol({
      nombre,
      alcance,
      permisos: PERMISOS_OFRECIDOS.filter((p) => permisos.has(p)),
      ...(esBasePropia ? { baseRolId: base } : {}),
    });
    if (!validado.ok) {
      alError(validado.mensaje);
      return;
    }
    if (!rol || rol.miembros === 0) {
      await guardar(validado.cuerpo);
      return;
    }
    setOcupado(true);
    try {
      const r = await api<Impacto>(`/roles/${rol.id}/impacto`, {
        method: "POST",
        body: validado.cuerpo,
      });
      if (!r.ok || !r.datos) {
        if (r.status !== 401) alError(mensajeDeErrorRol(r.status, r.datos));
        return;
      }
      const impacto = r.datos;
      const lineas = LINEAS_IMPACTO.filter(([clave]) => impacto[clave] > 0).map(
        ([clave, texto]) => texto(impacto[clave]),
      );
      if (lineas.length === 0) {
        setOcupado(false);
        await guardar(validado.cuerpo);
        return;
      }
      setPendiente({ cuerpo: validado.cuerpo, lineas });
    } catch {
      alError(mensajeDeErrorRol(500, null));
    } finally {
      setOcupado(false);
    }
  }

  return (
    <Card className="p-4 sm:p-6">
      <CardTitle>{rol ? `Editar rol ${rol.nombre}` : MENSAJES_ROLES.crear}</CardTitle>
      <form
        aria-label={MENSAJES_ROLES.formulario}
        onSubmit={enviar}
        className="flex flex-col gap-4"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Label>
            Nombre
            <Input
              maxLength={40}
              autoComplete="off"
              value={nombre}
              onChange={(e) => cambiar(() => setNombre(e.target.value))}
              className="max-lg:h-11"
            />
          </Label>
          <Label>
            Alcance
            <Select
              value={alcance}
              onChange={(e) =>
                cambiar(() => setAlcance(e.target.value as Alcance))
              }
              className="max-lg:h-11"
            >
              <option value="asignado">{ETIQUETA_ALCANCE.asignado}</option>
              <option value="global" disabled={!actorGlobal}>
                {ETIQUETA_ALCANCE.global}
              </option>
            </Select>
          </Label>
          {!rol && (
            <Label>
              Partir de
              <Select
                value={base}
                onChange={(e) => partirDe(e.target.value)}
                className="max-lg:h-11"
              >
                <option value="" />
                {lista.sistema.map((s) => (
                  <option key={s.rol} value={s.rol}>
                    {ETIQUETA_ROL[s.rol]}
                  </option>
                ))}
                {lista.propios.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.nombre}
                  </option>
                ))}
              </Select>
            </Label>
          )}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {permisosPorModulo().map(([modulo, codigos]) => (
            <fieldset
              key={modulo}
              className="m-0 flex min-w-0 flex-col gap-1 rounded-control border border-linea p-3"
            >
              <legend className="px-1 text-[13px] font-semibold capitalize text-tinta-media">
                {modulo}
              </legend>
              {codigos.map((permiso) => {
                const requisitos = requisitosDe(permiso);
                const ayuda = `ayuda-${permiso}`;
                return (
                  <div key={permiso} className="flex flex-col">
                    <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-control px-1 text-sm text-tinta has-[:disabled]:cursor-not-allowed has-[:disabled]:text-tinta-suave lg:min-h-9">
                      <input
                        type="checkbox"
                        checked={permisos.has(permiso)}
                        disabled={ocupado || !actorTiene(permiso)}
                        aria-describedby={requisitos.length ? ayuda : undefined}
                        onChange={() => alternar(permiso)}
                        className="size-5 shrink-0 cursor-pointer accent-primario disabled:cursor-not-allowed"
                      />
                      {permiso}
                    </label>
                    {requisitos.length > 0 && (
                      <span
                        id={ayuda}
                        className="pl-9 text-xs text-tinta-suave"
                      >
                        {MENSAJES_ROLES.requiere(requisitos)}
                      </span>
                    )}
                  </div>
                );
              })}
            </fieldset>
          ))}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={ocupado} className="max-lg:h-11">
            {MENSAJES_ROLES.guardar}
          </Button>
          <Button
            variant="secundario"
            disabled={ocupado}
            onClick={alCancelar}
            className="max-lg:h-11"
          >
            {MENSAJES_ROLES.cancelar}
          </Button>
        </div>
      </form>

      {pendiente && (
        <section
          aria-label={MENSAJES_ROLES.impacto}
          className="flex flex-col gap-3 rounded-tarjeta border border-aviso-borde bg-aviso-fondo p-4 text-sm text-aviso"
        >
          <ul className="m-0 flex list-disc flex-col gap-1 pl-5">
            {pendiente.lineas.map((linea) => (
              <li key={linea}>{linea}</li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={ocupado}
              onClick={() => void guardar(pendiente.cuerpo)}
              className="max-lg:h-11"
            >
              {MENSAJES_ROLES.confirmar}
            </Button>
            <Button
              variant="secundario"
              disabled={ocupado}
              onClick={() => setPendiente(null)}
              className="max-lg:h-11"
            >
              {MENSAJES_ROLES.cancelar}
            </Button>
          </div>
        </section>
      )}
    </Card>
  );
}
