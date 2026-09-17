"""Aplicación local de asistencia, sin dependencias externas."""

from datetime import date
from contextlib import contextmanager, closing
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
import json
import sqlite3
import hashlib
import hmac
import secrets
import time
import sys
import getpass
import os
from xlsx_export import make_export


ROOT = Path(__file__).resolve().parent
PUBLIC_MODE = os.environ.get("ASISTENCIA_PUBLIC_MODE") == "1"
TRUSTED_PERSISTENT_DIR = os.environ.get("ASISTENCIA_TRUST_PERSISTENT_DIR") == "1"
DATA_DIR = Path(os.environ["ASISTENCIA_DATA_DIR"]) if os.environ.get("ASISTENCIA_DATA_DIR") else ROOT
DB = DATA_DIR / "asistencia.db"
STATIC = ROOT / "static"


def check_data_storage():
    if PUBLIC_MODE:
        if not os.environ.get("ASISTENCIA_DATA_DIR") or not DATA_DIR.is_absolute():
            raise RuntimeError("En internet, ASISTENCIA_DATA_DIR debe apuntar a un disco persistente absoluto.")
        if TRUSTED_PERSISTENT_DIR:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
        elif not DATA_DIR.is_dir() or not os.path.ismount(DATA_DIR):
            raise RuntimeError("El disco persistente no está montado. Se detiene el servidor para proteger los datos.")
    else:
        DATA_DIR.mkdir(parents=True, exist_ok=True)


@contextmanager
def connect():
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    try:
        with con:
            yield con
    finally:
        con.close()


def init_db():
    check_data_storage()
    con = sqlite3.connect(DB)
    con.execute("PRAGMA foreign_keys = OFF")
    try:
        con.executescript("""
        CREATE TABLE IF NOT EXISTS students (
            id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE
        );
        CREATE TABLE IF NOT EXISTS subjects (
            id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE
        );
        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY,
            subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
            class_date TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            class_number INTEGER NOT NULL DEFAULT 1,
            UNIQUE (subject_id, class_date, class_number)
        );
        CREATE TABLE IF NOT EXISTS attendance (
            session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
            status TEXT NOT NULL CHECK (status IN ('presente', 'ausente', 'justificado')),
            PRIMARY KEY (session_id, student_id)
        );
        CREATE TABLE IF NOT EXISTS calendar_events (
            id INTEGER PRIMARY KEY,
            subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
            event_date TEXT NOT NULL,
            event_type TEXT NOT NULL,
            title TEXT NOT NULL,
            details TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS admin_account (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            salt BLOB NOT NULL,
            password_hash BLOB NOT NULL,
            failed_attempts INTEGER NOT NULL DEFAULT 0,
            first_failed_at INTEGER NOT NULL DEFAULT 0,
            login_locked INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS admin_sessions (
            token_hash TEXT PRIMARY KEY,
            expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS student_accounts (
            student_id INTEGER PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
            salt BLOB NOT NULL,
            password_hash BLOB NOT NULL,
            failed_attempts INTEGER NOT NULL DEFAULT 0,
            first_failed_at INTEGER NOT NULL DEFAULT 0,
            login_locked INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS student_sessions (
            token_hash TEXT PRIMARY KEY,
            student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
            expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS student_activation (
            student_id INTEGER PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
            salt BLOB NOT NULL,
            code_hash BLOB NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            locked_until INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS login_failures (
            id INTEGER PRIMARY KEY,
            account_type TEXT NOT NULL CHECK (account_type IN ('admin', 'student')),
            account_id INTEGER NOT NULL,
            failed_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS login_failures_lookup
            ON login_failures (account_type, account_id, failed_at);
        """)
        for table in ("admin_account", "student_accounts"):
            existing = {row[1] for row in con.execute(f"PRAGMA table_info({table})")}
            for column in ("failed_attempts", "first_failed_at", "login_locked"):
                if column not in existing:
                    con.execute(f"ALTER TABLE {table} ADD COLUMN {column} INTEGER NOT NULL DEFAULT 0")
        columns = {row[1] for row in con.execute("PRAGMA table_info(sessions)")}
        if "class_number" not in columns:
            # Migra la versión anterior sin perder clases ni asistencia.
            con.execute("BEGIN")
            try:
                con.execute("""CREATE TABLE sessions_new (
                    id INTEGER PRIMARY KEY,
                    subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
                    class_date TEXT NOT NULL,
                    title TEXT NOT NULL DEFAULT '',
                    class_number INTEGER NOT NULL,
                    UNIQUE (subject_id, class_date, class_number)
                )""")
                con.execute("""INSERT INTO sessions_new (id, subject_id, class_date, title, class_number)
                    SELECT s.id, s.subject_id, s.class_date, s.title,
                           (SELECT COUNT(*) FROM sessions earlier
                            WHERE earlier.subject_id = s.subject_id
                              AND earlier.class_date = s.class_date AND earlier.id <= s.id)
                    FROM sessions s""")
                con.execute("DROP TABLE sessions")
                con.execute("ALTER TABLE sessions_new RENAME TO sessions")
                con.commit()
            except Exception:
                con.rollback()
                raise
        con.execute("DROP TABLE IF EXISTS enrollments")
        con.commit()
        con.execute("PRAGMA foreign_keys = ON")
        if con.execute("PRAGMA foreign_key_check").fetchone():
            raise RuntimeError("La base de datos tiene referencias inválidas.")
    finally:
        con.close()


def rows(con, sql, args=()):
    return [dict(row) for row in con.execute(sql, args)]


def required_text(data, key, max_len=120):
    value = data.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"El campo '{key}' es obligatorio.")
    value = value.strip()
    if len(value) > max_len:
        raise ValueError(f"El campo '{key}' es demasiado largo.")
    return value


def positive_id(data, key):
    value = data.get(key)
    if isinstance(value, bool):
        raise ValueError(f"'{key}' debe ser un número válido.")
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise ValueError(f"'{key}' debe ser un número válido.") from None
    if number < 1:
        raise ValueError(f"'{key}' debe ser un número válido.")
    return number


def exists(con, table, item_id):
    if not con.execute(f"SELECT 1 FROM {table} WHERE id = ?", (item_id,)).fetchone():
        raise ValueError("El registro seleccionado no existe.")


def renumber_group(con, subject_id, class_date):
    sessions = rows(con, """SELECT id, class_number FROM sessions
                             WHERE subject_id = ? AND class_date = ?
                             ORDER BY class_number, id""", (subject_id, class_date))
    offset = max((item["class_number"] for item in sessions), default=0) + len(sessions)
    for number, item in enumerate(sessions, 1):
        con.execute("UPDATE sessions SET class_number = ? WHERE id = ?", (offset + number, item["id"]))
    for number, item in enumerate(sessions, 1):
        con.execute("UPDATE sessions SET class_number = ? WHERE id = ?", (number, item["id"]))


def selected_ids(con, data, key, table):
    values = data.get(key)
    if not isinstance(values, list) or not values or len(values) > 2000:
        raise ValueError(f"Selecciona al menos un registro en '{key}'.")
    if any(not isinstance(value, int) or isinstance(value, bool) for value in values):
        raise ValueError("La selección contiene identificadores inválidos.")
    ids = [positive_id({"id": value}, "id") for value in values]
    if len(set(ids)) != len(ids):
        raise ValueError("La selección contiene registros duplicados.")
    for item_id in ids:
        exists(con, table, item_id)
    return ids


SESSION_DAYS = 30
PASSWORD_ITERATIONS = 600_000
LOGIN_MAX_ATTEMPTS = 5
LOGIN_WINDOW_SECONDS = 5 * 60


def password_digest(password, salt):
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS)


def valid_password(password):
    return (isinstance(password, str) and 6 <= len(password) <= 128
            and any(char.isupper() for char in password)
            and any(char.isdigit() for char in password))


def clear_login_failures(con, account_type, account_id):
    con.execute("DELETE FROM login_failures WHERE account_type = ? AND account_id = ?",
                (account_type, account_id))


def record_login_failure(con, table, key_column, key_value, account_type):
    now = int(time.time())
    con.execute("""DELETE FROM login_failures WHERE account_type = ? AND account_id = ?
        AND failed_at <= ?""", (account_type, key_value, now - LOGIN_WINDOW_SECONDS))
    con.execute("INSERT INTO login_failures (account_type, account_id, failed_at) VALUES (?, ?, ?)",
                (account_type, key_value, now))
    attempts, first_failed_at = con.execute("""SELECT COUNT(*), MIN(failed_at) FROM login_failures
        WHERE account_type = ? AND account_id = ?""", (account_type, key_value)).fetchone()
    locked = int(attempts >= LOGIN_MAX_ATTEMPTS)
    con.execute(f"""UPDATE {table} SET failed_attempts = ?, first_failed_at = ?, login_locked = ?
        WHERE {key_column} = ?""", (attempts, first_failed_at, locked, key_value))
    return locked


def change_admin_password_local(password):
    if not valid_password(password):
        raise ValueError("La contraseña debe tener al menos 6 caracteres, una mayúscula y un número.")
    with connect() as con:
        if not con.execute("SELECT 1 FROM admin_account WHERE id = 1").fetchone():
            raise ValueError("Primero configura la cuenta de administrador desde la página.")
        salt = secrets.token_bytes(16)
        con.execute("""UPDATE admin_account SET salt = ?, password_hash = ?,
            failed_attempts = 0, first_failed_at = 0, login_locked = 0 WHERE id = 1""",
            (salt, password_digest(password, salt)))
        con.execute("DELETE FROM admin_sessions")
        clear_login_failures(con, "admin", 1)


def setup_admin_password_on_server(password):
    if not valid_password(password):
        raise ValueError("La contraseña debe tener al menos 6 caracteres, una mayúscula y un número.")
    with connect() as con:
        if con.execute("SELECT 1 FROM admin_account WHERE id = 1").fetchone():
            raise ValueError("La cuenta de administrador ya está configurada.")
        salt = secrets.token_bytes(16)
        con.execute("INSERT INTO admin_account (id, salt, password_hash) VALUES (1, ?, ?)",
                    (salt, password_digest(password, salt)))


def import_database_on_server(source_path):
    source_path = Path(source_path).resolve()
    if not source_path.is_file() or source_path == DB.resolve():
        raise ValueError("Indica una copia de la base de datos distinta de la base activa.")
    with closing(sqlite3.connect(DB)) as target:
        if any(target.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
               for table in ("students", "subjects", "sessions", "admin_account")):
            raise ValueError("La base del servidor ya contiene registros. No se sobrescribirá.")
        with closing(sqlite3.connect(source_path)) as source:
            if source.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("La copia de origen no pasó la verificación de integridad.")
            tables = {row[0] for row in source.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
            if not {"students", "subjects", "sessions", "attendance"}.issubset(tables):
                raise ValueError("El archivo no es una base de asistencia válida.")
            source.backup(target)
        for table in ("admin_sessions", "student_sessions"):
            if target.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)).fetchone():
                target.execute(f"DELETE FROM {table}")
        target.commit()
    init_db()


def print_database_status():
    with connect() as con:
        counts = {table: con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                  for table in ("students", "subjects", "sessions", "attendance", "admin_account")}
    print(f"Base de datos: {DB}")
    print(f"Estudiantes: {counts['students']} | Ramos: {counts['subjects']} | Clases: {counts['sessions']} | Marcas: {counts['attendance']}")
    print(f"Administrador configurado: {'sí' if counts['admin_account'] else 'no'}")


ACTIVATION_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
ACTIVATION_MAX_ATTEMPTS = 5
ACTIVATION_LOCK_SECONDS = 15 * 60


def issue_activation(con, student_id):
    code = "".join(secrets.choice(ACTIVATION_ALPHABET) for _ in range(5))
    salt = secrets.token_bytes(16)
    con.execute("""INSERT INTO student_activation (student_id, salt, code_hash, attempts, locked_until)
        VALUES (?, ?, ?, 0, 0)
        ON CONFLICT(student_id) DO UPDATE SET salt = excluded.salt,
            code_hash = excluded.code_hash, attempts = 0, locked_until = 0""",
        (student_id, salt, password_digest(code, salt)))
    return code


class Handler(BaseHTTPRequestHandler):
    def send_response(self, code, message=None):
        super().send_response(code, message)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'")
        if PUBLIC_MODE:
            self.send_header("Strict-Transport-Security", "max-age=31536000")

    def session_cookie(self, name, token, max_age):
        attributes = f"{name}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}"
        return attributes + ("; Secure" if PUBLIC_MODE else "")

    def check_activation(self, con, student_id, supplied_code):
        row = con.execute("SELECT salt, code_hash, attempts, locked_until FROM student_activation WHERE student_id = ?",
                          (student_id,)).fetchone()
        if not row:
            return 400, "No hay código de activación. Pide al administrador que restablezca la contraseña."
        now = int(time.time())
        if row["locked_until"] > now:
            return 429, "Demasiados intentos. Espera 15 minutos o pide otro código al administrador."
        code = supplied_code.strip().upper() if isinstance(supplied_code, str) else ""
        valid = (len(code) == 5 and all(char in ACTIVATION_ALPHABET for char in code)
                 and hmac.compare_digest(password_digest(code, row["salt"]), row["code_hash"]))
        if not valid:
            attempts = row["attempts"] + 1
            locked_until = now + ACTIVATION_LOCK_SECONDS if attempts >= ACTIVATION_MAX_ATTEMPTS else 0
            con.execute("UPDATE student_activation SET attempts = ?, locked_until = ? WHERE student_id = ?",
                        (0 if locked_until else attempts, locked_until, student_id))
            return (429, "Demasiados intentos. Espera 15 minutos o pide otro código al administrador.") if locked_until else (401, "Código de activación incorrecto.")
        con.execute("UPDATE student_activation SET attempts = 0, locked_until = 0 WHERE student_id = ?", (student_id,))
        return None
    def cookie_token(self, name):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
            return cookie[name].value if name in cookie else ""
        except Exception:
            return ""

    def student_status(self, con):
        token = self.cookie_token("student_session")
        if token:
            row = con.execute("""SELECT ss.student_id, st.name FROM student_sessions ss
                JOIN students st ON st.id = ss.student_id
                WHERE ss.token_hash = ? AND ss.expires_at > ?""",
                (hashlib.sha256(token.encode()).hexdigest(), int(time.time()))).fetchone()
            if row:
                return {"authenticated": True, "student_id": row["student_id"], "name": row["name"]}
        return {"authenticated": False, "student_id": None, "name": None}

    def require_attendance_identity(self, student_id):
        with connect() as con:
            if self.admin_status(con)["authenticated"] or self.student_status(con)["student_id"] == student_id:
                return True
        self.send_json({"error": "Ingresa como estudiante para marcar tu propia asistencia."}, 403)
        return False

    def require_class_identity(self):
        with connect() as con:
            if self.admin_status(con)["authenticated"] or self.student_status(con)["authenticated"]:
                return True
        self.send_json({"error": "Inicia sesión como estudiante o administrador para modificar clases."}, 403)
        return False

    def set_student_session(self, con, student_id):
        token = secrets.token_urlsafe(32)
        con.execute("INSERT INTO student_sessions VALUES (?, ?, ?)",
                    (hashlib.sha256(token.encode()).hexdigest(), student_id, int(time.time()) + SESSION_DAYS * 86400))
        con.execute("DELETE FROM student_sessions WHERE expires_at <= ?", (int(time.time()),))
        con.commit()
        raw = json.dumps({"authenticated": True, "student_id": student_id}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Set-Cookie", self.session_cookie("student_session", token, SESSION_DAYS * 86400))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def admin_status(self, con):
        configured = con.execute("SELECT 1 FROM admin_account WHERE id = 1").fetchone() is not None
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
            token = cookie["admin_session"].value if "admin_session" in cookie else ""
        except Exception:
            token = ""
        authenticated = False
        if configured and token:
            token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
            authenticated = con.execute("""SELECT 1 FROM admin_sessions
                WHERE token_hash = ? AND expires_at > ?""", (token_hash, int(time.time()))).fetchone() is not None
        return {"configured": configured, "authenticated": authenticated, "public_mode": PUBLIC_MODE}

    def require_admin(self):
        with connect() as con:
            if self.admin_status(con)["authenticated"]:
                return True
        self.send_json({"error": "Solo el administrador puede modificar estudiantes y ramos."}, 403)
        return False

    def set_admin_session(self, con):
        token = secrets.token_urlsafe(32)
        con.execute("INSERT INTO admin_sessions VALUES (?, ?)",
                    (hashlib.sha256(token.encode()).hexdigest(), int(time.time()) + SESSION_DAYS * 86400))
        con.execute("DELETE FROM admin_sessions WHERE expires_at <= ?", (int(time.time()),))
        con.commit()
        raw = json.dumps({"authenticated": True}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Set-Cookie", self.session_cookie("admin_session", token, SESSION_DAYS * 86400))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def send_json(self, value, status=200):
        raw = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def read_json(self):
        size = int(self.headers.get("Content-Length", "0"))
        if size < 1 or size > 100_000:
            raise ValueError("La solicitud es demasiado grande o está vacía.")
        data = json.loads(self.rfile.read(size))
        if not isinstance(data, dict):
            raise ValueError("Se esperaba un objeto JSON.")
        return data

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/healthz":
            try:
                with connect() as con:
                    con.execute("SELECT 1 FROM students LIMIT 1").fetchone()
                self.send_json({"ok": True})
            except sqlite3.Error:
                self.send_json({"ok": False}, 503)
            return
        if path == "/":
            path = "/index.html"
        if path.startswith("/api/"):
            try:
                query = parse_qs(parsed.query)
                with connect() as con:
                    if path == "/api/overview":
                        result = {
                            "students": rows(con, "SELECT id, name FROM students ORDER BY name"),
                            "subjects": rows(con, "SELECT id, name FROM subjects ORDER BY name"),
                        }
                    elif path == "/api/admin/status":
                        result = self.admin_status(con)
                    elif path == "/api/student/status":
                        result = self.student_status(con)
                    elif path == "/api/student/available":
                        result = rows(con, """SELECT st.id, st.name FROM students st
                            LEFT JOIN student_accounts a ON a.student_id = st.id
                            WHERE a.student_id IS NULL ORDER BY st.name""")
                    elif path == "/api/sessions":
                        subject_raw = query.get("subject_id", ["all"])[0]
                        subject_id = None if subject_raw == "all" else positive_id({"subject_id": subject_raw}, "subject_id")
                        if subject_id:
                            exists(con, "subjects", subject_id)
                        result = rows(con, """
                            SELECT s.id, s.subject_id, sub.name AS subject_name,
                                   s.class_date, s.title, s.class_number,
                                   SUM(CASE WHEN a.status = 'presente' THEN 1 ELSE 0 END) AS present,
                                   SUM(CASE WHEN a.status = 'justificado' THEN 1 ELSE 0 END) AS justified,
                                   (SELECT COUNT(*) FROM students) -
                                   SUM(CASE WHEN a.status IN ('presente', 'justificado') THEN 1 ELSE 0 END) AS absent
                            FROM sessions s JOIN subjects sub ON sub.id = s.subject_id
                            LEFT JOIN attendance a ON a.session_id = s.id
                            WHERE (? IS NULL OR s.subject_id = ?) GROUP BY s.id
                            ORDER BY s.class_date DESC, s.id DESC
                        """, (subject_id, subject_id))
                    elif path == "/api/session":
                        session_id = positive_id({"session_id": query.get("session_id", [None])[0]}, "session_id")
                        session = con.execute("SELECT id, subject_id, class_date, title, class_number FROM sessions WHERE id = ?", (session_id,)).fetchone()
                        if not session:
                            raise ValueError("La clase no existe.")
                        result = {
                            "session": dict(session),
                            "students": rows(con, """
                                SELECT st.id, st.name, COALESCE(a.status, 'ausente') AS status
                                FROM students st
                                LEFT JOIN attendance a ON a.session_id = ? AND a.student_id = st.id
                                ORDER BY st.name
                            """, (session_id,)),
                        }
                    elif path == "/api/report":
                        subject_raw = query.get("subject_id", ["all"])[0]
                        subject_id = None if subject_raw == "all" else positive_id({"subject_id": subject_raw}, "subject_id")
                        if subject_id:
                            exists(con, "subjects", subject_id)
                        student_raw = query.get("student_id", ["all"])[0]
                        student_id = None if student_raw == "all" else positive_id({"student_id": student_raw}, "student_id")
                        if student_id:
                            exists(con, "students", student_id)
                        result = rows(con, """
                            SELECT st.id, st.name,
                                   COUNT(s.id) AS total_classes,
                                   SUM(CASE WHEN a.status = 'presente' THEN 1 ELSE 0 END) AS present,
                                   SUM(CASE WHEN s.id IS NOT NULL AND (a.status IS NULL OR a.status = 'ausente') THEN 1 ELSE 0 END) AS absent,
                                   SUM(CASE WHEN a.status = 'justificado' THEN 1 ELSE 0 END) AS justified
                            FROM students st
                            LEFT JOIN sessions s ON (? IS NULL OR s.subject_id = ?)
                            LEFT JOIN attendance a ON a.session_id = s.id AND a.student_id = st.id
                            WHERE (? IS NULL OR st.id = ?)
                            GROUP BY st.id ORDER BY st.name
                        """, (subject_id, subject_id, student_id, student_id))
                        for item in result:
                            item["attendance_percent"] = (
                                round(100 * item["present"] / item["total_classes"], 1)
                                if item["total_classes"] else None
                            )
                            item["absence_days"] = rows(con, """
                                SELECT s.class_date, s.title, s.class_number,
                                       sub.name AS subject_name FROM sessions s
                                JOIN subjects sub ON sub.id = s.subject_id
                                LEFT JOIN attendance a ON a.session_id = s.id AND a.student_id = ?
                                WHERE (? IS NULL OR s.subject_id = ?)
                                  AND (a.status IS NULL OR a.status = 'ausente')
                                ORDER BY s.class_date DESC, s.id DESC
                            """, (item["id"], subject_id, subject_id))
                    elif path == "/api/calendar":
                        month = query.get("month", [None])[0]
                        if not month or len(month) != 7 or month[4] != "-":
                            raise ValueError("El mes debe tener el formato AAAA-MM.")
                        try:
                            date.fromisoformat(month + "-01")
                        except ValueError:
                            raise ValueError("Selecciona un mes válido.") from None
                        student_raw = query.get("student_id", [None])[0]
                        student_id = positive_id({"student_id": student_raw}, "student_id") if student_raw else None
                        if student_id:
                            exists(con, "students", student_id)
                        result = rows(con, """
                            SELECT s.id, s.class_date, s.title, s.class_number,
                                   sub.name AS subject_name,
                                   CASE WHEN ? IS NULL THEN '' ELSE COALESCE(a.status, 'ausente') END AS status
                            FROM sessions s JOIN subjects sub ON sub.id = s.subject_id
                            LEFT JOIN attendance a ON a.session_id = s.id AND a.student_id = ?
                            WHERE s.class_date >= ? AND s.class_date < ?
                            ORDER BY s.class_date, sub.name, s.class_number
                        """, (student_id, student_id, month + "-01", month + "-32"))
                    elif path == "/api/events":
                        month = query.get("month", [None])[0]
                        if not month or len(month) != 7 or month[4] != "-":
                            raise ValueError("El mes debe tener el formato AAAA-MM.")
                        try:
                            date.fromisoformat(month + "-01")
                        except ValueError:
                            raise ValueError("Selecciona un mes válido.") from None
                        subject_raw = query.get("subject_id", ["all"])[0]
                        subject_id = None if subject_raw == "all" else positive_id({"subject_id": subject_raw}, "subject_id")
                        if subject_id:
                            exists(con, "subjects", subject_id)
                        result = rows(con, """
                            SELECT e.id, e.subject_id, sub.name AS subject_name,
                                   e.event_date, e.event_type, e.title, e.details
                            FROM calendar_events e
                            JOIN subjects sub ON sub.id = e.subject_id
                            WHERE e.event_date >= ? AND e.event_date < ?
                              AND (? IS NULL OR e.subject_id = ?)
                            ORDER BY e.event_date, sub.name, e.title
                        """, (month + "-01", month + "-32", subject_id, subject_id))
                    else:
                        self.send_json({"error": "Ruta no encontrada."}, 404)
                        return
                self.send_json(result)
            except (ValueError, sqlite3.Error) as exc:
                self.send_json({"error": str(exc)}, 400)
            return
        name = path.lstrip("/")
        if name not in {"index.html", "style.css", "app.js"}:
            self.send_error(404)
            return
        file = STATIC / name
        mime = {"index.html": "text/html", "style.css": "text/css", "app.js": "text/javascript"}[name]
        raw = file.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", f"{mime}; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        try:
            if self.path in {"/api/students", "/api/subjects"} and not self.require_admin():
                return
            if self.path == "/api/events" and not self.require_admin():
                return
            reset_parts = self.path.split("/")
            reset_request = (len(reset_parts) == 5 and reset_parts[:3] == ["", "api", "students"]
                             and reset_parts[4] == "reset-password")
            if reset_request and not self.require_admin():
                return
            if self.path == "/api/sessions" and not self.require_class_identity():
                return
            data = self.read_json()
            if self.path == "/api/admin/setup":
                if PUBLIC_MODE:
                    raise ValueError("Configura la cuenta desde la terminal del servidor con python server.py --setup-admin.")
                if self.client_address[0] not in {"127.0.0.1", "::1"}:
                    raise ValueError("La cuenta inicial solo se puede configurar desde este computador.")
                password = data.get("password")
                if not valid_password(password):
                    raise ValueError("La contraseña debe tener al menos 6 caracteres, una mayúscula y un número.")
                with connect() as con:
                    if self.admin_status(con)["configured"]:
                        self.send_json({"error": "La cuenta de administrador ya está configurada."}, 409)
                        return
                    salt = secrets.token_bytes(16)
                    con.execute("INSERT INTO admin_account (id, salt, password_hash) VALUES (1, ?, ?)",
                                (salt, password_digest(password, salt)))
                    self.set_admin_session(con)
                return
            if self.path == "/api/admin/login":
                password = data.get("password")
                if not isinstance(password, str) or not 1 <= len(password) <= 128:
                    raise ValueError("Escribe la contraseña de administrador.")
                failure = None
                with connect() as con:
                    con.execute("BEGIN IMMEDIATE")
                    account = con.execute("SELECT salt, password_hash, login_locked FROM admin_account WHERE id = 1").fetchone()
                    if not account:
                        raise ValueError("Primero configura la cuenta de administrador.")
                    if account["login_locked"]:
                        failure = (423, "Cuenta de administrador bloqueada. En el computador del servidor, ejecuta python server.py --reset-admin.")
                    elif not hmac.compare_digest(password_digest(password, account["salt"]), account["password_hash"]):
                        locked = record_login_failure(con, "admin_account", "id", 1, "admin")
                        failure = (423, "Cuenta de administrador bloqueada. En el computador del servidor, ejecuta python server.py --reset-admin.") if locked else (401, "Contraseña incorrecta.")
                    else:
                        clear_login_failures(con, "admin", 1)
                        con.execute("UPDATE admin_account SET failed_attempts = 0, first_failed_at = 0 WHERE id = 1")
                        self.set_admin_session(con)
                        return
                self.send_json({"error": failure[1]}, failure[0])
                return
            if self.path == "/api/admin/logout":
                cookie = SimpleCookie()
                try:
                    cookie.load(self.headers.get("Cookie", ""))
                    token = cookie["admin_session"].value if "admin_session" in cookie else ""
                except Exception:
                    token = ""
                if token:
                    with connect() as con:
                        con.execute("DELETE FROM admin_sessions WHERE token_hash = ?",
                                    (hashlib.sha256(token.encode()).hexdigest(),))
                raw = b'{"authenticated": false}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Set-Cookie", self.session_cookie("admin_session", "", 0))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
                return
            if self.path == "/api/student/register":
                student_id = positive_id(data, "student_id")
                password = data.get("password")
                if not valid_password(password):
                    raise ValueError("La contraseña debe tener al menos 6 caracteres, una mayúscula y un número.")
                if password != data.get("confirm_password"):
                    raise ValueError("Las contraseñas no coinciden.")
                with connect() as con:
                    con.execute("BEGIN IMMEDIATE")
                    exists(con, "students", student_id)
                    if con.execute("SELECT 1 FROM student_accounts WHERE student_id = ?", (student_id,)).fetchone():
                        self.send_json({"error": "Este estudiante ya creó su contraseña."}, 409)
                        return
                    failure = self.check_activation(con, student_id, data.get("activation_code"))
                    if failure:
                        self.send_json({"error": failure[1]}, failure[0])
                        return
                    salt = secrets.token_bytes(16)
                    con.execute("INSERT INTO student_accounts (student_id, salt, password_hash) VALUES (?, ?, ?)",
                                (student_id, salt, password_digest(password, salt)))
                    con.execute("DELETE FROM student_activation WHERE student_id = ?", (student_id,))
                    self.set_student_session(con, student_id)
                return
            if self.path == "/api/student/activation-check":
                student_id = positive_id(data, "student_id")
                with connect() as con:
                    con.execute("BEGIN IMMEDIATE")
                    exists(con, "students", student_id)
                    if con.execute("SELECT 1 FROM student_accounts WHERE student_id = ?", (student_id,)).fetchone():
                        self.send_json({"error": "Este estudiante ya creó su contraseña."}, 409)
                        return
                    failure = self.check_activation(con, student_id, data.get("activation_code"))
                    if failure:
                        self.send_json({"error": failure[1]}, failure[0])
                        return
                self.send_json({"valid": True})
                return
            if reset_request:
                student_id = positive_id({"student_id": reset_parts[3]}, "student_id")
                with connect() as con:
                    con.execute("BEGIN IMMEDIATE")
                    exists(con, "students", student_id)
                    name = con.execute("SELECT name FROM students WHERE id = ?", (student_id,)).fetchone()[0]
                    con.execute("DELETE FROM student_sessions WHERE student_id = ?", (student_id,))
                    con.execute("DELETE FROM student_accounts WHERE student_id = ?", (student_id,))
                    clear_login_failures(con, "student", student_id)
                    code = issue_activation(con, student_id)
                self.send_json({"student_id": student_id, "name": name, "activation_code": code})
                return
            if self.path == "/api/student/login":
                student_id = positive_id(data, "student_id")
                password = data.get("password")
                if not isinstance(password, str) or not 1 <= len(password) <= 128:
                    raise ValueError("Escribe la contraseña del estudiante.")
                failure = None
                with connect() as con:
                    con.execute("BEGIN IMMEDIATE")
                    account = con.execute("SELECT salt, password_hash, login_locked FROM student_accounts WHERE student_id = ?", (student_id,)).fetchone()
                    if not account:
                        failure = (401, "Estudiante o contraseña incorrectos.")
                    elif account["login_locked"]:
                        failure = (423, "Cuenta bloqueada. Pide al administrador que restablezca tu contraseña.")
                    elif not hmac.compare_digest(password_digest(password, account["salt"]), account["password_hash"]):
                        locked = record_login_failure(con, "student_accounts", "student_id", student_id, "student")
                        failure = (423, "Cuenta bloqueada. Pide al administrador que restablezca tu contraseña.") if locked else (401, "Estudiante o contraseña incorrectos.")
                    else:
                        clear_login_failures(con, "student", student_id)
                        con.execute("UPDATE student_accounts SET failed_attempts = 0, first_failed_at = 0 WHERE student_id = ?", (student_id,))
                        self.set_student_session(con, student_id)
                        return
                self.send_json({"error": failure[1]}, failure[0])
                return
            if self.path == "/api/student/logout":
                token = self.cookie_token("student_session")
                if token:
                    with connect() as con:
                        con.execute("DELETE FROM student_sessions WHERE token_hash = ?", (hashlib.sha256(token.encode()).hexdigest(),))
                raw = b'{"authenticated": false}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Set-Cookie", self.session_cookie("student_session", "", 0))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
                return
            if self.path == "/api/export":
                with connect() as con:
                    student_ids = selected_ids(con, data, "student_ids", "students")
                    subject_ids = selected_ids(con, data, "subject_ids", "subjects")
                    con.execute("BEGIN")
                    raw = make_export(con, student_ids, subject_ids)
                filename = f"asistencia_{date.today().isoformat()}.xlsx"
                self.send_response(200)
                self.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
                self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
                return
            if self.path == "/api/attendance":
                student_id = positive_id(data, "student_id")
                if not self.require_attendance_identity(student_id):
                    return
            with connect() as con:
                if self.path == "/api/students":
                    name = required_text(data, "name")
                    cur = con.execute("INSERT INTO students (name) VALUES (?)", (name,))
                    code = issue_activation(con, cur.lastrowid)
                    result = {"id": cur.lastrowid, "name": name, "activation_code": code}
                elif self.path == "/api/subjects":
                    name = required_text(data, "name")
                    cur = con.execute("INSERT INTO subjects (name) VALUES (?)", (name,))
                    result = {"id": cur.lastrowid, "name": name}
                elif self.path == "/api/sessions":
                    subject_id = positive_id(data, "subject_id")
                    exists(con, "subjects", subject_id)
                    class_date = required_text(data, "class_date", 10)
                    try:
                        date.fromisoformat(class_date)
                    except ValueError:
                        raise ValueError("La fecha debe tener el formato AAAA-MM-DD.") from None
                    title = data.get("title", "")
                    if not isinstance(title, str) or len(title.strip()) > 120:
                        raise ValueError("El tema de la clase es demasiado largo.")
                    title = title.strip()
                    con.execute("BEGIN IMMEDIATE")
                    class_number = con.execute("""SELECT COALESCE(MAX(class_number), 0) + 1 FROM sessions
                                                  WHERE subject_id = ? AND class_date = ?""", (subject_id, class_date)).fetchone()[0]
                    cur = con.execute("INSERT INTO sessions (subject_id, class_date, title, class_number) VALUES (?, ?, ?, ?)",
                                      (subject_id, class_date, title, class_number))
                    result = {"id": cur.lastrowid, "subject_id": subject_id, "class_date": class_date,
                              "title": title, "class_number": class_number}
                elif self.path == "/api/attendance":
                    session_id = positive_id(data, "session_id")
                    student_id = positive_id(data, "student_id")
                    status = data.get("status")
                    if status not in {"presente", "ausente", "justificado"}:
                        raise ValueError("Selecciona un estado de asistencia válido.")
                    exists(con, "sessions", session_id)
                    exists(con, "students", student_id)
                    con.execute("""INSERT INTO attendance VALUES (?, ?, ?)
                                   ON CONFLICT(session_id, student_id) DO UPDATE SET status = excluded.status""",
                                (session_id, student_id, status))
                    result = {"session_id": session_id, "student_id": student_id, "status": status}
                elif self.path == "/api/events":
                    subject_id = positive_id(data, "subject_id")
                    exists(con, "subjects", subject_id)
                    event_date = required_text(data, "event_date", 10)
                    try:
                        date.fromisoformat(event_date)
                    except ValueError:
                        raise ValueError("La fecha debe tener el formato AAAA-MM-DD.") from None
                    event_type = required_text(data, "event_type", 30)
                    if event_type not in {"Certamen", "Presentación", "Seminario", "Otro"}:
                        raise ValueError("Selecciona un tipo de evento válido.")
                    title = required_text(data, "title")
                    details = data.get("details", "")
                    if not isinstance(details, str) or len(details.strip()) > 300:
                        raise ValueError("La descripción es demasiado larga.")
                    cur = con.execute("""INSERT INTO calendar_events
                        (subject_id, event_date, event_type, title, details) VALUES (?, ?, ?, ?, ?)""",
                        (subject_id, event_date, event_type, title, details.strip()))
                    result = {"id": cur.lastrowid, "subject_id": subject_id, "event_date": event_date,
                              "event_type": event_type, "title": title, "details": details.strip()}
                else:
                    self.send_json({"error": "Ruta no encontrada."}, 404)
                    return
            self.send_json(result, 201)
        except sqlite3.IntegrityError:
            self.send_json({"error": "Ese registro ya existe."}, 409)
        except (ValueError, json.JSONDecodeError) as exc:
            self.send_json({"error": str(exc)}, 400)

    def do_PATCH(self):
        self.change_item("PATCH")

    def do_DELETE(self):
        self.change_item("DELETE")

    def change_item(self, method):
        try:
            parts = urlparse(self.path).path.split("/")
            if len(parts) != 4 or parts[:2] != ["", "api"] or parts[2] not in {"students", "subjects", "sessions", "events"}:
                self.send_json({"error": "Ruta no encontrada."}, 404)
                return
            table = parts[2]
            if table in {"students", "subjects", "events"} and not self.require_admin():
                return
            if table == "sessions" and not self.require_class_identity():
                return
            item_id = positive_id({"id": parts[3]}, "id")
            data = self.read_json() if method == "PATCH" else None
            with connect() as con:
                exists(con, "calendar_events" if table == "events" else table, item_id)
                if table == "events":
                    if method == "PATCH":
                        subject_id = positive_id(data, "subject_id")
                        exists(con, "subjects", subject_id)
                        event_date = required_text(data, "event_date", 10)
                        try:
                            date.fromisoformat(event_date)
                        except ValueError:
                            raise ValueError("La fecha debe tener el formato AAAA-MM-DD.") from None
                        event_type = required_text(data, "event_type", 30)
                        if event_type not in {"Certamen", "Presentación", "Seminario", "Otro"}:
                            raise ValueError("Selecciona un tipo de evento válido.")
                        title = required_text(data, "title")
                        details = data.get("details", "")
                        if not isinstance(details, str) or len(details.strip()) > 300:
                            raise ValueError("La descripción es demasiado larga.")
                        con.execute("""UPDATE calendar_events SET subject_id = ?, event_date = ?,
                            event_type = ?, title = ?, details = ? WHERE id = ?""",
                            (subject_id, event_date, event_type, title, details.strip(), item_id))
                        result = {"id": item_id, "subject_id": subject_id, "event_date": event_date,
                                  "event_type": event_type, "title": title, "details": details.strip()}
                    else:
                        con.execute("DELETE FROM calendar_events WHERE id = ?", (item_id,))
                        result = {"deleted": item_id}
                elif table == "sessions":
                    con.execute("BEGIN IMMEDIATE")
                    original = con.execute("""SELECT subject_id, class_date, class_number FROM sessions
                                              WHERE id = ?""", (item_id,)).fetchone()
                    if method == "PATCH":
                        subject_id = positive_id(data, "subject_id")
                        exists(con, "subjects", subject_id)
                        class_date = required_text(data, "class_date", 10)
                        try:
                            date.fromisoformat(class_date)
                        except ValueError:
                            raise ValueError("La fecha debe tener el formato AAAA-MM-DD.") from None
                        title = data.get("title", "")
                        if not isinstance(title, str) or len(title.strip()) > 120:
                            raise ValueError("El tema de la clase es demasiado largo.")
                        title = title.strip()
                        moved = subject_id != original["subject_id"] or class_date != original["class_date"]
                        class_number = (con.execute("""SELECT COALESCE(MAX(class_number), 0) + 1 FROM sessions
                                                      WHERE subject_id = ? AND class_date = ?""",
                                                    (subject_id, class_date)).fetchone()[0]
                                        if moved else original["class_number"])
                        con.execute("""UPDATE sessions SET subject_id = ?, class_date = ?, title = ?, class_number = ?
                                       WHERE id = ?""", (subject_id, class_date, title, class_number, item_id))
                        result = {"id": item_id, "subject_id": subject_id, "class_date": class_date,
                                  "title": title, "class_number": class_number}
                    else:
                        con.execute("DELETE FROM sessions WHERE id = ?", (item_id,))
                        result = {"deleted": item_id}
                    if method == "DELETE" or moved:
                        renumber_group(con, original["subject_id"], original["class_date"])
                elif method == "PATCH":
                    name = required_text(data, "name")
                    con.execute(f"UPDATE {table} SET name = ? WHERE id = ?", (name, item_id))
                    result = {"id": item_id, "name": name}
                else:
                    if table == "students":
                        clear_login_failures(con, "student", item_id)
                    con.execute(f"DELETE FROM {table} WHERE id = ?", (item_id,))
                    result = {"deleted": item_id}
            self.send_json(result)
        except sqlite3.IntegrityError:
            self.send_json({"error": "Ya existe un registro con ese nombre."}, 409)
        except (ValueError, json.JSONDecodeError) as exc:
            self.send_json({"error": str(exc)}, 400)


if __name__ == "__main__":
    init_db()
    if len(sys.argv) == 2 and sys.argv[1] == "--status-db":
        print_database_status()
        sys.exit(0)
    if len(sys.argv) == 3 and sys.argv[1] == "--import-db":
        try:
            import_database_on_server(sys.argv[2])
            print("Base de asistencia importada. Las sesiones anteriores se cerraron.")
        except (ValueError, sqlite3.Error) as exc:
            print(f"Error: {exc}", file=sys.stderr)
            sys.exit(1)
        sys.exit(0)
    if len(sys.argv) == 2 and sys.argv[1] in {"--reset-admin", "--setup-admin"}:
        try:
            new_password = getpass.getpass("Nueva contraseña de administrador: ")
            confirmation = getpass.getpass("Repite la contraseña: ")
            if new_password != confirmation:
                raise ValueError("Las contraseñas no coinciden.")
            if sys.argv[1] == "--reset-admin":
                change_admin_password_local(new_password)
                print("Contraseña de administrador restablecida. Las sesiones anteriores se cerraron.")
            else:
                setup_admin_password_on_server(new_password)
                print("Cuenta de administrador configurada. Ya puedes iniciar sesión en la página.")
        except ValueError as exc:
            print(f"Error: {exc}", file=sys.stderr)
            sys.exit(1)
        sys.exit(0)
    if len(sys.argv) != 1:
        print("Uso: python server.py [--status-db|--setup-admin|--reset-admin|--import-db RUTA]", file=sys.stderr)
        sys.exit(2)
    port = int(os.environ.get("PORT", "10000" if PUBLIC_MODE else "8000"))
    if not 1 <= port <= 65535:
        raise ValueError("PORT debe estar entre 1 y 65535.")
    address = ("0.0.0.0" if PUBLIC_MODE else "127.0.0.1", port)
    print(f"Registro de asistencia escuchando en {address[0]}:{address[1]}")
    print("Presiona Ctrl+C para detener el programa.")
    ThreadingHTTPServer(address, Handler).serve_forever()
