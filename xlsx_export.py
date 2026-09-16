"""Exporta la selección del registro a un libro XLSX sin dependencias externas."""

from datetime import date, datetime
from html import escape
from io import BytesIO
from zipfile import ZIP_DEFLATED, ZipFile


class Percent(float):
    pass


def text_value(value):
    cleaned = "".join(char for char in str(value) if ord(char) >= 32 or char in "\t\n\r")
    return escape(cleaned, quote=True)


def column_name(number):
    result = ""
    while number:
        number, remainder = divmod(number - 1, 26)
        result = chr(65 + remainder) + result
    return result


def sheet_xml(headers, data):
    all_rows = [headers] + data
    widths = []
    for index, header in enumerate(headers):
        samples = [len(str(row[index])) for row in data[:300] if index < len(row) and row[index] is not None]
        widths.append(min(46, max(13, len(header) + 3, *(samples or [0])) + 2))
    columns = "".join(
        f'<col min="{index}" max="{index}" width="{width}" customWidth="1"/>'
        for index, width in enumerate(widths, 1)
    )
    records = []
    for row_number, row in enumerate(all_rows, 1):
        cells = []
        for index, value in enumerate(row, 1):
            if value is None:
                continue
            ref = f"{column_name(index)}{row_number}"
            if row_number == 1:
                cells.append(f'<c r="{ref}" s="1" t="inlineStr"><is><t>{text_value(value)}</t></is></c>')
            elif isinstance(value, date):
                serial = (value - date(1899, 12, 30)).days
                cells.append(f'<c r="{ref}" s="2"><v>{serial}</v></c>')
            elif isinstance(value, Percent):
                cells.append(f'<c r="{ref}" s="3"><v>{float(value):.8f}</v></c>')
            elif isinstance(value, (int, float)) and not isinstance(value, bool):
                cells.append(f'<c r="{ref}"><v>{value}</v></c>')
            else:
                cells.append(f'<c r="{ref}" t="inlineStr"><is><t>{text_value(value)}</t></is></c>')
        height = ' ht="29" customHeight="1"' if row_number == 1 else ''
        records.append(f'<row r="{row_number}"{height}>{"".join(cells)}</row>')
    last = f"{column_name(len(headers))}{len(all_rows)}"
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f'<dimension ref="A1:{last}"/><sheetViews><sheetView workbookViewId="0">'
        '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
        '</sheetView></sheetViews>'
        f'<cols>{columns}</cols><sheetData>{"".join(records)}</sheetData>'
        f'<autoFilter ref="A1:{last}"/></worksheet>'
    ).encode("utf-8")


def workbook_bytes(sheets):
    names = list(sheets)
    workbook = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheets>' + "".join(
            f'<sheet name="{text_value(name)}" sheetId="{index}" r:id="rId{index}"/>'
            for index, name in enumerate(names, 1)
        ) + '</sheets></workbook>'
    )
    relations = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + "".join(
            f'<Relationship Id="rId{index}" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
            f'Target="worksheets/sheet{index}.xml"/>'
            for index in range(1, len(names) + 1)
        ) + '<Relationship Id="rIdStyles" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" '
        'Target="styles.xml"/></Relationships>'
    )
    root_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
        'Target="xl/workbook.xml"/></Relationships>'
    )
    types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/styles.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        + "".join(
            f'<Override PartName="/xl/worksheets/sheet{index}.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            for index in range(1, len(names) + 1)
        ) + '</Types>'
    )
    styles = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<numFmts count="2"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/>'
        '<numFmt numFmtId="165" formatCode="0.0%"/></numFmts>'
        '<fonts count="2"><font><sz val="11"/><name val="Aptos"/></font>'
        '<font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Aptos"/></font></fonts>'
        '<fills count="2"><fill><patternFill patternType="none"/></fill>'
        '<fill><patternFill patternType="solid"><fgColor rgb="FF1767CC"/><bgColor indexed="64"/>'
        '</patternFill></fill></fills>'
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        '<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        '<xf numFmtId="0" fontId="1" fillId="1" borderId="0" xfId="0" applyFont="1" applyFill="1"/>'
        '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
        '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
        '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/>'
        '</cellStyles></styleSheet>'
    )
    output = BytesIO()
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", types)
        archive.writestr("_rels/.rels", root_rels)
        archive.writestr("xl/workbook.xml", workbook)
        archive.writestr("xl/_rels/workbook.xml.rels", relations)
        archive.writestr("xl/styles.xml", styles)
        for index, (headers, data) in enumerate(sheets.values(), 1):
            archive.writestr(f"xl/worksheets/sheet{index}.xml", sheet_xml(headers, data))
    return output.getvalue()


def make_export(con, student_ids, subject_ids):
    student_params = ",".join("?" for _ in student_ids)
    subject_params = ",".join("?" for _ in subject_ids)
    students = [dict(row) for row in con.execute(
        f"SELECT id, name FROM students WHERE id IN ({student_params}) ORDER BY name", student_ids
    )]
    subjects = [dict(row) for row in con.execute(
        f"SELECT id, name FROM subjects WHERE id IN ({subject_params}) ORDER BY name", subject_ids
    )]
    sessions = [dict(row) for row in con.execute(f"""
        SELECT s.id, s.class_date, s.title, s.class_number, s.subject_id, sub.name AS subject_name
        FROM sessions s JOIN subjects sub ON sub.id = s.subject_id
        WHERE s.subject_id IN ({subject_params}) ORDER BY s.class_date, sub.name, s.class_number
    """, subject_ids)]
    attendance = {(row["session_id"], row["student_id"]): row["status"] for row in con.execute(f"""
        SELECT session_id, student_id, status FROM attendance
        WHERE student_id IN ({student_params})
    """, student_ids)}
    if len(sessions) * len(students) > 500_000:
        raise ValueError("La selección contiene demasiados registros para un solo Excel.")
    summary = []
    class_rows = []
    attendance_rows = []
    counters = {(student["id"], subject["id"]): [0, 0, 0, 0]
                for student in students for subject in subjects}
    for session in sessions:
        counts = {"presente": 0, "ausente": 0, "justificado": 0}
        for student in students:
            stored = attendance.get((session["id"], student["id"]))
            status = stored or "ausente"
            counts[status] += 1
            count = counters[(student["id"], session["subject_id"])]
            count[0] += 1
            count[{"presente": 1, "ausente": 2, "justificado": 3}[status]] += 1
            attendance_rows.append([
                session["id"], date.fromisoformat(session["class_date"]), session["subject_name"],
                session["class_number"], session["title"], student["id"], student["name"],
                status.capitalize(), "Marcado" if stored else "Automático (sin marca)"
            ])
        class_rows.append([
            session["id"], date.fromisoformat(session["class_date"]), session["subject_name"],
            session["class_number"], session["title"], counts["presente"], counts["ausente"],
            counts["justificado"]
        ])
    for student in students:
        for subject in subjects:
            total, present, absent, justified = counters[(student["id"], subject["id"])]
            summary.append([
                student["name"], subject["name"], total, present, absent, justified,
                Percent(present / total) if total else None
            ])
    selection = [
        ["Exportado el", datetime.now().strftime("%Y-%m-%d %H:%M")],
        ["Estudiantes incluidos", len(students)],
        ["Ramos incluidos", len(subjects)],
        ["Clases incluidas", len(sessions)],
        ["Registros de asistencia", len(attendance_rows)],
        ["Regla de ausencia", "Sin marca de asistencia = ausente"],
        ["Porcentaje", "Presentes / total de clases; justificadas aparte"],
        ["Uso del archivo", "Exportación para consulta; no reemplaza la base SQLite para restaurar el programa"],
    ]
    sheets = {
        "Resumen": (["Estudiante", "Ramo", "Clases", "Presentes", "Ausentes", "Justificadas", "Asistencia (%)"], summary),
        "Clases": (["ID clase", "Fecha", "Ramo", "N° clase", "Tema", "Presentes", "Ausentes", "Justificadas"], class_rows),
        "Asistencia": (["ID clase", "Fecha", "Ramo", "N° clase", "Tema", "ID estudiante", "Estudiante", "Estado", "Registro"], attendance_rows),
        "Estudiantes": (["ID estudiante", "Nombre"], [[student["id"], student["name"]] for student in students]),
        "Ramos": (["ID ramo", "Nombre"], [[subject["id"], subject["name"]] for subject in subjects]),
        "Información": (["Dato", "Valor"], selection),
    }
    return workbook_bytes(sheets)
