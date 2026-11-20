# Acceso privado — Drum Studio 5.9 Beta 1

Este directorio contiene la primera base del servicio de acceso privado. Es un **andamiaje técnico**: no está desplegado ni conectado a cuentas reales. La página actual y los archivos del simulador no se han modificado.

## Alcance comercial definido

- Producto: Drum Studio 5.9 — Beta 1.
- Precio: **$4.900 COP** (490.000 centavos).
- Modalidad: pago único.
- Actualizaciones futuras: no incluidas.
- La demo pública permanece gratuita.

El importe se fija en el servidor. El navegador no puede enviar otro valor para alterar el precio.

## Arquitectura

- **Cloudflare Worker:** crea órdenes, genera la firma de integridad de Wompi, recibe eventos, comprueba el estado de la transacción y sirve el HTML únicamente tras validar una compra.
- **Cloudflare D1:** registra referencia, correo, estado, identificador de transacción y hash del token de acceso.
- **Cloudflare R2 privado:** guarda el HTML completo. No se debe habilitar un dominio público para el bucket.
- **Wompi Web Checkout:** checkout por transacción con referencia única. Se usa el Web Checkout porque permite firmar cada referencia desde el servidor; no es un enlace estático reutilizable.

El Worker calcula el checksum usando todas las propiedades que Wompi incluya, respetando su orden, y consulta la transacción desde el servidor para confirmar referencia, monto, moneda y estado. Solo ese evento validado puede marcar la compra como pagada. La redirección del navegador es informativa y nunca habilita por sí sola el simulador. Los secretos se guardan en Cloudflare, nunca en el HTML ni en Git.

## Rutas del Worker

`GET /health` ejecuta una consulta de lectura sobre D1, una operación de lista sobre el bucket R2 y un `head()` del objeto `drum-studio-beta1-full.html` para verificar que el simulador completo ya está presente en almacenamiento privado. Informa el tamaño del objeto sin exponer su contenido.

| Ruta | Uso |
| --- | --- |
| `GET /health` | Comprobar disponibilidad |
| `POST /api/checkout` | Crear orden, referencia, token de acceso y URL de checkout |
| `POST /api/wompi/events` | Recibir y verificar `transaction.updated` |
| `POST /api/content` | Entregar el HTML desde R2 solo si el pago está aprobado |

El endpoint de checkout devuelve un token aleatorio de un solo comprador. El ejemplo `checkout-client-example.js` lo guarda en `sessionStorage` antes de redirigir a Wompi; la pestaña debe permanecer abierta para recuperar el token al regresar. No se pone en la URL ni se envía a servicios de analítica. La página `pago-beta1.html` está preparada como retorno visual, pero debe configurarse con la URL real del Worker antes de poder usarse.

## Configuración — solo con la persona adulta responsable

La cuenta de Cloudflare, la cuenta comercial de Wompi, la aceptación de sus condiciones y las credenciales de producción deben gestionarse por una persona adulta responsable o la entidad propietaria del proyecto. No compartas contraseñas, documentos ni secretos en el chat.

### 1. Crear recursos

Desde esta carpeta:

```bash
cd cloudflare/worker
npx wrangler d1 create ingenialab-beta1-db
npx wrangler r2 bucket create ingenialab-beta1-private
```

Copia el identificador real que devuelve D1 en `database_id` dentro de `wrangler.toml`. Conserva el bucket R2 privado y no habilites acceso público.

### 2. Instalar el esquema D1

```bash
npx wrangler d1 migrations apply ingenialab-beta1-db --remote
```

La migración crea la tabla `purchases`.

### 3. Cargar el archivo completo en R2

El archivo que se suba debe ser la copia íntegra aprobada del simulador original. No uses la demo como sustituto. La clave esperada en R2 es:

```
drum-studio-beta1-full.html
```

Ejemplo de carga desde un archivo local ya descargado y verificado:

```bash
npx wrangler r2 object put ingenialab-beta1-private/drum-studio-beta1-full.html --file="./drum-studio-beta1-full.html" --content-type="text/html"
```

No publiques el bucket ni guardes una copia del simulador completo en esta carpeta.

### 4. Configurar secretos

Crea secretos directamente en Cloudflare Wrangler. No escribas sus valores en este archivo, en GitHub ni en el chat.

```bash
npx wrangler secret put WOMPI_INTEGRITY_SECRET
npx wrangler secret put WOMPI_EVENTS_SECRET
npx wrangler secret put WOMPI_PRIVATE_KEY
npx wrangler secret put ACCESS_TOKEN_PEPPER
```

- `WOMPI_INTEGRITY_SECRET`: secreto de integridad de Wompi.
- `WOMPI_EVENTS_SECRET`: secreto de eventos/webhooks de Wompi; es distinto del secreto de integridad y de la llave privada.
- `WOMPI_PRIVATE_KEY`: llave privada `prv_test_` del ambiente de pruebas; el Worker la usa exclusivamente en el servidor para consultar transacciones. Nunca se expone al navegador.
- `ACCESS_TOKEN_PEPPER`: cadena aleatoria propia del servicio, larga y exclusiva.

La llave pública de Wompi (`WOMPI_PUBLIC_KEY`) es una variable de texto no secreta y debe configurarse desde **Settings → Variables and Secrets** con la llave `pub_test_` del ambiente Sandbox. `keep_vars = true` conserva las variables añadidas desde el panel durante los siguientes despliegues. El secreto de integridad y la llave privada de Wompi nunca se exponen al navegador.

### 5. Configurar y desplegar en pruebas

En `wrangler.toml`:
- Sustituye el ID de D1 por el real.
- Confirma el nombre del bucket R2.
- Usa una llave pública `pub_test_`.
- Mantén `WOMPI_ENV = "test"`.
- `PUBLIC_RETURN_URL` debe apuntar a la futura página de respuesta de pago, que se agregará al sitio público en una segunda etapa.

Luego:

```bash
npx wrangler deploy
```

Prueba la ruta `/health`. No habilites pagos reales aún.

### 6. Configurar eventos en Wompi Sandbox

En el Dashboard de comercios de pruebas, la persona responsable debe registrar como URL de eventos:

```
https://<nombre-del-worker>.<cuenta>.workers.dev/api/wompi/events
```

Activa el evento `transaction.updated` y usa el secreto de eventos correspondiente al ambiente de pruebas. La documentación de Wompi indica que los ambientes de pruebas y producción deben tener URL de eventos separadas.

## Integración pendiente con la página

La plantilla pública de retorno (`pago-beta1.html`) y el ejemplo de botón (`checkout-client-example.js`) ya están preparados en esta rama, pero aún no están conectados al sitio publicado. El token temporal se conserva en `sessionStorage` de la misma pestaña; por eso el comprador debe regresar al sitio en esa misma pestaña. La página de retorno consulta el estado almacenado por el webhook y permite reintentar la comprobación mientras Wompi notifica el resultado. No se agrega el botón al `index.html` hasta que:
1. El Worker esté desplegado y responda.
2. D1 esté creado y migrado.
3. El bucket privado contenga el archivo completo correcto.
4. El webhook haya sido probado en Sandbox.
5. La página de retorno pueda recuperar el token del comprador y solicitar el contenido.

Después se conectará el botón **Acceso completo Beta 1 — $4.900 COP** sin cambiar el código interno del simulador.

## Aviso importante sobre la publicación anterior

El archivo completo estuvo alojado en un repositorio público. Moverlo a R2 y retirarlo de la rama actual reducirá su exposición futura, pero no puede deshacer copias que otras personas hayan descargado ni garantizar que no existan copias en el historial, cachés o forks públicos. Por ello, este control de acceso es una barrera técnica para nuevas compras, no una protección retroactiva ni DRM absoluto.

## Referencias técnicas

- Wompi — [Widget y Web Checkout](https://docs.wompi.co/docs/colombia/widget-checkout-web/)
- Wompi — [Eventos y validación del checksum](https://docs.wompi.co/docs/colombia/eventos/)
- Cloudflare — [R2 con Workers](https://developers.cloudflare.com/r2/api/workers/workers-api/)
- Cloudflare — [Migraciones D1](https://developers.cloudflare.com/d1/reference/migrations/)


## Ajustes de Cloudflare Workers Builds

El Worker está conectado al repositorio de GitHub. En **Settings → Builds** del proyecto `ingenialab-beta1-access`, utiliza:
- Production branch: `beta1-private-access`
- Root directory: `/cloudflare/worker`
- Build command: vacío / None
- Deploy command: `npx wrangler deploy`
- Preview command: predeterminado

Como la raíz del build ya es `/cloudflare/worker`, Wrangler encuentra el archivo `wrangler.toml` directamente en esa carpeta. No agregues `--config cloudflare/worker/wrangler.toml` al comando de despliegue, porque esa ruta se resolvería dos veces.

Un commit nuevo en la rama de producción configurada inicia el siguiente build. El fallo inicial ocurrió cuando Cloudflare ejecutó Wrangler desde la raíz del repositorio apuntando a una ruta de configuración incorrecta; no repitas ese intento antiguo de `main`.
