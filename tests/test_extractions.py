import os
import time
from collections.abc import Generator

import httpx
import pytest
from nanoid import generate

from getgather.config import FRIENDLY_CHARS

REMOTEBROWSER_URL = os.getenv("REMOTEBROWSER_URL", "http://localhost:23456")
RETRY_TIMEOUT = 30


@pytest.fixture(scope="module")
def client():
    with httpx.Client(base_url=REMOTEBROWSER_URL, timeout=30.0) as c:
        yield c


@pytest.fixture
def browser_ids(client: httpx.Client) -> Generator[list[str], None, None]:
    ids: list[str] = []
    yield ids
    for browser_id in ids:
        try:
            client.delete(f"/api/v1/browsers/{browser_id}")
        except Exception:
            pass


def prepare_new_browser(
    client: httpx.Client, prefix: str, browser_ids: list[str]
) -> tuple[str, str]:
    browser_id = f"{prefix}-{generate(FRIENDLY_CHARS, 7)}"
    browser_ids.append(browser_id)

    client.delete(f"/api/v1/browsers/{browser_id}")
    assert client.post(f"/api/v1/browsers/{browser_id}").status_code == 200

    page_id: str | None = None
    for _ in range(RETRY_TIMEOUT):
        page_ids: list[object] = client.get(f"/api/v1/browsers/{browser_id}/pages").json()
        if page_ids:
            page_id = str(page_ids[0])
            break
        time.sleep(1)
    assert page_id is not None, "Browser never exposed any pages"
    return browser_id, page_id


def navigate_page(client: httpx.Client, browser_id: str, page_id: str, url: str) -> httpx.Response:
    navigate: httpx.Response | None = None
    for _ in range(RETRY_TIMEOUT):
        response = client.post(
            f"/api/v1/browsers/{browser_id}/pages/{page_id}/navigate",
            params={"url": url},
        )
        if response.status_code == 200:
            navigate = response
            break
        time.sleep(1)
    assert navigate is not None, "Navigate never returned 200"
    assert navigate.status_code == 200
    return navigate


def get_distilled_json(client: httpx.Client, browser_id: str, page_id: str) -> list[object]:
    distilled: httpx.Response | None = None
    for _ in range(RETRY_TIMEOUT):
        response = client.get(f"/api/v1/browsers/{browser_id}/pages/{page_id}/distilled")
        if response.status_code == 200:
            distilled = response
            break
        time.sleep(1)
    assert distilled is not None, "Distilled endpoint never returned 200"
    assert distilled.status_code == 200
    data: list[object] = distilled.json()
    return data


@pytest.mark.distill
class TestNPR:
    def test_navigate_and_distill(self, client: httpx.Client, browser_ids: list[str]) -> None:
        browser_id, page_id = prepare_new_browser(client, "npr", browser_ids)

        navigate_page(client, browser_id, page_id, "https://text.npr.org/")

        data = get_distilled_json(client, browser_id, page_id)
        assert isinstance(data, list)
        assert len(data) > 0

        first = data[0]
        assert isinstance(first, dict)
        assert "title" in first
        assert "link" in first
        assert isinstance(first["link"], str)
        assert first["link"]


@pytest.mark.distill
class TestGroundNews:
    def test_navigate_and_distill(self, client: httpx.Client, browser_ids: list[str]) -> None:
        browser_id, page_id = prepare_new_browser(client, "groundnews", browser_ids)

        navigate_page(client, browser_id, page_id, "https://ground.news")

        data = get_distilled_json(client, browser_id, page_id)
        assert isinstance(data, list)
        assert len(data) > 0

        first = data[0]
        assert isinstance(first, dict)
        assert "title" in first
        assert "link" in first
        assert isinstance(first["link"], str)
        assert first["link"]


@pytest.mark.distill
class TestNYTimes:
    def test_navigate_and_distill(self, client: httpx.Client, browser_ids: list[str]) -> None:
        browser_id, page_id = prepare_new_browser(client, "nytimes", browser_ids)

        navigate_page(client, browser_id, page_id, "https://www.nytimes.com/books/best-sellers/")

        data = get_distilled_json(client, browser_id, page_id)
        assert isinstance(data, list)
        assert len(data) > 0

        first = data[0]
        assert isinstance(first, dict)
        assert "title" in first
        assert "author" in first
        assert isinstance(first["author"], str)
        assert first["author"]


@pytest.mark.distill
class TestESPN:
    def test_navigate_and_distill(self, client: httpx.Client, browser_ids: list[str]) -> None:
        browser_id, page_id = prepare_new_browser(client, "espn", browser_ids)

        navigate_page(client, browser_id, page_id, "https://www.espn.com/college-football/schedule")

        data = get_distilled_json(client, browser_id, page_id)
        assert isinstance(data, list)
        assert len(data) > 0

        first = data[0]
        assert isinstance(first, dict)
        assert "time" in first
        assert "home_team" in first
        assert "away_team" in first


@pytest.mark.distill
class TestCNN:
    def test_navigate_and_distill(self, client: httpx.Client, browser_ids: list[str]) -> None:
        browser_id, page_id = prepare_new_browser(client, "cnn", browser_ids)

        navigate_page(client, browser_id, page_id, "https://lite.cnn.com")

        data = get_distilled_json(client, browser_id, page_id)
        assert isinstance(data, list)
        assert len(data) > 0

        first = data[0]
        assert isinstance(first, dict)
        assert "title" in first
        assert "link" in first
        assert isinstance(first["link"], str)
        assert first["link"]


@pytest.mark.distill
class TestCBC:
    @pytest.fixture(autouse=True)
    def upload_cbc_patterns(self, client: httpx.Client) -> Generator[None, None, None]:
        html_content = """<html gg-domain="cbc">
  <head>
    <title>CBC Headlines</title>
  </head>
  <body>
    <ul gg-stop gg-convert="cbc-headlines.json" gg-match-html="main ul"></ul>
  </body>
</html>
"""
        json_content = """{
  "rows": "ul li",
  "columns": [
    { "name": "title", "selector": "li a" },
    { "name": "link", "selector": "li a", "attribute": "href" }
  ]
}
"""
        client.post("/api/v1/patterns/cbc-headlines", json={"content": html_content})
        client.post(
            "/api/v1/patterns/cbc-headlines",
            params={"ext": "json"},
            json={"content": json_content},
        )
        yield
        client.delete("/api/v1/patterns/cbc-headlines")
        client.delete("/api/v1/patterns/cbc-headlines", params={"ext": "json"})

    def test_navigate_and_distill(self, client: httpx.Client, browser_ids: list[str]) -> None:
        browser_id, page_id = prepare_new_browser(client, "cbc", browser_ids)

        navigate_page(client, browser_id, page_id, "https://www.cbc.ca/lite/news")

        data = get_distilled_json(client, browser_id, page_id)
        assert isinstance(data, list)
        assert len(data) > 0

        first = data[0]
        assert isinstance(first, dict)
        assert "title" in first
        assert "link" in first
        assert isinstance(first["link"], str)
        assert first["link"]
