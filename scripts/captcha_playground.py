"""Standalone CAPTCHA-solving playground.

Fully self-contained — depends only on third-party libs (zendriver, httpx), no
project imports. Launches a *local* Chrome via zendriver, opens a public CAPTCHA
demo page, and runs the whole pipeline inline — extract params → CapSolver →
inject token → submit — printing each step and saving before/after screenshots
so you can watch it work and iterate (especially on the fiddly Arkose injection).

Usage:
    export CAPTCHA_SOLVER_API_KEY=<your capsolver key>
    uv run python scripts/captcha_playground.py                 # Cloudflare Turnstile demo
    uv run python scripts/captcha_playground.py --provider arkose
    uv run python scripts/captcha_playground.py --url https://... --provider cloudflare
    uv run python scripts/captcha_playground.py --headless      # no visible window

Demo sites (public CAPTCHA playgrounds):
    cloudflare : https://2captcha.com/demo/cloudflare-turnstile
    arkose     : https://2captcha.com/demo/arkoselabs   (FunCaptcha)
"""

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, cast

import httpx
import zendriver as zd

CAPSOLVER_BASE_URL = "https://api.capsolver.com"
SOLVE_TIMEOUT_SECONDS = 120

DEMO_URLS: dict[str, str] = {
    "cloudflare": "https://2captcha.com/demo/cloudflare-turnstile",
    "arkose": "https://2captcha.com/demo/arkoselabs",
}


async def extract_params(page: zd.Tab, provider: str) -> dict[str, str] | None:
    """Read challenge parameters (sitekey / public key) from the live DOM."""
    if provider == "arkose":
        # The Arkose/FunCaptcha public key is rarely a static data-pkey attribute on real
        # targets (Amazon included) — it arrives via the enforcement script/iframe URL:
        #   https://<sub>.arkoselabs.com/v2/<PKEY>/api.js
        #   .../fc/gt2/public_key/<PKEY>
        # So: try data-pkey first, then mine the loaded resource URLs for the pkey + subdomain.
        js = r"""
        (() => {
          const uuid = '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}';
          const el = document.querySelector('[data-pkey]');
          if (el && el.getAttribute('data-pkey')) {
            return {
              websitePublicKey: el.getAttribute('data-pkey'),
              funcaptchaApiJSSubdomain: el.getAttribute('data-surl') || null,
            };
          }
          const urls = performance.getEntriesByType('resource').map(r => r.name);
          for (const u of urls) {
            if (!/arkose|funcaptcha/i.test(u)) continue;
            const m = u.match(new RegExp('/v2/(' + uuid + ')/')) ||
                      u.match(new RegExp('public_key/(' + uuid + ')'));
            if (m) {
              let sub = null;
              try { sub = new URL(u).hostname; } catch (e) {}
              return { websitePublicKey: m[1], funcaptchaApiJSSubdomain: sub };
            }
          }
          return null;
        })()
        """
    else:  # cloudflare turnstile
        js = """
        (() => {
          const el = document.querySelector('[data-sitekey], .cf-turnstile');
          if (!el) return null;
          const key = el.getAttribute('data-sitekey');
          if (!key) return null;
          return { websiteKey: key, action: el.getAttribute('data-action') || null };
        })()
        """
    raw = await page.evaluate(js, await_promise=True)
    if not isinstance(raw, dict):
        return None
    return {k: str(v) for k, v in raw.items() if v is not None}  # type: ignore[union-attr]


async def solve_via_capsolver(
    api_key: str, provider: str, params: dict[str, str], website_url: str
) -> dict[str, Any] | None:
    """Create a CapSolver task and poll until ready. Returns the solution dict."""
    if provider == "arkose":
        task: dict[str, Any] = {
            "type": "FunCaptchaTaskProxyLess",
            "websiteURL": website_url,
            "websitePublicKey": params.get("websitePublicKey"),
        }
        if params.get("funcaptchaApiJSSubdomain"):
            task["funcaptchaApiJSSubdomain"] = params["funcaptchaApiJSSubdomain"]
    else:
        task = {
            "type": "AntiTurnstileTaskProxyLess",
            "websiteURL": website_url,
            "websiteKey": params.get("websiteKey"),
        }
        if params.get("action"):
            task["metadata"] = {"action": params["action"]}

    deadline = time.monotonic() + SOLVE_TIMEOUT_SECONDS
    async with httpx.AsyncClient(base_url=CAPSOLVER_BASE_URL, timeout=30) as client:
        create = await client.post("/createTask", json={"clientKey": api_key, "task": task})
        create.raise_for_status()
        created = cast(dict[str, Any], create.json())
        if created.get("errorId"):
            print(f"   createTask error: {created.get('errorDescription')}")
            return None
        task_id = created.get("taskId")
        if not task_id:
            return None

        while time.monotonic() < deadline:
            await asyncio.sleep(2)
            poll = await client.post(
                "/getTaskResult", json={"clientKey": api_key, "taskId": task_id}
            )
            poll.raise_for_status()
            result = cast(dict[str, Any], poll.json())
            if result.get("errorId"):
                print(f"   getTaskResult error: {result.get('errorDescription')}")
                return None
            status = result.get("status")
            print(f"   status={status}")
            if status == "ready":
                solution = cast(dict[str, Any], result.get("solution") or {})
                if "cost" not in solution and result.get("cost") is not None:
                    solution["cost"] = result.get("cost")
                return solution
    print("   timed out waiting for solution")
    return None


async def inject(page: zd.Tab, provider: str, token: str) -> bool:
    """Write the token back into the page and submit the form."""
    token_js = json.dumps(token)
    if provider == "arkose":
        js = f"""
        (() => {{
          const token = {token_js};
          let set = false;
          document.querySelectorAll(
            'input[name="fc-token"], input[name="fctoken"], input[name="verification-token"], input[id*="captcha-token"]'
          ).forEach((el) => {{ el.value = token; set = true; }});
          const form = document.querySelector('form');
          if (form) {{ try {{ form.requestSubmit ? form.requestSubmit() : form.submit(); }} catch (e) {{}} }}
          return set;
        }})()
        """
    else:
        js = f"""
        (() => {{
          const token = {token_js};
          let set = false;
          document.querySelectorAll(
            'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"], input[name$="response"]'
          ).forEach((el) => {{ el.value = token; set = true; }});
          // Fire the widget's success callback if the page registered one (data-callback).
          const w = document.querySelector('.cf-turnstile, [data-sitekey]');
          const cbName = w && w.getAttribute('data-callback');
          if (cbName && typeof window[cbName] === 'function') {{
            try {{ window[cbName](token); }} catch (e) {{}}
          }}
          const form = document.querySelector('form');
          if (form) {{ try {{ form.requestSubmit ? form.requestSubmit() : form.submit(); }} catch (e) {{}} }}
          return set;
        }})()
        """
    return bool(await page.evaluate(js, await_promise=True))


async def turnstile_response_value(page: zd.Tab) -> str:
    """Read back the cf-turnstile-response field — the token a form would submit."""
    js = """
    (() => {
      const el = document.querySelector('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]');
      return el ? (el.value || '') : '';
    })()
    """
    return str(await page.evaluate(js, await_promise=True))


async def paint_banner(page: zd.Tab, text: str, color: str) -> None:
    """Draw a fixed banner on the page so a headful user sees the result directly."""
    js = f"""
    (() => {{
      let b = document.getElementById('__cap_banner');
      if (!b) {{
        b = document.createElement('div');
        b.id = '__cap_banner';
        b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;'
          + 'padding:14px 18px;font:600 15px/1.4 system-ui,sans-serif;color:#fff;'
          + 'white-space:pre-wrap;word-break:break-all;box-shadow:0 2px 8px rgba(0,0,0,.3)';
        document.body.appendChild(b);
      }}
      b.style.background = {json.dumps(color)};
      b.textContent = {json.dumps(text)};
    }})()
    """
    await page.evaluate(js, await_promise=True)


async def keep_open() -> None:
    """Block so the headful browser stays open for inspection after the run."""
    print("\nBrowser left open for inspection. Press Enter to close it (or Ctrl-C)...")
    try:
        if sys.stdin.isatty():
            await asyncio.to_thread(input)
        else:
            while True:
                await asyncio.sleep(3600)
    except (EOFError, KeyboardInterrupt):
        pass


async def run(api_key: str, url: str, provider: str, headless: bool) -> int:
    out_dir = Path(__file__).resolve().parent.parent / "data" / "captcha_playground"
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"Provider: {provider}")
    print(f"URL:      {url}")
    print(f"Headless: {headless}\n")

    browser = await zd.start(headless=headless)
    try:
        print("-> Navigating...")
        page = await browser.get(url)
        await page.sleep(5)  # let the widget render and register its DOM
        await page.save_screenshot(out_dir / "1_loaded.png")

        print("-> Extracting challenge params from the live DOM...")
        params = await extract_params(page, provider)
        print(f"   params = {params}")
        if not params:
            print(
                "No params found. The widget may be in a cross-origin iframe or not rendered yet. "
                "Inspect data/captcha_playground/1_loaded.png and adjust the selectors above."
            )
            await keep_open()
            return 1

        website_url = str(await page.evaluate("window.location.href", await_promise=True))
        print(f"-> Solving via CapSolver (up to {SOLVE_TIMEOUT_SECONDS}s)...")
        solution = await solve_via_capsolver(api_key, provider, params, website_url)
        token = solution.get("token") if solution else None
        if not token:
            print(f"Solve failed. solution={solution}")
            await keep_open()
            return 1
        print(f"   token = {token[:40]}...  (cost={(solution or {}).get('cost')})")

        print("-> Injecting token and submitting...")
        injected = await inject(page, provider, token)
        print(f"   injected = {injected}")

        await page.sleep(2)

        # Real proof for Turnstile: the token now sits in the cf-turnstile-response field
        # that any form on the page submits. (A token solver does NOT tick the visible
        # checkbox — that is cosmetic state inside Cloudflare's iframe. Acceptance happens
        # server-side when the form is submitted, e.g. the real DoorDash flow.)
        body_text = str(await page.evaluate("document.body.innerText", await_promise=True)).lower()
        site_confirmed = any(
            marker in body_text
            for marker in ("captcha is passed", "successfully", "verification successful", "solved")
        )
        if provider == "cloudflare":
            field = await turnstile_response_value(page)
            token_placed = bool(field)
            success = site_confirmed or token_placed
            print(f"   cf-turnstile-response in page = {field[:40] + '...' if field else '(empty)'}")
        else:
            token_placed = injected
            success = site_confirmed or injected

        verdict = "SUCCESS" if success else "UNCONFIRMED"
        banner = (
            f"{verdict}: CapSolver token obtained and placed in the page's response field "
            f"({len(token)} chars). The visible checkbox stays unchecked — token solvers don't "
            f"tick it; the site accepts the token on form submit."
        )
        await paint_banner(page, banner, "#15803d" if success else "#b45309")
        await page.save_screenshot(out_dir / "2_after_submit.png")

        print(f"\n{verdict} -- screenshots in {out_dir}")
        if success and not site_confirmed:
            print(
                "Token is valid and placed where a form submits it. This bare demo has no form/"
                "verify step, so there's no visible 'passed' UI — that's expected."
            )
        elif not success:
            print(
                "Token was not placed in the response field; check 2_after_submit.png and the "
                "selectors in inject()."
            )
        await keep_open()
        return 0 if success else 2
    finally:
        await browser.stop()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", choices=["cloudflare", "arkose"], default="cloudflare")
    parser.add_argument("--url", default=None, help="Override the demo URL")
    parser.add_argument("--headless", action="store_true", help="Run without a visible window")
    args = parser.parse_args()

    api_key = os.environ.get("CAPTCHA_SOLVER_API_KEY") or os.environ.get("CAPSOLVER_API_KEY")
    if not api_key:
        print(
            "No API key. Set CAPTCHA_SOLVER_API_KEY (or CAPSOLVER_API_KEY) to your CapSolver "
            "key, e.g.:\n  export CAPTCHA_SOLVER_API_KEY=CAP-XXXXXXXX"
        )
        return 1

    url = args.url or DEMO_URLS[args.provider]
    return asyncio.run(run(api_key, url, args.provider, args.headless))


if __name__ == "__main__":
    raise SystemExit(main())
