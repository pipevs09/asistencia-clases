"""Entrada WSGI para publicar la aplicación en PythonAnywhere."""

from io import BytesIO
from pathlib import Path
from http import HTTPStatus
import os


APP_DIR = Path(__file__).resolve().parent
os.environ.setdefault("ASISTENCIA_PUBLIC_MODE", "1")
os.environ.setdefault("ASISTENCIA_DATA_DIR", str(APP_DIR / "data"))
os.environ.setdefault("ASISTENCIA_TRUST_PERSISTENT_DIR", "1")

from server import Handler, init_db  # noqa: E402


init_db()


class _OpenBytesIO(BytesIO):
    def close(self):
        self.flush()


class _RequestSocket:
    def __init__(self, request):
        self.input = BytesIO(request)
        self.output = _OpenBytesIO()

    def makefile(self, mode, buffering=None):
        return self.input if "r" in mode else self.output

    def sendall(self, data):
        self.output.write(data)


class _Server:
    server_name = "pythonanywhere"
    server_port = 443


def _raw_request(environ):
    method = environ.get("REQUEST_METHOD", "GET")
    path = environ.get("PATH_INFO", "/")
    query = environ.get("QUERY_STRING", "")
    target = path + (("?" + query) if query else "")
    lines = [f"{method} {target} HTTP/1.1"]
    headers = {}
    for key, value in environ.items():
        if key.startswith("HTTP_"):
            name = key[5:].replace("_", "-").title()
            headers[name] = str(value)
    if environ.get("CONTENT_TYPE"):
        headers["Content-Type"] = environ["CONTENT_TYPE"]
    length = int(environ.get("CONTENT_LENGTH") or 0)
    if length:
        headers["Content-Length"] = str(length)
    headers.setdefault("Host", environ.get("HTTP_HOST", "localhost"))
    lines.extend(f"{name}: {value}" for name, value in headers.items())
    body = environ["wsgi.input"].read(length) if length else b""
    return ("\r\n".join(lines) + "\r\n\r\n").encode("iso-8859-1") + body


def application(environ, start_response):
    socket = _RequestSocket(_raw_request(environ))
    client = (environ.get("REMOTE_ADDR", "127.0.0.1"), 0)
    Handler(socket, client, _Server())
    raw = socket.output.getvalue()
    header_block, separator, body = raw.partition(b"\r\n\r\n")
    if not separator:
        status = "500 Internal Server Error"
        headers = [("Content-Type", "text/plain; charset=utf-8")]
        body = b"Respuesta inv\xe1lida del servidor."
    else:
        lines = header_block.decode("iso-8859-1").split("\r\n")
        parts = lines[0].split(" ", 2)
        code = int(parts[1])
        phrase = parts[2] if len(parts) > 2 else HTTPStatus(code).phrase
        status = f"{code} {phrase}"
        headers = []
        for line in lines[1:]:
            if ":" in line:
                name, value = line.split(":", 1)
                headers.append((name.strip(), value.strip()))
    start_response(status, headers)
    return [body]
