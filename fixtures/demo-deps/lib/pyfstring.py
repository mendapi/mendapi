import stripe

def charge_note(cid):
    # FS1: slot inside a single-line f-string is real code — must bind
    msg = f"charged: {stripe.Charge.retrieveFS1(cid).amount} cents"
    # FS2: prose outside the slot is a lookalike — must stay silent
    note = f"call stripe.Charge.createFS2(x) manually {cid}"
    # FS3: escaped double braces are literal text, not a slot — silent
    tpl = f"use {{stripe.Refund.createFS3(y)}} as a template"
    return msg, note, tpl

def report(pid):
    body = f"""
    Topup status: {stripe.Topup.cancelFS4(pid).status}
    example only: stripe.Topup.createFS5(z)
    """
    return body

def plain(pid):
    # FS6: non-f triple — slot syntax is just text, must stay silent
    doc = """
    template: {stripe.Transfer.createFS6(q)}
    """
    return doc

def spec(pid):
    # FS7: expr before depth-0 colon binds; format spec after it is prose
    return f"{stripe.Balance.retrieveFS7(pid):>10}"

def uppercase(cid):
    # FS8: capital F prefix interpolates too
    return F"done: {stripe.Charge.captureFS8(cid).id}"

def rawplain(cid):
    # FS9: r-string (no f) never interpolates — slot text stays prose
    return r"pattern {stripe.Charge.createFS9(x)} here"

def multiline_slot(cid):
    # PF1: slot opens here, closes on a later line — the continuation is
    # real code by Python grammar and must bind
    return f"""
    Result: {
        stripe.Charge.retrievePF1(cid).amount
    }
    PF2: prose after the slot closed: stripe.Charge.createPF2(x)
    """

def nested_braces(cid):
    # PF3: nested dict braces keep the multi-line slot open across lines
    return f"""
    Payload: {
        build({"id": stripe.Quote.listPF3(cid),
               "extra": {"k": 1}})
    }
    """

def close_then_code(cid):
    # PF4 binds on the slot closing line; PF5 binds after the triple closes
    body = f"""
    Status: {
        stripe.Topup.cancelPF4(cid).status}
    tail prose stripe.Topup.createPF6(z)
    """
    return stripe.Transfer.createPF5(amount=1), body

def nested_strings(d, t, cid):
    # NQ1: different-quote string inside a slot is prose — must stay silent
    a = f"note: {t('see stripe.Coupon.createNQ1(x) docs')} end"
    # NQ2: 3.12 same-quote nested string is prose; slot code after it binds
    b = f"val: {d["stripe.Topup.putNQ2(x) docs"] or stripe.Quote.cancelNQ2b(cid)} tail"
    # NQ3: a `}` inside a slot string must not close the slot early — the
    # call after the string, still inside the slot, binds
    c = f"x: {t('brace } inside') + str(stripe.Mandate.retrieveNQ3(cid))} done"
    # NQ4: escaped quote never ends the nested string early — silent
    e = f'y: {t("an \" escaped stripe.Coupon.cancelNQ4(x) prose")} end'
    # NQ5: real slot call with a plain string argument binds (control)
    g = f"z: {stripe.Charge.captureNQ5('usd', cid)}"
    return a, b, c, e, g

def triple_in_slot(q, fn, cid):
    # TZ1: triple-quoted string inside a slot is prose — must stay silent
    a = f"a: {q('''see stripe.Coupon.createTZ1(x) docs''')} end"
    # TZ2: apostrophe inside the triple body must not desync — the REAL
    # call after it, still inside the slot, binds
    b = f"b: {fn('''it's a note''') or stripe.Topup.createTZ2(cid)} tail"
    # TZ3: double-quote triple inside a single-quote-delimited f-string slot
    c = f'c: {q("""use stripe.Quote.cancelTZ3(x) here""")} end'
    # TZ4: empty string '' is not a triple opener — code after binds
    d = f"d: {q('') or stripe.Mandate.retrieveTZ4(cid)}"
    # TZ5: control — plain slot call after this block binds
    e = f"e: {stripe.Charge.captureTZ5(cid)}"
    return a, b, c, d, e
