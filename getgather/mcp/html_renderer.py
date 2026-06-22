"""HTML template renderer for dpage forms."""

DEFAULT_TITLE = "Sign In"


def render_form(
    content: str, title: str = DEFAULT_TITLE, action: str = "", error_code: str | None = None
) -> str:
    """Render HTML form with the given content and options."""
    return f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="error-message" content="{error_code if error_code else ""}" />
    <title>{title}</title>
    <style>
      :root {{
        --primary: #0a0a0a;
        --primary-dark: #090909;
        --gray-50: #f9fafb;
        --gray-200: #e5e7eb;
        --gray-300: #d1d5db;
        --gray-600: #4b5563;
        --gray-800: #1f2937;
        --gray-900: #111827;
      }}

      * {{
        box-sizing: border-box;
        margin: 0;
        padding: 0;
      }}

      body {{
        font-family: "Inter", system-ui, -apple-system, sans-serif;
        background-color: var(--gray-50);
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 1rem;
        line-height: 1.6;
      }}

      .card {{
        position: relative;
        background: white;
        border-radius: 16px;
        box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06);
        border: 1px solid var(--gray-200);
        padding: 2rem;
        width: 100%;
        max-width: 480px;
      }}

      .header {{
        text-align: center;
      }}

      .logo {{
        width: 48px;
        height: 48px;
        background: var(--primary);
        border-radius: 12px;
        margin: 0 auto 1rem;
        display: flex;
        align-items: center;
        justify-content: center;
        color: white;
        font-weight: bold;
        font-size: 1.25rem;
      }}

      h1, h2 {{
        font-size: 1.5rem;
        font-weight: 600;
        color: var(--gray-900);
        margin-bottom: 0.5rem;
      }}

      .subtitle {{
        color: var(--gray-600);
        font-size: 0.875rem;
        margin-bottom: 1rem;
      }}

      form {{
        display: flex;
        flex-direction: column;
        gap: 1.25rem;
      }}

      label {{
        display: block;
        font-size: 0.875rem;
        font-weight: 500;
        color: var(--gray-800);
      }}

      .radio-wrapper {{
        display: flex;
        align-items: center;
        gap: 10px;
      }}

      .vertical-radios {{
        gap: 1rem;
        display: flex;
        flex-direction: column;
        margin-bottom: 1rem;
        margin-top: 1rem;
      }}

      input[type="email"],
      input[type="password"],
      input[type="text"],
      input[type="tel"],
      input[type="url"],
      input[type="number"],
      select,
      textarea {{
        width: 100%;
        padding: 0.75rem 1rem;
        border: 1px solid var(--gray-300);
        border-radius: 8px;
        font-size: 1rem;
        transition: all 0.15s ease;
        background: white;
      }}

      input:focus,
      select:focus,
      textarea:focus {{
        outline: none;
        border-color: var(--primary);
        box-shadow: 0 0 0 3px rgba(0, 0, 0, 0.1);
      }}

      input[type="checkbox"] {{
        width: 1rem;
        height: 1rem;
        accent-color: var(--primary);
        border-radius: 4px;
      }}

      button[type="submit"],
      button,
      input[type="submit"] {{
        width: 100%;
        background: var(--primary);
        color: white;
        border: none;
        border-radius: 8px;
        padding: 0.875rem 1rem;
        font-size: 1rem;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.15s ease;
      }}

      button[type="submit"]:hover,
      button:hover,
      input[type="submit"]:hover {{
        background: var(--primary-dark);
      }}

      button[type="submit"]:focus,
      button:focus,
      input[type="submit"]:focus {{
        outline: none;
        box-shadow: 0 0 0 3px rgba(0, 0, 0, 0.2);
      }}

      .password-wrapper {{
        position: relative;
        width: 100%;
      }}

      .password-wrapper input[type="password"],
      .password-wrapper input[type="text"] {{
        padding-right: 2.75rem;
      }}

      .password-toggle {{
        position: absolute;
        right: 0.5rem;
        top: 50%;
        transform: translateY(-50%);
        width: auto;
        padding: 0.25rem;
        background: transparent;
        border: none;
        border-radius: 4px;
        color: var(--gray-600);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
      }}

      .password-toggle:hover {{
        background: transparent;
        color: var(--gray-900);
      }}

      .password-toggle:focus {{
        outline: none;
        box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.15);
      }}

      .password-toggle svg {{
        width: 20px;
        height: 20px;
        display: block;
      }}

      .password-toggle .icon-eye-off {{
        display: none;
      }}

      .password-toggle.is-visible .icon-eye {{
        display: none;
      }}

      .password-toggle.is-visible .icon-eye-off {{
        display: block;
      }}

      .content-wrapper {{
        display: flex;
        flex-direction: column;
        gap: 1rem;
      }}

    .content-wrapper
      :is(a, div, p, span, h1, h2, h3, h4, h5, h6):empty {{
      display: none;
    }}

      @media (max-width: 640px) {{
        body {{
          padding: 0;
        }}

        .card {{
          padding: 1.5rem;
          max-width: 100%;
        }}
      }}

      /* Loading spinner styles */
      .spinner {{
        display: inline-block;
        width: 16px;
        height: 16px;
        border: 2px solid rgba(255, 255, 255, 0.3);
        border-top-color: white;
        border-radius: 50%;
        animation: spin 0.6s linear infinite;
        margin-right: 8px;
        vertical-align: middle;
      }}

      @keyframes spin {{
        to {{ transform: rotate(360deg); }}
      }}

      button:disabled,
      input[type="submit"]:disabled {{
        opacity: 0.7;
        cursor: not-allowed;
      }}

      .form-overlay {{
        position: absolute;
        inset: 0;
        background: rgba(255, 255, 255, 0.6);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10;
        border-radius: inherit;
      }}

      form {{
        position: relative;
      }}

      .error-box {{
        display: flex;
        align-items: flex-start;
        gap: 0.625rem;
        padding: 0.875rem 1rem;
        background: #fff5f5;
        border: 1.5px solid #c0392b;
        border-left-width: 4px;
        border-radius: 8px;
        color: #c0392b;
        font-size: 0.9375rem;
        line-height: 1.5;
      }}
    </style>
    <script>
      document.addEventListener("DOMContentLoaded", function () {{
        const form = document.querySelector("div.card");

        if (form) {{
          form.addEventListener("submit", function (e) {{

            const overlay = document.createElement("div");
            overlay.className = "form-overlay";

            const spinner = document.createElement("div");
            spinner.className = "spinner";
            spinner.style.borderTopColor = "#333";

            overlay.appendChild(spinner);
            form.appendChild(overlay);
          }});
        }}

        const eyeIcon = '<svg class="icon-eye" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" /><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" /></svg>';
        const eyeOffIcon = '<svg class="icon-eye-off" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" /></svg>';

        document.querySelectorAll('input[type="password"]').forEach(function (input) {{
          if (input.parentElement && input.parentElement.classList.contains("password-wrapper")) {{
            return;
          }}

          const wrapper = document.createElement("div");
          wrapper.className = "password-wrapper";
          input.parentNode.insertBefore(wrapper, input);
          wrapper.appendChild(input);

          const toggle = document.createElement("button");
          toggle.type = "button";
          toggle.className = "password-toggle";
          toggle.setAttribute("aria-label", "Show password");
          toggle.setAttribute("aria-pressed", "false");
          toggle.innerHTML = eyeIcon + eyeOffIcon;

          toggle.addEventListener("click", function () {{
            const willShow = input.type === "password";
            input.type = willShow ? "text" : "password";
            toggle.classList.toggle("is-visible", willShow);
            toggle.setAttribute("aria-pressed", String(willShow));
            toggle.setAttribute("aria-label", willShow ? "Hide password" : "Show password");
          }});

          wrapper.appendChild(toggle);
        }});
      }});
    </script>
  </head>
  <body>
    <div class="card">
      <div class="header">
        <h2>{title}</h2>
      </div>
      <form method="POST" action="{action}">
        <div class="content-wrapper">
          {content}
        </div>
      </form>
    </div>
  </body>
</html>"""
