"""A small double-entry ledger. See SPEC.md."""


class LedgerError(Exception):
    """Raised for every rejected ledger operation."""


class Ledger:
    def open_account(self, name, kind):
        raise NotImplementedError

    def post(self, date, description, postings):
        raise NotImplementedError

    def balance(self, account, as_of=None):
        raise NotImplementedError
