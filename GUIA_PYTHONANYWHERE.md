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
