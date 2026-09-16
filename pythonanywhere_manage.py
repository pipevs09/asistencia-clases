"""Ejecuta las herramientas administrativas usando la carpeta persistente de PythonAnywhere."""

from pathlib import Path
import os
import runpy


APP_DIR = Path(__file__).resolve().parent
os.environ.setdefault("ASISTENCIA_PUBLIC_MODE", "1")
os.environ.setdefault("ASISTENCIA_DATA_DIR", str(APP_DIR / "data"))
os.environ.setdefault("ASISTENCIA_TRUST_PERSISTENT_DIR", "1")
runpy.run_path(str(APP_DIR / "server.py"), run_name="__main__")
