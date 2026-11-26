"use client";

import {
  Ellipsis,
  Inbox,
  KeyRound,
  ListChecks,
  LogOut,
  Mail,
  ShieldCheck,
  ScrollText,
  SlidersHorizontal,
  UserLock,
  UserCog,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { tiene, type Yo } from "../../lib/acceso";
import { cn } from "../../lib/utils";
import { Label, Select } from "../ui";
import { entradaBarra, entradaGrupo } from "./entrada-menu";

// Marco de navegación (spec 038, T8; P-5). Un solo `<nav>` con cada entrada una vez en el DOM: el CSS cambia
// de disposición (menú lateral desde 1024 px; barra inferior con Clientes, Buzones, Trabajos, Notificaciones y «Más» en
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

/** Variable CSS con el alto real de la barra inferior (solo bajo 1024 px; desde ahí el menú es lateral y vale 0). */
export const VARIABLE_ALTO_BARRA = "--alto-barra-inferior";

const activa = "bg-primario-suave text-primario hover:bg-primario-suave";

function esActiva(ruta: string | null, href: string): boolean {
  // «Roles» cuelga de /usuarios/roles: no deja «Usuarios» marcada a la vez.
  if (href === "/usuarios" && ruta?.startsWith("/usuarios/roles")) return false;
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
  const barra = useRef<HTMLElement>(null);

  // Publica el alto real de la barra inferior para lo que se fija sobre ella (botón «Generar archivo», T13). El
  // alto cambia con el área segura del dispositivo y si las entradas se parten en líneas; por eso se mide.
  useEffect(() => {
    const nav = barra.current;
    if (!nav) return;
    const raiz = document.documentElement;
    const medir = () => {
      const lateral =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(min-width: 1024px)").matches;
      const alto = lateral ? 0 : Math.ceil(nav.getBoundingClientRect().height);
      raiz.style.setProperty(VARIABLE_ALTO_BARRA, `${alto}px`);
    };
    medir();
    const observador =
      typeof ResizeObserver === "function" ? new ResizeObserver(medir) : null;
    observador?.observe(nav);
    window.addEventListener("resize", medir);
    return () => {
      observador?.disconnect();
      window.removeEventListener("resize", medir);
      raiz.style.removeProperty(VARIABLE_ALTO_BARRA);
    };
  }, []);

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
      ref={barra}
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
      {tiene(yo, "buzon.ver") && (
        <Link
          href="/buzon"
          aria-current={actual("/buzon")}
          className={clase("/buzon", cn(entradaBarra, "lg:order-2"))}
        >
          <Inbox aria-hidden="true" className="size-5 shrink-0" />
          Buzones
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
        <div className="flex items-stretch max-lg:min-w-11 max-lg:flex-1 lg:order-4">
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
        {tiene(yo, "roles.gestionar") && (
          <Link
            href="/usuarios/roles"
            aria-current={actual("/usuarios/roles")}
            className={clase("/usuarios/roles", cn(entradaGrupo, "lg:order-5"))}
          >
            <UserLock aria-hidden="true" className="size-5 shrink-0" />
            Roles
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
          href="/cuenta/correo"
          aria-current={actual("/cuenta/correo")}
          className={clase(
            "/cuenta/correo",
            cn(entradaGrupo, "lg:order-8 lg:mt-auto"),
          )}
        >
          <Mail aria-hidden="true" className="size-5 shrink-0" />
          Correo
        </Link>
        <Link
          href="/cuenta/contrasena"
          aria-current={actual("/cuenta/contrasena")}
          className={clase(
            "/cuenta/contrasena",
            cn(entradaGrupo, "lg:order-9"),
          )}
        >
          <KeyRound aria-hidden="true" className="size-5 shrink-0" />
          Cambiar contraseña
        </Link>
        <Link
          href="/cuenta/seguridad"
          aria-current={actual("/cuenta/seguridad")}
          className={clase("/cuenta/seguridad", cn(entradaGrupo, "lg:order-9"))}
        >
          <ShieldCheck aria-hidden="true" className="size-5 shrink-0" />
          Seguridad
        </Link>
        <button
          type="button"
          onClick={alCerrarSesion}
          className={cn(entradaGrupo, "text-left lg:order-10")}
        >
          <LogOut aria-hidden="true" className="size-5 shrink-0" />
          Cerrar sesión
        </button>
      </div>
    </nav>
  );
}
