# Lumbre para Obsidian

Plugin de escritorio que conecta el vault de Obsidian con [Lumbre](https://lumbre.pro), el gestor de tareas.

## Qué hace

El plugin **proyecta** tareas de Lumbre dentro de Obsidian. Nunca las copia al Markdown: la tarea
vive en Lumbre y la nota es tuya.

**Tres comandos** (en la paleta salen con el prefijo «Lumbre:»):

| Comando | Qué hace |
| --- | --- |
| **Enviar como tarea** | Abre un formulario con el título ya puesto (la selección, o la línea del cursor sin su marcador de lista), lista, fecha o «Algún día», hora, prioridad, fecha límite, notas y subtareas. También está en el menú contextual del editor, como «Enviar a Lumbre». |
| **Vincular esta nota a una lista** | Escribe la propiedad `lumbre-list` en el frontmatter con el id de la lista elegida. |
| **Quitar el vínculo con la lista** | Borra esa propiedad. |

**Un panel lateral**, «Tareas de esta nota» (icono en la barra izquierda, o el comando **Abrir las
tareas de esta nota**). Sigue a la nota abierta y enseña:

- Las tareas de Lumbre vinculadas a esa nota, con checkbox para completarlas o reabrirlas, su lista y
  su fecha, botón para abrirlas en Lumbre y para desvincularlas.
- Un buscador para vincular una tarea que ya existe, por título o por nombre de lista.
- Si la nota tiene `lumbre-list`, todas las tareas de esa lista agrupadas por sección.

Completar una tarea no es inmediato: la escritura va por una cola durable y el chip dice «Enviando…»
hasta que Lumbre la confirma al releerla. Sin conexión, la cabecera lo dice y se sigue enseñando lo
último confirmado, nunca una caché disfrazada de dato fresco.

`lumbre-list` es **lo único** que el plugin escribe dentro de una nota, y solo cuando lo pides con
ese comando.

## Estado

Lo que falta (la API pública para Dataview y js-engine, y dónde se guarda el token) está en la lista
`lumbre-obsidian` de Lumbre. El detalle de lo construido, en `docs/ESTADO.md`.

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
