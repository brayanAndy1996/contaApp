"use client";

import {
  Ellipsis,
  KeyRound,
  ListChecks,
  LogOut,
  ScrollText,
  SlidersHorizontal,
  UserCog,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { tiene, type Yo } from "../../lib/acceso";
import { cn } from "../../lib/utils";
import { anilloFoco, Label, Select } from "../ui";

// Marco de navegación (spec 038, T8; P-5). Un solo `<nav>` con cada entrada una vez en el DOM: el CSS cambia
// de disposición (menú lateral desde 1024 px; barra inferior con Clientes, Trabajos, Notificaciones y «Más» en
// celular). jsdom no aplica CSS, así que ninguna entrada se oculta con estado de React: «Más» solo muestra u
// oculta el grupo secundario por clase.

export interface EstudioMenu {
  id: string;
  nombre: string;
}

interface Props {
  estudioActivoId: string;
  estudios: EstudioMenu[];
  yo: Yo | null;
  /** La campana (T15 la estila); solo se pinta cuando hay sesión. */
  campana: ReactNode;
  alCambiarEstudio: (tenantId: string) => void;
  alCerrarSesion: () => void;
}

// Entrada de la barra inferior: ícono sobre texto en celular; fila en el menú lateral.
const entradaBarra = cn(
  "flex min-h-11 items-center gap-3 rounded-control px-3 text-sm font-semibold text-tinta-media hover:bg-neutro-fondo",
  "max-lg:min-w-11 max-lg:flex-1 max-lg:flex-col max-lg:justify-center max-lg:gap-0.5 max-lg:px-1 max-lg:text-xs",
  anilloFoco,
);

// Entrada del grupo secundario («Más» en celular): siempre en fila.
const entradaGrupo = cn(
  "flex min-h-11 w-full items-center gap-3 rounded-control px-3 text-sm font-semibold text-tinta-media hover:bg-neutro-fondo",
  anilloFoco,
);

const activa = "bg-primario-suave text-primario hover:bg-primario-suave";

function esActiva(ruta: string | null, href: string): boolean {
  return ruta === href || (ruta?.startsWith(`${href}/`) ?? false);
}

export function MenuPrincipal({
  estudioActivoId,
  estudios,
  yo,
  campana,
  alCambiarEstudio,
  alCerrarSesion,
}: Props) {
  const ruta = usePathname();
  const [masAbierto, setMasAbierto] = useState(false);
  const botonMas = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!masAbierto) return;
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMasAbierto(false);
      botonMas.current?.focus();
    };
    document.addEventListener("keydown", alTeclear);
    return () => document.removeEventListener("keydown", alTeclear);
  }, [masAbierto]);

  const clase = (href: string, base: string) =>
    cn(base, esActiva(ruta, href) && activa);
  const actual = (href: string) => (esActiva(ruta, href) ? "page" : undefined);

  return (
    <nav
      className={cn(
        "fixed inset-x-0 bottom-0 z-40 flex flex-wrap items-stretch justify-around gap-1 border-t border-linea bg-hoja-alterna px-2 pt-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] text-sm text-tinta shadow-flotante",
        "lg:inset-x-auto lg:inset-y-0 lg:left-0 lg:w-64 lg:flex-col lg:flex-nowrap lg:justify-start lg:gap-1 lg:overflow-y-auto lg:border-r lg:border-t-0 lg:p-4 lg:shadow-none",
      )}
    >
      {tiene(yo, "clientes.ver") && (
        <Link
          href="/clientes"
          aria-current={actual("/clientes")}
          className={clase("/clientes", cn(entradaBarra, "lg:order-2"))}
        >
          <Users aria-hidden="true" className="size-5 shrink-0" />
          Clientes
        </Link>
      )}
      {tiene(yo, "clientes.ver") && (
        <Link
          href="/trabajos"
          aria-current={actual("/trabajos")}
          className={clase("/trabajos", cn(entradaBarra, "lg:order-3"))}
        >
          <ListChecks aria-hidden="true" className="size-5 shrink-0" />
          Trabajos
        </Link>
      )}
      {campana && (
        <div className="flex min-h-11 items-center max-lg:min-w-11 max-lg:flex-1 max-lg:justify-center lg:order-4 lg:px-3">
          {campana}
        </div>
      )}
      <button
        ref={botonMas}
        type="button"
        aria-expanded={masAbierto}
        aria-controls="menu-mas"
        onClick={() => setMasAbierto((v) => !v)}
        className={cn(entradaBarra, "lg:hidden", masAbierto && activa)}
      >
        <Ellipsis aria-hidden="true" className="size-5 shrink-0" />
        Más
      </button>
      {/* Grupo secundario: ventana sobre la barra en celular (cerrada por defecto) y entradas sueltas del menú lateral desde 1024 px. */}
      <div
        id="menu-mas"
        onClick={(e) => {
          if (e.target instanceof Element && e.target.closest("a"))
            setMasAbierto(false);
        }}
        className={cn(
          masAbierto
            ? "absolute inset-x-2 bottom-full mb-2 flex max-h-[70dvh] flex-col gap-1 overflow-y-auto rounded-tarjeta border border-linea bg-hoja p-3 shadow-flotante"
            : "hidden",
          "lg:contents",
        )}
      >
        <Label className="gap-1 px-1 pb-2 lg:order-1 lg:pb-3">
          Estudio
          <Select
            value={estudioActivoId}
            onChange={(e) => alCambiarEstudio(e.target.value)}
            disabled={estudios.length === 0}
            className="max-lg:h-11"
          >
            {estudios.map((e) => (
              <option key={e.id} value={e.id}>
                {e.nombre}
              </option>
            ))}
          </Select>
        </Label>
        {tiene(yo, "usuarios.ver") && (
          <Link
            href="/usuarios"
            aria-current={actual("/usuarios")}
            className={clase("/usuarios", cn(entradaGrupo, "lg:order-5"))}
          >
            <UserCog aria-hidden="true" className="size-5 shrink-0" />
            Usuarios
          </Link>
        )}
        {tiene(yo, "auditoria.ver") && (
          <Link
            href="/configuracion/auditoria"
            aria-current={actual("/configuracion/auditoria")}
            className={clase(
              "/configuracion/auditoria",
              cn(entradaGrupo, "lg:order-6"),
            )}
          >
            <ScrollText aria-hidden="true" className="size-5 shrink-0" />
            Auditoría
          </Link>
        )}
        {tiene(yo, "reglas.ver") && (
          <Link
            href="/configuracion/reglas"
            aria-current={actual("/configuracion/reglas")}
            className={clase(
              "/configuracion/reglas",
              cn(entradaGrupo, "lg:order-7"),
            )}
          >
            <SlidersHorizontal aria-hidden="true" className="size-5 shrink-0" />
            Reglas del motor
          </Link>
        )}
        <Link
          href="/cuenta/contrasena"
          aria-current={actual("/cuenta/contrasena")}
          className={clase(
            "/cuenta/contrasena",
            cn(entradaGrupo, "lg:order-8 lg:mt-auto"),
          )}
        >
          <KeyRound aria-hidden="true" className="size-5 shrink-0" />
          Cambiar contraseña
        </Link>
        <button
          type="button"
          onClick={alCerrarSesion}
          className={cn(entradaGrupo, "text-left lg:order-9")}
        >
          <LogOut aria-hidden="true" className="size-5 shrink-0" />
          Cerrar sesión
        </button>
      </div>
    </nav>
  );
}
