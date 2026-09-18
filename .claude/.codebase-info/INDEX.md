# Mapa del código: lumbre-obsidian

*Última actualización: 2026-09-18*

Plugin de Obsidian (escritorio y móvil) que PROYECTA tareas de Lumbre dentro del vault sin
copiarlas al Markdown. Toda escritura hacia Lumbre pasa por una cola durable que envía y RELEE
antes de dar nada por hecho. Este mapa no repite la sección «Estructura» de `CLAUDE.md`; la
complementa con flujos, entradas, eventos y convenciones.

**Stack:** TypeScript estricto · API de Obsidian 1.13 (min 1.11.4) · esbuild (CJS) · Vitest · ESLint
con `eslint-plugin-obsidianmd`
**Forma:** un solo bundle `main.js`; `src/main.ts` cablea módulos puros (sin `obsidian`) con una
capa fina de UI que sí importa `obsidian`

## Documentos

| Documento | Qué contiene |
|-----------|--------------|
| [architecture.md](./architecture.md) | Piezas, fronteras, quién habla con quién, decisiones duras |
| [entry-points.md](./entry-points.md) | Comandos, bloques de código, vista lateral, temporizadores, API pública |
| [queue-flow.md](./queue-flow.md) | La cola de mutaciones: kinds, estados, envío, relectura, `outcome`, poda |
| [vault-events.md](./vault-events.md) | Eventos del vault (rename, delete, create) y los barridos con gracia |
| [modules.md](./modules.md) | Módulos por carpeta de `src/`: exports, dependencias, quién los consume |
| [communication.md](./communication.md) | Endpoints de Lumbre, cupos por endpoint, pestillo de lecturas, eventos internos |
| [storage.md](./storage.md) | `data.json`: forma, versiones, fusión con disco, token, id de dispositivo |
| [tech-landscape.md](./tech-landscape.md) | Toolchain, build, CI, release por BRAT |
| [directory-structure.md](./directory-structure.md) | Árbol anotado |
| [patterns.md](./patterns.md) | Patrones recurrentes, errores, diagnóstico, convenciones de tests |
| [coding-style.md](./coding-style.md) | Lint, tsconfig, formato, nombres |
| [onboarding.md](./onboarding.md) | Arranque, comandos, tareas frecuentes, trampas |

## Cómo usar este mapa

- Nuevo aquí: `onboarding.md`, luego `architecture.md` y `queue-flow.md`.
- Antes de tocar una escritura hacia Lumbre: `queue-flow.md` y `communication.md` (cupos).
- Antes de tocar rutas de notas o vínculos: `vault-events.md`.
- Las rutas son reales; úsalas para saltar al código.

## Mantener el mapa al día

Tras un cambio de arquitectura, estructura, dependencias, modelo de `data.json`, entradas, API o
convenciones, refresca los documentos afectados con `/codebase-mapper:update-codebase-map`.
Un cambio interno pequeño no lo necesita.
