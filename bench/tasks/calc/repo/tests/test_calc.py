import unittest

from calc import CalcError, evaluate, tokenize


class CalcTest(unittest.TestCase):
    def test_tokens(self):
        self.assertEqual(tokenize("2**x"), [("num", "2", 0), ("op", "**", 1), ("name", "x", 3)])

    def test_precedence(self):
        self.assertEqual(evaluate("1 + 2 * 3"), 7)
        self.assertEqual(evaluate("(1 + 2) * 3"), 9)
        self.assertEqual(evaluate("7 / 2"), 3.5)

    def test_variables(self):
        self.assertEqual(evaluate("x * y", {"x": 3, "y": 4}), 12)

    def test_division_by_zero_position(self):
        with self.assertRaises(CalcError) as ctx:
            evaluate("1 + 4 / 0")
        self.assertEqual(ctx.exception.position, 6)


if __name__ == "__main__":
    unittest.main()
