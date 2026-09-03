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
  fuentes de verdad y la que gana es la equivocada.
- **El token nunca entra en Markdown, frontmatter, logs ni Notices.** Solo se lee para construir la
  cabecera `Authorization`. Dónde se guarda es una decisión abierta (ver `src/token-store.ts`).

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
- `src/api/lumbre-api.ts`: la API PÚBLICA (`app.plugins.plugins.lumbre.api`), documentada en
  `docs/API.md`. Superficie pequeña y estable; todo lo que muta pasa por la cola.
- `src/links/link-store.ts`: mapa nota ↔ tarea. La nota se identifica por RUTA, nunca por un id
  escrito en el frontmatter.
- `src/storage/plugin-store.ts`: el único objeto de `data.json`, con las escrituras coalescidas.
- `src/settings.ts`: pestaña de ajustes.
- `src/token-store.ts`: almacén del token detrás de una interfaz.
- `scripts/verify-release.mjs`: coherencia de versión, tag sin prefijo `v` y assets publicados.
