import { BajaCorreo } from "../../../components/correo/baja-correo";

// Página pública de baja del correo (spec 028, D-4). Sin sesión; `next.config.ts` le pone `no-referrer` y `noindex`.
export default function PaginaBaja() {
  return <BajaCorreo />;
}
