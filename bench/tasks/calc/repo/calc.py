"""Arithmetic expressions. See SPEC.md."""


class CalcError(Exception):
    def __init__(self, message, position):
        super().__init__(f"{message} at {position}")
        self.position = position


def tokenize(expr):
    raise NotImplementedError


def evaluate(expr, variables=None):
    raise NotImplementedError
