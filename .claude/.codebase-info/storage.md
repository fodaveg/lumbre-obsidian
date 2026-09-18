# Almacenamiento: `data.json`

*Última actualización: 2026-09-18*

Único fichero de estado del plugin, gestionado por `PluginStore` (`src/storage/plugin-store.ts`)
sobre `Plugin.loadData/saveData`. Viaja por Obsidian Sync: casi todas las decisiones de este
módulo vienen de ahí.

## Forma (`PluginData`, `PLUGIN_DATA_VERSION = 7`)

| Campo | Tipo | Notas |
|---|---|---|
| `version` | `number` | 6 |
| `settings` | `LumbreSettings` | `apiOrigin`, `logLevel`, `liveLog`, `exportFolder`, `habitNames`, `foregroundLinkEnabled` |
| `token` | `string \| null` | el token personal; vive aquí en todas las plataformas (decisión del 5 sep 2026, `src/token-store.ts`) |
| `queue` | `QueuedOperation[]` | la cola durable, ya podada |
| `links` | `LumbreTaskLink[]` | nota ↔ tarea, con caché de la tarea, `syncState`, `orphanedAt`, `deepLink?` |
| `noteListLinks` | `NoteListLinkEntry[]` | nota ↔ lista, `id` = ruta, url exacta enviada |
| `deviceId` | `string \| null` | `null` cuando hay almacén local |

Historial: 1 objeto único → 2 `logLevel` + `liveLog` → 3 `noteListLinks` → 4 `deepLink` en
`links[]` → 5 `exportFolder` → 6 `habitNames`, los nombres de hábito guardados para «Registrar
hábito» → 7 `foregroundLinkEnabled`, el interruptor del empuje de la url de la nota activa
(por defecto `true`). El formato anterior a la 1 (sin `version`) se reconoce y migra conservando token y
origen. `migratedFrom` se apunta en el registro al arrancar.

## Migración (`migrate`)
Copia los ajustes enteros sobre `DEFAULT_SETTINGS` y solo corrige los que pueden venir mal
(`apiOrigin` por `normalizeOrigin`, `logLevel` dentro del enum, `exportFolder` validado). Así un
ajuste escrito por una versión más nueva desde otro dispositivo no se pierde. Detalle medido:
`exportFolder` se valida con `normalizeExportFolder` pero se guarda el valor crudo; por Ajustes sí
se guarda normalizado.

## Id de dispositivo
`DeviceIdStore` sobre `app.loadLocalStorage/saveLocalStorage` (clave `lumbre:device-id`,
`main.ts`), que NO sincroniza. Si esa API no existe, cae a `data.json`. Sin esto dos dispositivos
enviarían las mismas operaciones de la cola.

## Escrituras
- **Coalescing**: `save()` reutiliza el `pendingSave` en curso; espera un microtick, libera el
  hueco antes de escribir y encadena en `lastWrite` para que dos escrituras nunca se solapen.
  Tres `save()` seguidos = una escritura (`plugin-store.test.ts`).
- **Fusión con disco** (`merged`): `save()` relee `data.json` y une `queue`, `links` y
  `noteListLinks` por `id` ganando el `updatedAt` mayor. `settings` y `token` son de memoria (un
  token vacío gana: vaciarlo es una decisión). Tres `Set` de tombstones en memoria
  (`removedOperations`, `removedLinks`, `removedNoteListLinks`) impiden resucitar lo que este
  dispositivo quitó. Si no se puede releer, se escribe la memoria con un `warn`.
- **Puertos**: `QueueStorage`, `LinkStorage`, `NoteListLinkStorage` (`readX` síncrono desde
  memoria, `writeX` asíncrono). La cola escribe siempre podada (`pruneQueue`).

## Qué NO se guarda
- La tarea releída por la cola (solo `materializedAt`).
- El cursor del change-feed (memoria).
- Bytes de adjuntos (van directos a la API).
- Ningún contenido de nota salvo el `notes` pendiente de una operación `notes` mientras no se
  materializa.

## Token (`src/token-store.ts`)
`TokenStore { get, set }` con `PluginDataTokenStore` sobre el store; cadena vacía ↔ `null`.
`main.ts` envuelve el store (`watchedTokenStore`) para refrescar `secrets` del redactor en cada
cambio. Cambiar de almacén es cambiar esta clase.
