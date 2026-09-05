# CLAUDE.md

Plugin de Obsidian que conecta el vault con Lumbre.

## Idioma

Identificadores en inglés. Comentarios, JSDoc, textos de interfaz, README y docs en castellano. Nunca
guiones largos como inciso: coma, punto o paréntesis.

## Gate

`npm run check` (lint + tests + `verify-release` + build). Si está en rojo, no se cierra nada.

## Reglas de dominio

- **Lumbre manda sobre la tarea, el vault manda sobre la nota.** El plugin PROYECTA tareas de Lumbre
  dentro de Obsidian, nunca las copia al Markdown. Si una tarea acaba escrita en una nota, hay dos
  fuentes de verdad y la que gana es la equivocada. Única excepción: el comando que pega el BRL de
  hoy, que es una FOTO FIJA pedida a mano y no se vuelve a tocar.
- **La IA propone y el usuario confirma.** El plan de Soplo se enseña con una casilla por acción y
  no se aplica nada sin el clic. Y solo se puede aplicar lo que se ha ENSEÑADO: una acción sin su
  línea de preview se descarta.
- **El token nunca entra en Markdown, frontmatter, logs ni Notices.** Solo se lee para construir la
  cabecera `Authorization`. Vive en `data.json` en todas las plataformas (decidido el 5 sep 2026, ver
  `src/token-store.ts`). En el registro lo garantiza `src/diagnostics/redact.ts`, por el que pasa
  TODO lo que se apunta; el contenido de una nota tampoco entra, y el título de una tarea solo en `debug` y recortado a 80.

## Estructura

- `src/main.ts`: la clase del plugin y el cableado. Es quien inyecta `requestUrl` en el cliente y
  quien engancha los eventos del vault.
- `src/lumbre/types.ts`: formas de datos y traducción desde el JSON de la API. Sin red.
- `src/lumbre/client.ts`: cliente HTTP. NO importa `obsidian`, recibe `request` por inyección.
- `src/lumbre/queue.ts`: cola durable de escrituras. Envía, hace flush y RELEE antes de dar nada por
  materializado, porque un 200 de la API solo significa "encolado".
- `src/blocks/query-parser.ts`: la consulta del bloque ```` ```lumbre ````. Parseo, resolución contra
  la nota y el catálogo de listas, clave de caché y filtro en cliente. Sin red.
- `src/blocks/query-cache.ts`: UNA entrada por consulta, TTL de 30 s y peticiones deduplicadas. Los
  bloques se suscriben; la cola la invalida al materializar.
- `src/blocks/task-block.ts`: el `MarkdownRenderChild` que pinta el bloque. No escribe en la nota.
- `src/blocks/brl-cache.ts` y `src/blocks/brl-block.ts`: la gemela de la caché y del bloque para el
  registro del día (```` ```lumbre-brl ````). Misma constante de TTL, clave por DÍA.
- `src/brl/brl-ops.ts`: el texto de una entrada con su marcador (`-` nota, `=` pensamiento), la
  relectura por id y el parseo del bloque. Sin red.
- `src/soplo/plan-to-ops.ts`: el plan de Soplo a ops de `POST /api/batch`, solo lo MARCADO. Las
  mutaciones viajan verbatim (`mutateRaw`): el payload lo escribió Lumbre y es lo que se aprobó.
- `src/review/weekly-snapshot.ts`: el texto de la foto semanal. FOTO FIJA de solo lectura, con la
  fecha en la cabecera, y sus líneas NUNCA son casillas de Markdown. Sin red propia.
- `src/attachments/upload.ts`: el tope de 25 MB, las cabeceras y el cuerpo de la subida. Sin red.
- `src/api/lumbre-api.ts`: la API PÚBLICA (`app.plugins.plugins.lumbre.api`), documentada en
  `docs/API.md`. Superficie pequeña y estable; todo lo que muta pasa por la cola.
- `src/links/link-store.ts`: mapa nota ↔ tarea. La nota se identifica por RUTA, nunca por un id
  escrito en el frontmatter.
- `src/diagnostics/`: el registro. `logger.ts` (niveles, `child(module)` y buffer circular de 1000
  eventos que se llena SIEMPRE, filtre lo que filtre la consola), `redact.ts` (el token fuera de
  todo), `errors.ts`, `report.ts` (el texto que se copia), `unhandled.ts` (`guarded`) y
  `log-files.ts`. Ninguno hace red; solo el modal importa `obsidian`.
- `src/storage/plugin-store.ts`: el único objeto de `data.json`, con las escrituras coalescidas.
- `src/settings.ts`: pestaña de ajustes.
- `src/token-store.ts`: almacén del token detrás de una interfaz.
- `scripts/verify-release.mjs`: coherencia de versión, tag sin prefijo `v` y assets publicados.
