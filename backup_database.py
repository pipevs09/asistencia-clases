"""Crea una copia consistente de asistencia.db para trasladarla o guardarla."""

from pathlib import Path
from contextlib import closing
import sqlite3
import sys

from server import DB


def main(output_name):
    destination = Path(output_name).resolve()
    if not DB.exists():
        raise ValueError("Aún no existe asistencia.db.")
    if destination == DB.resolve() or destination.exists():
        raise ValueError("El destino debe ser un archivo nuevo, distinto de asistencia.db.")
    if not destination.parent.is_dir():
        raise ValueError("La carpeta de destino no existe.")
    with closing(sqlite3.connect(DB)) as source, closing(sqlite3.connect(destination)) as target:
        source.backup(target)
        if target.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("La copia no pasó la verificación de integridad.")
    print(f"Copia creada: {destination}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Uso: python backup_database.py RUTA_DEL_RESPALDO.db", file=sys.stderr)
        sys.exit(2)
    try:
        main(sys.argv[1])
    except (ValueError, sqlite3.Error) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)
