import { configure } from "@testing-library/react";

// T22a: con la máquina cargada (turbo corre muchos paquetes en paralelo) el `waitFor` por omisión de 1 s es frágil.
configure({ asyncUtilTimeout: 5000 });
