// IDs fijos del seed mínimo (03 §10): 2 estudios, 4 usuarios, membresías y 3 clientes por estudio.
// Un RUC se repite entre A y B (CA-7). Sin datos personales reales ni secretos.
// Spec 004: `contrasenaDesarrollo` es la única contraseña versionada (solo desarrollo y pruebas); las
// credenciales son su PHC argon2id en el piso (m=19456, t=2, p=1), precalculado una vez (packages/db no
// depende de Argon2). Cada usuario tiene su propia sal.
export interface FilaClienteSeed {
  id: string;
  ruc: string;
  razonSocial: string;
}

export interface FilaCredencialSeed {
  usuarioId: string;
  hash: string;
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
const uSin = "01920000-0000-7000-8000-0000000001c1";
const rucRepetido = "20100070970";

export const SEED = {
  tenantA,
  tenantB,
  uA,
  uB,
  uAB,
  /** Usuario sin estudios (P7). */
  uSin,
  rucRepetido,
  contrasenaDesarrollo: "desarrollo-contapp-2026",
  tenants: [
    { id: tenantA, nombre: "Estudio A (seed)" },
    { id: tenantB, nombre: "Estudio B (seed)" },
  ],
  usuarios: [
    { id: uA, email: "ua@seed.contapp.test", nombre: "Usuario A" },
    { id: uB, email: "ub@seed.contapp.test", nombre: "Usuario B" },
    { id: uAB, email: "uab@seed.contapp.test", nombre: "Usuario AB" },
    { id: uSin, email: "usin@seed.contapp.test", nombre: "Usuario sin estudio" },
  ],
  credenciales: [
    { usuarioId: uA, hash: "$argon2id$v=19$m=19456,t=2,p=1$FKjID1608QMgu8vHsmm8AA$fnG9+IMMtknbelExRCdxUhGgfw0cvQGWh6iVND07lVQ" },
    { usuarioId: uB, hash: "$argon2id$v=19$m=19456,t=2,p=1$x4yaqpEo8TfGBCGx8oU2YA$UjcniTpRPAnoo7pDtRIniO7W+KOvs7V2HC5uEHx4t4I" },
    { usuarioId: uAB, hash: "$argon2id$v=19$m=19456,t=2,p=1$acW8O/u6raLGoxyfkmDdUQ$nhiITIbNWVmWnDjzOTTEaLvW6tg6jWMFST7Nte90dNE" },
    { usuarioId: uSin, hash: "$argon2id$v=19$m=19456,t=2,p=1$jfpMaA07JoQsLT/QqGlvJA$i0uGjyp1NUR3bX4IfPNxu9fDJQamX28JWmegn07kB9U" },
  ] as FilaCredencialSeed[],
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
