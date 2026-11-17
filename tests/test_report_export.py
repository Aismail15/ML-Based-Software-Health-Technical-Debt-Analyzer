import json
from pathlib import Path
import tempfile
import unittest

from analysis.report_export import render_report, write_report


class ReportExportTests(unittest.TestCase):
    def _sample_report(self):
        return {
            "schema_version": 1,
            "status": "complete",
            "files": [
                {
                    "path": "src/app.py",
                    "metrics": {"loc": 120, "cyclomatic_complexity_max": 12},
                    "result": {
                        "risk_score": None,
                        "risk_score_kind": "unavailable",
                        "maintainability_findings": [
                            {"rule": "complex_function", "reason": "cc > 10", "suggestion": "split"}
                        ],
                    },
                },
                {
                    "path": "=formula.py",
                    "metrics": {"loc": 10, "cyclomatic_complexity_max": 1},
                    "result": {
                        "risk_score": 0.25,
                        "risk_score_kind": "relative_ranking_not_calibrated_probability",
                        "maintainability_findings": [],
                    },
                },
            ],
        }

    def test_render_json_and_csv_preserves_findings_and_escapes_formulas(self):
        report = self._sample_report()
        parsed = json.loads(render_report(report, "json"))
        self.assertEqual(len(parsed["files"]), 2)

        csv_text = render_report(report, "csv")
        self.assertIn("src/app.py,,unavailable,120,12,1,complex_function", csv_text)
        self.assertIn("'=formula.py,0.25", csv_text)

    def test_invalid_format_and_existing_file_protection(self):
        report = self._sample_report()
        with self.assertRaises(ValueError):
            render_report(report, "xml")

        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "report.json"
            write_report(out, report)
            self.assertTrue(out.exists())
            with self.assertRaises(FileExistsError):
                write_report(out, report)
