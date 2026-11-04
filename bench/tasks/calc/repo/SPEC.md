# calc: arithmetic expressions

Python 3.11+, standard library only, no `eval`/`exec`/`ast`. Module `calc` provides `tokenize(expr)`,
`evaluate(expr, variables=None)` and the exception `CalcError`, which has a `position` attribute: a 0-based index
into the original string.

## C1. Tokens

`tokenize(expr)` returns a list of `(kind, text, position)` tuples. Kinds: `num`, `name`, `op`, `lparen`,
`rparen`, `comma`. Whitespace separates tokens and is otherwise ignored.
- Numbers: `12`, `1.5`, `.5`, `2.`, `1e3`, `2.5E-2`, `3e+4`. A number must not be followed directly by a letter,
  digit, `_` or `.` that is not part of it (`1.2.3`, `2x`, `1e` are errors at the position of the first offending
  character).
- Names: `[A-Za-z_][A-Za-z0-9_]*`.
- Operators: `+ - * / // % **`, each one token (`//` and `**` are single tokens).
- Any other character is an error at its position.

## C2. Grammar and precedence

From lowest to highest: `+ -` (binary, left-assoc); `* / // %` (left-assoc); unary `+ -`; `**`
(right-assoc). `**` binds tighter than a unary operator on its left but accepts a unary operator on its right:
`-2**2` is `-4`, `2**-1` is `0.5`, `2**3**2` is `512`. Parentheses group. Function calls: `name(arg, ...)`.

## C3. Values

Integer literals are `int`; literals with `.` or an exponent are `float`. `+ - *` on two ints give an int,
otherwise a float. `/` always gives a float. `//` and `%` follow Python. `**` with an int base and a non-negative
int exponent gives an int; with a negative int exponent or any float, a float. The result of `evaluate` is an
`int` or a `float`.

## C4. Variables

A name not followed by `(` is a variable, looked up in `variables`. `pi` and `e` (from `math`) are predefined
unless `variables` defines them.

## C5. Functions

`abs(x)`; `min(a, ...)` and `max(a, ...)` with one or more arguments; `round(x)` and `round(x, n)` (Python
semantics, `n` must be an int); `sqrt(x)` (always a float). Function names are not variables.

## C6. Errors

`evaluate` raises `CalcError` with `position`:
- the tokenizer errors of C1;
- empty or blank expression: 0;
- a missing operand or an unexpected token: the position of that token, or `len(expr)` at the end of input;
- an unclosed `(`: the position of that `(`; a `)` with no matching `(`: its position;
- an unknown variable or function: the position of the name;
- a wrong number of arguments (or a non-int `n` for `round`): the position of the function name;
- division, floor division or modulo by zero: the position of the operator;
- `sqrt` of a negative number: the position of `sqrt`;
- `0 ** -1` (zero to a negative power): the position of `**`.
