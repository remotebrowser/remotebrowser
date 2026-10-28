# Harness

The harness lets the [Playground](playground.md) accept a task in natural language, for example "Go to CNN and get the page title". The harness sends the task to an LLM, which writes the script. The server verifies that script before it runs.

Without an LLM, the playground still works, but it accepts only scripts.

## Configuration

The harness works with any service that has an OpenAI-compatible chat completions endpoint (`/chat/completions`). This includes a managed service or a local LLM server. Set these environment variables:

| Env name           | Description                                                       |
| ------------------ | ----------------------------------------------------------------- |
| `LLM_API_BASE_URL` | Base URL of the API, without `/chat/completions`                  |
| `LLM_API_KEY`      | API key, if the service needs one. A local server often does not. |
| `LLM_CHAT_MODEL`   | Model name                                                        |

Both `LLM_API_BASE_URL` and `LLM_CHAT_MODEL` are required to turn on the harness.

At startup, the server asks the LLM to write a simple script. If the script is correct, the playground offers natural language. The server checks again every 5 minutes, so the playground follows the status of the LLM without a restart. If the test fails, the server logs `HARNESS LLM check failed`, and the playground accepts only scripts.

The quality of the scripts depends on the model. A fast model that writes good JavaScript works best, because the user waits for the answer before the script runs.

The text that a user types goes to the LLM service. If that is a problem, use a local LLM server.

The server does not trust the LLM. A task can contain a prompt injection, for example text that the user pasted from a different site. Thus, a script from the LLM must also obey stricter rules, as described in [Verification](#verification).

Each LLM request costs money with a managed service. Thus, each user can send 10 tasks a minute to the LLM. Scripts that pass verification run without the LLM, so they do not count.

## Verification

The server verifies each script before it runs. It verifies the user's own scripts in the same way, except where noted below. If verification fails, the playground shows the reason.

Each script must obey these rules:

- It is JavaScript only. It declares variables with `const` or `let`.
- It uses only the `page` methods that the [Playground](playground.md) documents, and only `console.log`, `info`, `warn`, and `error`.
- Apart from its own variables, it uses only `JSON`, `Math`, `Number`, `String`, `Boolean`, `Array`, `undefined`, and `NaN`.
- It does not use `fetch`, network objects, cookies, storage, or `location`.
- It does not change a string into code, for example with `eval` or `Function`.
- The functions in `page.evaluate`, `page.$eval`, and `page.$$eval` only read the page. They do not change elements.

A task can contain text that tries to control the LLM (a prompt injection), for example text that the user pasted from a different site. Thus, the server does not trust a script from the LLM. That script must also obey these rules:

- It does not use `page.cdp`.
- It uses an index only with a literal value, for example `items[0]`. A variable index could make a name that is not permitted.

If the server refuses the first script from the LLM, the LLM gets one more attempt with the reason.

Verification is not a sandbox. A script that passes verification still controls the browser. Give the LLM only tasks that you also run as a script.

## Examples

### OpenAI

```bash
LLM_API_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=yourownapikey
LLM_CHAT_MODEL=gpt-6-luna
```

### OpenRouter

```bash
LLM_API_BASE_URL=https://openrouter.ai/api/v1
LLM_API_KEY=yourownapikey
LLM_CHAT_MODEL=deepseek/deepseek-v4.1-flash
```

### DeepInfra

```bash
LLM_API_BASE_URL=https://api.deepinfra.com/v1/openai
LLM_API_KEY=yourownapikey
LLM_CHAT_MODEL=deepseek-ai/DeepSeek-V4.1-Flash
```

### Local LLM

A local LLM server also works, as long as it has an OpenAI-compatible endpoint. Such a server often needs no API key.

With [llama.cpp](https://github.com/ggml-org/llama.cpp), start `llama-server` with a model. It serves only that model, so `LLM_CHAT_MODEL` can be any name, but it must be set.

```bash
llama-server -m /path/to/model.gguf
```

```bash
LLM_API_BASE_URL=http://127.0.0.1:8080/v1
LLM_CHAT_MODEL=local
```

With [LM Studio](https://lmstudio.ai), load a model and start the server in the Developer tab. Set `LLM_CHAT_MODEL` to the model name that LM Studio shows there, for example:

```bash
LLM_API_BASE_URL=http://127.0.0.1:1234/v1
LLM_CHAT_MODEL=openai/gpt-oss-20b
```

Other local servers work in the same way.

A small local model may fail the test at startup, or write scripts that often fail. In that case, try a larger model.
