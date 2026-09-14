# Estructura de directorios

*Última actualización: 2026-09-14*

Principio organizador: por dominio dentro de `src/`, con el módulo puro y su UI en la misma
carpeta y el test al lado (`x.test.ts`). 22 420 líneas en `src/` (43 ficheros de test).

```
lumbre-obsidian/
├── src/
│   ├── main.ts                 # LumbrePlugin: construcción, comandos, eventos, temporizadores, flujos
│   ├── settings.ts             # pestaña de ajustes (origen, token, carpeta de exportación, diagnóstico)
│   ├── token-store.ts          # TokenStore sobre data.json
│   ├── dom-events.test.ts      # test de FORMA: ningún addEventListener a pelo en src/
│   ├── lumbre/                 # dominio de Lumbre, sin obsidian
│   │   ├── client.ts           # HTTP, cupos por endpoint, pestillo de lecturas
│   │   ├── queue.ts            # cola durable (7 kinds)
│   │   ├── queue-drain.ts      # drenaje periódico
│   │   ├── change-feed.ts      # sondeo updatedSince
│   │   ├── list-cache.ts       # listas, TTL 5 min
│   │   └── types.ts            # LumbreTask, LumbreList, TaskDraft y traducciones
│   ├── blocks/                 # bloques ```lumbre``` y ```lumbre-brl``` con sus cachés y parser
│   ├── links/                  # nota ↔ tarea, nota ↔ lista, frontmatter lumbre-list, deep links
│   ├── ui/                     # panel lateral, modal de envío, helpers puros de UI
│   ├── soplo/                  # plan del agente → ops de batch, modal
│   ├── brl/                    # entradas del registro del día, modal
│   ├── notes/                  # foto de la nota en la tarea
│   ├── review/                 # foto semanal
│   ├── attachments/            # subida de ficheros (directa, sin cola)
│   ├── export/                 # nombre del fichero de exportación
│   ├── api/                    # API pública app.plugins.plugins.lumbre.api
│   ├── diagnostics/            # logger, redacción, informe, ficheros de log, modal
│   ├── storage/                # PluginStore (data.json)
│   └── test/                   # obsidian-mock.ts (alias), fake-dom.ts
├── docs/
│   ├── ESTADO.md               # qué hay y por qué, por lotes; fuente de las decisiones
│   └── API.md                  # contrato de la API pública
├── scripts/
│   ├── verify-release.mjs      # coherencia de versión, tag sin v, assets publicados
│   └── install-dev.mjs         # copia main.js, manifest.json, styles.css al vault
├── .github/workflows/          # ci.yml (gate), release.yml (tag → release con 3 assets)
├── manifest.json · versions.json · styles.css   # assets del plugin
├── esbuild.config.mjs · version-bump.mjs · vitest.config.mts · eslint.config.mjs · tsconfig.json
├── CLAUDE.md                   # reglas del repo (idioma, gate, dominio, estructura)
└── README.md                   # manual de usuario
```

Fuera del control de versiones: `main.js` (generado), `node_modules/`, `/.claude/` (ignorado
entero por `.gitignore`, incluido este mapa).
