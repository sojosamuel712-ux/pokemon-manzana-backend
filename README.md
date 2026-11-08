# Pokémon Manzana — Backend

API Express, base SQLite, simulador de batallas, sprites y animaciones. El frontend se mantiene en el repositorio público [pokemon-manzana](https://github.com/sojosamuel712-ux/pokemon-manzana).

## Recursos y dependencias

`models/` contiene unos 6.003 GIF (aprox. 535 MB) y se versiona con Git LFS. `public/sprites/` contiene los sprites servidos en `/sprites`. Para clonar con los recursos completos:

```bash
git lfs install
git lfs pull
npm ci
```

El backend tiene copias propias de los catálogos que necesita en `data/`; no importa archivos del repositorio frontend. `MODEL_DIRECTORY` y `SPRITE_DIRECTORY` permiten cambiar las rutas de recursos; por defecto se usan `models/` y `public/sprites/`.

## Desarrollo local

```bash
npm ci
JWT_SECRET=una-clave-solo-local npm start
```

La API escucha en `http://localhost:3000`. La interfaz Vite reenvía `/api`, `/models` y `/sprites` a ese servidor. Para crear el primer administrador usa una base vacía y ejecuta `npm run admin:create -- NombreAdmin`; el comando solicita la contraseña de forma interactiva.

## Despliegue

El servicio necesita Node.js 22, un proceso Node persistente y almacenamiento persistente para SQLite. Incluye los objetos Git LFS reales al instalar/desplegar. Configura:

- `NODE_ENV=production`
- `PORT`: puerto asignado por el proveedor.
- `JWT_SECRET`: secreto aleatorio de al menos 32 caracteres.
- `DATABASE_PATH`: ruta absoluta dentro de un volumen persistente, por ejemplo `/var/data/manzana.sqlite`.
- `CORS_ORIGIN`: origen exacto de la interfaz Netlify, por ejemplo `https://mi-sitio.netlify.app`.
- `TRUST_PROXY_HOPS`: número exacto de proxies confiables; usa `0` si no hay ninguno.
- `MODEL_DIRECTORY` y `SPRITE_DIRECTORY`: opcionales, solo si los recursos están en rutas distintas a las predeterminadas.

Antes de habilitar el registro público, crea y prueba el primer administrador sobre la misma base persistente:

```bash
npm run admin:create -- NombreAdmin
npm start
```

Comprueba `GET /api/health`. El backend no sirve la interfaz web; Netlify sirve el build estático y la variable `VITE_API_BASE_URL` del frontend apunta a este servicio. Usa HTTPS, configura CORS para los orígenes previstos y respalda periódicamente el volumen SQLite. No escales varias instancias escribiendo a la misma base SQLite.

## Pruebas

```bash
npm test
```

GitHub Actions ejecuta las pruebas con LFS desactivado; la aplicación de producción requiere los objetos LFS completos.

## Recursos de terceros

Consulta [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) para el software y medios. Según lo reportado por el responsable, los sprites de `models/` y `public/sprites/` proceden de Pokémon Showdown. La licencia MIT del simulador no transfiere derechos sobre marcas Pokémon.
