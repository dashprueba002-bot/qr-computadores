# Control de equipos HONOR · versión en la nube (v2)

App para registrar el ingreso y salida de computadores en portería.
Los datos se guardan en **Netlify Blobs**, el almacenamiento interno de Netlify.

## Qué hay en esta carpeta

| Archivo o carpeta | Para qué sirve |
|---|---|
| `public/` | La app que se ve en el celular (página, íconos, instalación). |
| `netlify/functions/api.mjs` | El servidor: valida usuarios y guarda los datos en Netlify Blobs. |
| `netlify.toml` | Le dice a Netlify dónde está cada cosa. |
| `package.json` | Lista la librería de Netlify Blobs que usa el servidor. |

## Antes de empezar

1. **Abre la versión actual en el celular de portería** (la que guarda en el teléfono), entra como administrador y descarga una **copia de seguridad** (Historial > Copia de seguridad). Es tu respaldo por si algo sale mal.
2. Ten a mano el acceso a tu cuenta de Netlify.

> Esta versión **no se puede publicar arrastrando la carpeta** en Netlify Drop: ese método no publica la parte del servidor. Usa la opción A o la B.

## Opción A (recomendada): GitHub + Netlify

1. Crea una cuenta en https://github.com (gratis) y un repositorio nuevo **privado**, por ejemplo `control-equipos-honor`.
2. En el repositorio, toca **Add file > Upload files** y arrastra **todo el contenido** de esta carpeta (las carpetas `public` y `netlify`, y los archivos `netlify.toml`, `package.json`, `.gitignore` y este `LEEME.md`). Toca **Commit changes**.
3. En Netlify, abre **tu sitio actual** (para conservar la misma dirección):
   **Site configuration > Build & deploy > Continuous deployment > Link repository**, elige GitHub y el repositorio.
   - Build command: déjalo **vacío**.
   - Publish directory: `public`
   - Functions directory: `netlify/functions`
4. Toca **Deploy**. En un par de minutos queda publicada.

Para actualizar después: sube los archivos nuevos al repositorio y Netlify publica solo.

## Opción B: Netlify CLI (línea de comandos)

Requiere Node.js instalado en un computador.

```
npm install
npm install -g netlify-cli
netlify login
netlify link      # elige tu sitio actual
netlify deploy --prod
```

## Primer ingreso

- Usuario: `1095841966` · Contraseña inicial: `123456`
- La app pide cambiarla. Hazlo de inmediato y guárdala en un lugar seguro: **no se puede recuperar**.
- Tras 5 intentos fallidos, el usuario se bloquea 15 minutos.

## Pasar los datos del celular a la nube

- **Si publicaste en la misma dirección:** abre la app en el celular de portería y entra como administrador. Aparece el aviso *"Este celular tiene X registros de la versión anterior"*. Toca **Subir a la nube**. Los equipos conservan su mismo código QR, así que no hay que reimprimir etiquetas.
- **Si cambió la dirección:** entra como administrador, ve a **Historial > Copia y migración > Subir copia a la nube** y elige la copia de seguridad que descargaste antes de empezar.

Los usuarios que ya existían en el celular se suben con su misma contraseña.

## Dónde ver los datos

En Netlify: tu sitio > **Blobs**. Están en estos almacenes: `equipos`, `movimientos`, `abiertos` (equipos dentro ahora), `usuarios` (contraseñas cifradas), `fotos` y `config`.

**No borres el almacén `config`**: guarda la clave que firma las sesiones. Si se borra, todos deben volver a iniciar sesión.

## Importante

- La app necesita **internet** para registrar. Si se cae la señal, usa la planilla manual y transcríbela después.
- Los datos personales (nombres, cédulas, teléfonos y fotos) quedan en servidores de Netlify. Actualiza la ficha del registro de iniciativas y confirma con TIC (Ley 1581 de 2012).
