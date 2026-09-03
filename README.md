# Lumbre para Obsidian

Plugin de escritorio que conecta el vault de Obsidian con [Lumbre](https://lumbre.pro), el gestor de tareas.

## Estado

Base sin funciones de producto. Lo que hay: el esqueleto del plugin, una pestaña de ajustes con
origen y token personal, un botón de prueba de conexión, un cliente HTTP mínimo con tests, el gate de
CI y el pipeline de publicación para BRAT. Lo que falta está en la lista `lumbre-obsidian` de Lumbre.

## Instalación por BRAT

El repositorio es público, así que BRAT no necesita ningún token:

1. Instala el plugin **BRAT** desde la tienda de plugins de Obsidian.
2. Ejecuta **Add beta plugin** y escribe `fodaveg/lumbre-obsidian`.

BRAT descarga los tres ficheros de la última release (`main.js`, `manifest.json`, `styles.css`) y
actualiza el plugin cuando salga una versión nueva.

Después, en los ajustes de Lumbre dentro de Obsidian: pon el origen (por defecto
`https://app.lumbre.pro`), pega tu token personal de Lumbre y pulsa **Probar conexión**.

## Desarrollo

```sh
npm install
npm run dev          # esbuild en modo watch
npm run check        # el gate: lint + tests + verify-release + build
OBSIDIAN_VAULT=/ruta/al/vault npm run install:dev   # copia main.js, manifest.json y styles.css
```

`npm run check` es el gate. Si está en rojo, no se publica.

## Cómo se publica

```sh
npm version patch    # o minor
git push --follow-tags
```

`npm version` dispara `version-bump.mjs`, que sincroniza `manifest.json` y `versions.json`, y crea el
tag **sin prefijo `v`** (lo fija `.npmrc` con `tag-version-prefix=""`). Ese detalle no es cosmético: BRAT y el instalador de Obsidian buscan la
release cuyo tag es exactamente `manifest.version`, y `scripts/verify-release.mjs --tag` falla si
alguien publica `v0.1.0`.


Al llegar el tag, `.github/workflows/release.yml` pasa el gate, comprueba el tag contra el manifest,
crea la release con los tres assets sueltos y vuelve a comprobarla contra lo que GitHub tiene
publicado de verdad.

## De dónde sale el diseño

- Audit `2026-09-03 - Plugin Obsidian-Lumbre - viabilidad e ideas de funciones`, en el vault de
  Obsidian (`21.11 Lumbre` / `40 Audits y revisiones`).
- Lista `lumbre-obsidian` de Lumbre, que lleva las tareas pendientes.

## Licencia

MIT.
