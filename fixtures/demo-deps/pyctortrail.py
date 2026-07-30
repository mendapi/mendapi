# Python constructor trailing-chain adjudication (Loop 338).
# `client = OpenAI(api_key=k).chat` binds the CHAT sub-resource, not the
# client (false attribution). Python has no universal value-identity
# trailer, so ANY member trailer after the balanced close drops the
# binding — including .with_options() (per-SDK client copy: provider
# knowledge, AST track).
from openai import OpenAI

# PT1: plain construction — binds (control).
pt_client = OpenAI(api_key="k")
pt_client.moderations.wakePT1(model="x")

# PT2: derived-resource trailer — the name holds chat, NOT the client.
pt_res = OpenAI(api_key="k").chat
pt_res.batches.dropPT2(model="x")

# PT3: .with_options() client copy — honest skip (AST track), silent.
pt_opt = OpenAI(api_key="k").with_options(timeout=1)
pt_opt.batches.dropPT3(model="x")

# PT4: self-field with a derived trailer — silent.
class PtService:
    def __init__(self, k):
        self.pt_sc = OpenAI(api_key=k).chat

    def run(self):
        self.pt_sc.batches.dropPT4(model="x")
