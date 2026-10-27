import { beforeAll, describe, expect, it } from "vitest";
import {
  ContextoAadInvalidoError,
  IntegridadError,
  cifrarCredencial,
  crearKeyWrapper,
  type Sobre,
} from "./index";
import { crearKeyUnwrapper, descifrarSobre } from "./descifrado";
import {
  CLIENTE_1,
  CLIENTE_2,
  TENANT_A,
  TENANT_B,
  VALOR_SIRE,
  VALOR_SOL,
  ctxSire,
  ctxSol,
  ctxTipo,
  esperarFalla,
  voltearBit,
} from "./soporte-pruebas";

// CA-3 (integridad y AAD). Cada caso debe fallar con un error tipado y sin devolver texto parcial.
const ENV_MOCK = { KEY_PROVIDER: "mock" };

let sobre: Sobre;
let unwrapper: ReturnType<typeof crearKeyUnwrapper>;

beforeAll(async () => {
  unwrapper = crearKeyUnwrapper(ENV_MOCK);
  sobre = await cifrarCredencial(
    crearKeyWrapper(ENV_MOCK),
    ctxSol(),
    VALOR_SOL,
  );
});

describe("CA-3 bit-flip en cada campo del sobre", () => {
  const campos = ["ciphertext", "nonce", "tag", "dekEnvuelta"] as const;
  const posiciones: Array<[string, number, number]> = [
    ["primer byte, bit 0", 0, 0],
    ["byte central, bit 3", 5, 3],
    ["último byte, bit 7", -1, 7],
  ];

  for (const campo of campos) {
    it.each(posiciones)(
      `${campo}: ${"%s"} -> IntegridadError`,
      async (_nombre, byte, bit) => {
        const alterado = {
          ...sobre,
          [campo]: voltearBit(sobre[campo], byte, bit),
        } as Sobre;
        const error = await esperarFalla(
          () => descifrarSobre(unwrapper, ctxSol(), alterado),
          IntegridadError,
        );
        expect(error.reintentable).toBe(false);
      },
    );
  }

  it("el sobre original sigue descifrando (el bit-flip actuó sobre copias)", async () => {
    const secreto = await descifrarSobre(unwrapper, ctxSol(), sobre);
    expect(secreto.usar((v) => v)).toEqual(VALOR_SOL);
  });

  it("ciphertext con un byte de más -> IntegridadError", async () => {
    await esperarFalla(
      () =>
        descifrarSobre(unwrapper, ctxSol(), {
          ...sobre,
          ciphertext: Buffer.concat([sobre.ciphertext, Buffer.from([0])]),
        }),
      IntegridadError,
    );
  });
});

describe("CA-3 AAD: cualquier cambio de contexto falla con IntegridadError", () => {
  it("otro estudio (tenant)", async () => {
    await esperarFalla(
      () => descifrarSobre(unwrapper, ctxSol({ tenantId: TENANT_B }), sobre),
      IntegridadError,
    );
  });

  it("otro cliente (sobre copiado a otra fila de cliente)", async () => {
    await esperarFalla(
      () => descifrarSobre(unwrapper, ctxSol({ clienteId: CLIENTE_2 }), sobre),
      IntegridadError,
    );
  });

  it("otro tipo (sol descifrado como sire_api)", async () => {
    await esperarFalla(
      () => descifrarSobre(unwrapper, ctxSire(), sobre),
      IntegridadError,
    );
  });

  it("orden invertido: tenant con cliente intercambiados", async () => {
    const s = await cifrarCredencial(
      crearKeyWrapper(ENV_MOCK),
      ctxSol({ tenantId: TENANT_A, clienteId: CLIENTE_1 }),
      VALOR_SOL,
    );
    await esperarFalla(
      () =>
        descifrarSobre(
          unwrapper,
          ctxSol({ tenantId: CLIENTE_1, clienteId: TENANT_A }),
          s,
        ),
      IntegridadError,
    );
  });

  it("sobre sire_api descifrado como sol", async () => {
    const s = await cifrarCredencial(
      crearKeyWrapper(ENV_MOCK),
      ctxSire(),
      VALOR_SIRE,
    );
    await esperarFalla(
      () => descifrarSobre(unwrapper, ctxSol(), s),
      IntegridadError,
    );
  });

  it("el mismo contexto original sí descifra (control)", async () => {
    const secreto = await descifrarSobre(unwrapper, ctxSol(), sobre);
    expect(secreto.usar((v) => v)).toEqual(VALOR_SOL);
  });

  it("el contexto se compara por campo: UUID distinto en un solo carácter falla", async () => {
    const casi = TENANT_A.slice(0, -1) + (TENANT_A.endsWith("f") ? "e" : "f");
    await esperarFalla(
      () => descifrarSobre(unwrapper, ctxSol({ tenantId: casi }), sobre),
      IntegridadError,
    );
  });
});

describe("CA-3 contexto no canónico se rechaza al cifrar y al descifrar", () => {
  const malos: Array<[string, Record<string, string>]> = [
    ["tenant en mayúsculas", { tenantId: TENANT_A.toUpperCase() }],
    ["cliente en mayúsculas", { clienteId: CLIENTE_1.toUpperCase() }],
    ["tenant sin guiones", { tenantId: TENANT_A.replaceAll("-", "") }],
    ["cliente sin guiones", { clienteId: CLIENTE_1.replaceAll("-", "") }],
    ["tenant entre llaves", { tenantId: `{${TENANT_A}}` }],
    ["tenant con espacio final", { tenantId: `${TENANT_A} ` }],
    ["tenant vacío", { tenantId: "" }],
    ["tenant con |", { tenantId: `${TENANT_A}|${CLIENTE_1}` }],
    ["cliente con |", { clienteId: `${CLIENTE_1}|sol` }],
    ["cliente que no es UUID", { clienteId: "cliente-1" }],
  ];

  it.each(malos)(
    "cifrar: %s -> ContextoAadInvalidoError",
    async (_nombre, parcial) => {
      await esperarFalla(
        () =>
          cifrarCredencial(
            crearKeyWrapper(ENV_MOCK),
            ctxSol(parcial),
            VALOR_SOL,
          ),
        ContextoAadInvalidoError,
      );
    },
  );

  it.each(malos)(
    "descifrar: %s -> ContextoAadInvalidoError",
    async (_nombre, parcial) => {
      await esperarFalla(
        () => descifrarSobre(unwrapper, ctxSol(parcial), sobre),
        ContextoAadInvalidoError,
      );
    },
  );

  it.each(["otro", "SOL", "sol|x", "sol ", "", "sire"])(
    "tipo fuera del enum cerrado %j -> ContextoAadInvalidoError al cifrar y al descifrar",
    async (tipo) => {
      const ctx = ctxTipo(tipo as never);
      await esperarFalla(
        () =>
          cifrarCredencial(crearKeyWrapper(ENV_MOCK), ctx, VALOR_SOL as never),
        ContextoAadInvalidoError,
      );
      await esperarFalla(
        () => descifrarSobre(unwrapper, ctx as never, sobre),
        ContextoAadInvalidoError,
      );
    },
  );
});

describe("CA-3 el error de integridad no distingue la causa ni lleva texto parcial", () => {
  it("tag, AAD y DEK alterados dan el mismo mensaje y código", async () => {
    const porTag = await esperarFalla(
      () =>
        descifrarSobre(unwrapper, ctxSol(), {
          ...sobre,
          tag: voltearBit(sobre.tag, 0, 0),
        }),
      IntegridadError,
    );
    const porAad = await esperarFalla(
      () => descifrarSobre(unwrapper, ctxSol({ tenantId: TENANT_B }), sobre),
      IntegridadError,
    );
    const porDek = await esperarFalla(
      () =>
        descifrarSobre(unwrapper, ctxSol(), {
          ...sobre,
          dekEnvuelta: voltearBit(sobre.dekEnvuelta, 0, 0),
        }),
      IntegridadError,
    );
    expect(porAad.message).toBe(porTag.message);
    expect(porDek.message).toBe(porTag.message);
    expect(porAad.codigo).toBe(porTag.codigo);
    expect(porDek.codigo).toBe(porTag.codigo);
    expect(porTag.message).not.toContain(VALOR_SOL.usuario);
    expect(porTag.message).not.toContain(VALOR_SOL.clave);
  });
});
