# Fixture: bare-keyword suite headers (try/else/finally) at column 0 must not
# swallow the indented proven construction on the next line (Loop 331 — the
# annotation group's \s* used to cross the newline, minting a phantom
# instance named `try` and leaving the real binding invisible).
from openai import OpenAI

# TB1: module-level try/except bootstrap — the canonical "fail loud on bad
# credentials" spelling. The construction inside the try suite must bind.
try:
    tbclient = OpenAI(api_key="k")
except Exception:
    raise

tbclient.chat.completions.wakeTB1(model="m")

# TB2: else-suite construction (bare `else:` header at column 0).
if False:
    pass
else:
    tbother = OpenAI(api_key="k")

tbother.responses.wakeTB2("r")

# TB3: docstring lookalike — a triple-quoted body quoting the exact same
# try-block spelling must never mint a binding (prose mask).
NOTE = """
try:
    tbghost = OpenAI(api_key="k")
"""

def _use_ghost():
    return "tbghost.chat.completions.dropTB3"
