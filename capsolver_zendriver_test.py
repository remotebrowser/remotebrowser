#!/usr/bin/env python3
"""Standalone end-to-end test: solve a reCAPTCHA v2 with CapSolver, drive the page with zendriver.

Nothing here is imported from the getgather project. Deps: zendriver (installed) + requests (stdlib-adjacent).

Run:
    export CAPSOLVER_API_KEY=CAP-XXXXXXXX
    uv run python capsolver_zendriver_test.py

Definition of done: the reCAPTCHA v2 demo page shows "Verification Success".

============================================================================
LEARN CAPSOLVER — the mental model (read this first)
============================================================================
CapSolver does NOT click the captcha in YOUR browser. It's a token vendor:

  1. You tell it "there's a reCAPTCHA at THIS url with THIS sitekey".
  2. On CapSolver's own infrastructure, a worker/AI solves that captcha and
     produces a `g-recaptcha-response` TOKEN (a long opaque string Google
     issues to prove "a human passed the challenge").
  3. CapSolver hands YOU that token over a REST API.
  4. YOU paste the token into the page's hidden <textarea id="g-recaptcha-response">
     and submit the form. Google's backend validates the token — it never knows
     the token wasn't produced by a real click in your browser.

Key consequence: the token is the ONLY thing that crosses the network. The
sitekey + page URL are the INPUT; the token is the OUTPUT. Everything CapSolver
knows about "which captcha" comes from (websiteURL, websiteKey) — get those
wrong and it either refuses the task or solves the wrong widget.

The API is two endpoints, always used as a pair:
  - POST /createTask     -> returns a taskId (solving happens ASYNC in background)
  - POST /getTaskResult  -> you POLL this with the taskId until status == "ready"
There is no webhook/callback in this basic flow — you poll. (The official
`capsolver` pip SDK wraps this same pair in a blocking `capsolver.solve({...})`;
we use raw REST here so every step is visible.)
============================================================================
"""

import asyncio
import os
import sys
import time

import requests
import zendriver as zd

# --- The two inputs CapSolver needs: page URL + sitekey ---------------------
# Google's official reCAPTCHA v2 demo. LEARN: a reCAPTCHA "sitekey" is public —
# it's baked into the page HTML as data-sitekey and is safe to read from the DOM.
# It identifies which reCAPTCHA config to solve, and is bound to allowed domains
# (that's why a sitekey from site A fails with "Invalid domain" if you send site B's URL).
DEMO_URL = "https://www.google.com/recaptcha/api2/demo"
FALLBACK_SITEKEY = "6Le-wvkSAAAAAPBMRTvw0Q4Muexq9bi0DJwx_mJ-"

CAPSOLVER_BASE = "https://api.capsolver.com"
# Any of these strings appearing on the page after submit == success.
SUCCESS_MARKERS = ("Verification Success", "Hooray", "Captcha is passed successfully")
POLL_TIMEOUT = 180  # seconds we'll keep polling getTaskResult before giving up on one attempt


def solve_recaptcha_v2(api_key: str, website_url: str, website_key: str, attempts: int = 5) -> str:
    """Solve reCAPTCHA v2 via CapSolver's raw REST API. Returns the gRecaptchaResponse token.

    LEARN — why a retry loop matters with CapSolver:
    Solving is probabilistic. CapSolver commonly returns ERROR_CAPTCHA_SOLVE_FAILED
    (code 1001) — this is NOT a bug in your request, it just means "this attempt
    couldn't crack it, throw the task away and make a NEW one". The right response
    is to call /createTask again (a fresh taskId), not to keep polling the dead one.
    Real-world flows almost always wrap the solve in a few retries like this.
    Note: you are billed per SUCCESSFUL solve, so a failed attempt is (usually) free.
    """
    last_err: Exception | None = None
    for i in range(1, attempts + 1):
        try:
            print(f"[capsolver] solve attempt {i}/{attempts}")
            return _solve_once(api_key, website_url, website_key)
        except (RuntimeError, TimeoutError) as e:
            # Retry two transient conditions: an explicit solve failure, or our own
            # poll timeout (task stuck "processing"/"idle" too long). Re-raise anything
            # else — e.g. a bad key or unsupported sitekey won't get better by retrying.
            if isinstance(e, RuntimeError) and "ERROR_CAPTCHA_SOLVE_FAILED" not in str(e):
                raise
            last_err = e
            print(f"[capsolver] transient failure, retrying: {e}")
    raise RuntimeError(f"CapSolver failed after {attempts} attempts: {last_err}")


def _solve_once(api_key: str, website_url: str, website_key: str) -> str:
    # === STEP 1: createTask =================================================
    # LEARN the request shape. Every CapSolver call carries your `clientKey`
    # (the API key) at the top level, and a `task` object describing the job.
    # The `type` string is the single most important field — it selects the
    # solver. Common reCAPTCHA v2 types:
    #   - "ReCaptchaV2TaskProxyLess"  -> CapSolver uses ITS OWN proxies/IPs (easiest)
    #   - "ReCaptchaV2Task"           -> YOU must also pass a `proxy` field so the
    #                                     solve happens from an IP you control (needed
    #                                     when the site ties the token to the visitor IP)
    # Other families you'll meet later: ReCaptchaV2EnterpriseTaskProxyLess,
    # ReCaptchaV3TaskProxyLess (needs pageAction + minScore), HCaptchaTaskProxyLess,
    # TurnstileTaskProxyLess (Cloudflare), FunCaptchaTaskProxyLess, etc.
    create = requests.post(
        f"{CAPSOLVER_BASE}/createTask",
        json={
            "clientKey": api_key,
            "task": {
                "type": "ReCaptchaV2TaskProxyLess",
                "websiteURL": website_url,  # the page the captcha lives on
                "websiteKey": website_key,  # the public data-sitekey from that page
            },
        },
        timeout=30,
    ).json()
    # LEARN the response contract. CapSolver ALWAYS returns an `errorId`:
    #   errorId == 0  -> success, other fields are valid
    #   errorId != 0  -> failure; read `errorCode` + `errorDescription` to know why.
    # Error codes worth memorizing (all seen while building this script):
    #   ERROR_KEY_DENIED_ACCESS   -> bad/blocked clientKey
    #   ERROR_INVALID_TASK_DATA   -> "the sitekey is not supported" (wrong captcha
    #                                 family, e.g. sending an enterprise key as plain v2)
    #                                 or "Invalid domain for site key" (URL/sitekey mismatch)
    #   ERROR_CAPTCHA_SOLVE_FAILED-> transient; make a new task and retry (see above)
    if create.get("errorId"):
        raise RuntimeError(f"createTask failed: {create}")
    task_id = create["taskId"]  # opaque id; you'll poll getTaskResult with this
    print(f"[capsolver] task created: {task_id}")

    # === STEP 2: getTaskResult (poll) ======================================
    # LEARN the async model: createTask returns IMMEDIATELY with a taskId, before
    # the captcha is solved. You then poll getTaskResult on an interval. `status`
    # walks through: "idle"/"processing" (still working) -> "ready" (done, token
    # is in solution) — or the call comes back with errorId set if it failed.
    # Poll gently (a few seconds apart); solving a v2 image challenge can take
    # anywhere from a couple seconds to ~a minute.
    deadline = time.time() + POLL_TIMEOUT
    while time.time() < deadline:
        time.sleep(3)  # LEARN: don't hammer the endpoint; ~2-5s between polls is normal
        res = requests.post(
            f"{CAPSOLVER_BASE}/getTaskResult",
            json={"clientKey": api_key, "taskId": task_id},
            timeout=30,
        ).json()
        if res.get("errorId"):
            # e.g. the task ended in ERROR_CAPTCHA_SOLVE_FAILED — bubble up so the
            # retry loop can create a brand-new task.
            raise RuntimeError(f"getTaskResult failed: {res}")
        status = res.get("status")
        print(f"[capsolver] status: {status}")
        if status == "ready":
            # LEARN where the payoff lives: the token is at solution.gRecaptchaResponse
            # for reCAPTCHA. (Other captcha types nest their answer differently, e.g.
            # solution.token for Turnstile/hCaptcha, solution.text for image-to-text.)
            return res["solution"]["gRecaptchaResponse"]
        # any other status ("idle"/"processing") -> loop and poll again
    raise TimeoutError(f"CapSolver did not return a solution within {POLL_TIMEOUT}s")


async def main() -> int:
    api_key = os.environ.get("CAPSOLVER_API_KEY")
    if not api_key:
        print("ERROR: set CAPSOLVER_API_KEY (get one at https://dashboard.capsolver.com)")
        return 2

    shot_dir = os.path.dirname(os.path.abspath(__file__))

    async def shot(name: str) -> None:
        # Screenshots at each stage make it easy to SEE what the browser saw —
        # the fastest way to debug "did the token actually get injected/submitted?".
        path = os.path.join(shot_dir, f"shot_{name}.png")
        await page.save_screenshot(path)
        print(f"[shot] {path}")

    # headless=False so you can watch the solve happen; flip to True for CI.
    browser = await zd.start(headless=False)
    try:
        page = await browser.get(DEMO_URL)
        await page.sleep(2)
        await shot("1_loaded")

        # === STEP 3: get the sitekey (CapSolver INPUT #2) ==================
        # The sitekey is public and lives in the DOM as data-sitekey. We read it
        # so the script isn't hardcoded to one page. CAVEAT you hit while building
        # this: a page can have MULTIPLE [data-sitekey] elements (e.g. the site's
        # own header captcha vs. the demo widget) — querySelector grabs the FIRST,
        # which may be the wrong one. On a known page, prefer the known-good key.
        sitekey = await page.evaluate(
            "var e=document.querySelector('[data-sitekey]'); "
            "e ? e.getAttribute('data-sitekey') : null"
        )
        sitekey = sitekey if isinstance(sitekey, str) else FALLBACK_SITEKEY
        print(f"[page] using sitekey: {sitekey}")

        # === STEP 4: hand the job to CapSolver, get a token back ===========
        # asyncio.to_thread: solve_recaptcha_v2 uses BLOCKING requests + sleep. We
        # run it in a worker thread so it doesn't freeze zendriver's async event loop.
        token = await asyncio.to_thread(solve_recaptcha_v2, api_key, DEMO_URL, sitekey)
        print(f"[capsolver] token: {token[:40]}... ({len(token)} chars)")

        # === STEP 5: inject the token (the crux of the whole approach) =====
        # LEARN: this is how a solver-produced token becomes a "solved" captcha.
        # reCAPTCHA drops a hidden <textarea id="g-recaptcha-response"> into the
        # form; when a human passes, Google fills it with the token. We just fill
        # it OURSELVES with CapSolver's token. On submit, that value is POSTed as
        # the `g-recaptcha-response` field and Google's server verifies it.
        # (We create the textarea if missing, and set both value + innerHTML to be
        # safe across how different pages read it.)
        await page.evaluate(
            "(() => {"
            "  let el = document.getElementById('g-recaptcha-response');"
            "  if (!el) {"
            "    el = document.createElement('textarea');"
            "    el.id = 'g-recaptcha-response';"
            "    el.name = 'g-recaptcha-response';"
            "    document.querySelector('form').appendChild(el);"
            "  }"
            "  el.style.display = 'block';"
            f"  el.value = {token!r};"
            f"  el.innerHTML = {token!r};"
            "})()"
        )
        print("[page] token injected")
        await shot("2_injected")

        # === STEP 6: submit the form ======================================
        # Submit deterministically via JS (click the real submit control, else
        # submit the form). LEARN from a bug hit while building this: fuzzy
        # text-matching a button by label ("Check"/"Submit") can click the WRONG
        # element, so the token gets injected but the form is never actually sent.
        await page.evaluate(
            "(() => {"
            "  const form = document.querySelector('form');"
            "  const btn = document.querySelector("
            "    'button[type=submit], input[type=submit], #recaptcha-demo-submit');"
            "  if (btn) { btn.click(); }"
            "  else if (form) { form.submit(); }"
            "})()"
        )
        print("[page] form submitted")
        await page.sleep(4)
        await shot("3_submitted")

        # === STEP 7: verify (this is the definition of done) ==============
        # A token being ACCEPTED (page shows success) is the only proof that
        # matters — a well-formed token can still be rejected if the URL/sitekey/IP
        # didn't match. So we check the rendered page, not just "did we get a token".
        content = await page.get_content()
        hit = next((m for m in SUCCESS_MARKERS if m in content), None)
        if hit:
            print(f"✅ PASS: CAPTCHA solved — '{hit}' detected")
            return 0
        print("❌ FAIL: no success marker found on page")
        return 1
    finally:
        await browser.stop()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
