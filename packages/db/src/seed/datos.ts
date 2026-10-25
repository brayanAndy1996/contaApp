// IDs fijos del seed mínimo (03 §10): 2 estudios, 3 usuarios, membresías y 3 clientes por estudio.
// Un RUC se repite entre A y B (CA-7). Sin datos personales reales ni secretos.
export interface FilaClienteSeed {
  id: string;
  ruc: string;
  razonSocial: string;
}

export interface FilaMembresiaSeed {
  id: string;
  tenantId: string;
  usuarioId: string;
  rol: string;
}

const tenantA = "01920000-0000-7000-8000-0000000000a1";
const tenantB = "01920000-0000-7000-8000-0000000000b1";
const uA = "01920000-0000-7000-8000-0000000001a1";
const uB = "01920000-0000-7000-8000-0000000001b1";
const uAB = "01920000-0000-7000-8000-0000000001ab";
const rucRepetido = "20100070970";

export const SEED = {
  tenantA,
  tenantB,
  uA,
  uB,
  uAB,
  rucRepetido,
  tenants: [
    { id: tenantA, nombre: "Estudio A (seed)" },
    { id: tenantB, nombre: "Estudio B (seed)" },
  ],
  usuarios: [
    { id: uA, email: "ua@seed.contapp.test", nombre: "Usuario A" },
    { id: uB, email: "ub@seed.contapp.test", nombre: "Usuario B" },
    { id: uAB, email: "uab@seed.contapp.test", nombre: "Usuario AB" },
  ],
  membresias: [
    { id: "01920000-0000-7000-8000-0000000002a1", tenantId: tenantA, usuarioId: uA, rol: "admin" },
    { id: "01920000-0000-7000-8000-0000000002b1", tenantId: tenantB, usuarioId: uB, rol: "admin" },
    { id: "01920000-0000-7000-8000-0000000002a2", tenantId: tenantA, usuarioId: uAB, rol: "contador" },
    { id: "01920000-0000-7000-8000-0000000002b2", tenantId: tenantB, usuarioId: uAB, rol: "contador" },
  ] as FilaMembresiaSeed[],
  clientesA: [
    { id: "01920000-0000-7000-8000-0000000003a1", ruc: rucRepetido, razonSocial: "Cliente compartido (A)" },
    { id: "01920000-0000-7000-8000-0000000003a2", ruc: "20100047218", razonSocial: "Cliente A dos" },
    { id: "01920000-0000-7000-8000-0000000003a3", ruc: "20131312955", razonSocial: "Cliente A tres" },
  ] as FilaClienteSeed[],
  clientesB: [
    { id: "01920000-0000-7000-8000-0000000003b1", ruc: rucRepetido, razonSocial: "Cliente compartido (B)" },
    { id: "01920000-0000-7000-8000-0000000003b2", ruc: "20100130204", razonSocial: "Cliente B dos" },
    { id: "01920000-0000-7000-8000-0000000003b3", ruc: "20601234567", razonSocial: "Cliente B tres" },
  ] as FilaClienteSeed[],
};
