"""Exporta la selección del registro a un libro XLSX sin dependencias externas."""

from datetime import date, datetime
from html import escape
from io import BytesIO
from math import floor
from zipfile import ZIP_DEFLATED, ZipFile


class Percent(float):
    pass


def rounded_grade(value):
    return floor(float(value) * 10 + 0.500000001) / 10


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


def make_export(con, student_ids, subject_ids, sections=("attendance", "grades")):
    sections = set(sections)
    student_params = ",".join("?" for _ in student_ids)
    subject_params = ",".join("?" for _ in subject_ids)
    students = [dict(row) for row in con.execute(
        f"SELECT id, name FROM students WHERE id IN ({student_params}) ORDER BY name", student_ids
    )]
    subjects = [dict(row) for row in con.execute(
        f"SELECT id, name FROM subjects WHERE id IN ({subject_params}) ORDER BY name", subject_ids
    )]
    grade_settings = {row["subject_id"]: dict(row) for row in con.execute(f"""
        SELECT sub.id AS subject_id, sub.name AS subject_name,
               COALESCE(gs.course_type, 'teorico') AS course_type,
               COALESCE(gs.theoretical_weight, 100) AS theoretical_weight,
               COALESCE(gs.practical_weight, 0) AS practical_weight,
               COALESCE(gs.exemption_enabled, 0) AS exemption_enabled,
               COALESCE(gs.exemption_grade, 5) AS exemption_grade,
               COALESCE(gs.exemption_scope, 'total') AS exemption_scope,
               COALESCE(gs.exam_weight, 0) AS exam_weight,
               COALESCE(gs.exam_scope, 'total') AS exam_scope,
               COALESCE(gs.exam_is_failing, 0) AS exam_is_failing
        FROM subjects sub LEFT JOIN grade_settings gs ON gs.subject_id = sub.id
        WHERE sub.id IN ({subject_params}) ORDER BY sub.name
    """, subject_ids)}
    evaluations = [dict(row) for row in con.execute(f"""
        SELECT ge.id, ge.subject_id, sub.name AS subject_name, ge.name, ge.category,
               ge.weight, ge.substitutable, ge.sort_order
        FROM grade_evaluations ge JOIN subjects sub ON sub.id = ge.subject_id
        WHERE ge.subject_id IN ({subject_params})
        ORDER BY sub.name, CASE ge.category WHEN 'teorico' THEN 0 ELSE 1 END,
                 ge.sort_order, ge.id
    """, subject_ids)]
    evaluation_ids = [item["id"] for item in evaluations]
    grade_scores = {}
    if evaluation_ids:
        evaluation_params = ",".join("?" for _ in evaluation_ids)
        grade_scores = {(row["student_id"], row["evaluation_id"]): row["score"]
                        for row in con.execute(f"""
            SELECT student_id, evaluation_id, score FROM grade_scores
            WHERE student_id IN ({student_params}) AND evaluation_id IN ({evaluation_params})
        """, [*student_ids, *evaluation_ids])}
    substitutions = {(row["student_id"], row["subject_id"]): dict(row)
                     for row in con.execute(f"""
        SELECT student_id, subject_id, evaluation_id, score FROM grade_substitutions
        WHERE student_id IN ({student_params}) AND subject_id IN ({subject_params})
    """, [*student_ids, *subject_ids])}
    exam_scores = {(row["student_id"], row["subject_id"]): row["score"]
                   for row in con.execute(f"""
        SELECT student_id, subject_id, score FROM grade_exam_scores
        WHERE student_id IN ({student_params}) AND subject_id IN ({subject_params})
    """, [*student_ids, *subject_ids])}
    sessions = [dict(row) for row in con.execute(f"""
        SELECT s.id, s.class_date, s.title, s.class_number, s.has_attendance,
               s.subject_id, sub.name AS subject_name
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
        if session["has_attendance"]:
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
            session["class_number"], session["title"],
            "Con lista" if session["has_attendance"] else "Sin lista",
            counts["presente"] if session["has_attendance"] else None,
            counts["ausente"] if session["has_attendance"] else None,
            counts["justificado"] if session["has_attendance"] else None
        ])
    for student in students:
        for subject in subjects:
            total, present, absent, justified = counters[(student["id"], subject["id"])]
            summary.append([
                student["name"], subject["name"], total, present, absent, justified,
                Percent(present / total) if total else None
            ])
    evaluations_by_subject = {subject["id"]: [] for subject in subjects}
    for evaluation in evaluations:
        evaluations_by_subject[evaluation["subject_id"]].append(evaluation)

    def category_average(student_id, subject_id, category):
        entries = [item for item in evaluations_by_subject[subject_id] if item["category"] == category]
        if not entries:
            return None, False
        substitution = substitutions.get((student_id, subject_id))
        values = []
        for item in entries:
            score = grade_scores.get((student_id, item["id"]))
            if substitution and substitution["evaluation_id"] == item["id"] and substitution["score"] is not None:
                score = substitution["score"]
            values.append((item, score))
        complete = all(score is not None for _, score in values)
        entered = [(item, score) for item, score in values if score is not None]
        entered_weight = sum(float(item["weight"]) for item, _ in entered)
        average = (sum(float(score) * float(item["weight"]) for item, score in entered) / entered_weight
                   if entered_weight else None)
        return average, complete

    grade_rows = []
    grade_summary_rows = []
    for student in students:
        for subject in subjects:
            subject_id = subject["id"]
            settings = grade_settings[subject_id]
            substitution = substitutions.get((student["id"], subject_id))
            for evaluation in evaluations_by_subject[subject_id]:
                original = grade_scores.get((student["id"], evaluation["id"]))
                substitution_score = (substitution["score"] if substitution
                                      and substitution["evaluation_id"] == evaluation["id"] else None)
                effective = substitution_score if substitution_score is not None else original
                grade_rows.append([
                    student["name"], subject["name"],
                    "Teórico" if evaluation["category"] == "teorico" else "Práctico",
                    evaluation["name"], Percent(float(evaluation["weight"]) / 100),
                    "Sí" if evaluation["substitutable"] else "No",
                    original, substitution_score, effective
                ])
            theoretical, theoretical_complete = category_average(student["id"], subject_id, "teorico")
            practical, practical_complete = category_average(student["id"], subject_id, "practico")
            practical_course = settings["course_type"] == "teorico_practico"
            coursework = theoretical
            if practical_course and theoretical is not None and practical is not None:
                total_category_weight = float(settings["theoretical_weight"]) + float(settings["practical_weight"])
                coursework = ((theoretical * float(settings["theoretical_weight"])
                               + practical * float(settings["practical_weight"])) / total_category_weight
                              if total_category_weight else None)
            exam = exam_scores.get((student["id"], subject_id))
            final_average = coursework
            exam_weight = float(settings["exam_weight"]) / 100
            if exam is not None and exam_weight > 0:
                if settings["exam_scope"] == "total" and coursework is not None:
                    final_average = coursework * (1 - exam_weight) + float(exam) * exam_weight
                elif settings["exam_scope"] == "teorico" and theoretical is not None:
                    theoretical_with_exam = theoretical * (1 - exam_weight) + float(exam) * exam_weight
                    if practical_course and practical is not None:
                        final_average = (theoretical_with_exam * float(settings["theoretical_weight"])
                                         + practical * float(settings["practical_weight"])) / 100
                    else:
                        final_average = theoretical_with_exam
            theoretical_failed = theoretical_complete and theoretical is not None and rounded_grade(theoretical) < 4
            practical_failed = practical_course and practical_complete and practical is not None and rounded_grade(practical) < 4
            exam_failed = bool(settings["exam_is_failing"] and exam is not None and rounded_grade(exam) < 4)
            exemption_average = theoretical if settings["exemption_scope"] == "teorico" else coursework
            exemption_complete = theoretical_complete if settings["exemption_scope"] == "teorico" else (
                theoretical_complete and (not practical_course or practical_complete))
            all_complete = theoretical_complete and (not practical_course or practical_complete)
            if theoretical_failed or practical_failed or exam_failed:
                status = "Reprobado"
            elif settings["exemption_enabled"] and exemption_complete and exemption_average is not None \
                    and rounded_grade(exemption_average) >= float(settings["exemption_grade"]):
                status = "Eximido"
            elif all_complete:
                status = "No eximido"
            else:
                status = "En curso"
            grade_summary_rows.append([
                student["name"], subject["name"], theoretical,
                practical if practical_course else None, coursework, exam, final_average, status
            ])
    grade_configuration_rows = [[
        settings["subject_name"],
        "Teórico-práctico" if settings["course_type"] == "teorico_practico" else "Solo teórico",
        Percent(float(settings["theoretical_weight"]) / 100),
        Percent(float(settings["practical_weight"]) / 100),
        "Sí" if settings["exemption_enabled"] else "No", settings["exemption_grade"],
        "Solo teórico" if settings["exemption_scope"] == "teorico" else "Teórico + Práctico",
        Percent(float(settings["exam_weight"]) / 100),
        "Nota teórica" if settings["exam_scope"] == "teorico" else "Nota total",
        "Sí" if settings["exam_is_failing"] else "No"
    ] for settings in grade_settings.values()]
    selection = [
        ["Exportado el", datetime.now().strftime("%Y-%m-%d %H:%M")],
        ["Estudiantes incluidos", len(students)],
        ["Ramos incluidos", len(subjects)],
        ["Clases incluidas", len(sessions)],
        ["Clases con lista", sum(1 for session in sessions if session["has_attendance"])],
        ["Registros de asistencia", len(attendance_rows)],
        ["Evaluaciones configuradas", len(evaluations)],
        ["Registros de notas", len(grade_rows)],
        ["Regla de ausencia", "Sin marca de asistencia = ausente"],
        ["Porcentaje", "Presentes / total de clases; justificadas aparte"],
        ["Uso del archivo", "Exportación para consulta; no reemplaza la base SQLite para restaurar el programa"],
    ]
    sheets = {}
    if "attendance" in sections:
        sheets.update({
            "Resumen asistencia": (["Estudiante", "Ramo", "Clases", "Presentes", "Ausentes", "Justificadas", "Asistencia (%)"], summary),
            "Clases": (["ID clase", "Fecha", "Ramo", "N° clase", "Tema", "Control de asistencia", "Presentes", "Ausentes", "Justificadas"], class_rows),
            "Asistencia": (["ID clase", "Fecha", "Ramo", "N° clase", "Tema", "ID estudiante", "Estudiante", "Estado", "Registro"], attendance_rows),
        })
    if "grades" in sections:
        sheets.update({
            "Resumen notas": (["Estudiante", "Ramo", "Promedio teórico", "Promedio práctico", "Promedio teórico-práctico", "Examen", "Promedio final", "Estado"], grade_summary_rows),
            "Notas": (["Estudiante", "Ramo", "Categoría", "Evaluación", "Ponderación (%)", "Sustituible", "Nota original", "Nota sustitutiva", "Nota considerada"], grade_rows),
            "Configuración notas": (["Ramo", "Tipo", "Ponderación teórica", "Ponderación práctica", "Permite eximirse", "Nota de eximición", "Promedio para eximirse", "Ponderación examen", "Examen sobre", "Examen reprobatorio"], grade_configuration_rows),
        })
    sheets.update({
        "Estudiantes": (["ID estudiante", "Nombre"], [[student["id"], student["name"]] for student in students]),
        "Ramos": (["ID ramo", "Nombre"], [[subject["id"], subject["name"]] for subject in subjects]),
        "Información": (["Dato", "Valor"], selection),
    })
    return workbook_bytes(sheets)
