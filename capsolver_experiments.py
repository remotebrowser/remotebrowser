#!/usr/bin/env python3
"""NEXT EXPERIMENTS: solve Cloudflare Turnstile and reCAPTCHA v3 with CapSolver + zendriver.

This is a companion to capsolver_zendriver_test.py (which does reCAPTCHA v2). Read that
one first — it explains the CapSolver mental model. This file reuses the SAME two-endpoint
pattern (createTask -> poll getTaskResult) and shows the ONE thing that really changes
between captcha types: the `task` object you send, and where the answer comes back.

Run:
    export CAPSOLVER_API_KEY=CAP-XXXXXXXX
    uv run python capsolver_experiments.py turnstile
    uv run python capsolver_experiments.py v3

Deps: zendriver + requests. Nothing imported from the getgather project.

============================================================================
THE BIG PICTURE — one solver, many captcha types
============================================================================
CapSolver's API never changes shape. You always:
    POST /createTask     with {clientKey, task:{type, ...}}   -> taskId
    POST /getTaskResult  with {clientKey, taskId}  (poll)     -> solution
What changes per captcha type is:
    (a) task.type            — selects the solver
    (b) a few task params     — e.g. pageAction for v3
    (c) where the token lives in `solution`
    (d) HOW you feed the token back into the page (the browser side differs a lot)

    | Captcha            | task.type                     | extra params        | solution field           |
    |--------------------|-------------------------------|---------------------|--------------------------|
    | reCAPTCHA v2       | ReCaptchaV2TaskProxyLess      | —                   | gRecaptchaResponse       |
    | reCAPTCHA v3       | ReCaptchaV3TaskProxyLess      | pageAction (req'd)  | gRecaptchaResponse       |
    | Cloudflare Turnstile| AntiTurnstileTaskProxyLess   | metadata.action?    | token (+ userAgent!)     |
    | Amazon text captcha| ImageToTextTask               | body (base64 image) | text  (OCR, no sitekey)  |
    | AWS WAF            | AntiAwsWafTaskProxyLess       | iv/context/scripts  | token -> aws-waf-token cookie |
    | hCaptcha           | HCaptchaTaskProxyLess         | —                   | gRecaptchaResponse       |
    | FunCaptcha         | FunCaptchaTaskProxyLess       | websitePublicKey    | token                    |

"ProxyLess" = CapSolver uses its own IPs. Drop the suffix + add a `proxy` field when the
site binds the token to the visitor's IP.
============================================================================
"""

import asyncio
import os
import sys
import time
from collections.abc import Mapping

import requests
import zendriver as zd
import zendriver.cdp as cdp  # low-level CDP commands (used to set the aws-waf-token cookie)

# Base origin of the deployed CAPTCHA test target (see the handoff doc).
TEST_SITE = "https://dcz1t9chpw9yt.cloudfront.net"

CAPSOLVER_BASE = "https://api.capsolver.com"
POLL_TIMEOUT = 180  # seconds per solve attempt


# ---------------------------------------------------------------------------
# GENERALIZED SOLVER — identical to the v2 script, but takes ANY task dict.
# This is the whole point: the create/poll machinery is captcha-agnostic.
# ---------------------------------------------------------------------------
def solve(
    api_key: str, task: Mapping[str, object], solution_key: str, attempts: int = 5
) -> dict[str, str]:
    """Create a CapSolver task, poll until ready, return the whole `solution` object.

    `task` is the per-captcha-type dict (see the table up top).
    `solution_key` is just used to sanity-check/print the expected field.
    Retries transient ERROR_CAPTCHA_SOLVE_FAILED + our own poll timeout (same as v2).
    """
    last_err: Exception | None = None
    for i in range(1, attempts + 1):
        try:
            print(f"[capsolver] solve attempt {i}/{attempts} (type={task['type']})")
            return _solve_once(api_key, task, solution_key)
        except (RuntimeError, TimeoutError) as e:
            if isinstance(e, RuntimeError) and "ERROR_CAPTCHA_SOLVE_FAILED" not in str(e):
                raise  # hard error (bad key, unsupported sitekey, bad pageAction) — don't retry
            last_err = e
            print(f"[capsolver] transient failure, retrying: {e}")
    raise RuntimeError(f"CapSolver failed after {attempts} attempts: {last_err}")


def _solve_once(api_key: str, task: Mapping[str, object], solution_key: str) -> dict[str, str]:
    # STEP 1: createTask — note `task` is passed straight through. Only its
    # contents differ between Turnstile / v3 / v2.
    create = requests.post(
        f"{CAPSOLVER_BASE}/createTask",
        json={"clientKey": api_key, "task": task},
        timeout=30,
    ).json()
    if create.get("errorId"):
        # Same error vocabulary as v2: ERROR_INVALID_TASK_DATA (wrong sitekey/family),
        # ERROR_KEY_DENIED_ACCESS (bad key), etc.
        raise RuntimeError(f"createTask failed: {create}")
    # LEARN: some task types solve SYNCHRONOUSLY — e.g. ImageToTextTask returns the
    # solution right here in the createTask response (status == "ready"), with NO task
    # to poll. Polling getTaskResult for those gives ERROR_TASK_NOT_FOUND ("expired").
    # Token-based captchas (reCAPTCHA/Turnstile/AWS WAF) are async and DO need polling.
    if create.get("status") == "ready":
        print("[capsolver] solved synchronously (no polling needed)")
        return create["solution"]
    task_id = create["taskId"]
    print(f"[capsolver] task created: {task_id}")

    # STEP 2: poll getTaskResult until status == "ready".
    deadline = time.time() + POLL_TIMEOUT
    while time.time() < deadline:
        time.sleep(3)
        res = requests.post(
            f"{CAPSOLVER_BASE}/getTaskResult",
            json={"clientKey": api_key, "taskId": task_id},
            timeout=30,
        ).json()
        if res.get("errorId"):
            raise RuntimeError(f"getTaskResult failed: {res}")
        status = res.get("status")
        print(f"[capsolver] status: {status}")
        if status == "ready":
            solution = res["solution"]
            if solution_key not in solution:
                # Helpful when learning: shows you the ACTUAL solution shape if the
                # field you expected isn't there.
                print(f"[capsolver] WARNING: '{solution_key}' not in solution: {list(solution)}")
            return solution
    raise TimeoutError(f"CapSolver did not return a solution within {POLL_TIMEOUT}s")


# ===========================================================================
# EXPERIMENT 1 — Cloudflare Turnstile
# ===========================================================================
async def experiment_turnstile(api_key: str) -> int:
    """Solve a Cloudflare Turnstile widget.

    LEARN — how Turnstile differs from reCAPTCHA:
    - task.type is "AntiTurnstileTaskProxyLess".
    - The sitekey looks like "0x4AAAAAAA..." (Cloudflare format), still public, still
      in the DOM (on a <div class="cf-turnstile" data-sitekey="0x...">).
    - The answer is solution["token"] (NOT gRecaptchaResponse).
    - Turnstile ALSO returns solution["userAgent"]. Cloudflare ties the token to the
      user-agent that solved it, so for hardened sites you should drive the browser
      with that SAME user-agent. (For this simple demo we ignore it.)
    - You inject the token into a hidden <input name="cf-turnstile-response"> (Cloudflare's
      equivalent of g-recaptcha-response), then submit.

    IMPORTANT FINDING (verified live): there is NO public non-dummy Turnstile demo.
    The 2captcha demo below serves Cloudflare's dummy key "3x00000000000000000000FF"
    (the "always force interactive challenge" test key). CapSolver rightly rejects it:
        ERROR_INVALID_TASK_DATA: invalid websiteKey (3x00000000000000000000FF)
    Cloudflare's dummy keys come in three flavors — 1x..AA "always passes",
    2x..AB "always blocks", 3x..FF "force interactive". The "always passes" ones don't
    NEED a solver (the widget hands you a fake token client-side), and the others aren't
    real challenges — so a genuine CapSolver Turnstile solve REQUIRES a real production
    sitekey on its authorized domain. Point DEMO_URL/sitekey at a widget you own or are
    authorized to test. (This mirrors the v2 lesson: sitekeys are real, public, and
    domain-bound.)
    """
    DEMO_URL = "https://2captcha.com/demo/cloudflare-turnstile"

    browser = await zd.start(headless=False)
    try:
        page = await browser.get(DEMO_URL)
        await page.sleep(3)  # Turnstile can take a moment to render its widget

        # Turnstile puts its sitekey on the .cf-turnstile element (data-sitekey), same
        # public-key idea as reCAPTCHA.
        sitekey = await page.evaluate(
            "var e=document.querySelector('.cf-turnstile,[data-sitekey]');"
            "e ? e.getAttribute('data-sitekey') : null"
        )
        if not isinstance(sitekey, str):
            print("ERROR: couldn't find a Turnstile sitekey on the page — update DEMO_URL.")
            return 2
        print(f"[page] turnstile sitekey: {sitekey}")

        # Build the Turnstile task. Compare to v2: only `type` (and optionally
        # metadata.action / metadata.cdata for sites that set them) changes.
        task = {
            "type": "AntiTurnstileTaskProxyLess",
            "websiteURL": DEMO_URL,
            "websiteKey": sitekey,
            # "metadata": {"action": "...", "cdata": "..."},  # only if the site sets these
        }
        solution = await asyncio.to_thread(solve, api_key, task, "token")
        token = solution["token"]
        print(f"[capsolver] token: {token[:40]}... ({len(token)} chars)")
        print(f"[capsolver] solved with userAgent: {solution.get('userAgent', '(none)')}")

        # INJECT: Turnstile's hidden field is name="cf-turnstile-response".
        await page.evaluate(
            "(() => {"
            "  let el = document.querySelector('[name=\"cf-turnstile-response\"]');"
            "  if (!el) {"
            "    el = document.createElement('input');"
            "    el.type = 'hidden';"
            "    el.name = 'cf-turnstile-response';"
            "    document.querySelector('form').appendChild(el);"
            "  }"
            f"  el.value = {token!r};"
            "})()"
        )
        print("[page] token injected into cf-turnstile-response")

        # Submit + eyeball the result. (The 2captcha demo shows a success message;
        # a real site would POST the token to its backend for Cloudflare siteverify.)
        await page.evaluate(
            "(() => { const f=document.querySelector('form');"
            " const b=document.querySelector('button[type=submit],input[type=submit]');"
            " if(b){b.click();} else if(f){f.submit();} })()"
        )
        await page.sleep(4)
        shot = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shot_turnstile.png")
        await page.save_screenshot(shot)
        print(f"[shot] {shot}  <-- open this to verify the result")
        return 0
    finally:
        await browser.stop()


# ===========================================================================
# EXPERIMENT 2 — reCAPTCHA v3
# ===========================================================================
async def experiment_recaptcha_v3(api_key: str) -> int:
    """Solve a reCAPTCHA v3 token.

    LEARN — why v3 is a different beast:
    - v3 is INVISIBLE. There's no checkbox and no image puzzle. The page calls
      grecaptcha.execute(sitekey, {action}) in JS whenever it wants a token, gets a
      SCORE (0.0 = bot ... 1.0 = human) baked into the token, and sends it to its backend.
    - task.type is "ReCaptchaV3TaskProxyLess" and you MUST supply `pageAction` — the
      action name the site uses (e.g. "login", "submit", "verify"). The token is only
      valid for THAT action; a mismatch makes the server reject it. Finding the right
      action means reading the site's JS (search for grecaptcha.execute(...)).
    - Answer is solution["gRecaptchaResponse"] (same field name as v2).
    - There's no reliable "textarea to drop it in". v3 tokens are consumed by JS or
      POSTed to a backend, so injection is SITE-SPECIFIC. Two common strategies below.

    Because a clean generic browser-injection for v3 doesn't exist, this experiment
    focuses on the CapSolver part (getting a valid token) and then DEMONSTRATES the
    two ways you'd actually use it. Fill in PAGE_ACTION / sitekey for your target.
    """
    # TODO: set these for your target. For the 2captcha v3 demo, inspect the page's JS
    # (grecaptcha.execute) to find the real action + sitekey. These are placeholders.
    DEMO_URL = "https://2captcha.com/demo/recaptcha-v3"
    PAGE_ACTION = "demo_action"  # <-- MUST match the site's grecaptcha.execute action
    FALLBACK_SITEKEY = "6LfB5_IbAAAAAMCtsjEHEHKqcB9iQocwwxTiihJu"  # verify against the page

    browser = await zd.start(headless=False)
    try:
        page = await browser.get(DEMO_URL)
        await page.sleep(2)

        # v3 sitekeys usually aren't in a data-sitekey attribute — they're arguments to
        # grecaptcha.render/execute or in the api.js?render=<sitekey> script URL. Try to
        # scrape it from the script tag; fall back to the known one.
        sitekey = await page.evaluate(
            "(() => { const s=[...document.scripts].map(x=>x.src).find(u=>u.includes('render='));"
            " return s ? new URL(s).searchParams.get('render') : null; })()"
        )
        sitekey = sitekey if isinstance(sitekey, str) else FALLBACK_SITEKEY
        print(f"[page] v3 sitekey: {sitekey}  action: {PAGE_ACTION}")

        # The v3 task: note the REQUIRED pageAction — this is the new thing vs v2.
        task = {
            "type": "ReCaptchaV3TaskProxyLess",
            "websiteURL": DEMO_URL,
            "websiteKey": sitekey,
            "pageAction": PAGE_ACTION,
            # "minScore": 0.7,  # optional: ask CapSolver to keep trying for a high score
        }
        solution = await asyncio.to_thread(solve, api_key, task, "gRecaptchaResponse")
        token = solution["gRecaptchaResponse"]
        print(f"[capsolver] v3 token: {token[:40]}... ({len(token)} chars)")

        # ---- USING a v3 token (two real-world strategies) --------------------
        # STRATEGY A (backend-style, most common): don't touch the browser at all —
        # POST the token to the site's verify endpoint yourself, e.g.
        #     requests.post("https://target/verify", data={"g-recaptcha-response": token,
        #                                                    "action": PAGE_ACTION})
        # This is how v3 is normally consumed, because the server does the score check.
        #
        # STRATEGY B (browser-style, when a form/JS expects it): override the page's
        # grecaptcha.execute so that when the site asks for a token, it gets OURS.
        # Sketch (site-specific — enable only if the page calls execute on submit):
        #     await page.evaluate(
        #         "window.grecaptcha = window.grecaptcha || {};"
        #         f"window.grecaptcha.execute = () => Promise.resolve({token!r});"
        #         "window.grecaptcha.ready = (cb) => cb && cb();"
        #     )
        # then trigger the form/button that calls execute.
        print(
            "[note] v3 has no standard DOM slot. Use Strategy A (POST token to a verify "
            "endpoint) or Strategy B (override grecaptcha.execute). See comments above."
        )
        shot = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shot_v3.png")
        await page.save_screenshot(shot)
        print(f"[shot] {shot}")
        return 0
    finally:
        await browser.stop()


# ===========================================================================
# EXPERIMENT 3 — Amazon's distorted-text image CAPTCHA (OCR path)
# ===========================================================================
async def experiment_image_captcha(api_key: str) -> int:
    """Solve a distorted-text image CAPTCHA (Amazon's "Enter the characters you see below").

    LEARN — this is the OTHER captcha Amazon uses, and it's a completely different model
    from reCAPTCHA/Turnstile/AWS-WAF:
    - There is NO sitekey and NO token. The challenge is literally a PNG of wavy letters
      plus a text <input>. Amazon serves it from amazon.com/errors/validateCaptcha.
    - CapSolver task type is "ImageToTextTask" — pure OCR. You send the image bytes as
      base64 in `body`; CapSolver returns the letters in solution["text"].
    - You "inject" by TYPING the text into the field and submitting — no cookie, no textarea.
    - task params: {type, body(base64, no data: prefix)}, plus optional `module` to pick a
      recognition model tuned for a specific captcha style, and `case`/`score` hints.

    So the ONLY hard part is getting the image bytes. Below we read the <img> straight
    from the DOM by drawing it to a <canvas> and calling toDataURL — which works for a
    SAME-ORIGIN image (our test site serves /captcha-image.png same-origin, so this is fine).
    Cross-origin images (like the real amazon.com one) "taint" the canvas and toDataURL
    throws; for those you'd screenshot the element instead.

    Target = the deployed test site's /image-captcha. The page has a hidden `token` field
    and <img src="/captcha-image.png?t=<token>">; we OCR the image, then submit the form
    (which carries `token` + our typed `answer`). Success page contains IMAGE_SOLVE_OK.
    """
    # Start on ?difficulty=easy (clean, reliably-OCR-able). The default ?difficulty=hard
    # renders faint, heavily-warped glyphs under bold noise lines that generic OCR misreads.
    DIFFICULTY = os.environ.get("IMG_DIFFICULTY", "easy")
    DEMO_URL = f"{TEST_SITE}/image-captcha?difficulty={DIFFICULTY}"
    IMG_SELECTOR = "img[src*='captcha-image']"  # the distorted-text image
    INPUT_SELECTOR = "input[name='answer']"  # the answer text field
    SUBMIT_SELECTOR = "button[type=submit], input[type=submit]"
    SUCCESS_MARKERS = ("IMAGE_SOLVE_OK",)

    # LEARN: OCR is PROBABILISTIC. A single distorted image may be misread (wrong letters
    # or length), especially with heavy line-noise. The server hands out a FRESH image on
    # each wrong answer, so the real-world approach is to retry with new challenges until
    # one reads cleanly. (This is why solver dashboards quote accuracy %, not 100%.)
    ROUNDS = 8
    shot = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shot_image.png")

    browser = await zd.start(headless=False)
    page = None
    try:
        for r in range(1, ROUNDS + 1):
            page = await browser.get(DEMO_URL)  # fresh token + fresh image each round
            await page.sleep(2)

            # STEP A: pull the captcha image out of the DOM as base64 (no "data:..." prefix).
            # Draw the <img> onto a canvas, then canvas.toDataURL(). Same-origin only.
            data_url = await page.evaluate(
                "(() => {"
                f"  const img = document.querySelector({IMG_SELECTOR!r});"
                "  if (!img) return null;"
                "  const c = document.createElement('canvas');"
                "  c.width = img.naturalWidth || img.width;"
                "  c.height = img.naturalHeight || img.height;"
                "  c.getContext('2d').drawImage(img, 0, 0);"
                "  try { return c.toDataURL('image/png'); } catch (e) { return 'TAINTED:' + e; }"
                "})()"
            )
            if not isinstance(data_url, str) or not data_url.startswith("data:image"):
                print(f"ERROR: couldn't read captcha image as base64 (got: {data_url}).")
                print("       If it says TAINTED, the image is cross-origin — screenshot it.")
                return 2
            body_b64 = data_url.split(",", 1)[1]  # strip "data:image/png;base64," prefix

            # STEP B: solve via OCR. Same generic solve() machinery — only the task differs.
            task = {
                "type": "ImageToTextTask",
                "body": body_b64,
                # "module": "common",   # optional: some captcha styles have a dedicated model
                # "case": True,          # optional: case-sensitive answer
            }
            solution = await asyncio.to_thread(solve, api_key, task, "text")
            answer = solution["text"]
            print(f"[round {r}/{ROUNDS}] OCR answer: {answer!r}")

            # STEP C: type the answer and submit. (No token/cookie — the hidden `token`
            # field already in the form is submitted alongside our typed `answer`.)
            try:
                field = await page.select(INPUT_SELECTOR)
                await field.send_keys(answer)
            except Exception:
                await page.evaluate(
                    f"var el=document.querySelector({INPUT_SELECTOR!r}); if(el) el.value={answer!r};"
                )
            await page.evaluate(
                "(() => { const f=document.querySelector('form');"
                f" const b=document.querySelector({SUBMIT_SELECTOR!r});"
                " if(b){b.click();} else if(f){f.submit();} })()"
            )
            await page.sleep(3)

            # STEP D: verify against the marker on the resulting page.
            content = await page.get_content()
            if any(m in content for m in SUCCESS_MARKERS):
                await page.save_screenshot(shot)
                print(f"✅ PASS: image captcha solved on round {r} — 'IMAGE_SOLVE_OK' detected")
                print(f"[shot] {shot}")
                return 0
            print(f"[round {r}/{ROUNDS}] incorrect — retrying with a fresh image")

        if page is not None:
            await page.save_screenshot(shot)
        print(f"❌ FAIL: no correct OCR in {ROUNDS} rounds. [shot] {shot}")
        return 1
    finally:
        await browser.stop()


# ===========================================================================
# EXPERIMENT 4 — AWS WAF CAPTCHA (Amazon's modern bot wall)
# ===========================================================================
async def experiment_awswaf(api_key: str) -> int:
    """Solve an AWS WAF CAPTCHA and get past a WAF-gated page.

    LEARN — AWS WAF is the most different of all:
    - task.type is "AntiAwsWafTaskProxyLess". The MINIMAL task is just {type, websiteURL} —
      CapSolver fetches the challenge context (challenge.js, key, iv, context) itself. You
      CAN pass awsKey/awsIv/awsContext/awsChallengeJS if you've scraped them, but you rarely
      need to.
    - The answer is solution["cookie"] — a long opaque string. NOT gRecaptchaResponse, NOT
      solution.token.
    - You "inject" it by setting a COOKIE named `aws-waf-token` on the site's domain (here via
      the CDP Network.setCookie command), then reloading the gated page. No form field, no
      textarea — the token lives entirely in a cookie the browser sends on every request.
    - AWS gives ~300s of "immunity" once the token is accepted.

    CAVEAT (real-world): a ProxyLess solve happens from CapSolver's IP. If the WAF binds the
    token to the solver's IP, reusing it from OUR IP can be rejected — then you'd switch to
    AntiAwsWafTask + a matching `proxy`. We try ProxyLess first and let the result tell us.

    Target = the test site's /protected. Unsolved it returns HTTP 405 + the WAF interstitial;
    solved it contains AWSWAF_SOLVE_OK.
    """
    PROTECTED_URL = f"{TEST_SITE}/protected"
    DOMAIN = TEST_SITE.split("://", 1)[1]  # "dcz1t9chpw9yt.cloudfront.net"
    SUCCESS_MARKERS = ("AWSWAF_SOLVE_OK",)

    browser = await zd.start(headless=False)
    try:
        # Show the unsolved challenge first (for context + a screenshot).
        page = await browser.get(PROTECTED_URL)
        await page.sleep(3)
        shot_dir = os.path.dirname(os.path.abspath(__file__))
        await page.save_screenshot(os.path.join(shot_dir, "shot_awswaf_challenge.png"))

        # Solve: minimal task — CapSolver pulls the challenge context from websiteURL itself.
        task = {"type": "AntiAwsWafTaskProxyLess", "websiteURL": PROTECTED_URL}
        solution = await asyncio.to_thread(solve, api_key, task, "cookie")
        token = solution["cookie"]
        print(f"[capsolver] aws-waf-token: {token[:40]}... ({len(token)} chars)")

        # INJECT: set the aws-waf-token cookie via CDP, then reload the gated page.
        await page.send(
            cdp.network.set_cookie(
                name="aws-waf-token", value=token, domain=DOMAIN, path="/", secure=True
            )
        )
        print(f"[page] aws-waf-token cookie set on {DOMAIN}")
        page = await browser.get(PROTECTED_URL)  # re-request /protected WITH the cookie
        await page.sleep(3)
        await page.save_screenshot(os.path.join(shot_dir, "shot_awswaf_result.png"))

        # VERIFY.
        content = await page.get_content()
        hit = next((m for m in SUCCESS_MARKERS if m in content), None)
        if hit:
            print(f"✅ PASS: AWS WAF solved — '{hit}' detected")
            return 0
        print("❌ FAIL: no success marker — token may be IP-bound (try AntiAwsWafTask + proxy).")
        return 1
    finally:
        await browser.stop()


EXPERIMENTS = {
    "turnstile": experiment_turnstile,
    "v3": experiment_recaptcha_v3,
    "image": experiment_image_captcha,
    "awswaf": experiment_awswaf,
}


async def main() -> int:
    api_key = os.environ.get("CAPSOLVER_API_KEY")
    if not api_key:
        print("ERROR: set CAPSOLVER_API_KEY (get one at https://dashboard.capsolver.com)")
        return 2
    which = sys.argv[1] if len(sys.argv) > 1 else ""
    if which not in EXPERIMENTS:
        print(f"usage: python {os.path.basename(__file__)} [{' | '.join(EXPERIMENTS)}]")
        return 2
    return await EXPERIMENTS[which](api_key)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
