"""Hidden tests for the calc task: one class per SPEC.md section."""

import math
import unittest

from calc import CalcError, evaluate, tokenize


class C1Tokens(unittest.TestCase):
    def test_kinds_and_positions(self):
        self.assertEqual(tokenize(" max(a_1, .5)//2 % 3e+4"), [
            ("name", "max", 1), ("lparen", "(", 4), ("name", "a_1", 5), ("comma", ",", 8), ("num", ".5", 10),
            ("rparen", ")", 12), ("op", "//", 13), ("num", "2", 15), ("op", "%", 17), ("num", "3e+4", 19),
        ])

    def test_number_forms(self):
        for text in ["12", "1.5", ".5", "2.", "1e3", "2.5E-2", "3e+4"]:
            self.assertEqual(tokenize(text), [("num", text, 0)], text)

    def test_bad_numbers_and_chars(self):
        for expr, pos in [("1.2.3", 3), ("2x", 1), ("1e", 1), ("1e+", 1), ("3 $ 4", 2), ("1_0", 1), ("a # b", 2)]:
            with self.assertRaises(CalcError, msg=expr) as ctx:
                tokenize(expr)
            self.assertEqual(ctx.exception.position, pos, expr)


class C2Precedence(unittest.TestCase):
    def test_table(self):
        for expr, want in [("2 + 3 * 4 - 5", 9), ("10 - 4 - 3", 3), ("2 * 3 % 4", 2), ("-2**2", -4), ("2**-1", 0.5),
                           ("2**3**2", 512), ("(-2)**2", 4), ("--3", 3), ("-+-3", 3), ("7 // 2 * 2", 6),
                           ("2 * -3", -6), ("100 / 10 / 5", 2.0), ("-(1 + 2) * 3", -9)]:
            self.assertEqual(evaluate(expr), want, expr)


class C3Values(unittest.TestCase):
    def test_types(self):
        cases = [("1 + 2", int), ("1 + 2.0", float), ("6 / 3", float), ("7 // 2", int), ("7.0 // 2", float),
                 ("2 ** 10", int), ("2 ** -2", float), ("1e2", float), ("-7 % 3", int)]
        for expr, typ in cases:
            self.assertIs(type(evaluate(expr)), typ, expr)
        self.assertEqual(evaluate("-7 % 3"), 2)
        self.assertEqual(evaluate("-7 // 2"), -4)
        self.assertEqual(evaluate("2 ** 100"), 2 ** 100)


class C4Variables(unittest.TestCase):
    def test_lookup_and_constants(self):
        self.assertAlmostEqual(evaluate("2 * pi"), 2 * math.pi)
        self.assertAlmostEqual(evaluate("e"), math.e)
        self.assertEqual(evaluate("pi + e", {"pi": 1, "e": 2}), 3)
        self.assertEqual(evaluate("rate_2 * 3", {"rate_2": 0.5}), 1.5)


class C5Functions(unittest.TestCase):
    def test_functions(self):
        self.assertEqual(evaluate("abs(-3) + max(1, 7, 2) - min(4)"), 6)
        self.assertEqual(evaluate("round(2.5)"), 2)
        self.assertEqual(evaluate("round(3.14159, 2)"), 3.14)
        self.assertIs(type(evaluate("sqrt(16)")), float)
        self.assertEqual(evaluate("sqrt(16) ** 2"), 16.0)
        self.assertEqual(evaluate("max(1, min(5, 3) * 2)"), 6)

    def test_function_names_are_not_variables(self):
        with self.assertRaises(CalcError) as ctx:
            evaluate("1 + abs")
        self.assertEqual(ctx.exception.position, 4)


class C6Errors(unittest.TestCase):
    def check(self, expr, pos, variables=None):
        with self.assertRaises(CalcError, msg=expr) as ctx:
            evaluate(expr, variables)
        self.assertEqual(ctx.exception.position, pos, expr)

    def test_positions(self):
        for expr, pos in [
            ("", 0), ("   ", 0), ("1 +", 3), ("1 + * 2", 4), ("(1 + 2", 0), ("2 * (3 + (4)", 4), ("1 + 2)", 5),
            ("3 4", 2), ("x + 1", 0), ("1 + foo(2)", 4), ("min()", 0), ("abs(1, 2)", 0), ("round(1, 2.5)", 0),
            ("8 // 0", 2), ("8 % (2 - 2)", 2), ("1 / 0.0", 2), ("2 + sqrt(-4)", 4), ("0 ** -1", 2), ("max(1,)", 6),
            ("()", 1), ("abs(1", 3),
        ]:
            self.check(expr, pos)

    def test_tokenizer_errors_surface(self):
        self.check("1 + 2x", 5)


if __name__ == "__main__":
    unittest.main()
