"""Aplicación local de asistencia, sin dependencias externas."""

from datetime import date, datetime, timedelta, timezone
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
from zoneinfo import ZoneInfo
from xlsx_export import make_export


ROOT = Path(__file__).resolve().parent
PUBLIC_MODE = os.environ.get("ASISTENCIA_PUBLIC_MODE") == "1"
TRUSTED_PERSISTENT_DIR = os.environ.get("ASISTENCIA_TRUST_PERSISTENT_DIR") == "1"
DATA_DIR = Path(os.environ["ASISTENCIA_DATA_DIR"]) if os.environ.get("ASISTENCIA_DATA_DIR") else ROOT
DB = DATA_DIR / "asistencia.db"
STATIC = ROOT / "static"
NOTIFICATION_SECRET = os.environ.get("ASISTENCIA_NOTIFICATION_SECRET", "")
VAPID_PUBLIC_KEY = os.environ.get("ASISTENCIA_VAPID_PUBLIC_KEY", "")
APP_TIMEZONE = ZoneInfo("America/Punta_Arenas")


class SingleInstanceHTTPServer(ThreadingHTTPServer):
    """Evita que Windows mezcle dos versiones de la aplicación en el mismo puerto."""

    allow_reuse_address = False


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
            id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
            bio TEXT NOT NULL DEFAULT '',
            avatar_data TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS subjects (
            id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
            color TEXT NOT NULL DEFAULT '#1767cc',
            abbreviation TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY,
            subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
            class_date TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            class_number INTEGER NOT NULL DEFAULT 1,
            has_attendance INTEGER NOT NULL DEFAULT 1 CHECK (has_attendance IN (0, 1)),
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
            event_time TEXT NOT NULL DEFAULT '',
            event_type TEXT NOT NULL,
            title TEXT NOT NULL,
            details TEXT NOT NULL DEFAULT '',
            color TEXT NOT NULL DEFAULT '#7c3aed'
        );
        CREATE TABLE IF NOT EXISTS grade_settings (
            subject_id INTEGER PRIMARY KEY REFERENCES subjects(id) ON DELETE CASCADE,
            course_type TEXT NOT NULL DEFAULT 'teorico'
                CHECK (course_type IN ('teorico', 'teorico_practico')),
            theoretical_weight REAL NOT NULL DEFAULT 100,
            practical_weight REAL NOT NULL DEFAULT 0,
            exemption_enabled INTEGER NOT NULL DEFAULT 0,
            exemption_grade REAL NOT NULL DEFAULT 5.0,
            exemption_scope TEXT NOT NULL DEFAULT 'total'
                CHECK (exemption_scope IN ('teorico', 'total')),
            exam_weight REAL NOT NULL DEFAULT 0,
            exam_scope TEXT NOT NULL DEFAULT 'total'
                CHECK (exam_scope IN ('teorico', 'total')),
            exam_is_failing INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS grade_evaluations (
            id INTEGER PRIMARY KEY,
            subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            category TEXT NOT NULL CHECK (category IN ('teorico', 'practico')),
            weight REAL NOT NULL CHECK (weight >= 0 AND weight <= 100),
            substitutable INTEGER NOT NULL DEFAULT 0,
            sort_order INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS grade_scores (
            evaluation_id INTEGER NOT NULL REFERENCES grade_evaluations(id) ON DELETE CASCADE,
            student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
            score REAL NOT NULL CHECK (score >= 1 AND score <= 7),
            PRIMARY KEY (evaluation_id, student_id)
        );
        CREATE TABLE IF NOT EXISTS grade_substitutions (
            student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
            subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
            evaluation_id INTEGER NOT NULL REFERENCES grade_evaluations(id) ON DELETE CASCADE,
            score REAL CHECK (score IS NULL OR (score >= 1 AND score <= 7)),
            PRIMARY KEY (student_id, subject_id)
        );
        CREATE TABLE IF NOT EXISTS grade_exam_scores (
            student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
            subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
            score REAL NOT NULL CHECK (score >= 1 AND score <= 7),
            PRIMARY KEY (student_id, subject_id)
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
        CREATE TABLE IF NOT EXISTS push_subscriptions (
            id INTEGER PRIMARY KEY,
            student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
            endpoint TEXT NOT NULL UNIQUE,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            last_seen INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS notification_deliveries (
            event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
            subscription_id INTEGER NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
            reminder_minutes INTEGER NOT NULL,
            sent_at INTEGER NOT NULL,
            PRIMARY KEY (event_id, subscription_id, reminder_minutes)
        );
        """)
        for table in ("admin_account", "student_accounts"):
            existing = {row[1] for row in con.execute(f"PRAGMA table_info({table})")}
            for column in ("failed_attempts", "first_failed_at", "login_locked"):
                if column not in existing:
                    con.execute(f"ALTER TABLE {table} ADD COLUMN {column} INTEGER NOT NULL DEFAULT 0")
        student_columns = {row[1] for row in con.execute("PRAGMA table_info(students)")}
        if "bio" not in student_columns:
            con.execute("ALTER TABLE students ADD COLUMN bio TEXT NOT NULL DEFAULT ''")
        if "avatar_data" not in student_columns:
            con.execute("ALTER TABLE students ADD COLUMN avatar_data TEXT NOT NULL DEFAULT ''")
        event_columns = {row[1] for row in con.execute("PRAGMA table_info(calendar_events)")}
        if "color" not in event_columns:
            con.execute("ALTER TABLE calendar_events ADD COLUMN color TEXT NOT NULL DEFAULT '#7c3aed'")
        if "event_time" not in event_columns:
            con.execute("ALTER TABLE calendar_events ADD COLUMN event_time TEXT NOT NULL DEFAULT ''")
        con.execute("UPDATE calendar_events SET event_type = 'Prueba' WHERE event_type = 'Certamen'")
        con.execute("UPDATE calendar_events SET event_type = 'Otro' WHERE event_type = 'Seminario'")
        subject_columns = {row[1] for row in con.execute("PRAGMA table_info(subjects)")}
        if "color" not in subject_columns:
            con.execute("ALTER TABLE subjects ADD COLUMN color TEXT NOT NULL DEFAULT '#1767cc'")
        if "abbreviation" not in subject_columns:
            con.execute("ALTER TABLE subjects ADD COLUMN abbreviation TEXT NOT NULL DEFAULT ''")
        evaluation_columns = {row[1] for row in con.execute("PRAGMA table_info(grade_evaluations)")}
        if "substitutable" not in evaluation_columns:
            con.execute("ALTER TABLE grade_evaluations ADD COLUMN substitutable INTEGER NOT NULL DEFAULT 0")
        if "sort_order" not in evaluation_columns:
            con.execute("ALTER TABLE grade_evaluations ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0")
        grade_setting_columns = {row[1] for row in con.execute("PRAGMA table_info(grade_settings)")}
        if "course_type" not in grade_setting_columns:
            con.execute("ALTER TABLE grade_settings ADD COLUMN course_type TEXT NOT NULL DEFAULT 'teorico'")
            con.execute("""UPDATE grade_settings SET course_type = 'teorico_practico'
                WHERE practical_weight > 0 OR EXISTS (
                    SELECT 1 FROM grade_evaluations ge
                    WHERE ge.subject_id = grade_settings.subject_id AND ge.category = 'practico'
                )""")
        if "exam_is_failing" not in grade_setting_columns:
            con.execute("ALTER TABLE grade_settings ADD COLUMN exam_is_failing INTEGER NOT NULL DEFAULT 0")
        for subject_id, subject_name, abbreviation in con.execute(
                "SELECT id, name, abbreviation FROM subjects"):
            if not abbreviation:
                con.execute("UPDATE subjects SET abbreviation = ? WHERE id = ?",
                            (default_abbreviation(subject_name), subject_id))
        con.commit()
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
                    has_attendance INTEGER NOT NULL DEFAULT 1 CHECK (has_attendance IN (0, 1)),
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
        columns = {row[1] for row in con.execute("PRAGMA table_info(sessions)")}
        if "has_attendance" not in columns:
            con.execute("ALTER TABLE sessions ADD COLUMN has_attendance INTEGER NOT NULL DEFAULT 1")
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


def required_color(data, key="color"):
    color = data.get(key)
    if not isinstance(color, str) or len(color) != 7 or color[0] != "#" or any(
            char not in "0123456789abcdefABCDEF" for char in color[1:]):
        raise ValueError("Selecciona un color válido.")
    return color.lower()


def default_abbreviation(name):
    compact = "".join(char for char in name if char.isalpha())
    return (compact[:3] or "RAM").upper()


def required_abbreviation(data, key="abbreviation"):
    value = data.get(key)
    if not isinstance(value, str):
        raise ValueError("El diminutivo del ramo es obligatorio.")
    value = value.strip().upper()
    if not 1 <= len(value) <= 3 or not all(char.isalpha() for char in value):
        raise ValueError("El diminutivo debe tener entre 1 y 3 letras.")
    return value


def optional_time(data, key="event_time"):
    value = data.get(key, "")
    if value in (None, ""):
        return ""
    if not isinstance(value, str) or len(value) != 5 or value[2] != ":":
        raise ValueError("La hora debe tener el formato HH:MM.")
    hour, minute = value[:2], value[3:]
    if not hour.isdigit() or not minute.isdigit() or not 0 <= int(hour) <= 23 or not 0 <= int(minute) <= 59:
        raise ValueError("Selecciona una hora válida.")
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


def required_number(data, key, minimum=0, maximum=100):
    value = data.get(key)
    if isinstance(value, bool):
        raise ValueError(f"'{key}' debe ser un número válido.")
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"'{key}' debe ser un número válido.") from None
    if not minimum <= number <= maximum:
        raise ValueError(f"'{key}' debe estar entre {minimum} y {maximum}.")
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
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'")
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
            row = con.execute("""SELECT ss.student_id, st.name, st.bio, st.avatar_data FROM student_sessions ss
                JOIN students st ON st.id = ss.student_id
                WHERE ss.token_hash = ? AND ss.expires_at > ?""",
                (hashlib.sha256(token.encode()).hexdigest(), int(time.time()))).fetchone()
            if row:
                return {"authenticated": True, "student_id": row["student_id"], "name": row["name"],
                        "bio": row["bio"], "avatar_data": row["avatar_data"]}
        return {"authenticated": False, "student_id": None, "name": None,
                "bio": "", "avatar_data": ""}

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

    def notification_secret_valid(self):
        supplied = self.headers.get("Authorization", "")
        expected = f"Bearer {NOTIFICATION_SECRET}" if NOTIFICATION_SECRET else ""
        return bool(expected and hmac.compare_digest(supplied, expected))

    def notification_jobs(self, con):
        now = datetime.now(timezone.utc)
        oldest = now - timedelta(minutes=60)
        reminder_by_type = {"Clase": 15, "Presentación": 30, "Prueba": 60}
        event_rows = rows(con, """
            SELECT e.id, e.event_date, e.event_time, e.event_type, e.title, e.details,
                   sub.name AS subject_name
            FROM calendar_events e JOIN subjects sub ON sub.id = e.subject_id
            WHERE e.event_time != '' AND e.event_type IN ('Clase', 'Presentación', 'Prueba')
              AND e.event_date >= ? AND e.event_date <= ?
            ORDER BY e.event_date, e.event_time
        """, ((now.astimezone(APP_TIMEZONE) - timedelta(days=1)).date().isoformat(),
              (now.astimezone(APP_TIMEZONE) + timedelta(days=1)).date().isoformat()))
        subscriptions = rows(con, "SELECT id, endpoint, p256dh, auth FROM push_subscriptions")
        jobs = []
        labels = {"Clase": "Clase", "Presentación": "Presentación", "Prueba": "Prueba"}
        for event in event_rows:
            reminder = reminder_by_type[event["event_type"]]
            event_local = datetime.fromisoformat(
                f'{event["event_date"]}T{event["event_time"]}').replace(tzinfo=APP_TIMEZONE)
            due_at = event_local.astimezone(timezone.utc) - timedelta(minutes=reminder)
            if not oldest <= due_at <= now + timedelta(minutes=2):
                continue
            for subscription in subscriptions:
                delivered = con.execute("""SELECT 1 FROM notification_deliveries
                    WHERE event_id = ? AND subscription_id = ? AND reminder_minutes = ?""",
                    (event["id"], subscription["id"], reminder)).fetchone()
                if delivered:
                    continue
                detail = f'{event["subject_name"]} · Comienza a las {event["event_time"]}'
                if event["details"]:
                    detail += f' · {event["details"]}'
                jobs.append({
                    "event_id": event["id"], "subscription_id": subscription["id"],
                    "reminder_minutes": reminder, "endpoint": subscription["endpoint"],
                    "keys": {"p256dh": subscription["p256dh"], "auth": subscription["auth"]},
                    "payload": {
                        "title": f'{labels[event["event_type"]]} en {reminder} minutos: {event["title"]}',
                        "body": detail, "tag": f'event-{event["id"]}-{reminder}',
                        "url": f'/?event_date={event["event_date"]}'
                    }
                })
        return jobs

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
        if size < 1 or size > 200_000:
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
                    if path == "/api/notifications/config":
                        student = self.student_status(con)
                        result = {"supported": bool(VAPID_PUBLIC_KEY and NOTIFICATION_SECRET),
                                  "public_key": VAPID_PUBLIC_KEY,
                                  "student_authenticated": student["authenticated"]}
                    elif path == "/api/notifications/due":
                        if not self.notification_secret_valid():
                            self.send_json({"error": "Acceso no autorizado."}, 403)
                            return
                        result = {"jobs": self.notification_jobs(con)}
                    elif path == "/api/overview":
                        result = {
                            "students": rows(con, "SELECT id, name FROM students ORDER BY name"),
                            "subjects": rows(con, "SELECT id, name, color, abbreviation FROM subjects ORDER BY name"),
                        }
                    elif path == "/api/admin/status":
                        result = self.admin_status(con)
                    elif path == "/api/student/status":
                        result = self.student_status(con)
                    elif path == "/api/student/available":
                        result = rows(con, """SELECT st.id, st.name FROM students st
                            LEFT JOIN student_accounts a ON a.student_id = st.id
                            WHERE a.student_id IS NULL ORDER BY st.name""")
                    elif path == "/api/grade-settings":
                        viewer_student_id = self.student_status(con)["student_id"]
                        result = rows(con, """
                            SELECT sub.id, sub.name, sub.abbreviation, sub.color,
                                   COALESCE(gs.course_type, 'teorico') AS course_type,
                                   COALESCE(gs.theoretical_weight, 100) AS theoretical_weight,
                                   COALESCE(gs.practical_weight, 0) AS practical_weight,
                                   COALESCE(gs.exemption_enabled, 0) AS exemption_enabled,
                                   COALESCE(gs.exemption_grade, 5.0) AS exemption_grade,
                                   COALESCE(gs.exemption_scope, 'total') AS exemption_scope,
                                   COALESCE(gs.exam_weight, 0) AS exam_weight,
                                   COALESCE(gs.exam_scope, 'total') AS exam_scope,
                                   COALESCE(gs.exam_is_failing, 0) AS exam_is_failing
                            FROM subjects sub
                            LEFT JOIN grade_settings gs ON gs.subject_id = sub.id
                            ORDER BY sub.name
                        """)
                        for subject in result:
                            subject["evaluations"] = rows(con, """
                                SELECT ge.id, ge.name, ge.category, ge.weight, ge.substitutable,
                                       ge.sort_order,
                                       gs.score
                                FROM grade_evaluations ge
                                LEFT JOIN grade_scores gs
                                  ON gs.evaluation_id = ge.id AND gs.student_id = ?
                                WHERE ge.subject_id = ?
                                ORDER BY CASE ge.category WHEN 'teorico' THEN 0 ELSE 1 END,
                                         ge.sort_order, ge.id
                            """, (viewer_student_id, subject["id"]))
                            substitution = con.execute("""SELECT evaluation_id, score
                                FROM grade_substitutions
                                WHERE student_id = ? AND subject_id = ?""",
                                (viewer_student_id, subject["id"])).fetchone()
                            subject["substitution"] = dict(substitution) if substitution else None
                            exam_score = con.execute("""SELECT score FROM grade_exam_scores
                                WHERE student_id = ? AND subject_id = ?""",
                                (viewer_student_id, subject["id"])).fetchone()
                            subject["exam_score"] = exam_score["score"] if exam_score else None
                    elif path == "/api/sessions":
                        subject_raw = query.get("subject_id", ["all"])[0]
                        subject_id = None if subject_raw == "all" else positive_id({"subject_id": subject_raw}, "subject_id")
                        if subject_id:
                            exists(con, "subjects", subject_id)
                        # Si ambas sesiones quedaron abiertas en el navegador, la vista de clases
                        # prioriza el estado personal del estudiante. Una sesión solo administrativa
                        # sigue mostrando los totales generales.
                        viewer_student_id = self.student_status(con)["student_id"]
                        result = rows(con, """
                            SELECT s.id, s.subject_id, sub.name AS subject_name,
                                   s.class_date, s.title, s.class_number, s.has_attendance,
                                   CASE WHEN s.has_attendance = 0 OR ? IS NULL THEN NULL ELSE COALESCE(
                                       (SELECT own.status FROM attendance own
                                        WHERE own.session_id = s.id AND own.student_id = ?), 'ausente')
                                   END AS viewer_status,
                                   CASE WHEN s.has_attendance = 1 THEN
                                     SUM(CASE WHEN a.status = 'presente' THEN 1 ELSE 0 END) ELSE 0 END AS present,
                                   CASE WHEN s.has_attendance = 1 THEN
                                     SUM(CASE WHEN a.status = 'justificado' THEN 1 ELSE 0 END) ELSE 0 END AS justified,
                                   COUNT(a.session_id) AS recorded_attendance,
                                   CASE WHEN s.has_attendance = 1 THEN (SELECT COUNT(*) FROM students) -
                                     SUM(CASE WHEN a.status IN ('presente', 'justificado') THEN 1 ELSE 0 END)
                                     ELSE 0 END AS absent
                            FROM sessions s JOIN subjects sub ON sub.id = s.subject_id
                            LEFT JOIN attendance a ON a.session_id = s.id
                            WHERE (? IS NULL OR s.subject_id = ?) GROUP BY s.id
                            ORDER BY s.class_date DESC, s.id DESC
                        """, (viewer_student_id, viewer_student_id, subject_id, subject_id))
                    elif path == "/api/session":
                        session_id = positive_id({"session_id": query.get("session_id", [None])[0]}, "session_id")
                        session = con.execute("SELECT id, subject_id, class_date, title, class_number, has_attendance FROM sessions WHERE id = ?", (session_id,)).fetchone()
                        if not session:
                            raise ValueError("La clase no existe.")
                        if not session["has_attendance"]:
                            raise ValueError("Esta clase no tuvo lista de asistencia.")
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
                            LEFT JOIN sessions s ON s.has_attendance = 1 AND (? IS NULL OR s.subject_id = ?)
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
                                  AND s.has_attendance = 1
                                  AND (a.status IS NULL OR a.status = 'ausente')
                                ORDER BY s.class_date DESC, s.id DESC
                            """, (item["id"], subject_id, subject_id))
                            if subject_id is None and student_id is not None:
                                item["subjects"] = rows(con, """
                                    SELECT sub.id, sub.name,
                                           COUNT(s.id) AS total_classes,
                                           SUM(CASE WHEN a.status = 'presente' THEN 1 ELSE 0 END) AS present,
                                           SUM(CASE WHEN s.id IS NOT NULL AND (a.status IS NULL OR a.status = 'ausente') THEN 1 ELSE 0 END) AS absent,
                                           SUM(CASE WHEN a.status = 'justificado' THEN 1 ELSE 0 END) AS justified
                                    FROM subjects sub
                                    LEFT JOIN sessions s ON s.subject_id = sub.id AND s.has_attendance = 1
                                    LEFT JOIN attendance a ON a.session_id = s.id AND a.student_id = ?
                                    GROUP BY sub.id ORDER BY sub.name
                                """, (item["id"],))
                                for subject in item["subjects"]:
                                    subject["attendance_percent"] = (
                                        round(100 * subject["present"] / subject["total_classes"], 1)
                                        if subject["total_classes"] else None
                                    )
                                    subject["absence_days"] = rows(con, """
                                        SELECT s.class_date, s.title, s.class_number
                                        FROM sessions s
                                        LEFT JOIN attendance a ON a.session_id = s.id AND a.student_id = ?
                                        WHERE s.subject_id = ?
                                          AND s.has_attendance = 1
                                          AND (a.status IS NULL OR a.status = 'ausente')
                                        ORDER BY s.class_date DESC, s.id DESC
                                    """, (item["id"], subject["id"]))
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
                            SELECT s.id, s.class_date, s.title, s.class_number, s.has_attendance,
                                   sub.name AS subject_name,
                                   CASE WHEN s.has_attendance = 0 OR ? IS NULL THEN '' ELSE COALESCE(a.status, 'ausente') END AS status
                            FROM sessions s JOIN subjects sub ON sub.id = s.subject_id
                            LEFT JOIN attendance a ON a.session_id = s.id AND a.student_id = ?
                            WHERE s.class_date >= ? AND s.class_date < ?
                            ORDER BY s.class_date, sub.name, s.class_number
                        """, (student_id, student_id, month + "-01", month + "-32"))
                    elif path == "/api/events/next-test":
                        next_test = con.execute("""
                            SELECT e.id, e.subject_id, sub.name AS subject_name,
                                   sub.abbreviation AS subject_abbreviation,
                                   e.event_date, e.event_time, e.event_type, e.title, e.details, sub.color
                            FROM calendar_events e
                            JOIN subjects sub ON sub.id = e.subject_id
                            WHERE e.event_type = 'Prueba' AND e.event_date >= ?
                            ORDER BY e.event_date,
                                     CASE WHEN e.event_time = '' THEN 1 ELSE 0 END,
                                     e.event_time, sub.name, e.title
                            LIMIT 1
                        """, (date.today().isoformat(),)).fetchone()
                        result = dict(next_test) if next_test else None
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
                                   sub.abbreviation AS subject_abbreviation,
                                   e.event_date, e.event_time, e.event_type, e.title, e.details, sub.color
                            FROM calendar_events e
                            JOIN subjects sub ON sub.id = e.subject_id
                            WHERE e.event_date >= ? AND e.event_date < ?
                              AND (? IS NULL OR e.subject_id = ?)
                            ORDER BY e.event_date,
                                     CASE WHEN e.event_time = '' THEN 1 ELSE 0 END,
                                     e.event_time, sub.name, e.title
                        """, (month + "-01", month + "-32", subject_id, subject_id))
                    else:
                        self.send_json({"error": "Ruta no encontrada."}, 404)
                        return
                self.send_json(result)
            except (ValueError, sqlite3.Error) as exc:
                self.send_json({"error": str(exc)}, 400)
            return
        name = path.lstrip("/")
        if name not in {"index.html", "style.css", "app.js", "favicon.svg", "manifest.webmanifest",
                        "service-worker.js", "icon-192.png", "icon-512.png"}:
            self.send_error(404)
            return
        file = STATIC / name
        mime = {"index.html": "text/html", "style.css": "text/css", "app.js": "text/javascript",
                "favicon.svg": "image/svg+xml", "manifest.webmanifest": "application/manifest+json",
                "service-worker.js": "text/javascript", "icon-192.png": "image/png",
                "icon-512.png": "image/png"}[name]
        raw = file.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", f"{mime}; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        try:
            if self.path in {"/api/students", "/api/subjects"} and not self.require_admin():
                return
            if self.path == "/api/events" and not self.require_admin():
                return
            if self.path == "/api/grade-settings" and not self.require_admin():
                return
            reset_parts = self.path.split("/")
            reset_request = (len(reset_parts) == 5 and reset_parts[:3] == ["", "api", "students"]
                             and reset_parts[4] == "reset-password")
            if reset_request and not self.require_admin():
                return
            if self.path == "/api/sessions" and not self.require_class_identity():
                return
            data = self.read_json()
            if self.path == "/api/notifications/subscribe":
                with connect() as con:
                    student_id = self.student_status(con)["student_id"]
                    if not student_id:
                        self.send_json({"error": "Inicia sesión como estudiante para activar notificaciones."}, 403)
                        return
                    endpoint = required_text(data, "endpoint", 2000)
                    keys = data.get("keys")
                    if not isinstance(keys, dict):
                        raise ValueError("La suscripción del dispositivo no es válida.")
                    p256dh = required_text(keys, "p256dh", 500)
                    auth = required_text(keys, "auth", 500)
                    now = int(time.time())
                    con.execute("""INSERT INTO push_subscriptions
                        (student_id, endpoint, p256dh, auth, created_at, last_seen)
                        VALUES (?, ?, ?, ?, ?, ?)
                        ON CONFLICT(endpoint) DO UPDATE SET student_id = excluded.student_id,
                            p256dh = excluded.p256dh, auth = excluded.auth, last_seen = excluded.last_seen""",
                        (student_id, endpoint, p256dh, auth, now, now))
                self.send_json({"subscribed": True})
                return
            if self.path == "/api/notifications/unsubscribe":
                with connect() as con:
                    student_id = self.student_status(con)["student_id"]
                    if not student_id:
                        self.send_json({"error": "Inicia sesión como estudiante."}, 403)
                        return
                    endpoint = required_text(data, "endpoint", 2000)
                    con.execute("DELETE FROM push_subscriptions WHERE endpoint = ? AND student_id = ?",
                                (endpoint, student_id))
                self.send_json({"subscribed": False})
                return
            if self.path == "/api/notifications/ack":
                if not self.notification_secret_valid():
                    self.send_json({"error": "Acceso no autorizado."}, 403)
                    return
                successful = data.get("successful", [])
                expired = data.get("expired_subscription_ids", [])
                if not isinstance(successful, list) or not isinstance(expired, list):
                    raise ValueError("Confirmación de notificaciones inválida.")
                with connect() as con:
                    now = int(time.time())
                    for item in successful[:1000]:
                        if not isinstance(item, dict):
                            continue
                        try:
                            event_id = positive_id(item, "event_id")
                            subscription_id = positive_id(item, "subscription_id")
                            reminder = positive_id(item, "reminder_minutes")
                        except ValueError:
                            continue
                        con.execute("""INSERT OR IGNORE INTO notification_deliveries
                            (event_id, subscription_id, reminder_minutes, sent_at)
                            VALUES (?, ?, ?, ?)""", (event_id, subscription_id, reminder, now))
                    for subscription_id in expired[:1000]:
                        if isinstance(subscription_id, int) and subscription_id > 0:
                            con.execute("DELETE FROM push_subscriptions WHERE id = ?", (subscription_id,))
                self.send_json({"acknowledged": len(successful)})
                return
            if self.path == "/api/grade-scores":
                evaluation_id = positive_id(data, "evaluation_id")
                with connect() as con:
                    student_id = self.student_status(con)["student_id"]
                    if not student_id:
                        self.send_json({"error": "Inicia sesión como estudiante para guardar tus notas."}, 403)
                        return
                    evaluation = con.execute(
                        "SELECT subject_id FROM grade_evaluations WHERE id = ?", (evaluation_id,)).fetchone()
                    if not evaluation:
                        raise ValueError("La evaluación seleccionada no existe.")
                    score_value = data.get("score")
                    if score_value is None or score_value == "":
                        con.execute("DELETE FROM grade_scores WHERE evaluation_id = ? AND student_id = ?",
                                    (evaluation_id, student_id))
                        con.execute("DELETE FROM grade_substitutions WHERE student_id = ? AND subject_id = ?",
                                    (student_id, evaluation["subject_id"]))
                        score = None
                    else:
                        score = required_number(data, "score", 1, 7)
                        con.execute("""INSERT INTO grade_scores (evaluation_id, student_id, score)
                            VALUES (?, ?, ?) ON CONFLICT(evaluation_id, student_id)
                            DO UPDATE SET score = excluded.score""", (evaluation_id, student_id, score))
                self.send_json({"evaluation_id": evaluation_id, "score": score,
                                "substitution_deleted": score is None})
                return
            if self.path == "/api/grade-substitution":
                evaluation_id = positive_id(data, "evaluation_id")
                with connect() as con:
                    student_id = self.student_status(con)["student_id"]
                    if not student_id:
                        self.send_json({"error": "Inicia sesión como estudiante para guardar tu sustitutiva."}, 403)
                        return
                    evaluation = con.execute("""SELECT ge.subject_id, ge.substitutable, ge.category
                        FROM grade_evaluations ge WHERE ge.id = ?""", (evaluation_id,)).fetchone()
                    if not evaluation or evaluation["category"] != "teorico" or not evaluation["substitutable"]:
                        raise ValueError("La evaluación seleccionada no puede sustituirse.")
                    pending = con.execute("""SELECT COUNT(*) FROM grade_evaluations ge
                        LEFT JOIN grade_scores gs ON gs.evaluation_id = ge.id AND gs.student_id = ?
                        WHERE ge.subject_id = ? AND gs.score IS NULL""",
                        (student_id, evaluation["subject_id"])).fetchone()[0]
                    if pending:
                        raise ValueError("Debes ingresar todas tus notas antes de registrar la sustitutiva.")
                    score_value = data.get("score")
                    score = None if score_value is None or score_value == "" else required_number(data, "score", 1, 7)
                    con.execute("""INSERT INTO grade_substitutions
                        (student_id, subject_id, evaluation_id, score) VALUES (?, ?, ?, ?)
                        ON CONFLICT(student_id, subject_id) DO UPDATE SET
                            evaluation_id = excluded.evaluation_id, score = excluded.score""",
                        (student_id, evaluation["subject_id"], evaluation_id, score))
                self.send_json({"evaluation_id": evaluation_id, "score": score})
                return
            if self.path == "/api/grade-exam-score":
                subject_id = positive_id(data, "subject_id")
                with connect() as con:
                    student_id = self.student_status(con)["student_id"]
                    if not student_id:
                        self.send_json({"error": "Inicia sesión como estudiante para guardar tu nota de examen."}, 403)
                        return
                    settings = con.execute("""SELECT exam_weight FROM grade_settings
                        WHERE subject_id = ?""", (subject_id,)).fetchone()
                    if not settings or settings["exam_weight"] <= 0:
                        raise ValueError("Este ramo no tiene un examen configurado.")
                    score_value = data.get("score")
                    if score_value is None or score_value == "":
                        con.execute("DELETE FROM grade_exam_scores WHERE student_id = ? AND subject_id = ?",
                                    (student_id, subject_id))
                        score = None
                    else:
                        score = required_number(data, "score", 1, 7)
                        con.execute("""INSERT INTO grade_exam_scores (student_id, subject_id, score)
                            VALUES (?, ?, ?) ON CONFLICT(student_id, subject_id)
                            DO UPDATE SET score = excluded.score""", (student_id, subject_id, score))
                self.send_json({"subject_id": subject_id, "score": score})
                return
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
                    admin_authenticated = self.admin_status(con)["authenticated"]
                    signed_student_id = self.student_status(con)["student_id"]
                    if not admin_authenticated and not signed_student_id:
                        self.send_json({"error": "Inicia sesión para descargar tus datos."}, 403)
                        return
                    student_ids = (selected_ids(con, data, "student_ids", "students")
                                   if admin_authenticated else [signed_student_id])
                    subject_ids = selected_ids(con, data, "subject_ids", "subjects")
                    sections = data.get("sections", ["attendance", "grades"])
                    if not isinstance(sections, list):
                        raise ValueError("Selecciona qué información quieres descargar.")
                    sections = list(dict.fromkeys(sections))
                    if not sections or any(item not in {"attendance", "grades"} for item in sections):
                        raise ValueError("Selecciona Notas, Asistencia o ambas.")
                    con.execute("BEGIN")
                    raw = make_export(con, student_ids, subject_ids, sections)
                filename = f"registro_academico_{date.today().isoformat()}.xlsx"
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
                if self.path == "/api/grade-settings":
                    subject_id = positive_id(data, "subject_id")
                    exists(con, "subjects", subject_id)
                    course_type = data.get("course_type")
                    if course_type not in {"teorico", "teorico_practico"}:
                        raise ValueError("Selecciona si el ramo es teórico o teórico-práctico.")
                    theoretical_weight = required_number(data, "theoretical_weight")
                    practical_weight = required_number(data, "practical_weight")
                    if course_type == "teorico":
                        theoretical_weight = 100
                        practical_weight = 0
                    if abs(theoretical_weight + practical_weight - 100) > 0.001:
                        raise ValueError("Las ponderaciones Teórica y Práctica deben sumar 100%.")
                    if course_type == "teorico_practico" and (
                            theoretical_weight <= 0 or practical_weight <= 0):
                        raise ValueError("En un ramo teórico-práctico ambas categorías deben tener ponderación.")
                    exemption_enabled = data.get("exemption_enabled") is True
                    exemption_grade = required_number(data, "exemption_grade", 1, 7)
                    exemption_scope = data.get("exemption_scope")
                    exam_weight = required_number(data, "exam_weight")
                    exam_scope = data.get("exam_scope")
                    exam_is_failing = data.get("exam_is_failing") is True
                    if exemption_scope not in {"teorico", "total"}:
                        raise ValueError("Selecciona cómo se calcula la nota de eximición.")
                    if exam_scope not in {"teorico", "total"}:
                        raise ValueError("Selecciona dónde se aplica el examen.")
                    if course_type == "teorico":
                        exemption_scope = "teorico"
                        exam_scope = "teorico"
                    evaluations = data.get("evaluations")
                    if not isinstance(evaluations, list) or len(evaluations) > 100:
                        raise ValueError("La lista de evaluaciones no es válida.")
                    clean_evaluations = []
                    seen_evaluation_ids = set()
                    for evaluation in evaluations:
                        if not isinstance(evaluation, dict):
                            raise ValueError("Una evaluación contiene datos inválidos.")
                        name = required_text(evaluation, "name")
                        category = evaluation.get("category")
                        if category not in {"teorico", "practico"}:
                            raise ValueError("Selecciona una categoría válida para cada evaluación.")
                        if course_type == "teorico" and category == "practico":
                            raise ValueError("Un ramo solo teórico no puede contener evaluaciones prácticas.")
                        weight = required_number(evaluation, "weight")
                        sort_order = positive_id({"sort_order": evaluation.get("sort_order", 1)}, "sort_order")
                        substitutable = evaluation.get("substitutable") is True
                        if category == "practico":
                            substitutable = False
                        evaluation_id = None
                        if evaluation.get("id") not in {None, ""}:
                            evaluation_id = positive_id(evaluation, "id")
                            if evaluation_id in seen_evaluation_ids or not con.execute(
                                    "SELECT 1 FROM grade_evaluations WHERE id = ? AND subject_id = ?",
                                    (evaluation_id, subject_id)).fetchone():
                                raise ValueError("Una evaluación seleccionada no es válida para este ramo.")
                            seen_evaluation_ids.add(evaluation_id)
                        clean_evaluations.append((evaluation_id, name, category, weight, substitutable, sort_order))
                    theoretical_evaluations = [item for item in clean_evaluations if item[2] == "teorico"]
                    practical_evaluations = [item for item in clean_evaluations if item[2] == "practico"]
                    if not theoretical_evaluations:
                        raise ValueError("Agrega al menos una evaluación teórica.")
                    if abs(sum(item[3] for item in theoretical_evaluations) - 100) > 0.001:
                        raise ValueError("Las evaluaciones teóricas deben sumar 100%.")
                    if course_type == "teorico_practico":
                        if not practical_evaluations:
                            raise ValueError("Agrega al menos una evaluación práctica.")
                        if abs(sum(item[3] for item in practical_evaluations) - 100) > 0.001:
                            raise ValueError("Las evaluaciones prácticas deben sumar 100%.")
                    con.execute("""INSERT INTO grade_settings
                        (subject_id, course_type, theoretical_weight, practical_weight, exemption_enabled,
                         exemption_grade, exemption_scope, exam_weight, exam_scope, exam_is_failing)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(subject_id) DO UPDATE SET
                            course_type = excluded.course_type,
                            theoretical_weight = excluded.theoretical_weight,
                            practical_weight = excluded.practical_weight,
                            exemption_enabled = excluded.exemption_enabled,
                            exemption_grade = excluded.exemption_grade,
                            exemption_scope = excluded.exemption_scope,
                            exam_weight = excluded.exam_weight,
                            exam_scope = excluded.exam_scope,
                            exam_is_failing = excluded.exam_is_failing""",
                        (subject_id, course_type, theoretical_weight, practical_weight, int(exemption_enabled),
                         exemption_grade, exemption_scope, exam_weight, exam_scope, int(exam_is_failing)))
                    existing_ids = {row[0] for row in con.execute(
                        "SELECT id FROM grade_evaluations WHERE subject_id = ?", (subject_id,))}
                    for evaluation_id in existing_ids - seen_evaluation_ids:
                        con.execute("DELETE FROM grade_evaluations WHERE id = ?", (evaluation_id,))
                    for evaluation_id, name, category, weight, substitutable, sort_order in clean_evaluations:
                        if evaluation_id:
                            con.execute("""UPDATE grade_evaluations
                                SET name = ?, category = ?, weight = ?, substitutable = ?, sort_order = ?
                                WHERE id = ?""",
                                (name, category, weight, int(substitutable), sort_order, evaluation_id))
                        else:
                            con.execute("""INSERT INTO grade_evaluations
                                (subject_id, name, category, weight, substitutable, sort_order)
                                VALUES (?, ?, ?, ?, ?, ?)""",
                                (subject_id, name, category, weight, int(substitutable), sort_order))
                    con.execute("""DELETE FROM grade_substitutions
                        WHERE subject_id = ? AND evaluation_id NOT IN (
                            SELECT id FROM grade_evaluations
                            WHERE subject_id = ? AND category = 'teorico' AND substitutable = 1
                        )""", (subject_id, subject_id))
                    if exam_weight <= 0:
                        con.execute("DELETE FROM grade_exam_scores WHERE subject_id = ?", (subject_id,))
                    result = {"saved": True, "subject_id": subject_id}
                elif self.path == "/api/students":
                    name = required_text(data, "name")
                    cur = con.execute("INSERT INTO students (name) VALUES (?)", (name,))
                    code = issue_activation(con, cur.lastrowid)
                    result = {"id": cur.lastrowid, "name": name, "activation_code": code}
                elif self.path == "/api/subjects":
                    name = required_text(data, "name")
                    color = required_color(data)
                    abbreviation = required_abbreviation(data)
                    cur = con.execute("INSERT INTO subjects (name, color, abbreviation) VALUES (?, ?, ?)",
                                      (name, color, abbreviation))
                    result = {"id": cur.lastrowid, "name": name, "color": color,
                              "abbreviation": abbreviation}
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
                    has_attendance = data.get("has_attendance", True)
                    if not isinstance(has_attendance, bool):
                        raise ValueError("Indica si la clase tuvo lista de asistencia.")
                    con.execute("BEGIN IMMEDIATE")
                    class_number = con.execute("""SELECT COALESCE(MAX(class_number), 0) + 1 FROM sessions
                                                  WHERE subject_id = ? AND class_date = ?""", (subject_id, class_date)).fetchone()[0]
                    cur = con.execute("""INSERT INTO sessions
                        (subject_id, class_date, title, class_number, has_attendance)
                        VALUES (?, ?, ?, ?, ?)""",
                                      (subject_id, class_date, title, class_number, int(has_attendance)))
                    result = {"id": cur.lastrowid, "subject_id": subject_id, "class_date": class_date,
                              "title": title, "class_number": class_number,
                              "has_attendance": int(has_attendance)}
                elif self.path == "/api/attendance":
                    session_id = positive_id(data, "session_id")
                    student_id = positive_id(data, "student_id")
                    status = data.get("status")
                    if status not in {"presente", "ausente", "justificado"}:
                        raise ValueError("Selecciona un estado de asistencia válido.")
                    session = con.execute("SELECT has_attendance FROM sessions WHERE id = ?", (session_id,)).fetchone()
                    if not session:
                        raise ValueError("La clase no existe.")
                    if not session["has_attendance"]:
                        raise ValueError("Esta clase no tuvo lista de asistencia.")
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
                    event_time = optional_time(data)
                    event_type = required_text(data, "event_type", 30)
                    if event_type not in {"Prueba", "Presentación", "Clase", "Otro"}:
                        raise ValueError("Selecciona un tipo de evento válido.")
                    title = required_text(data, "title")
                    details = data.get("details", "")
                    if not isinstance(details, str) or len(details.strip()) > 300:
                        raise ValueError("La descripción es demasiado larga.")
                    cur = con.execute("""INSERT INTO calendar_events
                        (subject_id, event_date, event_time, event_type, title, details) VALUES (?, ?, ?, ?, ?, ?)""",
                        (subject_id, event_date, event_time, event_type, title, details.strip()))
                    result = {"id": cur.lastrowid, "subject_id": subject_id, "event_date": event_date,
                              "event_time": event_time, "event_type": event_type, "title": title,
                              "details": details.strip()}
                else:
                    self.send_json({"error": "Ruta no encontrada."}, 404)
                    return
            self.send_json(result, 201)
        except sqlite3.IntegrityError:
            self.send_json({"error": "Ese registro ya existe."}, 409)
        except (ValueError, json.JSONDecodeError) as exc:
            self.send_json({"error": str(exc)}, 400)

    def do_PATCH(self):
        if urlparse(self.path).path == "/api/profile":
            try:
                data = self.read_json()
                with connect() as con:
                    student_id = self.student_status(con)["student_id"]
                    if not student_id:
                        self.send_json({"error": "Inicia sesión como estudiante para editar tu perfil."}, 403)
                        return
                    name = required_text(data, "name")
                    bio = data.get("bio", "")
                    if not isinstance(bio, str) or len(bio.strip()) > 240:
                        raise ValueError("La biografía puede tener hasta 240 caracteres.")
                    avatar_data = data.get("avatar_data", "")
                    if not isinstance(avatar_data, str) or len(avatar_data) > 100_000:
                        raise ValueError("La foto de perfil es demasiado grande.")
                    if avatar_data and not avatar_data.startswith("data:image/jpeg;base64,"):
                        raise ValueError("La foto de perfil no tiene un formato válido.")
                    con.execute("UPDATE students SET name = ?, bio = ?, avatar_data = ? WHERE id = ?",
                                (name, bio.strip(), avatar_data, student_id))
                    result = {"student_id": student_id, "name": name, "bio": bio.strip(),
                              "avatar_data": avatar_data}
                self.send_json(result)
            except sqlite3.IntegrityError:
                self.send_json({"error": "Ya existe un estudiante con ese nombre."}, 409)
            except (ValueError, json.JSONDecodeError) as exc:
                self.send_json({"error": str(exc)}, 400)
            return
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
                        event_time = optional_time(data)
                        event_type = required_text(data, "event_type", 30)
                        if event_type not in {"Prueba", "Presentación", "Clase", "Otro"}:
                            raise ValueError("Selecciona un tipo de evento válido.")
                        title = required_text(data, "title")
                        details = data.get("details", "")
                        if not isinstance(details, str) or len(details.strip()) > 300:
                            raise ValueError("La descripción es demasiado larga.")
                        con.execute("""UPDATE calendar_events SET subject_id = ?, event_date = ?, event_time = ?,
                            event_type = ?, title = ?, details = ? WHERE id = ?""",
                            (subject_id, event_date, event_time, event_type, title, details.strip(), item_id))
                        result = {"id": item_id, "subject_id": subject_id, "event_date": event_date,
                                  "event_time": event_time, "event_type": event_type, "title": title,
                                  "details": details.strip()}
                    else:
                        con.execute("DELETE FROM calendar_events WHERE id = ?", (item_id,))
                        result = {"deleted": item_id}
                elif table == "sessions":
                    con.execute("BEGIN IMMEDIATE")
                    original = con.execute("""SELECT subject_id, class_date, class_number, has_attendance FROM sessions
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
                        has_attendance = data.get("has_attendance", bool(original["has_attendance"]))
                        if not isinstance(has_attendance, bool):
                            raise ValueError("Indica si la clase tuvo lista de asistencia.")
                        moved = subject_id != original["subject_id"] or class_date != original["class_date"]
                        class_number = (con.execute("""SELECT COALESCE(MAX(class_number), 0) + 1 FROM sessions
                                                      WHERE subject_id = ? AND class_date = ?""",
                                                    (subject_id, class_date)).fetchone()[0]
                                        if moved else original["class_number"])
                        con.execute("""UPDATE sessions SET subject_id = ?, class_date = ?, title = ?,
                                       class_number = ?, has_attendance = ? WHERE id = ?""",
                                    (subject_id, class_date, title, class_number,
                                     int(has_attendance), item_id))
                        result = {"id": item_id, "subject_id": subject_id, "class_date": class_date,
                                  "title": title, "class_number": class_number,
                                  "has_attendance": int(has_attendance)}
                    else:
                        con.execute("DELETE FROM sessions WHERE id = ?", (item_id,))
                        result = {"deleted": item_id}
                    if method == "DELETE" or moved:
                        renumber_group(con, original["subject_id"], original["class_date"])
                elif method == "PATCH" and table == "subjects":
                    name = required_text(data, "name")
                    color = required_color(data)
                    abbreviation = required_abbreviation(data)
                    con.execute("UPDATE subjects SET name = ?, color = ?, abbreviation = ? WHERE id = ?",
                                (name, color, abbreviation, item_id))
                    result = {"id": item_id, "name": name, "color": color,
                              "abbreviation": abbreviation}
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
    lan_mode = len(sys.argv) == 2 and sys.argv[1] == "--lan"
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
    if len(sys.argv) != 1 and not lan_mode:
        print("Uso: python server.py [--lan|--status-db|--setup-admin|--reset-admin|--import-db RUTA]", file=sys.stderr)
        sys.exit(2)
    port = int(os.environ.get("PORT", "10000" if PUBLIC_MODE else "8000"))
    if not 1 <= port <= 65535:
        raise ValueError("PORT debe estar entre 1 y 65535.")
    address = ("0.0.0.0" if PUBLIC_MODE or lan_mode else "127.0.0.1", port)
    try:
        server = SingleInstanceHTTPServer(address, Handler)
    except OSError as exc:
        print(f"No se pudo iniciar el servidor en el puerto {port}. ", end="", file=sys.stderr)
        print("Cierra la otra ventana de Registro de asistencia e inténtalo nuevamente.", file=sys.stderr)
        sys.exit(1)
    print(f"Registro de asistencia escuchando en {address[0]}:{address[1]}")
    if lan_mode:
        print(f"Modo de prueba en red local activo. Abre http://IP-DE-TU-PC:{port} desde el teléfono.")
    print("Presiona Ctrl+C para detener el programa.")
    server.serve_forever()
