# Gold fixture (negative control, Loop 292): docstring-quoted import lookalikes.
# All provider mentions live in comments / docstrings — zero detections expected.

# old: import sendgrid

"""
Example from the old README (do not use):

import plaid
client = plaid.Client(client_id, secret)
"""


def local_sum(values):
    """Sum values locally. No SDK involved."""
    return sum(values)
