# Patrones y convenciones

*Última actualización: 2026-09-14*

## Organización

- Módulo puro + pieza de UI en la misma carpeta. El puro no importa `obsidian`; recibe el entorno
  por opciones (`request`, `now`, `sleep`, `register`, `exists`, `wait`, `app`).
- Las piezas de UI declaran su propia interfaz de host (`TaskBlockHost`, `BrlBlockHost`,
  `NoteTasksHost`, `LumbreSettingsHost`) para no importar `main.ts` y evitar ciclos. `main.ts`
  las cumple con métodos `xxxHost()`.
- `Pick<LumbreClient, ...>` en las opciones: cada consumidor declara exactamente qué métodos usa.

## Patrones recurrentes

| Patrón | Ejemplo canónico |
|---|---|
| Resultado uniforme `LumbreResult<T>` = `{ok:true,value}` \| `{ok:false,reason,status?}`; nunca lanzar desde el cliente | `src/lumbre/client.ts` |
| Ids fijados en cliente para idempotencia (`clientTaskId`, `entryId`) | `src/lumbre/queue.ts` |
| Enviar y RELEER antes de dar por hecho | `OperationQueue.confirm/reread` |
| Una petición en vuelo compartida (`inFlight`, `inFlightFlush`, `onceDrain`) | `QueryCache.load`, `LumbreClient.flush`, `queue.ts` |
| Coalescer ráfagas con un pestillo que se suelta ANTES de trabajar | `QueryCache.refreshSoon` (250 ms), `PluginStore.save` |
| Caché que conserva la última lectura buena y anota el error aparte | `QueryCache.fetch`, `BrlCache`, `ListCache.get` |
| Marcar huérfano y retirar tras una gracia, nunca al momento | `markDeleted` + `orphansPastGrace` |
| Guardar la cadena EXACTA enviada para poder retirarla | `NoteListLinkEntry.url`, `LumbreTaskLink.deepLink` |
| Ausente ≠ cero: campos opcionales cuando el servidor puede no traerlos | `rolloverCount?`, `attachmentCount?`, `updatedAt?` |
| Fotos fijas: texto pegado a mano, nunca casillas de Markdown | `insertBrlToday`, `weekly-snapshot.ts` (`- `, `plainTitle`) |
| Tests de forma que leen `src/` y prueban que no pasan en vacío | `src/dom-events.test.ts` |
| Un `Component` propio dentro de cada `Modal` para `registerDomEvent` | `brl-modal.ts`, `soplo-modal.ts`, `save-note-modal.ts`, `diagnostics-modal.ts` |
| Construir el DOM desenganchado y adjuntar al final | `note-tasks-view.ts` `renderProject`, `task-block.ts` con `DocumentFragment` |
| `window.setTimeout`/`window.setInterval`, nunca a secas (ventanas emergentes de Obsidian) | `queue.ts`, `query-cache.ts`, `main.ts` |

## Manejo de errores

- El cliente clasifica por status en `FailureReason`; la cola decide permanente vs recuperable
  (`PERMANENT_REASONS`) y trata el 429 como «falló el momento», sin gastar intento.
- `guarded(logger, acción, fn)` envuelve los callbacks que Obsidian invoca: apunta con contexto y
  NO relanza; también captura promesas para no duplicar el `unhandledrejection`.
- Excepción deliberada: `applySoploPlan` apunta y RELANZA para que el modal salga de «Aplicando…».
- Los errores de `window` se filtran por `plugin:lumbre` en el stack; los ajenos solo en `debug`.
- Los Notices llevan `describeFailure(reason, status)`, nunca el texto crudo del servidor salvo en
  `failedItems` de un lote (que es validación del servidor).
- Reintento manual con «Reintentar» (rejected o recoverable) y «Descartar» (`isStuck`).

## Diagnóstico y privacidad del registro

- `Logger.create({ secrets })` con `child(module)`; consola filtrada por nivel, buffer de 1000
  siempre; `redact` tapa secretos de 6+ caracteres y claves con sufijo `token`, `authorization`,
  `apikey`, `bearer`, `password`, `secret`.
- Qué NO entra en `info`: títulos de tarea (solo `debug` y `shortTitle` a 80), texto de BRL, texto
  de Soplo, contenido de nota, búsquedas del panel, cuerpo de un bloque mal escrito. Sí entran
  rutas de nota, ids, recuentos, longitudes y la consulta del bloque.
- Informe (`buildReport`): 300 eventos por defecto, cola con las 10 últimas, vínculos solo en
  recuento, y `stripSecrets` final. Modal: 100 eventos. Ficheros: 10 informes, live log de 1 MiB
  con una vuelta.

## Configuración y secretos

- Ajustes en `data.json` (`LumbreSettings`); token en `data.json` bajo `token`, solo accesible por
  `TokenStore`. Sin variables de entorno ni `.env` en runtime.
- Un ajuste inválido en la pestaña no se guarda (Notice + `warn`).
- Cambiar el token suelta el pestillo de lecturas y refresca `secrets` del redactor.

## Tests

- **Dónde:** junto al módulo, `x.test.ts`. 43 ficheros. `src/test/` solo tiene infraestructura.
- **Cómo corre:** `npm test` (`vitest run`). `obsidian` se resuelve por alias a
  `src/test/obsidian-mock.ts`; no hay `vi.mock('obsidian')`. `.claude/**` excluido (worktrees).
- **Mock de Obsidian:** mínimo. Clases vacías salvo `Plugin` (construible), `TFile`/`TFolder`
  (para `instanceof`) y `MarkdownRenderChild` (guarda `containerEl`). `Platform` mutable a `false`.
  `apiVersion = '1.11.4'`.
- **DOM:** `src/test/fake-dom.ts` (`createDiv/createSpan/createEl/empty/addClass/...`,
  `createFragment`, `findAll`, `installFakeGlobalDom`). Sin jsdom.
- **Red:** nunca se mockea `fetch`; se inyecta `request: LumbreRequestFn`. Helpers locales
  `clientWith`, `respondWith`, `recordingClient` en `client.test.ts`; `fakeClient()` con `vi.fn()`
  en `queue.test.ts`; `okClient()` en `query-cache.test.ts`.
- **Tiempo:** CERO fake timers. El reloj se inyecta (`now`) y se avanza reasignando una variable;
  `sleep`/`wait` inyectados; `deferred()` local para congelar una promesa a medias.
- **Factorías:** duplicadas por fichero a propósito (`task()`, `memoryStorage()`, `memoryHost()`
  con `writes`, `memoryAdapter()` con `files`), para que cada test se lea entero.
- **Nombres:** `describe('Sujeto: aspecto')`, `it('describe el comportamiento en castellano, con
  MAYÚSCULAS en el contraste que defiende y `backticks` en identificadores')`. Arrange / act /
  assert separados por línea en blanco. Imports explícitos de `vitest` aunque `globals` esté
  declarado. Constantes del módulo en las aserciones, no números mágicos.
- **Datos:** castellano y del dominio («Comprar pan», «Cocina.md»); token de ejemplo realista
  (`lum_tok_…`) para que la redacción lo cace.
- **Tests de forma:** `dom-events.test.ts` y `main.test.ts` (onunload tras onload fallido).
- **Huecos conocidos:** `splitSubtasks` (`send-modal.ts`) sin test; `uploadRequest` tiene test
  pero no lo usa producción; `buildWeeklySnapshot` solo lo usa su test.
