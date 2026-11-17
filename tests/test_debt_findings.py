import unittest

from model.debt_estimator import DebtEstimator


class DebtFindingsTests(unittest.TestCase):
    def test_untrained_estimator_returns_unavailable_risk_and_all_rule_findings(self):
        estimator = DebtEstimator()
        metrics = {
            "cyclomatic_complexity": 4.0,
            "cyclomatic_complexity_max": 12.0,
            "halstead_volume": 1200.0,
            "halstead_difficulty": 55.0,
            "halstead_effort": 66000.0,
            "loc": 350,
            "num_functions": 8,
        }
        result = estimator.estimate_debt(metrics)
        self.assertIsNone(result["risk_score"])
        self.assertEqual(result["risk_score_kind"], "unavailable")
        rules = [item["rule"] for item in result["maintainability_findings"]]
        self.assertEqual(rules, ["complex_function", "large_file", "dense_expressions"])

    def test_clean_metrics_produce_no_maintainability_findings(self):
        estimator = DebtEstimator()
        metrics = {
            "cyclomatic_complexity": 2.0,
            "cyclomatic_complexity_max": 3.0,
            "halstead_volume": 100.0,
            "halstead_difficulty": 8.0,
            "halstead_effort": 800.0,
            "loc": 45,
            "num_functions": 3,
        }
        result = estimator.estimate_debt(metrics)
        self.assertEqual(result["maintainability_findings"], [])
