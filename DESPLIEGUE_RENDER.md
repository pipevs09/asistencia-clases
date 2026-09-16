# Publicar el registro de asistencia con Render

El programa está preparado para un servicio web de Render con HTTPS y un disco persistente. La consulta de clases, calendarios, resúmenes y Excel seguirá siendo pública, como se decidió. Crear o cambiar datos exige iniciar sesión según los permisos actuales.

## 1. Conectar el código

[Render obtiene el código](https://render.com/docs/web-services#deploy-your-own-code) desde un repositorio Git conectado, una URL de repositorio público o una imagen Docker. Como todavía no tienes GitHub, la vía más sencilla es crear una cuenta de GitHub y un **repositorio privado** llamado, por ejemplo, `asistencia-clases`. También sirve GitLab o Bitbucket si prefieres uno de ellos.

Esta carpeta ya tiene `render.yaml` y `.gitignore`. El archivo `asistencia.db` y los respaldos no deben subirse al repositorio: contienen los registros y los resúmenes de contraseñas. El repositorio debe contener `server.py`, `xlsx_export.py`, `backup_database.py`, la carpeta `static`, `render.yaml`, `.gitignore` y la documentación.

Después de crear el repositorio privado, abre una terminal en esta carpeta. Configura tu identidad de Git en este repositorio y sube el código, reemplazando los ejemplos por tus datos y por la URL que GitHub te muestre:

```powershell
git config user.name "Tu nombre"
git config user.email "tu-correo@ejemplo.cl"
git add .
git status --short
git commit -m "Preparar registro de asistencia para Render"
git remote add origin https://github.com/TU_USUARIO/asistencia-clases.git
git push -u origin main
```

Antes del `git commit`, confirma con `git status --short` que **no aparece `asistencia.db`**. Si prefieres, podemos hacer juntos la conexión y el envío cuando tengas la cuenta.

## 2. Crear el servicio

En Render, conecta GitHub desde **Account Settings → Git Deployment Credentials**. Luego crea un **Blueprint** usando el repositorio privado. Render leerá `render.yaml` y propondrá un servicio Python de pago con un disco de 1 GB montado en `/var/data`. Revisa el plan y su costo antes de crearlo; [el plan gratuito no admite disco persistente](https://render.com/docs/disks#setup).

El servicio se inicia en **Maintenance Mode**, así que la página aún no será visible desde internet mientras trasladamos la base. Render asignará una dirección `https://...onrender.com`, gestionará el certificado HTTPS y dirigirá las solicitudes al puerto que el programa lee de `PORT`. El servidor comprueba que `/var/data` sea realmente un disco montado; si no lo es, se detiene para evitar guardar datos en un sistema temporal.

## 3. Llevar los registros que ya tienes

Hay una copia consistente en `../respaldo_asistencia_para_render.db`. Si sigues usando el programa antes de trasladarlo, genera **una copia nueva** justo antes del envío:

```powershell
python backup_database.py ..\respaldo_asistencia_nuevo.db
python server.py --status-db
```

Para trasladar el archivo, abre **Shell** del servicio de pago en Render. Una opción sencilla es [Magic Wormhole](https://render.com/docs/disks#transferring-files): instálalo en tu computador con `python -m pip install magic-wormhole`. Desde esta carpeta, ejecuta `wormhole send ..\respaldo_asistencia_para_render.db` (o el nombre de la copia más reciente). En Render Shell, ejecuta `wormhole receive`, introduce el código temporal que Wormhole mostró en tu computador y mueve el archivo recibido al disco:

```bash
mv respaldo_asistencia_para_render.db /var/data/import.db
python server.py --import-db /var/data/import.db
python server.py --status-db
```

Si enviaste un archivo con otro nombre, úsalo en el comando `mv`. El programa **se niega a importar sobre una base que ya tenga estudiantes, ramos, clases o administrador**, para evitar borrar datos. La importación conserva la información y las contraseñas, pero cierra las sesiones anteriores. Comprueba que los conteos de `--status-db` coincidan con los de tu computador. El archivo `/var/data/import.db` es una copia adicional y puedes eliminarlo después de comprobar la importación.

Si decides comenzar con una base vacía en lugar de trasladar la actual, configura el administrador desde Render Shell con `python server.py --setup-admin`. La página pública no permite que un visitante se apropie de la cuenta inicial.

## 4. Abrir la página y añadir dominio

Cuando el servicio funcione y los datos estén verificados, desactiva **Maintenance Mode** en Render **Settings**. Para que una futura sincronización del Blueprint no lo reactive, cambia `maintenanceMode.enabled` a `false` en `render.yaml`, sube ese cambio y sincroniza el Blueprint.

Primero prueba la dirección `onrender.com` en tu computador y en un celular. Para usar un dominio comprado en nic.cl, añádelo en **Render → Settings → Custom Domains**, copia a nic.cl los registros DNS que Render indique y verifica el dominio en Render. [Render emite y renueva el certificado HTTPS](https://render.com/docs/custom-domains) y redirige HTTP a HTTPS.

El disco conserva `asistencia.db` entre reinicios y despliegues. Para tener un respaldo independiente del servidor, genera periódicamente copias con `backup_database.py` desde Render Shell y descárgalas a tu computador. El Excel descargable es una exportación para consulta, no reemplaza la base SQLite.
