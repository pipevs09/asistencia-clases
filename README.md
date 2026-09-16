# Registro de asistencia a clases

Aplicación local para crear ramos y estudiantes, registrar cada clase y marcar asistencia. Todos los estudiantes agregados aparecen automáticamente en todos los ramos. La pantalla se organiza en cuatro pestañas: **Agregar clases**, **Registro de asistencia**, **Editor de clases** y **Estudiantes y ramos**. El resumen muestra cada fecha de inasistencia junto con el ramo y el porcentaje de asistencia. El calendario reúne las clases de todos los ramos y marca en rojo las faltas del estudiante seleccionado.

## Cuenta de administrador

Al iniciar esta versión por primera vez, la página te pedirá configurar una contraseña de administrador de al menos 6 caracteres, con una mayúscula y un número. La cuenta se configura una sola vez desde este computador. La pestaña **Estudiantes y ramos** aparecerá cuando ingreses como administrador; sin esa sesión, no se podrán crear, editar ni eliminar estudiantes o ramos. Las demás pestañas siguen disponibles para todos.

El navegador recuerda la sesión de administrador durante 30 días. Puedes cerrarla con **Cerrar sesión** en la parte superior; para volver a entrar, usa **Ingresar como administrador**. Cada navegador o dispositivo necesita ingresar una vez. La contraseña se guarda como un resumen criptográfico con sal, no como texto legible.

Cinco contraseñas incorrectas dentro de cualquier lapso de cinco minutos bloquean la cuenta de administrador hasta restablecer la contraseña. Si eso ocurre, detén el servidor, abre una terminal en esta carpeta y ejecuta `python server.py --reset-admin`. Escribe dos veces la contraseña nueva cuando la terminal la pida; no aparecerá en pantalla. Luego inicia `server.py` normalmente. El restablecimiento cierra las sesiones anteriores. Este comando solo funciona en el computador que tiene el archivo `asistencia.db`.

## Acceso de estudiantes

El administrador agrega el nombre de cada estudiante en **Estudiantes y ramos**. Al crearlo, aparece un código de activación de 5 caracteres que se muestra una sola vez; cópialo y entrégaselo al estudiante. El estudiante pulsa **Ingresar como estudiante → Primera vez**, selecciona su nombre y valida el código. Solo después crea una contraseña escribiéndola dos veces. La contraseña requiere al menos 6 caracteres, una mayúscula y un número. Después entra seleccionando su nombre y escribiendo la contraseña. El navegador recuerda su sesión durante 30 días; puede cerrarla desde el botón superior.

Cuando entra como estudiante, puede marcar solamente su propia asistencia. El administrador puede corregir la asistencia de cualquiera. Agregar, editar o borrar clases también requiere ingresar como estudiante o administrador. Sin sesión, se pueden consultar las clases, el registro y el calendario. La pestaña **Estudiantes y ramos** sigue reservada para el administrador.

Si el estudiante olvida la contraseña o se pierde el código, el administrador abre **Editar → Restablecer contraseña** junto a su nombre y confirma. Aparecerá un código nuevo; la contraseña y las sesiones anteriores dejarán de funcionar, pero se conservará toda su asistencia. El estudiante podrá volver a usar **Primera vez** con el código nuevo. Para estudiantes agregados en versiones anteriores, usa ese mismo botón para emitir su primer código. Después de cinco intentos incorrectos, el código se bloquea durante 15 minutos; restablecerlo también elimina ese bloqueo. El código se almacena como un resumen criptográfico, no como texto legible.

Si un estudiante escribe cinco contraseñas incorrectas dentro de cualquier lapso de cinco minutos, su cuenta queda bloqueada hasta que el administrador use **Editar → Restablecer contraseña**. Una contraseña correcta antes del quinto fallo limpia el contador de intentos.

## Cómo iniciar

En este computador puedes hacer doble clic en **`iniciar.bat`**. Se abrirá una ventana que mantiene el servidor activo.

Si prefieres usar una terminal, necesitas Python 3.9 o superior. Abre una terminal en esta carpeta y ejecuta:

```powershell
python server.py
```

Luego abre **http://127.0.0.1:8000** en tu navegador. Para detener el programa, presiona **Ctrl+C** en la terminal.

En uso local, los registros quedan guardados en `asistencia.db`, que se crea automáticamente en esta carpeta. Puedes generar una copia consistente, incluso con el servidor abierto, con `python backup_database.py RUTA_DEL_RESPALDO.db`. Para publicarlo en Render con HTTPS y almacenamiento persistente, sigue [DESPLIEGUE_RENDER.md](DESPLIEGUE_RENDER.md). La base local no se sube al repositorio Git.

## Uso básico

1. En **Estudiantes y ramos**, agrega estudiantes y ramos. Debajo puedes editar o eliminar cualquiera de ellos.
2. En **Agregar clases**, el historial muestra **Todos los ramos** al entrar. Para crear una clase, elige su ramo en **Ramo de la nueva clase** y agrega la fecha. Si agregas otra clase del mismo ramo en la misma fecha, aparecerá como **2° clase**.
3. En cada clase, pulsa **Marcar asistencia** y marca a quienes estuvieron presentes. También puedes elegir «Justificado» o cambiar una marca a «Ausente».
4. En **Editor de clases**, modifica la fecha, el ramo o el tema de una clase, o elimínala. La asistencia registrada se conserva al modificarla. Al eliminarla se borra su asistencia.
5. En **Registro de asistencia**, el resumen muestra **Todos los ramos** al entrar; puedes filtrar por uno. El porcentaje de asistencia es clases marcadas como **Presente** divididas por todas las clases del filtro. Las justificadas se muestran aparte. Si ingresaste como estudiante, el calendario muestra tus faltas por defecto; puedes seleccionar a cualquier otro estudiante para consultar las suyas. Pulsa cualquier día para ver sus clases.
6. En **Descargar Excel**, marca todos o elige varios estudiantes y ramos. El `.xlsx` contiene resumen, clases, asistencia detallada, estudiantes, ramos e información de la selección. Las faltas sin marca se indican como automáticas.

Una clase sin asistencia marcada se cuenta automáticamente como **inasistencia**. Puedes volver a abrir una clase para corregir un estado. Los registros anteriores se conservan; sus clases sin marca también cuentan ahora como inasistencias.

La primera apertura de esta versión actualiza automáticamente la base de datos anterior y conserva la asistencia. Al eliminar un estudiante se elimina también su historial de asistencia; la aplicación pide confirmación antes de hacerlo.

Al eliminar un ramo se eliminan todas sus clases y sus registros de asistencia. La aplicación pide confirmación antes de hacerlo.

El Excel es una exportación de los datos seleccionados y sirve para consulta o archivo. No se puede importar de vuelta directamente a esta versión de la aplicación. Si necesitas una copia para restaurar el programa, cierra `server.py` y copia `asistencia.db`.

La versión de Render mantiene la consulta de clases, asistencia y exportaciones abierta a cualquier visitante, tal como se decidió. Crear o cambiar registros exige ingresar como estudiante o administrador según la acción.
