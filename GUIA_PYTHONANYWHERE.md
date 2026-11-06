# Publicar en PythonAnywhere gratis

## 1. Subir y descomprimir

1. En PythonAnywhere, abre **Files**.
2. En `/home/TU_USUARIO/`, sube `asistencia_clases_pythonanywhere.zip`.
3. Abre **Consoles > Bash** y ejecuta:

```bash
cd ~
unzip asistencia_clases_pythonanywhere.zip
```

## 2. Crear la aplicación web

1. Abre **Web** y pulsa **Add a new web app**.
2. Acepta el dominio gratuito `TU_USUARIO.pythonanywhere.com`.
3. Elige **Manual configuration** y la versión de Python más reciente disponible.
4. En la sección **Code**, abre el enlace del archivo WSGI.
5. Borra su contenido y pega lo siguiente, reemplazando `TU_USUARIO`:

```python
import sys

project_home = "/home/TU_USUARIO/asistencia_clases"
if project_home not in sys.path:
    sys.path.insert(0, project_home)

from pythonanywhere_wsgi import application
```

6. Guarda el archivo.

Las notificaciones requieren tres líneas adicionales. Se agregan más adelante,
después de generar sus claves; no escribas esas claves dentro del repositorio.

## 3. Configurar el administrador

En una consola Bash ejecuta:

```bash
cd ~/asistencia_clases
python3 pythonanywhere_manage.py --reset-admin
```

Escribe dos veces la contraseña del administrador. Los caracteres no se muestran mientras escribes; es normal. Este paso conserva estudiantes, ramos, clases y asistencias, y cierra las sesiones antiguas.

## 4. Encender la página

Regresa a **Web** y pulsa el botón verde **Reload**. Después abre:

`https://TU_USUARIO.pythonanywhere.com`

## Herramientas posteriores

Restablecer la contraseña del administrador:

```bash
cd ~/asistencia_clases
python3 pythonanywhere_manage.py --reset-admin
```

Comprobar la base de datos:

```bash
cd ~/asistencia_clases
python3 pythonanywhere_manage.py --status-db
```

La base se guarda en `~/asistencia_clases/data/asistencia.db`, dentro del almacenamiento persistente de la cuenta.

## Activar las notificaciones del teléfono

Los avisos se envían 15 minutos antes de una clase, 30 minutos antes de una
presentación y 60 minutos antes de una prueba. Solo se pueden programar eventos
que tengan una hora asignada.

### 1. Generar las claves

Antes de subir la actualización, abre PowerShell dentro de la carpeta local del
proyecto y ejecuta:

```powershell
node scripts/generate_notification_keys.mjs
```

Guarda los tres valores que aparecen. Son secretos de la aplicación y no deben
publicarse ni subirse a GitHub.

### 2. Configurar PythonAnywhere

En **Web**, abre el archivo WSGI y agrega estas líneas antes de importar
`pythonanywhere_wsgi`, reemplazando los valores de ejemplo:

```python
import os

os.environ["ASISTENCIA_VAPID_PUBLIC_KEY"] = "VALOR_GENERADO"
os.environ["ASISTENCIA_NOTIFICATION_SECRET"] = "VALOR_GENERADO"
```

Pulsa **Reload** para aplicar el cambio.

### 3. Configurar GitHub

En el repositorio abre **Settings > Secrets and variables > Actions**, pulsa
**New repository secret** y crea:

- `APP_URL`: la dirección completa de la página, por ejemplo
  `https://TU_USUARIO.pythonanywhere.com`.
- `NOTIFICATION_SECRET`: el mismo valor de
  `ASISTENCIA_NOTIFICATION_SECRET` configurado en PythonAnywhere.
- `VAPID_PUBLIC_KEY`: el valor de `ASISTENCIA_VAPID_PUBLIC_KEY`.
- `VAPID_PRIVATE_KEY`: la clave privada generada.
- `VAPID_SUBJECT`: un correo de contacto con el formato
  `mailto:correo@ejemplo.com`.

Después abre **Actions > Enviar recordatorios** y ejecuta **Run workflow** una
vez para comprobarlo. Luego GitHub revisará automáticamente los avisos
pendientes cada cinco minutos.

### 4. Activarlas en cada teléfono

Cada estudiante debe iniciar sesión, abrir **Personalización** desde su perfil y
pulsar **Activar notificaciones**. En iPhone la página debe estar instalada en
la pantalla de inicio y abrirse desde su icono para poder conceder el permiso.

## Publicar el APK para descargarlo desde la página

El flujo **Crear APK Android** genera un archivo llamado
`Registro_de_Asistencia.apk`. Descárgalo desde los artefactos de GitHub y súbelo
en PythonAnywhere a esta ruta:

```text
~/asistencia_clases/static/Registro_de_Asistencia.apk
```

No es necesario reiniciar la página después de reemplazar únicamente este
archivo. La opción **Instalar aplicación → Instalar aplicación propia
(Android)** descargará siempre el APK que se encuentre en esa ruta.
