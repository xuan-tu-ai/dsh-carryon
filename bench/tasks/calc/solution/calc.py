"""Reference solution for the calc benchmark task (used only to check the hidden tests)."""

import math


class CalcError(Exception):
    def __init__(self, message, position):
        super().__init__(f"{message} at {position}")
        self.position = position


def _is_name_start(c):
    return c.isascii() and (c.isalpha() or c == "_")


def _is_name_char(c):
    return c.isascii() and (c.isalnum() or c == "_")


def tokenize(expr):
    tokens = []
    i, n = 0, len(expr)
    while i < n:
        c = expr[i]
        if c.isspace():
            i += 1
        elif c.isdigit() or (c == "." and i + 1 < n and expr[i + 1].isdigit()):
            start = i
            while i < n and expr[i].isdigit():
                i += 1
            if i < n and expr[i] == ".":
                i += 1
                while i < n and expr[i].isdigit():
                    i += 1
            if i < n and expr[i] in "eE":
                j = i + 1
                if j < n and expr[j] in "+-":
                    j += 1
                if j < n and expr[j].isdigit():
                    i = j
                    while i < n and expr[i].isdigit():
                        i += 1
                else:
                    raise CalcError("bad exponent", i)
            if i < n and (_is_name_char(expr[i]) or expr[i] == "."):
                raise CalcError("bad number", i)
            tokens.append(("num", expr[start:i], start))
        elif _is_name_start(c):
            start = i
            while i < n and _is_name_char(expr[i]):
                i += 1
            tokens.append(("name", expr[start:i], start))
        elif expr.startswith(("**", "//"), i):
            tokens.append(("op", expr[i:i + 2], i))
            i += 2
        elif c in "+-*/%":
            tokens.append(("op", c, i))
            i += 1
        elif c == "(":
            tokens.append(("lparen", c, i))
            i += 1
        elif c == ")":
            tokens.append(("rparen", c, i))
            i += 1
        elif c == ",":
            tokens.append(("comma", c, i))
            i += 1
        else:
            raise CalcError(f"unexpected character {c!r}", i)
    return tokens


def _number(text):
    return float(text) if any(ch in text for ch in ".eE") else int(text)


def _sqrt(pos, x):
    if x < 0:
        raise CalcError("sqrt of a negative number", pos)
    return math.sqrt(x)


def _round(pos, *args):
    if len(args) == 2 and not isinstance(args[1], int):
        raise CalcError("round digits must be an int", pos)
    return round(*args)


FUNCS = {
    "abs": (1, 1, lambda pos, x: abs(x)),
    "min": (1, None, lambda pos, *a: min(a)),
    "max": (1, None, lambda pos, *a: max(a)),
    "round": (1, 2, _round),
    "sqrt": (1, 1, _sqrt),
}


class _Parser:
    def __init__(self, expr, variables):
        self.expr = expr
        self.tokens = tokenize(expr)
        self.i = 0
        self.vars = {"pi": math.pi, "e": math.e, **(variables or {})}

    def peek(self):
        return self.tokens[self.i] if self.i < len(self.tokens) else ("end", "", len(self.expr))

    def take(self):
        tok = self.peek()
        self.i += 1
        return tok

    def parse(self):
        if not self.tokens:
            raise CalcError("empty expression", 0)
        value = self.sum()
        kind, _, pos = self.peek()
        if kind != "end":
            raise CalcError("unexpected token", pos)
        return value

    def sum(self):
        value = self.product()
        while self.peek()[0] == "op" and self.peek()[1] in "+-":
            _, op, _ = self.take()
            rhs = self.product()
            value = value + rhs if op == "+" else value - rhs
        return value

    def product(self):
        value = self.unary()
        while self.peek()[0] == "op" and self.peek()[1] in ("*", "/", "//", "%"):
            _, op, pos = self.take()
            rhs = self.unary()
            if op == "*":
                value = value * rhs
            else:
                if rhs == 0:
                    raise CalcError("division by zero", pos)
                value = value / rhs if op == "/" else value // rhs if op == "//" else value % rhs
        return value

    def unary(self):
        if self.peek()[0] == "op" and self.peek()[1] in "+-":
            _, op, _ = self.take()
            value = self.unary()
            return -value if op == "-" else +value
        return self.power()

    def power(self):
        base = self.atom()
        if self.peek()[0] == "op" and self.peek()[1] == "**":
            _, _, pos = self.take()
            exp = self.unary()
            if base == 0 and exp < 0:
                raise CalcError("zero to a negative power", pos)
            if isinstance(base, int) and isinstance(exp, int) and exp < 0:
                return float(base) ** exp
            return base ** exp
        return base

    def atom(self):
        kind, text, pos = self.take()
        if kind == "num":
            return _number(text)
        if kind == "lparen":
            value = self.sum()
            if self.peek()[0] != "rparen":
                if self.peek()[0] == "end":
                    raise CalcError("unclosed parenthesis", pos)
                raise CalcError("unexpected token", self.peek()[2])
            self.take()
            return value
        if kind == "name":
            if self.peek()[0] == "lparen":
                return self.call(text, pos)
            if text not in self.vars:
                raise CalcError(f"unknown variable {text}", pos)
            return self.vars[text]
        raise CalcError("unexpected token" if kind != "end" else "missing operand", pos)

    def call(self, name, pos):
        if name not in FUNCS:
            raise CalcError(f"unknown function {name}", pos)
        open_pos = self.take()[2]
        args = []
        if self.peek()[0] != "rparen":
            while True:
                args.append(self.sum())
                if self.peek()[0] != "comma":
                    break
                self.take()
        if self.peek()[0] != "rparen":
            if self.peek()[0] == "end":
                raise CalcError("unclosed parenthesis", open_pos)
            raise CalcError("unexpected token", self.peek()[2])
        self.take()
        low, high, fn = FUNCS[name]
        if len(args) < low or (high is not None and len(args) > high):
            raise CalcError(f"wrong number of arguments for {name}", pos)
        return fn(pos, *args)


def evaluate(expr, variables=None):
    return _Parser(expr, variables).parse()
