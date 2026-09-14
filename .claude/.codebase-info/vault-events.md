# Eventos del vault

*Última actualización: 2026-09-14*

La nota se identifica por RUTA en los dos mapas (`LinkStore` nota ↔ tarea, `NoteListLinkStore`
nota ↔ lista). Por eso el plugin sigue los renombrados y trata los borrados con una gracia: sin
eso, un enlace se pierde o se retira de Lumbre por error. Los listeners viven en
`LumbrePlugin.onload` (`src/main.ts`) y van envueltos en `guarded(logger.child('vault'), ...)`.

## `vault.on('rename', (file, oldPath))`

Vale para ficheros y carpetas: `movedPath` (`src/links/link-store.ts`) y `movedNotePath`
(`src/links/note-list-link-store.ts`) casan ruta exacta o prefijo `oldPath/`.

Orden dentro del listener:

1. **Captura antes de mover**: `links.entriesUnder(oldPath)` filtrado por `deepLink !== undefined`.
   Obligatorio porque `LinkStore.renamePath` muta `notePath` en memoria de forma SÍNCRONA antes de
   su primer `await`; leer después ya vería la ruta nueva y no se podría reconstruir la url vieja.
2. `links.renamePath(oldPath, newPath)` → `notifyDataChange()` → si había deep links,
   `renameTaskLinks(entries, oldPath, newPath)`: actualiza `deepLink.url` en el store, cede el
   turno (`await Promise.resolve()`), y por cada cambio de `renameTaskLinkChanges` encola
   `taskLink unlink` (url vieja) y luego `taskLink link` (url nueva), saltando el `link` si un
   renombrado encadenado ya movió la nota otra vez.
3. `renameListLinks(oldPath, newPath)` → `applyRenameListLinks` (`note-list-link-store.ts`):
   mueve el registro local ANTES de encolar, cede el turno, relee y encola `unlink` viejo y `link`
   nuevo por entrada. El `unlink` se manda siempre (de más no rompe: 200 con `removed: false`).

Motivo del orden `unlink` → `link`: un servidor que procese en orden no ve dos urls activas a la
vez. Motivo de guardar la url exacta: el servidor compara byte a byte y un `unlink` con una url
recalculada de otra forma responde 200 sin quitar nada (fallo mudo).

## `vault.on('delete', file)`

Solo MARCA: `links.markDeleted(path)` y `noteListLinks.markDeleted(path)` ponen `orphanedAt`.
No encola ni borra nada. Obsidian Sync emite `delete` seguido de `create` en la MISMA ruta cuando
una nota vuelve de otro dispositivo; un `unlink` inmediato dejaría el frontmatter con
`lumbre-list` y Lumbre sin la nota.

## `vault.on('create', file)`

El gemelo: `links.markCreated(path)` y `noteListLinks.markCreated(path)` limpian `orphanedAt`.
Sin esto «La nota ya no existe» se quedaba para siempre tras un delete + create de Sync.

## Barridos con gracia (cada `QUEUE_DRAIN_INTERVAL_MS`, 60 s, y al arrancar)

| Barrido | Selector | Efecto |
|---|---|---|
| `sweepOrphanedNoteListLinks` | `orphansPastGrace(entries, now, exists)`: `orphanedAt` + `ORPHAN_GRACE_MS` (30 s) pasado Y la nota sigue sin existir | encola `listLink unlink` con la url guardada y borra la entrada |
| `sweepOrphanedTaskLinks` | `taskLinksPastGrace(links, now, exists)`: misma gracia (`TASK_LINK_ORPHAN_GRACE_MS`), solo vínculos con `deepLink` | encola `taskLink unlink` y vacía `deepLink` |
| `backfillTaskLinks` | vínculos `materialized` sin `deepLink` y con ruta | encola hasta 40 `taskLink link` por pasada (`TASK_LINK_BACKFILL_BATCH`, para no competir con el cubo de 60/min) |

`exists` lo cablea `main.ts` con `vault.getAbstractFileByPath(path) !== null`. `LinkStore.refresh`
también limpia `orphanedAt` si `exists` dice que la nota está.

## `workspace.on('editor-menu')`

Añade «Enviar a Lumbre» y «Soplo con la selección» al menú contextual del editor.

## Frontmatter

`src/links/note-list.ts`: `NOTE_LIST_PROPERTY = 'lumbre-list'`. `readNoteListId` lee de
`metadataCache`; `writeNoteListId` usa `fileManager.processFrontMatter`. Es la ÚNICA escritura
automática del plugin dentro de una nota. El panel escucha `metadataCache.on('changed')` para
recargar la lista si esa propiedad cambia.

## Deep links hacia la nota

`src/links/deep-link.ts`: `buildObsidianDeepLink(vaultName, notePath)` produce
`obsidian://open?vault=…&file=…` con `encodeURIComponent` (no `URLSearchParams`, que codifica el
espacio como `+` y Obsidian espera `%20`). `noteLinkLabel` recorta a `MAX_LABEL_LENGTH` (300).
Solo viaja la ruta, nunca el contenido de la nota.

## Tests relacionados

`src/links/link-store.test.ts`, `src/links/note-list-link-store.test.ts`, `src/links/deep-link.test.ts`.
`exists` se inyecta en los tests para simular la nota que vuelve.
