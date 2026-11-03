# ledger: a small double-entry ledger

Python 3.11+, standard library only. Everything lives in the `ledger` package; import it as
`from ledger import Ledger, LedgerError`. Money is `decimal.Decimal`, rounded to cents with `ROUND_HALF_UP`.
Every rejected operation raises `LedgerError` and leaves the ledger unchanged.

## R1. Accounts

`Ledger.open_account(name, kind)` creates an account. `kind` is one of `asset`, `liability`, `equity`,
`income`, `expense`. Names are non-empty after stripping whitespace, are stored stripped, and are unique
ignoring case. Every method that takes an account name accepts any capitalization of it.

## R2. Posting transactions

`Ledger.post(date, description, postings)` records a transaction and returns its id. Ids are integers
starting at 1, in posting order. `date` is an ISO date string `YYYY-MM-DD` (it must be a real calendar date).
`postings` is a list of `(account, amount)` pairs; `amount` is a `Decimal`, `int` or numeric string, rounded to
cents. A positive amount is a debit, a negative amount a credit. A transaction needs at least two postings,
every account must exist, no rounded amount may be zero, and the rounded amounts must sum to exactly zero.

## R3. Balances

`Ledger.balance(account, as_of=None)` returns the account's balance as a `Decimal` with two decimal places.
Debit-normal accounts (`asset`, `expense`) report debits minus credits; credit-normal accounts (`liability`,
`equity`, `income`) report credits minus debits. With `as_of` (ISO date), only transactions dated on or before
that day count.

## R4. Trial balance

`Ledger.trial_balance(as_of=None)` returns a list of `(name, kind, balance)` tuples for accounts with a
non-zero balance, ordered by kind (`asset`, `liability`, `equity`, `income`, `expense`) and then by name,
case-insensitively.

## R5. Voiding

`Ledger.void(txn_id)` posts a new transaction on the same date as the original, with every amount negated and
the description `VOID #<id>: <original description>`, and returns the new id. A transaction can be voided
only once, a void cannot itself be voided, and an unknown id is an error. `Ledger.is_void(txn_id)` tells
whether a transaction has been voided.

## R6. CSV import

`Ledger.import_csv(text)` reads CSV text with the header `date,description,account,amount,txn`. Rows with the
same `txn` value form one transaction (the date and description of its first row are used), posted in order of
the first appearance of each `txn` value. Import is all-or-nothing: if any transaction is invalid, nothing is
posted and the error message contains the offending `txn` value. Returns the list of new ids.

## R7. Income statement

`Ledger.income_statement(start, end)` returns `{"income": Decimal, "expense": Decimal, "net": Decimal}` for
transactions dated from `start` to `end`, both inclusive. `income` is the credit-normal movement of all income
accounts, `expense` the debit-normal movement of all expense accounts, and `net` is `income - expense`.

## R8. Persistence

`Ledger.to_json()` returns a JSON string, and `Ledger.from_json(text)` (a class method) rebuilds an equal
ledger: same accounts (names and kinds), same transactions with the same ids, dates, descriptions, postings and
void status. New transactions after loading continue the id sequence.
