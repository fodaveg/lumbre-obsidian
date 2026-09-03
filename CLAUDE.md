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

- `src/main.ts`: la clase del plugin y el cableado. Es quien inyecta `requestUrl` en el cliente.
- `src/lumbre/client.ts`: cliente HTTP. NO importa `obsidian`, recibe `request` por inyección.
- `src/settings.ts`: pestaña de ajustes.
- `src/token-store.ts`: almacén del token detrás de una interfaz.
- `scripts/verify-release.mjs`: coherencia de versión, tag sin prefijo `v` y assets publicados.
