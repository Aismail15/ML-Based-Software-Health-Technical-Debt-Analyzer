import unittest

from typer.testing import CliRunner

from cli.main import app


class CliHelpTests(unittest.TestCase):
    def test_cli_help_lists_analysis_options(self):
        runner = CliRunner()
        result = runner.invoke(app, ["analyze", "--help"])
        self.assertEqual(result.exit_code, 0)
        self.assertIn("--max-commits", result.stdout)
        self.assertIn("--observation-commits", result.stdout)
        self.assertIn("--output", result.stdout)
        self.assertIn("--exclude", result.stdout)
